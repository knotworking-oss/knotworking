import {
  canApproveSopVersion,
  dateInZone,
  daysOutstanding,
  defaultSopReviewDueOn,
  docToPlainText,
  extractImageIds,
  hasModuleLevel,
  addDaysToIsoDate,
  resolveModuleAccess,
  sopReviewState,
  SOP_REVIEW_SOON_DAYS,
  type DocContent,
  type ModuleId,
  type SopCreateInput,
  type SopDecisionInput,
  type SopDraftInput,
  type SopListQuery,
  type SopOutstandingQuery,
  type SopSubmitInput,
  type SopTargetsInput,
  type SopUpdateInput,
} from "@knotworking/core";
import {
  attachments,
  jobRoles,
  lockWorkspaceLog,
  memberModuleAccess,
  recordChanges,
  sopAcknowledgements,
  sops,
  sopTargets,
  sopVersions,
  users,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Executor,
  type Transaction,
} from "@knotworking/db";
import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";
import {
  deliverNotifications,
  notifySopReviewRequested,
  notifySopTargeted,
  notifySopVersionApproved,
  type NotificationRow,
} from "./notifications";
import { sopTargetUserIds } from "./sop-audience";
import { workspaceTimeZone, workspaceToday } from "./time-zone";
import { recordSopAcknowledgementTraining } from "./ports/training";

/**
 * SOPs module: standard operating procedures under document control (BRCGS).
 *
 * An SOP has a working draft and immutable versions; the current version is the `approved` one.
 * Drafts and versions under review are only ever returned to callers with `write`, and the sync
 * log carries metadata only (never `draftContent` or a version's `content`), so a read-only
 * member can't see them through any route. Every write is one transaction that records changes.
 */

type SopRow = typeof sops.$inferSelect;
type VersionRow = typeof sopVersions.$inferSelect;

const like = (q: string) => `%${q.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;

// ─── Serialization ───────────────────────────────────────────────────────────

/** The SOP header: nothing of the draft but whether there is one. */
function serializeHeader(row: SopRow) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    category: row.category,
    ownerId: row.ownerId,
    reviewIntervalMonths: row.reviewIntervalMonths,
    ackReminderDays: row.ackReminderDays,
    ackReminderRepeatDays: row.ackReminderRepeatDays,
    status: row.status,
    hasDraft: row.draftContent !== null,
    draftUpdatedAt: row.draftUpdatedAt,
    draftUpdatedBy: row.draftUpdatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The sync-log payload of an SOP: metadata only. */
const sopSyncData = serializeHeader;

/** A version without its content. `title`, the summary and the note go to `write` callers only for in-review versions. */
function serializeVersionMeta(row: VersionRow) {
  const { workspaceId: _ws, deletedAt: _deleted, content: _content, ...rest } = row;
  return rest;
}

/** The sync-log payload of a version: status and dates, no content, title, summary or note. */
function versionSyncData(row: VersionRow) {
  const { title: _t, changeSummary: _s, decisionNote: _n, ...rest } = serializeVersionMeta(row);
  return rest;
}

const serializeVersion = (row: VersionRow) => ({ ...serializeVersionMeta(row), content: row.content });

/** What a read-only member learns about a version still under review: that it exists. */
const redactedVersion = (row: VersionRow) => ({
  id: row.id,
  sopId: row.sopId,
  versionNumber: row.versionNumber,
  status: row.status,
  submittedBy: row.submittedBy,
  submittedAt: row.submittedAt,
});

const sopChange = (row: SopRow): ChangeInput => ({
  entity: "sop",
  entityId: row.id,
  action: "upsert",
  data: sopSyncData(row),
});
const versionChange = (row: VersionRow): ChangeInput => ({
  entity: "sop_version",
  entityId: row.id,
  action: "upsert",
  data: versionSyncData(row),
});

/** Canonical JSON (sorted keys), so two jsonb values compare regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export const sameContent = (a: DocContent, b: DocContent) => canonical(a) === canonical(b);

// ─── Lookups ─────────────────────────────────────────────────────────────────

async function findSop(db: Executor, workspaceId: string, id: string, lock = false) {
  const query = db
    .select()
    .from(sops)
    .where(and(eq(sops.id, id), eq(sops.workspaceId, workspaceId), isNull(sops.deletedAt)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("SOP");
  return row;
}

async function findVersion(db: Executor, workspaceId: string, sopId: string, versionId: string) {
  const [row] = await db
    .select()
    .from(sopVersions)
    .where(
      and(
        eq(sopVersions.id, versionId),
        eq(sopVersions.sopId, sopId),
        eq(sopVersions.workspaceId, workspaceId),
        isNull(sopVersions.deletedAt),
      ),
    );
  if (!row) throw notFound("SOP version");
  return row;
}

const liveVersions = (workspaceId: string, sopId: string | string[]) =>
  and(
    eq(sopVersions.workspaceId, workspaceId),
    Array.isArray(sopId) ? inArray(sopVersions.sopId, sopId) : eq(sopVersions.sopId, sopId),
    isNull(sopVersions.deletedAt),
  );

async function assertCodeFree(tx: Transaction, workspaceId: string, code: string, exceptId?: string) {
  const [taken] = await tx
    .select({ id: sops.id })
    .from(sops)
    .where(
      and(
        eq(sops.workspaceId, workspaceId),
        isNull(sops.deletedAt),
        sql`lower(${sops.code}) = lower(${code})`,
        exceptId ? sql`${sops.id} <> ${exceptId}` : undefined,
      ),
    );
  if (taken) throw new ApiError(409, "code_taken", `Another SOP already uses the code "${code}"`);
}

async function assertMember(tx: Transaction, workspaceId: string, userId: string) {
  const [member] = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  if (!member) throw badRequest("ownerId must be a member of this workspace");
}

/**
 * Images in an SOP's text must be files uploaded to that SOP (`sop` attachments), so they are
 * served under SOP access and a version's images can be protected from deletion. Not the wiki's.
 */
async function assertImagesBelong(
  tx: Transaction,
  workspaceId: string,
  sopId: string,
  content: DocContent | null | undefined,
) {
  const ids = content ? extractImageIds(content) : [];
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.workspaceId, workspaceId),
        eq(attachments.entityType, "sop"),
        eq(attachments.entityId, sopId),
        isNull(attachments.deletedAt),
        inArray(attachments.id, ids),
      ),
    );
  if (rows.length !== ids.length) {
    throw badRequest("Images in an SOP must be uploaded to that SOP (not taken from a page or another SOP)");
  }
}

/** Members of the workspace with at least `level` in the SOPs module (owners and admins always have `manage`). */
export async function sopMembersWithLevel(
  db: Executor,
  workspaceId: string,
  active: readonly ModuleId[],
  level: "read" | "manage",
) {
  const [members, grants] = await Promise.all([
    db
      .select({ userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(workspaceMembers.deletedAt)))
      .orderBy(asc(users.name)),
    db
      .select({ userId: memberModuleAccess.userId, level: memberModuleAccess.level })
      .from(memberModuleAccess)
      .where(
        and(
          eq(memberModuleAccess.workspaceId, workspaceId),
          eq(memberModuleAccess.moduleId, "sops"),
          isNull(memberModuleAccess.deletedAt),
        ),
      ),
  ]);
  const grantOf = new Map(grants.map((g) => [g.userId, g.level]));
  return members.filter((m) => {
    const access = resolveModuleAccess({
      role: m.role,
      active,
      grants: grantOf.has(m.userId) ? { sops: grantOf.get(m.userId)! } : {},
    });
    return hasModuleLevel(access.sops, level);
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export async function listSops(
  db: Database,
  workspaceId: string,
  viewerId: string,
  query: SopListQuery,
  active: readonly ModuleId[] = [],
) {
  const where: (SQL | undefined)[] = [eq(sops.workspaceId, workspaceId), isNull(sops.deletedAt)];
  if (query.status !== "all") where.push(eq(sops.status, query.status));
  if (query.category) where.push(sql`lower(${sops.category}) = lower(${query.category})`);
  if (query.q) {
    where.push(
      or(
        sql`${sops.title} ilike ${like(query.q)} escape '!'`,
        sql`${sops.code} ilike ${like(query.q)} escape '!'`,
      ),
    );
  }
  if (query.due) {
    const today = await workspaceToday(db, workspaceId);
    const range =
      query.due === "overdue"
        ? sql`${sopVersions.reviewDueOn} < ${today}`
        : sql`${sopVersions.reviewDueOn} >= ${today} and ${sopVersions.reviewDueOn} <= ${addDaysToIsoDate(today, SOP_REVIEW_SOON_DAYS)}`;
    where.push(
      sql`exists (select 1 from ${sopVersions} where ${sopVersions.sopId} = ${sops.id}
        and ${sopVersions.status} = 'approved' and ${sopVersions.deletedAt} is null and ${range})`,
    );
  }
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(sops)
      .where(and(...where))
      .orderBy(asc(sops.code), asc(sops.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(sops)
      .where(and(...where)),
  ]);
  const ids = rows.map((r) => r.id);
  const versions = ids.length
    ? await db
        .select()
        .from(sopVersions)
        .where(and(liveVersions(workspaceId, ids), inArray(sopVersions.status, ["approved", "in_review"])))
    : [];
  const acked = ids.length
    ? await db
        .select({ versionId: sopAcknowledgements.versionId })
        .from(sopAcknowledgements)
        .where(and(inArray(sopAcknowledgements.sopId, ids), eq(sopAcknowledgements.userId, viewerId)))
    : [];
  const ackedVersions = new Set(acked.map((a) => a.versionId));
  const targeted = await sopTargetUserIds(db, workspaceId, active, ids);
  const today = await workspaceToday(db, workspaceId);
  return {
    sops: rows.map((row) => {
      const current = versions.find((v) => v.sopId === row.id && v.status === "approved");
      return {
        ...serializeHeader(row),
        currentVersion: current
          ? {
              id: current.id,
              versionNumber: current.versionNumber,
              effectiveOn: current.effectiveOn,
              reviewDueOn: current.reviewDueOn,
            }
          : null,
        reviewState: sopReviewState(current?.reviewDueOn, today),
        inReview: versions.some((v) => v.sopId === row.id && v.status === "in_review"),
        acknowledged: current ? ackedVersions.has(current.id) : false,
        /** Whether the viewer is one of the people who must read it (everyone, unless targeted). */
        required: targeted.get(row.id)?.has(viewerId) ?? true,
      };
    }),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * One SOP: the header, the current approved version with its content, the version history, and,
 * for callers with `write`, the draft and the version in review with their content.
 */
export async function getSop(
  db: Executor,
  workspaceId: string,
  viewerId: string,
  id: string,
  canWrite: boolean,
  active: readonly ModuleId[] = [],
) {
  const row = await findSop(db, workspaceId, id);
  const versions = await db
    .select()
    .from(sopVersions)
    .where(liveVersions(workspaceId, id))
    .orderBy(desc(sopVersions.versionNumber));
  const current = versions.find((v) => v.status === "approved") ?? null;
  const inReview = versions.find((v) => v.status === "in_review") ?? null;
  const [ack] = current
    ? await db
        .select({ id: sopAcknowledgements.id })
        .from(sopAcknowledgements)
        .where(and(eq(sopAcknowledgements.versionId, current.id), eq(sopAcknowledgements.userId, viewerId)))
    : [];
  return {
    ...serializeHeader(row),
    currentVersion: current ? serializeVersion(current) : null,
    versions: versions.map((v) =>
      v.status === "in_review" && !canWrite ? redactedVersion(v) : serializeVersionMeta(v),
    ),
    inReview: inReview !== null,
    inReviewVersion: canWrite && inReview ? serializeVersion(inReview) : null,
    draft:
      canWrite && row.draftContent
        ? {
            title: row.draftTitle ?? row.title,
            content: row.draftContent,
            updatedAt: row.draftUpdatedAt,
            updatedBy: row.draftUpdatedBy,
          }
        : null,
    acknowledged: ack !== undefined,
    required: (await sopTargetUserIds(db, workspaceId, active, [id])).get(id)?.has(viewerId) ?? true,
  };
}

export async function getSopVersion(
  db: Executor,
  workspaceId: string,
  id: string,
  versionId: string,
  canWrite: boolean,
) {
  await findSop(db, workspaceId, id);
  const version = await findVersion(db, workspaceId, id, versionId);
  if (version.status === "in_review" && !canWrite) {
    throw new ApiError(403, "module_forbidden", "A version under review is only visible to editors");
  }
  return serializeVersion(version);
}

// ─── Writing the header and the draft ────────────────────────────────────────

export async function createSop(db: Database, workspaceId: string, actorId: string, input: SopCreateInput) {
  const { id, content, ...fields } = input;
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await assertCodeFree(tx, workspaceId, fields.code);
    if (fields.ownerId) await assertMember(tx, workspaceId, fields.ownerId);
    const [row] = await tx
      .insert(sops)
      .values({
        ...fields,
        ...(id ? { id } : {}),
        workspaceId,
        ...(content
          ? {
              draftContent: content,
              draftTitle: fields.title,
              draftUpdatedAt: new Date(),
              draftUpdatedBy: actorId,
            }
          : {}),
      })
      .returning();
    await assertImagesBelong(tx, workspaceId, row!.id, content);
    await recordChanges(tx, workspaceId, actorId, [sopChange(row!)]);
    return serializeHeader(row!);
  });
}

export async function updateSop(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  patch: SopUpdateInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findSop(tx, workspaceId, id);
    if (patch.code !== undefined) await assertCodeFree(tx, workspaceId, patch.code, id);
    if (patch.ownerId) await assertMember(tx, workspaceId, patch.ownerId);
    const [row] = await tx.update(sops).set(patch).where(eq(sops.id, id)).returning();
    await recordChanges(tx, workspaceId, actorId, [sopChange(row!)]);
    return serializeHeader(row!);
  });
}

/**
 * Saves (or with `content: null` discards) the working draft. `expectedDraftUpdatedAt` is the
 * precondition: if someone saved since, nothing is written and the caller gets 409
 * `draft_conflict` with the current draft.
 */
export async function saveSopDraft(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: SopDraftInput,
) {
  return db.transaction(async (tx) => {
    const before = await findSop(tx, workspaceId, id, true);
    if (before.status === "archived") {
      throw new ApiError(409, "sop_archived", "An archived SOP can't be edited; reactivate it first");
    }
    if (input.expectedDraftUpdatedAt !== undefined) {
      const expected = input.expectedDraftUpdatedAt;
      const actual = before.draftUpdatedAt;
      const same =
        expected === null
          ? actual === null
          : actual !== null && actual.getTime() === new Date(expected).getTime();
      if (!same) {
        throw new ApiError(
          409,
          "draft_conflict",
          "This draft was saved by someone else since you opened it. Reload it and reapply your changes.",
          {
            current: {
              title: before.draftTitle ?? before.title,
              content: before.draftContent,
              updatedAt: before.draftUpdatedAt,
              updatedBy: before.draftUpdatedBy,
            },
          },
        );
      }
    }
    await assertImagesBelong(tx, workspaceId, id, input.content);
    // Strictly increasing, so two saves in the same millisecond still invalidate each other.
    const now = new Date(Math.max(Date.now(), (before.draftUpdatedAt?.getTime() ?? 0) + 1));
    const [row] = await tx
      .update(sops)
      .set({
        draftContent: input.content,
        draftTitle: input.content ? (input.title ?? before.draftTitle ?? before.title) : null,
        draftUpdatedAt: now,
        draftUpdatedBy: actorId,
      })
      .where(eq(sops.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [sopChange(row!)]);
    return {
      ...serializeHeader(row!),
      draft: row!.draftContent
        ? {
            title: row!.draftTitle ?? row!.title,
            content: row!.draftContent,
            updatedAt: row!.draftUpdatedAt,
            updatedBy: row!.draftUpdatedBy,
          }
        : null,
    };
  });
}

// ─── Review ──────────────────────────────────────────────────────────────────

/**
 * Snapshots the draft into the next version, `in_review`. Refused while another version is under
 * review, when there is no draft, or when the draft is identical to the current approved version.
 * The draft is kept.
 */
export async function submitSop(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: SopSubmitInput,
  active: readonly ModuleId[],
) {
  let notified: NotificationRow[] = [];
  const created = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const sop = await findSop(tx, workspaceId, id, true);
    if (sop.status === "archived") {
      throw new ApiError(409, "sop_archived", "An archived SOP can't be submitted; reactivate it first");
    }
    const versions = await tx.select().from(sopVersions).where(liveVersions(workspaceId, id));
    if (versions.some((v) => v.status === "in_review")) {
      throw new ApiError(409, "review_in_progress", "A version of this SOP is already waiting for review");
    }
    if (!sop.draftContent || docToPlainText(sop.draftContent).trim() === "") {
      throw new ApiError(409, "draft_empty", "There is no draft to submit");
    }
    const title = sop.draftTitle ?? sop.title;
    const current = versions.find((v) => v.status === "approved");
    if (current && current.title === title && sameContent(current.content, sop.draftContent)) {
      throw new ApiError(409, "draft_unchanged", "The draft is the same as the current approved version");
    }
    // Numbers are never reused, including those of rejected versions (and soft-deleted ones).
    const [{ top } = { top: 0 }] = await tx
      .select({ top: sql<number>`coalesce(max(${sopVersions.versionNumber}), 0)::int` })
      .from(sopVersions)
      .where(eq(sopVersions.sopId, id));
    const [version] = await tx
      .insert(sopVersions)
      .values({
        workspaceId,
        sopId: id,
        versionNumber: top + 1,
        title,
        content: sop.draftContent,
        changeSummary: input.changeSummary,
        status: "in_review",
        submittedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [versionChange(version!)]);
    notified = await notifySopReviewRequested(tx, workspaceId, actorId, active, sop, version!);
    return serializeVersion(version!);
  });
  void deliverNotifications(db, notified);
  return created;
}

/**
 * Records the sign-off on a version in review. The route requires `manage` and refuses API
 * tokens; here the four-eyes rule applies to approval (see `canApproveSopVersion`).
 */
export async function decideSopVersion(
  db: Database,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  id: string,
  versionId: string,
  input: SopDecisionInput,
) {
  let notified: NotificationRow[] = [];
  const decided = await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const sop = await findSop(tx, workspaceId, id, true);
    const version = await findVersion(tx, workspaceId, id, versionId);
    if (version.status !== "in_review") {
      throw new ApiError(409, "not_in_review", "Only a version that is in review can be decided");
    }
    const now = new Date();
    if (input.decision === "reject") {
      const [rejected] = await tx
        .update(sopVersions)
        .set({ status: "rejected", decidedBy: actorId, decidedAt: now, decisionNote: input.note })
        .where(eq(sopVersions.id, versionId))
        .returning();
      await recordChanges(tx, workspaceId, actorId, [versionChange(rejected!)]);
      return serializeVersion(rejected!);
    }

    const managers = await sopMembersWithLevel(tx, workspaceId, active, "manage");
    if (
      !canApproveSopVersion({
        submittedBy: version.submittedBy,
        deciderId: actorId,
        managerIds: managers.map((m) => m.userId),
      })
    ) {
      throw new ApiError(
        403,
        "four_eyes",
        "You submitted this version, so someone else with manage access must approve it",
      );
    }
    const effectiveOn = input.effectiveOn ?? (await workspaceToday(tx, workspaceId, now));
    const reviewDueOn = input.reviewDueOn ?? defaultSopReviewDueOn(effectiveOn, sop.reviewIntervalMonths);
    if (reviewDueOn <= effectiveOn) throw badRequest("reviewDueOn must be after effectiveOn");

    const superseded = await tx
      .update(sopVersions)
      .set({ status: "superseded" })
      .where(and(liveVersions(workspaceId, id), eq(sopVersions.status, "approved")))
      .returning();
    const [approved] = await tx
      .update(sopVersions)
      .set({
        status: "approved",
        decidedBy: actorId,
        decidedAt: now,
        decisionNote: input.note ?? null,
        effectiveOn,
        reviewDueOn,
      })
      .where(eq(sopVersions.id, versionId))
      .returning();
    // The approved text is now the document; the draft is spent. Bump the stamp so an editor
    // still holding the old draft gets a conflict rather than silently resurrecting it.
    const [updatedSop] = await tx
      .update(sops)
      .set({
        title: approved!.title,
        draftContent: null,
        draftTitle: null,
        draftUpdatedAt: new Date(Math.max(Date.now(), (sop.draftUpdatedAt?.getTime() ?? 0) + 1)),
        draftUpdatedBy: actorId,
      })
      .where(eq(sops.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [
      ...superseded.map(versionChange),
      versionChange(approved!),
      sopChange(updatedSop!),
    ]);
    notified = await notifySopVersionApproved(tx, workspaceId, actorId, active, sop, approved!);
    return serializeVersion(approved!);
  });
  void deliverNotifications(db, notified);
  return decided;
}

// ─── Acknowledgement ─────────────────────────────────────────────────────────

/** Records that `userId` has read and understood the current approved version, once. */
export async function acknowledgeSop(
  db: Database,
  workspaceId: string,
  userId: string,
  id: string,
  versionId?: string,
  /** `kiosk`: a linked member of staff at the attendance kiosk, after their PIN. */
  source: "app" | "kiosk" = "app",
  /** The environment's active modules: with `training` on, the acknowledgement counts as training. */
  active: readonly ModuleId[] = [],
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findSop(tx, workspaceId, id);
    const [current] = await tx
      .select()
      .from(sopVersions)
      .where(and(liveVersions(workspaceId, id), eq(sopVersions.status, "approved")));
    if (!current) throw new ApiError(409, "no_current_version", "This SOP has no approved version yet");
    if (versionId && versionId !== current.id) {
      throw new ApiError(409, "version_not_current", "That version is no longer the current one");
    }
    const [existing] = await tx
      .select({ id: sopAcknowledgements.id })
      .from(sopAcknowledgements)
      .where(and(eq(sopAcknowledgements.versionId, current.id), eq(sopAcknowledgements.userId, userId)));
    if (existing) {
      throw new ApiError(409, "already_acknowledged", "You have already acknowledged this version");
    }
    const [row] = await tx
      .insert(sopAcknowledgements)
      .values({ workspaceId, sopId: id, versionId: current.id, userId, source })
      .returning();
    const { workspaceId: _ws, ...data } = row!;
    await recordChanges(tx, workspaceId, userId, [
      { entity: "sop_acknowledgement", entityId: row!.id, action: "upsert", data },
    ]);
    // `training` needs `people`, so it being active means staff records exist too.
    if (active.includes("training")) {
      await recordSopAcknowledgementTraining(tx, workspaceId, userId, current);
    }
    return data;
  });
}

/** Who has acknowledged a version, and (for the current version) which members with access have not. */
export async function listAcknowledgements(
  db: Database,
  workspaceId: string,
  active: readonly ModuleId[],
  id: string,
  versionId: string,
) {
  await findSop(db, workspaceId, id);
  const version = await findVersion(db, workspaceId, id, versionId);
  const acknowledged = await db
    .select({
      userId: sopAcknowledgements.userId,
      name: users.name,
      email: users.email,
      acknowledgedAt: sopAcknowledgements.acknowledgedAt,
    })
    .from(sopAcknowledgements)
    .innerJoin(users, eq(users.id, sopAcknowledgements.userId))
    .where(eq(sopAcknowledgements.versionId, versionId))
    .orderBy(asc(sopAcknowledgements.acknowledgedAt));
  const done = new Set(acknowledged.map((a) => a.userId));
  const targeted = (await sopTargetUserIds(db, workspaceId, active, [id])).get(id);
  const pending =
    version.status === "approved"
      ? (await sopMembersWithLevel(db, workspaceId, active, "read"))
          .filter((m) => !done.has(m.userId) && (!targeted || targeted.has(m.userId)))
          .map(({ userId, name, email }) => ({ userId, name, email }))
      : [];
  return {
    versionId,
    versionNumber: version.versionNumber,
    status: version.status,
    targeted: targeted !== undefined,
    acknowledged,
    pending,
  };
}

// ─── Targets and outstanding acknowledgements ────────────────────────────────

const targetChange = (row: typeof sopTargets.$inferSelect): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity: "sop_target", entityId: row.id, action: "upsert", data };
};

/** Who an SOP is aimed at: the targets, and the people they resolve to (those who can read SOPs). */
export async function getSopTargets(
  db: Executor,
  workspaceId: string,
  active: readonly ModuleId[],
  id: string,
) {
  await findSop(db, workspaceId, id);
  const rows = await db
    .select()
    .from(sopTargets)
    .where(
      and(eq(sopTargets.workspaceId, workspaceId), eq(sopTargets.sopId, id), isNull(sopTargets.deletedAt)),
    );
  const targeted = (await sopTargetUserIds(db, workspaceId, active, [id])).get(id);
  const readers = await sopMembersWithLevel(db, workspaceId, active, "read");
  return {
    jobRoleIds: rows.flatMap((r) => (r.jobRoleId ? [r.jobRoleId] : [])),
    userIds: rows.flatMap((r) => (r.userId ? [r.userId] : [])),
    /** Everyone with `read` when no target is set. */
    targeted: rows.length > 0,
    readers: readers
      .filter((m) => !targeted || targeted.has(m.userId))
      .map(({ userId, name, email }) => ({ userId, name, email })),
  };
}

/**
 * Replaces who must read an SOP. Empty lists mean everyone with `read`. Job roles need the
 * `people` module. Targets are workspace data (they go to the sync log); they change who is
 * expected to acknowledge from now on, not the acknowledgements already recorded.
 */
export async function setSopTargets(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: SopTargetsInput,
  active: readonly ModuleId[],
) {
  const roleIds = [...new Set(input.jobRoleIds)];
  const userIds = [...new Set(input.userIds)];
  let notified: NotificationRow[] = [];
  await db.transaction(async (tx) => {
    // Serialised with `deleteJobRole`, which refuses roles an SOP targets.
    await lockWorkspaceLog(tx, workspaceId);
    const sop = await findSop(tx, workspaceId, id);
    if (roleIds.length) {
      if (!active.includes("people")) throw badRequest("Job roles need the People module");
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
    if (userIds.length) {
      const members = await tx
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            isNull(workspaceMembers.deletedAt),
            inArray(workspaceMembers.userId, userIds),
          ),
        );
      if (members.length !== userIds.length) throw badRequest("userIds must be members of this workspace");
    }
    const audienceBefore = (await sopTargetUserIds(tx, workspaceId, active, [id])).get(id);
    const now = new Date();
    const existing = await tx
      .select()
      .from(sopTargets)
      .where(and(eq(sopTargets.sopId, id), isNull(sopTargets.deletedAt)));
    const changes: ChangeInput[] = [];
    for (const row of existing) {
      const keep = row.jobRoleId ? roleIds.includes(row.jobRoleId) : userIds.includes(row.userId!);
      if (keep) continue;
      await tx.update(sopTargets).set({ deletedAt: now }).where(eq(sopTargets.id, row.id));
      changes.push({ entity: "sop_target", entityId: row.id, action: "delete" });
    }
    const had = new Set(existing.map((r) => r.jobRoleId ?? r.userId));
    for (const jobRoleId of roleIds) {
      if (had.has(jobRoleId)) continue;
      const [row] = await tx
        .insert(sopTargets)
        .values({ workspaceId, sopId: id, jobRoleId })
        .onConflictDoUpdate({
          target: [sopTargets.sopId, sopTargets.jobRoleId],
          set: { deletedAt: null, updatedAt: now },
        })
        .returning();
      changes.push(targetChange(row!));
    }
    for (const userId of userIds) {
      if (had.has(userId)) continue;
      const [row] = await tx
        .insert(sopTargets)
        .values({ workspaceId, sopId: id, userId })
        .onConflictDoUpdate({
          target: [sopTargets.sopId, sopTargets.userId],
          set: { deletedAt: null, updatedAt: now },
        })
        .returning();
      changes.push(targetChange(row!));
    }
    if (changes.length) await recordChanges(tx, workspaceId, actorId, changes);
    if (changes.length && sop.status === "active") {
      notified = await notifyNewlyTargeted(tx, workspaceId, actorId, active, sop, audienceBefore);
    }
  });
  void deliverNotifications(db, notified);
  return getSopTargets(db, workspaceId, active, id);
}

/**
 * Tells the people a change of targets has just made responsible for an SOP (they were not before)
 * that they must read and acknowledge its current version. `before` is the audience before the
 * change (`undefined`: everyone with `read`, so nobody is newly included by narrowing to targets).
 * Nobody is told when the SOP has no approved version yet (they hear on approval), when they have
 * already acknowledged it, or about their own change. Call inside the transaction.
 */
async function notifyNewlyTargeted(
  tx: Transaction,
  workspaceId: string,
  actorId: string,
  active: readonly ModuleId[],
  sop: SopRow,
  before: Set<string> | undefined,
): Promise<NotificationRow[]> {
  const [current] = await tx
    .select()
    .from(sopVersions)
    .where(and(liveVersions(workspaceId, sop.id), eq(sopVersions.status, "approved")));
  if (!current) return [];
  const after = (await sopTargetUserIds(tx, workspaceId, active, [sop.id])).get(sop.id);
  const readers = (await sopMembersWithLevel(tx, workspaceId, active, "read")).map((m) => m.userId);
  const wasIn = (userId: string) => before === undefined || before.has(userId);
  const isIn = (userId: string) => after === undefined || after.has(userId);
  const added = readers.filter((userId) => userId !== actorId && isIn(userId) && !wasIn(userId));
  if (added.length === 0) return [];
  const done = await tx
    .select({ userId: sopAcknowledgements.userId })
    .from(sopAcknowledgements)
    .where(eq(sopAcknowledgements.versionId, current.id));
  const acknowledged = new Set(done.map((d) => d.userId));
  return notifySopTargeted(
    tx,
    workspaceId,
    actorId,
    sop,
    current,
    added.filter((userId) => !acknowledged.has(userId)),
  );
}

/**
 * Acknowledgements still to come: for each active SOP with a current approved version, each person
 * who must read it (its targeted readers, or everyone with `read` when it has no targets) and has
 * not acknowledged that version. `since` is when the version took effect (or was approved, if
 * later) on the workspace calendar; `daysOutstanding` counts from it. Oldest first.
 */
export async function listOutstandingAcknowledgements(
  db: Executor,
  workspaceId: string,
  active: readonly ModuleId[],
  query: SopOutstandingQuery = {},
  now: Date = new Date(),
) {
  const [today, zone] = await Promise.all([
    workspaceToday(db, workspaceId, now),
    workspaceTimeZone(db, workspaceId),
  ]);
  const current = await db
    .select({ sop: sops, version: sopVersions })
    .from(sops)
    .innerJoin(
      sopVersions,
      and(eq(sopVersions.sopId, sops.id), eq(sopVersions.status, "approved"), isNull(sopVersions.deletedAt)),
    )
    .where(
      and(
        eq(sops.workspaceId, workspaceId),
        eq(sops.status, "active"),
        isNull(sops.deletedAt),
        query.sopId ? eq(sops.id, query.sopId) : undefined,
      ),
    );
  if (current.length === 0) return { items: [], today };
  const sopIds = current.map((c) => c.sop.id);
  const [readers, targeted, acked] = await Promise.all([
    sopMembersWithLevel(db, workspaceId, active, "read"),
    sopTargetUserIds(db, workspaceId, active, sopIds),
    db
      .select({ versionId: sopAcknowledgements.versionId, userId: sopAcknowledgements.userId })
      .from(sopAcknowledgements)
      .where(
        inArray(
          sopAcknowledgements.versionId,
          current.map((c) => c.version.id),
        ),
      ),
  ]);
  const done = new Set(acked.map((a) => `${a.versionId}:${a.userId}`));
  const items = [];
  for (const { sop, version } of current) {
    const decidedOn = version.decidedAt ? dateInZone(version.decidedAt, zone) : today;
    const since = version.effectiveOn && version.effectiveOn > decidedOn ? version.effectiveOn : decidedOn;
    const days = daysOutstanding(since, today);
    if (query.minDays !== undefined && days < query.minDays) continue;
    const audience = targeted.get(sop.id);
    for (const reader of readers) {
      if (audience && !audience.has(reader.userId)) continue;
      if (query.userId && reader.userId !== query.userId) continue;
      if (done.has(`${version.id}:${reader.userId}`)) continue;
      items.push({
        sopId: sop.id,
        code: sop.code,
        title: version.title,
        ackReminderDays: sop.ackReminderDays,
        ackReminderRepeatDays: sop.ackReminderRepeatDays,
        versionId: version.id,
        versionNumber: version.versionNumber,
        effectiveOn: version.effectiveOn,
        since,
        daysOutstanding: days,
        userId: reader.userId,
        name: reader.name,
        email: reader.email,
      });
    }
  }
  items.sort(
    (a, b) =>
      b.daysOutstanding - a.daysOutstanding || a.code.localeCompare(b.code) || a.name.localeCompare(b.name),
  );
  return { items, today };
}

// ─── Deleting ────────────────────────────────────────────────────────────────

/** Soft-deletes an SOP that has never been approved. Anything that has been in force is archived instead. */
export async function deleteSop(db: Database, workspaceId: string, actorId: string, id: string) {
  await db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    await findSop(tx, workspaceId, id, true);
    const versions = await tx.select().from(sopVersions).where(liveVersions(workspaceId, id));
    if (versions.some((v) => v.status === "approved" || v.status === "superseded")) {
      throw new ApiError(
        409,
        "has_approved_version",
        "This SOP has had an approved version, so it is kept for the record. Archive it instead.",
      );
    }
    const now = new Date();
    await tx.update(sops).set({ deletedAt: now }).where(eq(sops.id, id));
    const targets = await tx
      .update(sopTargets)
      .set({ deletedAt: now })
      .where(and(eq(sopTargets.sopId, id), isNull(sopTargets.deletedAt)))
      .returning({ id: sopTargets.id });
    if (versions.length) {
      await tx.update(sopVersions).set({ deletedAt: now }).where(liveVersions(workspaceId, id));
    }
    await recordChanges(tx, workspaceId, actorId, [
      { entity: "sop", entityId: id, action: "delete" },
      ...versions.map((v): ChangeInput => ({ entity: "sop_version", entityId: v.id, action: "delete" })),
      ...targets.map((t): ChangeInput => ({ entity: "sop_target", entityId: t.id, action: "delete" })),
    ]);
  });
}
