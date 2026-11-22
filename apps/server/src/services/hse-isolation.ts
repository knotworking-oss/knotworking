import { hsePermits, type Executor } from "@knotworking/db";
import { and, eq, inArray } from "drizzle-orm";
import { ApiError } from "../errors";
/** Persistent safety hold: never depends on whether HSE is visible to this caller. Caller holds workspace lock. */
export async function assertNoHseIsolation(db: Executor, ws: string, assetId: string) {
  const [p] = await db
    .select({ id: hsePermits.id })
    .from(hsePermits)
    .where(
      and(
        eq(hsePermits.workspaceId, ws),
        eq(hsePermits.assetId, assetId),
        eq(hsePermits.isolationRequired, true),
        inArray(hsePermits.status, ["issued", "suspended"]),
      ),
    )
    .limit(1);
  if (p)
    throw new ApiError(
      409,
      "asset_isolated",
      "An HSE permit still isolates this asset. A signed return-to-service decision is required before hygiene clearance.",
    );
}
