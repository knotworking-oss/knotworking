import {
  parseStaffCsv,
  type CsvImportInput,
  type CsvImportRowError,
  type StaffCsvColumn,
  type StaffEntry,
} from "@knotworking/core";
import {
  jobRoles,
  lockWorkspaceLog,
  recordChanges,
  staff,
  staffJobRoles,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { chunks, importResult, invalidRows, type ImportChange } from "./csv-import";
import { setStaffJobRoles, staffChange } from "./people";
import { workspaceToday } from "./time-zone";

/**
 * CSV import of staff (the parser is in core): created or updated by staff number. The number is
 * the key, so an import never changes one, which keeps the rule that a number is fixed once a
 * person has training or attendance records. Never touches PINs, lock-outs or the login link;
 * those stay a manager's act in the app.
 */

type StaffRow = typeof staff.$inferSelect;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Entry field → the row column it sets (and the CSV column it came from, for errors). */
const fieldColumn = {
  firstName: "firstName",
  lastName: "lastName",
  jobTitle: "jobTitle",
  department: "department",
  startDate: "startDate",
  endDate: "endDate",
  payrollReference: "payrollReference",
  status: "status",
} as const satisfies Record<string, StaffCsvColumn>;
const scalarFields = Object.keys(fieldColumn) as (keyof typeof fieldColumn)[];

type StaffPlan =
  | {
      action: "create";
      entry: StaffEntry;
      values: typeof staff.$inferInsert;
      roleIds: string[] | undefined;
    }
  | {
      action: "update";
      entry: StaffEntry;
      current: StaffRow;
      patch: Partial<StaffRow>;
      roleIds: string[] | undefined;
      fields: string[];
    }
  | { action: "unchanged"; entry: StaffEntry };

async function planStaff(tx: Executor, workspaceId: string, entries: StaffEntry[]) {
  const existing = new Map<string, StaffRow>();
  for (const batch of chunks(entries.map((e) => e.staffNumber))) {
    // Removed people included: a number is never reused.
    const rows = await tx
      .select()
      .from(staff)
      .where(and(eq(staff.workspaceId, workspaceId), inArray(staff.staffNumber, batch)));
    for (const row of rows) existing.set(row.staffNumber, row);
  }
  const roles = await tx
    .select()
    .from(jobRoles)
    .where(and(eq(jobRoles.workspaceId, workspaceId), isNull(jobRoles.deletedAt)));
  const roleByName = new Map(roles.map((r) => [r.name.toLowerCase(), r]));
  const heldBy = new Map<string, Set<string>>();
  const liveIds = [...existing.values()].filter((s) => !s.deletedAt).map((s) => s.id);
  for (const batch of chunks(liveIds)) {
    const rows = await tx
      .select({ staffId: staffJobRoles.staffId, jobRoleId: staffJobRoles.jobRoleId })
      .from(staffJobRoles)
      .where(and(inArray(staffJobRoles.staffId, batch), isNull(staffJobRoles.deletedAt)));
    for (const r of rows) {
      const set = heldBy.get(r.staffId) ?? new Set();
      set.add(r.jobRoleId);
      heldBy.set(r.staffId, set);
    }
  }
  const today = await workspaceToday(tx, workspaceId);

  const errors: CsvImportRowError<StaffCsvColumn>[] = [];
  const plan: StaffPlan[] = [];
  for (const entry of entries) {
    const before = errors.length;
    const fail = (column: StaffCsvColumn, message: string) =>
      errors.push({ row: entry.row, column, message });
    const current = existing.get(entry.staffNumber);
    if (current?.deletedAt) {
      fail(
        "staffNumber",
        `Staff number ${entry.staffNumber} belonged to someone who was removed; numbers are never reused`,
      );
      continue;
    }

    let roleIds: string[] | undefined;
    if (entry.jobRoleNames) {
      roleIds = [];
      for (const name of entry.jobRoleNames) {
        const role = roleByName.get(name.toLowerCase());
        if (!role) fail("jobRoles", `No job role is called "${name}". Add it on the People page first`);
        else if (role.status === "archived") fail("jobRoles", `The job role "${name}" is archived`);
        else roleIds.push(role.id);
      }
    }

    const given: Record<string, unknown> = {};
    for (const f of scalarFields) if (entry[f] !== undefined) given[f] = entry[f];
    // Becoming a leaver records the last day (today unless given); coming back clears it.
    const status = entry.status ?? current?.status ?? "active";
    if (entry.endDate === undefined) {
      if (status === "leaver" && current?.status !== "leaver") given.endDate = current?.endDate ?? today;
      else if (status === "active" && current?.status === "leaver" && entry.status) given.endDate = null;
    }
    const startDate = (given.startDate !== undefined ? given.startDate : current?.startDate) as
      string | null | undefined;
    const endDate = (given.endDate !== undefined ? given.endDate : current?.endDate) as
      string | null | undefined;
    if (startDate && endDate && startDate > endDate) fail("endDate", "The start date is after the end date");

    if (!current) {
      for (const f of ["firstName", "lastName"] as const) {
        if (entry[f] === undefined) {
          fail(
            f,
            `${entry.staffNumber} is a new person, so they need a ${f === "firstName" ? "first" : "last"} name`,
          );
        }
      }
      if (errors.length > before) continue;
      plan.push({
        action: "create",
        entry,
        values: { ...given, staffNumber: entry.staffNumber, workspaceId } as typeof staff.$inferInsert,
        roleIds,
      });
      continue;
    }
    if (errors.length > before) continue;

    const patch = Object.fromEntries(
      Object.entries(given).filter(([f, v]) => !same(current[f as keyof StaffRow], v)),
    ) as Partial<StaffRow>;
    const held = heldBy.get(current.id) ?? new Set<string>();
    const rolesChanged =
      roleIds !== undefined && !(roleIds.length === held.size && roleIds.every((id) => held.has(id)));
    const fields = [...Object.keys(patch), ...(rolesChanged ? ["jobRoles"] : [])];
    plan.push(
      fields.length
        ? { action: "update", entry, current, patch, roleIds: rolesChanged ? roleIds : undefined, fields }
        : { action: "unchanged", entry },
    );
  }
  return { plan, errors };
}

export async function importStaffCsv(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: CsvImportInput,
) {
  const parsed = parseStaffCsv(input.csv);
  const fileName = input.fileName ?? null;

  const check = async (tx: Executor) => {
    const { plan, errors } = await planStaff(tx, workspaceId, parsed.entries);
    const all = [...parsed.errors, ...errors].sort((a, b) => a.row - b.row);
    return { plan: all.length ? [] : plan, errors: all };
  };
  const nameOf = (p: StaffPlan) => {
    const first =
      p.action === "create"
        ? p.values.firstName
        : (p.entry.firstName ?? (p.action === "update" ? p.current.firstName : ""));
    const last =
      p.action === "create"
        ? p.values.lastName
        : (p.entry.lastName ?? (p.action === "update" ? p.current.lastName : ""));
    return `${first} ${last}`.trim();
  };
  const result = (plan: StaffPlan[], errors: CsvImportRowError[], dryRun: boolean) => {
    const changes: ImportChange[] = plan.flatMap((p) =>
      p.action === "unchanged"
        ? []
        : [
            {
              row: p.entry.row,
              action: p.action,
              key: p.entry.staffNumber,
              name: nameOf(p),
              fields: p.action === "update" ? p.fields : [],
            },
          ],
    );
    return importResult({
      dryRun,
      fileName,
      rowCount: parsed.rowCount,
      ignoredColumns: parsed.ignoredColumns,
      errors,
      changes,
      unchanged: plan.filter((p) => p.action === "unchanged").length,
    });
  };

  if (input.dryRun) {
    const { plan, errors } = await check(db);
    return result(plan, errors, true);
  }
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const { plan, errors } = await check(tx);
    if (errors.length) throw invalidRows(errors);
    const changes: ChangeInput[] = [];
    const creates = plan.filter((p): p is Extract<StaffPlan, { action: "create" }> => p.action === "create");
    for (const batch of chunks(creates)) {
      const rows = await tx
        .insert(staff)
        .values(batch.map((p) => p.values))
        .returning();
      const byNumber = new Map(rows.map((r) => [r.staffNumber, r]));
      for (const p of batch) {
        const row = byNumber.get(p.entry.staffNumber)!;
        changes.push(staffChange(row));
        if (p.roleIds?.length) changes.push(...(await setStaffJobRoles(tx, workspaceId, row.id, p.roleIds)));
      }
    }
    for (const p of plan) {
      if (p.action !== "update") continue;
      const [row] = Object.keys(p.patch).length
        ? await tx.update(staff).set(p.patch).where(eq(staff.id, p.current.id)).returning()
        : await tx.update(staff).set({ updatedAt: new Date() }).where(eq(staff.id, p.current.id)).returning();
      changes.push(staffChange(row!));
      if (p.roleIds) changes.push(...(await setStaffJobRoles(tx, workspaceId, p.current.id, p.roleIds)));
    }
    for (const batch of chunks(changes, 1000)) await recordChanges(tx, workspaceId, actorId, batch);
    return result(plan, [], false);
  });
}
