import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  isWeakPin,
  nextStaffNumber,
  STAFF_PIN_LOCK_MINUTES,
  STAFF_PIN_MAX_ATTEMPTS,
  type JobRoleCreateInput,
  type JobRoleListQuery,
  type JobRoleUpdateInput,
  type StaffCreateInput,
  type StaffListQuery,
  type StaffUpdateInput,
} from "@knotworking/core";
import {
  jobRoles,
  lockWorkspaceLog,
  recordChanges,
  staff,
  staffJobRoles,
  trainingCourses,
  sopTargets,
  trainingRequirements,
  users,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceToday } from "./time-zone";
import { hasWorkforceRecords } from "./workforce";
import { hasAttendanceEvents } from "./attendance";
import { hasTrainingRecords } from "./ports/training";

/**
 * People module: the staff register (people with or without a login), their job roles and their
 * kiosk PINs.
 *
 * PINs are six digits, so a plain hash would fall to a brute force of 10⁶ guesses. They are
 * stored as HMAC-SHA-256 under a key derived from the server secret, salted with the workspace
 * and staff ids: a database dump alone reveals nothing. Changing `BETTER_AUTH_SECRET` therefore
 * invalidates every PIN. Online guessing is limited by the lock-out in `verifyStaffPin`.
 */

type StaffRow = typeof staff.$inferSelect;
type JobRoleRow = typeof jobRoles.$inferSelect;

/** `%` and `_` are literal in a search box. */
const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

/** The key PINs are hashed under, derived from the server secret. */
export const deriveStaffPinKey = (secret: string) =>
  createHmac("sha256", secret).update("knotworking:staff-pin:v1").digest();

const hashPin = (key: Buffer, row: Pick<StaffRow, "workspaceId" | "id">, pin: string) =>
  createHmac("sha256", key).update(`${row.workspaceId}:${row.id}:${pin}`).digest("hex");

const pinMatches = (key: Buffer, row: StaffRow, pin: string) => {
  if (!row.pinHash) return false;
  const a = Buffer.from(hashPin(key, row, pin), "hex");
  const b = Buffer.from(row.pinHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

/** A random PIN that `isWeakPin` accepts. */
export function generatePin(staffNumber: string): string {
  for (;;) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!isWeakPin(pin, staffNumber)) return pin;
  }
}

const isLocked = (row: StaffRow, now = new Date()) => !!row.pinLockedUntil && row.pinLockedUntil > now;

// ─── Serializing ─────────────────────────────────────────────────────────────

/** What leaves the API about a person: never the PIN hash or the attempt counter. */
function staffData(row: StaffRow) {
  const {
    workspaceId: _ws,
    deletedAt: _deleted,
    pinHash,
    pinFailedAttempts: _attempts,
    pinLockedUntil,
    ...rest
  } = row;
  return {
    ...rest,
    hasPin: pinHash !== null,
    pinLockedUntil: pinLockedUntil && pinLockedUntil > new Date() ? pinLockedUntil : null,
  };
}

export const staffChange = (row: StaffRow): ChangeInput => ({
  entity: "staff",
  entityId: row.id,
  action: "upsert",
  data: staffData(row),
});

interface StaffExtras {
  jobRoles: { id: string; name: string }[];
  user: { id: string; name: string; email: string } | null;
}

async function staffExtras(db: Executor, rows: StaffRow[]) {
  const byStaff = new Map<string, StaffExtras>();
  for (const row of rows) byStaff.set(row.id, { jobRoles: [], user: null });
  if (rows.length === 0) return byStaff;
  const ids = rows.map((r) => r.id);
  const roleRows = await db
    .select({ staffId: staffJobRoles.staffId, id: jobRoles.id, name: jobRoles.name })
    .from(staffJobRoles)
    .innerJoin(jobRoles, and(eq(jobRoles.id, staffJobRoles.jobRoleId), isNull(jobRoles.deletedAt)))
    .where(and(inArray(staffJobRoles.staffId, ids), isNull(staffJobRoles.deletedAt)))
    .orderBy(asc(jobRoles.name));
  for (const { staffId, ...role } of roleRows) byStaff.get(staffId)!.jobRoles.push(role);
  const userIds = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))];
  if (userIds.length) {
    const userRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds));
    const byId = new Map(userRows.map((u) => [u.id, u]));
    for (const row of rows) if (row.userId) byStaff.get(row.id)!.user = byId.get(row.userId) ?? null;
  }
  return byStaff;
}

const serializeStaff = (row: StaffRow, extras: StaffExtras | undefined) => ({
  ...staffData(row),
  jobRoles: extras?.jobRoles ?? [],
  user: extras?.user ?? null,
});

// ─── Staff ───────────────────────────────────────────────────────────────────

export async function listStaff(db: Database, workspaceId: string, query: StaffListQuery) {
  const where: (SQL | undefined)[] = [eq(staff.workspaceId, workspaceId), isNull(staff.deletedAt)];
  if (query.status !== "all") where.push(eq(staff.status, query.status));
  if (query.department) where.push(sql`lower(${staff.department}) = lower(${query.department})`);
  if (query.q) {
    const q = like(query.q);
    where.push(
      or(
        sql`(${staff.firstName} || ' ' || ${staff.lastName}) ilike ${q} escape '!'`,
        sql`${staff.staffNumber} ilike ${q} escape '!'`,
        sql`${staff.payrollReference} ilike ${q} escape '!'`,
        sql`${staff.jobTitle} ilike ${q} escape '!'`,
        sql`${staff.department} ilike ${q} escape '!'`,
      ),
    );
  }
  if (query.jobRoleId) {
    where.push(
      sql`exists (select 1 from ${staffJobRoles} where ${staffJobRoles.staffId} = ${staff.id}
        and ${staffJobRoles.jobRoleId} = ${query.jobRoleId} and ${staffJobRoles.deletedAt} is null)`,
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(staff)
      .where(and(...where))
      .orderBy(asc(staff.lastName), asc(staff.firstName), asc(staff.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(staff)
      .where(and(...where)),
  ]);
  const extras = await staffExtras(db, rows);
  return {
    staff: rows.map((row) => serializeStaff(row, extras.get(row.id))),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findStaff(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(staff)
    .where(and(eq(staff.id, id), eq(staff.workspaceId, workspaceId), isNull(staff.deletedAt)));
  if (!row) throw notFound("Staff member");
  return row;
}

export async function getStaff(db: Executor, workspaceId: string, id: string) {
  const row = await findStaff(db, workspaceId, id);
  return serializeStaff(row, (await staffExtras(db, [row])).get(row.id));
}

/** The staff number a new person would get (every number ever used counts, deleted rows included). */
export async function suggestStaffNumber(db: Executor, workspaceId: string) {
  const rows = await db
    .select({ n: staff.staffNumber })
    .from(staff)
    .where(eq(staff.workspaceId, workspaceId));
  return nextStaffNumber(rows.map((r) => r.n));
}

async function assertStaffNumberFree(
  tx: Transaction,
  workspaceId: string,
  number: string,
  exceptId?: string,
) {
  const [taken] = await tx
    .select({ id: staff.id, deletedAt: staff.deletedAt })
    .from(staff)
    .where(
      and(
        eq(staff.workspaceId, workspaceId),
        eq(staff.staffNumber, number),
        exceptId ? ne(staff.id, exceptId) : undefined,
      ),
    );
  if (taken) {
    throw new ApiError(
      409,
      "staff_number_taken",
      taken.deletedAt
        ? `Staff number ${number} belonged to someone who was removed; numbers are never reused`
        : `Staff number ${number} is already in use`,
    );
  }
}

async function assertUserLinkable(tx: Transaction, workspaceId: string, userId: string, exceptId?: string) {
  const [member] = await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!member) throw badRequest("userId is not a member of this workspace");
  const [linked] = await tx
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(
        eq(staff.workspaceId, workspaceId),
        eq(staff.userId, userId),
        isNull(staff.deletedAt),
        exceptId ? ne(staff.id, exceptId) : undefined,
      ),
    );
  if (linked)
    throw new ApiError(409, "user_already_linked", "That member is already linked to another staff record");
}

/** Replaces a person's job roles, returning the sync changes. */
export async function setStaffJobRoles(
  tx: Transaction,
  workspaceId: string,
  staffId: string,
  roleIds: string[],
): Promise<ChangeInput[]> {
  if (roleIds.length) {
    const known = await tx
      .select({ id: jobRoles.id })
      .from(jobRoles)
      .where(
        and(eq(jobRoles.workspaceId, workspaceId), isNull(jobRoles.deletedAt), inArray(jobRoles.id, roleIds)),
      );
    if (known.length !== roleIds.length) throw badRequest("Unknown jobRoleId");
  }
  const changes: ChangeInput[] = [];
  const now = new Date();
  const wanted = new Set(roleIds);
  const existing = await tx
    .select()
    .from(staffJobRoles)
    .where(and(eq(staffJobRoles.staffId, staffId), isNull(staffJobRoles.deletedAt)));
  const have = new Set(existing.map((r) => r.jobRoleId));
  for (const row of existing) {
    if (wanted.has(row.jobRoleId)) continue;
    await tx.update(staffJobRoles).set({ deletedAt: now }).where(eq(staffJobRoles.id, row.id));
    changes.push({ entity: "staff_job_role", entityId: row.id, action: "delete" });
  }
  for (const jobRoleId of roleIds) {
    if (have.has(jobRoleId)) continue;
    const [row] = await tx
      .insert(staffJobRoles)
      .values({ workspaceId, staffId, jobRoleId })
      .onConflictDoUpdate({
        target: [staffJobRoles.staffId, staffJobRoles.jobRoleId],
        set: { deletedAt: null, updatedAt: now },
      })
      .returning();
    const { workspaceId: _ws, deletedAt: _deleted, ...data } = row!;
    changes.push({ entity: "staff_job_role", entityId: row!.id, action: "upsert", data });
  }
  return changes;
}

export async function createStaff(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: StaffCreateInput,
) {
  const { jobRoleIds, id, staffNumber: requested, ...fields } = input;
  return db.transaction(async (tx) => {
    // Check-then-insert on the staff number and user link: queue behind other writers.
    await lockWorkspaceLog(tx, workspaceId);
    const staffNumber = requested ?? (await suggestStaffNumber(tx, workspaceId));
    if (!staffNumber)
      throw new ApiError(409, "staff_numbers_exhausted", "Every six-digit staff number is in use");
    await assertStaffNumberFree(tx, workspaceId, staffNumber);
    if (fields.userId) await assertUserLinkable(tx, workspaceId, fields.userId);
    const [row] = await tx
      .insert(staff)
      .values({ ...fields, staffNumber, ...(id ? { id } : {}), workspaceId })
      .returning();
    const roleChanges = jobRoleIds ? await setStaffJobRoles(tx, workspaceId, row!.id, jobRoleIds) : [];
    await recordChanges(tx, workspaceId, actorId, [staffChange(row!), ...roleChanges]);
    return getStaff(tx, workspaceId, row!.id);
  });
}

export async function updateStaff(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: StaffUpdateInput,
) {
  const { jobRoleIds, ...fields } = patch;
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findStaff(tx, workspaceId, id);
    if (fields.staffNumber !== undefined && fields.staffNumber !== current.staffNumber) {
      // Payroll and training history refer to the number: once there is any, it is fixed.
      if (
        (await hasTrainingRecords(tx, id)) ||
        (await hasAttendanceEvents(tx, id)) ||
        (await hasWorkforceRecords(tx, id))
      ) {
        throw new ApiError(
          409,
          "staff_number_fixed",
          "This person has training, absence or attendance records, so their staff number can't change",
        );
      }
      await assertStaffNumberFree(tx, workspaceId, fields.staffNumber, id);
    }
    if (fields.userId) await assertUserLinkable(tx, workspaceId, fields.userId, id);
    // Becoming a leaver records the last day (today unless given); coming back clears it.
    if (fields.status === "leaver" && current.status !== "leaver" && fields.endDate === undefined) {
      fields.endDate = current.endDate ?? (await workspaceToday(tx, workspaceId));
    }
    if (fields.status === "active" && current.status === "leaver" && fields.endDate === undefined) {
      fields.endDate = null;
    }
    const startDate = fields.startDate !== undefined ? fields.startDate : current.startDate;
    const endDate = fields.endDate !== undefined ? fields.endDate : current.endDate;
    if (startDate && endDate && startDate > endDate) throw badRequest("The start date is after the end date");
    const [row] = Object.keys(fields).length
      ? await tx.update(staff).set(fields).where(eq(staff.id, id)).returning()
      : // Job roles only: still bump the person so readers see it changed.
        await tx.update(staff).set({ updatedAt: new Date() }).where(eq(staff.id, id)).returning();
    const roleChanges = jobRoleIds ? await setStaffJobRoles(tx, workspaceId, id, jobRoleIds) : [];
    await recordChanges(tx, workspaceId, actorId, [staffChange(row!), ...roleChanges]);
    return getStaff(tx, workspaceId, id);
  });
}

/**
 * Soft delete, for a record made by mistake. The staff number stays taken. Anyone with training, absence
 * or attendance history should become a leaver instead: the delete is refused.
 */
export async function deleteStaff(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findStaff(tx, workspaceId, id);
    if (
      (await hasTrainingRecords(tx, id)) ||
      (await hasAttendanceEvents(tx, id)) ||
      (await hasWorkforceRecords(tx, id))
    ) {
      throw new ApiError(
        409,
        "staff_has_records",
        "This person has training, absence or attendance records; mark them as a leaver instead",
      );
    }
    const now = new Date();
    await tx.update(staff).set({ deletedAt: now, pinHash: null, userId: null }).where(eq(staff.id, id));
    const links = await tx
      .update(staffJobRoles)
      .set({ deletedAt: now })
      .where(and(eq(staffJobRoles.staffId, id), isNull(staffJobRoles.deletedAt)))
      .returning({ id: staffJobRoles.id });
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "staff", entityId: id, action: "delete" },
      ...links.map((l): ChangeInput => ({ entity: "staff_job_role", entityId: l.id, action: "delete" })),
    ]);
  });
}

// ─── PINs ────────────────────────────────────────────────────────────────────

/**
 * Sets a person's PIN (a manager's act: `manage`, signed in). Without `pin` a random one is
 * generated. The PIN is returned once, here, and never again. Clears any lock-out.
 */
export async function setStaffPin(
  db: Database,
  key: Buffer,
  workspaceId: string,
  actorId: string,
  id: string,
  requested: string | undefined,
) {
  return db.transaction(async (tx) => {
    const current = await findStaff(tx, workspaceId, id);
    if (requested && isWeakPin(requested, current.staffNumber)) {
      throw new ApiError(
        400,
        "weak_pin",
        "That PIN is too easy to guess: avoid repeats, runs and the staff number",
      );
    }
    const pin = requested ?? generatePin(current.staffNumber);
    const [row] = await tx
      .update(staff)
      .set({
        pinHash: hashPin(key, current, pin),
        pinSetAt: new Date(),
        pinSetBy: actorId,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      })
      .where(eq(staff.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [staffChange(row!)]);
    return { pin, staff: await getStaff(tx, workspaceId, id) };
  });
}

/** Removes a person's PIN: they can't use the kiosk until a new one is set. */
export async function clearStaffPin(db: Database, workspaceId: string, actorId: string, id: string) {
  return db.transaction(async (tx) => {
    await findStaff(tx, workspaceId, id);
    const [row] = await tx
      .update(staff)
      .set({
        pinHash: null,
        pinSetAt: new Date(),
        pinSetBy: actorId,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      })
      .where(eq(staff.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [staffChange(row!)]);
    return getStaff(tx, workspaceId, id);
  });
}

/** Lifts a lock-out after too many wrong PINs. */
export async function unlockStaffPin(db: Database, workspaceId: string, actorId: string, id: string) {
  return db.transaction(async (tx) => {
    await findStaff(tx, workspaceId, id);
    const [row] = await tx
      .update(staff)
      .set({ pinFailedAttempts: 0, pinLockedUntil: null })
      .where(eq(staff.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [staffChange(row!)]);
    return getStaff(tx, workspaceId, id);
  });
}

export type PinCheck =
  | { ok: true; staff: StaffRow }
  | { ok: false; reason: "unknown" | "inactive" | "no_pin" | "wrong" }
  | { ok: false; reason: "locked"; lockedUntil: Date };

/**
 * Checks a staff number and PIN (the kiosk). Wrong PINs count; the `STAFF_PIN_MAX_ATTEMPTS`th in
 * a row locks the number for `STAFF_PIN_LOCK_MINUTES`, and a locked number is refused without
 * looking at the PIN. A right PIN resets the count. Callers should show one message for
 * `unknown`, `no_pin` and `wrong` so the kiosk doesn't reveal which staff numbers exist.
 *
 * Counter updates are not in the sync log: they are security state, not data anyone reads.
 */
export async function verifyStaffPin(
  db: Database,
  key: Buffer,
  workspaceId: string,
  staffNumber: string,
  pin: string,
  now = new Date(),
): Promise<PinCheck> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(staff)
      .where(
        and(eq(staff.workspaceId, workspaceId), eq(staff.staffNumber, staffNumber), isNull(staff.deletedAt)),
      )
      .for("update");
    if (!row) return { ok: false, reason: "unknown" } as const;
    if (isLocked(row, now)) return { ok: false, reason: "locked", lockedUntil: row.pinLockedUntil! } as const;
    if (!row.pinHash) return { ok: false, reason: "no_pin" } as const;
    if (!pinMatches(key, row, pin)) {
      // A lock that has run out starts a fresh count.
      const attempts = (row.pinLockedUntil ? 0 : row.pinFailedAttempts) + 1;
      const lock = attempts >= STAFF_PIN_MAX_ATTEMPTS;
      const lockedUntil = new Date(now.getTime() + STAFF_PIN_LOCK_MINUTES * 60_000);
      await tx
        .update(staff)
        .set({ pinFailedAttempts: lock ? 0 : attempts, pinLockedUntil: lock ? lockedUntil : null })
        .where(eq(staff.id, row.id));
      return lock
        ? ({ ok: false, reason: "locked", lockedUntil } as const)
        : ({ ok: false, reason: "wrong" } as const);
    }
    if (row.status !== "active") return { ok: false, reason: "inactive" } as const;
    if (row.pinFailedAttempts || row.pinLockedUntil) {
      await tx.update(staff).set({ pinFailedAttempts: 0, pinLockedUntil: null }).where(eq(staff.id, row.id));
    }
    return { ok: true, staff: row } as const;
  });
}

/** A person changing their own PIN with the current one (the kiosk). */
export async function changeOwnStaffPin(
  db: Database,
  key: Buffer,
  workspaceId: string,
  input: { staffNumber: string; currentPin: string; newPin: string },
) {
  const check = await verifyStaffPin(db, key, workspaceId, input.staffNumber, input.currentPin);
  if (!check.ok) return check;
  if (input.newPin === input.currentPin || isWeakPin(input.newPin, input.staffNumber)) {
    throw new ApiError(400, "weak_pin", "Choose a different PIN: avoid repeats, runs and your staff number");
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(staff)
      .set({ pinHash: hashPin(key, check.staff, input.newPin), pinSetAt: new Date(), pinSetBy: null })
      .where(eq(staff.id, check.staff.id))
      .returning();
    await recordChanges(tx, workspaceId, null, [staffChange(row!)]);
  });
  return check;
}

// ─── Job roles ───────────────────────────────────────────────────────────────

function serializeJobRole(row: JobRoleRow) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
}

const jobRoleChange = (row: JobRoleRow): ChangeInput => ({
  entity: "job_role",
  entityId: row.id,
  action: "upsert",
  data: serializeJobRole(row),
});

export async function listJobRoles(db: Database, workspaceId: string, query: JobRoleListQuery) {
  const where: (SQL | undefined)[] = [eq(jobRoles.workspaceId, workspaceId), isNull(jobRoles.deletedAt)];
  if (query.status !== "all") where.push(eq(jobRoles.status, query.status));
  const rows = await db
    .select()
    .from(jobRoles)
    .where(and(...where))
    .orderBy(asc(jobRoles.name), asc(jobRoles.id));
  const counts = await db
    .select({ jobRoleId: staffJobRoles.jobRoleId, n: count() })
    .from(staffJobRoles)
    .innerJoin(
      staff,
      and(eq(staff.id, staffJobRoles.staffId), isNull(staff.deletedAt), eq(staff.status, "active")),
    )
    .where(and(eq(staffJobRoles.workspaceId, workspaceId), isNull(staffJobRoles.deletedAt)))
    .groupBy(staffJobRoles.jobRoleId);
  const staffCount = new Map(counts.map((c) => [c.jobRoleId, c.n]));
  return rows.map((row) => ({ ...serializeJobRole(row), staffCount: staffCount.get(row.id) ?? 0 }));
}

async function findJobRole(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(jobRoles)
    .where(and(eq(jobRoles.id, id), eq(jobRoles.workspaceId, workspaceId), isNull(jobRoles.deletedAt)));
  if (!row) throw notFound("Job role");
  return row;
}

async function assertJobRoleNameFree(tx: Transaction, workspaceId: string, name: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: jobRoles.id })
    .from(jobRoles)
    .where(
      and(
        eq(jobRoles.workspaceId, workspaceId),
        isNull(jobRoles.deletedAt),
        sql`lower(${jobRoles.name}) = lower(${name})`,
        exceptId ? ne(jobRoles.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "name_taken", `There is already a job role called "${name}"`);
}

export async function createJobRole(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: JobRoleCreateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertJobRoleNameFree(tx, workspaceId, input.name);
    const [row] = await tx
      .insert(jobRoles)
      .values({
        name: input.name,
        description: input.description ?? null,
        ...(input.id ? { id: input.id } : {}),
        workspaceId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [jobRoleChange(row!)]);
    return serializeJobRole(row!);
  });
}

export async function updateJobRole(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: JobRoleUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findJobRole(tx, workspaceId, id);
    if (patch.name) await assertJobRoleNameFree(tx, workspaceId, patch.name, id);
    const [row] = await tx.update(jobRoles).set(patch).where(eq(jobRoles.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [jobRoleChange(row!)]);
    return serializeJobRole(row!);
  });
}

/**
 * Soft-deletes a job role and its assignments. A role a live course requires can't be deleted:
 * the training matrix works through these assignments, so deleting would silently drop the
 * requirement for everyone (and `people:write` must not undo what `training:manage` set up).
 * Archive it instead. The training tables exist even when the training module is inactive.
 */
export async function deleteJobRole(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    // Serialised with `setCourseRequirements`, so a requirement can't land between check and delete.
    await lockWorkspaceLog(tx, workspaceId);
    await findJobRole(tx, workspaceId, id);
    const [required] = await tx
      .select({ id: trainingRequirements.id })
      .from(trainingRequirements)
      .innerJoin(
        trainingCourses,
        and(eq(trainingCourses.id, trainingRequirements.courseId), isNull(trainingCourses.deletedAt)),
      )
      .where(and(eq(trainingRequirements.jobRoleId, id), isNull(trainingRequirements.deletedAt)))
      .limit(1);
    if (required) {
      throw new ApiError(
        409,
        "job_role_in_use",
        "A training course requires this job role; archive it instead of deleting it",
      );
    }
    const [targeted] = await tx
      .select({ id: sopTargets.id })
      .from(sopTargets)
      .where(and(eq(sopTargets.jobRoleId, id), isNull(sopTargets.deletedAt)))
      .limit(1);
    if (targeted) {
      throw new ApiError(
        409,
        "job_role_in_use",
        "An SOP is aimed at this job role; archive it instead of deleting it",
      );
    }
    const now = new Date();
    await tx.update(jobRoles).set({ deletedAt: now }).where(eq(jobRoles.id, id));
    const links = await tx
      .update(staffJobRoles)
      .set({ deletedAt: now })
      .where(and(eq(staffJobRoles.jobRoleId, id), isNull(staffJobRoles.deletedAt)))
      .returning({ id: staffJobRoles.id });
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "job_role", entityId: id, action: "delete" },
      ...links.map((l): ChangeInput => ({ entity: "staff_job_role", entityId: l.id, action: "delete" })),
    ]);
  });
}
