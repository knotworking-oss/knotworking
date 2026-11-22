import { z } from "zod";
import type { ModuleId } from "./modules";

/**
 * Evidence-based QA release (Phase 3, milestone 3.2.3). Releasing a lot (setting it `available`)
 * is checked against the evidence other modules hold, and against the item's release rule:
 *
 * - **Always** (when Testing is active): no sample on the lot awaiting results; no failed sample
 *   with its investigation open; no failed sample left unresolved (its investigation closed and a
 *   later complete, passing sample covering the failed analytes clears it).
 * - **By rule** (per item, versioned): a complete passing sample covering the required analytes;
 *   an approved specification for the item; every CCP log of the batches that made the lot
 *   reviewed and approved, with no open corrective action.
 * - **Shown, never blocking**: out-of-limit CCP readings that were corrected and reviewed, and
 *   packing checks (not recorded until milestone 3.5).
 *
 * A blocked release can still be made as an authorised exception, by two people with stock
 * `manage`: one requests it with the reason and the evidence, another approves it (which releases
 * the lot). Every release keeps the checks and the rule version used.
 * The rules here are pure; the server gathers the facts. No DOM or Node APIs.
 */

// ─── Rules ───────────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();

export const lotReleaseRuleInputSchema = z
  .object({
    /** A complete, passing test sample on the lot is needed before release. */
    requirePassingTest: z.boolean().default(false),
    /** Analytes that passing sample must cover (case-insensitive); empty: any passing sample. */
    requiredAnalytes: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    /** The item must have an approved specification. */
    requireApprovedSpecification: z.boolean().default(false),
    /** For a lot made in production: its batches' CCP logs reviewed, no corrective action open. */
    requireCcpReviewed: z.boolean().default(false),
    /** Why the rule is what it is (the product's risk, a customer's requirement). */
    note: optionalText(2000).optional(),
  })
  .refine((r) => r.requiredAnalytes.length === 0 || r.requirePassingTest, {
    message: "Required analytes only apply when a passing test is required",
    path: ["requiredAnalytes"],
  })
  .refine((r) => new Set(r.requiredAnalytes.map((a) => a.toLowerCase())).size === r.requiredAnalytes.length, {
    message: "Each analyte may appear once",
    path: ["requiredAnalytes"],
  });
export type LotReleaseRuleInput = z.infer<typeof lotReleaseRuleInputSchema>;

export interface LotReleaseRule {
  requirePassingTest: boolean;
  requiredAnalytes: readonly string[];
  requireApprovedSpecification: boolean;
  requireCcpReviewed: boolean;
  note: string | null;
  /** 1, 2, … per item: each change is a new version, recorded with the releases made under it. */
  version: number;
}

/** A release exception: why the lot is released despite what blocks it, and the evidence. */
export const lotReleaseExceptionSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  evidence: z.string().trim().min(1).max(2000),
});
export type LotReleaseException = z.infer<typeof lotReleaseExceptionSchema>;

/** Asking for a blocked lot to be released as an exception: the release note, reason and evidence. */
export const lotReleaseExceptionRequestSchema = lotReleaseExceptionSchema.extend({
  note: z.string().trim().min(1).max(2000),
});
export type LotReleaseExceptionRequestInput = z.infer<typeof lotReleaseExceptionRequestSchema>;

/** Approving releases the lot; rejecting (or withdrawing your own request) needs a reason. */
export const lotReleaseExceptionApproveSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});
export const lotReleaseExceptionRejectSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

/**
 * Four-eyes on release exceptions: whoever requested one can't approve it, unless nobody else has
 * stock `manage` (a one-manager site can still release by exception, and the record says so).
 */
export function canApproveReleaseException(input: {
  requestedBy: string | null;
  deciderId: string;
  managerIds: readonly string[];
}): { allowed: boolean; selfApproved: boolean } {
  if (input.requestedBy !== input.deciderId) return { allowed: true, selfApproved: false };
  const alone = input.managerIds.every((id) => id === input.deciderId);
  return { allowed: alone, selfApproved: alone };
}

/**
 * Whether the blockers now are covered by those an exception was requested against: the same rule
 * version, and every blocker now was shown then, down to the records it names. A new blocker, or a
 * new sample, record or reading under an existing kind (a second failed test, another open
 * corrective action), isn't covered; a blocker that names no records must read the same. Fewer
 * blockers, or fewer records under one, are fine.
 */
export function exceptionCovers(
  requested: { ruleVersion: number | null; checks: readonly CoverableCheck[] },
  now: { ruleVersion: number | null; checks: readonly CoverableCheck[] },
): boolean {
  if (requested.ruleVersion !== now.ruleVersion) return false;
  const asked = new Map(requested.checks.filter((c) => c.status === "block").map((c) => [c.kind, c]));
  return now.checks
    .filter((c) => c.status === "block")
    .every((c) => {
      const then = asked.get(c.kind);
      if (!then) return false;
      const refs = c.refs ?? [];
      if (refs.length === 0) return (then.refs ?? []).length === 0 && then.detail === c.detail;
      const shown = new Set((then.refs ?? []).map((r) => r.id));
      return refs.every((r) => shown.has(r.id));
    });
}

/** The parts of a release check that `exceptionCovers` compares. */
export interface CoverableCheck {
  kind: string;
  status: string;
  detail?: string;
  refs?: readonly { id: string }[];
}

// ─── Facts ───────────────────────────────────────────────────────────────────

export interface ReleaseSampleFact {
  id: string;
  reference: string;
  sampledOn: string;
  status: "awaiting_results" | "complete" | "cancelled";
  outcome: "pending" | "pass" | "fail";
  investigationStatus: "open" | "closed" | null;
  /** Each analyte and its outcome. */
  results: readonly { name: string; outcome: "pending" | "pass" | "fail" }[];
}

export interface ReleaseCcpLogFact {
  id: string;
  ccpCode: string;
  batchCode: string;
  checkedAt: string;
  withinLimits: boolean;
  reviewStatus: "pending" | "approved" | "rejected";
}

export interface ReleaseFacts {
  /** Which modules are active on the server (a rule needing an inactive one blocks). */
  active: readonly ModuleId[];
  rule: LotReleaseRule | null;
  /** Testing: the lot's samples (cancelled ones included; they are ignored). */
  samples: readonly ReleaseSampleFact[];
  /** Specifications: the item's approved specification, if any. */
  approvedSpecification: { id: string; code: string; versionNumber: number } | null;
  /** Production: the batches whose output is this lot. */
  batches: readonly { id: string; batchCode: string }[];
  /** HACCP: those batches' current CCP logs (corrected logs left out). */
  ccpLogs: readonly ReleaseCcpLogFact[];
  /** HACCP: open corrective actions on those batches or their logs. */
  openCorrectiveActions: readonly { id: string; batchCode: string | null; title: string }[];
}

// ─── Checks ──────────────────────────────────────────────────────────────────

export type ReleaseCheckKind =
  | "tests_pending"
  | "investigation_open"
  | "test_failed"
  | "required_test"
  | "specification"
  | "ccp_review"
  | "corrective_actions"
  | "deviations"
  | "packing_checks";

export interface ReleaseCheckRef {
  id: string;
  label: string;
}

export interface ReleaseCheck {
  kind: ReleaseCheckKind;
  /** `block` stops a release (unless made as an exception); `pass` is met; `info` is for the record. */
  status: "pass" | "block" | "info";
  /** The module whose records the check reads. */
  module: ModuleId;
  label: string;
  detail: string;
  refs: ReleaseCheckRef[];
  /** True when the check comes from the item's release rule rather than always applying. */
  fromRule: boolean;
}

export interface ReleaseEvaluation {
  checks: ReleaseCheck[];
  blocked: boolean;
  /** The rule version evaluated, or null when the item has no rule. */
  ruleVersion: number | null;
}

const sampleRef = (s: ReleaseSampleFact): ReleaseCheckRef => ({ id: s.id, label: s.reference });
const lower = (s: string) => s.trim().toLowerCase();
const covers = (sample: ReleaseSampleFact, analytes: readonly string[]) => {
  const passed = new Set(sample.results.filter((r) => r.outcome === "pass").map((r) => lower(r.name)));
  return analytes.every((a) => passed.has(lower(a)));
};
const passingComplete = (s: ReleaseSampleFact) => s.status === "complete" && s.outcome === "pass";

/** Checks a lot's release against the facts gathered for it. */
export function evaluateLotRelease(facts: ReleaseFacts): ReleaseEvaluation {
  const checks: ReleaseCheck[] = [];
  const rule = facts.rule;
  const testing = facts.active.includes("testing");
  const samples = facts.samples.filter((s) => s.status !== "cancelled");

  if (testing) {
    const pending = samples.filter((s) => s.status === "awaiting_results" && s.outcome !== "fail");
    checks.push({
      kind: "tests_pending",
      status: pending.length ? "block" : "pass",
      module: "testing",
      label: "No test results outstanding",
      detail: pending.length
        ? `${pending.length} sample${pending.length === 1 ? " is" : "s are"} awaiting results`
        : "No sample on this lot is awaiting results",
      refs: pending.map(sampleRef),
      fromRule: false,
    });
    const failed = samples.filter((s) => s.outcome === "fail");
    const open = failed.filter((s) => s.investigationStatus === "open");
    checks.push({
      kind: "investigation_open",
      status: open.length ? "block" : "pass",
      module: "testing",
      label: "No open test investigation",
      detail: open.length
        ? `${open.length} failed sample${open.length === 1 ? " has" : "s have"} an open investigation`
        : "No failed sample on this lot is still being investigated",
      refs: open.map(sampleRef),
      fromRule: false,
    });
    // A failure investigated and closed is resolved by a later complete, passing retest.
    const unresolved = failed.filter((s) => {
      if (s.investigationStatus === "open") return false;
      const failedNames = s.results.filter((r) => r.outcome === "fail").map((r) => r.name);
      return !samples.some(
        (r) => r.id !== s.id && passingComplete(r) && r.sampledOn >= s.sampledOn && covers(r, failedNames),
      );
    });
    checks.push({
      kind: "test_failed",
      status: unresolved.length ? "block" : "pass",
      module: "testing",
      label: "No unresolved failed result",
      detail: unresolved.length
        ? `${unresolved.length} failed sample${unresolved.length === 1 ? " has" : "s have"} no passing retest`
        : failed.length
          ? "Every failed sample was investigated and passed a retest"
          : "No failed sample on this lot",
      refs: unresolved.map(sampleRef),
      fromRule: false,
    });
  }

  if (rule?.requirePassingTest) {
    const passing = samples.filter((s) => passingComplete(s) && covers(s, rule.requiredAnalytes));
    const what = rule.requiredAnalytes.length ? ` covering ${rule.requiredAnalytes.join(", ")}` : "";
    checks.push({
      kind: "required_test",
      status: !testing || passing.length === 0 ? "block" : "pass",
      module: "testing",
      label: `A passing test${what}`,
      detail: !testing
        ? "The release rule needs a passing test, but the Testing module is switched off"
        : passing.length
          ? `Passed: ${passing.map((s) => s.reference).join(", ")}`
          : `No complete, passing sample${what} yet`,
      refs: passing.map(sampleRef),
      fromRule: true,
    });
  }

  if (rule?.requireApprovedSpecification) {
    const specs = facts.active.includes("specifications");
    const spec = facts.approvedSpecification;
    checks.push({
      kind: "specification",
      status: specs && spec ? "pass" : "block",
      module: "specifications",
      label: "An approved specification",
      detail: !specs
        ? "The release rule needs an approved specification, but the Specifications module is switched off"
        : spec
          ? "The item's specification is approved"
          : "The item has no approved specification",
      refs: spec ? [{ id: spec.id, label: `${spec.code} v${spec.versionNumber}` }] : [],
      fromRule: true,
    });
  }

  const haccp = facts.active.includes("haccp");
  if (rule?.requireCcpReviewed) {
    if (!haccp) {
      checks.push({
        kind: "ccp_review",
        status: "block",
        module: "haccp",
        label: "CCP monitoring reviewed",
        detail: "The release rule needs CCP reviews, but the Food safety records module is switched off",
        refs: [],
        fromRule: true,
      });
    } else if (facts.batches.length === 0) {
      checks.push({
        kind: "ccp_review",
        status: "info",
        module: "haccp",
        label: "CCP monitoring reviewed",
        detail: "This lot wasn't made in a production batch, so it has no CCP monitoring",
        refs: [],
        fromRule: true,
      });
    } else {
      const unreviewed = facts.ccpLogs.filter((l) => l.reviewStatus !== "approved");
      checks.push({
        kind: "ccp_review",
        status: unreviewed.length ? "block" : "pass",
        module: "haccp",
        label: "CCP monitoring reviewed",
        detail: unreviewed.length
          ? `${unreviewed.length} CCP reading${unreviewed.length === 1 ? " is" : "s are"} not approved (${unreviewed.filter((l) => l.reviewStatus === "rejected").length} rejected)`
          : facts.ccpLogs.length
            ? `All ${facts.ccpLogs.length} CCP readings for ${facts.batches.map((b) => b.batchCode).join(", ")} are approved`
            : `No CCP readings were recorded for ${facts.batches.map((b) => b.batchCode).join(", ")}`,
        refs: unreviewed.map((l) => ({ id: l.id, label: `${l.batchCode} ${l.ccpCode}` })),
        fromRule: true,
      });
      checks.push({
        kind: "corrective_actions",
        status: facts.openCorrectiveActions.length ? "block" : "pass",
        module: "haccp",
        label: "No open corrective action",
        detail: facts.openCorrectiveActions.length
          ? `${facts.openCorrectiveActions.length} corrective action${facts.openCorrectiveActions.length === 1 ? " is" : "s are"} open on the batch`
          : "No corrective action is open on the batch",
        refs: facts.openCorrectiveActions.map((a) => ({ id: a.id, label: a.title })),
        fromRule: true,
      });
    }
  }

  if (haccp && facts.batches.length) {
    const deviations = facts.ccpLogs.filter((l) => !l.withinLimits);
    if (deviations.length) {
      checks.push({
        kind: "deviations",
        status: "info",
        module: "haccp",
        label: "CCP deviations during production",
        detail: `${deviations.length} reading${deviations.length === 1 ? " was" : "s were"} out of limits; check they were handled before releasing`,
        refs: deviations.map((l) => ({ id: l.id, label: `${l.batchCode} ${l.ccpCode}` })),
        fromRule: false,
      });
    }
  }

  checks.push({
    kind: "packing_checks",
    status: "info",
    module: "stock",
    label: "Packing checks",
    detail: "Label, date code and weight checks aren't recorded in Knotworking yet",
    refs: [],
    fromRule: false,
  });

  return { checks, blocked: checks.some((c) => c.status === "block"), ruleVersion: rule?.version ?? null };
}

/** The checks that stop a release, in words, for an error message. */
export const releaseBlockers = (evaluation: ReleaseEvaluation) =>
  evaluation.checks.filter((c) => c.status === "block").map((c) => `${c.label}: ${c.detail}`);
