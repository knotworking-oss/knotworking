"use client";

import { cn } from "@knotworking/ui/lib/utils";
import type { SuggestionProps } from "@tiptap/suggestion";
import {
  CheckSquare,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  List,
  ListOrdered,
  Lightbulb,
  Minus,
  Quote,
  Table,
  Type,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import type { SlashCommandItem } from "./extensions";

const icons: Record<string, LucideIcon> = {
  Text: Type,
  "Heading 1": Heading1,
  "Heading 2": Heading2,
  "Heading 3": Heading3,
  "Bulleted list": List,
  "Numbered list": ListOrdered,
  "To-do list": CheckSquare,
  Quote,
  Callout: Lightbulb,
  "Code block": Code,
  Table,
  Divider: Minus,
  Image: ImageIcon,
};

export interface SlashMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * The `/` block menu. Focus stays in the editor: the suggestion plugin forwards
 * arrow keys and Enter here through `ref.onKeyDown`.
 */
export function SlashMenu({
  ref,
  items,
  command,
  clientRect,
}: SuggestionProps<SlashCommandItem, SlashCommandItem> & { ref: Ref<SlashMenuHandle> }) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => setActive(0), [items]);

  useLayoutEffect(() => {
    const rect = clientRect?.();
    if (!rect) return setPosition(null);
    const height = list.current?.offsetHeight ?? 320;
    const below = rect.bottom + 6;
    // Flip above the cursor when there's no room below.
    const top = below + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : below;
    setPosition({ top, left: Math.min(rect.left, window.innerWidth - 272) });
  }, [clientRect, items]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") {
        setActive((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setActive((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[active];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (!items.length) return null;
  return createPortal(
    <div
      ref={list}
      role="listbox"
      aria-label="Insert block"
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
      className="fixed z-50 flex max-h-80 w-64 flex-col overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Blocks</div>
      {items.map((item, i) => {
        const Icon = icons[item.title] ?? Type;
        return (
          <button
            key={item.title}
            type="button"
            role="option"
            aria-selected={i === active}
            data-index={i}
            // Keep focus (and the selection) in the editor.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => command(item)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none",
              i === active && "bg-accent text-accent-foreground",
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
              <Icon className="size-4 text-muted-foreground" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{item.title}</span>
              <span className="truncate text-xs text-muted-foreground">{item.description}</span>
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
