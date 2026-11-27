import { newId, textToDoc } from "@knotworking/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestCtx } from "./test-utils";

const W = "/v1/workspaces/acme";

interface Change {
  entity: string;
  entityId: string;
  action: string;
  data: any;
}

describe("task start dates and dependencies", () => {
  let ctx: TestCtx;
  let ada: string; // owner
  let marcus: string; // demoted to guest
  let teamId: string;

  beforeAll(async () => {
    ctx = await makeApp({ seed: true });
    ada = (await signIn(ctx, "ada@knotworking.dev")).cookie;
    const { members } = await (await ctx.req(`${W}/members`, { cookie: ada })).json();
    const marcusId = members.find((m: { email: string }) => m.email.startsWith("marcus@")).userId;
    await ctx.req(`${W}/members/${marcusId}`, { method: "PATCH", cookie: ada, json: { role: "guest" } });
    marcus = (await signIn(ctx, "marcus@knotworking.dev")).cookie;
    teamId = (await boot()).teams[0].id;
  }, 60_000);
  afterAll(() => ctx.handle.close());

  async function boot() {
    return (await ctx.req(`${W}/bootstrap`, { cookie: ada })).json();
  }
  const call = (method: string, path: string, json?: unknown, cookie = ada) =>
    ctx.req(`${W}${path}`, { method, cookie, ...(json === undefined ? {} : { json }) });
  const cursor = async (): Promise<string> => (await boot()).cursor;
  const changesAfter = async (after: string) =>
    (await (await ctx.req(`${W}/sync?after=${after}`, { cookie: ada })).json()).changes as Change[];
  const newTask = async (title: string, extra: object = {}, team = teamId) => {
    const res = await call("POST", "/tasks", { teamId: team, title, ...extra });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; startDate: string | null; dueDate: string | null };
  };
  const relate = (blockingTaskId: string, blockedTaskId: string, extra: object = {}) =>
    call("POST", "/task-relations", { blockingTaskId, blockedTaskId, ...extra });

  it("pages task activity, recording real changes and both ends of dependencies", async () => {
    const seeded = await boot();
    const oldActivity = await call("GET", `/tasks/${seeded.tasks[0].id}/activity`);
    expect(oldActivity.status).toBe(200);
    expect(await oldActivity.json()).toEqual({ events: [], nextCursor: null });
    const a = await newTask("Plan");
    const b = await newTask("Build");
    const path = `/tasks/${a.id}/activity`;
    const labelId = seeded.labels[0].id;
    const change = { title: "Design", description: textToDoc("Draft content"), labelIds: [labelId] };
    expect((await call("PATCH", `/tasks/${a.id}`, change)).status).toBe(200);
    expect((await call("PATCH", `/tasks/${a.id}`, change)).status).toBe(200);
    expect((await call("PATCH", `/tasks/${a.id}`, { labelIds: [newId()] })).status).toBe(400);

    const relation = await relate(a.id, b.id);
    expect(relation.status).toBe(201);
    const { id } = await relation.json();
    expect((await call("DELETE", `/task-relations/${id}`)).status).toBe(204);

    const response = await call("GET", `${path}?limit=2`, undefined, marcus);
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first.events.map((event: { details: { kind: string } }) => event.details.kind)).toEqual([
      "dependency_removed",
      "dependency_added",
    ]);
    expect(first.nextCursor).toBe(first.events[1].id);
    const second = await (await call("GET", `${path}?limit=2&before=${first.nextCursor}`)).json();
    expect(second).toMatchObject({
      events: [
        {
          source: "session",
          details: {
            kind: "updated",
            changes: {
              title: { from: "Plan", to: "Design" },
              description: { from: false, to: true },
              labelIds: { from: [], to: [labelId] },
            },
          },
        },
        { details: { kind: "created" } },
      ],
      nextCursor: null,
    });
    const other = await (await call("GET", `/tasks/${b.id}/activity`)).json();
    expect(other.events[0].details).toEqual({
      kind: "dependency_removed",
      blockingTaskId: a.id,
      blockedTaskId: b.id,
    });
    expect((await call("GET", `${path}?limit=101`)).status).toBe(400);
    expect((await call("DELETE", `/tasks/${a.id}`)).status).toBe(204);
    expect((await call("GET", path)).status).toBe(404);
  });

  describe("start dates", () => {
    it("sets a start date on create and update, and syncs it", async () => {
      const task = await newTask("Plan the launch", { startDate: "2026-12-01", dueDate: "2026-12-10" });
      expect(task).toMatchObject({ startDate: "2026-12-01", dueDate: "2026-12-10" });

      const before = await cursor();
      const res = await call("PATCH", `/tasks/${task.id}`, { startDate: "2026-12-03" });
      expect(res.status).toBe(200);
      expect((await res.json()).startDate).toBe("2026-12-03");
      const changes = await changesAfter(before);
      expect(changes).toEqual([
        expect.objectContaining({
          entity: "task",
          action: "upsert",
          data: expect.objectContaining({ startDate: "2026-12-03" }),
        }),
      ]);
      const b = await boot();
      expect(b.tasks.find((t: { id: string }) => t.id === task.id).startDate).toBe("2026-12-03");

      // Clearing it.
      const cleared = await call("PATCH", `/tasks/${task.id}`, { startDate: null });
      expect((await cleared.json()).startDate).toBeNull();
    });

    it("rejects a start date after the due date", async () => {
      const created = await call("POST", "/tasks", {
        teamId,
        title: "Backwards",
        startDate: "2026-12-10",
        dueDate: "2026-12-01",
      });
      expect(created.status).toBe(400);

      const task = await newTask("Dated", { startDate: "2026-12-01", dueDate: "2026-12-10" });
      const before = await cursor();
      // Both in one PATCH (schema), and each one against the stored other (server).
      for (const patch of [
        { startDate: "2026-12-20", dueDate: "2026-12-11" },
        { startDate: "2026-12-11" },
        { dueDate: "2026-11-30" },
      ]) {
        const res = await call("PATCH", `/tasks/${task.id}`, patch);
        expect([patch, res.status]).toEqual([patch, 400]);
        expect((await res.json()).error.code).toBe("invalid_input");
      }
      expect(await changesAfter(before)).toEqual([]);

      // Same day is fine, and moving both together is fine.
      expect((await call("PATCH", `/tasks/${task.id}`, { startDate: "2026-12-10" })).status).toBe(200);
      expect(
        (await call("PATCH", `/tasks/${task.id}`, { startDate: "2027-01-05", dueDate: "2027-01-09" })).status,
      ).toBe(200);
    });
  });

  describe("relations", () => {
    it("creates a relation, records it in the sync log and lists it in the bootstrap", async () => {
      const a = await newTask("Design");
      const b = await newTask("Build");
      const before = await cursor();
      const id = newId();
      const res = await relate(a.id, b.id, { id });
      expect(res.status).toBe(201);
      const rel = await res.json();
      expect(rel).toMatchObject({ id, blockingTaskId: a.id, blockedTaskId: b.id });
      expect(rel).not.toHaveProperty("workspaceId");

      const changes = await changesAfter(before);
      expect(changes).toEqual([
        expect.objectContaining({
          entity: "task_relation",
          entityId: id,
          action: "upsert",
          data: expect.objectContaining({ blockingTaskId: a.id, blockedTaskId: b.id }),
        }),
      ]);
      expect((await boot()).taskRelations).toContainEqual(expect.objectContaining({ id }));

      // Deleting it writes a tombstone and frees the pair.
      const before2 = await cursor();
      expect((await call("DELETE", `/task-relations/${id}`)).status).toBe(204);
      expect(await changesAfter(before2)).toEqual([
        expect.objectContaining({ entity: "task_relation", entityId: id, action: "delete", data: null }),
      ]);
      expect((await boot()).taskRelations.some((r: { id: string }) => r.id === id)).toBe(false);
      expect((await call("DELETE", `/task-relations/${id}`)).status).toBe(404);
      expect((await relate(a.id, b.id)).status).toBe(201);
    });

    it("rejects self-relations, duplicates and unknown tasks", async () => {
      const a = await newTask("Solo");
      const b = await newTask("Pair");
      const self = await relate(a.id, a.id);
      expect(self.status).toBe(400);

      expect((await relate(a.id, b.id)).status).toBe(201);
      const dup = await relate(a.id, b.id);
      expect(dup.status).toBe(409);
      expect((await dup.json()).error.code).toBe("relation_exists");

      const unknown = await relate(a.id, newId());
      expect(unknown.status).toBe(404);
    });

    it("rejects cycles, direct and transitive, without writing anything", async () => {
      const a = await newTask("Cycle A");
      const b = await newTask("Cycle B");
      const c = await newTask("Cycle C");
      const d = await newTask("Cycle D");
      expect((await relate(a.id, b.id)).status).toBe(201);
      expect((await relate(b.id, c.id)).status).toBe(201);
      expect((await relate(c.id, d.id)).status).toBe(201);

      const before = await cursor();
      for (const [from, to] of [
        [b, a], // the reverse of an existing pair
        [c, a],
        [d, a], // a → b → c → d → a
        [d, b],
      ] as const) {
        const res = await relate(from.id, to.id);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe("relation_cycle");
        expect(body.error.message).toMatch(/circular/i);
      }
      expect(await changesAfter(before)).toEqual([]);

      // Diamonds are fine: a → d is redundant but not circular.
      expect((await relate(a.id, d.id)).status).toBe(201);
    });

    it("keeps guests read-only", async () => {
      const a = await newTask("Guest A");
      const b = await newTask("Guest B");
      expect((await relate(a.id, b.id, {})).status).toBe(201);
      const rel = (await boot()).taskRelations.find(
        (r: { blockedTaskId: string }) => r.blockedTaskId === b.id,
      );
      expect(
        (await call("POST", "/task-relations", { blockingTaskId: b.id, blockedTaskId: newId() }, marcus))
          .status,
      ).toBe(403);
      expect((await call("DELETE", `/task-relations/${rel.id}`, undefined, marcus)).status).toBe(403);
      // Guests still read relations.
      const guestBoot = await (await ctx.req(`${W}/bootstrap`, { cookie: marcus })).json();
      expect(guestBoot.taskRelations).toContainEqual(expect.objectContaining({ id: rel.id }));
    });

    it("deletes a deleted task's relations, with tombstones", async () => {
      const a = await newTask("Doomed");
      const b = await newTask("Blocked by doomed");
      const c = await newTask("Blocked by b");
      const ab = await (await relate(a.id, b.id)).json();
      const bc = await (await relate(b.id, c.id)).json();

      const before = await cursor();
      expect((await call("DELETE", `/tasks/${b.id}`)).status).toBe(204);
      const changes = await changesAfter(before);
      expect(changes[0]).toMatchObject({ entity: "task", entityId: b.id, action: "delete" });
      expect(
        changes
          .slice(1)
          .map((ch) => [ch.entity, ch.entityId, ch.action])
          .sort(),
      ).toEqual([ab.id, bc.id].sort().map((id) => ["task_relation", id, "delete"]));
      const ids = (await boot()).taskRelations.map((r: { id: string }) => r.id);
      expect(ids).not.toContain(ab.id);
      expect(ids).not.toContain(bc.id);
      // A deleted task can't be linked.
      expect((await relate(a.id, b.id)).status).toBe(404);
    });

    it("hides relations of an archived team's tasks and re-sends them on restore", async () => {
      const created = await call("POST", "/teams", { key: "DEPS", name: "Dependencies" });
      expect(created.status).toBe(201);
      const team = await created.json();
      const inside = await newTask("Ops task", {}, team.id);
      const outside = await newTask("Depends on ops");
      const rel = await (await relate(inside.id, outside.id)).json();

      const before = await cursor();
      expect((await call("PATCH", `/teams/${team.id}`, { archived: true })).status).toBe(200);
      expect(await changesAfter(before)).toContainEqual(
        expect.objectContaining({ entity: "task_relation", entityId: rel.id, action: "delete" }),
      );
      expect((await boot()).taskRelations.some((r: { id: string }) => r.id === rel.id)).toBe(false);
      // Tasks of an archived team can't be linked.
      expect((await relate(outside.id, inside.id)).status).toBe(404);
      expect((await call("GET", `/tasks/${inside.id}/activity`)).status).toBe(404);

      const before2 = await cursor();
      expect((await call("PATCH", `/teams/${team.id}`, { archived: false })).status).toBe(200);
      expect(await changesAfter(before2)).toContainEqual(
        expect.objectContaining({
          entity: "task_relation",
          entityId: rel.id,
          action: "upsert",
          data: expect.objectContaining({ blockingTaskId: inside.id, blockedTaskId: outside.id }),
        }),
      );
      expect((await boot()).taskRelations).toContainEqual(expect.objectContaining({ id: rel.id }));
      expect((await call("GET", `/tasks/${inside.id}/activity`)).status).toBe(200);
      // While it was hidden the relation still counted for cycle checks, so restoring can't reveal a cycle.
      expect((await relate(outside.id, inside.id)).status).toBe(409);
    });
  });
});
