import {
  datesBetween,
  onWeekday,
  type StaffingGapReason,
  type staffingRequirementCreateSchema,
  type staffingRequirementUpdateSchema,
} from "@knotworking/core";
import {
  jobRoles,
  productionBatches,
  productionNonWorkingDays,
  staff,
  staffJobRoles,
  trainingCourses,
  workforceRotaEntries as entries,
  workforceShifts as shifts,
  workforceStaffingRequirements as requirements,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { z } from "zod";
import { ApiError, notFound } from "../errors";
import { executeLedgerCommand } from "./ledger-command";
import { competenceLookup } from "./ports/training";
import { agencyEngagementsFor, agencyOn, isUnavailable, unavailableRanges } from "./workforce-rota";

/**
 * Competence-based staffing (Phase 3.4.4.3): what each shift needs, checked against the rota,
 * recorded absences and Training. Requirements are independent, so one person can count towards
 * several (an operative who is also the first aider).
 */

const conflict = (message: string) => new ApiError(409, "workforce_conflict", message);
type Requirement = typeof requirements.$inferSelect;
type RequirementInput = z.infer<typeof staffingRequirementCreateSchema>;

export interface StaffingOptions {
  absencesEnabled: boolean;
  trainingEnabled: boolean;
  productionEnabled: boolean;
  /** The caller can read Training, so per-course reasons are shown rather than summarised. */
  canReadTraining: boolean;
  /** The caller can read Production, so planned batches per line are shown (they're used either way). */
  canReadProduction: boolean;
  today: string;
}

/**
 * Every reference must belong to this workspace, whether or not the requirement is active. An
 * active requirement needs an active shift, and any course it newly adds must be active; courses
 * it already had may since have been archived (the check reports them as `course_archived`).
 */
async function validateRequirement(
  tx: Executor,
  ws: string,
  input: RequirementInput & { active?: boolean },
  existingCourseIds: readonly string[] = [],
) {
  const active = input.active ?? true;
  const [shift] = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.workspaceId, ws), eq(shifts.id, input.shiftId)));
  if (!shift) throw notFound("Shift");
  if (active && !shift.active) throw conflict("That shift is inactive");
  if (input.appliesWhen === "production_planned" && !shift.lineId)
    throw conflict("Link the shift to a production line to apply this only when production is planned");
  if (input.jobRoleId) {
    const [role] = await tx
      .select({ id: jobRoles.id })
      .from(jobRoles)
      .where(and(eq(jobRoles.workspaceId, ws), eq(jobRoles.id, input.jobRoleId), isNull(jobRoles.deletedAt)));
    if (!role) throw notFound("Job role");
  }
  if (input.courseIds.length) {
    const found = await tx
      .select({ id: trainingCourses.id, status: trainingCourses.status })
      .from(trainingCourses)
      .where(and(eq(trainingCourses.workspaceId, ws), inArray(trainingCourses.id, input.courseIds)));
    if (found.length !== input.courseIds.length) throw notFound("Training course");
    const added = found.filter((c) => !existingCourseIds.includes(c.id));
    if (active && added.some((c) => c.status !== "active")) throw notFound("Active training course");
  }
}

const values = (input: RequirementInput) => ({
  shiftId: input.shiftId,
  name: input.name,
  headcount: input.headcount,
  jobRoleId: input.jobRoleId,
  courseIds: input.courseIds,
  weekdays: input.weekdays,
  appliesWhen: input.appliesWhen,
  validFrom: input.validFrom,
  validTo: input.validTo,
});

/** Course codes and titles are Training data: readers without Training access get `courses: null`. */
export async function listRequirements(db: Database, ws: string, options: { canReadTraining: boolean }) {
  const rows = await db
    .select({ requirement: requirements, shiftName: shifts.name, jobRoleName: jobRoles.name })
    .from(requirements)
    .innerJoin(shifts, and(eq(shifts.id, requirements.shiftId), eq(shifts.workspaceId, ws)))
    .leftJoin(jobRoles, and(eq(jobRoles.id, requirements.jobRoleId), eq(jobRoles.workspaceId, ws)))
    .where(eq(requirements.workspaceId, ws))
    .orderBy(asc(shifts.startTime), asc(shifts.name), asc(requirements.name))
    .limit(501);
  const courseIds = options.canReadTraining ? [...new Set(rows.flatMap((r) => r.requirement.courseIds))] : [];
  const courses = courseIds.length
    ? await db
        .select({
          id: trainingCourses.id,
          code: trainingCourses.code,
          title: trainingCourses.title,
          status: trainingCourses.status,
        })
        .from(trainingCourses)
        .where(and(eq(trainingCourses.workspaceId, ws), inArray(trainingCourses.id, courseIds)))
    : [];
  const courseById = new Map(courses.map((c) => [c.id, c]));
  return {
    requirements: rows.slice(0, 500).map((r) => ({
      ...r.requirement,
      shiftName: r.shiftName,
      jobRoleName: r.jobRoleName,
      courses: options.canReadTraining
        ? r.requirement.courseIds.map((id) => {
            const c = courseById.get(id);
            return c
              ? { id: c.id, code: c.code, title: c.title, active: c.status === "active" }
              : { id, code: "?", title: "Unavailable course", active: false };
          })
        : null,
    })),
    hasMore: rows.length > 500,
  };
}

export async function createRequirement(db: Database, ws: string, actorId: string, input: RequirementInput) {
  return executeLedgerCommand(db, ws, actorId, "workforce.staffing.create", input, input, async (tx) => {
    await validateRequirement(tx, ws, input);
    const [row] = await tx
      .insert(requirements)
      .values({ workspaceId: ws, ...values(input), createdBy: actorId })
      .returning();
    return row!;
  });
}

export async function updateRequirement(
  db: Database,
  ws: string,
  actorId: string,
  id: string,
  input: z.infer<typeof staffingRequirementUpdateSchema>,
) {
  return executeLedgerCommand(
    db,
    ws,
    actorId,
    "workforce.staffing.update",
    input,
    { id, ...input },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(requirements)
        .where(and(eq(requirements.workspaceId, ws), eq(requirements.id, id)));
      if (!row) throw notFound("Staffing requirement");
      if (row.revision !== input.expectedRevision)
        throw conflict("This staffing requirement changed. Reload and review the latest version.");
      await validateRequirement(tx, ws, input, row.courseIds);
      const [updated] = await tx
        .update(requirements)
        .set({ ...values(input), active: input.active, revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(requirements.id, id))
        .returning();
      return updated!;
    },
  );
}

/** Whether a requirement applies on a date, and if not, why. */
function applies(
  r: Requirement,
  date: string,
  production: { planned: number | null; nonWorkingDay: boolean } | null,
  options: StaffingOptions,
): { applies: true } | { applies: false; reason: string } | { applies: null; reason: string } {
  if (r.validFrom > date || (r.validTo && r.validTo < date) || !onWeekday(r.weekdays, date))
    return { applies: false, reason: "not_scheduled" };
  if (r.appliesWhen === "production_planned") {
    if (!options.productionEnabled || !production) return { applies: null, reason: "production_unavailable" };
    if (production.nonWorkingDay) return { applies: false, reason: "non_working_day" };
    if (!production.planned) return { applies: false, reason: "no_production_planned" };
  }
  return { applies: true };
}

/**
 * The staffing check for a window. For each date and shift with requirements or rota entries it
 * reports, per requirement that applies, the people who count, the shortfall, and why each other
 * rostered person doesn't count. Training standings use today's records and must stay valid
 * through the shift date. With Private HR records off, absences can't be seen, so the result says
 * so (`absenceSourceEnabled: false`) rather than implying everyone is available.
 */
export async function staffingCheck(
  db: Database,
  ws: string,
  query: { from: string; to: string },
  options: StaffingOptions,
) {
  const shiftRows = await db.select().from(shifts).where(eq(shifts.workspaceId, ws));
  const shiftById = new Map(shiftRows.map((s) => [s.id, s]));
  const reqRows = await db
    .select()
    .from(requirements)
    .where(
      and(
        eq(requirements.workspaceId, ws),
        eq(requirements.active, true),
        lte(requirements.validFrom, query.to),
        or(isNull(requirements.validTo), gte(requirements.validTo, query.from)),
      ),
    )
    .orderBy(asc(requirements.name), asc(requirements.id));
  const entryRows = await db
    .select({
      id: entries.id,
      shiftId: entries.shiftId,
      workDate: entries.workDate,
      staffId: entries.staffId,
      jobRoleId: entries.jobRoleId,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(entries)
    .innerJoin(staff, eq(staff.id, entries.staffId))
    .where(
      and(
        eq(entries.workspaceId, ws),
        eq(entries.state, "active"),
        gte(entries.workDate, query.from),
        lte(entries.workDate, query.to),
      ),
    )
    .orderBy(asc(staff.lastName), asc(staff.firstName), asc(entries.id))
    .limit(5001);
  if (entryRows.length > 5000) throw conflict("This window has too many rota entries. Narrow the dates.");
  const staffIds = [...new Set(entryRows.map((e) => e.staffId))];

  const roleRows = await db
    .select({ id: jobRoles.id, name: jobRoles.name })
    .from(jobRoles)
    .where(eq(jobRoles.workspaceId, ws));
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  const held = new Set(
    (staffIds.length
      ? await db
          .select({ staffId: staffJobRoles.staffId, jobRoleId: staffJobRoles.jobRoleId })
          .from(staffJobRoles)
          .where(and(inArray(staffJobRoles.staffId, staffIds), isNull(staffJobRoles.deletedAt)))
      : []
    ).map((r) => `${r.staffId}:${r.jobRoleId}`),
  );
  const unavailable = options.absencesEnabled
    ? await unavailableRanges(db, ws, staffIds, query.from, query.to)
    : null;
  const agencyMap = await agencyEngagementsFor(db, ws, staffIds, query.from, query.to);
  const needsTraining = reqRows.some((r) => r.courseIds.length);
  const competence =
    needsTraining && options.trainingEnabled ? await competenceLookup(db, ws, staffIds, options.today) : null;

  // Production per line and date: batches still to make (planned or in progress) and non-working days.
  const lineIds = [...new Set(shiftRows.flatMap((s) => (s.lineId ? [s.lineId] : [])))];
  const planned = new Map<string, number>();
  const closed = new Set<string>();
  if (options.productionEnabled && lineIds.length) {
    const batches = await db
      .select({ lineId: productionBatches.lineId, plannedOn: productionBatches.plannedOn })
      .from(productionBatches)
      .where(
        and(
          eq(productionBatches.workspaceId, ws),
          inArray(productionBatches.lineId, lineIds),
          inArray(productionBatches.status, ["planned", "in_progress"]),
          gte(productionBatches.plannedOn, query.from),
          lte(productionBatches.plannedOn, query.to),
          isNull(productionBatches.deletedAt),
        ),
      );
    for (const b of batches)
      planned.set(`${b.lineId}:${b.plannedOn}`, (planned.get(`${b.lineId}:${b.plannedOn}`) ?? 0) + 1);
    const days = await db
      .select({ date: productionNonWorkingDays.date, lineId: productionNonWorkingDays.lineId })
      .from(productionNonWorkingDays)
      .where(
        and(
          eq(productionNonWorkingDays.workspaceId, ws),
          gte(productionNonWorkingDays.date, query.from),
          lte(productionNonWorkingDays.date, query.to),
          isNull(productionNonWorkingDays.deletedAt),
        ),
      );
    for (const d of days) closed.add(`${d.lineId ?? "*"}:${d.date}`);
  }

  const entriesBy = new Map<string, typeof entryRows>();
  for (const e of entryRows) {
    const key = `${e.workDate}:${e.shiftId}`;
    const list = entriesBy.get(key) ?? [];
    list.push(e);
    entriesBy.set(key, list);
  }
  const reqsByShift = new Map<string, Requirement[]>();
  for (const r of reqRows) {
    // A deactivated shift is no longer staffed, so its requirements don't apply.
    if (!shiftById.get(r.shiftId)?.active) continue;
    const list = reqsByShift.get(r.shiftId) ?? [];
    list.push(r);
    reqsByShift.set(r.shiftId, list);
  }
  const shiftIds = [...new Set([...reqsByShift.keys(), ...entryRows.map((e) => e.shiftId)])]
    .filter((id) => shiftById.has(id))
    .sort((a, b) => {
      const x = shiftById.get(a)!;
      const y = shiftById.get(b)!;
      return x.startTime.localeCompare(y.startTime) || x.name.localeCompare(y.name);
    });

  const courseLabel = (id: string) =>
    competence?.course(id) ?? { id, code: "?", title: "Unavailable course", active: false };
  const days = [];
  let checked = 0;
  let short = 0;
  let unfilled = 0;
  for (const date of datesBetween(query.from, query.to)) {
    for (const shiftId of shiftIds) {
      const shift = shiftById.get(shiftId)!;
      const rostered = entriesBy.get(`${date}:${shiftId}`) ?? [];
      const reqs = reqsByShift.get(shiftId) ?? [];
      if (!rostered.length && !reqs.length) continue;
      const production = shift.lineId
        ? {
            planned: options.productionEnabled ? (planned.get(`${shift.lineId}:${date}`) ?? 0) : null,
            nonWorkingDay: closed.has(`*:${date}`) || closed.has(`${shift.lineId}:${date}`),
          }
        : null;
      const people = rostered.map((e) => ({
        entryId: e.id,
        staff: { id: e.staffId, staffNumber: e.staffNumber, firstName: e.firstName, lastName: e.lastName },
        jobRole: e.jobRoleId ? { id: e.jobRoleId, name: roleName.get(e.jobRoleId) ?? "" } : null,
        agency: agencyOn(agencyMap, e.staffId, date),
        unavailable: unavailable ? isUnavailable(unavailable, e.staffId, date) : null,
      }));
      const results = [];
      for (const r of reqs) {
        const when = applies(r, date, production, options);
        if (when.applies === false && when.reason === "not_scheduled") continue;
        const base = {
          requirementId: r.id,
          name: r.name,
          headcount: r.headcount,
          jobRole: r.jobRoleId ? { id: r.jobRoleId, name: roleName.get(r.jobRoleId) ?? "" } : null,
          courses: options.canReadTraining
            ? r.courseIds.map((id) => {
                const c = courseLabel(id);
                return { id: c.id, code: c.code, title: c.title };
              })
            : null,
        };
        if (when.applies !== true) {
          results.push({
            ...base,
            applies: when.applies,
            reason: when.reason,
            counted: [],
            shortfall: 0,
            excluded: [],
          });
          continue;
        }
        if (r.courseIds.length && !competence) {
          results.push({
            ...base,
            applies: null,
            reason: "training_unavailable",
            counted: [],
            shortfall: 0,
            excluded: [],
          });
          continue;
        }
        const counted: string[] = [];
        const excluded: {
          staffId: string;
          reasons: {
            reason: StaffingGapReason | "competence_not_met";
            courseId?: string;
            expiresOn?: string | null;
          }[];
        }[] = [];
        for (const p of people) {
          const reasons: (typeof excluded)[number]["reasons"] = [];
          if (p.unavailable) reasons.push({ reason: "unavailable" });
          if (r.jobRoleId && !held.has(`${p.staff.id}:${r.jobRoleId}`))
            reasons.push({ reason: "role_not_held" });
          const gaps = r.courseIds.flatMap((courseId) => {
            const gap = competence!.gap(p.staff.id, courseId, date);
            return gap ? [{ reason: gap.reason, courseId, expiresOn: gap.expiresOn }] : [];
          });
          if (gaps.length)
            reasons.push(...(options.canReadTraining ? gaps : [{ reason: "competence_not_met" as const }]));
          if (reasons.length) excluded.push({ staffId: p.staff.id, reasons });
          else counted.push(p.staff.id);
        }
        const shortfall = Math.max(0, r.headcount - counted.length);
        checked++;
        if (shortfall) {
          short++;
          unfilled += shortfall;
        }
        results.push({ ...base, applies: true as const, reason: null, counted, shortfall, excluded });
      }
      // A shift with nobody rostered and no requirement in effect that day has nothing to show.
      if (!rostered.length && !results.length) continue;
      days.push({
        date,
        shift: {
          id: shift.id,
          name: shift.name,
          startTime: shift.startTime,
          endTime: shift.endTime,
          lineId: shift.lineId,
          active: shift.active,
        },
        production: options.canReadProduction ? production : null,
        people,
        requirements: results,
      });
    }
  }
  return {
    from: query.from,
    to: query.to,
    absenceSourceEnabled: options.absencesEnabled,
    trainingSourceEnabled: options.trainingEnabled,
    productionSourceEnabled: options.productionEnabled,
    summary: { requirementsChecked: checked, shortfalls: short, unfilledPositions: unfilled },
    shifts: days,
  };
}
