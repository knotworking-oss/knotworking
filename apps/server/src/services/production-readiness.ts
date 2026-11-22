import type { Database } from "@knotworking/db";
import { getBatchRecord } from "./haccp";
import { findBatch } from "./ports/production";

/** One read model for completion/release screens. Advisory: existing sign-off rules still apply.
 * Unreadable HACCP data is represented as unchecked, never as zero issues or an implicit pass.
 */
export async function getProductionReadiness(
  db: Database,
  workspaceId: string,
  batchId: string,
  canReadHaccp: boolean,
) {
  await findBatch(db, workspaceId, batchId);
  if (!canReadHaccp) return { batchId, checked: false as const, ready: null, issues: [] };
  const record = await getBatchRecord(db, workspaceId, batchId);
  const issues = [
    { code: "missing_checks", count: record.missingChecks, message: "Required CCP checks are missing" },
    {
      code: "awaiting_review",
      count: record.awaitingReview,
      message: "CCP readings are awaiting a person's review",
    },
    {
      code: "open_corrective_actions",
      count: record.openCorrectiveActions,
      message: "Corrective actions are still open",
    },
  ].filter((issue) => issue.count > 0);
  return { batchId, checked: true as const, ready: issues.length === 0, issues };
}
