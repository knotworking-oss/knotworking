import { describe, expect, it } from "vitest";
import {
  doneToggleTarget,
  isHelpKey,
  isOverlayOpen,
  isTypingTarget,
  navigateTask,
  shortcutGroups,
  taskKeyAction,
} from "./keyboard";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "repeat", boolean>> = {}) =>
  taskKeyAction({ key: k, ...mods });

describe("taskKeyAction", () => {
  it("maps J/K and arrows to focus moves; only arrows need a focused row", () => {
    expect(key("j")).toEqual({ type: "move", dir: "next", needsFocus: false });
    expect(key("K")).toEqual({ type: "move", dir: "prev", needsFocus: false });
    expect(key("ArrowDown")).toEqual({ type: "move", dir: "next", needsFocus: true });
    expect(key("ArrowUp")).toEqual({ type: "move", dir: "prev", needsFocus: true });
    expect(key("ArrowLeft")).toEqual({ type: "move", dir: "left", needsFocus: true });
    expect(key("ArrowRight")).toEqual({ type: "move", dir: "right", needsFocus: true });
  });

  it("maps S/P/A/L to property menus in either case", () => {
    expect(key("s")).toEqual({ type: "menu", menu: "status" });
    expect(key("P")).toEqual({ type: "menu", menu: "priority" });
    expect(key("a")).toEqual({ type: "menu", menu: "assignee" });
    expect(key("L")).toEqual({ type: "menu", menu: "labels" });
  });

  it("maps X to toggle done and Escape to clear", () => {
    expect(key("x")).toEqual({ type: "toggleDone" });
    expect(key("Escape")).toEqual({ type: "clear" });
  });

  it("leaves Space and Enter alone so dnd-kit drags and links keep working", () => {
    expect(key(" ")).toBeNull();
    expect(key("Enter")).toBeNull();
    expect(key("Tab")).toBeNull();
  });

  it("ignores digits so open menus can use them", () => {
    for (const d of "0123456789") expect(key(d)).toBeNull();
  });

  it("ignores shortcuts with ⌘, Ctrl or Alt held (⌘K, browser shortcuts)", () => {
    expect(key("k", { metaKey: true })).toBeNull();
    expect(key("k", { ctrlKey: true })).toBeNull();
    expect(key("s", { metaKey: true })).toBeNull();
    expect(key("l", { altKey: true })).toBeNull();
    expect(key("ArrowDown", { altKey: true })).toBeNull();
  });

  it("lets navigation repeat but not menus or toggles", () => {
    expect(key("j", { repeat: true })).not.toBeNull();
    expect(key("ArrowDown", { repeat: true })).not.toBeNull();
    expect(key("s", { repeat: true })).toBeNull();
    expect(key("x", { repeat: true })).toBeNull();
  });
});

describe("isHelpKey", () => {
  it("matches ? without command modifiers", () => {
    expect(isHelpKey({ key: "?" })).toBe(true);
    expect(isHelpKey({ key: "?", metaKey: true })).toBe(false);
    expect(isHelpKey({ key: "/" })).toBe(false);
  });
});

describe("navigateTask", () => {
  const columns = [["a", "b", "c"], [], ["d", "e"]];

  it("starts at the first or last task when nothing is focused", () => {
    expect(navigateTask(columns, null, "next")).toBe("a");
    expect(navigateTask(columns, null, "prev")).toBe("e");
    expect(navigateTask(columns, null, "left")).toBeNull();
  });

  it("walks through every task in order, crossing empty columns", () => {
    expect(navigateTask(columns, "a", "next")).toBe("b");
    expect(navigateTask(columns, "c", "next")).toBe("d");
    expect(navigateTask(columns, "d", "prev")).toBe("c");
  });

  it("stops at the ends instead of wrapping", () => {
    expect(navigateTask(columns, "e", "next")).toBeNull();
    expect(navigateTask(columns, "a", "prev")).toBeNull();
  });

  it("jumps between columns keeping the row, skipping empty columns and clamping", () => {
    expect(navigateTask(columns, "b", "right")).toBe("e");
    expect(navigateTask(columns, "c", "right")).toBe("e");
    expect(navigateTask(columns, "d", "left")).toBe("a");
    expect(navigateTask(columns, "e", "left")).toBe("b");
    expect(navigateTask(columns, "e", "right")).toBeNull();
    expect(navigateTask(columns, "a", "left")).toBeNull();
  });

  it("treats an unknown current task like no focus, and an empty board as nothing to do", () => {
    expect(navigateTask(columns, "gone", "next")).toBe("a");
    expect(navigateTask([[], []], null, "next")).toBeNull();
    expect(navigateTask([], null, "next")).toBeNull();
  });
});

describe("doneToggleTarget", () => {
  const states = [
    { id: "backlog", type: "backlog" },
    { id: "todo", type: "unstarted" },
    { id: "doing", type: "started" },
    { id: "done", type: "completed" },
    { id: "canceled", type: "canceled" },
  ];

  it("completes an open task", () => {
    expect(doneToggleTarget(states, "doing")).toBe("done");
    expect(doneToggleTarget(states, "backlog")).toBe("done");
    expect(doneToggleTarget(states, "canceled")).toBe("done");
  });

  it("reopens a done task into the first unstarted state", () => {
    expect(doneToggleTarget(states, "done")).toBe("todo");
  });

  it("falls back to backlog, and gives up when the team has no suitable state", () => {
    expect(
      doneToggleTarget(
        states.filter((s) => s.id !== "todo"),
        "done",
      ),
    ).toBe("backlog");
    expect(doneToggleTarget([{ id: "todo", type: "unstarted" }], "todo")).toBeNull();
    expect(doneToggleTarget([{ id: "done", type: "completed" }], "done")).toBeNull();
  });
});

describe("DOM helpers without a DOM", () => {
  it("isTypingTarget is false outside the browser", () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it("isOverlayOpen asks the document for dialogs, menus and popovers", () => {
    const seen: string[] = [];
    const doc = (open: boolean) => ({
      querySelector: (selector: string) => {
        seen.push(selector);
        return open ? ({} as Element) : null;
      },
    });
    expect(isOverlayOpen(doc(true))).toBe(true);
    expect(isOverlayOpen(doc(false))).toBe(false);
    expect(seen[0]).toContain("[role=dialog]");
    expect(seen[0]).toContain("[role=menu]");
    expect(seen[0]).toContain("[data-slot=popover-content]");
  });
});

describe("shortcutGroups", () => {
  it("documents every key the task list handles", () => {
    const listed = shortcutGroups.flatMap((g) => g.shortcuts.flatMap((s) => s.keys));
    for (const k of ["J", "K", "S", "P", "A", "L", "X", "Esc", "Enter", "?"]) expect(listed).toContain(k);
  });
});
