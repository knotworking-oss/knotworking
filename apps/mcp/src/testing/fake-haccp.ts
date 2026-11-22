import {
  ccpLogCreateSchema,
  correctiveActionCreateSchema,
  correctiveActionUpdateSchema,
  decisionTreeOutcome,
  hazardRisk,
  describeFrequency,
  describeLimit,
  describeReading,
  evaluateReading,
  haccpPlanCreateSchema,
  haccpPlanDraftSchema,
  haccpPlanTemplateSchema,
  hazardFromLibraryEntry,
  hazardLibraryEntrySchema,
  newId,
  type CcpInput,
} from "@knotworking/core";
import type { Hono } from "hono";

/**
 * In-memory stand-in for the HACCP module's routes (apps/server/src/routes/haccp.ts) that the MCP
 * tools use: plans and drafts, logs, recording a reading, cleaning and calibration records,
 * corrective actions and what's due. Request bodies are checked with the real schemas from
 * `@knotworking/core`. Every request here comes from an API token, so a recorded reading is
 * `source: api` and `pending` review, and an out-of-limit one opens a corrective action at once.
 *
 * Seeded with plan HACCP-01 (version 1 approved: CCP1 cooking, CCP2 chilling), two approved CCP
 * checks of which one is out of limits with its open corrective action, a cleaning and a
 * calibration record. Batches are looked up in the fake production module's list.
 */
export function mountFakeHaccp(app: Hono, ws: string, deps: { batches: Record<string, any>[] }) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-11-11T09:00:00.000Z";

  const ccpView = (c: CcpInput & { id: string }, i: number) => ({
    ...c,
    limitMin: c.limitMin ?? null,
    limitMax: c.limitMax ?? null,
    limitUnit: c.limitUnit ?? null,
    passCriterion: c.passCriterion ?? null,
    sortOrder: i,
    stepId: (c as { stepId?: string | null }).stepId ?? null,
    frequencyText: describeFrequency(c.frequency),
    limitText: describeLimit({
      limitType: c.limitType,
      limitMin: c.limitMin ?? null,
      limitMax: c.limitMax ?? null,
      limitUnit: c.limitUnit ?? null,
      passCriterion: c.passCriterion ?? null,
    }),
  });
  const version = (fields: Record<string, any>) => ({
    id: newId(),
    versionNumber: 1,
    status: "draft",
    effectiveOn: null as string | null,
    reviewDueOn: null as string | null,
    approvedAt: null as string | null,
    approvedBy: null,
    approvedByName: null as string | null,
    changeNote: null,
    scopeNote: null,
    scope: { itemIds: [] as string[], recipeIds: [] as string[] },
    ccps: [] as (CcpInput & { id: string })[],
    steps: [] as { id: string; name: string; description: string | null; hazards: any[] }[],
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  // Approval through the API is a person's act, so the fake never schedules a version for later.
  const stateOf = (v: ReturnType<typeof version>) =>
    v.status === "approved" ? "in_force" : v.status === "superseded" ? "replaced" : "draft";
  const fullVersion = (v: ReturnType<typeof version>) => ({
    ...v,
    state: stateOf(v),
    inForceUntil: null as string | null,
    scope: {
      ...v.scope,
      items: v.scope.itemIds.map((id) => ({ id, code: id, name: id, status: "active" })),
      recipes: v.scope.recipeIds.map((id) => ({ id, code: id, name: id, status: "active" })),
      wholeSite: v.scope.itemIds.length === 0 && v.scope.recipeIds.length === 0,
    },
    ccps: v.ccps.map(ccpView),
    steps: v.steps.map((st) => ({
      ...st,
      hazards: st.hazards.map((h: any) => ({
        ...h,
        risk: hazardRisk(h.likelihood, h.severity),
        outcome: decisionTreeOutcome(h),
      })),
    })),
    analysisNotes: [] as { stepId: string; text: string }[],
  });

  const ccp = (fields: Partial<CcpInput>): CcpInput & { id: string } => ({
    id: newId(),
    code: "CCP1",
    processStep: "Cooking",
    hazardType: "biological",
    hazard: "Survival of vegetative pathogens",
    limitType: "range",
    limitMin: 75,
    limitMax: null,
    limitUnit: "°C",
    passCriterion: null,
    monitoringMethod: "Probe the core",
    frequency: { every: 1, unit: "batch" },
    duringProduction: false,
    responsibleRole: "Cook",
    correctiveAction: "Continue cooking",
    verification: "Supervisor review",
    ...fields,
  });
  const v1 = version({
    status: "approved",
    effectiveOn: "2026-10-01",
    reviewDueOn: "2027-10-01",
    approvedAt: "2026-10-01T09:00:00.000Z",
    approvedByName: "Ada Lovelace",
    changeNote: "First issue",
    ccps: [
      ccp({}),
      ccp({
        code: "CCP2",
        processStep: "Chilling",
        limitMin: null,
        limitMax: 5,
        frequency: { every: 2, unit: "hour" },
        duringProduction: true,
      }),
    ],
  });
  const plans = [
    {
      id: newId(),
      code: "HACCP-01",
      name: "Soups",
      description: null as string | null,
      status: "active",
      reviewIntervalMonths: 12,
      createdAt: now,
      updatedAt: now,
      versions: [v1] as ReturnType<typeof version>[],
    },
  ];
  type Plan = (typeof plans)[number];

  const planView = (p: Plan) => {
    const approved = p.versions.find((v) => v.status === "approved");
    const draft = p.versions.find((v) => v.status === "draft");
    const { versions: _v, ...header } = p;
    return {
      ...header,
      reviewState: approved ? "ok" : null,
      currentVersion: approved ? fullVersion(approved) : null,
      upcomingVersion: null,
      draftVersion: draft ? fullVersion(draft) : null,
      versions: [...p.versions]
        .sort((a, b) => b.versionNumber - a.versionNumber)
        .map((v) => ({
          id: v.id,
          versionNumber: v.versionNumber,
          status: v.status,
          state: stateOf(v),
          inForceUntil: null,
          changeNote: v.changeNote,
          effectiveOn: v.effectiveOn,
          reviewDueOn: v.reviewDueOn,
          approvedAt: v.approvedAt,
          approvedByName: v.approvedByName,
        })),
    };
  };

  const cooking = v1.ccps[0]!;
  const chilling = v1.ccps[1]!;
  const log = ({ ccp: c, ...fields }: { ccp: ReturnType<typeof ccp> } & Record<string, any>) => {
    const limit = ccpView(c, 0);
    return {
      id: newId(),
      planId: plans[0]!.id,
      planVersionId: v1.id,
      ccpId: c.id,
      ccpCode: c.code,
      batchId: null,
      value: null as number | null,
      passed: null as boolean | null,
      withinLimits: true,
      deviationReason: null as string | null,
      note: null,
      source: "manual",
      checkedAt: now,
      recordedBy: null,
      recordedByName: "Marcus Chen",
      correctsLogId: null,
      correctionReason: null,
      correctedByLogId: null as string | null,
      reviewStatus: "approved",
      reviewedBy: null,
      reviewedByName: "Marcus Chen" as string | null,
      reviewedAt: now as string | null,
      reviewNote: null as string | null,
      createdAt: now,
      plan: { id: plans[0]!.id, code: "HACCP-01", name: "Soups" },
      batch: null as { id: string; batchCode: string } | null,
      ccp: {
        id: c.id,
        code: c.code,
        processStep: c.processStep,
        limitText: limit.limitText,
        limitUnit: c.limitUnit,
      },
      readingText: describeReading(
        { limitUnit: c.limitUnit ?? null },
        { value: fields.value ?? null, passed: fields.passed ?? null },
      ),
      correctiveActions: [] as { id: string; title: string; status: string }[],
      ...fields,
    };
  };
  const good = log({ ccp: cooking, value: 82 });
  const bad = log({ ccp: chilling, value: 9, withinLimits: false, deviationReason: "above_max" });
  const logs = [bad, good];

  const actions: Record<string, any>[] = [];
  const missing = (a: Record<string, any>) =>
    (["actionTaken", "rootCause", "preventiveAction"] as const).filter((f) => !a[f]);
  const actionView = (a: Record<string, any>) => {
    const l = logs.find((x) => x.id === a.logId);
    return {
      ...a,
      log: l
        ? {
            id: l.id,
            ccp: l.ccp,
            plan: l.plan,
            readingText: l.readingText,
            checkedAt: l.checkedAt,
            recordedByName: l.recordedByName,
          }
        : null,
      calibration: null,
      batch: null,
      lot: null,
      raisedByName: "Marcus Chen",
      closedByName: null,
      missing: missing(a),
    };
  };
  const addAction = (fields: Record<string, any>) => {
    const row = {
      id: newId(),
      title: "",
      logId: null,
      calibrationId: null,
      batchId: null,
      lotId: null,
      actionTaken: null,
      rootCause: null,
      preventiveAction: null,
      status: "open",
      source: "manual",
      closedAt: null,
      closureNote: null,
      createdAt: now,
      updatedAt: now,
      ...fields,
    };
    actions.push(row);
    return row;
  };
  const badAction = addAction({ title: "CCP2 Chilling: 9 °C (limit ≤ 5 °C)", logId: bad.id });
  bad.correctiveActions = [{ id: badAction.id, title: badAction.title, status: "open" }];

  const asset = { id: newId(), kind: "equipment", code: "PRB-01", name: "Probe 1" };
  const cleaning = [
    {
      id: newId(),
      asset: { ...asset, kind: "area", code: "L1", name: "Line 1" },
      cleanedAt: now,
      doneByName: "Marcus Chen",
      verifiedByName: null,
      verifiedAt: null,
      note: null,
    },
  ];
  const calibration = [
    {
      id: newId(),
      asset,
      calibratedAt: now,
      referenceReading: 100,
      actualReading: 100.2,
      tolerance: 0.5,
      unit: "°C",
      passed: true,
      nextDueOn: "2026-12-11",
      recordedByName: "Marcus Chen",
      correctiveActions: [],
    },
  ];

  const page = <T>(rows: T[], q: Record<string, string>) => {
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return { rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
  };

  app.get(`${ws}/haccp/plans`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const status = q.status ?? "active";
    const found = plans.filter(
      (p) =>
        (status === "all" || p.status === status) &&
        (!text || p.code.toLowerCase().includes(text) || p.name.toLowerCase().includes(text)),
    );
    const { rows, ...rest } = page(found, q);
    return c.json({
      plans: rows.map((p) => {
        const approved = p.versions.find((v) => v.status === "approved");
        const { versions: _v, ...header } = p;
        return {
          ...header,
          currentVersion: approved
            ? {
                id: approved.id,
                versionNumber: approved.versionNumber,
                effectiveOn: approved.effectiveOn,
                reviewDueOn: approved.reviewDueOn,
                ccpCount: approved.ccps.length,
                inForceUntil: null,
              }
            : null,
          upcomingVersion: null,
          reviewState: approved ? "ok" : null,
          hasDraft: p.versions.some((v) => v.status === "draft"),
        };
      }),
      ...rest,
    });
  });
  app.get(`${ws}/haccp/plans/:id`, (c) => {
    const found = plans.find((p) => p.id === c.req.param("id"));
    return found ? c.json(planView(found)) : c.json(err("not_found", "HACCP plan not found"), 404);
  });

  const saveDraft = (p: Plan, body: unknown) => {
    const draft = haccpPlanDraftSchema.parse(body);
    const existing = p.versions.find((v) => v.status === "draft");
    const steps = draft.steps.map((st) => ({
      id: newId(),
      ref: st.ref,
      name: st.name,
      description: st.description ?? null,
      hazards: st.hazards.map((h) => ({
        ...h,
        controlMeasure: h.controlMeasure ?? null,
        justification: h.justification ?? null,
      })),
    }));
    const content = {
      steps,
      scope: { itemIds: draft.scope.itemIds, recipeIds: draft.scope.recipeIds },
      scopeNote: draft.scopeNote ?? null,
      changeNote: draft.changeNote ?? null,
      ccps: draft.ccps.map((x) => ({
        ...x,
        id: newId(),
        stepId: steps.find((st) => st.ref === x.stepRef)?.id ?? null,
      })),
    };
    if (existing) {
      Object.assign(existing, content);
      return existing;
    }
    const created = version({
      versionNumber: Math.max(0, ...p.versions.map((v) => v.versionNumber)) + 1,
      ...content,
    });
    p.versions.push(created);
    return created;
  };
  app.post(`${ws}/haccp/plans`, async (c) => {
    const parsed = haccpPlanCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const { draft: given, templateId, ...input } = parsed.data;
    const template = templateId ? templates.find((t) => t.id === templateId) : undefined;
    if (templateId && !template) return c.json(err("not_found", "HACCP plan template not found"), 404);
    const draft = template
      ? { scope: { itemIds: [], recipeIds: [] }, steps: template.steps, ccps: template.ccps }
      : given;
    if (plans.some((p) => p.code.toLowerCase() === input.code.toLowerCase()))
      return c.json(err("code_taken", `Another HACCP plan already uses the code "${input.code}"`), 409);
    const plan: Plan = {
      id: input.id ?? newId(),
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      status: "active",
      reviewIntervalMonths: input.reviewIntervalMonths ?? 12,
      createdAt: now,
      updatedAt: now,
      versions: [],
    };
    plans.push(plan);
    if (draft) saveDraft(plan, draft);
    return c.json(planView(plan), 201);
  });
  // The hazard library and plan templates.
  const library: Record<string, any>[] = [];
  // Seeded with one template: a cooking step with one hazard, and its CCP.
  const templates: Record<string, any>[] = [
    {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      ...haccpPlanTemplateSchema.parse({
        name: "Cook-chill",
        description: "Cooked and chilled lines",
        steps: [
          {
            ref: "cook",
            name: "Cooking",
            hazards: [
              {
                hazardType: "biological",
                description: "Survival of pathogens",
                likelihood: 4,
                severity: 4,
                controlMeasure: "Cook to 75C",
                q1: true,
                q2: true,
              },
            ],
          },
        ],
        ccps: [
          {
            code: "CCP1",
            processStep: "Cooking",
            stepRef: "cook",
            hazardType: "biological",
            hazard: "Survival of pathogens",
            limitType: "range",
            limitMin: 75,
            limitUnit: "°C",
            monitoringMethod: "Probe",
            frequency: { every: 1, unit: "day" },
            responsibleRole: "Cook",
            correctiveAction: "Keep cooking",
            verification: "Daily review",
          },
        ],
      }),
    },
  ];
  const entryView = (e: Record<string, any>) => ({
    ...e,
    risk: hazardRisk(e.likelihood, e.severity),
    outcome: decisionTreeOutcome(e as never),
  });
  app.get(`${ws}/haccp/library`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const found = library.filter(
      (e) =>
        (!q.hazardType || e.hazardType === q.hazardType) &&
        (!text || e.title.toLowerCase().includes(text) || e.description.toLowerCase().includes(text)),
    );
    const { rows, ...rest } = page(found, q);
    return c.json({ entries: rows.map(entryView), ...rest });
  });
  const saveEntry = async (c: any, existing?: Record<string, any>) => {
    const parsed = hazardLibraryEntrySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const fields = {
      ...parsed.data,
      stepName: parsed.data.stepName ?? null,
      ...hazardFromLibraryEntry({
        ...parsed.data,
        controlMeasure: parsed.data.controlMeasure ?? null,
        justification: parsed.data.justification ?? null,
      }),
    };
    if (existing) return c.json(entryView(Object.assign(existing, fields)));
    const row = { id: newId(), createdAt: now, updatedAt: now, ...fields };
    library.push(row);
    return c.json(entryView(row), 201);
  };
  app.post(`${ws}/haccp/library`, (c) => saveEntry(c));
  app.put(`${ws}/haccp/library/:id`, (c) => {
    const found = library.find((e) => e.id === c.req.param("id"));
    return found ? saveEntry(c, found) : c.json(err("not_found", "Hazard library entry not found"), 404);
  });
  app.get(`${ws}/haccp/templates`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const found = templates.filter((t) => !text || t.name.toLowerCase().includes(text));
    const { rows, ...rest } = page(found, q);
    return c.json({ templates: rows, ...rest });
  });
  app.post(`${ws}/haccp/templates`, async (c) => {
    const parsed = haccpPlanTemplateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const row = { id: newId(), createdAt: now, updatedAt: now, description: null, ...parsed.data };
    templates.push(row);
    return c.json(row, 201);
  });
  app.put(`${ws}/haccp/plans/:id/draft`, async (c) => {
    const found = plans.find((p) => p.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "HACCP plan not found"), 404);
    const parsed = haccpPlanDraftSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    return c.json(fullVersion(saveDraft(found, parsed.data)));
  });

  app.get(`${ws}/haccp/logs`, (c) => {
    const q = c.req.query();
    const found = logs.filter(
      (l) =>
        (!q.planId || l.planId === q.planId) &&
        (!q.ccpCode || l.ccpCode.toLowerCase() === q.ccpCode.toLowerCase()) &&
        (!q.batchId || l.batchId === q.batchId) &&
        (q.outOfLimits === undefined || l.withinLimits === (q.outOfLimits === "false")) &&
        (!q.review || l.reviewStatus === q.review) &&
        (q.includeCorrected !== "false" || !l.correctedByLogId),
    );
    const { rows, ...rest } = page(found, q);
    return c.json({ logs: rows, ...rest });
  });
  app.post(`${ws}/haccp/logs`, async (c) => {
    const parsed = ccpLogCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const input = parsed.data;
    const found = plans.flatMap((p) =>
      p.versions.flatMap((v) => v.ccps.filter((x) => x.id === input.ccpId).map((x) => ({ p, v, x }))),
    )[0];
    if (!found) return c.json(err("not_found", "CCP not found"), 404);
    const { p, v, x } = found;
    if (v.status !== "approved") {
      return c.json(
        err("ccp_not_current", `${x.code} is not in the current approved version of ${p.code}`),
        409,
      );
    }
    const evaluation = evaluateReading(
      {
        limitType: x.limitType,
        limitMin: x.limitMin ?? null,
        limitMax: x.limitMax ?? null,
        limitUnit: x.limitUnit ?? null,
        passCriterion: x.passCriterion ?? null,
      },
      input.value !== undefined ? { value: input.value } : { passed: input.passed! },
    );
    if (!evaluation) {
      return c.json(err("invalid_input", `${x.code} takes the other kind of reading`), 400);
    }
    let batch: { id: string; batchCode: string } | null = null;
    if (input.batchId) {
      const b = deps.batches.find((row) => row.id === input.batchId);
      if (!b) return c.json(err("not_found", "Batch not found"), 404);
      if (b.status !== "in_progress" && b.status !== "completed") {
        return c.json(err("batch_not_running", `Batch ${b.batchCode} is ${b.status}`), 409);
      }
      batch = { id: b.id, batchCode: b.batchCode };
    }
    if (input.checkedAt && new Date(input.checkedAt).getTime() > Date.now() + 5 * 60_000) {
      return c.json(err("invalid_input", "A check can't be dated in the future"), 400);
    }
    const row = log({
      ccp: x,
      planId: p.id,
      planVersionId: v.id,
      plan: { id: p.id, code: p.code, name: p.name },
      value: input.value ?? null,
      passed: input.passed ?? null,
      withinLimits: evaluation.withinLimits,
      deviationReason: evaluation.reason,
      batchId: batch?.id ?? null,
      batch,
      note: input.note ?? null,
      checkedAt: input.checkedAt ?? now,
      source: "api",
      recordedByName: "Ada Lovelace",
      reviewStatus: "pending",
      reviewedByName: null,
      reviewedAt: null,
    });
    if (!evaluation.withinLimits) {
      const action = addAction({
        title: `${x.code} ${x.processStep}: ${row.readingText} (limit ${ccpView(x, 0).limitText})`,
        logId: row.id,
        batchId: row.batchId,
        source: "api",
      });
      row.correctiveActions = [{ id: action.id, title: action.title, status: "open" }];
    }
    logs.unshift(row);
    return c.json(row, 201);
  });
  app.get(`${ws}/haccp/cleaning`, (c) => {
    const { rows, ...rest } = page(cleaning, c.req.query());
    return c.json({ records: rows, ...rest });
  });
  app.get(`${ws}/haccp/calibration`, (c) => {
    const { rows, ...rest } = page(calibration, c.req.query());
    return c.json({ records: rows, ...rest });
  });

  app.get(`${ws}/haccp/corrective-actions`, (c) => {
    const q = c.req.query();
    const status = q.status ?? "all";
    const found = actions.filter(
      (a) => (status === "all" || a.status === status) && (!q.batchId || a.batchId === q.batchId),
    );
    const { rows, ...rest } = page(found, q);
    return c.json({ correctiveActions: rows.map(actionView), ...rest });
  });
  app.post(`${ws}/haccp/corrective-actions`, async (c) => {
    const parsed = correctiveActionCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    const input = parsed.data;
    if (input.logId) {
      const l = logs.find((x) => x.id === input.logId);
      if (!l) return c.json(err("not_found", "CCP log not found"), 404);
      if (l.withinLimits)
        return c.json(
          err("invalid_input", "That reading was within its limits; there is no deviation to act on"),
          400,
        );
    }
    return c.json(actionView(addAction({ ...input, source: "api" })), 201);
  });
  app.patch(`${ws}/haccp/corrective-actions/:id`, async (c) => {
    const found = actions.find((a) => a.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "Corrective action not found"), 404);
    if (found.status !== "open")
      return c.json(
        err("corrective_action_closed", "This corrective action is closed and can't change"),
        409,
      );
    const parsed = correctiveActionUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json(err("invalid_input", parsed.error.message), 400);
    Object.assign(found, parsed.data);
    return c.json(actionView(found));
  });

  app.get(`${ws}/haccp/due`, (c) => {
    const q = c.req.query();
    const checks = [
      {
        kind: "ccp",
        key: `ccp:${chilling.id}`,
        label: "CCP2 Chilling",
        state: "overdue",
        dueOn: "2026-11-11",
        dueAt: "2026-11-11T08:00:00.000Z",
        lastAt: "2026-11-11T06:00:00.000Z",
        frequencyText: "Every 2 hours",
      },
      {
        kind: "cleaning",
        key: "cleaning:line-1",
        label: "Clean Line 1",
        state: "due",
        dueOn: "2026-11-11",
        dueAt: null,
        lastAt: "2026-11-10T16:00:00.000Z",
        frequencyText: "Daily",
      },
      {
        kind: "calibration",
        key: `calibration:${asset.id}`,
        label: "Calibrate Probe 1",
        state: "ok",
        dueOn: "2026-12-11",
        dueAt: null,
        lastAt: now,
        frequencyText: "Monthly",
      },
    ].filter(
      (ch) =>
        (!q.kind || ch.kind === q.kind) && (q.include === "all" || ["overdue", "due"].includes(ch.state)),
    );
    return c.json({
      today: "2026-11-11",
      now,
      checks,
      counts: {
        overdue: 1,
        due: 1,
        soon: 0,
        awaitingReview: logs.filter((l) => l.reviewStatus === "pending" && !l.correctedByLogId).length,
      },
      batchesInProgress: [{ id: newId(), batchCode: "B261111-001", planIds: [plans[0]!.id] }],
    });
  });

  return { plans, logs, actions };
}
