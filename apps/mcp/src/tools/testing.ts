import {
  formatAnalyteLimit,
  specificationParameterCategories,
  testInvestigationStatuses,
  testOutcomes,
  testSampleStatuses,
} from "@knotworking/core";
import { z } from "zod";
import { ToolError, type Api } from "../api";
import type { ToolContext } from "./shared";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSE_NOTE =
  "A failed result opens an investigation and puts an available lot on hold. Closing the investigation, and releasing the lot, are a person's decisions in the Knotworking app; there is no tool for them.";

/**
 * Testing module: samples, results, plans due and trends. Agents may log samples and record
 * laboratory results (a failure holds the lot); closing investigations is a person's.
 */
export function registerTestingTools({ define, slugOf, workspaceParam }: ToolContext) {
  const ws = (api: Api) => api.client.v1.workspaces[":slug"];

  async function resolveItemId(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { items } = await api.call(
      ws(api).items.$get({ param: { slug }, query: { q: wanted, status: "all", limit: "200" } }),
    );
    const match = items.filter((i) => i.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError("not_found", `No item has the code "${wanted}". Use list_items to find it.`);
  }

  async function resolvePointId(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { points } = await api.call(
      ws(api).testing.points.$get({ param: { slug }, query: { status: "all" } }),
    );
    const match = points.filter((p) => p.code.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No sampling point has the code "${wanted}". Known points: ${points.map((p) => p.code).join(", ") || "none"}.`,
    );
  }

  async function resolveLotId(api: Api, slug: string, ref: string, itemId?: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { lots } = await api.call(
      ws(api).stock.lots.$get({
        param: { slug },
        query: { q: wanted, includeEmpty: "true", limit: "200", ...(itemId ? { itemId } : {}) },
      }),
    );
    const match = lots.filter((l) => l.lotCode.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      match.length ? "ambiguous" : "not_found",
      match.length
        ? `Several lots have the code "${wanted}"; pass \`item\` too, or the lot id.`
        : `No lot has the code "${wanted}". Use list_stock_lots to find it.`,
    );
  }

  async function resolveSampleId(api: Api, slug: string, ref: string) {
    const wanted = ref.trim();
    if (UUID.test(wanted)) return wanted;
    const { samples } = await api.call(
      ws(api).testing.samples.$get({ param: { slug }, query: { q: wanted, limit: "200" } }),
    );
    const match = samples.filter((s) => s.reference.toLowerCase() === wanted.toLowerCase());
    if (match.length === 1) return match[0]!.id;
    throw new ToolError(
      "not_found",
      `No sample has the reference "${wanted}". Use list_test_samples to find it.`,
    );
  }

  const fetchSample = (api: Api, slug: string, id: string) =>
    api.call(ws(api).testing.samples[":id"].$get({ param: { slug, id } }));
  type Sample = Awaited<ReturnType<typeof fetchSample>>;
  const sampleView = (s: Sample) => ({
    id: s.id,
    reference: s.reference,
    subject: s.subject,
    lot: s.lot ? { lotCode: s.lot.lotCode, status: s.lot.status } : null,
    item: s.item?.code ?? null,
    samplingPoint: s.samplingPoint
      ? { code: s.samplingPoint.code, name: s.samplingPoint.name, zone: s.samplingPoint.zone }
      : null,
    plan: s.plan?.name ?? null,
    laboratory: s.laboratory?.name ?? null,
    specification: s.specification ? `${s.specification.code} v${s.specification.versionNumber}` : null,
    sampledOn: s.sampledOn,
    sampledBy: s.sampledBy,
    status: s.status,
    outcome: s.outcome,
    lotHeld: s.lotHeld,
    investigation: s.investigationStatus
      ? {
          status: s.investigationStatus,
          findings: s.findings,
          rootCause: s.rootCause,
          actionTaken: s.actionTaken,
          closedBy: s.investigationClosedByName,
        }
      : null,
    results: s.results.map((r) => ({
      resultId: r.id,
      analyte: r.name,
      category: r.category,
      limit: formatAnalyteLimit(r),
      needs: r.min != null || r.max != null ? "value" : "outcome",
      value: r.value,
      valueText: r.valueText,
      outcome: r.outcome,
      reportedOn: r.reportedOn,
      corrections: r.history.length,
    })),
    note: CLOSE_NOTE,
  });

  define(
    "list_test_samples",
    {
      module: "testing",
      resource: { name: "test_samples", op: "list" },
      title: "List test samples",
      description:
        "Test samples, newest first, with what they were taken from (lot or sampling point), laboratory, status (awaiting_results, complete, cancelled), outcome (pending, pass, fail) and investigation state. Filter by `query` (reference, lot, item or point code), `status`, `outcome`, `investigation` (open: failures still to be closed), `item`, `lot`, `sampling_point`, `from`/`to`. Paged.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        query: z.string().max(200).optional(),
        status: z.enum([...testSampleStatuses, "all"]).optional(),
        outcome: z.enum(testOutcomes).optional(),
        investigation: z.enum(testInvestigationStatuses).optional(),
        item: z.string().max(200).optional().describe("Item id or exact code."),
        lot: z.string().max(200).optional().describe("Lot id or exact lot code."),
        sampling_point: z.string().max(200).optional().describe("Sampling point id or exact code."),
        from: z.string().date().optional(),
        to: z.string().date().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      const lotId = a.lot ? await resolveLotId(api, slug, a.lot, itemId) : undefined;
      const samplingPointId = a.sampling_point
        ? await resolvePointId(api, slug, a.sampling_point)
        : undefined;
      const page = await api.call(
        ws(api).testing.samples.$get({
          param: { slug },
          query: {
            ...(a.query ? { q: a.query } : {}),
            ...(a.status ? { status: a.status } : {}),
            ...(a.outcome ? { outcome: a.outcome } : {}),
            ...(a.investigation ? { investigation: a.investigation } : {}),
            ...(itemId ? { itemId } : {}),
            ...(lotId ? { lotId } : {}),
            ...(samplingPointId ? { samplingPointId } : {}),
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
            limit: String(a.limit ?? 50),
            offset: String(a.offset ?? 0),
          },
        }),
      );
      return {
        samples: page.samples.map((s) => ({
          id: s.id,
          reference: s.reference,
          sampledOn: s.sampledOn,
          lot: s.lot?.lotCode ?? null,
          item: s.item?.code ?? null,
          samplingPoint: s.samplingPoint?.code ?? null,
          laboratory: s.laboratoryName,
          status: s.status,
          outcome: s.outcome,
          investigation: s.investigationStatus,
          lotHeld: s.lotHeld,
        })),
        total: page.total,
        returned: page.samples.length,
        hasMore: page.offset + page.samples.length < page.total,
      };
    },
  );

  define(
    "get_test_sample",
    {
      module: "testing",
      resource: { name: "test_samples", op: "get" },
      title: "Get test sample",
      description:
        "One sample by id or reference: what it was taken from, each analyte with its limit, whether it needs a `value` or an `outcome`, the result recorded so far and the investigation. The `resultId`s are what record_test_results takes.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        sample: z.string().min(1).max(200).describe("Sample id or reference, e.g. S-2026-0012."),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      return sampleView(await fetchSample(api, slug, await resolveSampleId(api, slug, a.sample)));
    },
  );

  define(
    "log_test_sample",
    {
      module: "testing",
      title: "Log test sample",
      description:
        "Logs a sample taken from a stock `lot` or a `sampling_point`, on `sampled_on` (not in the future). What it is tested for comes from `analytes` if given, else the `plan` (by name), else, for a lot, the item's approved specification. Returns the sample with its result ids.",
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        lot: z.string().max(200).optional().describe("Lot id or exact lot code."),
        item: z
          .string()
          .max(200)
          .optional()
          .describe("Item id or code, to tell lots with the same code apart."),
        sampling_point: z.string().max(200).optional().describe("Sampling point id or exact code."),
        plan: z.string().max(200).optional().describe("Sampling plan id or exact name."),
        laboratory: z
          .string()
          .max(200)
          .optional()
          .describe("Laboratory id or exact name; default the plan's."),
        sampled_on: z.string().date(),
        sampled_by: z.string().max(200).optional(),
        notes: z.string().max(2000).optional(),
        analytes: z
          .array(
            z.object({
              category: z.enum(specificationParameterCategories),
              name: z.string().min(1).max(120),
              unit: z.string().max(20).optional(),
              min: z.number().optional(),
              max: z.number().optional(),
              limit_text: z.string().max(200).optional().describe('A written limit, e.g. "Not detected".'),
              method: z.string().max(200).optional(),
            }),
          )
          .max(100)
          .optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      if (!a.lot === !a.sampling_point)
        throw new ToolError("invalid_input", "Give either `lot` or `sampling_point`.");
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      let planId: string | undefined;
      if (a.plan) {
        const { plans } = await api.call(
          ws(api).testing.plans.$get({ param: { slug }, query: { status: "active" } }),
        );
        const plan = plans.find(
          (p) => p.id === a.plan || p.name.toLowerCase() === a.plan!.trim().toLowerCase(),
        );
        if (!plan)
          throw new ToolError("not_found", `No active plan "${a.plan}". Use get_testing_due to list plans.`);
        planId = plan.id;
      }
      let laboratoryId: string | undefined;
      if (a.laboratory) {
        const { laboratories } = await api.call(
          ws(api).testing.laboratories.$get({ param: { slug }, query: { status: "active" } }),
        );
        const lab = laboratories.find(
          (l) => l.id === a.laboratory || l.name.toLowerCase() === a.laboratory!.trim().toLowerCase(),
        );
        if (!lab) throw new ToolError("not_found", `No active laboratory "${a.laboratory}".`);
        laboratoryId = lab.id;
      }
      const created = await api.call(
        ws(api).testing.samples.$post({
          param: { slug },
          json: {
            subject: a.lot ? "lot" : "point",
            ...(a.lot ? { lotId: await resolveLotId(api, slug, a.lot, itemId) } : {}),
            ...(a.sampling_point
              ? { samplingPointId: await resolvePointId(api, slug, a.sampling_point) }
              : {}),
            ...(planId ? { planId } : {}),
            ...(laboratoryId ? { laboratoryId } : {}),
            sampledOn: a.sampled_on,
            ...(a.sampled_by ? { sampledBy: a.sampled_by } : {}),
            ...(a.notes ? { notes: a.notes } : {}),
            ...(a.analytes
              ? {
                  analytes: a.analytes.map((x) => ({
                    category: x.category,
                    name: x.name,
                    unit: x.unit ?? null,
                    min: x.min ?? null,
                    max: x.max ?? null,
                    limitText: x.limit_text ?? null,
                    method: x.method ?? null,
                  })),
                }
              : {}),
          },
        }),
      );
      return sampleView(created);
    },
  );

  define(
    "record_test_results",
    {
      module: "testing",
      title: "Record test results",
      description: `Records results from a laboratory report against a sample's analytes (\`result_id\` from get_test_sample). A numeric limit needs \`value\`; a written limit needs \`outcome\` (pass or fail); \`value_text\` keeps what the report said ("<10", "Not detected"). Re-recording a result needs \`correction_reason\` and keeps the old value. ${CLOSE_NOTE}`,
      annotations: CREATE,
      input: {
        workspace: workspaceParam,
        sample: z.string().min(1).max(200).describe("Sample id or reference."),
        reported_on: z.string().date().describe("The report's date."),
        report_reference: z.string().max(200).optional(),
        results: z
          .array(
            z.object({
              result_id: z.string().uuid(),
              value: z.number().optional(),
              value_text: z.string().max(200).optional(),
              outcome: z.enum(["pass", "fail"]).optional(),
              correction_reason: z.string().max(500).optional(),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const id = await resolveSampleId(api, slug, a.sample);
      const saved = await api.call(
        ws(api).testing.samples[":id"].results.$post({
          param: { slug, id },
          json: {
            reportedOn: a.reported_on,
            ...(a.report_reference ? { reportReference: a.report_reference } : {}),
            results: a.results.map((r) => ({
              resultId: r.result_id,
              ...(r.value !== undefined ? { value: r.value } : {}),
              ...(r.value_text !== undefined ? { valueText: r.value_text } : {}),
              ...(r.outcome ? { outcome: r.outcome } : {}),
              ...(r.correction_reason ? { correctionReason: r.correction_reason } : {}),
            })),
          },
        }),
      );
      return sampleView(saved);
    },
  );

  define(
    "get_testing_due",
    {
      module: "testing",
      title: "Get testing due",
      description:
        "Active sampling plans with when each is next due (frequency days after the last sample taken under it), state (overdue, due, due_soon, ok), what is sampled, the analytes and the risk rationale. Soonest first.",
      annotations: READ,
      input: { workspace: workspaceParam },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const { plans, today } = await api.call(
        ws(api).testing.plans.$get({ param: { slug }, query: { status: "active" } }),
      );
      return {
        today,
        plans: plans.map((p) => ({
          id: p.id,
          name: p.name,
          subject: p.subject,
          item: p.item?.code ?? null,
          samplingPoint: p.samplingPoint ? { code: p.samplingPoint.code, zone: p.samplingPoint.zone } : null,
          frequencyDays: p.frequencyDays,
          laboratory: p.laboratoryName,
          lastSampledOn: p.lastSampledOn,
          nextDueOn: p.nextDueOn,
          state: p.state,
          analytes: p.analytes.length ? p.analytes.map((x) => x.name) : "the item's approved specification",
          rationale: p.rationale,
        })),
      };
    },
  );

  define(
    "get_test_trend",
    {
      module: "testing",
      title: "Get test trend",
      description:
        "One analyte's results over time (cancelled samples left out) with totals: results, fails, fail rate, mean, min, max, latest. Narrow to an `item`, a `sampling_point` or a `zone` (one of them), and `from`/`to`.",
      annotations: READ,
      input: {
        workspace: workspaceParam,
        analyte: z
          .string()
          .min(1)
          .max(120)
          .describe('Analyte name, e.g. "Listeria spp." (case-insensitive).'),
        item: z.string().max(200).optional(),
        sampling_point: z.string().max(200).optional(),
        zone: z.string().max(100).optional(),
        from: z.string().date().optional(),
        to: z.string().date().optional(),
      },
    },
    async (a, api) => {
      const slug = await slugOf(api, a.workspace);
      const itemId = a.item ? await resolveItemId(api, slug, a.item) : undefined;
      const samplingPointId = a.sampling_point
        ? await resolvePointId(api, slug, a.sampling_point)
        : undefined;
      const trend = await api.call(
        ws(api).testing.trends.$get({
          param: { slug },
          query: {
            analyte: a.analyte,
            ...(itemId ? { itemId } : {}),
            ...(samplingPointId ? { samplingPointId } : {}),
            ...(a.zone ? { zone: a.zone } : {}),
            ...(a.from ? { from: a.from } : {}),
            ...(a.to ? { to: a.to } : {}),
          },
        }),
      );
      return {
        analyte: trend.analyte,
        summary: trend.summary,
        points: trend.points.map((p) => ({
          reference: p.reference,
          sampledOn: p.sampledOn,
          source: p.lotCode ?? p.pointCode,
          value: p.value,
          valueText: p.valueText,
          outcome: p.outcome,
        })),
        truncated: trend.truncated,
      };
    },
  );
}
