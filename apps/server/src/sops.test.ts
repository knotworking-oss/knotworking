import {
  addDays,
  addMonthsToIsoDate,
  DEFAULT_TIME_ZONE,
  docToPlainText,
  textToDoc,
  todayInZone,
} from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const SECRET = "Wash hands for twenty seconds. SECRET-DRAFT-TEXT";

describe("sops module", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: { cookie: string; userId: string };
  let reader: { cookie: string; userId: string };
  let adaId: string;
  let token: string;
  const as = (cookie: string) => ({
    get: (path: string) => ctx.req(`${WS}${path}`, { cookie }),
    send: (method: string, path: string, json?: unknown) => ctx.req(`${WS}${path}`, { method, cookie, json }),
  });
  const viaToken = (method: string, path: string, json?: unknown) =>
    ctx.req(`${WS}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "" }, json });
  const grant = (userId: string, level: string | null) =>
    ctx.req(`${WS}/members/${userId}/module-access/sops`, { method: "PUT", cookie: ada, json: { level } });
  const code = async (res: { json(): Promise<any> }) => (await res.json()).error.code;
  /** Creates an SOP with a draft and returns its id. */
  const makeSop = async (sopCode: string, extra: Record<string, unknown> = {}) => {
    const res = await as(marcus.cookie).send("POST", "/sops", {
      code: sopCode,
      title: `Procedure ${sopCode}`,
      content: textToDoc(SECRET),
      ...extra,
    });
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  };
  /** Submits the draft as marcus and returns the new version. */
  const submit = async (id: string, cookie = marcus.cookie) => {
    const res = await as(cookie).send("POST", `/sops/${id}/submit`, { changeSummary: "Initial issue" });
    expect(res.status).toBe(201);
    return res.json();
  };
  const approve = (id: string, versionId: string, cookie = ada, body: object = {}) =>
    as(cookie).send("POST", `/sops/${id}/versions/${versionId}/decision`, { decision: "approve", ...body });

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${WS}/members`, { cookie: ada })).json();
    const find = (email: string) => members.find((x: { email: string }) => x.email === email);
    adaId = find("ada@knotworking.dev").userId;
    const m = find("marcus@knotworking.dev");
    marcus = { userId: m.userId, cookie: (await signIn(ctx, m.email)).cookie };
    const other = members.find(
      (x: { email: string; role: string }) => x.role === "member" && x.email !== "marcus@knotworking.dev",
    );
    reader = { userId: other.userId, cookie: (await signIn(ctx, other.email)).cookie };
    token = (
      await (
        await ctx.req("/v1/me/api-tokens", {
          method: "POST",
          cookie: ada,
          json: { name: "t", scope: "write" },
        })
      ).json()
    ).token;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("access", () => {
    it("is opt-in: a member needs a grant, and read can't write", async () => {
      expect((await as(marcus.cookie).get("/sops")).status).toBe(403);
      await grant(marcus.userId, "read");
      expect((await as(marcus.cookie).get("/sops")).status).toBe(200);
      const write = await as(marcus.cookie).send("POST", "/sops", { code: "X", title: "X" });
      expect(write.status).toBe(403);
      await grant(marcus.userId, "write");
      await grant(reader.userId, "read");
    });

    it("is switched off with the module", async () => {
      const off = await makeApp({ seed: true, activeModules: ["tasks", "docs"] });
      const cookie = (await signIn(off, "ada@knotworking.dev")).cookie;
      const res = await off.req(`${WS}/sops`, { cookie });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("module_inactive");
      await off.handle.close();
    }, 60_000);
  });

  describe("draft", () => {
    it("creates an SOP, keeps codes unique case-insensitively, saves the draft and detects conflicts", async () => {
      const id = await makeSop("SOP-001", { category: "Cleaning" });
      expect(
        await code(await as(marcus.cookie).send("POST", "/sops", { code: "sop-001", title: "Dupe" })),
      ).toBe("code_taken");

      const first = await (await as(marcus.cookie).get(`/sops/${id}`)).json();
      expect(first).toMatchObject({
        code: "SOP-001",
        category: "Cleaning",
        status: "active",
        hasDraft: true,
      });
      expect(first.currentVersion).toBeNull();
      expect(docToPlainText(first.draft.content)).toContain("SECRET-DRAFT-TEXT");

      const save = (content: unknown, expected: string | null) =>
        as(marcus.cookie).send("PUT", `/sops/${id}/draft`, {
          content,
          expectedDraftUpdatedAt: expected,
        });
      const saved = await save(textToDoc("Second draft"), first.draft.updatedAt);
      expect(saved.status).toBe(200);
      const second = await saved.json();
      expect(second.draft.updatedAt > first.draft.updatedAt).toBe(true);

      // Someone else saved in between: refused, with the current draft attached.
      const stale = await save(textToDoc("Lost edit"), first.draft.updatedAt);
      expect(stale.status).toBe(409);
      const body = await stale.json();
      expect(body.error.code).toBe("draft_conflict");
      expect(docToPlainText(body.error.details.current.content)).toContain("Second draft");
      // "Never saved" is a precondition too.
      expect((await save(textToDoc("x"), null)).status).toBe(409);
      // Without a precondition the write goes through.
      expect(
        (await as(marcus.cookie).send("PUT", `/sops/${id}/draft`, { content: textToDoc("Third") })).status,
      ).toBe(200);
    });

    it("lets only writers read the draft", async () => {
      const id = await makeSop("SOP-002");
      const asReader = await (await as(reader.cookie).get(`/sops/${id}`)).json();
      expect(asReader.hasDraft).toBe(true);
      expect(asReader.draft).toBeNull();
      expect(JSON.stringify(asReader)).not.toContain("SECRET-DRAFT-TEXT");
      const list = await (await as(reader.cookie).get("/sops")).json();
      expect(JSON.stringify(list)).not.toContain("SECRET-DRAFT-TEXT");
      expect((await as(reader.cookie).send("PUT", `/sops/${id}/draft`, { content: null })).status).toBe(403);
    });
  });

  describe("document control", () => {
    it("submits, approves (clearing the draft), and supersedes the old version on the next approval", async () => {
      const id = await makeSop("SOP-010", { reviewIntervalMonths: 6 });
      // Submit needs a change summary and a non-empty draft.
      expect(
        (await as(marcus.cookie).send("POST", `/sops/${id}/submit`, { changeSummary: " " })).status,
      ).toBe(400);
      const v1 = await submit(id);
      expect(v1).toMatchObject({ versionNumber: 1, status: "in_review", changeSummary: "Initial issue" });
      expect(v1.submittedBy).toBe(marcus.userId);
      // The draft is kept on submit; a second submission while one is in review is refused.
      expect((await (await as(marcus.cookie).get(`/sops/${id}`)).json()).hasDraft).toBe(true);
      expect(
        await code(await as(marcus.cookie).send("POST", `/sops/${id}/submit`, { changeSummary: "Again" })),
      ).toBe("review_in_progress");

      const approved = await approve(id, v1.id);
      expect(approved.status).toBe(200);
      const a1 = await approved.json();
      expect(a1).toMatchObject({
        status: "approved",
        decidedBy: adaId,
        effectiveOn: todayInZone(DEFAULT_TIME_ZONE),
      });
      expect(a1.reviewDueOn).toBe(addMonthsToIsoDate(todayInZone(DEFAULT_TIME_ZONE), 6));

      const detail = await (await as(marcus.cookie).get(`/sops/${id}`)).json();
      expect(detail.hasDraft).toBe(false);
      expect(detail.draft).toBeNull();
      expect(detail.currentVersion.id).toBe(v1.id);
      // Nothing to submit now, and a deciding twice is refused.
      expect(
        await code(await as(marcus.cookie).send("POST", `/sops/${id}/submit`, { changeSummary: "x" })),
      ).toBe("draft_empty");
      expect(await code(await approve(id, v1.id))).toBe("not_in_review");

      // An unchanged draft can't be resubmitted…
      await as(marcus.cookie).send("PUT", `/sops/${id}/draft`, { content: a1.content, title: a1.title });
      expect(
        await code(await as(marcus.cookie).send("POST", `/sops/${id}/submit`, { changeSummary: "x" })),
      ).toBe("draft_unchanged");
      // …a changed one becomes version 2, and approving it supersedes version 1.
      await as(marcus.cookie).send("PUT", `/sops/${id}/draft`, { content: textToDoc("Revised text") });
      const v2 = await submit(id);
      expect(v2.versionNumber).toBe(2);
      const a2 = await (
        await approve(id, v2.id, ada, { effectiveOn: "2099-01-01", reviewDueOn: "2099-06-01" })
      ).json();
      expect(a2).toMatchObject({ effectiveOn: "2099-01-01", reviewDueOn: "2099-06-01" });
      const after = await (await as(marcus.cookie).get(`/sops/${id}`)).json();
      expect(after.currentVersion.id).toBe(v2.id);
      expect(
        after.versions.map((v: { versionNumber: number; status: string }) => [v.versionNumber, v.status]),
      ).toEqual([
        [2, "approved"],
        [1, "superseded"],
      ]);
      // Superseded versions stay readable, with their content.
      const old = await (await as(reader.cookie).get(`/sops/${id}/versions/${v1.id}`)).json();
      expect(docToPlainText(old.content)).toContain("SECRET-DRAFT-TEXT");
      // The header takes the approved title.
      expect(after.title).toBe(a2.title);
    });

    it("rejects with a required note and keeps the draft for rework", async () => {
      const id = await makeSop("SOP-011");
      const v1 = await submit(id);
      const decide = (json: object) => as(ada).send("POST", `/sops/${id}/versions/${v1.id}/decision`, json);
      expect((await decide({ decision: "reject" })).status).toBe(400);
      const rejected = await (await decide({ decision: "reject", note: "Missing allergen step" })).json();
      expect(rejected).toMatchObject({
        status: "rejected",
        decisionNote: "Missing allergen step",
        decidedBy: adaId,
      });
      const detail = await (await as(marcus.cookie).get(`/sops/${id}`)).json();
      expect(detail.hasDraft).toBe(true);
      expect(detail.currentVersion).toBeNull();
      // Rejected versions are kept and readable; the next submission is version 2.
      expect((await as(reader.cookie).get(`/sops/${id}/versions/${v1.id}`)).status).toBe(200);
      expect((await submit(id)).versionNumber).toBe(2);
    });

    it("keeps versions immutable: there is no route that edits or deletes one", async () => {
      const id = await makeSop("SOP-012");
      const v1 = await submit(id);
      await approve(id, v1.id);
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const res = await as(ada).send(method, `/sops/${id}/versions/${v1.id}`, { title: "Tampered" });
        expect([404, 405]).toContain(res.status);
      }
      expect((await (await as(ada).get(`/sops/${id}/versions/${v1.id}`)).json()).title).toBe(v1.title);
      // The SOP has been in force, so it can only be archived.
      expect(await code(await as(ada).send("DELETE", `/sops/${id}`))).toBe("has_approved_version");
      const archived = await as(ada).send("PATCH", `/sops/${id}`, { status: "archived" });
      expect((await archived.json()).status).toBe("archived");
      expect(await code(await as(marcus.cookie).send("PUT", `/sops/${id}/draft`, { content: null }))).toBe(
        "sop_archived",
      );
      // One that never was approved can be deleted.
      const fresh = await makeSop("SOP-013");
      expect((await as(marcus.cookie).send("DELETE", `/sops/${fresh}`)).status).toBe(204);
      expect((await as(marcus.cookie).get(`/sops/${fresh}`)).status).toBe(404);
    });

    it("refuses decisions from write-level members and from API tokens", async () => {
      const id = await makeSop("SOP-020");
      const v1 = await submit(id);
      const asWriter = await approve(id, v1.id, marcus.cookie);
      expect(asWriter.status).toBe(403);
      expect(await code(asWriter)).toBe("module_forbidden");
      const asReader = await approve(id, v1.id, reader.cookie);
      expect(asReader.status).toBe(403);
      const tokenRes = await viaToken("POST", `/sops/${id}/versions/${v1.id}/decision`, {
        decision: "approve",
      });
      expect(tokenRes.status).toBe(403);
      expect(await code(tokenRes)).toBe("token_not_allowed");
      expect((await (await as(ada).get(`/sops/${id}/versions/${v1.id}`)).json()).status).toBe("in_review");
    });

    it("applies four-eyes unless the submitter is the only manager", async () => {
      // Ada is the only manager: she may approve her own submission.
      const solo = await makeSop("SOP-030");
      const own = await submit(solo, ada);
      expect((await approve(solo, own.id)).status).toBe(200);

      // With a second manager, a submitter may not approve their own version.
      await grant(marcus.userId, "manage");
      const id = await makeSop("SOP-031");
      const v1 = await submit(id);
      const self = await approve(id, v1.id, marcus.cookie);
      expect(self.status).toBe(403);
      expect(await code(self)).toBe("four_eyes");
      expect((await approve(id, v1.id, ada)).status).toBe(200);
      // Rejecting your own submission (withdrawing it) is allowed.
      await as(marcus.cookie).send("PUT", `/sops/${id}/draft`, { content: textToDoc("Another change") });
      const v2 = await submit(id);
      const withdrawn = await as(marcus.cookie).send("POST", `/sops/${id}/versions/${v2.id}/decision`, {
        decision: "reject",
        note: "Withdrawn",
      });
      expect(withdrawn.status).toBe(200);
      await grant(marcus.userId, "write");
    });

    it("hides content under review from read-only members", async () => {
      const id = await makeSop("SOP-040");
      const v1 = await submit(id);
      const detail = await (await as(reader.cookie).get(`/sops/${id}`)).json();
      expect(detail.inReview).toBe(true);
      expect(detail.inReviewVersion).toBeNull();
      expect(JSON.stringify(detail)).not.toContain("SECRET-DRAFT-TEXT");
      expect(JSON.stringify(detail)).not.toContain("Initial issue");
      expect((await as(reader.cookie).get(`/sops/${id}/versions/${v1.id}`)).status).toBe(403);
      const forWriter = await (await as(marcus.cookie).get(`/sops/${id}`)).json();
      expect(forWriter.inReviewVersion.id).toBe(v1.id);
      expect(docToPlainText(forWriter.inReviewVersion.content)).toContain("SECRET-DRAFT-TEXT");
    });
  });

  describe("acknowledgement", () => {
    it("is once per person per version, personal, and listed for managers", async () => {
      const id = await makeSop("SOP-050");
      const v1 = await submit(id);
      // Nothing to acknowledge before approval.
      expect(await code(await as(reader.cookie).send("POST", `/sops/${id}/acknowledge`, {}))).toBe(
        "no_current_version",
      );
      await approve(id, v1.id);

      const ack = await as(reader.cookie).send("POST", `/sops/${id}/acknowledge`, { versionId: v1.id });
      expect(ack.status).toBe(201);
      expect(await ack.json()).toMatchObject({ versionId: v1.id, userId: reader.userId });
      expect(await code(await as(reader.cookie).send("POST", `/sops/${id}/acknowledge`, {}))).toBe(
        "already_acknowledged",
      );
      expect((await (await as(reader.cookie).get(`/sops/${id}`)).json()).acknowledged).toBe(true);
      expect((await (await as(marcus.cookie).get(`/sops/${id}`)).json()).acknowledged).toBe(false);
      const row = (await (await as(reader.cookie).get("/sops?q=SOP-050")).json()).sops[0];
      expect(row.acknowledged).toBe(true);

      // A token is refused (a personal attestation).
      const tokenRes = await viaToken("POST", `/sops/${id}/acknowledge`, {});
      expect(tokenRes.status).toBe(403);
      expect(await code(tokenRes)).toBe("token_not_allowed");

      // The list is a manager's view.
      const path = `/sops/${id}/versions/${v1.id}/acknowledgements`;
      expect((await as(marcus.cookie).get(path)).status).toBe(403);
      const list = await (await as(ada).get(path)).json();
      expect(list.acknowledged.map((a: { userId: string }) => a.userId)).toEqual([reader.userId]);
      const pending = list.pending.map((p: { userId: string }) => p.userId);
      expect(pending).toContain(marcus.userId);
      expect(pending).toContain(adaId);
      expect(pending).not.toContain(reader.userId);

      // A new approved version needs fresh acknowledgements.
      await as(marcus.cookie).send("PUT", `/sops/${id}/draft`, { content: textToDoc("Version two text") });
      const v2 = await submit(id);
      await approve(id, v2.id);
      expect((await (await as(reader.cookie).get(`/sops/${id}`)).json()).acknowledged).toBe(false);
      expect(
        await code(await as(reader.cookie).send("POST", `/sops/${id}/acknowledge`, { versionId: v1.id })),
      ).toBe("version_not_current");
      expect(
        (await as(reader.cookie).send("POST", `/sops/${id}/acknowledge`, { versionId: v2.id })).status,
      ).toBe(201);
    });
  });

  describe("review dates", () => {
    it("filters by overdue and soon on the current version's review date", async () => {
      const overdue = await makeSop("SOP-060");
      const soon = await makeSop("SOP-061");
      const later = await makeSop("SOP-062");
      await makeSop("SOP-063");
      const today = todayInZone(DEFAULT_TIME_ZONE);
      const inTwoWeeks = addDays(todayInZone(DEFAULT_TIME_ZONE), 14);
      const dates: [string, string, string][] = [
        [overdue, "2020-01-01", "2020-06-01"],
        [soon, today, inTwoWeeks],
        [later, today, addMonthsToIsoDate(today, 12)],
      ];
      for (const [id, effectiveOn, reviewDueOn] of dates) {
        const v = await submit(id);
        expect((await approve(id, v.id, ada, { effectiveOn, reviewDueOn })).status).toBe(200);
      }
      const codes = async (query: string) =>
        (await (await as(reader.cookie).get(`/sops?${query}`)).json()).sops.map(
          (s: { code: string }) => s.code,
        );
      expect(await codes("due=overdue")).toEqual(["SOP-060"]);
      expect(await codes("due=soon")).toEqual(["SOP-061"]);
      const all = await codes("q=SOP-06");
      expect(all).toEqual(["SOP-060", "SOP-061", "SOP-062", "SOP-063"]);
      const rows = (await (await as(reader.cookie).get("/sops?q=SOP-06")).json()).sops;
      expect(rows.map((r: { reviewState: string | null }) => r.reviewState)).toEqual([
        "overdue",
        "soon",
        "ok",
        null,
      ]);
      expect(rows[0].currentVersion).toMatchObject({ versionNumber: 1, effectiveOn: "2020-01-01" });
      expect(rows[3].currentVersion).toBeNull();
      expect(rows[3].hasDraft).toBe(true);
    });

    it("filters by category and status", async () => {
      const cleaning = (await (await as(ada).get("/sops?category=cleaning")).json()).sops;
      expect(cleaning.map((s: { code: string }) => s.code)).toEqual(["SOP-001"]);
      const active = (await (await as(ada).get("/sops?limit=200")).json()).sops;
      expect(active.some((s: { status: string }) => s.status === "archived")).toBe(false);
      const archived = (await (await as(ada).get("/sops?status=archived")).json()).sops;
      expect(archived.map((s: { code: string }) => s.code)).toEqual(["SOP-012"]);
    });
  });

  describe("sync log", () => {
    it("carries metadata only, never draft or version content", async () => {
      const sync = await (await as(reader.cookie).get("/sync?after=0")).json();
      const sopChanges = sync.changes.filter((c: { entity: string }) => c.entity.startsWith("sop"));
      expect(new Set(sopChanges.map((c: { entity: string }) => c.entity))).toEqual(
        new Set(["sop", "sop_version", "sop_acknowledgement"]),
      );
      const text = JSON.stringify(sopChanges);
      expect(text).not.toContain("SECRET-DRAFT-TEXT");
      expect(text).not.toContain("Revised text");
      expect(text).not.toContain("draftContent");
      expect(text).not.toContain("Initial issue");
      for (const change of sopChanges.filter((c: { action: string }) => c.action === "upsert")) {
        expect(change.data).not.toHaveProperty("content");
        expect(change.data).not.toHaveProperty("draft");
        expect(change.data).not.toHaveProperty("workspaceId");
      }
      // SOPs are not in the bootstrap.
      const boot = await (await as(reader.cookie).get("/bootstrap")).json();
      expect(boot).not.toHaveProperty("sops");
    });

    it("hides SOP changes from members without module access", async () => {
      await grant(reader.userId, null);
      const sync = await (await as(reader.cookie).get("/sync?after=0")).json();
      expect(sync.changes.some((c: { entity: string }) => c.entity.startsWith("sop"))).toBe(false);
    });
  });
});
