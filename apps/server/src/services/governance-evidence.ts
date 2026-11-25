import {
  addMonthsIso,
  authenticityListQuerySchema,
  evidenceCheckIds,
  evidenceChecks,
  type EvidenceCheckId,
  type EvidenceCheckResult,
  type ModuleId,
} from "@knotworking/core";
import { sops, sopVersions, specifications, specificationVersions, type Database } from "@knotworking/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { listAuthenticity } from "./authenticity";
import { defenceOverview } from "./defence";
import { listRequirements, listReviews } from "./governance";
import { getDue, plansWithHazardReviewDue } from "./haccp";
import { trainingDue } from "./ports/training";
import { qualitySummary } from "./quality";
import { listOutstandingAcknowledgements } from "./sops";
import { listSupplierCompliance } from "./supplier-controls";

/**
 * Evidence checks (G2): each reads the live records of its modules through that module's own read
 * models, so a check means what the module's own overview means. A check whose module is off, or
 * that the reader can't read, is `unavailable` and reveals nothing. Definitions in
 * `@knotworking/core` governance-standards.ts.
 */

export interface EvidenceAccess {
  active: readonly ModuleId[];
  readable: (m: ModuleId) => boolean;
}

const MAX_ITEMS = 10;
type Partial = Omit<EvidenceCheckResult, "id" | "label">;
const met = (detail: string, items: EvidenceCheckResult["items"] = []): Partial => ({
  status: "met",
  detail,
  items,
});
const gap = (detail: string, items: EvidenceCheckResult["items"]): Partial => ({
  status: "gap",
  detail,
  items: items.slice(0, MAX_ITEMS),
});
const noData = (detail: string): Partial => ({ status: "no_data", detail, items: [] });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One evaluation's shared reads: the quality summary feeds three checks. */
interface Run {
  access: EvidenceAccess;
  quality: () => ReturnType<typeof qualitySummary>;
}
type Evaluator = (db: Database, ws: string, today: string, run: Run) => Promise<Partial>;

const evaluators: Record<EvidenceCheckId, Evaluator> = {
  async traceability_test(_db, _ws, _today, run) {
    const { recallTest } = await run.quality();
    if (recallTest.state === "never") return gap("No passing traceability test on record", []);
    const last = {
      label: `Passed ${recallTest.lastPassed!.conductedOn}`,
      detail: `next due ${recallTest.dueOn}`,
    };
    return recallTest.state === "overdue"
      ? gap(`The last passing traceability test was over a year ago (due ${recallTest.dueOn})`, [last])
      : met(`Passed ${recallTest.lastPassed!.conductedOn}; next due ${recallTest.dueOn}`, [last]);
  },
  async internal_audits(_db, _ws, _today, run) {
    const { audits } = await run.quality();
    if (audits.overdue > 0) return gap(`${plural(audits.overdue, "audit")} past the planned date`, []);
    if (audits.completedLast12Months === 0)
      return audits.next
        ? gap("No internal audit completed in the last 12 months", [
            { label: `Next: ${audits.next.title}`, detail: audits.next.plannedOn },
          ])
        : noData("No internal audits planned or completed");
    return met(
      `${plural(audits.completedLast12Months, "audit")} completed in the last 12 months; none overdue`,
    );
  },
  async nonconformances_overdue(_db, _ws, _today, run) {
    const { nonconformances } = await run.quality();
    return nonconformances.overdue > 0
      ? gap(`${plural(nonconformances.overdue, "non-conformance")} open past the due date`, [])
      : met(`${plural(nonconformances.open, "open non-conformance")}, none overdue`);
  },
  async haccp_plan_review(db, ws, today) {
    const due = await plansWithHazardReviewDue(db, ws, today);
    return due.length
      ? gap(
          `${plural(due.length, "HACCP plan")} with the hazard analysis review due`,
          due.map((p) => ({ label: `${p.code} ${p.name}` })),
        )
      : met("Every current HACCP plan's review is in date");
  },
  async ccp_monitoring(db, ws, _today, run) {
    return dueChecks(db, ws, "ccp", "CCP check", "No CCPs on a schedule", run.access.readable("production"));
  },
  async cleaning_schedule(db, ws) {
    return dueChecks(db, ws, "cleaning", "cleaning", "Nothing on the cleaning schedule");
  },
  async calibration(db, ws) {
    return dueChecks(db, ws, "calibration", "calibration", "No equipment on the calibration schedule");
  },
  async sop_reviews(db, ws, today) {
    // The latest approved version of each active SOP, and whether its review date has passed.
    const rows = await db
      .selectDistinctOn([sopVersions.sopId], {
        sopId: sopVersions.sopId,
        code: sops.code,
        title: sops.title,
        reviewDueOn: sopVersions.reviewDueOn,
      })
      .from(sopVersions)
      .innerJoin(sops, eq(sops.id, sopVersions.sopId))
      .where(
        and(
          eq(sopVersions.workspaceId, ws),
          eq(sopVersions.status, "approved"),
          isNull(sopVersions.deletedAt),
          eq(sops.status, "active"),
          isNull(sops.deletedAt),
        ),
      )
      .orderBy(sopVersions.sopId, sql`${sopVersions.versionNumber} desc`);
    if (!rows.length) return noData("No approved SOPs");
    const overdue = rows.filter((r) => r.reviewDueOn && r.reviewDueOn < today);
    return overdue.length
      ? gap(
          `${plural(overdue.length, "SOP")} past the review date`,
          overdue.map((r) => ({ label: `${r.code} ${r.title}`, detail: `review due ${r.reviewDueOn}` })),
        )
      : met(`${plural(rows.length, "approved SOP")}, all reviewed on time`);
  },
  async sop_acknowledgements(db, ws, _today, { access }) {
    // Counts per SOP only: who hasn't acknowledged is for SOP managers (`GET /sops/outstanding`),
    // and this check shows to anyone who can read SOPs.
    const { items } = await listOutstandingAcknowledgements(db, ws, access.active);
    const bySop = new Map<string, { label: string; count: number; oldest: number }>();
    for (const i of items) {
      const key = `${i.code} ${i.title}`;
      const row = bySop.get(key) ?? { label: key, count: 0, oldest: 0 };
      row.count += 1;
      row.oldest = Math.max(row.oldest, i.daysOutstanding);
      bySop.set(key, row);
    }
    const sopsDue = [...bySop.values()].sort((a, b) => b.oldest - a.oldest);
    return items.length
      ? gap(
          `${plural(items.length, "acknowledgement")} outstanding across ${plural(sopsDue.length, "SOP")}`,
          sopsDue.map((r) => ({
            label: r.label,
            detail: `${plural(r.count, "person", "people")}, oldest ${r.oldest} days`,
          })),
        )
      : met("Everyone in each SOP's audience has acknowledged its current version");
  },
  async specification_reviews(db, ws, today) {
    const rows = await db
      .select({
        code: specifications.code,
        title: specifications.title,
        reviewDueOn: specificationVersions.reviewDueOn,
      })
      .from(specificationVersions)
      .innerJoin(specifications, eq(specifications.id, specificationVersions.specificationId))
      .where(
        and(
          eq(specificationVersions.workspaceId, ws),
          eq(specificationVersions.status, "approved"),
          isNull(specificationVersions.deletedAt),
          eq(specifications.status, "active"),
          isNull(specifications.deletedAt),
        ),
      );
    if (!rows.length) return noData("No approved specifications");
    const overdue = rows.filter((r) => r.reviewDueOn && r.reviewDueOn < today);
    return overdue.length
      ? gap(
          `${plural(overdue.length, "specification")} past the review date`,
          overdue.map((r) => ({ label: `${r.code} ${r.title}`, detail: `review due ${r.reviewDueOn}` })),
        )
      : met(`${plural(rows.length, "approved specification")}, all reviewed on time`);
  },
  async supplier_controls(db, ws, today, { access }) {
    const { suppliers } = await listSupplierCompliance(db, ws, access.active, today);
    const approved = suppliers.filter((s) => s.approvalStatus === "approved");
    if (!approved.length) return noData("No approved suppliers");
    const issues = approved.filter((s) => s.actionCount > 0);
    return issues.length
      ? gap(
          `${plural(issues.length, "approved supplier")} with control issues to act on`,
          issues.map((s) => ({ label: s.name, detail: plural(s.actionCount, "issue") })),
        )
      : met(`${plural(approved.length, "approved supplier")}, controls current`);
  },
  async training_competence(db, ws, today) {
    const { items } = await trainingDue(db, ws, { withinDays: 0 }, today);
    // Outdated (trained on an earlier SOP version) is a gap; awaiting sign-off is not yet one.
    const missing = items.filter(
      (i) => i.status === "missing" || i.status === "expired" || i.status === "outdated",
    );
    return missing.length
      ? gap(
          `${plural(missing.length, "required training record")} missing, expired or outdated`,
          missing.map((i) => ({
            label: `${i.staff.firstName} ${i.staff.lastName}`,
            detail: `${i.course.title}: ${i.status}`,
          })),
        )
      : met("Required training current for everyone");
  },
  async food_defence(db, ws, today) {
    const o = await defenceOverview(db, ws, today, { visitors: false });
    if (!o.counts.assessments) return noData("No food defence assessment");
    const items = [
      ...o.assessmentsDue.map((a) => ({ label: a.title, detail: "assessment review due" })),
      ...o.controlsDue
        .filter((c) => c.dueStatus === "overdue" || c.dueStatus === "never")
        .map((c) => ({ label: c.name, detail: "control check overdue" })),
    ];
    return items.length
      ? gap(
          `${plural(o.assessmentsDue.length, "assessment")} due for review, ${plural(o.counts.overdueControls, "control")} overdue`,
          items,
        )
      : met("Food defence assessment in date and controls checked on time");
  },
  async food_fraud(db, ws) {
    // Page through the whole active register (the list caps a page at 100).
    const assessments: Awaited<ReturnType<typeof listAuthenticity>>["assessments"] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const page = await listAuthenticity(
        db,
        ws,
        authenticityListQuerySchema.parse({ state: "active", limit: 100, offset }),
      );
      assessments.push(...page.assessments);
      if (page.assessments.length < 100 || assessments.length >= page.total) break;
    }
    if (!assessments.length) return noData("No food fraud vulnerability assessment");
    const due = assessments.filter((a) => !a.currentVersionId || a.needsReview);
    return due.length
      ? gap(
          `${plural(due.length, "vulnerability assessment")} not approved or due for review`,
          due.map((a) => ({
            label: `${a.reference} ${a.title}`,
            detail: a.currentVersionId ? `review due ${a.reviewDueOn ?? "now"}` : "not approved",
          })),
        )
      : met(`${plural(assessments.length, "vulnerability assessment")}, all approved and in date`);
  },
  async management_review(db, ws, today) {
    const { reviews } = await listReviews(db, ws);
    const signed = reviews.filter((r) => r.status === "signed" && r.signedAt);
    if (!signed.length) return gap("No signed management review", []);
    const last = signed
      .map((r) => new Date(r.signedAt!).toISOString().slice(0, 10))
      .sort()
      .at(-1)!;
    const item = [{ label: `Last signed ${last}` }];
    return last < addMonthsIso(today, -12)
      ? gap(`The last signed management review was over a year ago (${last})`, item)
      : met(`Management review signed ${last}`, item);
  },
  async requirements_register(db, ws, today) {
    const { requirements } = await listRequirements(db, ws, today);
    const active = requirements.filter((r) => r.status === "active");
    if (!active.length) return noData("Nothing on the requirement register");
    const due = active.filter(
      (r) =>
        r.compliance === "non_compliant" || r.compliance === "not_assessed" || r.reviewStatus === "overdue",
    );
    return due.length
      ? gap(
          `${plural(due.length, "requirement")} not compliant, never assessed or past review`,
          due.map((r) => ({
            label: r.reference ? `${r.reference} ${r.title}` : r.title,
            detail: r.compliance,
          })),
        )
      : met(`${plural(active.length, "requirement")}, all compliant and reviewed on time`);
  },
};

async function dueChecks(
  db: Database,
  ws: string,
  kind: "ccp" | "cleaning" | "calibration",
  what: string,
  none: string,
  /** Per-batch CCPs count only for readers of Production (a soft dependency of HACCP). */
  batches = true,
) {
  const all = await getDue(db, ws, { include: "all", kind }, new Date(), { batches });
  if (!all.checks.length) return noData(none);
  // Never done is a gap too (getDue calls it "due"), except a per-batch CCP on a batch still in
  // progress: that one is simply due on today's batch.
  const overdue = all.checks.filter(
    (c) => c.state === "overdue" || (c.lastAt === null && !(c.kind === "ccp" && c.batch)),
  );
  return overdue.length
    ? gap(
        `${plural(overdue.length, what)} overdue or never done`,
        overdue.map((c) => ({
          label: c.label,
          detail: c.lastAt ? `last ${c.lastAt.slice(0, 10)}` : "never done",
        })),
      )
    : met(
        `${plural(all.checks.length, `${what} on the schedule`, `${what}s on the schedule`)}, none overdue`,
      );
}

/**
 * Runs the checks asked for (default: all), each only when every one of its modules is on and
 * readable. A check that fails to run reports `no_data` with the reason rather than failing the
 * whole analysis.
 */
export async function evaluateEvidenceChecks(
  db: Database,
  ws: string,
  today: string,
  access: EvidenceAccess,
  only: readonly EvidenceCheckId[] = evidenceCheckIds,
): Promise<Map<EvidenceCheckId, EvidenceCheckResult>> {
  let quality: ReturnType<typeof qualitySummary> | undefined;
  const run: Run = { access, quality: () => (quality ??= qualitySummary(db, ws, today)) };
  const ids = [...new Set(only)];
  const results = await Promise.all(
    ids.map(async (id): Promise<EvidenceCheckResult> => {
      const def = evidenceChecks[id];
      const head = { id, label: def.label };
      const usable = def.modules.every((m) => access.active.includes(m) && access.readable(m));
      if (!usable)
        return {
          ...head,
          status: "unavailable",
          detail: `Needs read access to ${def.modules.join(" and ")}`,
          items: [],
        };
      try {
        return { ...head, ...(await evaluators[id](db, ws, today, run)) };
      } catch (err) {
        // The reason goes to the log, not to readers (or the CSV and agents).
        console.error(`evidence check ${id} failed`, err);
        return { ...head, status: "no_data", detail: "Couldn't be checked", items: [] };
      }
    }),
  );
  return new Map(results.map((r) => [r.id, r]));
}
