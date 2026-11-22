import {
  governanceCultureCreateSchema,
  governanceCultureState,
  governanceCultureUpdateSchema,
  governanceDueStatus,
  governanceObjectiveCreateSchema,
  governanceObjectiveUpdateSchema,
  governanceProgressSchema,
  governanceRequirementCreateSchema,
  governanceReviewCreateSchema,
  governanceReviewUpdateSchema,
  governanceSignBlockers,
  clauseImportSchema,
  clauseEvidenceSetSchema,
  clauseDraftSchema,
  evidenceCheckIds,
  gapSnapshotCreateSchema,
  evidenceChecks,
  parseClauseCsv,
  summariseGaps,
  newId,
} from "@knotworking/core";
import type { Hono } from "hono";

const TODAY = "2026-03-01";

/** In-memory stand-in for the Governance routes (apps/server/src/routes/governance.ts). */
export function mountFakeGovernance(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const objectives: Record<string, any>[] = [];
  const activities: Record<string, any>[] = [];
  const requirements: Record<string, any>[] = [];
  const reviews: Record<string, any>[] = [];
  const objectiveView = (o: Record<string, any>) => ({
    ...o,
    ownerName: null,
    dueStatus: o.status === "open" ? governanceDueStatus(o.dueOn, TODAY) : "ok",
    latest: o.progress.at(-1) ?? null,
  });
  const cultureView = (a: Record<string, any>) => ({
    ...a,
    ownerName: null,
    state: governanceCultureState(a as never, TODAY),
  });
  const reviewView = (r: Record<string, any>) => ({
    ...r,
    evidence: { period: { from: r.periodFrom, to: r.periodTo }, previousActions: [] },
    evidenceIsSnapshot: r.status === "signed",
    signedByName: null,
    followUpTeam: null,
    decisions: r.decisions.map((d: any) => ({ ...d, ownerName: null })),
    signBlockers: governanceSignBlockers({ ...(r as any), tasksActive: false }, TODAY),
  });
  const parse = async (schema: any, c: any) => schema.safeParse(await c.req.json());

  app.get(`${ws}/governance/overview`, (c) =>
    c.json({
      objectivesNeedingAttention: objectives
        .map(objectiveView)
        .filter((o) => o.latest?.rag && o.latest.rag !== "on_track"),
      cultureOverdue: activities.map(cultureView).filter((a) => a.state === "overdue"),
      cultureUpcoming: activities.map(cultureView).filter((a) => a.state === "planned"),
      requirementsDue: requirements,
      openConcerns: null,
      lastSignedReview: null,
      draftReviews: reviews.filter((r) => r.status === "draft").map((r) => ({ id: r.id, title: r.title })),
    }),
  );
  app.get(`${ws}/governance/objectives`, (c) => c.json({ objectives: objectives.map(objectiveView) }));
  app.post(`${ws}/governance/objectives`, async (c) => {
    const p = await parse(governanceObjectiveCreateSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    const o = {
      id: newId(),
      measure: null,
      target: null,
      ownerUserId: null,
      dueOn: null,
      status: "open",
      progress: [],
      ...p.data,
    };
    objectives.push(o);
    return c.json(objectiveView(o), 201);
  });
  app.patch(`${ws}/governance/objectives/:id`, async (c) => {
    const o = objectives.find((x) => x.id === c.req.param("id"));
    if (!o) return c.json(err("not_found", "Objective not found"), 404);
    const p = await parse(governanceObjectiveUpdateSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    Object.assign(o, p.data);
    return c.json(objectiveView(o));
  });
  app.post(`${ws}/governance/objectives/:id/progress`, async (c) => {
    const o = objectives.find((x) => x.id === c.req.param("id"));
    if (!o) return c.json(err("not_found", "Objective not found"), 404);
    const p = await parse(governanceProgressSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    o.progress.push({ value: null, ...p.data, by: "u", byName: "Ada", at: new Date().toISOString() });
    return c.json(objectiveView(o), 201);
  });
  app.get(`${ws}/governance/culture`, (c) => c.json({ activities: activities.map(cultureView) }));
  app.post(`${ws}/governance/culture`, async (c) => {
    const p = await parse(governanceCultureCreateSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    const a = {
      id: newId(),
      measure: null,
      ownerUserId: null,
      completedOn: null,
      participants: null,
      result: null,
      cancelledAt: null,
      ...p.data,
    };
    activities.push(a);
    return c.json(cultureView(a), 201);
  });
  app.patch(`${ws}/governance/culture/:id`, async (c) => {
    const a = activities.find((x) => x.id === c.req.param("id"));
    if (!a) return c.json(err("not_found", "Activity not found"), 404);
    const p = await parse(governanceCultureUpdateSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    Object.assign(a, p.data);
    return c.json(cultureView(a));
  });
  app.get(`${ws}/governance/requirements`, (c) => c.json({ requirements }));
  app.post(`${ws}/governance/requirements`, async (c) => {
    const p = await parse(governanceRequirementCreateSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    const r = {
      id: newId(),
      reference: null,
      customerName: null,
      ownerName: null,
      compliance: "not_assessed",
      lastReviewedOn: null,
      reviewDueOn: null,
      status: "active",
      ...p.data,
    };
    r.reviewStatus = governanceDueStatus(r.reviewDueOn, TODAY);
    requirements.push(r);
    return c.json(r, 201);
  });
  app.get(`${ws}/governance/reviews`, (c) =>
    c.json({
      reviews: reviews.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        decisions: r.decisions.length,
      })),
    }),
  );
  app.post(`${ws}/governance/reviews`, async (c) => {
    const p = await parse(governanceReviewCreateSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    const r = {
      id: newId(),
      heldOn: null,
      attendees: null,
      notes: {},
      resources: null,
      decisions: [],
      followUpTeamId: null,
      status: "draft",
      signedAt: null,
      ...p.data,
    };
    reviews.push(r);
    return c.json({ id: r.id }, 201);
  });
  app.get(`${ws}/governance/reviews/:id`, (c) => {
    const r = reviews.find((x) => x.id === c.req.param("id"));
    return r ? c.json(reviewView(r)) : c.json(err("not_found", "Review not found"), 404);
  });
  app.patch(`${ws}/governance/reviews/:id`, async (c) => {
    const r = reviews.find((x) => x.id === c.req.param("id"));
    if (!r) return c.json(err("not_found", "Review not found"), 404);
    const p = await parse(governanceReviewUpdateSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    Object.assign(r, p.data);
    return c.json(reviewView(r));
  });
  // Standards gap analysis: one in-memory standard; clauses imported with the real CSV rules.
  const standards: Record<string, any>[] = [];
  const clauses: Record<string, any>[] = [];
  const gapView = (std: Record<string, any>) => {
    const mine = clauses.filter((x) => x.standardId === std.id);
    return {
      standard: std,
      summary: summariseGaps(
        mine.map((x) => ({
          ref: x.ref as string,
          section: x.section as string,
          fundamental: x.fundamental as boolean,
          status: "not_assessed" as const,
          dueOn: null,
        })),
        TODAY,
      ),
      clauses: mine.map((x) => ({ ...x, status: "not_assessed", assessment: null, tasks: [], taskCount: 0 })),
    };
  };
  app.get(`${ws}/governance/standards`, (c) => c.json({ standards }));
  const evidence = new Map<string, string[]>();
  app.get(`${ws}/governance/evidence-checks`, (c) =>
    c.json({
      checks: evidenceCheckIds.map((id) => ({
        id,
        label: evidenceChecks[id].label,
        status: "no_data",
        detail: "Nothing on record",
        items: [],
        clauses: [...evidence.entries()].filter(([, ids]) => ids.includes(id)).map(([clause]) => clause),
      })),
    }),
  );
  app.put(`${ws}/governance/clauses/:id/evidence`, async (c) => {
    const p = await parse(clauseEvidenceSetSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    evidence.set(c.req.param("id"), p.data.checkIds);
    return c.json({ clauseId: c.req.param("id"), checkIds: p.data.checkIds });
  });
  app.get(`${ws}/governance/standards/:id`, (c) => {
    const std = standards.find((x) => x.id === c.req.param("id"));
    return std ? c.json(gapView(std)) : c.json(err("not_found", "Standard not found"), 404);
  });
  app.post(`${ws}/governance/standards/:id/clauses/import`, async (c) => {
    const std = standards.find((x) => x.id === c.req.param("id"));
    if (!std) return c.json(err("not_found", "Standard not found"), 404);
    const p = await parse(clauseImportSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    const parsed = parseClauseCsv(p.data.csv);
    if (parsed.errors.length)
      return c.json({ applied: false, added: 0, updated: 0, unchanged: 0, errors: parsed.errors });
    if (!p.data.dryRun) for (const r of parsed.rows) clauses.push({ id: newId(), standardId: std.id, ...r });
    return c.json({
      applied: !p.data.dryRun,
      added: parsed.rows.length,
      updated: 0,
      unchanged: 0,
      errors: [],
    });
  });
  const drafts: { id: string; clauseId: string; state: string; draftedVia: string; [k: string]: unknown }[] =
    [];
  app.post(`${ws}/governance/clauses/:id/drafts`, async (c) => {
    const clause = clauses.find((x) => x.id === c.req.param("id"));
    if (!clause) return c.json(err("not_found", "Clause not found"), 404);
    const p = await parse(clauseDraftSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    for (const d of drafts) if (d.clauseId === clause.id && d.state === "open") d.state = "superseded";
    drafts.unshift({ id: newId(), clauseId: clause.id, state: "open", draftedVia: "agent", ...p.data });
    return c.json(
      { clause, status: "not_assessed", history: [], drafts: drafts.filter((d) => d.clauseId === clause.id) },
      201,
    );
  });
  const snapshots: { id: string; standardId: string; label: string; takenOn: string; clauseCount: number }[] =
    [];
  app.get(`${ws}/governance/standards/:id/snapshots`, (c) =>
    c.json({ snapshots: snapshots.filter((x) => x.standardId === c.req.param("id")) }),
  );
  app.post(`${ws}/governance/standards/:id/snapshots`, async (c) => {
    const std = standards.find((x) => x.id === c.req.param("id"));
    if (!std) return c.json(err("not_found", "Standard not found"), 404);
    const p = await parse(gapSnapshotCreateSchema, c);
    if (!p.success) return c.json(err("invalid_input", p.error.message), 400);
    const snap = {
      id: newId(),
      standardId: std.id,
      label: p.data.label,
      takenOn: TODAY,
      clauseCount: clauses.filter((x) => x.standardId === std.id).length,
    };
    snapshots.unshift(snap);
    return c.json(snap, 201);
  });
  app.get(`${ws}/governance/snapshots/:id`, (c) => {
    const snap = snapshots.find((x) => x.id === c.req.param("id"));
    if (!snap) return c.json(err("not_found", "Snapshot not found"), 404);
    const std = standards.find((x) => x.id === snap.standardId)!;
    return c.json({ snapshot: snap, ...gapView(std), changesSince: { status: [], added: [], removed: [] } });
  });
  return { objectives, activities, requirements, reviews, standards, drafts, snapshots };
}
