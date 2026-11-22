import {
  checkOutcomeLabels,
  checkSignOffLabels,
  checklistKindLabels,
  ccpLogReviewStatusLabels,
  complaintCategoryLabels,
  complaintStatusLabels,
  correctiveActionStatusLabels,
  glassConditionLabels,
  glassItemKindLabels,
  breakageStatusLabels,
  pestActivityLabels,
  purchaseOrderStateLabels,
  qualitySeverityLabels,
  toCsv,
} from "@knotworking/core";
import type {
  BatchCostRow,
  ChecklistCheck,
  ComplaintRow,
  CorrectiveAction,
  GlassBreakage,
  GlassCheck,
  HaccpLog,
  MaintenanceRecord,
  PestVisit,
  PurchaseOrderRow,
  StorageReading,
} from "@/lib/api";

/**
 * CSV for the lists people ask to take into a spreadsheet. Each builder returns rows (header
 * first) for `toCsv` from `@knotworking/core`, which quotes fields and neutralises anything a
 * spreadsheet would read as a formula (a cell starting `=`, `+`, `-` or `@`). Numbers stay numbers;
 * dates and times are ISO so they sort and parse. Pure, so it runs in the browser from the data a
 * page already holds.
 */
export type CsvCell = string | number | null | undefined;
export type CsvRows = CsvCell[][];

const yesNo = (v: boolean) => (v ? "Yes" : "No");
const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : "");

/** The text of a CSV file: BOM first so Excel reads UTF-8 (£, °C, names with accents) correctly. */
export const csvDocument = (rows: CsvRows) => `﻿${toCsv(rows)}`;

/** `base-2026-11-13.csv`: a name with no characters a file system dislikes. */
export function csvFileName(base: string, date: string = new Date().toISOString().slice(0, 10)) {
  const safe = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${safe || "export"}-${date}.csv`;
}

/** Every row of a paged list, one request per page, stopping at `cap` rows. */
export async function collectPages<T>(
  fetchPage: (offset: number) => Promise<{ rows: readonly T[]; total: number }>,
  cap = 5000,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const page = await fetchPage(rows.length);
    rows.push(...page.rows);
    if (page.rows.length === 0 || rows.length >= page.total || rows.length >= cap) break;
  }
  return rows.slice(0, cap);
}

export function ccpLogsCsv(logs: readonly HaccpLog[]): CsvRows {
  return [
    [
      "Checked at",
      "Plan",
      "CCP",
      "Process step",
      "Limit",
      "Reading",
      "Within limits",
      "Batch",
      "Recorded by",
      "Source",
      "Review",
      "Reviewed by",
      "Reviewed at",
      "Review note",
      "Note",
      "Corrects log",
      "Correction reason",
      "Replaced by a correction",
      "Corrective actions",
    ],
    ...logs.map((l) => [
      iso(l.checkedAt),
      l.plan?.code,
      l.ccp.code,
      l.ccp.processStep,
      l.ccp.limitText,
      l.readingText,
      yesNo(l.withinLimits),
      l.batch?.batchCode,
      l.recordedByName,
      l.source,
      ccpLogReviewStatusLabels[l.reviewStatus],
      l.reviewedByName,
      iso(l.reviewedAt),
      l.reviewNote,
      l.note,
      l.correctsLogId,
      l.correctionReason,
      yesNo(l.correctedByLogId !== null),
      l.correctiveActions.map((a) => a.title).join("; "),
    ]),
  ];
}

export function correctiveActionsCsv(actions: readonly CorrectiveAction[]): CsvRows {
  return [
    [
      "Raised at",
      "Title",
      "Status",
      "Deviation",
      "Batch",
      "Action taken",
      "Root cause",
      "Preventive action",
      "Raised by",
      "Closed at",
      "Closed by",
      "Closure note",
    ],
    ...actions.map((a) => [
      iso(a.createdAt),
      a.title,
      correctiveActionStatusLabels[a.status],
      a.log ? `${a.log.ccp.code} ${a.log.readingText}` : "",
      a.batch?.batchCode,
      a.actionTaken,
      a.rootCause,
      a.preventiveAction,
      a.raisedByName,
      iso(a.closedAt),
      a.closedByName,
      a.closureNote,
    ]),
  ];
}

export function storageReadingsCsv(readings: readonly StorageReading[]): CsvRows {
  return [
    [
      "Checked at",
      "Unit",
      "Code",
      "Value",
      "Reading",
      "Limits",
      "Within limits",
      "Recorded by",
      "Source",
      "Review",
      "Reviewed by",
      "Reviewed at",
      "Note",
      "Corrects reading",
      "Correction reason",
      "Replaced by a correction",
      "Corrective actions",
    ],
    ...readings.map((r) => [
      iso(r.checkedAt),
      r.unit?.name,
      r.unit?.code,
      Number(r.value),
      r.readingText,
      r.limitsText,
      yesNo(r.withinLimits),
      r.recordedByName,
      r.source,
      ccpLogReviewStatusLabels[r.reviewStatus],
      r.reviewedByName,
      iso(r.reviewedAt),
      r.note,
      r.correctsReadingId,
      r.correctionReason,
      yesNo(r.correctedByReadingId !== null),
      r.correctiveActions.map((a) => a.title).join("; "),
    ]),
  ];
}

export function checklistChecksCsv(checks: readonly ChecklistCheck[]): CsvRows {
  return [
    [
      "Performed at",
      "Checklist",
      "Kind",
      "Area",
      "Line",
      "Outcome",
      "Failed items",
      "Performed by",
      "Sign-off",
      "Signed off by",
      "Signed off at",
      "Sign-off note",
      "Note",
      "Previous batch",
      "Next batch",
      "Corrects check",
      "Correction reason",
      "Replaced by a correction",
    ],
    ...checks.map((c) => [
      iso(c.performedAt),
      c.templateName,
      checklistKindLabels[c.kind],
      c.area?.name,
      c.line,
      checkOutcomeLabels[c.outcome],
      c.failedCount,
      c.performedByName,
      checkSignOffLabels[c.signOffStatus],
      c.signedOffByName,
      iso(c.signedOffAt),
      c.signOffNote,
      c.note,
      c.previousBatch?.batchCode,
      c.nextBatch?.batchCode,
      c.correctsCheckId,
      c.correctionReason,
      yesNo(c.correctedByCheckId !== null),
    ]),
  ];
}

export function glassChecksCsv(checks: readonly GlassCheck[]): CsvRows {
  return [
    [
      "Checked at",
      "Area",
      "Item",
      "Kind",
      "Condition",
      "Note",
      "Recorded by",
      "Corrects check",
      "Correction reason",
      "Replaced by a correction",
    ],
    ...checks.map((c) => [
      iso(c.checkedAt),
      c.area?.name,
      c.item?.description,
      c.item ? glassItemKindLabels[c.item.kind] : "",
      glassConditionLabels[c.condition],
      c.note,
      c.recordedByName,
      c.correctsCheckId,
      c.correctionReason,
      yesNo(c.correctedByCheckId !== null),
    ]),
  ];
}

export function glassBreakagesCsv(breakages: readonly GlassBreakage[]): CsvRows {
  return [
    [
      "Occurred at",
      "Area",
      "Register item",
      "What broke",
      "Quarantined",
      "Clean-down",
      "Clean-down by",
      "Clean-down at",
      "Status",
      "Reported by",
      "Source",
      "Released by",
      "Released at",
      "Release note",
    ],
    ...breakages.map((b) => [
      iso(b.occurredAt),
      b.area?.name,
      b.item?.description,
      b.description,
      b.quarantined,
      b.cleanDown,
      b.cleanDownByName,
      iso(b.cleanDownAt),
      breakageStatusLabels[b.status],
      b.raisedByName,
      b.source,
      b.releasedByName,
      iso(b.releasedAt),
      b.releaseNote,
    ]),
  ];
}

export function maintenanceRecordsCsv(records: readonly MaintenanceRecord[]): CsvRows {
  return [
    [
      "Completed at",
      "Task",
      "Equipment",
      "Area",
      "Work done",
      "Done by",
      "Contractor",
      "Next due",
      "Clearance required",
      "Cleared at",
      "Cleared by",
      "Clearance note",
      "Note",
      "Recorded by",
      "Corrects record",
      "Correction reason",
      "Replaced by a correction",
    ],
    ...records.map((m) => [
      iso(m.completedAt),
      m.task?.title,
      m.asset?.name,
      m.area?.name,
      m.workDone,
      m.doneByName,
      m.contractor,
      m.nextDueOn,
      yesNo(m.clearanceRequired),
      iso(m.clearedAt),
      m.clearedByName,
      m.clearanceNote,
      m.note,
      m.recordedByName,
      m.correctsRecordId,
      m.correctionReason,
      yesNo(m.correctedByRecordId !== null),
    ]),
  ];
}

/** One row per finding (a visit with none gets one row of its own). */
export function pestVisitsCsv(visits: readonly PestVisit[]): CsvRows {
  return [
    [
      "Visited on",
      "Contractor",
      "Technician",
      "Device",
      "Location",
      "Activity",
      "Pest",
      "Count",
      "Finding action",
      "Finding note",
      "Visit summary",
      "Recommendations",
      "Actions taken",
      "Next visit",
      "Recorded by",
      "Corrects visit",
      "Correction reason",
      "Replaced by a correction",
    ],
    ...visits.flatMap((v) => {
      const visit = [
        v.summary,
        v.recommendations,
        v.actionsTaken,
        v.nextVisitOn,
        v.recordedByName,
        v.correctsVisitId,
        v.correctionReason,
        yesNo(v.correctedByVisitId !== null),
      ];
      return v.findings.length === 0
        ? [[v.visitedOn, v.contractor, v.technician, "", "", "", "", "", "", "", ...visit]]
        : v.findings.map((f) => [
            v.visitedOn,
            v.contractor,
            v.technician,
            f.device?.code,
            f.device?.location ?? f.location,
            pestActivityLabels[f.activity],
            f.pest,
            f.count,
            f.action,
            f.note,
            ...visit,
          ]);
    }),
  ];
}

export function complaintsCsv(complaints: readonly ComplaintRow[]): CsvRows {
  return [
    [
      "Reference",
      "Received on",
      "Status",
      "Category",
      "Severity",
      "Customer",
      "Product",
      "Lot",
      "Reported lot code",
      "Description",
      "Non-conformances",
      "Logged by",
      "Closed by",
    ],
    ...complaints.map((c) => [
      c.reference,
      c.receivedOn,
      complaintStatusLabels[c.status],
      complaintCategoryLabels[c.category],
      qualitySeverityLabels[c.severity],
      c.customer,
      c.item ? `${c.item.code} ${c.item.name}` : "",
      c.lot?.lotCode,
      c.reportedLotCode,
      c.description,
      c.nonconformanceCount,
      c.createdByName,
      c.closedByName,
    ]),
  ];
}

export function purchaseOrdersCsv(orders: readonly PurchaseOrderRow[]): CsvRows {
  return [
    [
      "Reference",
      "Supplier",
      "Supplier code",
      "State",
      "Ordered on",
      "Next expected",
      "Lines",
      "Lines received in full",
      "Value",
      "Value complete",
      "Overdue",
      "Delivery location",
      "Supplier reference",
    ],
    ...orders.map((o) => [
      o.reference,
      o.supplier.name,
      o.supplier.code,
      purchaseOrderStateLabels[o.state],
      o.orderedOn,
      o.nextExpectedOn,
      o.linesCount,
      o.receivedLines,
      o.value,
      yesNo(o.valueComplete),
      yesNo(o.overdue),
      o.deliveryLocation?.name,
      o.supplierReference,
    ]),
  ];
}

export function batchCostsCsv(batches: readonly BatchCostRow[]): CsvRows {
  return [
    [
      "Batch",
      "Status",
      "Costing date",
      "Product code",
      "Product",
      "Produced",
      "Unit",
      "Yield %",
      "Actual cost",
      "Cost per unit",
      "Standard cost per unit",
      "Variance",
      "Variance %",
      "Estimated %",
      "Provisional",
      "Complete",
    ],
    ...batches.map((b) => [
      b.batchCode,
      b.status,
      b.costingDate,
      b.outputItem.code,
      b.outputItem.name,
      b.cost.produced.display,
      b.cost.produced.displayUnit,
      b.cost.yieldPercent,
      b.cost.actualCost,
      b.cost.costPerUnit,
      b.cost.standardCostPerUnit,
      b.cost.variance,
      b.cost.variancePercent,
      b.cost.estimatedPercent,
      yesNo(b.cost.provisional),
      yesNo(b.cost.costComplete),
    ]),
  ];
}
