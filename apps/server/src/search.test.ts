import { d, type DocContent, type SearchResponse } from "@knotworking/core";
import {
  addWorkspaceMember,
  createPasswordUser,
  documents,
  tasks,
  teams,
  workflowStates,
  workspaces,
} from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "./services/api-tokens";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";

describe("workspace search", () => {
  let ctx: TestCtx;
  let ada: string;
  let guest: string;
  let otherWorkspaceId: string;

  const get = async (q: string, params: Record<string, string> = {}, cookie = ada) => {
    const qs = new URLSearchParams({ q, ...params });
    const res = await ctx.req(`${WS}/search?${qs}`, { cookie });
    return { status: res.status, body: (await res.json()) as SearchResponse };
  };
  const find = async (q: string, params?: Record<string, string>) => (await get(q, params)).body;
  const createDoc = async (title: string, content?: DocContent) => {
    const res = await ctx.req(`${WS}/documents`, { method: "POST", cookie: ada, json: { title, content } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const patchDoc = (id: string, json: Record<string, unknown>) =>
    ctx.req(`${WS}/documents/${id}`, { method: "PATCH", cookie: ada, json });
  const titles = (hits: { title: string }[]) => hits.map((h) => h.title);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { url } = await (
      await ctx.req(`${WS}/invitations`, {
        method: "POST",
        cookie: ada,
        json: { email: "guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;

    // A second workspace with its own document and task, to prove nothing crosses over.
    const db = ctx.handle.db;
    const [other] = await db.insert(workspaces).values({ slug: "other", name: "Other" }).returning();
    otherWorkspaceId = other!.id;
    const [team] = await db
      .insert(teams)
      .values({ workspaceId: otherWorkspaceId, key: "OTH", name: "Others" })
      .returning();
    const [state] = await db
      .insert(workflowStates)
      .values({
        workspaceId: otherWorkspaceId,
        teamId: team!.id,
        name: "Todo",
        type: "unstarted",
        sortOrder: "a0",
      })
      .returning();
    await db.insert(tasks).values({
      workspaceId: otherWorkspaceId,
      teamId: team!.id,
      stateId: state!.id,
      title: "Quokkasecret task",
      sortOrder: "a0",
    });
    await db.insert(documents).values({
      workspaceId: otherWorkspaceId,
      title: "Quokkasecret doc",
      content: d.doc(d.p("quokkasecret body")),
      sortOrder: "a0",
    });
    const outsider = await createPasswordUser(db, {
      email: "outsider@other.test",
      name: "Olive",
      password: "outsider-password-1",
    });
    await addWorkspaceMember(db, otherWorkspaceId, outsider.id, "owner");
  }, 60_000);
  afterAll(() => ctx.handle.close());

  it("finds documents by body text and returns a highlighted snippet", async () => {
    const doc = await createDoc(
      "Onboarding handbook",
      d.doc(
        d.h(1, "Welcome"),
        d.p("Every new hire gets a laptop, a badge and a mentor."),
        d.p(
          "Request the ",
          d.text("kubernetes", "bold"),
          " sandbox from the platform team before day three.",
        ),
      ),
    );
    const { documents: hits } = await find("sandbox");
    expect(hits.map((h) => h.id)).toContain(doc.id);
    const hit = hits.find((h) => h.id === doc.id)!;
    expect(hit.titleMatches).toEqual([]);
    expect(hit.snippet).toContain("sandbox");
    expect(hit.snippetMatches).toHaveLength(1);
    const [s, e] = hit.snippetMatches[0]!;
    expect(hit.snippet.slice(s, e)).toBe("sandbox");
    expect(hit.updatedAt).toMatch(/^\d{4}-/);
  });

  it("matches word prefixes, case-insensitively, with every word required in any order", async () => {
    const doc = await createDoc("Quarterly planning", d.doc(d.p("Roadmap review happens on Thursdays.")));
    for (const q of ["roadm", "ROADMAP", "thursdays review", "review roadmap", "plann"]) {
      expect(
        (await find(q)).documents.map((h) => h.id),
        q,
      ).toContain(doc.id);
    }
    expect((await find("roadmap friday")).documents.map((h) => h.id)).not.toContain(doc.id);
  });

  it("sees text split across marks and keeps paragraphs apart", async () => {
    const doc = await createDoc(
      "Marks",
      d.doc(d.p("hel", d.text("lo", "bold"), "wor"), d.p("ldly paragraph")),
    );
    const ids = async (q: string) => (await find(q)).documents.map((h) => h.id);
    expect(await ids("helloworldly")).not.toContain(doc.id); // paragraphs are separate
    expect(await ids("hello")).toContain(doc.id); // "hel" + bold "lo" is one word
    expect(await ids("ldly")).toContain(doc.id);
    // Node attributes are not body text.
    const attrs = await createDoc("Attrs", d.doc(d.h(2, "plain heading")));
    expect((await find("level")).documents.map((h) => h.id)).not.toContain(attrs.id);
  });

  it("ranks title matches above body matches, and better matches above weaker ones", async () => {
    await createDoc("Notes", d.doc(d.p("The zanzibar migration is described in detail below.")));
    await createDoc("Zanzibar migration", d.doc(d.p("Moving everything over.")));
    await createDoc("Misc", d.doc(d.p("zanzibar zanzibar zanzibar migration migration")));
    const { documents: hits } = await find("zanzibar migration");
    expect(titles(hits)[0]).toBe("Zanzibar migration");
    expect(titles(hits)).toEqual(expect.arrayContaining(["Notes", "Misc"]));
    expect(hits[0]!.titleMatches.length).toBeGreaterThan(0);
    // Title that starts with the query beats one that only contains it.
    await createDoc("Archive: Zanzibar", d.doc());
    await createDoc("Zanzibar", d.doc());
    const titleOnly = titles((await find("zanzibar", { scope: "documents" })).documents);
    expect(titleOnly.indexOf("Zanzibar")).toBeLessThan(titleOnly.indexOf("Archive: Zanzibar"));
  });

  it("applies limit and scope", async () => {
    for (let i = 0; i < 4; i++) await createDoc(`Limit probe ${i}`, d.doc(d.p("limitprobe")));
    expect((await find("limitprobe", { limit: "2" })).documents).toHaveLength(2);
    expect((await find("limitprobe")).documents.length).toBeGreaterThanOrEqual(4);
    const onlyTasks = await find("limitprobe", { scope: "tasks" });
    expect(onlyTasks.documents).toEqual([]);
    const onlyDocs = await find("onboarding", { scope: "documents" });
    expect(onlyDocs.tasks).toEqual([]);
    expect(onlyDocs.documents.length).toBeGreaterThan(0);
  });

  it("never returns soft-deleted documents, including descendants, and updates after edits", async () => {
    const parent = await createDoc("Parent page", d.doc(d.p("ephemeralword here")));
    const childRes = await ctx.req(`${WS}/documents`, {
      method: "POST",
      cookie: ada,
      json: { title: "Child page", parentId: parent.id, content: d.doc(d.p("ephemeralword child")) },
    });
    const child = (await childRes.json()) as { id: string };
    expect((await find("ephemeralword")).documents.map((h) => h.id).sort()).toEqual(
      [parent.id, child.id].sort(),
    );

    expect((await ctx.req(`${WS}/documents/${parent.id}`, { method: "DELETE", cookie: ada })).status).toBe(
      204,
    );
    expect((await find("ephemeralword")).documents).toEqual([]);
    expect((await find("Parent page")).documents.map((h) => h.id)).not.toContain(parent.id);

    const live = await createDoc("Edited", d.doc(d.p("before-edit text")));
    expect((await find("before")).documents.map((h) => h.id)).toContain(live.id);
    await patchDoc(live.id, { content: d.doc(d.p("after-edit text")) });
    expect((await find("before")).documents.map((h) => h.id)).not.toContain(live.id);
    expect((await find("after")).documents.map((h) => h.id)).toContain(live.id);
  });

  it("is scoped to the workspace in the URL and to its members", async () => {
    const mine = await find("quokkasecret");
    expect(mine.documents).toEqual([]);
    expect(mine.tasks).toEqual([]);
    // Ada isn't a member of "other": the workspace doesn't exist for her.
    const res = await ctx.req(`/v1/workspaces/other/search?q=quokkasecret`, { cookie: ada });
    expect(res.status).toBe(404);
    // Its own member does find them there, and only there.
    const olive = (await signIn(ctx, "outsider@other.test", "outsider-password-1")).cookie;
    const theirs = await (
      await ctx.req(`/v1/workspaces/other/search?q=quokkasecret`, { cookie: olive })
    ).json();
    expect(theirs.documents).toHaveLength(1);
    expect(theirs.tasks).toHaveLength(1);
    // Anonymous requests get nothing.
    expect((await ctx.req(`${WS}/search?q=anything`)).status).toBe(401);
  });

  it("searches tasks (title and description), but not deleted tasks or archived teams", async () => {
    const boot = await (await ctx.req(`${WS}/bootstrap`, { cookie: ada })).json();
    const teamId = boot.teams[0].id as string;
    const make = async (title: string, description?: DocContent) => {
      const res = await ctx.req(`${WS}/tasks`, {
        method: "POST",
        cookie: ada,
        json: { teamId, title, description },
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string };
    };
    const byTitle = await make("Fix the flibbertigibbet login");
    const byBody = await make("Unrelated title", d.doc(d.p("Steps: open the flibbertigibbet screen")));
    const gone = await make("Deleted flibbertigibbet");
    await ctx.req(`${WS}/tasks/${gone.id}`, { method: "DELETE", cookie: ada });

    const { tasks: hits } = await find("flibbertigibbet");
    expect(hits.map((h) => h.id).sort()).toEqual([byTitle.id, byBody.id].sort());
    expect(hits[0]!.id).toBe(byTitle.id); // title match first
    const body = hits.find((h) => h.id === byBody.id)!;
    expect(body.titleMatches).toEqual([]);
    expect(body.snippet).toContain("flibbertigibbet");
    expect(body.teamId).toBe(teamId);

    await ctx.handle.db.update(teams).set({ deletedAt: new Date() }).where(eq(teams.id, teamId));
    expect((await find("flibbertigibbet")).tasks).toEqual([]);
    await ctx.handle.db.update(teams).set({ deletedAt: null }).where(eq(teams.id, teamId));
  });

  describe("odd queries", () => {
    it("treats text-search and LIKE syntax as plain text", async () => {
      const doc = await createDoc(
        "Specials",
        d.doc(
          d.p("Cost is $100 (50% off) for the C++ course, see foo_bar.baz()"),
          d.p('Ask ada@example.com — it\'s "quoted" & done | really! <b>x</b> back\\slash'),
        ),
      );
      const ids = async (q: string) => (await get(q)).body.documents.map((h) => h.id);
      for (const q of [
        "C++",
        "$100",
        "50%",
        "foo_bar",
        "foo_bar.baz()",
        "ada@example.com",
        "it's",
        '"quoted"',
        "done | really",
        "<b>x</b>",
        "back\\slash",
        "(50% off)",
        "really!",
      ]) {
        expect(await ids(q), q).toContain(doc.id);
      }
      // `%` and `_` are literal, not wildcards.
      expect(await ids("5%0")).not.toContain(doc.id);
      expect(await ids("foo_baz")).not.toContain(doc.id);
      expect(await ids("f_o_bar")).not.toContain(doc.id);
    });

    it("never errors on operators, quotes or punctuation-only input", async () => {
      const queries = [
        "&",
        "|",
        "!",
        ":*",
        "'",
        "''",
        '"',
        "\\",
        "(",
        ")",
        "(((",
        "a &",
        "a | b",
        "!a",
        "'a':*",
        "a:b",
        "<->",
        "%",
        "_",
        "%%%",
        "!!",
        "-- drop table documents",
        "'; drop table documents; --",
        "foo' or '1'='1",
        "a ".repeat(100).trim(),
        "😀",
        "日本語",
        "tab\tnewline\nspaces   inside",
      ];
      for (const q of queries) {
        const { status, body } = await get(q);
        expect(status, JSON.stringify(q)).toBe(200);
        expect(Array.isArray(body.documents)).toBe(true);
      }
      expect((await get("'; drop table documents; --")).body.documents).toEqual([]);
      // Still intact.
      expect((await find("onboarding")).documents.length).toBeGreaterThan(0);
    });

    it("matches non-Latin text and ignores accents' case", async () => {
      const doc = await createDoc("Käse", d.doc(d.p("日本語のメモ and Ärger")));
      const ids = async (q: string) => (await find(q)).documents.map((h) => h.id);
      expect(await ids("日本語")).toContain(doc.id);
      expect(await ids("käse")).toContain(doc.id);
      expect(await ids("ärger")).toContain(doc.id);
    });

    it("validates the query", async () => {
      for (const params of [
        "",
        "q=",
        "q=%20%20",
        `q=${"x".repeat(201)}`,
        "q=a&limit=0",
        "q=a&limit=51",
        "q=a&scope=nope",
      ]) {
        const res = await ctx.req(`${WS}/search?${params}`, { cookie: ada });
        expect(res.status, params).toBe(400);
        expect((await res.json()).error.code).toBe("invalid_input");
      }
    });
  });

  it("lets guests search with the same visibility as the documents list", async () => {
    const list = await (await ctx.req(`${WS}/documents`, { cookie: guest })).json();
    const total = list.documents.length;
    expect(total).toBeGreaterThan(0);
    const { status, body } = await get("onboarding", {}, guest);
    expect(status).toBe(200);
    expect(body.documents.length).toBeGreaterThan(0);
    for (const hit of body.documents)
      expect(list.documents.map((x: { id: string }) => x.id)).toContain(hit.id);
  });

  it("is available to read and write API tokens, read-only", async () => {
    const [ada_] = await ctx.handle.db.query.users.findMany({
      where: (u, { eq: is }) => is(u.email, "ada@knotworking.dev"),
    });
    const { token } = await createApiToken(ctx.handle.db, ada_!.id, { name: "search", scope: "read" });
    const res = await ctx.req(`${WS}/search?q=onboarding`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).documents.length).toBeGreaterThan(0);
  });

  it("bounds each snippet", async () => {
    const long = "word ".repeat(2000) + "needleinhaystack " + "tail ".repeat(2000);
    const doc = await createDoc("Long", d.doc(d.p(long)));
    const hit = (await find("needleinhaystack")).documents.find((h) => h.id === doc.id)!;
    expect(hit.snippet.length).toBeLessThan(200);
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.endsWith("…")).toBe(true);
    const [s, e] = hit.snippetMatches[0]!;
    expect(hit.snippet.slice(s, e)).toBe("needleinhaystack");
  });
});
