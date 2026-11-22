import type { DocContent } from "@knotworking/core";
import { documentRevisions, documents, syncChanges, workspaces } from "@knotworking/db";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";
import { MAX_REVISIONS_PER_DOCUMENT, REVISION_THROTTLE_MINUTES } from "./services/document-revisions";

const WS = "/v1/workspaces/acme";

const text = (t: string): DocContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

describe("document version history", () => {
  let ctx: TestCtx;
  let ada: string;
  let adaId: string;
  let marcus: string;
  let marcusId: string;
  let guest: string;

  const db = () => ctx.handle.db;
  const create = async (title: string, content?: unknown, cookie = ada) => {
    const res = await ctx.req(`${WS}/documents`, { method: "POST", cookie, json: { title, content } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; updatedAt: string };
  };
  const patch = (id: string, json: Record<string, unknown>, cookie = ada) =>
    ctx.req(`${WS}/documents/${id}`, { method: "PATCH", cookie, json });
  const save = async (id: string, json: Record<string, unknown>, cookie = ada) => {
    const res = await patch(id, json, cookie);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; updatedAt: string; title: string; content: any };
  };
  const list = async (id: string, cookie = ada) => {
    const res = await ctx.req(`${WS}/documents/${id}/revisions`, { cookie });
    expect(res.status).toBe(200);
    return (await res.json()).revisions as {
      id: string;
      kind: string;
      authorId: string | null;
      title: string;
      createdAt: string;
      updatedAt: string;
    }[];
  };
  const getRev = (id: string, rev: string, cookie = ada) =>
    ctx.req(`${WS}/documents/${id}/revisions/${rev}`, { cookie });
  const restore = (id: string, rev: string, json: Record<string, unknown> = {}, cookie = ada) =>
    ctx.req(`${WS}/documents/${id}/revisions/${rev}/restore`, { method: "POST", cookie, json });
  /** Pretends the time window has passed: every revision of the document started this much earlier. */
  const age = (id: string, minutes: number) =>
    db()
      .update(documentRevisions)
      .set({ createdAt: sql`${documentRevisions.createdAt} - ${minutes} * interval '1 minute'` })
      .where(eq(documentRevisions.documentId, id));
  const revisionRows = (id: string) =>
    db().select({ n: count() }).from(documentRevisions).where(eq(documentRevisions.documentId, id));
  const docChanges = async (id: string) =>
    db()
      .select()
      .from(syncChanges)
      .where(and(eq(syncChanges.entity, "document"), eq(syncChanges.entityId, id)))
      .orderBy(asc(syncChanges.id));

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    const me = async (cookie: string) => (await (await ctx.req("/v1/me", { cookie })).json()).user.id;
    adaId = await me(ada);
    marcusId = await me(marcus);
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
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("capture", () => {
    it("snapshots a new document, and the list carries metadata but no content", async () => {
      const doc = await create("Spec", text("first"));
      const revisions = await list(doc.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ kind: "edit", authorId: adaId, title: "Spec" });
      expect(revisions[0]).not.toHaveProperty("content");
      expect(revisions[0]).not.toHaveProperty("workspaceId");

      const full = await (await getRev(doc.id, revisions[0]!.id)).json();
      expect(full).toMatchObject({ id: revisions[0]!.id, documentId: doc.id, title: "Spec", kind: "edit" });
      expect(full.content).toEqual(text("first"));
    });

    it("folds autosaves by the same author inside the window into one revision, in place", async () => {
      const doc = await create("Notes");
      const [first] = await list(doc.id);
      for (const t of ["a", "ab", "abc", "abcd", "abcde"]) await save(doc.id, { content: text(t) });
      const revisions = await list(doc.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.id).toBe(first!.id); // updated in place
      const full = await (await getRev(doc.id, first!.id)).json();
      expect(full.content).toEqual(text("abcde"));
      expect(new Date(full.updatedAt).getTime()).toBeGreaterThan(new Date(full.createdAt).getTime());
      // Title edits fold in as well.
      await save(doc.id, { title: "Notes 2" });
      expect((await list(doc.id))[0]).toMatchObject({ id: first!.id, title: "Notes 2" });
    });

    it(`starts a new revision once the ${REVISION_THROTTLE_MINUTES}-minute window has passed`, async () => {
      const doc = await create("Windowed", text("one"));
      await save(doc.id, { content: text("two") });
      expect(await list(doc.id)).toHaveLength(1);

      await age(doc.id, REVISION_THROTTLE_MINUTES - 1); // still inside the window
      await save(doc.id, { content: text("three") });
      expect(await list(doc.id)).toHaveLength(1);

      await age(doc.id, 2); // now older than the window
      await save(doc.id, { content: text("four") });
      const revisions = await list(doc.id);
      expect(revisions).toHaveLength(2);
      // The older revision keeps what it had; the new one holds the latest state.
      const [newest, older] = revisions;
      expect((await (await getRev(doc.id, older!.id)).json()).content).toEqual(text("three"));
      expect((await (await getRev(doc.id, newest!.id)).json()).content).toEqual(text("four"));
    });

    it("keeps one revision per author: another author's save inside the window adds one", async () => {
      const doc = await create("Shared", text("ada's"));
      await save(doc.id, { content: text("marcus's") }, marcus);
      await save(doc.id, { content: text("marcus's again") }, marcus);
      await save(doc.id, { content: text("ada again") }, ada); // the latest is marcus's: not hers to extend
      const revisions = await list(doc.id);
      expect(revisions.map((r) => r.authorId)).toEqual([adaId, marcusId, adaId]);
    });

    it("skips saves that change neither title nor body", async () => {
      const doc = await create("Same", text("body"));
      const [rev] = await list(doc.id);
      const before = await (await getRev(doc.id, rev!.id)).json();

      await save(doc.id, { title: "Same", content: text("body") }); // identical
      await save(doc.id, { content: { content: text("body").content, type: "doc" } }); // same JSON, other key order
      const parent = await create("Parent");
      await save(doc.id, { parentId: parent.id }); // a move
      await save(doc.id, { icon: "📄" }); // metadata only

      expect(await list(doc.id)).toHaveLength(1);
      expect(await (await getRev(doc.id, rev!.id)).json()).toEqual(before); // not even touched
      // A no-op does not break the next real edit's window logic either.
      await age(doc.id, REVISION_THROTTLE_MINUTES + 1);
      await save(doc.id, { content: text("changed") });
      expect(await list(doc.id)).toHaveLength(2);
    });

    it("keeps the pre-history version of a document that has no revisions yet", async () => {
      const doc = await create("Legacy", text("as it was"));
      await db().delete(documentRevisions).where(eq(documentRevisions.documentId, doc.id));
      await save(doc.id, { content: text("edited") });
      const revisions = await list(doc.id);
      expect(revisions).toHaveLength(2);
      const [latest, baseline] = revisions;
      expect((await (await getRev(doc.id, baseline!.id)).json()).content).toEqual(text("as it was"));
      expect((await (await getRev(doc.id, latest!.id)).json()).content).toEqual(text("edited"));
    });

    it("records the token's user as author of agent edits (the MCP server is an API client)", async () => {
      const mint = await ctx.req("/v1/me/api-tokens", {
        method: "POST",
        cookie: marcus,
        json: { name: "agent", scope: "write" },
      });
      const { token } = await mint.json();
      const doc = await create("Agent page", text("human"));
      const res = await ctx.req(`${WS}/documents/${doc.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, origin: "" },
        json: { content: text("agent wrote this") },
      });
      expect(res.status).toBe(200);
      const [latest, created] = await list(doc.id);
      expect(latest).toMatchObject({ authorId: marcusId, kind: "edit" });
      expect(created!.authorId).toBe(adaId);
    });

    it("keeps the most recent revisions only and prunes the oldest", async () => {
      const doc = await create("Busy", text("current"));
      const [row] = await db().select().from(documents).where(eq(documents.id, doc.id));
      // A history already at the limit, all older than the window (oldest = "old 0").
      const at = (i: number) => new Date(Date.now() - (MAX_REVISIONS_PER_DOCUMENT - i + 60) * 3_600_000);
      await db()
        .insert(documentRevisions)
        .values(
          Array.from({ length: MAX_REVISIONS_PER_DOCUMENT }, (_, i) => ({
            workspaceId: row!.workspaceId,
            documentId: doc.id,
            title: `old ${i}`,
            content: text(`old ${i}`),
            authorId: adaId,
            kind: "edit" as const,
            createdAt: at(i),
            updatedAt: at(i),
          })),
        );
      expect((await revisionRows(doc.id))[0]!.n).toBe(MAX_REVISIONS_PER_DOCUMENT + 1);

      await age(doc.id, REVISION_THROTTLE_MINUTES + 1);
      await save(doc.id, { content: text("newest") });

      const revisions = await list(doc.id);
      expect(revisions).toHaveLength(MAX_REVISIONS_PER_DOCUMENT);
      expect((await revisionRows(doc.id))[0]!.n).toBe(MAX_REVISIONS_PER_DOCUMENT);
      expect(revisions[0]!.title).toBe("Busy"); // the newest
      const titles = revisions.map((r) => r.title);
      expect(titles).not.toContain("old 0"); // the oldest two went
      expect(titles).not.toContain("old 1");
      expect(titles).toContain("old 2");
      // Updating in place never prunes.
      await save(doc.id, { content: text("newest, edited") });
      expect(await list(doc.id)).toHaveLength(MAX_REVISIONS_PER_DOCUMENT);
    });
  });

  describe("restore", () => {
    const setup = async () => {
      const doc = await create("Original title", text("original"));
      const [original] = await list(doc.id);
      await age(doc.id, REVISION_THROTTLE_MINUTES + 1);
      const current = await save(doc.id, { title: "New title", content: text("rewritten") });
      return { doc, original: original!, current };
    };

    it("snapshots the current state first, then applies the old title and body as a normal update", async () => {
      const { doc, original, current } = await setup();
      const syncBefore = (await docChanges(doc.id)).length;
      const res = await restore(doc.id, original.id, {}, marcus);
      expect(res.status).toBe(200);
      const restored = await res.json();
      expect(restored).toMatchObject({ id: doc.id, title: "Original title", lastEditedById: marcusId });
      expect(restored.content).toEqual(text("original"));
      expect(new Date(restored.updatedAt).getTime()).toBeGreaterThan(new Date(current.updatedAt).getTime());
      expect((await (await ctx.req(`${WS}/documents/${doc.id}`, { cookie: ada })).json()).content).toEqual(
        text("original"),
      );

      // History: restore on top, the replaced state kept as "before-restore", then the two earlier edits.
      const revisions = await list(doc.id);
      expect(revisions.map((r) => r.kind)).toEqual(["restore", "before-restore", "edit", "edit"]);
      expect(revisions[0]).toMatchObject({ authorId: marcusId, title: "Original title" });
      const before = await (await getRev(doc.id, revisions[1]!.id)).json();
      expect(before).toMatchObject({ authorId: marcusId, title: "New title" });
      expect(before.content).toEqual(text("rewritten"));

      // The write is in the sync log like any other document update.
      const changes = await docChanges(doc.id);
      expect(changes).toHaveLength(syncBefore + 1);
      expect(changes.at(-1)).toMatchObject({ action: "upsert" });
      expect((changes.at(-1)!.data as any).title).toBe("Original title");
      expect((changes.at(-1)!.data as any).content).toEqual(text("original"));
    });

    it("can be undone through the before-restore snapshot", async () => {
      const { doc, original } = await setup();
      await restore(doc.id, original.id);
      const beforeRestore = (await list(doc.id)).find((r) => r.kind === "before-restore")!;
      const res = await restore(doc.id, beforeRestore.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ title: "New title", content: text("rewritten") });
    });

    it("a later edit by the same person starts its own revision instead of rewriting the restore", async () => {
      const { doc, original } = await setup();
      await restore(doc.id, original.id);
      await save(doc.id, { content: text("typing after restore") });
      const kinds = (await list(doc.id)).map((r) => r.kind);
      expect(kinds).toEqual(["edit", "restore", "before-restore", "edit", "edit"]);
    });

    it("honours expectedUpdatedAt: a stale value is a 409 that writes nothing, not even the snapshot", async () => {
      const { doc, original, current } = await setup();
      await save(doc.id, { content: text("someone else saved") });
      const revisionsBefore = await list(doc.id);
      const syncBefore = (await docChanges(doc.id)).length;
      const stored = (await db().select().from(documents).where(eq(documents.id, doc.id)))[0];

      const res = await restore(doc.id, original.id, { expectedUpdatedAt: current.updatedAt });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("document_conflict");
      expect(body.error.details.current.content).toEqual(text("someone else saved"));

      expect(await list(doc.id)).toEqual(revisionsBefore);
      expect((await docChanges(doc.id)).length).toBe(syncBefore);
      expect((await db().select().from(documents).where(eq(documents.id, doc.id)))[0]).toEqual(stored);
    });

    it("accepts a matching expectedUpdatedAt", async () => {
      const { doc, original, current } = await setup();
      const res = await restore(doc.id, original.id, { expectedUpdatedAt: current.updatedAt });
      expect(res.status).toBe(200);
      expect((await res.json()).content).toEqual(text("original"));
    });

    it("rejects a malformed body or ids, and a revision of another document", async () => {
      const { doc, original } = await setup();
      const other = await create("Other doc", text("x"));
      expect((await restore(doc.id, original.id, { expectedUpdatedAt: "yesterday" })).status).toBe(400);
      expect((await restore(doc.id, "not-a-uuid")).status).toBe(400);
      expect((await restore(other.id, original.id)).status).toBe(404);
      expect((await getRev(other.id, original.id)).status).toBe(404);
      expect((await restore(doc.id, "00000000-0000-7000-8000-000000000000")).status).toBe(404);
    });

    it("is writer-only: members restore, guests and read-only tokens cannot", async () => {
      const { doc, original } = await setup();
      const syncBefore = (await docChanges(doc.id)).length;
      const asGuest = await restore(doc.id, original.id, {}, guest);
      expect(asGuest.status).toBe(403);
      expect((await asGuest.json()).error.code).toBe("read_only");

      const mint = async (scope: string) =>
        (
          await (
            await ctx.req("/v1/me/api-tokens", {
              method: "POST",
              cookie: marcus,
              json: { name: scope, scope },
            })
          ).json()
        ).token as string;
      const viaToken = (token: string) =>
        ctx.req(`${WS}/documents/${doc.id}/revisions/${original.id}/restore`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, origin: "" },
          json: {},
        });
      expect((await viaToken(await mint("read"))).status).toBe(403);
      expect((await docChanges(doc.id)).length).toBe(syncBefore);
      expect((await viaToken(await mint("write"))).status).toBe(200);
    });
  });

  describe("visibility", () => {
    it("lets members and guests read history, and keeps revisions out of the sync log", async () => {
      const doc = await create("Readable", text("v1"));
      await save(doc.id, { content: text("v2") });
      const [rev] = await list(doc.id, marcus);
      expect((await list(doc.id, guest)).map((r) => r.id)).toEqual([rev!.id]);
      const full = await getRev(doc.id, rev!.id, guest);
      expect(full.status).toBe(200);
      expect((await full.json()).content).toEqual(text("v2"));

      const entities = await db().selectDistinct({ entity: syncChanges.entity }).from(syncChanges);
      expect(entities.map((e) => e.entity)).not.toContain("document_revision");
      const feed = await (await ctx.req(`${WS}/sync?after=0&limit=500`, { cookie: ada })).json();
      expect(JSON.stringify(feed)).not.toContain("before-restore");
    });

    it("needs a session or token in the workspace", async () => {
      const doc = await create("Private-ish", text("x"));
      const [rev] = await list(doc.id);
      expect((await ctx.req(`${WS}/documents/${doc.id}/revisions`)).status).toBe(401);
      // Ada is not a member of "other".
      const foreign = await ctx.req(`/v1/workspaces/other/documents/${doc.id}/revisions`, { cookie: ada });
      expect(foreign.status).toBe(404);
      const foreignOne = await ctx.req(`/v1/workspaces/other/documents/${doc.id}/revisions/${rev!.id}`, {
        cookie: ada,
      });
      expect(foreignOne.status).toBe(404);
    });

    it("never shows another workspace's document or revisions through this one", async () => {
      const [other] = await db().insert(workspaces).values({ slug: "other", name: "Other" }).returning();
      const [foreign] = await db()
        .insert(documents)
        .values({ workspaceId: other!.id, title: "Foreign", sortOrder: "a0", content: text("secret") })
        .returning();
      const [foreignRev] = await db()
        .insert(documentRevisions)
        .values({
          workspaceId: other!.id,
          documentId: foreign!.id,
          title: "Foreign",
          content: text("secret"),
        })
        .returning();
      expect((await ctx.req(`${WS}/documents/${foreign!.id}/revisions`, { cookie: ada })).status).toBe(404);
      expect((await getRev(foreign!.id, foreignRev!.id)).status).toBe(404);
      expect((await restore(foreign!.id, foreignRev!.id)).status).toBe(404);
      // ...and a foreign revision id under one of our documents is not found either.
      const mine = await create("Mine", text("mine"));
      expect((await getRev(mine.id, foreignRev!.id)).status).toBe(404);
      expect((await restore(mine.id, foreignRev!.id)).status).toBe(404);
    });

    it("hides the history of a deleted document, and restore refuses it", async () => {
      const doc = await create("Doomed", text("v1"));
      await save(doc.id, { content: text("v2") });
      const [rev] = await list(doc.id);
      expect((await ctx.req(`${WS}/documents/${doc.id}`, { method: "DELETE", cookie: ada })).status).toBe(
        204,
      );
      expect((await ctx.req(`${WS}/documents/${doc.id}/revisions`, { cookie: ada })).status).toBe(404);
      expect((await getRev(doc.id, rev!.id)).status).toBe(404);
      expect((await getRev(doc.id, rev!.id, guest)).status).toBe(404);
      const syncBefore = (await docChanges(doc.id)).length;
      expect((await restore(doc.id, rev!.id)).status).toBe(404);
      expect((await docChanges(doc.id)).length).toBe(syncBefore);
      const stored = await db().select().from(documents).where(eq(documents.id, doc.id));
      expect(stored[0]!.deletedAt).not.toBeNull();
    });

    it("reports a null author once the account is gone", async () => {
      const doc = await create("Orphaned", text("x"), marcus);
      await db()
        .update(documentRevisions)
        .set({ authorId: null })
        .where(eq(documentRevisions.documentId, doc.id));
      expect((await list(doc.id))[0]!.authorId).toBeNull();
    });
  });
});
