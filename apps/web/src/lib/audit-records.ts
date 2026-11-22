import {
  checkItemResultLabels,
  checkOutcomeLabels,
  checkSignOffLabels,
  checklistKindLabels,
  ccpLogReviewStatusLabels,
  correctiveActionStatusLabels,
  deviationReasonLabels,
  glassConditionLabels,
  glassItemKindLabels,
  pestActivityLabels,
  auditStatusLabels,
  nonconformanceStatusLabels,
  qualitySeverityLabels,
  recallDirectionLabels,
  type CcpLogReviewStatus,
  type AuditStatus,
} from "@knotworking/core";
import type {
  CalibrationRecord,
  ChecklistCheck,
  CleaningRecord,
  CorrectiveAction,
  GlassBreakage,
  GlassCheck,
  HaccpLog,
  MaintenanceRecord,
  QualityAuditDetail,
  RecallTestRow,
  PestVisit,
  StorageReading,
} from "@/lib/api";
import { inDayRange, printDate, printDateTime, type DayRange } from "@/lib/print";

/**
 * One record on an audit print: who did what and when, what it corrected, and who signed it off.
 * Built from the API's records by the functions below, so the layout stays one component.
 */
export interface AuditEntry {
  id: string;
  /** When it was done (ISO timestamp or date): the order on paper. */
  at: string;
  atText: string;
  title: string;
  lines: string[];
  /** The outcome in words ("78.0 °C, within limits"). */
  result: string | null;
  /** Out of limits, failed, rejected: printed in bold. */
  problem: boolean;
  /** "Recorded by Ada Lovelace". */
  doneBy: string | null;
  note: string | null;
  /** Set when this record corrects an earlier one: what that earlier one said, and why. */
  corrects: { summary: string; reason: string | null } | null;
  /** A later record has replaced this one: it no longer counts. */
  replaced: boolean;
  /** What to say about a replaced record, when "a later record corrects it" is not it (a voided test). */
  replacedNote?: string;
  /** Review, clearance or sign-off in words, or null when the record has none. */
  signOff: string | null;
  /** Corrective actions the record opened. */
  followUps: string[];
  /** One line saying what the record was, for a correction to quote. */
  summary: string;
}

type Maybe<T> = T | null | undefined;

const by = (verb: string, name: Maybe<string>) => (name ? `${verb} ${name}` : null);

function correction(
  correctsId: Maybe<string>,
  reason: Maybe<string>,
  summaries: ReadonlyMap<string, string>,
): AuditEntry["corrects"] {
  if (!correctsId) return null;
  return {
    summary: summaries.get(correctsId) ?? "an earlier record (before the start of this range)",
    reason: reason ?? null,
  };
}

function review(
  status: CcpLogReviewStatus,
  name: Maybe<string>,
  at: Maybe<string | Date>,
  note: Maybe<string>,
  timeZone: string,
) {
  const when = at ? `, ${printDateTime(at, timeZone)}` : "";
  const why = note ? `: ${note}` : "";
  if (status === "pending") return "Awaiting review";
  const word = status === "approved" ? "Approved" : "Rejected";
  return `${word}${name ? ` by ${name}` : ""}${when}${why}`;
}

/** CCP checks of a plan. */
export function ccpLogEntries(logs: readonly HaccpLog[], timeZone = "UTC"): AuditEntry[] {
  const summary = (l: HaccpLog) => `${printDateTime(l.checkedAt, timeZone)}: ${l.ccp.code} ${l.readingText}`;
  const summaries = new Map(logs.map((l) => [l.id, summary(l)]));
  return logs.map((l) => ({
    id: l.id,
    at: String(l.checkedAt),
    atText: printDateTime(l.checkedAt, timeZone),
    title: `${l.ccp.code} ${l.ccp.processStep}`,
    lines: [
      `Limit: ${l.ccp.limitText}`,
      ...(l.batch ? [`Batch ${l.batch.batchCode}`] : []),
      ...(l.source === "api" ? ["Entered by an API token"] : []),
    ],
    result: `${l.readingText}, ${l.withinLimits ? "within limits" : "OUT OF LIMITS"}${
      !l.withinLimits && l.deviationReason ? ` (${deviationReasonLabels[l.deviationReason]})` : ""
    }`,
    problem: !l.withinLimits,
    doneBy: by("Checked by", l.recordedByName),
    note: l.note ?? null,
    corrects: correction(l.correctsLogId, l.correctionReason, summaries),
    replaced: l.correctedByLogId !== null,
    signOff: review(l.reviewStatus, l.reviewedByName, l.reviewedAt, l.reviewNote, timeZone),
    followUps: l.correctiveActions.map((a) => `${a.title} (${correctiveActionStatusLabels[a.status]})`),
    summary: summary(l),
  }));
}

/** Corrective actions, with who raised them and who closed them. */
export function correctiveActionEntries(
  actions: readonly CorrectiveAction[],
  timeZone = "UTC",
): AuditEntry[] {
  return actions.map((a) => ({
    id: a.id,
    at: String(a.createdAt),
    atText: printDateTime(a.createdAt, timeZone),
    title: a.title,
    lines: [
      ...(a.log
        ? [`Deviation: ${a.log.ccp.code} ${a.log.readingText} on ${printDateTime(a.log.checkedAt, timeZone)}`]
        : []),
      ...(a.calibration
        ? [
            `Calibration of ${a.calibration.asset.name}: ${a.calibration.actualReading} against ${a.calibration.referenceReading} ${a.calibration.unit}`,
          ]
        : []),
      ...(a.batch ? [`Batch ${a.batch.batchCode}`] : []),
      ...(a.lot ? [`Lot ${a.lot.lotCode}`] : []),
      `Action taken: ${a.actionTaken ?? "not recorded"}`,
      `Root cause: ${a.rootCause ?? "not recorded"}`,
      `Preventive action: ${a.preventiveAction ?? "not recorded"}`,
    ],
    result: correctiveActionStatusLabels[a.status],
    problem: a.status === "open",
    doneBy: by("Raised by", a.raisedByName),
    note: null,
    corrects: null,
    replaced: false,
    signOff:
      a.status === "closed"
        ? `Closed by ${a.closedByName ?? "—"}, ${printDateTime(a.closedAt, timeZone)}${a.closureNote ? `: ${a.closureNote}` : ""}`
        : "Open: not signed off",
    followUps: [],
    summary: `${printDateTime(a.createdAt, timeZone)}: ${a.title}`,
  }));
}

/** Cleaning of areas and equipment, with who did it and who verified it. */
export function cleaningEntries(records: readonly CleaningRecord[], timeZone = "UTC"): AuditEntry[] {
  const summary = (r: CleaningRecord) =>
    `${printDateTime(r.cleanedAt, timeZone)}: cleaning of ${r.asset.name}`;
  const summaries = new Map(records.map((r) => [r.id, summary(r)]));
  return records.map((r) => ({
    id: r.id,
    at: String(r.cleanedAt),
    atText: printDateTime(r.cleanedAt, timeZone),
    title: `Cleaning · ${r.asset.name}${r.asset.code ? ` (${r.asset.code})` : ""}`,
    lines: [],
    result: "Cleaned",
    problem: false,
    doneBy: by("Done by", r.doneByName) ?? by("Recorded by", r.recordedByName),
    note: r.note ?? null,
    corrects: correction(r.correctsRecordId, r.correctionReason, summaries),
    replaced: r.correctedByRecordId !== null,
    signOff: r.verifiedAt
      ? `Verified by ${r.verifiedByName ?? "—"}, ${printDateTime(r.verifiedAt, timeZone)}${r.verificationNote ? `: ${r.verificationNote}` : ""}`
      : "Not yet verified",
    followUps: [],
    summary: summary(r),
  }));
}

/** Calibration of equipment against a reference, with the result and any corrective action. */
export function calibrationEntries(records: readonly CalibrationRecord[], timeZone = "UTC"): AuditEntry[] {
  const summary = (r: CalibrationRecord) =>
    `${printDateTime(r.calibratedAt, timeZone)}: calibration of ${r.asset.name}`;
  const summaries = new Map(records.map((r) => [r.id, summary(r)]));
  return records.map((r) => {
    const unit = r.unit ? ` ${r.unit}` : "";
    return {
      id: r.id,
      at: String(r.calibratedAt),
      atText: printDateTime(r.calibratedAt, timeZone),
      title: `Calibration · ${r.asset.name}${r.asset.code ? ` (${r.asset.code})` : ""}`,
      lines: [
        `Reference ${r.referenceReading}${unit}, reading ${r.actualReading}${unit}${r.tolerance !== null ? `, tolerance ±${r.tolerance}${unit}` : ""}`,
        ...(r.method ? [`Method: ${r.method}`] : []),
        ...(r.nextDueOn ? [`Next due ${printDate(r.nextDueOn)}`] : []),
      ],
      result: r.passed ? "Passed" : "FAILED",
      problem: !r.passed,
      doneBy: by("Recorded by", r.recordedByName),
      note: r.note ?? null,
      corrects: correction(r.correctsRecordId, r.correctionReason, summaries),
      replaced: r.correctedByRecordId !== null,
      signOff: null,
      followUps: r.correctiveActions.map(
        (a) => `Corrective action (${correctiveActionStatusLabels[a.status]})`,
      ),
      summary: summary(r),
    };
  });
}

/** Storage temperature readings. */
export function storageReadingEntries(readings: readonly StorageReading[], timeZone = "UTC"): AuditEntry[] {
  const summary = (r: StorageReading) =>
    `${printDateTime(r.checkedAt, timeZone)}: ${r.unit?.name ?? "unit"} ${r.readingText}`;
  const summaries = new Map(readings.map((r) => [r.id, summary(r)]));
  return readings.map((r) => ({
    id: r.id,
    at: String(r.checkedAt),
    atText: printDateTime(r.checkedAt, timeZone),
    title: `${r.unit?.name ?? "Storage unit"}${r.unit?.code ? ` (${r.unit.code})` : ""}`,
    lines: [`Limits: ${r.limitsText}`, ...(r.source === "api" ? ["Entered by an API token"] : [])],
    result: `${r.readingText}, ${r.withinLimits ? "within limits" : "OUT OF LIMITS"}`,
    problem: !r.withinLimits,
    doneBy: by("Read by", r.recordedByName),
    note: r.note ?? null,
    corrects: correction(r.correctsReadingId, r.correctionReason, summaries),
    replaced: r.correctedByReadingId !== null,
    signOff: review(r.reviewStatus, r.reviewedByName, r.reviewedAt, r.reviewNote, timeZone),
    followUps: r.correctiveActions.map((a) => `${a.title} (${a.status})`),
    summary: summary(r),
  }));
}

/** Pre-start, changeover and other checklist checks, with each item's result. */
export function checklistCheckEntries(checks: readonly ChecklistCheck[], timeZone = "UTC"): AuditEntry[] {
  const summary = (c: ChecklistCheck) =>
    `${printDateTime(c.performedAt, timeZone)}: ${c.templateName} (${checkOutcomeLabels[c.outcome]})`;
  const summaries = new Map(checks.map((c) => [c.id, summary(c)]));
  return checks.map((c) => ({
    id: c.id,
    at: String(c.performedAt),
    atText: printDateTime(c.performedAt, timeZone),
    title: `${c.templateName} · ${checklistKindLabels[c.kind]}`,
    lines: [
      ...(c.area
        ? [`Area: ${c.area.name}${c.line ? `, ${c.line}` : ""}`]
        : c.line
          ? [`Line: ${c.line}`]
          : []),
      ...(c.previousBatch || c.nextBatch
        ? [`Batches: ${c.previousBatch?.batchCode ?? "—"} then ${c.nextBatch?.batchCode ?? "—"}`]
        : []),
      ...(c.allergenRisk && c.allergenRisk.status !== "none"
        ? c.allergenRisk.warnings.map((w) => `Allergen risk: ${w}`)
        : []),
      ...c.results.map(
        (r) => `${checkItemResultLabels[r.result]}: ${r.prompt}${r.note ? ` (${r.note})` : ""}`,
      ),
    ],
    result: `${checkOutcomeLabels[c.outcome]}${c.failedCount ? `, ${c.failedCount} failed` : ""}`,
    problem: c.outcome === "failed",
    doneBy: by("Done by", c.performedByName),
    note: c.note ?? null,
    corrects: correction(c.correctsCheckId, c.correctionReason, summaries),
    replaced: c.correctedByCheckId !== null,
    signOff:
      c.signOffStatus === "pending"
        ? `${checkSignOffLabels[c.signOffStatus]}`
        : `${checkSignOffLabels[c.signOffStatus]}${c.signedOffByName ? ` by ${c.signedOffByName}` : ""}${c.signedOffAt ? `, ${printDateTime(c.signedOffAt, timeZone)}` : ""}${c.signOffNote ? `: ${c.signOffNote}` : ""}`,
    followUps: [],
    summary: summary(c),
  }));
}

/** Glass and brittle plastics condition checks, one record per item checked. */
export function glassCheckEntries(checks: readonly GlassCheck[], timeZone = "UTC"): AuditEntry[] {
  const summary = (c: GlassCheck) =>
    `${printDateTime(c.checkedAt, timeZone)}: ${c.item?.description ?? "item"} ${glassConditionLabels[c.condition].toLowerCase()}`;
  const summaries = new Map(checks.map((c) => [c.id, summary(c)]));
  return checks.map((c) => ({
    id: c.id,
    at: String(c.checkedAt),
    atText: printDateTime(c.checkedAt, timeZone),
    title: `${c.item?.description ?? "Glass item"}${c.area ? ` · ${c.area.name}` : ""}`,
    lines: [
      ...(c.item ? [glassItemKindLabels[c.item.kind]] : []),
      ...(c.item?.location ? [`Location: ${c.item.location}`] : []),
    ],
    result: c.condition === "intact" ? "Intact" : glassConditionLabels[c.condition].toUpperCase(),
    problem: c.condition !== "intact",
    doneBy: by("Checked by", c.recordedByName),
    note: c.note ?? null,
    corrects: correction(c.correctsCheckId, c.correctionReason, summaries),
    replaced: c.correctedByCheckId !== null,
    signOff: null,
    followUps: [],
    summary: summary(c),
  }));
}

/** Glass breakages: what was quarantined, the clean-down and who released the area. */
export function glassBreakageEntries(breakages: readonly GlassBreakage[], timeZone = "UTC"): AuditEntry[] {
  return breakages.map((b) => {
    const summary = `${printDateTime(b.occurredAt, timeZone)}: breakage in ${b.area?.name ?? "an area"}`;
    return {
      id: b.id,
      at: String(b.occurredAt),
      atText: printDateTime(b.occurredAt, timeZone),
      title: `Breakage${b.area ? ` · ${b.area.name}` : ""}`,
      lines: [
        b.description,
        ...(b.item ? [`Register item: ${b.item.description}`] : []),
        `Quarantined: ${b.quarantined}`,
        b.cleanDown
          ? `Clean-down: ${b.cleanDown}${b.cleanDownByName ? ` (${b.cleanDownByName}${b.cleanDownAt ? `, ${printDateTime(b.cleanDownAt, timeZone)}` : ""})` : ""}`
          : "Clean-down: not yet recorded",
        ...(b.source === "api" ? ["Reported through the API"] : []),
      ],
      result: b.status === "open" ? "AREA HELD" : "Released",
      problem: b.status === "open",
      doneBy: by("Reported by", b.raisedByName),
      note: null,
      corrects: null,
      replaced: false,
      signOff:
        b.status === "released"
          ? `Released by ${b.releasedByName ?? "—"}${b.releasedAt ? `, ${printDateTime(b.releasedAt, timeZone)}` : ""}${b.releaseNote ? `: ${b.releaseNote}` : ""}`
          : "Area still held: not yet released",
      followUps: [],
      summary,
    };
  });
}

/** Maintenance work, with who did it and who cleared the area to restart. */
export function maintenanceEntries(records: readonly MaintenanceRecord[], timeZone = "UTC"): AuditEntry[] {
  const summary = (m: MaintenanceRecord) =>
    `${printDateTime(m.completedAt, timeZone)}: ${m.task?.title ?? "maintenance"} on ${m.asset?.name ?? "equipment"}`;
  const summaries = new Map(records.map((m) => [m.id, summary(m)]));
  return records.map((m) => ({
    id: m.id,
    at: String(m.completedAt),
    atText: printDateTime(m.completedAt, timeZone),
    title: `${m.task?.title ?? "Maintenance"} · ${m.asset?.name ?? "equipment"}`,
    lines: [
      ...(m.area ? [`Area: ${m.area.name}`] : []),
      ...(m.workDone ? [`Work done: ${m.workDone}`] : []),
      ...(m.contractor ? [`Contractor: ${m.contractor}`] : []),
      `Next due ${printDate(m.nextDueOn)}`,
    ],
    result: m.clearanceRequired
      ? m.clearedAt
        ? "Done, area cleared"
        : m.correctedByRecordId
          ? "Done"
          : "Done, AWAITING CLEARANCE"
      : "Done",
    problem: m.awaitingClearance,
    doneBy: by("Done by", m.doneByName ?? m.contractor) ?? by("Recorded by", m.recordedByName),
    note: m.note ?? null,
    corrects: correction(m.correctsRecordId, m.correctionReason, summaries),
    replaced: m.correctedByRecordId !== null,
    signOff: m.clearanceRequired
      ? m.clearedAt
        ? `Cleared to restart by ${m.clearedByName ?? "—"}, ${printDateTime(m.clearedAt, timeZone)}${m.clearanceNote ? `: ${m.clearanceNote}` : ""}`
        : "Clearance required, not yet given"
      : null,
    followUps: [],
    summary: summary(m),
  }));
}

/** Pest control visits and what they found. */
export function pestVisitEntries(visits: readonly PestVisit[], timeZone = "UTC"): AuditEntry[] {
  const summary = (v: PestVisit) => `${printDate(v.visitedOn)}: visit by ${v.contractor}`;
  const summaries = new Map(visits.map((v) => [v.id, summary(v)]));
  return visits.map((v) => ({
    id: v.id,
    at: v.visitedOn,
    atText: printDate(v.visitedOn),
    title: `Visit by ${v.contractor}${v.technician ? ` (${v.technician})` : ""}`,
    lines: [
      ...v.findings.map(
        (f) =>
          `${f.device?.code ?? f.location ?? "Site"}: ${pestActivityLabels[f.activity]}${f.pest ? `, ${f.pest}` : ""}${f.count ? ` x${f.count}` : ""}${f.action ? `. Action: ${f.action}` : ""}${f.note ? ` (${f.note})` : ""}`,
      ),
      ...(v.recommendations ? [`Recommendations: ${v.recommendations}`] : []),
      ...(v.actionsTaken ? [`Actions taken: ${v.actionsTaken}`] : []),
      `Next visit: ${v.nextVisitOn ? printDate(v.nextVisitOn) : "none set"}`,
    ],
    result: `Highest activity: ${pestActivityLabels[v.highestActivity]}`,
    problem: v.highestActivity === "moderate" || v.highestActivity === "high",
    doneBy: by("Recorded by", v.recordedByName),
    note: v.summary ?? null,
    corrects: correction(v.correctsVisitId, v.correctionReason, summaries),
    replaced: v.correctedByVisitId !== null,
    signOff: null,
    followUps: [],
    summary: summary(v),
  }));
}

/**
 * The corrective actions that answer a plan's deviations and were raised or closed in the range,
 * or answer a deviation checked in the range, oldest first.
 */
export function planCorrectiveActions(
  actions: readonly CorrectiveAction[],
  planId: string,
  range: DayRange,
  timeZone = "UTC",
): CorrectiveAction[] {
  return actions
    .filter(
      (a) =>
        a.log?.plan?.id === planId &&
        (inDayRange(String(a.createdAt), range, timeZone) ||
          inDayRange(a.closedAt ? String(a.closedAt) : null, range, timeZone) ||
          inDayRange(String(a.log.checkedAt), range, timeZone)),
    )
    .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
}

/** A quality audit, in the range when it was completed (or, if not done, planned). */
export function auditInRange(
  audit: { status: AuditStatus; plannedOn: string; completedOn: string | null },
  range: DayRange,
): boolean {
  return inDayRange(
    audit.status === "completed" ? (audit.completedOn ?? audit.plannedOn) : audit.plannedOn,
    range,
  );
}

/** Internal audits with their findings and who signed them off. */
export function qualityAuditEntries(audits: readonly QualityAuditDetail[], timeZone = "UTC"): AuditEntry[] {
  return audits.map((a) => {
    const done = a.status === "completed";
    const date = done ? (a.completedOn ?? a.plannedOn) : a.plannedOn;
    return {
      id: a.id,
      at: date,
      atText: printDate(date),
      title: `${a.reference} ${a.title}`,
      lines: [
        ...(a.scope ? [`Scope: ${a.scope}`] : []),
        `Planned ${printDate(a.plannedOn)}`,
        `Auditor: ${a.auditor?.name ?? a.auditorName ?? "not named"}`,
        ...(a.summary ? [`Summary: ${a.summary}`] : []),
        ...(a.nonconformances.length === 0
          ? ["No findings raised"]
          : a.nonconformances.map(
              (n) =>
                `Finding ${n.reference}: ${n.title} (${qualitySeverityLabels[n.severity]}, ${nonconformanceStatusLabels[n.status]}${n.dueOn ? `, due ${printDate(n.dueOn)}` : ""})`,
            )),
      ],
      result:
        auditStatusLabels[a.status] +
        (a.status === "completed" ? `, ${a.findings.total} finding${a.findings.total === 1 ? "" : "s"}` : ""),
      problem: a.findings.open > 0,
      doneBy: by("Auditor", a.auditor?.name ?? a.auditorName),
      note: a.status === "cancelled" ? (a.cancelReason ?? null) : null,
      corrects: null,
      replaced: false,
      signOff: done
        ? `Signed off by ${a.completedByName ?? "—"}${a.completedAt ? `, ${printDateTime(a.completedAt, timeZone)}` : ""}`
        : a.status === "cancelled"
          ? `Cancelled by ${a.cancelledByName ?? "—"}${a.cancelledAt ? `, ${printDateTime(a.cancelledAt, timeZone)}` : ""}`
          : "Not yet signed off",
      followUps: [],
      summary: `${a.reference} ${a.title}`,
    };
  });
}

/** Mock recall tests: the lot, how long the trace took, how much of it reconciled. */
export function recallTestEntries(tests: readonly RecallTestRow[], timeZone = "UTC"): AuditEntry[] {
  return tests.map((t) => {
    const voided = t.voidedAt !== null;
    return {
      id: t.id,
      at: t.conductedOn,
      atText: printDate(t.conductedOn),
      title: `${t.reference} · ${recallDirectionLabels[t.direction]} trace of ${t.lot?.lotCode ?? "a lot"}${t.lot?.item ? ` (${t.lot.item.name})` : ""}`,
      lines: [
        ...(t.scenario ? [`Scenario: ${t.scenario}`] : []),
        `Started ${printDateTime(t.startedAt, timeZone)}, finished ${printDateTime(t.completedAt, timeZone)} (${t.durationMinutes} minutes)`,
        `Traced ${t.quantityTraced} of ${t.quantityExpected} ${t.unit}${t.reconciledPercent === null ? "" : ` (${t.reconciledPercent}% reconciled)`}`,
      ],
      result: t.passed ? "Passed" : "FAILED",
      problem: !t.passed,
      doneBy: by("Conducted and recorded by", t.recordedByName),
      note: t.notes ?? null,
      corrects: null,
      replaced: voided,
      ...(voided
        ? {
            replacedNote: `Voided by ${t.voidedByName ?? "—"}${t.voidedAt ? `, ${printDateTime(t.voidedAt, timeZone)}` : ""}${t.voidReason ? `: ${t.voidReason}` : ""}. It no longer counts.`,
          }
        : {}),
      signOff: null,
      followUps: [],
      summary: `${t.reference} on ${printDate(t.conductedOn)}`,
    };
  });
}
