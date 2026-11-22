import { describe, expect, it } from "vitest";
import {
  barBox,
  datePatch,
  dayToX,
  dependencyLines,
  dependencyPath,
  fromDay,
  headerRows,
  isViolated,
  parseZoom,
  PX_PER_DAY,
  rowCenter,
  shiftDates,
  snapDays,
  taskSpan,
  timelineRange,
  timelineRows,
  toDay,
  weekday,
  xToDay,
  type TimelineTask,
} from "./timeline";

const task = (
  id: string,
  startDate: string | null,
  dueDate: string | null,
  extra: Partial<TimelineTask> = {},
) => ({
  id,
  parentId: null,
  startDate,
  dueDate,
  sortOrder: "a0",
  ...extra,
});

describe("days", () => {
  it("round-trips dates through day numbers, independent of the time zone", () => {
    expect(toDay("1970-01-01")).toBe(0);
    expect(fromDay(toDay("2026-11-09")!)).toBe("2026-11-09");
    // Across the US DST change (America/New_York in tests): still exactly one day apart.
    expect(toDay("2026-11-02")! - toDay("2026-11-01")!).toBe(1);
    expect(toDay("2026-03-09")! - toDay("2026-03-08")!).toBe(1);
    expect(toDay("not a date")).toBeNull();
    expect(toDay(null)).toBeNull();
  });

  it("knows the weekday (Monday = 0)", () => {
    expect(weekday(toDay("2026-11-09")!)).toBe(0); // a Monday
    expect(weekday(toDay("2026-11-15")!)).toBe(6);
    expect(weekday(toDay("1969-12-29")!)).toBe(0); // negative day numbers too
  });
});

describe("zoom and pixels", () => {
  it("parses zoom, defaulting to week", () => {
    expect(parseZoom("day")).toBe("day");
    expect(parseZoom("month")).toBe("month");
    expect(parseZoom("year")).toBe("week");
    expect(parseZoom(undefined)).toBe("week");
  });

  it("pads and aligns the range to the zoom level", () => {
    const day = timelineRange(["2026-11-10", "2026-11-20"], "2026-11-12", "day");
    expect(fromDay(day.start)).toBe("2026-11-03");
    expect(day.days).toBe(25);

    const week = timelineRange(["2026-11-10", "2026-11-20"], "2026-11-12", "week");
    expect(weekday(week.start)).toBe(0);
    expect(week.days % 7).toBe(0);
    expect(week.start).toBeLessThanOrEqual(toDay("2026-10-27")!);

    const month = timelineRange(["2026-11-10"], "2026-11-12", "month");
    expect(fromDay(month.start)).toBe("2026-10-01");
    expect(fromDay(month.start + month.days - 1)).toBe("2026-12-31");
  });

  it("always includes today and ignores missing dates", () => {
    const r = timelineRange([null, undefined, "2026-01-05"], "2026-11-09", "day");
    expect(r.start).toBeLessThanOrEqual(toDay("2026-01-05")!);
    expect(r.start + r.days).toBeGreaterThan(toDay("2026-11-09")!);
  });

  it("converts between days and pixels", () => {
    const range = { start: toDay("2026-11-01")!, days: 30 };
    expect(dayToX(toDay("2026-11-01")!, range, "day")).toBe(0);
    expect(dayToX(toDay("2026-11-04")!, range, "day")).toBe(3 * PX_PER_DAY.day);
    expect(dayToX(toDay("2026-11-04")!, range, "month")).toBe(3 * PX_PER_DAY.month);
    expect(fromDay(xToDay(3 * PX_PER_DAY.week + 1, range, "week"))).toBe("2026-11-04");
    expect(fromDay(xToDay(PX_PER_DAY.week - 1, range, "week"))).toBe("2026-11-01");
  });

  it("snaps pointer movement to whole days", () => {
    expect(snapDays(0, "day")).toBe(0);
    expect(snapDays(15, "day")).toBe(0);
    expect(snapDays(17, "day")).toBe(1);
    expect(snapDays(-17, "day")).toBe(-1);
    expect(snapDays(PX_PER_DAY.week * 3, "week")).toBe(3);
    expect(snapDays(-2, "month")).toBe(0); // not -0
    expect(Object.is(snapDays(-2, "month"), 0)).toBe(true);
  });

  it("lays out bars from the first day's left edge to the last day's right edge", () => {
    const range = { start: toDay("2026-11-01")!, days: 30 };
    const span = taskSpan({ startDate: "2026-11-03", dueDate: "2026-11-05" })!;
    expect(barBox(span, range, "day")).toEqual({ x: 64, width: 96 });
    const marker = taskSpan({ startDate: null, dueDate: "2026-11-03" })!;
    expect(barBox(marker, range, "day")).toEqual({ x: 64, width: 32 });
  });
});

describe("header", () => {
  it("shows months over days at day zoom", () => {
    const { top, bottom } = headerRows({ start: toDay("2026-10-30")!, days: 5 }, "day");
    expect(top).toEqual([
      { start: toDay("2026-10-30"), days: 2, label: "Oct 2026" },
      { start: toDay("2026-11-01"), days: 3, label: "Nov 2026" },
    ]);
    expect(bottom.map((c) => c.label)).toEqual(["30", "31", "1", "2", "3"]);
  });

  it("shows weeks starting on Monday at week zoom", () => {
    const { bottom } = headerRows({ start: toDay("2026-11-02")!, days: 14 }, "week");
    expect(bottom).toEqual([
      { start: toDay("2026-11-02"), days: 7, label: "Nov 2" },
      { start: toDay("2026-11-09"), days: 7, label: "Nov 9" },
    ]);
  });

  it("shows years over months at month zoom", () => {
    const { top, bottom } = headerRows({ start: toDay("2026-12-01")!, days: 62 }, "month");
    expect(top.map((c) => c.label)).toEqual(["2026", "2027"]);
    expect(bottom.map((c) => [c.label, c.days])).toEqual([
      ["Dec", 31],
      ["Jan", 31],
    ]);
  });
});

describe("rows", () => {
  it("spans start to due, and marks single dates", () => {
    expect(taskSpan({ startDate: "2026-11-03", dueDate: "2026-11-05" })).toMatchObject({ kind: "range" });
    expect(taskSpan({ startDate: "2026-11-03", dueDate: null })).toEqual({
      start: toDay("2026-11-03"),
      end: toDay("2026-11-03"),
      kind: "start",
    });
    expect(taskSpan({ startDate: null, dueDate: "2026-11-05" })?.kind).toBe("due");
    expect(taskSpan({ startDate: null, dueDate: null })).toBeNull();
    // Bad data (start after due) still draws, the right way round.
    expect(taskSpan({ startDate: "2026-11-09", dueDate: "2026-11-01" })).toMatchObject({
      start: toDay("2026-11-01"),
      end: toDay("2026-11-09"),
    });
  });

  it("orders by start, nests subtasks and lists unscheduled tasks separately", () => {
    const tasks = [
      task("late", "2026-11-20", "2026-11-25"),
      task("early", null, "2026-11-02"),
      task("parent", null, null, { sortOrder: "a5" }),
      task("child-b", "2026-11-12", null, { parentId: "parent", sortOrder: "a1" }),
      task("child-a", "2026-11-10", "2026-11-11", { parentId: "parent", sortOrder: "a2" }),
      task("child-none", null, null, { parentId: "parent" }),
      task("orphan", "2026-11-01", null, { parentId: "elsewhere" }),
      task("none-2", null, null, { sortOrder: "a2" }),
      task("none-1", null, null, { sortOrder: "a1" }),
    ];
    const { rows, unscheduled } = timelineRows(tasks);
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([
      ["orphan", 0],
      ["early", 0],
      ["parent", 0], // no dates itself, sorted by its first subtask
      ["child-a", 1],
      ["child-b", 1],
      ["late", 0],
    ]);
    expect(rows.find((r) => r.task.id === "parent")?.span).toBeNull();
    expect(unscheduled.map((t) => t.id)).toEqual(["child-none", "none-1", "none-2"]);
  });

  it("breaks ties by manual order and survives a parent cycle", () => {
    const { rows } = timelineRows([
      task("b", "2026-11-01", null, { sortOrder: "a2" }),
      task("a", "2026-11-01", null, { sortOrder: "a1" }),
      task("x", "2026-11-03", null, { parentId: "y" }),
      task("y", "2026-11-04", null, { parentId: "x" }),
    ]);
    expect(rows.map((r) => r.task.id)).toEqual(["a", "b", "x", "y"]);
  });
});

describe("rescheduling", () => {
  const range = { startDate: "2026-11-03", dueDate: "2026-11-05" };

  it("moves both dates", () => {
    expect(shiftDates(range, "move", 2)).toEqual({ startDate: "2026-11-05", dueDate: "2026-11-07" });
    expect(shiftDates({ startDate: null, dueDate: "2026-11-05" }, "move", -1)).toEqual({
      startDate: null,
      dueDate: "2026-11-04",
    });
    expect(shiftDates(range, "move", 0)).toBe(range);
  });

  it("resizes an edge without crossing the other", () => {
    expect(shiftDates(range, "start", -2)).toEqual({ startDate: "2026-11-01", dueDate: "2026-11-05" });
    expect(shiftDates(range, "start", 5)).toEqual({ startDate: "2026-11-05", dueDate: "2026-11-05" });
    expect(shiftDates(range, "end", 3)).toEqual({ startDate: "2026-11-03", dueDate: "2026-11-08" });
    expect(shiftDates(range, "end", -9)).toEqual({ startDate: "2026-11-03", dueDate: "2026-11-03" });
  });

  it("turns a marker into a bar from its free edge", () => {
    const due = { startDate: null, dueDate: "2026-11-05" };
    expect(shiftDates(due, "start", -2)).toEqual({ startDate: "2026-11-03", dueDate: "2026-11-05" });
    expect(shiftDates(due, "end", 2)).toEqual({ startDate: null, dueDate: "2026-11-07" });
    const start = { startDate: "2026-11-03", dueDate: null };
    expect(shiftDates(start, "end", 2)).toEqual({ startDate: "2026-11-03", dueDate: "2026-11-05" });
    expect(shiftDates(start, "start", -1)).toEqual({ startDate: "2026-11-02", dueDate: null });
  });

  it("patches only what changed", () => {
    expect(datePatch(range, shiftDates(range, "end", 1))).toEqual({ dueDate: "2026-11-06" });
    expect(datePatch(range, shiftDates(range, "move", 1))).toEqual({
      startDate: "2026-11-04",
      dueDate: "2026-11-06",
    });
    expect(datePatch(range, range)).toEqual({});
  });
});

describe("dependencies", () => {
  it("draws an elbow when the blocked bar starts to the right", () => {
    expect(dependencyPath({ x: 100, y: 18 }, { x: 200, y: 54 })).toBe("M 100 18 H 108 V 54 H 200");
  });

  it("doubles back between the rows when the blocked bar starts earlier", () => {
    expect(dependencyPath({ x: 100, y: 18 }, { x: 50, y: 90 })).toBe("M 100 18 H 108 V 54 H 42 V 90 H 50");
    // Upwards too.
    expect(dependencyPath({ x: 100, y: 90 }, { x: 105, y: 18 })).toBe("M 100 90 H 108 V 54 H 97 V 18 H 105");
  });

  it("flags a blocked task that starts on or before its blocker ends", () => {
    const blocker = taskSpan({ startDate: "2026-11-01", dueDate: "2026-11-05" })!;
    expect(isViolated(blocker, taskSpan({ startDate: "2026-11-06", dueDate: null })!)).toBe(false);
    expect(isViolated(blocker, taskSpan({ startDate: "2026-11-05", dueDate: null })!)).toBe(true);
    expect(isViolated(blocker, taskSpan({ startDate: null, dueDate: "2026-11-03" })!)).toBe(true);
  });

  it("only connects tasks drawn as bars", () => {
    const range = { start: toDay("2026-11-01")!, days: 30 };
    const box = (index: number, startDate: string, dueDate: string) => {
      const span = taskSpan({ startDate, dueDate })!;
      return { index, span, box: barBox(span, range, "day") };
    };
    const boxes = new Map([
      ["a", box(0, "2026-11-01", "2026-11-02")],
      ["b", box(1, "2026-11-02", "2026-11-04")],
    ]);
    const lines = dependencyLines(
      [
        { id: "r1", blockingTaskId: "a", blockedTaskId: "b" },
        { id: "r2", blockingTaskId: "b", blockedTaskId: "missing" },
      ],
      boxes,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: "r1", violated: true });
    // b starts before a ends, so the arrow doubles back between the rows.
    const between = (rowCenter(0) + rowCenter(1)) / 2;
    expect(lines[0]!.path).toBe(`M 64 ${rowCenter(0)} H 72 V ${between} H 24 V ${rowCenter(1)} H 32`);
  });
});
