/** True when a key event comes from somewhere the person is typing (so single-key shortcuts must not fire). */
export function isTypingTarget(target: EventTarget | null) {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Selector for anything modal or floating (⌘K, dialogs, property menus) that owns the keyboard while open. */
export const overlaySelector = "[role=dialog], [role=menu], [data-slot=popover-content]";

/** True while a dialog, menu or popover is open, so global single-key shortcuts must stay quiet. */
export function isOverlayOpen(doc: Pick<Document, "querySelector"> = document) {
  return doc.querySelector(overlaySelector) !== null;
}

// ─── Task lists and boards ──────────────────────────────────────────────────

export type RowMenu = "status" | "priority" | "assignee" | "labels";
export type NavDirection = "next" | "prev" | "left" | "right";

export type TaskKeyAction =
  /** Move focus. `needsFocus` actions (arrow keys) only apply once a row already has focus, so the page can still scroll. */
  | { type: "move"; dir: NavDirection; needsFocus: boolean }
  | { type: "menu"; menu: RowMenu }
  | { type: "toggleDone" }
  | { type: "clear" };

/** The parts of a KeyboardEvent that shortcuts care about (so the logic is testable without a DOM). */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

const menuKeys: Record<string, RowMenu> = { s: "status", p: "priority", a: "assignee", l: "labels" };

/**
 * What a key press means for the task list or board, or null if it means nothing.
 * Callers still have to rule out typing targets, open menus and drags first.
 * Space and Enter are deliberately absent: Space starts a keyboard drag and Enter opens the focused task link.
 */
export function taskKeyAction(e: KeyLike): TaskKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "j":
    case "J":
      return { type: "move", dir: "next", needsFocus: false };
    case "k":
    case "K":
      return { type: "move", dir: "prev", needsFocus: false };
    case "ArrowDown":
      return { type: "move", dir: "next", needsFocus: true };
    case "ArrowUp":
      return { type: "move", dir: "prev", needsFocus: true };
    case "ArrowLeft":
      return { type: "move", dir: "left", needsFocus: true };
    case "ArrowRight":
      return { type: "move", dir: "right", needsFocus: true };
    case "Escape":
      return { type: "clear" };
  }
  if (e.repeat) return null;
  const key = e.key.toLowerCase();
  const menu = menuKeys[key];
  if (menu) return { type: "menu", menu };
  if (key === "x") return { type: "toggleDone" };
  return null;
}

/** `?` opens the shortcut help. */
export function isHelpKey(e: KeyLike) {
  return e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat;
}

/**
 * Where focus goes next. `columns` are the visible task ids per list section or board column, in
 * display order. `current` is the focused task (or null). Returns the id to focus, or null to stay put.
 * Up/down (next/prev) run through every task in order, crossing from one column to the next; left/right
 * jump to the nearest non-empty column keeping the row index where possible.
 */
export function navigateTask(columns: string[][], current: string | null, dir: NavDirection): string | null {
  const flat = columns.flat();
  if (flat.length === 0) return null;
  if (current === null || !flat.includes(current)) {
    if (dir === "next") return flat[0]!;
    if (dir === "prev") return flat[flat.length - 1]!;
    return null;
  }
  if (dir === "next" || dir === "prev") {
    const i = flat.indexOf(current) + (dir === "next" ? 1 : -1);
    return flat[i] ?? null;
  }
  const col = columns.findIndex((c) => c.includes(current));
  const row = columns[col]!.indexOf(current);
  const step = dir === "right" ? 1 : -1;
  for (let c = col + step; c >= 0 && c < columns.length; c += step) {
    const target = columns[c]!;
    if (target.length) return target[Math.min(row, target.length - 1)]!;
  }
  return null;
}

/**
 * The state to move a task to when `X` is pressed: done, or back to open if it already is.
 * `states` are the task's team's workflow states in display order.
 */
export function doneToggleTarget(
  states: { id: string; type: string }[],
  currentStateId: string,
): string | null {
  const current = states.find((s) => s.id === currentStateId);
  if (current?.type === "completed") {
    return (
      (states.find((s) => s.type === "unstarted") ?? states.find((s) => s.type === "backlog"))?.id ?? null
    );
  }
  return states.find((s) => s.type === "completed")?.id ?? null;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

/** Everything listed in the `?` help dialog. */
export const shortcutGroups: ShortcutGroup[] = [
  {
    title: "Global",
    shortcuts: [
      { keys: ["⌘", "K"], description: "Open the command menu" },
      { keys: ["C"], description: "Create a task" },
      { keys: ["?"], description: "Show keyboard shortcuts" },
    ],
  },
  {
    title: "Task lists and boards",
    shortcuts: [
      { keys: ["J"], description: "Focus the next task (or ↓)" },
      { keys: ["K"], description: "Focus the previous task (or ↑)" },
      { keys: ["←", "→"], description: "Board: focus the neighbouring column" },
      { keys: ["Enter"], description: "Open the focused task" },
      { keys: ["S"], description: "Change status" },
      { keys: ["P"], description: "Change priority" },
      { keys: ["A"], description: "Change assignee" },
      { keys: ["L"], description: "Change labels" },
      { keys: ["X"], description: "Mark done, or reopen if already done" },
      { keys: ["Esc"], description: "Clear focus" },
    ],
  },
  {
    title: "Move a task",
    shortcuts: [
      { keys: ["Space"], description: "Pick up the focused task" },
      { keys: ["↑", "↓", "←", "→"], description: "Move it" },
      { keys: ["Space"], description: "Drop it (Esc cancels)" },
    ],
  },
  {
    title: "Property menus",
    shortcuts: [
      { keys: ["1–9"], description: "Pick the numbered option" },
      { keys: ["0"], description: "Clear (no assignee, no project)" },
      { keys: ["Type"], description: "Search the options" },
    ],
  },
  {
    title: "Task page",
    shortcuts: [
      { keys: ["S", "P", "A", "L"], description: "Open the status, priority, assignee and label menus" },
    ],
  },
];
