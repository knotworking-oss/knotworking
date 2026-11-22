"use client";

import { cn } from "@knotworking/ui/lib/utils";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TaskSummary } from "@/lib/api";
import {
  doneToggleTarget,
  isOverlayOpen,
  isTypingTarget,
  navigateTask,
  taskKeyAction,
  type RowMenu,
} from "@/lib/keyboard";
import { useWorkspace } from "@/lib/workspace-store";

/**
 * Keyboard navigation for task lists and boards.
 *
 * `TaskKeyboardNav` (one per list or board) owns a single document key listener. Rows register
 * themselves with `useTaskRow`, which gives it their link (the focus target) and column, plus a
 * handler for the row-level shortcuts. Focus is real DOM focus on the row's link, so Enter opens the
 * task and Space starts dnd-kit's keyboard drag exactly as before; the listener stands down during a
 * drag, while a dialog/menu is open, and while the person is typing.
 */
interface RowEntry {
  id: string;
  column: string;
  link: () => HTMLElement | null;
  /** Runs a row shortcut. Returns false if the row can't (e.g. read-only). */
  run: (action: { type: "menu"; menu: RowMenu } | { type: "toggleDone" }) => boolean;
}

interface Nav {
  register: (entry: RowEntry) => () => void;
  /** Ask for focus to land on this task's row once it (re)mounts, e.g. after a status change moves it. */
  holdFocus: (id: string) => void;
  releaseFocus: (id: string) => void;
  /** True once if this task was holding focus. */
  takeFocus: (id: string) => boolean;
}

const NavCtx = createContext<Nav | null>(null);
const HOLD_MS = 1500;

export function TaskKeyboardNav({
  dragging,
  horizontal = false,
  children,
}: {
  /** True while a drag is in progress. */
  dragging: boolean;
  /** Arrow left/right jump between columns (board). */
  horizontal?: boolean;
  children: ReactNode;
}) {
  const rows = useRef(new Map<string, RowEntry>());
  const held = useRef<{ id: string; until: number } | null>(null);
  const draggingRef = useRef(dragging);
  useEffect(() => {
    draggingRef.current = dragging;
  }, [dragging]);

  const nav = useMemo<Nav>(
    () => ({
      register(entry) {
        rows.current.set(entry.id, entry);
        return () => {
          if (rows.current.get(entry.id) === entry) rows.current.delete(entry.id);
        };
      },
      holdFocus(id) {
        held.current = { id, until: Date.now() + HOLD_MS };
      },
      releaseFocus(id) {
        if (held.current?.id === id) held.current = null;
      },
      takeFocus(id) {
        const h = held.current;
        if (!h || h.id !== id) return false;
        held.current = null;
        return Date.now() < h.until;
      },
    }),
    [],
  );

  useEffect(() => {
    /** Visible rows grouped by column, in document order. */
    const layout = () => {
      const entries = [...rows.current.values()]
        .map((entry) => ({ entry, el: entry.link() }))
        .filter((r): r is { entry: RowEntry; el: HTMLElement } => r.el !== null)
        .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      const columns = new Map<string, string[]>();
      for (const { entry } of entries) {
        const col = columns.get(entry.column) ?? [];
        col.push(entry.id);
        columns.set(entry.column, col);
      }
      return [...columns.values()];
    };

    const onKey = (e: KeyboardEvent) => {
      if (draggingRef.current || e.defaultPrevented || e.isComposing) return;
      if (isTypingTarget(e.target) || isOverlayOpen()) return;
      const action = taskKeyAction(e);
      if (!action) return;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const currentId = focused?.closest<HTMLElement>("[data-task-id]")?.dataset.taskId ?? null;
      const current = currentId !== null && rows.current.has(currentId) ? currentId : null;

      switch (action.type) {
        case "move": {
          if (action.needsFocus && !current) return;
          if (!horizontal && (action.dir === "left" || action.dir === "right")) return;
          const columns = layout();
          if (columns.length === 0) return;
          e.preventDefault();
          const target = navigateTask(columns, current, action.dir);
          if (!target || target === current) return;
          const link = rows.current.get(target)?.link();
          link?.focus();
          link?.scrollIntoView({ block: "nearest", inline: "nearest" });
          return;
        }
        case "clear":
          if (!current) return;
          e.preventDefault();
          focused?.blur();
          return;
        default:
          if (current && rows.current.get(current)?.run(action)) e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [horizontal]);

  return <NavCtx.Provider value={nav}>{children}</NavCtx.Provider>;
}

/** Props for a picker's `PropertyMenu`: controlled open state plus focus hand-back to the row. */
export type RowMenuProps = (menu: RowMenu) => {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
};

/**
 * Wires one list row or board card into keyboard navigation. Spread `rowProps` on the outer element,
 * pass `linkRef` to the task link, and spread `menus(key)` onto each picker so S/P/A/L can open it.
 */
export function useTaskRow(task: TaskSummary, column: string) {
  const nav = useContext(NavCtx);
  const { idx, canEditTasks: canEdit, updateTask } = useWorkspace();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const byKeyboard = useRef(false);

  // The registered handler always sees the latest task and store.
  const latest = useRef({ task, canEdit, idx, updateTask });
  latest.current = { task, canEdit, idx, updateTask };

  const id = task.id;
  useEffect(() => {
    if (!nav) return;
    const unregister = nav.register({
      id,
      column,
      link: () => linkRef.current,
      run(action) {
        const { task, canEdit, idx, updateTask } = latest.current;
        if (!canEdit) return false;
        nav.holdFocus(id);
        if (action.type === "menu") {
          byKeyboard.current = true;
          setMenu(action.menu);
        } else {
          const states = idx.boot.workflowStates.filter((s) => s.teamId === task.teamId);
          const stateId = doneToggleTarget(states, task.stateId);
          if (stateId) void updateTask(task.id, { stateId });
        }
        return true;
      },
    });
    // A task that moved group (new parent, so a new element) takes its focus with it.
    if (nav.takeFocus(id)) linkRef.current?.focus();
    return unregister;
  }, [nav, id, column]);

  const menus = useCallback<RowMenuProps>(
    (key) => ({
      open: menu === key,
      onOpenChange: (open) => {
        // Closing keeps the flag: onCloseAutoFocus (which runs after) needs it.
        if (open) byKeyboard.current = false;
        setMenu(open ? key : null);
      },
      onCloseAutoFocus: (event) => {
        // Menus opened by a shortcut hand focus back to the row so J/K and Space keep working.
        if (byKeyboard.current) {
          event.preventDefault();
          linkRef.current?.focus();
        }
        byKeyboard.current = false;
        nav?.releaseFocus(id);
      },
    }),
    [menu, nav, id],
  );

  return { linkRef, menus, rowProps: { "data-task-id": task.id } };
}

/**
 * Invisible anchor for a menu whose normal trigger isn't on screen (status on a board card, labels in a row),
 * so the S and L shortcuts have somewhere to open from.
 */
export function MenuAnchor({ className }: { className?: string }) {
  return <span aria-hidden className={cn("pointer-events-none size-0 shrink-0", className)} />;
}
