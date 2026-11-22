import type { SopCopyCloseInput, SopCopyIssueInput, SopCopyListQuery } from "@knotworking/core";
import {
  lockWorkspaceLog,
  recordChanges,
  sopCopies,
  sops,
  sopVersions,
  users,
  workspaceMembers,
  type ChangeInput,
  type Database,
  type Executor,
} from "@knotworking/db";
import { and, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { ApiError, badRequest, notFound } from "../errors";

/**
 * The controlled-copy register of the SOPs module: printed copies of an approved SOP version that
 * were issued to a person or a place, numbered per version, and later returned or destroyed.
 * Append-only apart from closing a copy. A copy of a version that is no longer the current one is
 * flagged `outOfDate`: it is the document controller's job to call it in. Every write is one
 * transaction that records changes (`sop_copy`).
 */

type CopyRow = typeof sopCopies.$inferSelect;

/** The sync-log payload of a copy: who holds it and its state, no SOP content. */
function copyData(row: CopyRow) {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
}
const copyChange = (row: CopyRow): ChangeInput => ({
  entity: "sop_copy",
  entityId: row.id,
  action: "upsert",
  data: copyData(row),
});

/** Copies with the SOP, version and people they refer to. */
async function copyViews(db: Executor, rows: CopyRow[]) {
  if (rows.length === 0) return [];
  const sopIds = [...new Set(rows.map((r) => r.sopId))];
  const versionIds = [...new Set(rows.map((r) => r.versionId))];
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.issuedBy, r.closedBy, r.issuedToUserId]).filter((x) => x !== null)),
  ] as string[];
  const [sopRows, versionRows, people] = await Promise.all([
    db.select({ id: sops.id, code: sops.code }).from(sops).where(inArray(sops.id, sopIds)),
    db
      .select({
        id: sopVersions.id,
        title: sopVersions.title,
        versionNumber: sopVersions.versionNumber,
        status: sopVersions.status,
        effectiveOn: sopVersions.effectiveOn,
      })
      .from(sopVersions)
      .where(inArray(sopVersions.id, versionIds)),
    userIds.length
      ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))
      : Promise.resolve([]),
  ]);
  const sopOf = new Map(sopRows.map((s) => [s.id, s]));
  const versionOf = new Map(versionRows.map((v) => [v.id, v]));
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const name = (id: string | null) => (id ? (nameOf.get(id) ?? null) : null);
  return rows.map((row) => {
    const version = versionOf.get(row.versionId);
    return {
      ...copyData(row),
      sopCode: sopOf.get(row.sopId)?.code ?? "",
      title: version?.title ?? "",
      versionNumber: version?.versionNumber ?? 0,
      versionStatus: version?.status ?? "superseded",
      effectiveOn: version?.effectiveOn ?? null,
      /** The version this copy shows is the SOP's current approved one. */
      current: version?.status === "approved",
      /** Still out, but the version is no longer current: to be called in and replaced. */
      outOfDate: row.status === "issued" && version?.status !== "approved",
      issuedByName: name(row.issuedBy),
      closedByName: name(row.closedBy),
    };
  });
}

export async function listSopCopies(db: Executor, workspaceId: string, query: SopCopyListQuery) {
  const where = and(
    eq(sopCopies.workspaceId, workspaceId),
    query.sopId ? eq(sopCopies.sopId, query.sopId) : undefined,
    query.status === "all" ? undefined : eq(sopCopies.status, query.status),
    query.outOfDate === undefined
      ? undefined
      : query.outOfDate
        ? and(eq(sopCopies.status, "issued"), ne(sopVersions.status, "approved"))
        : sql`not (${sopCopies.status} = 'issued' and ${sopVersions.status} <> 'approved')`,
  );
  const base = db
    .select({ copy: sopCopies })
    .from(sopCopies)
    .innerJoin(sopVersions, eq(sopVersions.id, sopCopies.versionId))
    .innerJoin(sops, and(eq(sops.id, sopCopies.sopId), isNull(sops.deletedAt)))
    .where(where);
  const [rows, [total]] = await Promise.all([
    base
      .orderBy(desc(sopCopies.issuedAt), desc(sopCopies.copyNumber))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(sopCopies)
      .innerJoin(sopVersions, eq(sopVersions.id, sopCopies.versionId))
      .innerJoin(sops, and(eq(sops.id, sopCopies.sopId), isNull(sops.deletedAt)))
      .where(where),
  ]);
  return {
    copies: await copyViews(
      db,
      rows.map((r) => r.copy),
    ),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

async function findCopy(db: Executor, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(sopCopies)
    .where(and(eq(sopCopies.id, id), eq(sopCopies.workspaceId, workspaceId)));
  if (!row) throw notFound("Controlled copy");
  return row;
}

export async function getSopCopy(db: Executor, workspaceId: string, id: string) {
  const row = await findCopy(db, workspaceId, id);
  return (await copyViews(db, [row]))[0]!;
}

/**
 * Issues a printed copy of an approved version (the current one unless `versionId` says otherwise;
 * only an approved version can be issued) and numbers it: the next copy number of that version.
 */
export async function issueSopCopy(
  db: Database,
  workspaceId: string,
  actorId: string,
  sopId: string,
  input: SopCopyIssueInput,
) {
  return db.transaction(async (tx) => {
    // Numbering is max + 1, so two issues of one version must not interleave.
    await lockWorkspaceLog(tx, workspaceId);
    const [sop] = await tx
      .select()
      .from(sops)
      .where(and(eq(sops.id, sopId), eq(sops.workspaceId, workspaceId), isNull(sops.deletedAt)));
    if (!sop) throw notFound("SOP");
    if (sop.status !== "active") {
      throw new ApiError(409, "sop_archived", "An archived SOP can't be issued: make it active first");
    }
    const [version] = await tx
      .select()
      .from(sopVersions)
      .where(
        and(
          eq(sopVersions.sopId, sopId),
          eq(sopVersions.workspaceId, workspaceId),
          isNull(sopVersions.deletedAt),
          input.versionId ? eq(sopVersions.id, input.versionId) : eq(sopVersions.status, "approved"),
        ),
      );
    if (!version) {
      if (input.versionId) throw notFound("SOP version");
      throw new ApiError(409, "no_current_version", "This SOP has no approved version yet");
    }
    if (version.status !== "approved") {
      throw new ApiError(409, "version_not_current", "Only the current approved version can be issued");
    }
    let issuedTo = input.issuedTo ?? "";
    if (input.issuedToUserId) {
      const [member] = await tx
        .select({ name: users.name })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, input.issuedToUserId),
            isNull(workspaceMembers.deletedAt),
          ),
        );
      if (!member) throw badRequest("issuedToUserId must be a member of this workspace");
      issuedTo ||= member.name;
    }
    const [last] = await tx
      .select({ n: sql<number>`coalesce(max(${sopCopies.copyNumber}), 0)::int` })
      .from(sopCopies)
      .where(eq(sopCopies.versionId, version.id));
    const [row] = await tx
      .insert(sopCopies)
      .values({
        workspaceId,
        sopId,
        versionId: version.id,
        copyNumber: (last?.n ?? 0) + 1,
        issuedToUserId: input.issuedToUserId ?? null,
        issuedTo,
        location: input.location ?? null,
        issuedBy: actorId,
      })
      .returning();
    await recordChanges(tx, workspaceId, actorId, [copyChange(row!)]);
    return (await copyViews(tx, [row!]))[0]!;
  });
}

/** Records that a copy was returned or destroyed. A copy that is already closed stays as it was. */
export async function closeSopCopy(
  db: Database,
  workspaceId: string,
  actorId: string,
  id: string,
  input: SopCopyCloseInput,
) {
  return db.transaction(async (tx) => {
    await lockWorkspaceLog(tx, workspaceId);
    const copy = await findCopy(tx, workspaceId, id);
    if (copy.status !== "issued") {
      throw new ApiError(409, "copy_closed", `This copy was already ${copy.status}`);
    }
    const [row] = await tx
      .update(sopCopies)
      .set({ status: input.status, closedAt: new Date(), closedBy: actorId, closedNote: input.note ?? null })
      .where(eq(sopCopies.id, id))
      .returning();
    await recordChanges(tx, workspaceId, actorId, [copyChange(row!)]);
    return (await copyViews(tx, [row!]))[0]!;
  });
}
