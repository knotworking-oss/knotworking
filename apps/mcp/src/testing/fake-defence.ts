import {
  defenceApprovalBlockers,
  defenceAssessmentCreateSchema,
  defenceControlCreateSchema,
  defenceControlDue,
  defenceDraftSchema,
  defenceReviewStartSchema,
  defenceThreatRating,
  diffDefenceThreats,
  newId,
} from "@knotworking/core";
import type { Hono } from "hono";

const TODAY = "2026-03-01";

/** In-memory stand-in for the Food defence routes (apps/server/src/routes/defence.ts). */
export function mountFakeDefence(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const assessments: Record<string, any>[] = [];
  const controls: Record<string, any>[] = [];
  const controlIds = () => new Set(controls.map((c) => c.id));
  const versionView = (v: Record<string, any>): Record<string, any> => ({
    ...v,
    threats: v.threats.map((t: any) => ({ ...t, ...defenceThreatRating(t) })),
    approvedByName: v.approvedAt ? "Ada" : null,
    lastEditedByName: null,
  });
  const view = (a: Record<string, any>) => {
    const approved = a.versions.find((v: any) => v.status === "approved") ?? null;
    const draft = a.versions.find((v: any) => v.status === "draft") ?? null;
    return {
      id: a.id,
      title: a.title,
      scope: a.scope,
      status: a.status,
      reviewStatus: approved ? "ok" : "never",
      approved: approved ? versionView(approved) : null,
      draft: draft ? versionView(draft) : null,
      draftChanges: draft ? diffDefenceThreats(approved?.threats ?? [], draft.threats) : [],
      approvalBlockers: draft ? defenceApprovalBlockers(draft, TODAY, controlIds()) : [],
      history: [...a.versions].reverse().map(versionView),
      controls: controls.map((c) => ({ id: c.id, name: c.name, status: c.status })),
      exercises: [],
    };
  };
  const find = (id: string) => assessments.find((a) => a.id === id);

  app.get(`${ws}/defence/overview`, (c) =>
    c.json({
      controlsDue: controls.map((x) => ({
        ...x,
        lastCheckedOn: null,
        dueOn: TODAY,
        dueStatus: "never",
        openFailures: 0,
      })),
      openFailures: [],
      assessmentsDue: [],
      lastExercise: null,
      exerciseDueOn: TODAY,
      exerciseOverdue: true,
      visitors: null,
      counts: {
        controls: controls.length,
        overdueControls: controls.length,
        openFailures: 0,
        assessments: assessments.length,
        highThreats: 0,
      },
    }),
  );
  app.get(`${ws}/defence/assessments`, (c) =>
    c.json({
      assessments: assessments.map((a) => {
        const v = view(a);
        return {
          id: a.id,
          title: a.title,
          status: a.status,
          approvedVersion: v.approved?.versionNumber ?? null,
          reviewDueOn: v.approved?.reviewDueOn ?? null,
          reviewStatus: v.reviewStatus,
          threatCount: v.approved?.threats.length ?? 0,
          highThreats: 0,
          draftVersion: v.draft?.versionNumber ?? null,
        };
      }),
    }),
  );
  app.get(`${ws}/defence/assessments/:id`, (c) => {
    const a = find(c.req.param("id"));
    return a ? c.json(view(a)) : c.json(err("not_found", "Assessment not found"), 404);
  });
  app.post(`${ws}/defence/assessments`, async (c) => {
    const parsed = defenceAssessmentCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const a = {
      id: newId(),
      title: parsed.data.title,
      scope: parsed.data.scope ?? null,
      status: "active",
      versions: [
        {
          id: newId(),
          versionNumber: 1,
          status: "draft",
          summary: parsed.data.draft.summary ?? null,
          threats: parsed.data.draft.threats,
          reviewDueOn: parsed.data.draft.reviewDueOn ?? null,
          reviewTrigger: null,
          reviewReason: null,
          approvedAt: null,
        },
      ],
    };
    assessments.push(a);
    return c.json(view(a), 201);
  });
  app.patch(`${ws}/defence/assessments/:id`, async (c) => {
    const a = find(c.req.param("id"));
    if (!a) return c.json(err("not_found", "Assessment not found"), 404);
    Object.assign(a, await c.req.json());
    return c.json(view(a));
  });
  app.put(`${ws}/defence/assessments/:id/draft`, async (c) => {
    const a = find(c.req.param("id"));
    if (!a) return c.json(err("not_found", "Assessment not found"), 404);
    const parsed = defenceDraftSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const draft = a.versions.find((v: any) => v.status === "draft");
    if (!draft) return c.json(err("no_draft", "Start a review to change an approved assessment"), 409);
    Object.assign(draft, parsed.data);
    return c.json(view(a));
  });
  app.post(`${ws}/defence/assessments/:id/review`, async (c) => {
    const a = find(c.req.param("id"));
    if (!a) return c.json(err("not_found", "Assessment not found"), 404);
    const parsed = defenceReviewStartSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const approved = a.versions.find((v: any) => v.status === "approved");
    if (!approved) return c.json(err("no_approved_version", "Approve the first version first"), 409);
    if (a.versions.some((v: any) => v.status === "draft"))
      return c.json(err("draft_exists", "A review is already in progress"), 409);
    a.versions.push({
      ...approved,
      id: newId(),
      versionNumber: a.versions.length + 1,
      status: "draft",
      reviewDueOn: null,
      reviewTrigger: parsed.data.trigger,
      reviewReason: parsed.data.reason ?? null,
      approvedAt: null,
    });
    return c.json(view(a), 201);
  });
  /** Stands in for a person approving the draft in the app (tests only). */
  const approve = (id: string) => {
    const a = find(id)!;
    for (const v of a.versions) if (v.status === "approved") v.status = "superseded";
    const draft = a.versions.find((v: any) => v.status === "draft");
    draft.status = "approved";
    draft.approvedAt = new Date().toISOString();
  };
  app.get(`${ws}/defence/controls`, (c) =>
    c.json({
      controls: controls.map((x) => ({
        ...x,
        lastCheckedOn: null,
        ...defenceControlDue(x.frequencyDays, null, TODAY),
        dueStatus: defenceControlDue(x.frequencyDays, null, TODAY).status,
        openFailures: 0,
      })),
    }),
  );
  app.post(`${ws}/defence/controls`, async (c) => {
    const parsed = defenceControlCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const row = { id: newId(), area: null, instructions: null, status: "active", ...parsed.data };
    controls.push(row);
    return c.json(row, 201);
  });
  return { assessments, controls, approve };
}
