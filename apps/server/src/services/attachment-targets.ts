import { attachmentTargets, type AttachmentTargetType, type ModuleId } from "@knotworking/core";
import {
  hseRecords,
  hseEntries,
  hsePermits,
  haccpCalibrationRecords,
  haccpCleaningRecords,
  haccpCorrectiveActions,
  items,
  npdProjects,
  defenceExercises,
  purchaseInvoices,
  purchaseOrders,
  purchaseReceipts,
  qualityAudits,
  qualityComplaints,
  qualityNonconformances,
  qualityRecallTests,
  siteGlassBreakages,
  sops,
  specifications,
  supplierQuestionnaires,
  suppliers,
  testingSamples,
  trainingRecords,
  type Executor,
} from "@knotworking/db";
import { and, eq, isNull } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * The registry of records a file can be attached to. Adding a target is one entry in
 * `attachmentTargets` (core: sync entity type, module, label, kinds) plus one in `targets` below
 * (its table and when it is locked); routes, sync filtering, the MCP listing and the web panel
 * all read from those. Each entry says:
 *  - the module whose access rules apply (from core, so clients agree);
 *  - how to load the record inside the workspace (null if it is missing, soft-deleted or another
 *    workspace's);
 *  - when the record is `locked`: signed off or append-only (an approved supplier, a closed
 *    action, a released breakage). Files can still be added to a locked record as evidence, but
 *    its existing files can no longer be deleted.
 */
export interface AttachmentTarget {
  module: ModuleId;
  load(db: Executor, workspaceId: string, id: string): Promise<{ locked: boolean } | null>;
}

interface TargetTable {
  id: PgColumn;
  workspaceId: PgColumn;
  deletedAt?: PgColumn;
}
type Row = Record<string, unknown>;

const targets: Record<AttachmentTargetType, { table: TargetTable; locked: (row: Row) => boolean }> = {
  hse_record: { table: hseRecords, locked: () => true },
  hse_entry: { table: hseEntries, locked: () => true },
  hse_permit: { table: hsePermits, locked: () => true },
  // Append-only: a competency sign-off or a void is a one-way decision.
  training_record: { table: trainingRecords, locked: (r) => r.signedOffAt != null || r.voidedAt != null },
  supplier: { table: suppliers, locked: (r) => r.approvalStatus === "approved" },
  item: { table: items, locked: () => false },
  // A reviewed questionnaire's evidence is final.
  supplier_questionnaire: {
    table: supplierQuestionnaires,
    locked: (r) => r.status === "accepted" || r.status === "rejected",
  },
  quality_complaint: { table: qualityComplaints, locked: (r) => r.status === "closed" },
  quality_nonconformance: { table: qualityNonconformances, locked: (r) => r.status === "closed" },
  site_glass_breakage: { table: siteGlassBreakages, locked: (r) => r.status === "released" },
  haccp_corrective_action: { table: haccpCorrectiveActions, locked: (r) => r.status === "closed" },
  purchase_order: {
    table: purchaseOrders,
    locked: (r) => r.status === "closed" || r.status === "cancelled",
  },
  // Approved invoices are immutable (a correction is a new version), and so is their evidence.
  purchase_invoice: { table: purchaseInvoices, locked: (r) => r.status !== "draft" },
  // An audit is final once completed or cancelled; its working papers can be added to until then.
  quality_audit: { table: qualityAudits, locked: (r) => r.status !== "planned" },
  // A recall test is recorded complete and never edited (a mistake is voided), so its evidence
  // (trace sheets, photos) is final from the start: files can be added, never removed.
  quality_recall_test: { table: qualityRecallTests, locked: () => true },
  // The first receipt row of a delivery stands for the whole delivery (the delivery note, photos of
  // the load). Receipts are append-only (a correction is a reversal on the lot), but a wrong photo
  // may still be removed by its uploader or a manager, so the delivery is never locked.
  purchase_receipt: { table: purchaseReceipts, locked: () => false },
  // A single line of a delivery (the receipt row itself): its own photos, never locked for the same reason.
  purchase_receipt_line: { table: purchaseReceipts, locked: () => false },
  // Append-only: a calibration is never edited, so its certificate is final once filed.
  haccp_calibration_record: { table: haccpCalibrationRecords, locked: () => true },
  // Locked once a second person has verified the cleaning.
  haccp_cleaning_record: { table: haccpCleaningRecords, locked: (r) => r.verifiedAt != null },
  // Not locked as a whole: a file stays removable while no draft or version uses it
  // (`deleteAttachment` refuses the others), so unused uploads can be cleaned up.
  sop: { table: sops, locked: () => false },
  // Not locked: a new version's sheet is filed beside the old ones, which stay as evidence.
  specification: { table: specifications, locked: () => false },
  // The report is evidence for the result: final once the sample is complete or cancelled.
  // Locked once launched or cancelled: the record of how the product came to be is final.
  npd_project: { table: npdProjects, locked: (r) => r.status === "launched" || r.status === "cancelled" },
  // Not locked: debrief notes and photos may follow the exercise.
  defence_exercise: { table: defenceExercises, locked: () => false },
  testing_sample: { table: testingSamples, locked: (r) => r.status !== "awaiting_results" },
};

export const attachmentTargetRegistry = Object.fromEntries(
  (Object.keys(attachmentTargets) as AttachmentTargetType[]).map((type) => {
    const { table, locked } = targets[type];
    const load: AttachmentTarget["load"] = async (db, workspaceId, id) => {
      const [row] = await db
        .select()
        .from(table as never)
        .where(
          and(
            eq(table.id, id),
            eq(table.workspaceId, workspaceId),
            ...(table.deletedAt ? [isNull(table.deletedAt)] : []),
          ),
        );
      return row ? { locked: locked(row as Row) } : null;
    };
    return [type, { module: attachmentTargets[type].module, load }];
  }),
) as Record<AttachmentTargetType, AttachmentTarget>;
