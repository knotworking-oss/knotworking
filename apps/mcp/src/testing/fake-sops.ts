import { newId, textToDoc } from "@knotworking/core";
import type { Hono } from "hono";

/** In-memory stand-in for the SOPs module's routes (apps/server/src/routes/sops.ts). */
export function mountFakeSops(app: Hono, ws: string) {
  const err = (code: string, message: string) => ({ error: { code, message } });
  const now = "2026-01-05T09:00:00.000Z";
  /** Whether the caller may see drafts and versions in review (`write`). Tests flip this. */
  const state = { canWrite: true };

  const version = (fields: Record<string, unknown>) => ({
    id: newId(),
    sopId: "",
    versionNumber: 1,
    title: "",
    content: textToDoc(""),
    changeSummary: "Initial issue",
    status: "approved",
    submittedBy: null,
    submittedAt: now,
    decidedBy: null,
    decidedAt: now,
    decisionNote: null,
    effectiveOn: "2026-01-05",
    reviewDueOn: "2027-01-05",
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  const sop = (fields: Record<string, unknown>) => ({
    id: newId(),
    code: "",
    title: "",
    category: null as string | null,
    ownerId: null,
    reviewIntervalMonths: 12,
    ackReminderDays: 14,
    ackReminderRepeatDays: null as number | null,
    status: "active",
    draft: null as null | { title: string; content: any; updatedAt: string; updatedBy: string | null },
    draftUpdatedAt: null as string | null,
    versions: [] as Record<string, any>[],
    createdAt: now,
    updatedAt: now,
    ...fields,
  });

  const cleaning = sop({ code: "SOP-001", title: "Hand washing", category: "Cleaning" });
  cleaning.versions.push(
    version({
      sopId: cleaning.id,
      title: "Hand washing",
      content: textToDoc("Wash hands for twenty seconds."),
    }),
  );
  const allergen = sop({ code: "SOP-002", title: "Allergen changeover", category: "Allergen control" });
  allergen.versions.push(
    version({
      sopId: allergen.id,
      title: "Allergen changeover",
      content: textToDoc("Clean down between allergen runs."),
      reviewDueOn: "2025-12-01",
    }),
  );
  allergen.draft = {
    title: "Allergen changeover",
    content: textToDoc("Draft: clean down and swab."),
    updatedAt: now,
    updatedBy: null,
  };
  allergen.draftUpdatedAt = now;
  const old = sop({ code: "SOP-003", title: "Retired procedure", status: "archived" });
  const sops = [cleaning, allergen, old];

  const current = (s: (typeof sops)[number]) => s.versions.find((v) => v.status === "approved");
  const header = (s: (typeof sops)[number]) => {
    const { draft, versions: _v, ...rest } = s;
    return { ...rest, hasDraft: draft !== null };
  };
  const row = (s: (typeof sops)[number]) => {
    const c = current(s);
    return {
      ...header(s),
      currentVersion: c
        ? { id: c.id, versionNumber: c.versionNumber, effectiveOn: c.effectiveOn, reviewDueOn: c.reviewDueOn }
        : null,
      reviewState: c ? (c.reviewDueOn < "2026-01-05" ? "overdue" : "ok") : null,
      inReview: s.versions.some((v) => v.status === "in_review"),
      acknowledged: false,
    };
  };
  const detail = (s: (typeof sops)[number]) => {
    const review = s.versions.find((v) => v.status === "in_review");
    return {
      ...header(s),
      currentVersion: current(s) ?? null,
      versions: [...s.versions]
        .sort((a, b) => b.versionNumber - a.versionNumber)
        .map(({ content: _c, ...meta }) => meta),
      inReview: review !== undefined,
      inReviewVersion: state.canWrite && review ? review : null,
      draft: state.canWrite ? s.draft : null,
      acknowledged: false,
    };
  };

  app.get(`${ws}/sops`, (c) => {
    const q = c.req.query();
    const text = q.q?.toLowerCase();
    const status = q.status ?? "active";
    const found = sops.filter(
      (s) =>
        (status === "all" || s.status === status) &&
        (!q.category || s.category?.toLowerCase() === q.category.toLowerCase()) &&
        (!text || s.title.toLowerCase().includes(text) || s.code.toLowerCase().includes(text)) &&
        (!q.due || row(s).reviewState === q.due),
    );
    const limit = Number(q.limit ?? 50);
    const offset = Number(q.offset ?? 0);
    return c.json({ sops: found.slice(offset, offset + limit).map(row), total: found.length, limit, offset });
  });
  app.get(`${ws}/sops/outstanding`, (c) =>
    c.json({
      items: [
        {
          sopId: cleaning.id,
          code: cleaning.code,
          title: cleaning.title,
          ackReminderDays: 14,
          versionId: "v1",
          versionNumber: 1,
          effectiveOn: "2026-01-05",
          since: "2026-01-05",
          daysOutstanding: 20,
          userId: "u1",
          name: "Ada",
          email: "ada@example.com",
        },
      ],
      today: "2026-01-25",
    }),
  );
  const copy = (fields: Record<string, unknown>) => ({
    id: newId(),
    sopId: cleaning.id,
    versionId: cleaning.versions[0]!.id,
    copyNumber: 1,
    issuedToUserId: null,
    issuedTo: "Packing room",
    location: "Wall file",
    status: "issued",
    issuedBy: null,
    issuedAt: now,
    closedAt: null,
    closedBy: null,
    closedNote: null,
    sopCode: "SOP-001",
    title: "Hand washing",
    versionNumber: 1,
    versionStatus: "approved",
    effectiveOn: "2026-01-05",
    current: true,
    outOfDate: false,
    issuedByName: "Ada",
    closedByName: null,
    ...fields,
  });
  const copies = [
    copy({}),
    copy({
      copyNumber: 2,
      issuedTo: "Goods in",
      outOfDate: true,
      current: false,
      versionStatus: "superseded",
    }),
    copy({ copyNumber: 3, status: "destroyed", closedNote: "Shredded", closedByName: "Ada", closedAt: now }),
  ];
  app.get(`${ws}/sops/copies`, (c) => {
    const q = c.req.query();
    const status = q.status ?? "issued";
    const found = copies.filter(
      (x) =>
        (status === "all" || x.status === status) &&
        (!q.sopId || x.sopId === q.sopId) &&
        (q.outOfDate === undefined || String(x.outOfDate) === q.outOfDate),
    );
    const limit = Number(q.limit ?? 100);
    const offset = Number(q.offset ?? 0);
    return c.json({ copies: found.slice(offset, offset + limit), total: found.length, limit, offset });
  });
  app.get(`${ws}/sops/:id`, (c) => {
    const found = sops.find((s) => s.id === c.req.param("id"));
    return found ? c.json(detail(found)) : c.json(err("not_found", "SOP not found"), 404);
  });
  app.post(`${ws}/sops`, async (c) => {
    const body = await c.req.json();
    if (sops.some((s) => s.code.toLowerCase() === String(body.code).toLowerCase()))
      return c.json(err("code_taken", `Another SOP already uses the code "${body.code}"`), 409);
    const { content, ...fields } = body;
    const created = sop({
      ...fields,
      draft: content ? { title: body.title, content, updatedAt: now, updatedBy: null } : null,
      draftUpdatedAt: content ? now : null,
    });
    sops.push(created);
    return c.json(header(created), 201);
  });
  app.put(`${ws}/sops/:id/draft`, async (c) => {
    const found = sops.find((s) => s.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "SOP not found"), 404);
    const body = await c.req.json();
    if (body.expectedDraftUpdatedAt !== undefined && body.expectedDraftUpdatedAt !== found.draftUpdatedAt)
      return c.json(err("draft_conflict", "This draft was saved by someone else since you opened it."), 409);
    const stamp = new Date(Date.parse(found.draftUpdatedAt ?? now) + 1000).toISOString();
    found.draft = body.content
      ? { title: body.title ?? found.title, content: body.content, updatedAt: stamp, updatedBy: null }
      : null;
    found.draftUpdatedAt = stamp;
    return c.json({ ...header(found), draft: found.draft });
  });
  app.post(`${ws}/sops/:id/submit`, async (c) => {
    const found = sops.find((s) => s.id === c.req.param("id"));
    if (!found) return c.json(err("not_found", "SOP not found"), 404);
    if (found.versions.some((v) => v.status === "in_review"))
      return c.json(err("review_in_progress", "A version of this SOP is already waiting for review"), 409);
    if (!found.draft) return c.json(err("draft_empty", "There is no draft to submit"), 409);
    const body = await c.req.json();
    const created = version({
      sopId: found.id,
      versionNumber: found.versions.length + 1,
      title: found.draft.title,
      content: found.draft.content,
      changeSummary: body.changeSummary,
      status: "in_review",
      decidedAt: null,
      effectiveOn: null,
      reviewDueOn: null,
    });
    found.versions.push(created);
    return c.json(created, 201);
  });

  return { sops, state };
}
