import {
  addDaysIso,
  addMonthsIso,
  type ModuleId,
  dateInZone,
  trainingGapStatuses,
  trainingStatus,
  type TrainingCellStatus,
  type TrainingCourseCreateInput,
  type TrainingCourseListQuery,
  type TrainingCourseUpdateInput,
  type TrainingDueQuery,
  type TrainingMatrixQuery,
  type TrainingRecordCreateInput,
  type TrainingRecordListQuery,
  type TrainingRequirementsInput,
  type TrainingStatus,
} from "@knotworking/core";
import {
  jobRoles,
  lockWorkspaceLog,
  recordChanges,
  sopAcknowledgements,
  sops,
  sopVersions,
  staff,
  staffJobRoles,
  trainingCourses,
  trainingRecords,
  trainingRequirements,
  users,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ApiError, badRequest, notFound } from "../errors";
import { workspaceTimeZone, workspaceToday } from "./time-zone";

/**
 * Training module: courses, which job roles need them, and append-only training records.
 *
 * Where a person stands on a course (`trainingStatus` in core) is derived on every read from their
 * records, their roles' requirements and, for SOP courses, the SOP's current approved version.
 * Nothing about it is stored, so approving a new SOP version or changing a requirement takes
 * effect at once with no extra write.
 *
 * "Today" is the UTC date unless the caller passes one (tests).
 */

type CourseRow = typeof trainingCourses.$inferSelect;
type RecordRow = typeof trainingRecords.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

const strip = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};

// ─── Courses ─────────────────────────────────────────────────────────────────

export interface CourseReadOptions {
  /** Whether the caller can read SOPs: SOP codes and titles are only shown to them. */
  includeSop: boolean;
}

async function courseExtras(db: Executor, rows: CourseRow[], options: CourseReadOptions) {
  const ids = rows.map((r) => r.id);
  const requirements = new Map<
    string,
    { jobRoleId: string; jobRoleName: string; dueWithinDays: number | null }[]
  >();
  const recordCounts = new Map<string, number>();
  const sopInfo = new Map<
    string,
    { id: string; code: string; title: string; currentVersion: number | null }
  >();
  if (ids.length === 0) return { requirements, recordCounts, sopInfo };
  const reqRows = await db
    .select({
      courseId: trainingRequirements.courseId,
      jobRoleId: jobRoles.id,
      jobRoleName: jobRoles.name,
      dueWithinDays: trainingRequirements.dueWithinDays,
    })
    .from(trainingRequirements)
    .innerJoin(jobRoles, and(eq(jobRoles.id, trainingRequirements.jobRoleId), isNull(jobRoles.deletedAt)))
    .where(and(inArray(trainingRequirements.courseId, ids), isNull(trainingRequirements.deletedAt)))
    .orderBy(asc(jobRoles.name));
  for (const { courseId, ...req } of reqRows) {
    const list = requirements.get(courseId) ?? [];
    list.push(req);
    requirements.set(courseId, list);
  }
  const counts = await db
    .select({ courseId: trainingRecords.courseId, n: count() })
    .from(trainingRecords)
    .where(and(inArray(trainingRecords.courseId, ids), isNull(trainingRecords.voidedAt)))
    .groupBy(trainingRecords.courseId);
  for (const c of counts) recordCounts.set(c.courseId, c.n);
  const sopIds = [...new Set(rows.flatMap((r) => (r.sopId ? [r.sopId] : [])))];
  if (options.includeSop && sopIds.length) {
    const sopRows = await db
      .select({ id: sops.id, code: sops.code, title: sops.title })
      .from(sops)
      .where(and(inArray(sops.id, sopIds), isNull(sops.deletedAt)));
    const current = await currentSopVersions(db, sopIds);
    for (const s of sopRows)
      sopInfo.set(s.id, { ...s, currentVersion: current.get(s.id)?.versionNumber ?? null });
  }
  return { requirements, recordCounts, sopInfo };
}

const serializeCourse = (row: CourseRow, extras: Awaited<ReturnType<typeof courseExtras>>) => ({
  ...strip(row),
  sop: row.sopId ? (extras.sopInfo.get(row.sopId) ?? null) : null,
  requirements: extras.requirements.get(row.id) ?? [],
  recordCount: extras.recordCounts.get(row.id) ?? 0,
});

const courseChange = (row: CourseRow): ChangeInput => ({
  entity: "training_course",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

export async function listCourses(
  db: Database,
  workspaceId: string,
  query: TrainingCourseListQuery,
  options: CourseReadOptions,
) {
  const where: (SQL | undefined)[] = [
    eq(trainingCourses.workspaceId, workspaceId),
    isNull(trainingCourses.deletedAt),
  ];
  if (query.status !== "all") where.push(eq(trainingCourses.status, query.status));
  if (query.kind) where.push(eq(trainingCourses.kind, query.kind));
  if (query.sopId) where.push(eq(trainingCourses.sopId, query.sopId));
  if (query.q) {
    where.push(
      or(
        sql`${trainingCourses.title} ilike ${like(query.q)} escape '!'`,
        sql`${trainingCourses.code} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  const rows = await db
    .select()
    .from(trainingCourses)
    .where(and(...where))
    .orderBy(asc(trainingCourses.code), asc(trainingCourses.id));
  const extras = await courseExtras(db, rows, options);
  return rows.map((row) => serializeCourse(row, extras));
}

async function findCourse(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(trainingCourses)
    .where(
      and(
        eq(trainingCourses.id, id),
        eq(trainingCourses.workspaceId, workspaceId),
        isNull(trainingCourses.deletedAt),
      ),
    );
  if (!row) throw notFound("Course");
  return row;
}

export async function getCourse(db: Executor, workspaceId: string, id: string, options: CourseReadOptions) {
  const row = await findCourse(db, workspaceId, id);
  return serializeCourse(row, await courseExtras(db, [row], options));
}

async function assertCourseCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: trainingCourses.id })
    .from(trainingCourses)
    .where(
      and(
        eq(trainingCourses.workspaceId, workspaceId),
        isNull(trainingCourses.deletedAt),
        sql`lower(${trainingCourses.code}) = lower(${code})`,
        exceptId ? ne(trainingCourses.id, exceptId) : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another course already uses the code "${code}"`);
}

async function assertSop(tx: Transaction, workspaceId: string, sopId: string) {
  const [row] = await tx
    .select({ id: sops.id })
    .from(sops)
    .where(and(eq(sops.id, sopId), eq(sops.workspaceId, workspaceId), isNull(sops.deletedAt)));
  if (!row) throw badRequest("Unknown sopId");
}

export async function createCourse(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: TrainingCourseCreateInput,
  options: CourseReadOptions,
  active: readonly ModuleId[] = [],
) {
  const { id, ...fields } = input;
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertCourseCodeFree(tx, workspaceId, fields.code);
    if (fields.sopId) await assertSop(tx, workspaceId, fields.sopId);
    const [row] = await tx
      .insert(trainingCourses)
      .values({ ...fields, ...(id ? { id } : {}), workspaceId })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [courseChange(row!)]);
    // Linking a course to an SOP counts the acknowledgements people already made of it.
    if (row!.kind === "sop" && row!.sopId && row!.status === "active" && active.includes("sops")) {
      await backfillCourseFromAcknowledgements(tx, workspaceId, row!);
    }
    return getCourse(tx, workspaceId, row!.id, options);
  });
}

export async function updateCourse(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: TrainingCourseUpdateInput,
  options: CourseReadOptions,
  active: readonly ModuleId[] = [],
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const current = await findCourse(tx, workspaceId, id);
    if (patch.code !== undefined) await assertCourseCodeFree(tx, workspaceId, patch.code, id);
    const kind = patch.kind ?? current.kind;
    const sopId = patch.sopId !== undefined ? patch.sopId : current.sopId;
    if ((kind === "sop") !== Boolean(sopId)) {
      throw badRequest("An SOP course needs an SOP, and only SOP courses have one");
    }
    if (patch.sopId) await assertSop(tx, workspaceId, patch.sopId);
    // Records point at versions of the SOP they were trained on: the SOP can't be swapped after.
    if (patch.sopId !== undefined && patch.sopId !== current.sopId) {
      const [used] = await tx
        .select({ id: trainingRecords.id })
        .from(trainingRecords)
        .where(eq(trainingRecords.courseId, id))
        .limit(1);
      if (used)
        throw new ApiError(
          409,
          "course_has_records",
          "This course has training records; make a new course for another SOP",
        );
    }
    const [row] = await tx.update(trainingCourses).set(patch).where(eq(trainingCourses.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [courseChange(row!)]);
    const linked =
      (patch.sopId !== undefined && patch.sopId !== current.sopId) ||
      (patch.kind === "sop" && current.kind !== "sop") ||
      (patch.status === "active" && current.status !== "active");
    if (linked && row!.kind === "sop" && row!.sopId && row!.status === "active" && active.includes("sops")) {
      await backfillCourseFromAcknowledgements(tx, workspaceId, row!);
    }
    return getCourse(tx, workspaceId, id, options);
  });
}

/** Soft delete, only for a course nobody has been trained on. Archive the others. */
export async function deleteCourse(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await findCourse(tx, workspaceId, id);
    const [used] = await tx
      .select({ id: trainingRecords.id })
      .from(trainingRecords)
      .where(eq(trainingRecords.courseId, id))
      .limit(1);
    if (used)
      throw new ApiError(
        409,
        "course_has_records",
        "People have been trained on this course; archive it instead",
      );
    const now = new Date();
    await tx.update(trainingCourses).set({ deletedAt: now }).where(eq(trainingCourses.id, id));
    const reqs = await tx
      .update(trainingRequirements)
      .set({ deletedAt: now })
      .where(and(eq(trainingRequirements.courseId, id), isNull(trainingRequirements.deletedAt)))
      .returning({ id: trainingRequirements.id });
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "training_course", entityId: id, action: "delete" },
      ...reqs.map((r): ChangeInput => ({ entity: "training_requirement", entityId: r.id, action: "delete" })),
    ]);
  });
}

/** Replaces which job roles need a course. */
export async function setCourseRequirements(
  db: Database,
  workspaceId: string,
  actorId: string,
  courseId: string,
  input: TrainingRequirementsInput,
  options: CourseReadOptions,
) {
  return db.transaction(async (tx) => {
    // Serialised with `deleteJobRole`, which refuses roles a course requires.
    await lockWorkspaceLog(tx, workspaceId);
    await findCourse(tx, workspaceId, courseId);
    const roleIds = input.requirements.map((r) => r.jobRoleId);
    if (roleIds.length) {
      const known = await tx
        .select({ id: jobRoles.id })
        .from(jobRoles)
        .where(
          and(
            eq(jobRoles.workspaceId, workspaceId),
            isNull(jobRoles.deletedAt),
            inArray(jobRoles.id, roleIds),
          ),
        );
      if (known.length !== roleIds.length) throw badRequest("Unknown jobRoleId");
    }
    const now = new Date();
    const changes: ChangeInput[] = [];
    const wanted = new Set(roleIds);
    const existing = await tx
      .select()
      .from(trainingRequirements)
      .where(and(eq(trainingRequirements.courseId, courseId), isNull(trainingRequirements.deletedAt)));
    for (const row of existing) {
      if (wanted.has(row.jobRoleId)) continue;
      await tx
        .update(trainingRequirements)
        .set({ deletedAt: now })
        .where(eq(trainingRequirements.id, row.id));
      changes.push({ entity: "training_requirement", entityId: row.id, action: "delete" });
    }
    for (const req of input.requirements) {
      const dueWithinDays = req.dueWithinDays ?? null;
      const [row] = await tx
        .insert(trainingRequirements)
        .values({ workspaceId, courseId, jobRoleId: req.jobRoleId, dueWithinDays })
        .onConflictDoUpdate({
          target: [trainingRequirements.courseId, trainingRequirements.jobRoleId],
          set: { dueWithinDays, deletedAt: null, updatedAt: now },
        })
        .returning();
      changes.push({
        entity: "training_requirement",
        entityId: row!.id,
        action: "upsert",
        data: strip(row!),
      });
    }
    await recordChanges(tx, workspaceId, actorId, changes);
    return getCourse(tx, workspaceId, courseId, options);
  });
}

// ─── SOP versions ────────────────────────────────────────────────────────────

/** The approved version of each SOP (at most one each). */
async function currentSopVersions(db: Executor, sopIds: string[]) {
  const map = new Map<string, { id: string; versionNumber: number }>();
  if (sopIds.length === 0) return map;
  const rows = await db
    .select({ sopId: sopVersions.sopId, id: sopVersions.id, versionNumber: sopVersions.versionNumber })
    .from(sopVersions)
    .where(and(inArray(sopVersions.sopId, sopIds), eq(sopVersions.status, "approved")));
  for (const r of rows) map.set(r.sopId, { id: r.id, versionNumber: r.versionNumber });
  return map;
}

// ─── Records ─────────────────────────────────────────────────────────────────

const recordChange = (row: RecordRow): ChangeInput => ({
  entity: "training_record",
  entityId: row.id,
  action: "upsert",
  data: strip(row),
});

const signer = alias(users, "signer");
const voider = alias(users, "voider");
const trainer = alias(users, "trainer");

/** Records with the names a reader needs: the person, the course, the trainer, who signed or voided. */
async function recordViews(db: Executor, where: SQL | undefined, page?: { limit: number; offset: number }) {
  const query = db
    .select({
      record: trainingRecords,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      staffUserId: staff.userId,
      courseCode: trainingCourses.code,
      courseTitle: trainingCourses.title,
      requiresSignOff: trainingCourses.requiresSignOff,
      sopVersionNumber: sopVersions.versionNumber,
      trainerUserName: trainer.name,
      signedOffByName: signer.name,
      voidedByName: voider.name,
    })
    .from(trainingRecords)
    .innerJoin(staff, eq(staff.id, trainingRecords.staffId))
    .innerJoin(trainingCourses, eq(trainingCourses.id, trainingRecords.courseId))
    .leftJoin(sopVersions, eq(sopVersions.id, trainingRecords.sopVersionId))
    .leftJoin(trainer, eq(trainer.id, trainingRecords.trainerUserId))
    .leftJoin(signer, eq(signer.id, trainingRecords.signedOffBy))
    .leftJoin(voider, eq(voider.id, trainingRecords.voidedBy))
    .where(where)
    .orderBy(desc(trainingRecords.completedOn), desc(trainingRecords.createdAt), desc(trainingRecords.id));
  const rows = page ? await query.limit(page.limit).offset(page.offset) : await query;
  return rows.map(({ record, ...names }) => ({
    ...strip(record),
    staff: {
      id: record.staffId,
      staffNumber: names.staffNumber,
      firstName: names.firstName,
      lastName: names.lastName,
      /** The member this person signs in as: nobody signs off their own training. */
      userId: names.staffUserId,
    },
    course: {
      id: record.courseId,
      code: names.courseCode,
      title: names.courseTitle,
      requiresSignOff: names.requiresSignOff,
    },
    sopVersionNumber: names.sopVersionNumber,
    trainer: record.trainerUserId ? names.trainerUserName : record.trainerName,
    signedOffByName: names.signedOffByName,
    voidedByName: names.voidedByName,
  }));
}

const pendingSignOff = and(
  isNull(trainingRecords.voidedAt),
  isNull(trainingRecords.signedOffAt),
  eq(trainingRecords.outcome, "competent"),
  eq(trainingCourses.requiresSignOff, true),
);

export async function listRecords(db: Database, workspaceId: string, query: TrainingRecordListQuery) {
  const where: (SQL | undefined)[] = [eq(trainingRecords.workspaceId, workspaceId)];
  if (query.staffId) where.push(eq(trainingRecords.staffId, query.staffId));
  if (query.courseId) where.push(eq(trainingRecords.courseId, query.courseId));
  if (query.includeVoided !== "true") where.push(isNull(trainingRecords.voidedAt));
  if (query.signOff === "pending") where.push(pendingSignOff);
  const [records, [total]] = await Promise.all([
    recordViews(db, and(...where), query),
    db
      .select({ n: count() })
      .from(trainingRecords)
      .innerJoin(trainingCourses, eq(trainingCourses.id, trainingRecords.courseId))
      .where(and(...where)),
  ]);
  return { records, total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}

/**
 * Records one training session for each of `staffIds` (write; API tokens allowed, so an agent can
 * log who attended). For an SOP course the record names the SOP's current approved version.
 * Courses that need a sign-off don't count until a manager signs each person off.
 */
export async function createRecords(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: TrainingRecordCreateInput,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  if (input.completedOn > today) throw badRequest("Training can't be recorded for a future date");
  return db.transaction(async (tx) => {
    const course = await findCourse(tx, workspaceId, input.courseId);
    if (course.status !== "active") throw new ApiError(409, "course_archived", "This course is archived");
    const people = await tx
      .select({ id: staff.id, status: staff.status, firstName: staff.firstName, lastName: staff.lastName })
      .from(staff)
      .where(
        and(eq(staff.workspaceId, workspaceId), isNull(staff.deletedAt), inArray(staff.id, input.staffIds)),
      );
    if (people.length !== input.staffIds.length) throw badRequest("Unknown staffId");
    const leaver = people.find((p) => p.status !== "active");
    if (leaver) {
      throw new ApiError(409, "staff_not_active", `${leaver.firstName} ${leaver.lastName} has left`);
    }
    if (input.trainerUserId) {
      const [member] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, input.trainerUserId),
            isNull(workspaceMembers.deletedAt),
          ),
        );
      if (!member) throw badRequest("trainerUserId is not a member of this workspace");
    }
    let sopVersionId: string | null = null;
    if (course.kind === "sop" && course.sopId) {
      const current = (await currentSopVersions(tx, [course.sopId])).get(course.sopId);
      if (!current) {
        throw new ApiError(
          409,
          "sop_not_approved",
          "The SOP for this course has no approved version to train on",
        );
      }
      sopVersionId = current.id;
    }
    const expiresOn = course.validityMonths ? addMonthsIso(input.completedOn, course.validityMonths) : null;
    const rows = await tx
      .insert(trainingRecords)
      .values(
        input.staffIds.map((staffId) => ({
          workspaceId,
          staffId,
          courseId: course.id,
          sopVersionId,
          completedOn: input.completedOn,
          outcome: input.outcome,
          expiresOn,
          trainerUserId: input.trainerUserId ?? null,
          trainerName: input.trainerName ?? null,
          notes: input.notes ?? null,
          recordedBy: actorId,
        })),
      )
      .returning();
    await recordChanges(tx, workspaceId, actorId, rows.map(recordChange));
    return recordViews(
      tx,
      inArray(
        trainingRecords.id,
        rows.map((r) => r.id),
      ),
    );
  });
}

/**
 * Read-and-acknowledge counts as training. Called inside `acknowledgeSop`'s transaction when both
 * modules are active: `userId` has just acknowledged `version`, the SOP's current approved version.
 * For each active SOP course on that SOP, and the active staff record linked to that login, it
 * appends an ordinary training record dated today (workspace calendar) naming the version, with the
 * course's validity applied and `trainerName` "Read and acknowledged". Nothing is signed off
 * here: a course that needs a competency sign-off gets a `competent` record that waits for a
 * manager (and never for the person themselves), any other course gets an `attended` record that
 * counts at once. A person without a staff record, or a course nobody linked, adds nothing. The
 * course's record for this version is never doubled up (a record for it already exists, voided or
 * not, so a void is not silently undone).
 */
export async function recordSopAcknowledgementTraining(
  tx: Transaction,
  workspaceId: string,
  userId: string,
  version: { id: string; sopId: string; versionNumber: number },
) {
  const [person] = await tx
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(
        eq(staff.workspaceId, workspaceId),
        eq(staff.userId, userId),
        eq(staff.status, "active"),
        isNull(staff.deletedAt),
      ),
    );
  if (!person) return [];
  const courses = await tx
    .select()
    .from(trainingCourses)
    .where(
      and(
        eq(trainingCourses.workspaceId, workspaceId),
        eq(trainingCourses.kind, "sop"),
        eq(trainingCourses.sopId, version.sopId),
        eq(trainingCourses.status, "active"),
        isNull(trainingCourses.deletedAt),
      ),
    );
  if (courses.length === 0) return [];
  const done = await tx
    .select({ courseId: trainingRecords.courseId })
    .from(trainingRecords)
    .where(
      and(
        eq(trainingRecords.staffId, person.id),
        eq(trainingRecords.sopVersionId, version.id),
        inArray(
          trainingRecords.courseId,
          courses.map((c) => c.id),
        ),
      ),
    );
  const have = new Set(done.map((d) => d.courseId));
  const todo = courses.filter((c) => !have.has(c.id));
  if (todo.length === 0) return [];
  const today = await workspaceToday(tx, workspaceId);
  const rows = await tx
    .insert(trainingRecords)
    .values(
      todo.map((course) => ({
        workspaceId,
        staffId: person.id,
        courseId: course.id,
        sopVersionId: version.id,
        completedOn: today,
        outcome: course.requiresSignOff ? ("competent" as const) : ("attended" as const),
        expiresOn: course.validityMonths ? addMonthsIso(today, course.validityMonths) : null,
        trainerName: "Read and acknowledged",
        notes: `Read and acknowledged version ${version.versionNumber} in the SOPs module`,
        recordedBy: userId,
      })),
    )
    .returning();
  await recordChanges(tx, workspaceId, userId, rows.map(recordChange));
  return rows;
}

/**
 * Back-fills an SOP course from acknowledgements already made of the SOP's current approved
 * version (those that predate the link, or the course being active). It follows the live rules of
 * `recordSopAcknowledgementTraining` for each active staff record linked to an acknowledging login:
 * a record dated the day of the acknowledgement (workspace calendar) naming the version, expiry
 * from the course's validity, trainer "Read and acknowledged", `competent` and waiting for a
 * manager's sign-off when the course needs one, otherwise `attended`. A person who already has a
 * record for this course and version (voided or not) is skipped, so running it again adds nothing.
 * Older versions are not back-filled: they are `outdated` anyway.
 */
async function backfillCourseFromAcknowledgements(
  tx: Transaction,
  workspaceId: string,
  course: typeof trainingCourses.$inferSelect,
) {
  if (course.kind !== "sop" || !course.sopId) return { created: 0, skipped: 0 };
  const [current] = await tx
    .select({ id: sopVersions.id, versionNumber: sopVersions.versionNumber })
    .from(sopVersions)
    .where(
      and(
        eq(sopVersions.sopId, course.sopId),
        eq(sopVersions.workspaceId, workspaceId),
        eq(sopVersions.status, "approved"),
        isNull(sopVersions.deletedAt),
      ),
    );
  if (!current) return { created: 0, skipped: 0 };
  const acks = await tx
    .select({
      userId: sopAcknowledgements.userId,
      acknowledgedAt: sopAcknowledgements.acknowledgedAt,
      staffId: staff.id,
    })
    .from(sopAcknowledgements)
    .innerJoin(
      staff,
      and(
        eq(staff.userId, sopAcknowledgements.userId),
        eq(staff.workspaceId, workspaceId),
        eq(staff.status, "active"),
        isNull(staff.deletedAt),
      ),
    )
    .where(eq(sopAcknowledgements.versionId, current.id));
  if (acks.length === 0) return { created: 0, skipped: 0 };
  const have = new Set(
    (
      await tx
        .select({ staffId: trainingRecords.staffId })
        .from(trainingRecords)
        .where(and(eq(trainingRecords.courseId, course.id), eq(trainingRecords.sopVersionId, current.id)))
    ).map((r) => r.staffId),
  );
  const todo = acks.filter((a) => !have.has(a.staffId));
  if (todo.length === 0) return { created: 0, skipped: acks.length };
  const zone = await workspaceTimeZone(tx, workspaceId);
  const rows = await tx
    .insert(trainingRecords)
    .values(
      todo.map((a) => {
        const completedOn = dateInZone(a.acknowledgedAt, zone);
        return {
          workspaceId,
          staffId: a.staffId,
          courseId: course.id,
          sopVersionId: current.id,
          completedOn,
          outcome: course.requiresSignOff ? ("competent" as const) : ("attended" as const),
          expiresOn: course.validityMonths ? addMonthsIso(completedOn, course.validityMonths) : null,
          trainerName: "Read and acknowledged",
          notes: `Read and acknowledged version ${current.versionNumber} in the SOPs module (back-filled)`,
          recordedBy: a.userId,
        };
      }),
    )
    .returning();
  await recordChanges(tx, workspaceId, todo[0]!.userId, rows.map(recordChange));
  return { created: rows.length, skipped: acks.length - rows.length };
}

/** On demand (`manage`): back-fills one SOP course from the acknowledgements already on record. */
export async function backfillCourse(
  db: Database,
  workspaceId: string,
  courseId: string,
  active: readonly ModuleId[],
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const course = await findCourse(tx, workspaceId, courseId);
    if (course.kind !== "sop" || !course.sopId) {
      throw badRequest("Only a course linked to an SOP can be back-filled");
    }
    if (course.status !== "active") throw new ApiError(409, "course_archived", "This course is archived");
    if (!active.includes("sops")) throw new ApiError(409, "sops_inactive", "The SOPs module is not active");
    return backfillCourseFromAcknowledgements(tx, workspaceId, course);
  });
}

/**
 * A competency sign-off (BRCGS: a person, with `manage`, never a token). All or nothing: every
 * record must be live, competent, unsigned and on a course that needs a sign-off. Nobody signs
 * off their own training.
 */
export async function signOffRecords(
  db: Database,
  workspaceId: string,
  actorId: string,
  recordIds: string[],
) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        record: trainingRecords,
        requiresSignOff: trainingCourses.requiresSignOff,
        userId: staff.userId,
      })
      .from(trainingRecords)
      .innerJoin(trainingCourses, eq(trainingCourses.id, trainingRecords.courseId))
      .innerJoin(staff, eq(staff.id, trainingRecords.staffId))
      .where(and(eq(trainingRecords.workspaceId, workspaceId), inArray(trainingRecords.id, recordIds)))
      .for("update", { of: trainingRecords });
    if (rows.length !== recordIds.length) throw notFound("Training record");
    for (const { record, requiresSignOff, userId } of rows) {
      if (record.voidedAt) throw new ApiError(409, "record_voided", "A voided record can't be signed off");
      if (record.signedOffAt) throw new ApiError(409, "already_signed_off", "Already signed off");
      if (!requiresSignOff)
        throw new ApiError(409, "sign_off_not_needed", "This course doesn't need a sign-off");
      if (record.outcome !== "competent") {
        throw new ApiError(409, "not_competent", "Only training recorded as competent can be signed off");
      }
      if (userId === actorId) throw new ApiError(403, "own_training", "You can't sign off your own training");
    }
    const updated = await tx
      .update(trainingRecords)
      .set({ signedOffAt: new Date(), signedOffBy: actorId })
      .where(inArray(trainingRecords.id, recordIds))
      .returning();
    await recordChanges(tx, workspaceId, actorId, updated.map(recordChange));
    return recordViews(tx, inArray(trainingRecords.id, recordIds));
  });
}

/** Voids a record made in error. It is kept and shown, and never counts again. */
export async function voidRecord(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  reason: string,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(trainingRecords)
      .where(and(eq(trainingRecords.id, id), eq(trainingRecords.workspaceId, workspaceId)))
      .for("update");
    if (!row) throw notFound("Training record");
    if (row.voidedAt) throw new ApiError(409, "record_voided", "Already voided");
    const [updated] = await tx
      .update(trainingRecords)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: reason })
      .where(eq(trainingRecords.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [recordChange(updated!)]);
    return (await recordViews(tx, eq(trainingRecords.id, id)))[0]!;
  });
}

// ─── The matrix ──────────────────────────────────────────────────────────────

interface MatrixScope {
  staffIds?: string[];
  jobRoleId?: string;
  department?: string;
  /** Include leavers (a person's own history). */
  includeLeavers?: boolean;
}

/**
 * Everything needed to work out every person × course status in scope: the people with their
 * roles, active courses, requirements, live records and current SOP versions.
 */
async function loadStandings(db: Executor, workspaceId: string, scope: MatrixScope, today: string) {
  const staffWhere: (SQL | undefined)[] = [eq(staff.workspaceId, workspaceId), isNull(staff.deletedAt)];
  if (!scope.includeLeavers) staffWhere.push(eq(staff.status, "active"));
  if (scope.staffIds) staffWhere.push(inArray(staff.id, scope.staffIds));
  if (scope.department) staffWhere.push(sql`lower(${staff.department}) = lower(${scope.department})`);
  if (scope.jobRoleId) {
    staffWhere.push(
      sql`exists (select 1 from ${staffJobRoles} where ${staffJobRoles.staffId} = ${staff.id}
        and ${staffJobRoles.jobRoleId} = ${scope.jobRoleId} and ${staffJobRoles.deletedAt} is null)`,
    );
  }
  const people = await db
    .select({
      id: staff.id,
      staffNumber: staff.staffNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
      department: staff.department,
      startDate: staff.startDate,
      status: staff.status,
    })
    .from(staff)
    .where(and(...staffWhere))
    .orderBy(asc(staff.lastName), asc(staff.firstName), asc(staff.id));
  const staffIds = people.map((p) => p.id);

  const courses = await db
    .select()
    .from(trainingCourses)
    .where(and(eq(trainingCourses.workspaceId, workspaceId), isNull(trainingCourses.deletedAt)))
    .orderBy(asc(trainingCourses.code));
  const roleRows = staffIds.length
    ? await db
        .select({ staffId: staffJobRoles.staffId, jobRoleId: jobRoles.id, name: jobRoles.name })
        .from(staffJobRoles)
        .innerJoin(jobRoles, and(eq(jobRoles.id, staffJobRoles.jobRoleId), isNull(jobRoles.deletedAt)))
        .where(and(inArray(staffJobRoles.staffId, staffIds), isNull(staffJobRoles.deletedAt)))
        .orderBy(asc(jobRoles.name))
    : [];
  const reqRows = await db
    .select()
    .from(trainingRequirements)
    .where(and(eq(trainingRequirements.workspaceId, workspaceId), isNull(trainingRequirements.deletedAt)));
  const records = staffIds.length
    ? await db
        .select()
        .from(trainingRecords)
        .where(and(inArray(trainingRecords.staffId, staffIds), isNull(trainingRecords.voidedAt)))
    : [];
  const sopVersionByCourse = await currentSopVersions(db, [
    ...new Set(courses.flatMap((c) => (c.kind === "sop" && c.sopId ? [c.sopId] : []))),
  ]);

  const rolesOf = new Map<string, { id: string; name: string }[]>();
  for (const r of roleRows) {
    const list = rolesOf.get(r.staffId) ?? [];
    list.push({ id: r.jobRoleId, name: r.name });
    rolesOf.set(r.staffId, list);
  }
  const reqsOfCourse = new Map<string, typeof reqRows>();
  for (const r of reqRows) {
    const list = reqsOfCourse.get(r.courseId) ?? [];
    list.push(r);
    reqsOfCourse.set(r.courseId, list);
  }
  const recordsOf = new Map<string, RecordRow[]>();
  for (const r of records) {
    const key = `${r.staffId}:${r.courseId}`;
    const list = recordsOf.get(key) ?? [];
    list.push(r);
    recordsOf.set(key, list);
  }

  /** A person's standing on a course, or `null` if it has nothing to do with them. */
  const cell = (person: (typeof people)[number], course: CourseRow): TrainingCellStatus | null => {
    const held = new Set((rolesOf.get(person.id) ?? []).map((r) => r.id));
    // Archived courses only matter for people who have training on them.
    const reqs =
      course.status === "active"
        ? (reqsOfCourse.get(course.id) ?? []).filter((r) => held.has(r.jobRoleId))
        : [];
    const own = recordsOf.get(`${person.id}:${course.id}`) ?? [];
    if (reqs.length === 0 && own.length === 0) return null;
    // Several roles may need the course: the tightest deadline wins.
    const windows = reqs.map((r) => r.dueWithinDays).filter((d): d is number => d !== null);
    return trainingStatus({
      records: own,
      requiresSignOff: course.requiresSignOff,
      currentSopVersionId:
        course.kind === "sop" && course.sopId
          ? (sopVersionByCourse.get(course.sopId)?.id ?? null)
          : undefined,
      requirement: reqs.length
        ? { dueWithinDays: windows.length ? Math.min(...windows) : null, startDate: person.startDate }
        : null,
      today,
    });
  };
  return { people, courses, rolesOf, cell };
}

const courseColumn = (c: CourseRow) => ({
  id: c.id,
  code: c.code,
  title: c.title,
  kind: c.kind,
  status: c.status,
  validityMonths: c.validityMonths,
  requiresSignOff: c.requiresSignOff,
});

const emptySummary = (): Record<Exclude<TrainingStatus, "not_required">, number> => ({
  current: 0,
  expiring: 0,
  expired: 0,
  outdated: 0,
  pending_sign_off: 0,
  missing: 0,
});

/**
 * The training matrix: people (rows) × courses (columns). Columns are the courses that any shown
 * person needs or has been trained on, unless `allCourses` or `courseId` says otherwise.
 */
export async function trainingMatrix(
  db: Database,
  workspaceId: string,
  query: TrainingMatrixQuery,
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const { people, courses, rolesOf, cell } = await loadStandings(db, workspaceId, query, today);
  const rows = people.map((person) => {
    const cells: Record<string, TrainingCellStatus> = {};
    for (const course of courses) {
      if (query.courseId && course.id !== query.courseId) continue;
      const c = cell(person, course);
      if (c) cells[course.id] = c;
    }
    return { person, cells };
  });
  const shownRows = query.status
    ? rows.filter((r) => Object.values(r.cells).some((c) => c.status === query.status))
    : rows;
  const used = new Set(shownRows.flatMap((r) => Object.keys(r.cells)));
  const columns = courses.filter((c) =>
    query.courseId
      ? c.id === query.courseId
      : query.allCourses === "true"
        ? c.status === "active" || used.has(c.id)
        : used.has(c.id),
  );
  const summary = emptySummary();
  for (const r of shownRows) {
    for (const c of Object.values(r.cells)) if (c.status !== "not_required") summary[c.status]++;
  }
  return {
    today,
    courses: columns.map(courseColumn),
    rows: shownRows.map(({ person, cells }) => ({
      staff: {
        id: person.id,
        staffNumber: person.staffNumber,
        firstName: person.firstName,
        lastName: person.lastName,
        department: person.department,
        jobRoles: rolesOf.get(person.id) ?? [],
      },
      cells,
    })),
    summary,
  };
}

/** What needs doing: missing, expired, outdated, awaiting sign-off, and expiring within `withinDays`. */
export async function trainingDue(
  db: Database,
  workspaceId: string,
  query: TrainingDueQuery & { staffIds?: string[] },
  todayOn?: string,
) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const { people, courses, cell } = await loadStandings(db, workspaceId, query, today);
  const horizon = addDaysIso(today, query.withinDays);
  const items: {
    staff: {
      id: string;
      staffNumber: string;
      firstName: string;
      lastName: string;
      department: string | null;
    };
    course: ReturnType<typeof courseColumn>;
    status: TrainingStatus;
    dueOn: string | null;
    overdue: boolean;
    completedOn: string | null;
    expiresOn: string | null;
  }[] = [];
  for (const person of people) {
    for (const course of courses) {
      const c = cell(person, course);
      if (!c) continue;
      const expiringSoon = c.expiresOn !== null && c.expiresOn >= today && c.expiresOn <= horizon;
      const status: TrainingStatus =
        c.status === "current" && expiringSoon
          ? "expiring"
          : c.status === "expiring" && !expiringSoon
            ? "current"
            : c.status;
      if (!trainingGapStatuses.includes(status)) continue;
      const { startDate: _start, status: _staffStatus, ...who } = person;
      items.push({
        staff: who,
        course: courseColumn(course),
        status,
        dueOn:
          status === "missing" ? c.dueOn : status === "expiring" || status === "expired" ? c.expiresOn : null,
        overdue: c.overdue,
        completedOn: c.completedOn,
        expiresOn: c.expiresOn,
      });
    }
  }
  // Most urgent first: overdue and lapsed, then by date.
  const rank: Partial<Record<TrainingStatus, number>> = {
    expired: 0,
    missing: 1,
    outdated: 2,
    pending_sign_off: 3,
    expiring: 4,
  };
  items.sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
      (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") ||
      a.staff.lastName.localeCompare(b.staff.lastName),
  );
  return { today, withinDays: query.withinDays, items };
}

/** One person's training: their standing on every course that concerns them, and every record. */
export async function staffTraining(db: Database, workspaceId: string, staffId: string, todayOn?: string) {
  const today = todayOn ?? (await workspaceToday(db, workspaceId));
  const { people, courses, rolesOf, cell } = await loadStandings(
    db,
    workspaceId,
    { staffIds: [staffId], includeLeavers: true },
    today,
  );
  const person = people[0];
  if (!person) throw notFound("Staff member");
  const standings = courses.flatMap((course) => {
    const c = cell(person, course);
    return c ? [{ course: courseColumn(course), ...c }] : [];
  });
  const records = await recordViews(
    db,
    and(eq(trainingRecords.workspaceId, workspaceId), eq(trainingRecords.staffId, staffId)),
  );
  return { today, staff: { ...person, jobRoles: rolesOf.get(person.id) ?? [] }, standings, records };
}

/** Whether a person has any training records (people can't be deleted once they do). */
export async function hasTrainingRecords(db: Executor, staffId: string) {
  const [row] = await db
    .select({ id: trainingRecords.id })
    .from(trainingRecords)
    .where(eq(trainingRecords.staffId, staffId))
    .limit(1);
  return Boolean(row);
}

/** HSE reuses the training matrix's SOP/version, expiry and sign-off rules under its own lock. */
/**
 * Competence lookups for staffing checks: whether a person counts as competent on a course for a
 * given shift date, using the same standings as the matrix. Competent means the training is
 * current (or expiring) today, signed off where the course needs it, on the SOP's current version,
 * and still valid on the shift date. Archived courses never count.
 */
export async function competenceLookup(db: Executor, workspaceId: string, staffIds: string[], today: string) {
  // Leavers count too: the rota already limits entries to employed dates, and past checks need them.
  const { people, courses, cell } = await loadStandings(
    db,
    workspaceId,
    { staffIds, includeLeavers: true },
    today,
  );
  const personById = new Map(people.map((p) => [p.id, p]));
  const courseById = new Map(courses.map((c) => [c.id, c]));
  return {
    course: (courseId: string) => {
      const c = courseById.get(courseId);
      return c ? { id: c.id, code: c.code, title: c.title, active: c.status === "active" } : null;
    },
    /** null when competent on `date`; otherwise why not. */
    gap(staffId: string, courseId: string, date: string) {
      const course = courseById.get(courseId);
      if (!course || course.status !== "active")
        return { reason: "course_archived" as const, expiresOn: null };
      const person = personById.get(staffId);
      const state = person ? cell(person, course) : null;
      if (!state || state.status === "missing" || state.status === "not_required")
        return { reason: "training_missing" as const, expiresOn: null };
      if (state.status === "pending_sign_off")
        return { reason: "training_awaiting_sign_off" as const, expiresOn: state.expiresOn };
      if (state.status === "outdated")
        return { reason: "training_outdated" as const, expiresOn: state.expiresOn };
      if (state.status === "expired")
        return { reason: "training_expired" as const, expiresOn: state.expiresOn };
      if (state.expiresOn && state.expiresOn < date)
        return { reason: "training_expires_before_shift" as const, expiresOn: state.expiresOn };
      return null;
    },
  };
}

export async function permitCompetence(
  db: Executor,
  workspaceId: string,
  staffId: string,
  courseIds: string[],
  today: string,
  through: string,
) {
  const { people, courses, cell } = await loadStandings(db, workspaceId, { staffIds: [staffId] }, today);
  const person = people[0];
  if (!person) throw notFound("Active staff member");
  const evidence = [];
  for (const id of courseIds) {
    const course = courses.find((c) => c.id === id && c.status === "active");
    const state = course ? cell(person, course) : null;
    if (
      !course ||
      !state ||
      !["current", "expiring"].includes(state.status) ||
      !state.completedOn ||
      state.completedOn > today ||
      (state.expiresOn && state.expiresOn < through)
    )
      throw new ApiError(
        409,
        "competence_required",
        "Required training must be current, signed off and valid through the permit's end",
      );
    const currentSop =
      course.kind === "sop" && course.sopId
        ? (await currentSopVersions(db, [course.sopId])).get(course.sopId)?.id
        : undefined;
    const [proof] = await db
      .select({
        recordId: trainingRecords.id,
        signedOffBy: trainingRecords.signedOffBy,
        signedOffAt: trainingRecords.signedOffAt,
        sopVersionId: trainingRecords.sopVersionId,
      })
      .from(trainingRecords)
      .where(
        and(
          eq(trainingRecords.workspaceId, workspaceId),
          eq(trainingRecords.staffId, staffId),
          eq(trainingRecords.courseId, course.id),
          eq(trainingRecords.completedOn, state.completedOn),
          state.expiresOn
            ? eq(trainingRecords.expiresOn, state.expiresOn)
            : isNull(trainingRecords.expiresOn),
          isNull(trainingRecords.voidedAt),
          course.requiresSignOff
            ? sql`${trainingRecords.signedOffAt} is not null and ${trainingRecords.outcome} = 'competent'`
            : inArray(trainingRecords.outcome, ["competent", "attended"]),
          currentSop ? eq(trainingRecords.sopVersionId, currentSop) : undefined,
        ),
      )
      .orderBy(desc(trainingRecords.createdAt), desc(trainingRecords.id))
      .limit(1);
    if (!proof)
      throw new ApiError(
        409,
        "competence_required",
        "The qualifying training evidence changed; review the worker's training",
      );
    evidence.push({ courseId: course.id, code: course.code, title: course.title, ...state, ...proof });
  }
  return { staffId: person.id, name: `${person.firstName} ${person.lastName}`, courses: evidence };
}
