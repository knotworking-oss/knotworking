import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sortKeyBetween } from "@knotworking/core";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const W = "/v1/workspaces/acme";

describe("workspace structure: teams, workflow states and labels", () => {
  let ctx: TestCtx;
  let ada: string; // owner
  let marcus: string; // member
  let noor: string; // promoted to admin
  let ids: Record<string, string>;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${W}/members`, { cookie: ada })).json();
    ids = Object.fromEntries(
      members.map((m: { email: string; userId: string }) => [m.email.split("@")[0], m.userId]),
    );
    await ctx.req(`${W}/members/${ids.noor}`, { method: "PATCH", cookie: ada, json: { role: "admin" } });
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    noor = (await signIn(ctx, "noor@knotworking.dev")).cookie;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  const boot = async () => (await ctx.req(`${W}/bootstrap`, { cookie: ada })).json();
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${W}${path}`, { method, cookie, ...(json === undefined ? {} : { json }) });
  const changesAfter = async (cursor: string) =>
    (await (await ctx.req(`${W}/sync?after=${cursor}`, { cookie: ada })).json()).changes as {
      entity: string;
      entityId: string;
      action: string;
      data: any;
    }[];
  const createTeam = async (key: string, extra: object = {}) => {
    const res = await call("POST", "/teams", { key, name: `Team ${key}`, ...extra });
    expect(res.status).toBe(201);
    return res.json();
  };
  const statesOf = (b: any, teamId: string) =>
    b.workflowStates.filter((s: any) => s.teamId === teamId) as { id: string; name: string; type: string }[];
  const newTask = async (teamId: string, stateId: string, title = "A task") => {
    const res = await call("POST", "/tasks", { teamId, stateId, title });
    expect(res.status).toBe(201);
    return res.json();
  };

  describe("permissions", () => {
    it("requires a session", async () => {
      const res = await ctx.req(`${W}/teams`, { method: "POST", json: { key: "NOPE", name: "Nope" } });
      expect(res.status).toBe(401);
    });

    it("limits every structural route to owners and admins", async () => {
      const b = await boot();
      const team = b.teams[0];
      const state = b.workflowStates.find((s: any) => s.teamId === team.id);
      const label = b.labels[0];
      const attempts: [string, string, unknown?][] = [
        ["GET", "/teams/archived"],
        ["POST", "/teams", { key: "MEM", name: "Members' team" }],
        ["PATCH", `/teams/${team.id}`, { name: "Renamed" }],
        ["POST", `/teams/${team.id}/members`, { userId: ids.marcus }],
        ["DELETE", `/teams/${team.id}/members/${ids.ada}`],
        ["POST", `/teams/${team.id}/states`, { name: "QA", type: "started" }],
        ["PATCH", `/states/${state.id}`, { name: "Renamed" }],
        ["DELETE", `/states/${state.id}`],
        ["POST", "/labels", { name: "Sneaky" }],
        ["PATCH", `/labels/${label.id}`, { name: "Renamed" }],
        ["DELETE", `/labels/${label.id}`],
      ];
      for (const [method, path, json] of attempts) {
        const res = await call(method, path, json, marcus);
        expect([method, path, res.status]).toEqual([method, path, 403]);
      }
      // Nothing changed.
      const after = await boot();
      expect(after.teams).toHaveLength(b.teams.length);
      expect(after.labels).toHaveLength(b.labels.length);
      expect(after.workflowStates).toHaveLength(b.workflowStates.length);
    });

    it("lets admins (not just owners) manage structure", async () => {
      const res = await call("POST", "/labels", { name: "Made by an admin", color: "teal" }, noor);
      expect(res.status).toBe(201);
    });

    it("blocks writes from other origins", async () => {
      const res = await ctx.req(`${W}/labels`, {
        method: "POST",
        cookie: ada,
        headers: { origin: "https://evil.example" },
        json: { name: "CSRF" },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("teams", () => {
    it("creates a team with the default workflow and members", async () => {
      const cursor = (await boot()).cursor;
      const team = await createTeam("eng", {
        icon: "🛠️",
        color: "blue",
        memberIds: [ids.ada, ids.priya],
      });
      expect(team).toMatchObject({ key: "ENG", name: "Team eng", color: "blue" });

      const b = await boot();
      expect(statesOf(b, team.id).map((s) => [s.name, s.type])).toEqual([
        ["Backlog", "backlog"],
        ["Todo", "unstarted"],
        ["In Progress", "started"],
        ["In Review", "started"],
        ["Done", "completed"],
        ["Canceled", "canceled"],
      ]);
      expect(
        b.teamMembers
          .filter((m: any) => m.teamId === team.id)
          .map((m: any) => m.userId)
          .sort(),
      ).toEqual([ids.ada, ids.priya].sort());

      const log = await changesAfter(cursor);
      expect(log.filter((c) => c.entity === "team" && c.entityId === team.id)).toHaveLength(1);
      expect(log.filter((c) => c.entity === "workflow_state")).toHaveLength(6);
      expect(log.filter((c) => c.entity === "team_member")).toHaveLength(2);

      // The new team is usable right away.
      const todo = statesOf(b, team.id).find((s) => s.name === "Todo")!;
      expect((await newTask(team.id, todo.id)).teamId).toBe(team.id);
    });

    it("validates keys, names and members, and keeps keys unique", async () => {
      expect((await call("POST", "/teams", { key: "x", name: "Too short" })).status).toBe(400);
      expect((await call("POST", "/teams", { key: "1ABC", name: "Starts with digit" })).status).toBe(400);
      expect((await call("POST", "/teams", { key: "OKAY", name: "  " })).status).toBe(400);
      expect(
        (await call("POST", "/teams", { key: "OKAY", name: "Ghosts", memberIds: [crypto.randomUUID()] }))
          .status,
      ).toBe(400);
      const dupe = await call("POST", "/teams", { key: "mkt", name: "Another marketing" });
      expect(dupe.status).toBe(409);
      expect((await dupe.json()).error.code).toBe("team_key_taken");
    });

    it("renames a team and syncs the change", async () => {
      const team = await createTeam("ren");
      const cursor = (await boot()).cursor;
      const res = await call("PATCH", `/teams/${team.id}`, {
        name: "Renamed",
        description: "What we do",
        key: "rnm",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ name: "Renamed", key: "RNM", description: "What we do" });
      const log = await changesAfter(cursor);
      expect(log).toEqual([expect.objectContaining({ entity: "team", entityId: team.id, action: "upsert" })]);
      expect(log[0]!.data.name).toBe("Renamed");

      expect((await call("PATCH", `/teams/${team.id}`, { key: "MKT" })).status).toBe(409);
      expect((await call("PATCH", `/teams/${crypto.randomUUID()}`, { name: "x" })).status).toBe(404);
      expect((await call("PATCH", `/teams/${team.id}`, {})).status).toBe(200); // no-op
    });

    it("archives and restores a team, hiding its tasks meanwhile", async () => {
      const team = await createTeam("arc");
      const b0 = await boot();
      const todo = statesOf(b0, team.id).find((s) => s.type === "unstarted")!;
      const task = await newTask(team.id, todo.id, "Lives in an archived team");

      const cursor = (await boot()).cursor;
      expect((await call("PATCH", `/teams/${team.id}`, { archived: true })).status).toBe(200);
      expect(await changesAfter(cursor)).toEqual([
        expect.objectContaining({ entity: "team", entityId: team.id, action: "delete" }),
        expect.objectContaining({ entity: "task", entityId: task.id, action: "delete" }),
      ]);

      const b1 = await boot();
      expect(b1.teams.some((t: any) => t.id === team.id)).toBe(false);
      expect(b1.tasks.some((t: any) => t.id === task.id)).toBe(false);
      const archived = await (await call("GET", "/teams/archived")).json();
      expect(archived.teams.map((t: any) => t.id)).toContain(team.id);

      // Archived teams can't be edited or used, and keep their key.
      expect((await call("PATCH", `/teams/${team.id}`, { name: "Nope" })).status).toBe(409);
      expect((await call("POST", "/tasks", { teamId: team.id, title: "Nope" })).status).toBe(400);
      expect((await call("POST", `/teams/${team.id}/members`, { userId: ids.ada })).status).toBe(404);
      const clash = await call("POST", "/teams", { key: "ARC", name: "Again" });
      expect(clash.status).toBe(409);
      expect((await clash.json()).error.message).toContain("archived");

      expect((await call("PATCH", `/teams/${team.id}`, { archived: false })).status).toBe(200);
      const b2 = await boot();
      expect(b2.teams.some((t: any) => t.id === team.id)).toBe(true);
      expect(b2.tasks.some((t: any) => t.id === task.id)).toBe(true);
    });

    it("logs task deletes on archive and task upserts on restore", async () => {
      const team = await createTeam("trk");
      const todo = statesOf(await boot(), team.id).find((s) => s.type === "unstarted")!;
      const a = await newTask(team.id, todo.id, "Tracked A");
      const b = await newTask(team.id, todo.id, "Tracked B");
      const gone = await newTask(team.id, todo.id, "Deleted before archive");
      expect((await call("DELETE", `/tasks/${gone.id}`)).status).toBeLessThan(300);

      // A client that loaded before the archive.
      const before = await boot();
      const archivedAt = before.cursor;
      expect((await call("PATCH", `/teams/${team.id}`, { archived: true })).status).toBe(200);
      const archiveLog = await changesAfter(archivedAt);
      const taskDeletes = archiveLog.filter((c) => c.entity === "task");
      expect(taskDeletes.map((c) => [c.action, c.entityId]).sort()).toEqual(
        [a.id, b.id].map((id) => ["delete", id]).sort(),
      );
      expect(archiveLog.filter((c) => c.entity === "team")).toEqual([
        expect.objectContaining({ entityId: team.id, action: "delete" }),
      ]);

      // A client that bootstraps while the team is archived sees neither team nor tasks.
      const whileArchived = await boot();
      expect(whileArchived.tasks.some((t: any) => t.teamId === team.id)).toBe(false);

      // Archiving twice is rejected.
      expect((await call("PATCH", `/teams/${team.id}`, { archived: true })).status).toBe(409);

      const restoredFrom = whileArchived.cursor;
      expect((await call("PATCH", `/teams/${team.id}`, { archived: false })).status).toBe(200);
      const restoreLog = await changesAfter(restoredFrom);
      const upserts = restoreLog.filter((c) => c.entity === "task");
      expect(upserts.every((c) => c.action === "upsert")).toBe(true);
      expect(upserts.map((c) => c.entityId).sort()).toEqual([a.id, b.id].sort());
      expect(upserts.find((c) => c.entityId === a.id)!.data).toMatchObject({
        id: a.id,
        teamId: team.id,
        title: "Tracked A",
        stateId: todo.id,
      });
      expect(restoreLog.filter((c) => c.entity === "team")).toEqual([
        expect.objectContaining({ entityId: team.id, action: "upsert" }),
      ]);

      // /sync from the "loaded while archived" cursor repopulates the tasks.
      const after = await boot();
      expect(
        after.tasks
          .filter((t: any) => t.teamId === team.id)
          .map((t: any) => t.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());

      // Restoring a team that is already live is a plain team upsert.
      const noop = (await boot()).cursor;
      expect((await call("PATCH", `/teams/${team.id}`, { archived: false })).status).toBe(200);
      expect((await changesAfter(noop)).map((c) => c.entity)).toEqual(["team"]);
    });

    it("manages team members", async () => {
      const team = await createTeam("mem");
      const members = async () =>
        (await boot()).teamMembers.filter((m: any) => m.teamId === team.id).map((m: any) => m.userId);

      const added = await call("POST", `/teams/${team.id}/members`, { userId: ids.tomas });
      expect(added.status).toBe(201);
      expect(await members()).toEqual([ids.tomas]);
      // Adding again is a no-op.
      expect((await call("POST", `/teams/${team.id}/members`, { userId: ids.tomas })).status).toBe(200);
      expect(await members()).toEqual([ids.tomas]);
      // Only active workspace members can join.
      expect((await call("POST", `/teams/${team.id}/members`, { userId: crypto.randomUUID() })).status).toBe(
        400,
      );

      const cursor = (await boot()).cursor;
      expect((await call("DELETE", `/teams/${team.id}/members/${ids.tomas}`)).status).toBe(204);
      expect(await members()).toEqual([]);
      expect(await changesAfter(cursor)).toEqual([
        expect.objectContaining({
          entity: "team_member",
          entityId: (await added.json()).id,
          action: "delete",
        }),
      ]);
      expect((await call("DELETE", `/teams/${team.id}/members/${ids.tomas}`)).status).toBe(404);
    });
  });

  describe("workflow states", () => {
    it("creates states in category order, renames and reorders them", async () => {
      const team = await createTeam("wfl");
      const list = async () => statesOf(await boot(), team.id).map((s) => s.name);

      const qa = await (
        await call("POST", `/teams/${team.id}/states`, { name: "QA", type: "started" })
      ).json();
      expect(await list()).toEqual(["Backlog", "Todo", "In Progress", "In Review", "QA", "Done", "Canceled"]);
      const triage = await (
        await call("POST", `/teams/${team.id}/states`, { name: "Triage", type: "backlog" })
      ).json();
      expect(await list()).toEqual([
        "Backlog",
        "Triage",
        "Todo",
        "In Progress",
        "In Review",
        "QA",
        "Done",
        "Canceled",
      ]);

      const renamed = await call("PATCH", `/states/${qa.id}`, {
        name: "Quality check",
        description: "Testing",
      });
      expect(await renamed.json()).toMatchObject({
        name: "Quality check",
        description: "Testing",
        type: "started",
      });

      // Reorder: move "Triage" to just before "In Progress".
      const states = (await boot()).workflowStates.filter((s: any) => s.teamId === team.id);
      const todo = states.find((s: any) => s.name === "Todo");
      const progress = states.find((s: any) => s.name === "In Progress");
      const moved = await call("PATCH", `/states/${triage.id}`, {
        sortOrder: sortKeyBetween(todo.sortOrder, progress.sortOrder),
      });
      expect(moved.status).toBe(200);
      expect(await list()).toEqual([
        "Backlog",
        "Todo",
        "Triage",
        "In Progress",
        "In Review",
        "Quality check",
        "Done",
        "Canceled",
      ]);

      expect((await call("PATCH", `/states/${triage.id}`, { sortOrder: "not a key!" })).status).toBe(400);
      expect((await call("PATCH", `/states/${triage.id}`, { type: "nonsense" })).status).toBe(400);
      expect((await call("PATCH", `/states/${crypto.randomUUID()}`, { name: "x" })).status).toBe(404);
    });

    it("keeps lifecycle timestamps in step when a state changes category", async () => {
      const team = await createTeam("cat");
      const b = await boot();
      const review = statesOf(b, team.id).find((s) => s.name === "In Review")!;
      const task = await newTask(team.id, review.id);
      expect(task).toMatchObject({ completedAt: null });
      expect(task.startedAt).not.toBeNull();

      const cursor = (await boot()).cursor;
      // "In Review" becomes a completed state: its tasks now count as done.
      expect((await call("PATCH", `/states/${review.id}`, { type: "completed" })).status).toBe(200);
      const after = (await (await call("GET", `/tasks/${task.id}`)).json()) as any;
      expect(after.completedAt).not.toBeNull();
      expect(after.startedAt).toBe(task.startedAt);
      expect((await changesAfter(cursor)).map((c) => c.entity).sort()).toEqual(["task", "workflow_state"]);

      // ...and back to "started".
      await call("PATCH", `/states/${review.id}`, { type: "started" });
      expect(((await (await call("GET", `/tasks/${task.id}`)).json()) as any).completedAt).toBeNull();
    });

    it("refuses to delete a state that still has tasks", async () => {
      const team = await createTeam("use");
      const b = await boot();
      const review = statesOf(b, team.id).find((s) => s.name === "In Review")!;
      const task = await newTask(team.id, review.id);
      await newTask(team.id, review.id, "Second");

      const res = await call("DELETE", `/states/${review.id}`);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatchObject({ code: "state_in_use", details: { taskCount: 2 } });
      // Nothing happened.
      expect(statesOf(await boot(), team.id).map((s) => s.id)).toContain(review.id);
      expect(((await (await call("GET", `/tasks/${task.id}`)).json()) as any).stateId).toBe(review.id);

      // Deleted tasks don't count.
      const empty = statesOf(b, team.id).find((s) => s.name === "Backlog")!;
      const stray = await newTask(team.id, empty.id, "Stray");
      expect((await call("DELETE", `/states/${empty.id}`)).status).toBe(409);
      await call("DELETE", `/tasks/${stray.id}`);
      expect((await call("DELETE", `/states/${empty.id}`)).status).toBe(204);
    });

    it("moves tasks to another state when asked, then deletes the state", async () => {
      const team = await createTeam("mov");
      const other = await createTeam("oth");
      const b = await boot();
      const review = statesOf(b, team.id).find((s) => s.name === "In Review")!;
      const done = statesOf(b, team.id).find((s) => s.name === "Done")!;
      const task = await newTask(team.id, review.id);

      // Targets must be real states of the same team, other than the one being deleted.
      const foreign = statesOf(b, other.id)[0]!;
      expect((await call("DELETE", `/states/${review.id}?moveTasksTo=${foreign.id}`)).status).toBe(400);
      expect((await call("DELETE", `/states/${review.id}?moveTasksTo=${review.id}`)).status).toBe(400);
      expect((await call("DELETE", `/states/${review.id}?moveTasksTo=${crypto.randomUUID()}`)).status).toBe(
        400,
      );
      expect((await call("DELETE", `/states/${review.id}?moveTasksTo=nope`)).status).toBe(400);

      const cursor = (await boot()).cursor;
      expect((await call("DELETE", `/states/${review.id}?moveTasksTo=${done.id}`)).status).toBe(204);
      const moved = (await (await call("GET", `/tasks/${task.id}`)).json()) as any;
      expect(moved.stateId).toBe(done.id);
      expect(moved.completedAt).not.toBeNull(); // follows the new category
      expect(statesOf(await boot(), team.id).map((s) => s.id)).not.toContain(review.id);

      const log = await changesAfter(cursor);
      expect(log).toContainEqual(
        expect.objectContaining({ entity: "workflow_state", entityId: review.id, action: "delete" }),
      );
      expect(log).toContainEqual(
        expect.objectContaining({ entity: "task", entityId: task.id, action: "upsert" }),
      );
      expect((await call("DELETE", `/states/${review.id}`)).status).toBe(404);
    });

    it("never leaves a team without an open state or a Done state", async () => {
      const team = await createTeam("min");
      const states = statesOf(await boot(), team.id);
      const byName = (n: string) => states.find((s) => s.name === n)!;

      expect((await call("DELETE", `/states/${byName("Done").id}`)).status).toBe(409);
      expect((await call("PATCH", `/states/${byName("Done").id}`, { type: "canceled" })).status).toBe(409);
      for (const n of ["Backlog", "Todo", "In Progress"]) {
        expect((await call("DELETE", `/states/${byName(n).id}`)).status).toBe(204);
      }
      const last = await call("DELETE", `/states/${byName("In Review").id}`);
      expect(last.status).toBe(409);
      expect((await last.json()).error.code).toBe("invalid_workflow");
      // The refused delete rolled back completely.
      expect(statesOf(await boot(), team.id).map((s) => s.name)).toEqual(["In Review", "Done", "Canceled"]);
    });
  });

  describe("labels", () => {
    it("creates, edits and deletes labels", async () => {
      const cursor = (await boot()).cursor;
      const res = await call("POST", "/labels", { name: "  Urgent fix ", color: "red" });
      expect(res.status).toBe(201);
      const label = await res.json();
      expect(label).toMatchObject({ name: "Urgent fix", color: "red", teamId: null });
      expect((await boot()).labels.map((l: any) => l.id)).toContain(label.id);

      const edited = await call("PATCH", `/labels/${label.id}`, { name: "Hotfix", color: "orange" });
      expect(await edited.json()).toMatchObject({ name: "Hotfix", color: "orange" });

      expect((await call("DELETE", `/labels/${label.id}`)).status).toBe(204);
      expect((await boot()).labels.map((l: any) => l.id)).not.toContain(label.id);
      expect((await call("DELETE", `/labels/${label.id}`)).status).toBe(404);
      expect((await call("PATCH", `/labels/${label.id}`, { name: "Gone" })).status).toBe(404);

      const log = (await changesAfter(cursor)).filter((c) => c.entityId === label.id);
      expect(log.map((c) => c.action)).toEqual(["upsert", "upsert", "delete"]);
    });

    it("validates labels and keeps names unique per scope", async () => {
      expect((await call("POST", "/labels", { name: "" })).status).toBe(400);
      expect((await call("POST", "/labels", { name: "Fine", color: "chartreuse" })).status).toBe(400);
      const dupe = await call("POST", "/labels", { name: "client REQUEST" });
      expect(dupe.status).toBe(409);
      expect((await dupe.json()).error.code).toBe("label_exists");

      const b = await boot();
      const hiring = b.labels.find((l: any) => l.name === "Hiring");
      expect((await call("PATCH", `/labels/${hiring.id}`, { name: "content" })).status).toBe(409);
      // Renaming to itself (or just recolouring) is fine.
      expect((await call("PATCH", `/labels/${hiring.id}`, { name: "Hiring", color: "blue" })).status).toBe(
        200,
      );

      // Team-scoped labels live in their own namespace and need a live team.
      const team = b.teams[0];
      const scoped = await call("POST", "/labels", { name: "Content", teamId: team.id });
      expect(scoped.status).toBe(201);
      expect((await scoped.json()).teamId).toBe(team.id);
      expect((await call("POST", "/labels", { name: "Ghost", teamId: crypto.randomUUID() })).status).toBe(
        400,
      );
    });

    it("removes a deleted label from the tasks that had it", async () => {
      const team = await createTeam("lbl");
      const label = await (await call("POST", "/labels", { name: "Temporary" })).json();
      const todo = statesOf(await boot(), team.id).find((s) => s.type === "unstarted")!;
      const res = await call("POST", "/tasks", {
        teamId: team.id,
        stateId: todo.id,
        title: "Labelled",
        labelIds: [label.id],
      });
      const task = await res.json();
      expect(task.labelIds).toEqual([label.id]);

      const cursor = (await boot()).cursor;
      expect((await call("DELETE", `/labels/${label.id}`)).status).toBe(204);
      expect(((await (await call("GET", `/tasks/${task.id}`)).json()) as any).labelIds).toEqual([]);
      expect((await boot()).tasks.find((t: any) => t.id === task.id).labelIds).toEqual([]);
      expect((await changesAfter(cursor)).map((c) => [c.entity, c.action])).toEqual([
        ["task_label", "delete"],
        ["label", "delete"],
      ]);

      // The deleted label can't be attached any more.
      const again = await call("PATCH", `/tasks/${task.id}`, { title: "Relabelled", labelIds: [label.id] });
      expect(again.status).toBe(400);
    });
  });
});
