import { canSignOffSiteRecord, type ModuleId, type SiteFrequency } from "@knotworking/core";
import { type ChangeInput, type Executor, type Transaction, workspaceMembers } from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError, badRequest } from "../errors";
import { audience, memberAccess } from "./notifications";
import { assetSummaries } from "./ports/assets";

type AreaSummary = { id: string; code: string | null; name: string; status: string };

/** How far ahead of the server's clock a record may be dated (clock skew on a tablet). */
export const FUTURE_SKEW_MS = 5 * 60_000;

// ─── Shared helpers ──────────────────────────────────────────────────────────

export const strip = <T extends { workspaceId: string }>(row: T) => {
  const { workspaceId: _ws, ...rest } = row;
  return rest;
};
export const stripSoft = <T extends { workspaceId: string; deletedAt: Date | null }>(row: T) => {
  const { workspaceId: _ws, deletedAt: _deleted, ...rest } = row;
  return rest;
};
export const change = (
  entity: ChangeInput["entity"],
  row: { id: string; workspaceId: string; deletedAt?: Date | null },
): ChangeInput => {
  const { workspaceId: _ws, deletedAt: _deleted, ...data } = row;
  return { entity, entityId: row.id, action: "upsert", data };
};

export const nameOf = (names: Map<string, string>, id: string | null) =>
  id ? (names.get(id) ?? null) : null;
export const frequencyOf = (
  every: number | null,
  unit: SiteFrequency["unit"] | null,
): SiteFrequency | null => (every !== null && unit !== null ? { every, unit } : null);

/** The date of a check or record: now unless given, and not in the future (allowing for clock skew). */
export function momentOf(value: string | undefined, now: Date) {
  if (!value) return now;
  const at = new Date(value);
  if (at.getTime() > now.getTime() + FUTURE_SKEW_MS)
    throw badRequest("A record can't be dated in the future");
  return at;
}

/** A page of records with the total, as every list returns it. */
export const page = <T>(rows: T[], total: number | undefined, query: { limit: number; offset: number }) => ({
  rows,
  total: total ?? 0,
  limit: query.limit,
  offset: query.offset,
});

export async function assertMember(tx: Executor, workspaceId: string, userId: string) {
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
  if (!member) throw badRequest("doneBy must be a member of this workspace");
}

export async function areasById(db: Executor, ids: (string | null | undefined)[]) {
  const found = await assetSummaries(db, ids);
  return new Map<string, AreaSummary>(
    [...found.values()].map((a) => [a.id, { id: a.id, code: a.code, name: a.name, status: a.status }]),
  );
}
export const areaOf = (areas: Map<string, AreaSummary>, id: string | null) =>
  id ? (areas.get(id) ?? null) : null;

/**
 * Four-eyes: the person who signs a release (an area after a breakage or after maintenance) is not
 * one of the people who reported or recorded it, unless they are the only member with `manage` on
 * the relevant module. `active` is the workspace's active modules (a module switched off grants nothing).
 */
export async function assertFourEyes(
  tx: Transaction,
  workspaceId: string,
  active: readonly ModuleId[],
  actorId: string,
  recordedBy: readonly (string | null)[],
  what: string,
  module: ModuleId,
) {
  if (!recordedBy.includes(actorId)) return;
  const managers = audience(await memberAccess(tx, workspaceId, active), module, "manage");
  if (!canSignOffSiteRecord({ recordedBy, deciderId: actorId, managerIds: managers })) {
    throw new ApiError(
      403,
      "four_eyes",
      `You ${what}, so someone else with manage access must sign this off`,
    );
  }
}
