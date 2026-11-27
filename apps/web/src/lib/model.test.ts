import { sortKeyBetween, upsertRow } from "@knotworking/core";
import { describe, expect, it } from "vitest";
import { makeBootstrap, makeState, makeTask } from "@/test/fixtures";
import type { TaskSummary } from "./api";
import { projectProgress } from "./projects";
import { projectBootstrap, seedTables } from "./sync-model";
import {
  groupByCategory,
  groupByState,
  groupTasksBy,
  indexWorkspace,
  orderTasks,
  parseOrdering,
  planDrop,
  taskOrderings,
  type TaskOrdering,
} from "./model";

const ids = (tasks: TaskSummary[]) => tasks.map((t) => t.id);

it("groups due dates in Monday weeks with undated tasks last", () => {
  const tasks = [
    makeTask({ id: "sunday", dueDate: "2026-12-06" }),
    makeTask({ id: "monday", dueDate: "2026-12-07" }),
    makeTask({ id: "undated" }),
    makeTask({ id: "friday", dueDate: "2026-12-04" }),
  ];
  const byWeek = groupTasksBy(tasks, indexWorkspace(makeBootstrap(tasks)), "dueWeek", "manual");
  expect(byWeek.map((group) => [group.group?.value, ids(group.tasks)])).toEqual([
    ["2026-11-30", ["friday", "sunday"]],
    ["2026-12-07", ["monday"]],
    [null, ["undated"]],
  ]);
});

it("keeps historical sync rows out of the recent view until reopened and uses full project counts", () => {
  const active = makeTask({ id: "active", projectId: "project" });
  const older = makeTask({ id: "older", stateId: "done", projectId: "project" });
  const base = makeBootstrap([active], {
    closedWindow: {
      cutoff: "2026-02-01T00:00:00.000Z",
      olderCount: 1,
      projectCounts: { project: { open: 1, completed: 1, canceled: 0, started: 0, estimate: 0, logged: 0 } },
      labelCounts: {},
      stateCounts: { todo: 1, done: 1 },
    },
  });
  const tables = upsertRow(seedTables(base), "task", { ...older });
  const snapshot = projectBootstrap(tables, base, "1");
  expect(ids(snapshot.tasks)).toEqual(["active"]);
  expect(projectProgress(snapshot.tasks, indexWorkspace(snapshot)).get("project")).toMatchObject({
    completed: 1,
    total: 2,
    ratio: 0.5,
  });
  const reopened = upsertRow(tables, "task", {
    ...older,
    stateId: "todo",
    updatedAt: "2026-02-02T00:00:00.000Z",
  });
  expect(ids(projectBootstrap(reopened, base, "2").tasks)).toEqual(
    expect.arrayContaining(["active", "older"]),
  );
});

describe("indexWorkspace", () => {
  const boot = makeBootstrap([], {
    teams: [
      { id: "team-1", key: "ENG", name: "Engineering" },
      { id: "team-2", key: "OPS", name: "Operations" },
    ] as never,
  });
  const idx = indexWorkspace(boot);

  it("builds id and key lookups", () => {
    expect(idx.boot).toBe(boot);
    expect(idx.users.get("u1")?.name).toBe("Ada");
    expect(idx.teams.get("team-2")?.key).toBe("OPS");
    expect(idx.teamsByKey.get("ENG")?.id).toBe("team-1");
    expect(idx.states.get("doing")?.type).toBe("started");
    expect(idx.states.get("nope")).toBeUndefined();
  });

  it("fills 'started' states progressively and leaves other states without progress", () => {
    // Two started states (In Progress -> In Review): half way, then three quarters.
    expect(idx.stateProgress("doing")).toBe(0.5);
    expect(idx.stateProgress("review")).toBe(0.75);
    expect(idx.stateProgress("todo")).toBeUndefined();
    expect(idx.stateProgress("done")).toBeUndefined();
    expect(idx.stateProgress("unknown")).toBeUndefined();
  });

  it("handles a single started state and spaces three evenly", () => {
    const one = indexWorkspace(
      makeBootstrap([], { workflowStates: [makeState({ id: "only", type: "started" })] as never }),
    );
    expect(one.stateProgress("only")).toBe(0.5);

    const three = indexWorkspace(
      makeBootstrap([], {
        workflowStates: ["a", "b", "c"].map((id) => makeState({ id, type: "started" })) as never,
      }),
    );
    expect(["a", "b", "c"].map(three.stateProgress)).toEqual([0.5, 0.625, 0.75]);
  });

  it("computes progress per team", () => {
    const multi = indexWorkspace(
      makeBootstrap([], {
        workflowStates: [
          makeState({ id: "t1-a", type: "started", teamId: "team-1" }),
          makeState({ id: "t2-a", type: "started", teamId: "team-2" }),
          makeState({ id: "t1-b", type: "started", teamId: "team-1" }),
          makeState({ id: "t2-b", type: "started", teamId: "team-2" }),
        ] as never,
      }),
    );
    expect(multi.stateProgress("t1-a")).toBe(0.5);
    expect(multi.stateProgress("t2-a")).toBe(0.5);
    expect(multi.stateProgress("t1-b")).toBe(0.75);
    expect(multi.stateProgress("t2-b")).toBe(0.75);
  });
});

describe("parseOrdering", () => {
  it("accepts known orderings and falls back to priority", () => {
    for (const o of taskOrderings) expect(parseOrdering(o)).toBe(o);
    expect(parseOrdering(undefined)).toBe("priority");
    expect(parseOrdering("")).toBe("priority");
    expect(parseOrdering("alphabetical")).toBe("priority");
    expect(parseOrdering("MANUAL")).toBe("priority");
  });
});

describe("orderTasks", () => {
  const tasks = [
    makeTask({ id: "none", priority: 0, sortOrder: "a0" }),
    makeTask({ id: "low", priority: 4, sortOrder: "a1" }),
    makeTask({ id: "urgent-b", priority: 1, sortOrder: "a3" }),
    makeTask({ id: "urgent-a", priority: 1, sortOrder: "a2" }),
    makeTask({ id: "medium", priority: 3, sortOrder: "a4" }),
    makeTask({ id: "high", priority: 2, sortOrder: "a5" }),
  ];

  it("priority: urgent first, 'no priority' last, ties broken by sort key", () => {
    expect(ids(orderTasks(tasks, "priority"))).toEqual([
      "urgent-a",
      "urgent-b",
      "high",
      "medium",
      "low",
      "none",
    ]);
  });

  it("manual: sort key order", () => {
    expect(ids(orderTasks(tasks, "manual"))).toEqual([
      "none",
      "low",
      "urgent-a",
      "urgent-b",
      "medium",
      "high",
    ]);
  });

  it("compares sort keys by byte order, not locale", () => {
    // Fractional indexes use uppercase for negative integer parts: "Zz" sorts before "a0".
    const t = [makeTask({ id: "x", sortOrder: "a0" }), makeTask({ id: "y", sortOrder: "Zz" })];
    expect(ids(orderTasks(t, "manual"))).toEqual(["y", "x"]);
  });

  it("falls back to id when sort keys are equal, so the order is deterministic", () => {
    const t = [makeTask({ id: "b", sortOrder: "a0" }), makeTask({ id: "a", sortOrder: "a0" })];
    expect(ids(orderTasks(t, "manual"))).toEqual(["a", "b"]);
    expect(ids(orderTasks([...t].reverse(), "manual"))).toEqual(["a", "b"]);
  });

  it("created / updated: newest first, ties by sort key", () => {
    const t = [
      makeTask({ id: "old", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" }),
      makeTask({ id: "new", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-01-15T00:00:00Z" }),
      makeTask({
        id: "tie-b",
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-01-15T00:00:00Z",
        sortOrder: "a9",
      }),
    ];
    expect(ids(orderTasks(t, "created"))).toEqual(["new", "tie-b", "old"]);
    expect(ids(orderTasks(t, "updated"))).toEqual(["old", "new", "tie-b"]);
  });

  it("does not mutate its input", () => {
    const input = [...tasks];
    orderTasks(input, "priority");
    expect(ids(input)).toEqual(ids(tasks));
  });
});

describe("grouping", () => {
  const boot = makeBootstrap([
    makeTask({ id: "t-low", stateId: "todo", priority: 4, sortOrder: "a0" }),
    makeTask({ id: "t-urgent", stateId: "todo", priority: 1, sortOrder: "a1" }),
    makeTask({ id: "d1", stateId: "doing" }),
    makeTask({ id: "r1", stateId: "review" }),
    makeTask({ id: "x1", stateId: "done" }),
    makeTask({ id: "orphan", stateId: "deleted-state" }),
  ]);
  const idx = indexWorkspace(boot);

  it("groupByState keeps one group per state, in state order, including empty ones", () => {
    const groups = groupByState(boot.tasks, boot.workflowStates, idx);
    expect(groups.map((g) => g.key)).toEqual(["backlog", "todo", "doing", "review", "done", "canceled"]);
    expect(ids(groups.find((g) => g.key === "todo")!.tasks)).toEqual(["t-urgent", "t-low"]);
    expect(groups.find((g) => g.key === "backlog")!.tasks).toEqual([]);
    expect(groups.find((g) => g.key === "doing")).toMatchObject({
      title: "doing",
      type: "started",
      progress: 0.5,
    });
    expect(groups.find((g) => g.key === "review")!.progress).toBe(0.75);
    expect(groups.find((g) => g.key === "todo")!.progress).toBeUndefined();
    // Tasks in an unknown state are not shown in any group.
    expect(groups.flatMap((g) => ids(g.tasks))).not.toContain("orphan");
  });

  it("groupByState honours the ordering", () => {
    const groups = groupByState(boot.tasks, boot.workflowStates, idx, "manual");
    expect(ids(groups.find((g) => g.key === "todo")!.tasks)).toEqual(["t-low", "t-urgent"]);
  });

  it("groupByCategory merges states by type, in workflow order, with friendly titles", () => {
    const groups = groupByCategory(boot.tasks, idx);
    expect(groups.map((g) => [g.key, g.title])).toEqual([
      ["started", "In Progress"],
      ["unstarted", "Todo"],
      ["backlog", "Backlog"],
      ["completed", "Done"],
      ["canceled", "Canceled"],
    ]);
    expect(ids(groups[0]!.tasks).sort()).toEqual(["d1", "r1"]);
    expect(ids(groups[1]!.tasks)).toEqual(["t-urgent", "t-low"]);
    expect(ids(groups[3]!.tasks)).toEqual(["x1"]);
    expect(groups.flatMap((g) => ids(g.tasks))).not.toContain("orphan");
  });
});

describe("planDrop", () => {
  const key = (n: number) => `a${n}`;
  const column = (...specs: [id: string, priority: number, order: string][]) =>
    specs.map(([id, priority, sortOrder]) => makeTask({ id, priority, sortOrder }));

  it("returns nothing for date orderings or an invalid index", () => {
    const col = column(["a", 1, key(0)], ["b", 1, key(1)]);
    expect(planDrop(col, 1, "created")).toEqual({});
    expect(planDrop(col, 1, "updated")).toEqual({});
    expect(planDrop(col, 5, "manual")).toEqual({});
    expect(planDrop([], 0, "manual")).toEqual({});
  });

  describe("manual", () => {
    it("takes a key between its neighbours", () => {
      const col = column(["a", 0, "a0"], ["moved", 0, "a9"], ["c", 0, "a1"]);
      const plan = planDrop(col, 1, "manual");
      expect(plan.priority).toBeUndefined();
      expect(plan.sortOrder! > "a0" && plan.sortOrder! < "a1").toBe(true);
    });

    it("sorts before the first and after the last neighbour", () => {
      const first = planDrop(column(["moved", 0, "a9"], ["b", 0, "a0"]), 0, "manual");
      expect(first.sortOrder! < "a0").toBe(true);
      const last = planDrop(column(["a", 0, "a0"], ["moved", 0, "a9"]), 1, "manual");
      expect(last.sortOrder! > "a0").toBe(true);
    });

    it("gives a fresh key to a task dropped into an empty column", () => {
      expect(planDrop(column(["moved", 0, "a5"]), 0, "manual")).toEqual({ sortOrder: "a0" });
    });

    it("changes nothing if the existing key already fits", () => {
      // A lone task keyed "a0" is already what the slot would be assigned.
      expect(planDrop(column(["moved", 0, "a0"]), 0, "manual")).toEqual({});
    });

    it("never throws on duplicate or reversed neighbour keys", () => {
      const dup = column(["a", 0, "a1"], ["moved", 0, "a5"], ["c", 0, "a1"]);
      expect(planDrop(dup, 1, "manual").sortOrder! > "a1").toBe(true);
      const reversed = column(["a", 0, "a2"], ["moved", 0, "a5"], ["c", 0, "a1"]);
      expect(typeof planDrop(reversed, 1, "manual").sortOrder).toBe("string");
    });
  });

  describe("priority", () => {
    it("adopts the priority of the slot above and sorts among that priority", () => {
      // urgent, urgent, [moved: low], medium  ->  dropped under the urgent tasks
      const col = column(["u1", 1, "a0"], ["u2", 1, "a1"], ["moved", 4, "a9"], ["m", 3, "a2"]);
      const plan = planDrop(col, 2, "priority");
      expect(plan.priority).toBe(1);
      expect(plan.sortOrder! > "a1").toBe(true); // after u2; the medium task's key is irrelevant
    });

    it("adopts the slot below when dropped at the top of the column", () => {
      const col = column(["moved", 4, "a9"], ["m", 3, "a2"], ["l", 4, "a3"]);
      const plan = planDrop(col, 0, "priority");
      expect(plan.priority).toBe(3);
      expect(plan.sortOrder! < "a2").toBe(true);
    });

    it("sorts between same-priority neighbours and omits the priority when unchanged", () => {
      const col = column(["h1", 2, "a0"], ["moved", 2, "a9"], ["h2", 2, "a1"]);
      const plan = planDrop(col, 1, "priority");
      expect(plan).not.toHaveProperty("priority");
      expect(plan.sortOrder! > "a0" && plan.sortOrder! < "a1").toBe(true);
    });

    it("on a group boundary joins the group above and ignores the other group's keys", () => {
      // The urgent task above has a *larger* key than the high-priority task below. Priority decides
      // the order across groups, so the key is only compared with same-priority neighbours.
      const col = column(["u", 1, "a8"], ["moved", 2, "a0"], ["h", 2, "a2"]);
      const plan = planDrop(col, 1, "priority");
      expect(plan.priority).toBe(1);
      expect(plan.sortOrder! > "a8").toBe(true);
    });

    it("treats 'no priority' (0) as the lowest rank when matching neighbours", () => {
      const col = column(["l", 4, "a0"], ["moved", 1, "a9"], ["n1", 0, "a1"], ["n2", 0, "a2"]);
      const plan = planDrop(col, 1, "priority");
      // Dropped between low (above) and none (below): adopts low, goes after the low task's key.
      expect(plan.priority).toBe(4);
      expect(plan.sortOrder! > "a0").toBe(true);
    });

    it("keeps the task's priority when dropped into an empty column", () => {
      expect(planDrop(column(["moved", 3, "a5"]), 0, "priority")).toEqual({ sortOrder: "a0" });
    });
  });

  describe("round trip: the planned change lands the task where it was dropped", () => {
    // Deterministic pseudo-random generator (mulberry32) so failures are reproducible.
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (const ordering of ["manual", "priority"] as TaskOrdering[]) {
      it(`${ordering} ordering`, () => {
        const rand = rng(ordering === "manual" ? 1 : 2);
        // Build a column of tasks with unique keys, shuffled so keys are NOT monotonic across priorities.
        let keys: string[] = [];
        let last: string | null = null;
        for (let i = 0; i < 40; i++) keys.push((last = sortKeyBetween(last, null)));
        keys = keys.sort(() => rand() - 0.5);
        let tasks = keys.map((sortOrder, i) =>
          makeTask({ id: `t${String(i).padStart(2, "0")}`, sortOrder, priority: Math.floor(rand() * 5) }),
        );

        for (let step = 0; step < 150; step++) {
          const shown = orderTasks(tasks, ordering);
          const from = Math.floor(rand() * shown.length);
          const to = Math.floor(rand() * shown.length);
          // What the drag-and-drop layer hands us: the column in its final order, task included.
          const dropped = [...shown];
          const [moved] = dropped.splice(from, 1);
          dropped.splice(to, 0, moved!);

          const plan = planDrop(dropped, to, ordering);
          const changed = { ...moved!, ...plan };
          tasks = tasks.map((t) => (t.id === moved!.id ? changed : t));

          const after = orderTasks(tasks, ordering);
          if (ordering === "manual") {
            expect(ids(after), `step ${step}: ${from} -> ${to}`).toEqual(ids(dropped));
          } else {
            // Priority ordering may re-rank the task (it adopts its new neighbours' priority), but it
            // must end up in the slot it was dropped in: same neighbours as in the dropped column.
            const i = ids(after).indexOf(moved!.id);
            expect(i, `step ${step}: ${from} -> ${to}`).toBe(to);
            expect(ids(after)).toEqual(ids(dropped));
          }
        }
      });
    }
  });
});
