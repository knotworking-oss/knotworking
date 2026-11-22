import {
  judgeResult,
  newId,
  sampleOutcome,
  summarizeTrend,
  testPlanDue,
  testResultsRecordSchema,
  testSampleCreateSchema,
  TestJudgeError,
} from "@knotworking/core";
import type { Hono } from "hono";

/**
 * In-memory stand-in for the Testing module's routes (apps/server/src/routes/testing.ts). Lot
 * samples take their analytes from the request or plan only (no specification lookup); a failure
 * holds an available lot, as the real one does.
 */
export function mountFakeTesting(
  app: Hono,
  ws: string,
  deps: { items: Record<string, any>[]; lots: Record<string, any>[] },
) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const today = "2026-01-05";
  const laboratories = [{ id: newId(), name: "Micro Labs", accreditation: "UKAS 0001", status: "active" }];
  const points = [
    {
      id: newId(),
      code: "HC-Z1-01",
      name: "Slicer blade",
      kind: "environmental",
      zone: "High care zone 1",
      status: "active",
    },
  ];
  const listeria = {
    category: "microbiological",
    name: "Listeria spp.",
    unit: null,
    min: null,
    max: null,
    limitText: "Not detected",
    method: null,
  };
  const plans = [
    {
      id: newId(),
      name: "Weekly Listeria swab",
      subject: "point",
      itemId: null,
      samplingPointId: points[0]!.id,
      frequencyDays: 7,
      rationale: "Zone 1 food contact",
      laboratoryId: laboratories[0]!.id,
      analytes: [listeria],
      startedOn: "2026-01-01",
      status: "active",
    },
  ];
  const samples: Record<string, any>[] = [];

  const view = (s: Record<string, any>) => {
    const lot = deps.lots.find((l) => l.id === s.lotId);
    const item = deps.items.find((i) => i.id === s.itemId);
    const point = points.find((p) => p.id === s.samplingPointId);
    return {
      ...s,
      lot: lot ? { id: lot.id, lotCode: lot.lotCode, status: lot.status, expiresOn: null } : null,
      item: item ? { id: item.id, code: item.code, name: item.name } : null,
      samplingPoint: point ?? null,
      plan: plans.find((p) => p.id === s.planId) ?? null,
      laboratory: laboratories.find((l) => l.id === s.laboratoryId) ?? null,
      specification: null,
      investigationClosedByName: null,
    };
  };

  app.get(`${ws}/testing/laboratories`, (c) => c.json({ laboratories }));
  app.get(`${ws}/testing/points`, (c) => c.json({ points }));
  app.get(`${ws}/testing/plans`, (c) =>
    c.json({
      today,
      plans: plans.map((p) => {
        const last =
          samples
            .filter((s) => s.planId === p.id && s.status !== "cancelled")
            .map((s) => s.sampledOn as string)
            .sort()
            .at(-1) ?? null;
        return {
          ...p,
          item: null,
          samplingPoint: points.find((x) => x.id === p.samplingPointId) ?? null,
          laboratoryName: laboratories.find((l) => l.id === p.laboratoryId)?.name ?? null,
          lastSampledOn: last,
          ...testPlanDue({
            lastSampledOn: last,
            frequencyDays: p.frequencyDays,
            startedOn: p.startedOn,
            today,
          }),
        };
      }),
    }),
  );

  app.get(`${ws}/testing/samples`, (c) => {
    const q = c.req.query();
    const rows = samples
      .filter((s) => !q.q || s.reference.toLowerCase().includes(q.q.toLowerCase()))
      .filter((s) => !q.outcome || s.outcome === q.outcome)
      .filter((s) => !q.investigation || s.investigationStatus === q.investigation)
      .filter((s) => !q.samplingPointId || s.samplingPointId === q.samplingPointId)
      .filter((s) => !q.lotId || s.lotId === q.lotId)
      .map(view);
    return c.json({
      samples: rows.map((s) => ({ ...s, laboratoryName: s.laboratory?.name ?? null })),
      total: rows.length,
      offset: Number(q.offset ?? 0),
    });
  });

  app.get(`${ws}/testing/samples/:id`, (c) => {
    const s = samples.find((x) => x.id === c.req.param("id"));
    return s ? c.json(view(s)) : c.json(err("not_found", "Sample not found"), 404);
  });

  app.post(`${ws}/testing/samples`, async (c) => {
    const parsed = testSampleCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const input = parsed.data;
    const plan = plans.find((p) => p.id === input.planId);
    const lot = deps.lots.find((l) => l.id === input.lotId);
    const analytes = input.analytes ?? plan?.analytes ?? [];
    if (!analytes.length) return c.json(err("invalid_input", "Say what the sample is tested for"), 400);
    const sample = {
      id: newId(),
      reference: `S-2026-${String(samples.length + 1).padStart(4, "0")}`,
      subject: input.subject,
      lotId: input.lotId ?? null,
      itemId: lot?.itemId ?? null,
      samplingPointId: input.samplingPointId ?? null,
      planId: plan?.id ?? null,
      laboratoryId: input.laboratoryId ?? plan?.laboratoryId ?? null,
      sampledOn: input.sampledOn,
      sampledBy: input.sampledBy ?? null,
      status: "awaiting_results",
      outcome: "pending",
      lotHeld: false,
      investigationStatus: null,
      findings: null,
      rootCause: null,
      actionTaken: null,
      results: analytes.map((a: any) => ({
        id: newId(),
        category: a.category,
        name: a.name,
        unit: a.unit ?? null,
        min: a.min ?? null,
        max: a.max ?? null,
        limitText: a.limitText ?? null,
        value: null,
        valueText: null,
        outcome: "pending",
        reportedOn: null,
        history: [] as unknown[],
      })),
    };
    samples.push(sample);
    return c.json(view(sample), 201);
  });

  app.post(`${ws}/testing/samples/:id/results`, async (c) => {
    const s = samples.find((x) => x.id === c.req.param("id"));
    if (!s) return c.json(err("not_found", "Sample not found"), 404);
    const parsed = testResultsRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const failed: string[] = [];
    for (const entry of parsed.data.results) {
      const r = s.results.find((x: any) => x.id === entry.resultId);
      if (!r) return c.json(err("invalid_input", "A result doesn't belong to this sample"), 400);
      if (r.outcome !== "pending" && !entry.correctionReason) {
        return c.json(
          err("invalid_input", `${r.name} already has a result: give a reason to correct it`),
          400,
        );
      }
      try {
        const outcome = judgeResult(r, entry);
        if (r.outcome !== "pending")
          r.history.push({ value: r.value, outcome: r.outcome, reason: entry.correctionReason });
        Object.assign(r, {
          value: entry.value ?? null,
          valueText: entry.valueText ?? null,
          outcome,
          reportedOn: parsed.data.reportedOn,
        });
        if (outcome === "fail") failed.push(r.name);
      } catch (e) {
        if (e instanceof TestJudgeError) return c.json(err("invalid_input", `${r.name}: ${e.message}`), 400);
        throw e;
      }
    }
    const outcomes = s.results.map((r: any) => r.outcome);
    s.outcome = sampleOutcome(outcomes);
    s.status = outcomes.includes("pending") ? "awaiting_results" : "complete";
    if (s.outcome === "fail" && !s.investigationStatus) s.investigationStatus = "open";
    const lot = deps.lots.find((l) => l.id === s.lotId);
    if (failed.length && lot?.status === "available") {
      lot.status = "quarantine";
      s.lotHeld = true;
    }
    return c.json(view(s));
  });

  app.get(`${ws}/testing/trends`, (c) => {
    const analyte = (c.req.query("analyte") ?? "").toLowerCase();
    const points_ = samples
      .filter((s) => s.status !== "cancelled")
      .flatMap((s) =>
        s.results
          .filter((r: any) => r.name.toLowerCase() === analyte)
          .map((r: any) => ({
            reference: s.reference,
            sampledOn: s.sampledOn,
            lotCode: deps.lots.find((l) => l.id === s.lotId)?.lotCode ?? null,
            pointCode: points.find((p) => p.id === s.samplingPointId)?.code ?? null,
            value: r.value,
            valueText: r.valueText,
            outcome: r.outcome,
          })),
      );
    return c.json({
      analyte: c.req.query("analyte"),
      points: points_,
      summary: summarizeTrend(points_),
      truncated: false,
    });
  });

  return { samples, plans, points, laboratories };
}
