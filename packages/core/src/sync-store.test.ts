import { describe, expect, it } from "vitest";
import {
  applyChanges,
  backoffDelay,
  compareCursors,
  deleteWhere,
  getRow,
  getTable,
  patchRow,
  syncEntityTypes,
  SyncStore,
  tablesFromRows,
  upsertRow,
  type SyncChange,
  type SyncPage,
} from "./index";

let nextCursor = 0;
const change = (
  entity: string,
  entityId: string,
  data: Record<string, unknown> | null,
  id = String(++nextCursor),
): SyncChange => ({
  id,
  entity: entity as SyncChange["entity"],
  entityId,
  action: data ? "upsert" : "delete",
  data: data ? { id: entityId, ...data } : null,
  actorId: null,
  createdAt: new Date(0).toISOString(),
});

/** A fake `/sync` endpoint over an in-memory log, paged like the real one. */
function fakeServer(limit = 2) {
  const log: SyncChange[] = [];
  const calls: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  return {
    log,
    calls,
    hold() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = Promise.resolve();
        release();
      };
    },
    push(...changes: SyncChange[]) {
      log.push(...changes);
    },
    pull: async (after: string): Promise<SyncPage> => {
      calls.push(after);
      await gate;
      const rows = log.filter((c) => compareCursors(c.id, after) > 0);
      const page = rows.slice(0, limit);
      return { changes: page, cursor: page.at(-1)?.id ?? after, hasMore: rows.length > limit };
    },
  };
}

const titles = (store: SyncStore) => [...getTable(store.getSnapshot(), "task").values()].map((t) => t.title);

describe("sync tables", () => {
  it("compares cursors numerically", () => {
    expect(compareCursors("9", "10")).toBe(-1);
    expect(compareCursors("100", "99")).toBe(1);
    expect(compareCursors("42", "42")).toBe(0);
    expect(compareCursors("007", "7")).toBe(0);
    expect(compareCursors("12345678901234567890", "12345678901234567891")).toBe(-1);
  });

  it("applies upserts and deletes idempotently", () => {
    const base = tablesFromRows({ task: [{ id: "a", title: "A" }] });
    const changes = [
      change("task", "a", { title: "A2" }),
      change("task", "b", { title: "B" }),
      change("task_label", "l", { taskId: "b", labelId: "x" }),
      change("task", "a", null),
    ];
    const once = applyChanges(base, changes);
    const twice = applyChanges(once, changes);
    expect([...getTable(once, "task").keys()]).toEqual(["b"]);
    expect(getRow(once, "task_label", "l")?.labelId).toBe("x");
    expect(twice).toEqual(once);
    // The input is never mutated.
    expect(getRow(base, "task", "a")?.title).toBe("A");
  });

  it("treats upserts of soft-deleted rows as deletes", () => {
    const base = tablesFromRows({ document: [{ id: "d", title: "Doc" }] });
    const next = applyChanges(base, [change("document", "d", { title: "Doc", deletedAt: "2026-01-01" })]);
    expect(getTable(next, "document").size).toBe(0);
  });

  it("only copies the tables a change touches", () => {
    const base = tablesFromRows({ task: [{ id: "a" }], label: [{ id: "x" }] });
    const next = applyChanges(base, [change("task", "b", {})]);
    expect(next.label).toBe(base.label);
    expect(next.task).not.toBe(base.task);
  });

  it("is generic over entity types", () => {
    const next = applyChanges({}, [change("comment" as never, "c", { body: "hi" })]);
    expect(getRow(next, "comment", "c")?.body).toBe("hi");
  });

  it("patches only existing rows", () => {
    const base = tablesFromRows({ task: [{ id: "a", title: "A" }] });
    expect(getRow(patchRow(base, "task", "a", { title: "B" }), "task", "a")?.title).toBe("B");
    expect(patchRow(base, "task", "missing", { title: "B" })).toBe(base);
    expect(deleteWhere(base, "task", () => false)).toBe(base);
  });

  it("never syncs private calendar events", () => {
    expect(syncEntityTypes as readonly string[]).not.toContain("calendar_event");
  });
});

describe("SyncStore", () => {
  const seed = () => tablesFromRows({ task: [{ id: "a", title: "A" }] });

  it("catches up across pages and advances the cursor", async () => {
    const server = fakeServer(2);
    server.push(
      ...["b", "c", "d", "e", "f"].map((id, i) =>
        change("task", id, { title: id.toUpperCase() }, String(i + 1)),
      ),
    );
    const store = new SyncStore({ tables: seed(), cursor: "0", pull: server.pull });
    await store.pull();
    expect(titles(store)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(store.cursor).toBe("5");
    expect(server.calls).toEqual(["0", "2", "4"]);
  });

  it("skips changes at or before its cursor and replays racing ones harmlessly", async () => {
    const store = new SyncStore({ tables: seed(), cursor: "10", pull: fakeServer().pull });
    store.receive({ changes: [change("task", "a", { title: "old" }, "9")], cursor: "9" });
    expect(titles(store)).toEqual(["A"]);
    expect(store.cursor).toBe("10");
    store.receive({ changes: [change("task", "a", { title: "new" }, "11")], cursor: "11" });
    store.receive({ changes: [change("task", "a", { title: "new" }, "11")], cursor: "11" });
    expect(titles(store)).toEqual(["new"]);
  });

  it("coalesces concurrent pulls into one follow-up", async () => {
    const server = fakeServer(10);
    const store = new SyncStore({ tables: seed(), cursor: "0", pull: server.pull });
    const release = server.hold();
    const first = store.pull();
    const second = store.pull();
    const third = store.pull();
    expect(second).toBe(third);
    server.push(change("task", "b", { title: "B" }, "1"));
    release();
    await Promise.all([first, second, third]);
    expect(server.calls).toEqual(["0", "1"]);
    expect(titles(store)).toEqual(["A", "B"]);
  });

  it("refuses to loop when the server does not advance", async () => {
    const store = new SyncStore({
      tables: seed(),
      cursor: "3",
      pull: async () => ({ changes: [], cursor: "3", hasMore: true }),
    });
    await expect(store.pull()).rejects.toThrow(/did not advance/);
  });

  it("applies optimistic edits at once and keeps them until the server's change is pulled", async () => {
    const server = fakeServer();
    const store = new SyncStore({ tables: seed(), cursor: "0", pull: server.pull });
    let respond!: () => void;
    const done = store.mutate({
      apply: (t) => patchRow(t, "task", "a", { title: "Mine" }),
      send: () => new Promise<void>((r) => (respond = r)),
    });
    expect(titles(store)).toEqual(["Mine"]);
    expect(getRow(store.getConfirmed(), "task", "a")?.title).toBe("A");

    // The server accepts the write and logs it; the overlay stays until we pull it.
    server.push(change("task", "a", { title: "Mine", updatedAt: "later" }, "1"));
    respond();
    await done;
    await store.pull();
    expect(store.pendingCount).toBe(0);
    expect(getRow(store.getSnapshot(), "task", "a")?.updatedAt).toBe("later");
  });

  it("rolls back failed edits without clobbering newer server data", async () => {
    const store = new SyncStore({ tables: seed(), cursor: "0", pull: fakeServer().pull });
    let fail!: (err: Error) => void;
    const done = store.mutate({
      apply: (t) => patchRow(t, "task", "a", { title: "Mine" }),
      send: () => new Promise<void>((_, reject) => (fail = reject)),
    });
    // Someone else edits another field meanwhile.
    store.receive({ changes: [change("task", "a", { title: "A", priority: 1 }, "1")], cursor: "1" });
    expect(getRow(store.getSnapshot(), "task", "a")).toMatchObject({ title: "Mine", priority: 1 });
    fail(new Error("nope"));
    await expect(done).rejects.toThrow("nope");
    expect(getRow(store.getSnapshot(), "task", "a")).toMatchObject({ title: "A", priority: 1 });
    expect(store.pendingCount).toBe(0);
  });

  it("rebases pending edits on incoming changes", async () => {
    const store = new SyncStore({ tables: seed(), cursor: "0", pull: fakeServer().pull });
    void store.mutate({
      apply: (t) => patchRow(t, "task", "a", { priority: 2 }),
      send: () => new Promise(() => {}),
    });
    store.receive({ changes: [change("task", "a", { title: "Renamed", priority: 0 }, "1")], cursor: "1" });
    expect(getRow(store.getSnapshot(), "task", "a")).toMatchObject({ title: "Renamed", priority: 2 });
    // A remote delete wins over a pending patch.
    store.receive({ changes: [change("task", "a", null, "2")], cursor: "2" });
    expect(getTable(store.getSnapshot(), "task").size).toBe(0);
  });

  it("does not drop an acked edit on a pull that started before the ack", async () => {
    const server = fakeServer();
    const store = new SyncStore({ tables: seed(), cursor: "0", pull: server.pull });
    const release = server.hold();
    const early = store.pull(); // in flight before the write is acked
    await store.mutate({
      apply: (t) => patchRow(t, "task", "a", { title: "Mine" }),
      send: async () => server.push(change("task", "a", { title: "Mine" }, "1")),
    });
    release();
    await early;
    await store.pull();
    expect(store.pendingCount).toBe(0);
    expect(titles(store)).toEqual(["Mine"]);
    expect(server.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("swaps in the server's result for creates", async () => {
    const store = new SyncStore({ tables: seed(), cursor: "0", pull: () => new Promise(() => {}) });
    const created = await store.mutate({
      apply: (t) => t,
      send: async () => ({ id: "n", title: "New" }),
      confirmed: (row) => (t) => upsertRow(t, "task", row),
    });
    expect(created.id).toBe("n");
    expect(titles(store)).toEqual(["A", "New"]);
  });

  it("restarts an in-flight pull after a reset", async () => {
    const server = fakeServer();
    server.push(change("task", "x", { title: "X" }, "6"));
    const store = new SyncStore({ tables: seed(), cursor: "0", pull: server.pull });
    const release = server.hold();
    const pulling = store.pull();
    store.reset(tablesFromRows({ task: [{ id: "a", title: "Fresh" }] }), "5");
    release();
    await pulling;
    expect(server.calls).toEqual(["0", "5"]);
    expect(titles(store)).toEqual(["Fresh", "X"]);
    expect(store.cursor).toBe("6");
  });

  it("notifies subscribers and reports applied changes", async () => {
    const seen: string[] = [];
    let notified = 0;
    const store = new SyncStore({
      tables: seed(),
      cursor: "0",
      pull: fakeServer().pull,
      onChanges: (changes) => seen.push(...changes.map((c) => c.entity)),
    });
    const unsubscribe = store.subscribe(() => notified++);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before); // stable between changes
    store.receive({ changes: [change("workspace_member", "m", { role: "admin" }, "1")], cursor: "1" });
    expect(seen).toEqual(["workspace_member"]);
    expect(notified).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
    unsubscribe();
    store.receive({ changes: [change("task", "a", null, "2")], cursor: "2" });
    expect(notified).toBe(1);
  });
});

describe("backoffDelay", () => {
  it("doubles up to a ceiling with jitter", () => {
    const at = (attempt: number, r: number) =>
      backoffDelay(attempt, { base: 1000, max: 8000, random: () => r });
    expect(at(0, 1)).toBe(1000);
    expect(at(0, 0)).toBe(500);
    expect(at(2, 1)).toBe(4000);
    expect(at(10, 1)).toBe(8000);
  });
});
