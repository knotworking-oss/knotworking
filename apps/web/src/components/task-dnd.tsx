"use client";

import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { TaskSummary } from "@/lib/api";
import type { TaskGroup } from "@/lib/model";

export type DropHandler = (taskId: string, groupKey: string, column: TaskSummary[], index: number) => void;

/**
 * Drag-and-drop across grouped tasks (list sections or board columns).
 *
 * While dragging, the grouping is held locally so items can move between groups
 * with a live preview. On drop, `onDrop` gets the group and the column's final
 * order; the caller turns that into a state change and/or a new sort key.
 */
export function TaskDndProvider({
  groups,
  onDrop,
  renderOverlay,
  children,
}: {
  groups: TaskGroup[];
  onDrop: DropHandler;
  renderOverlay: (task: TaskSummary) => ReactNode;
  children: (state: { columns: Record<string, TaskSummary[]>; dragging: boolean }) => ReactNode;
}) {
  // Stable ID so dnd-kit's accessibility attributes match between server and client render.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter opens the task; Space picks it up.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const byId = useMemo(() => new Map(groups.flatMap((g) => g.tasks.map((i) => [i.id, i]))), [groups]);
  const settled = useMemo(
    () => Object.fromEntries(groups.map((g) => [g.key, g.tasks.map((i) => i.id)])),
    [groups],
  );
  const [live, setLive] = useState<Record<string, string[]> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const origin = useRef<{ key: string; index: number } | null>(null);
  const suppressClick = useRef(false);
  const ids = live ?? settled;

  const containerOf = (id: UniqueIdentifier, from = ids) => {
    const key = String(id);
    if (key in from) return key;
    return Object.keys(from).find((k) => from[k]!.includes(key));
  };

  const reset = () => {
    setLive(null);
    setActiveId(null);
    origin.current = null;
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    const key = containerOf(active.id, settled);
    if (!key) return;
    origin.current = { key, index: settled[key]!.indexOf(String(active.id)) };
    setActiveId(String(active.id));
    setLive(settled);
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !live) return;
    const from = containerOf(active.id, live);
    const to = containerOf(over.id, live);
    if (!from || !to || from === to) return;
    setLive((cur) => {
      if (!cur) return cur;
      const target = cur[to]!;
      const overIndex = target.indexOf(String(over.id));
      const index = overIndex === -1 ? target.length : overIndex;
      return {
        ...cur,
        [from]: cur[from]!.filter((id) => id !== active.id),
        [to]: [...target.slice(0, index), String(active.id), ...target.slice(index)],
      };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    const current = live;
    const start = origin.current;
    reset();
    if (!over || !current || !start) return;
    const key = containerOf(active.id, current);
    if (!key) return;
    let column = current[key]!;
    const overIndex = column.indexOf(String(over.id));
    const activeIndex = column.indexOf(String(active.id));
    if (overIndex !== -1 && overIndex !== activeIndex) column = arrayMove(column, activeIndex, overIndex);
    const index = column.indexOf(String(active.id));
    if (key === start.key && index === start.index) return;
    onDrop(String(active.id), key, column.map((id) => byId.get(id)!).filter(Boolean), index);
  };

  const columns = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(ids).map(([k, list]) => [k, list.map((id) => byId.get(id)!).filter(Boolean)]),
      ),
    [ids, byId],
  );
  const active = activeId ? byId.get(activeId) : undefined;

  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "To move a task, press space. Use the arrow keys to move it, then press space again to drop it, or escape to cancel.",
        },
      }}
    >
      {/* A drag that ends over a link must not also open it. */}
      <div
        className="contents"
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {children({ columns, dragging: activeId !== null })}
      </div>
      <DragOverlay dropAnimation={null}>{active ? renderOverlay(active) : null}</DragOverlay>
    </DndContext>
  );
}

/** One group's droppable area + sortable context. */
export function TaskDropZone({
  id,
  items,
  className,
  children,
  as: Tag = "div",
}: {
  id: string;
  items: TaskSummary[];
  className?: string;
  children: ReactNode;
  as?: "div" | "ul";
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <SortableContext id={id} items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
      <Tag ref={setNodeRef as never} className={className} data-over={isOver || undefined}>
        {children}
      </Tag>
    </SortableContext>
  );
}

/** Sortable wrapper: returns props for the moving element and for the drag handle (the task link). */
export function useSortableTask(id: string, disabled?: boolean) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return {
    isDragging,
    nodeProps: { ref: setNodeRef, style },
    handleProps: disabled
      ? {}
      : {
          ...listeners,
          "aria-describedby": attributes["aria-describedby"],
          "aria-roledescription": "sortable task",
        },
  };
}
