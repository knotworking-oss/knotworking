import { d, type BacklinksResponse, type DocContent } from "@knotworking/core";
import {
  addWorkspaceMember,
  createPasswordUser,
  documents,
  notifications,
  syncChanges,
  tasks,
  teams,
  workflowStates,
  workspaces,
} from "@knotworking/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const WS = "/v1/workspaces/acme";
const GHOST = "019a0000-0000-7000-8000-000000000001";

describe("mentions: validation, notifications and backlinks", () => {
  let ctx: TestCtx;
  let ada: string;
  let marcus: string;
  let priya: string;
  let guest: string;
  let ids: Record<string, string>;
  let teamId: string;
  let otherWorkspaceId: string;
  let otherDocId: string;

  const call = (path: string, cookie: string, init: { method?: string; json?: unknown } = {}) =>
    ctx.req(`${WS}${path}`, { cookie, ...init });
  const inbox = async (cookie: string) =>
    (await (await call("/notifications", cookie)).json()) as {
      notifications: { type: string; taskId: string | null; actorId: string; data: Record<string, string> }[];
      unreadCount: number;
    };
  const createDoc = async (title: string, content?: DocContent, cookie = ada) => {
    const res = await call("/documents", cookie, { method: "POST", json: { title, content } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; updatedAt: string };
  };
  const patchDoc = (id: string, json: Record<string, unknown>, cookie = ada) =>
    call(`/documents/${id}`, cookie, { method: "PATCH", json });
  const createTask = async (title: string, description?: DocContent, cookie = ada) => {
    const res = await call("/tasks", cookie, { method: "POST", json: { teamId, title, description } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const backlinks = async (kind: "documents" | "tasks", id: string, cookie = ada) => {
    const res = await call(`/${kind}/${id}/backlinks`, cookie);
    return { status: res.status, body: (await res.json()) as BacklinksResponse };
  };
  const mentionOf = (u: string, name: string) => d.mention("user", u, name);

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    const cookie = async (name: string) => (await signIn(ctx, `${name}@knotworking.dev`)).cookie;
    ada = await cookie("ada");
    marcus = await cookie("marcus");
    priya = await cookie("priya");
    const boot = await (await call("/bootstrap", ada)).json();
    ids = Object.fromEntries(
      boot.users.map((u: { id: string; email: string }) => [u.email.split("@")[0], u.id]),
    );
    teamId = boot.teams[0].id;

    const { url } = await (
      await call("/invitations", ada, {
        method: "POST",
        json: { email: "guest@partner.test", role: "guest" },
      })
    ).json();
    await ctx.req(`/v1/public/invitations/${url.split("/invite/")[1]}/accept`, {
      method: "POST",
      json: { name: "Gail Guest", password: "guest-password-1" },
    });
    guest = (await signIn(ctx, "guest@partner.test", "guest-password-1")).cookie;
    ids.gail = (await (await call("/bootstrap", ada)).json()).users.find(
      (u: { email: string }) => u.email === "guest@partner.test",
    ).id;

    // A second workspace with a doc, a task and its own member, to prove nothing crosses over.
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
    const [otherTask] = await db
      .insert(tasks)
      .values({
        workspaceId: otherWorkspaceId,
        teamId: team!.id,
        stateId: state!.id,
        title: "Elsewhere",
        sortOrder: "a0",
        description: d.doc(d.p(d.mention("doc", GHOST, "x"))),
      })
      .returning();
    const [otherDoc] = await db
      .insert(documents)
      .values({ workspaceId: otherWorkspaceId, title: "Elsewhere doc", sortOrder: "a0" })
      .returning();
    otherDocId = otherDoc!.id;
    await db
      .update(documents)
      .set({ content: d.doc(d.p(d.mention("task", otherTask!.id, "Elsewhere"))) })
      .where(eq(documents.id, otherDocId));
    const outsider = await createPasswordUser(db, {
      email: "outsider@other.test",
      name: "Olive",
      password: "outsider-password-1",
    });
    await addWorkspaceMember(db, otherWorkspaceId, outsider.id, "owner");
  }, 60_000);
  afterAll(() => ctx.handle.close());

  describe("validation", () => {
    it("stores mention nodes unchanged", async () => {
      const content = d.doc(
        d.p("Ping ", mentionOf(ids.marcus!, "Marcus"), " about ", d.mention("doc", GHOST, "Plan")),
      );
      const doc = await createDoc("With mentions", content);
      const read = await (await call(`/documents/${doc.id}`, ada)).json();
      expect(read.content).toEqual(content);
    });

    it.each([
      ["an unknown kind", { kind: "team", id: GHOST, label: "x" }],
      ["a non-UUID id", { kind: "task", id: "not-a-uuid", label: "x" }],
      ["a missing label", { kind: "user", id: GHOST }],
      ["no attrs", undefined],
    ])("rejects a mention with %s", async (_name, attrs) => {
      const content = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "mention", attrs }] }],
      };
      const res = await call("/documents", ada, { method: "POST", json: { title: "Bad", content } });
      expect(res.status).toBe(400);
      const task = await call("/tasks", ada, {
        method: "POST",
        json: { teamId, title: "Bad", description: content },
      });
      expect(task.status).toBe(400);
    });

    it("rejects a mention that has content", async () => {
      const bad = d.p({ ...d.mention("user", GHOST, "x"), content: [{ type: "text", text: "no" }] });
      const res = await call("/documents", ada, {
        method: "POST",
        json: { title: "Bad", content: d.doc(bad) },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("notifications", () => {
    it("notifies a person newly mentioned in a document, never the author", async () => {
      const before = (await inbox(marcus)).notifications.length;
      const doc = await createDoc(
        "Roadmap",
        d.doc(d.p("cc ", mentionOf(ids.marcus!, "Marcus"), " ", mentionOf(ids.ada!, "Ada"))),
      );
      const box = await inbox(marcus);
      expect(box.notifications).toHaveLength(before + 1);
      expect(box.notifications[0]).toMatchObject({
        type: "mentioned",
        taskId: null,
        actorId: ids.ada,
        data: { documentId: doc.id, documentTitle: "Roadmap" },
      });
      expect((await inbox(ada)).notifications.filter((n) => n.type === "mentioned")).toEqual([]);
    });

    it("only notifies mentions a save adds, so autosaves stay quiet", async () => {
      const doc = await createDoc("Autosave", d.doc(d.p("draft")));
      const count = async () =>
        (await inbox(priya)).notifications.filter((n) => n.type === "mentioned").length;
      const base = await count();

      const withPriya = d.doc(d.p("hi ", mentionOf(ids.priya!, "Priya")));
      expect((await patchDoc(doc.id, { content: withPriya })).status).toBe(200);
      expect(await count()).toBe(base + 1);

      // Same mention again, with more text around it: nothing new.
      const more = d.doc(d.p("hi ", mentionOf(ids.priya!, "Priya"), " and more words"));
      await patchDoc(doc.id, { content: more });
      // A title-only save never looks at mentions.
      await patchDoc(doc.id, { title: "Autosave renamed" });
      expect(await count()).toBe(base + 1);

      // Another person added later is notified; the first isn't again.
      const markBefore = (await inbox(marcus)).notifications.length;
      await patchDoc(doc.id, {
        content: d.doc(d.p(mentionOf(ids.priya!, "Priya"), mentionOf(ids.marcus!, "Marcus"))),
      });
      expect(await count()).toBe(base + 1);
      expect((await inbox(marcus)).notifications).toHaveLength(markBefore + 1);
    });

    it("writes no notification when the guarded save is refused", async () => {
      const doc = await createDoc("Guarded", d.doc(d.p("x")));
      await patchDoc(doc.id, { title: "Changed elsewhere" });
      const base = (await inbox(priya)).notifications.length;
      const res = await patchDoc(doc.id, {
        content: d.doc(d.p(mentionOf(ids.priya!, "Priya"))),
        expectedUpdatedAt: doc.updatedAt,
      });
      expect(res.status).toBe(409);
      expect((await inbox(priya)).notifications).toHaveLength(base);
    });

    it("notifies from task descriptions, on create and on edit, linking to the task", async () => {
      const base = (await inbox(marcus)).notifications.length;
      const task = await createTask("Plan the launch", d.doc(d.p(mentionOf(ids.marcus!, "Marcus"))));
      let box = await inbox(marcus);
      expect(box.notifications).toHaveLength(base + 1);
      expect(box.notifications[0]).toMatchObject({
        type: "mentioned",
        taskId: task.id,
        data: { taskTitle: "Plan the launch" },
      });

      // A title edit and an unchanged description are silent; a new mention notifies.
      await call(`/tasks/${task.id}`, ada, { method: "PATCH", json: { title: "Plan the big launch" } });
      await call(`/tasks/${task.id}`, ada, {
        method: "PATCH",
        json: { description: d.doc(d.p(mentionOf(ids.marcus!, "Marcus"), " thanks")) },
      });
      expect((await inbox(marcus)).notifications).toHaveLength(base + 1);
      const priyaBase = (await inbox(priya)).notifications.length;
      await call(`/tasks/${task.id}`, ada, {
        method: "PATCH",
        json: { description: d.doc(d.p(mentionOf(ids.marcus!, "Marcus"), mentionOf(ids.priya!, "Priya"))) },
      });
      box = await inbox(priya);
      expect(box.notifications).toHaveLength(priyaBase + 1);
      expect(box.notifications[0]).toMatchObject({ type: "mentioned", taskId: task.id });
    });

    it("ignores people who are not members of this workspace, and removed members", async () => {
      const olive = (await ctx.handle.db.query.users.findFirst({
        where: (u, { eq }) => eq(u.email, "outsider@other.test"),
      }))!;
      const doc = await createDoc(
        "Strangers",
        d.doc(d.p(mentionOf(olive.id, "Olive"), mentionOf(GHOST, "Nobody"))),
      );
      expect(doc.id).toBeTruthy();
      const rows = await ctx.handle.db.select().from(notifications);
      expect(rows.filter((r) => r.userId === olive.id)).toEqual([]);
      expect(rows.filter((r) => r.userId === GHOST)).toEqual([]);
    });

    it("notifies a guest, who can read the page, and lets them follow it", async () => {
      const doc = await createDoc("For the guest", d.doc(d.p(mentionOf(ids.gail!, "Gail"))));
      const box = await inbox(guest);
      expect(box.notifications[0]).toMatchObject({ type: "mentioned", data: { documentId: doc.id } });
      expect((await call(`/documents/${doc.id}`, guest)).status).toBe(200);
    });

    it("hides a mention notification once its document is deleted", async () => {
      const doc = await createDoc("Short-lived page", d.doc(d.p(mentionOf(ids.marcus!, "Marcus"))));
      expect((await inbox(marcus)).notifications.some((n) => n.data.documentId === doc.id)).toBe(true);
      const unreadBefore = (await inbox(marcus)).unreadCount;
      await call(`/documents/${doc.id}`, ada, { method: "DELETE" });
      const box = await inbox(marcus);
      expect(box.notifications.some((n) => n.data.documentId === doc.id)).toBe(false);
      expect(box.unreadCount).toBe(unreadBefore - 1);
    });

    it("emails the mentioned person, linking to the page, unless they opted out", async () => {
      ctx.mailer.sent.length = 0;
      const doc = await createDoc("Emailed page", d.doc(d.p(mentionOf(ids.priya!, "Priya"))));
      await vi.waitFor(() => expect(ctx.mailer.sent).toHaveLength(1));
      expect(ctx.mailer.sent[0]).toMatchObject({
        to: "priya@knotworking.dev",
        subject: 'Ada Park mentioned you in "Emailed page"',
      });
      expect(ctx.mailer.sent[0]!.text).toContain(`/acme/docs/${doc.id}`);

      await call("/notifications/preferences", priya, { method: "PUT", json: { emailEnabled: false } });
      await createDoc("Silent page", d.doc(d.p(mentionOf(ids.priya!, "Priya"))));
      await new Promise((r) => setTimeout(r, 50));
      expect(ctx.mailer.sent).toHaveLength(1);
      await call("/notifications/preferences", priya, { method: "PUT", json: { emailEnabled: true } });
    });

    it("keeps notifications out of the workspace sync log", async () => {
      const log = await ctx.handle.db.select().from(syncChanges);
      expect(log.every((c) => c.entity !== ("notification" as string))).toBe(true);
    });
  });

  describe("backlinks", () => {
    it("lists the documents and tasks that mention a document, newest first", async () => {
      const target = await createDoc("Target page", d.doc(d.p("the target")));
      const a = await createDoc("Links A", d.doc(d.p(d.mention("doc", target.id, "Target page"))));
      const b = await createDoc("Links B", d.doc(d.p("x", d.mention("doc", target.id, "stale label"))));
      await createDoc("Unrelated", d.doc(d.p(d.mention("doc", GHOST, "Other"))));
      const task = await createTask("Mentions it", d.doc(d.p(d.mention("doc", target.id, "Target page"))));
      // A task mention of the same id is a different kind, so it doesn't count as a doc link.
      await createDoc("Other kind", d.doc(d.p(d.mention("task", target.id, "Target page"))));

      const { status, body } = await backlinks("documents", target.id);
      expect(status).toBe(200);
      expect(body.documents.map((x) => x.id)).toEqual([b.id, a.id]);
      expect(body.documents[0]).toMatchObject({ title: "Links B", icon: null });
      expect(body.tasks.map((x) => x.id)).toEqual([task.id]);
      expect(body.tasks[0]).toMatchObject({ title: "Mentions it", teamId });
    });

    it("lists what mentions a task, and never the row itself", async () => {
      const task = await createTask("Target task");
      const self = await call(`/tasks/${task.id}`, ada, {
        method: "PATCH",
        json: { description: d.doc(d.p(d.mention("task", task.id, "Target task"))) },
      });
      expect(self.status).toBe(200);
      const doc = await createDoc("Cites the task", d.doc(d.p(d.mention("task", task.id, "Target task"))));
      const other = await createTask("Also cites", d.doc(d.p(d.mention("task", task.id, "Target task"))));
      const { body } = await backlinks("tasks", task.id);
      expect(body.documents.map((x) => x.id)).toEqual([doc.id]);
      expect(body.tasks.map((x) => x.id)).toEqual([other.id]);
    });

    it("finds mentions nested in lists and tables", async () => {
      const target = await createDoc("Nested target");
      const nested = await createDoc(
        "Nested",
        d.doc({
          type: "bulletList",
          content: [{ type: "listItem", content: [d.p(d.mention("doc", target.id, "Nested target"))] }],
        }),
      );
      const table = await createDoc(
        "In a table",
        d.doc({
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableCell", content: [d.p(d.mention("doc", target.id, "Nested target"))] }],
            },
          ],
        }),
      );
      const { body } = await backlinks("documents", target.id);
      expect(body.documents.map((x) => x.id).sort()).toEqual([nested.id, table.id].sort());
    });

    it("drops deleted documents and tasks, and links that were removed", async () => {
      const target = await createDoc("Deletion target");
      const gone = await createDoc("Will be deleted", d.doc(d.p(d.mention("doc", target.id, "T"))));
      const edited = await createDoc("Will unlink", d.doc(d.p(d.mention("doc", target.id, "T"))));
      const keep = await createDoc("Stays", d.doc(d.p(d.mention("doc", target.id, "T"))));
      const deadTask = await createTask("Dead task", d.doc(d.p(d.mention("doc", target.id, "T"))));
      expect((await backlinks("documents", target.id)).body.documents).toHaveLength(3);

      await call(`/documents/${gone.id}`, ada, { method: "DELETE" });
      await call(`/tasks/${deadTask.id}`, ada, { method: "DELETE" });
      await patchDoc(edited.id, { content: d.doc(d.p("no link any more")) });
      const { body } = await backlinks("documents", target.id);
      expect(body.documents.map((x) => x.id)).toEqual([keep.id]);
      expect(body.tasks).toEqual([]);
    });

    it("answers 404 for a deleted or unknown target, and never crosses workspaces", async () => {
      const target = await createDoc("Soon deleted");
      await call(`/documents/${target.id}`, ada, { method: "DELETE" });
      expect((await backlinks("documents", target.id)).status).toBe(404);
      expect((await backlinks("documents", GHOST)).status).toBe(404);
      expect((await backlinks("tasks", GHOST)).status).toBe(404);
      expect((await call("/documents/not-a-uuid/backlinks", ada)).status).toBe(400);

      // The other workspace's doc isn't addressable through this one, and its mention of a task
      // never shows up here even when the ids line up.
      expect((await backlinks("documents", otherDocId)).status).toBe(404);
      const olive = (await signIn(ctx, "outsider@other.test", "outsider-password-1")).cookie;
      expect((await ctx.req(`${WS}/documents/${otherDocId}/backlinks`, { cookie: olive })).status).toBe(404);
      const ours = await createDoc(
        "Mentions elsewhere",
        d.doc(d.p(d.mention("doc", otherDocId, "Elsewhere doc"))),
      );
      expect(ours.id).toBeTruthy();
      const res = await ctx.req(`/v1/workspaces/other/documents/${otherDocId}/backlinks`, { cookie: olive });
      expect(res.status).toBe(200);
      expect(((await res.json()) as BacklinksResponse).documents).toEqual([]);
    });

    it("is readable by guests and requires a session", async () => {
      const target = await createDoc("Guest readable");
      await createDoc("Linker", d.doc(d.p(d.mention("doc", target.id, "x"))));
      expect((await backlinks("documents", target.id, guest)).body.documents).toHaveLength(1);
      expect((await ctx.req(`${WS}/documents/${target.id}/backlinks`)).status).toBe(401);
    });

    it("is bounded", async () => {
      const target = await createDoc("Popular");
      const content = d.doc(d.p(d.mention("doc", target.id, "Popular")));
      const db = ctx.handle.db;
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, "acme"));
      await db.insert(documents).values(
        Array.from({ length: 60 }, (_, i) => ({
          workspaceId: ws!.id,
          title: `Fan ${i}`,
          sortOrder: `z${i}`,
          content,
        })),
      );
      expect((await backlinks("documents", target.id)).body.documents).toHaveLength(50);
    });
  });
});
