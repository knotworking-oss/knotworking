"use client";

import { cn } from "@knotworking/ui/lib/utils";
import type { SuggestionProps } from "@tiptap/suggestion";
import { AtSign, FileText, Hash } from "lucide-react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import type { MentionItem } from "@/lib/mentions";

export interface MentionMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

const groups = { user: "People", task: "Tasks", doc: "Pages" } as const;
const icons = { user: AtSign, task: Hash, doc: FileText } as const;

/**
 * The `@` picker. Like the slash menu, focus stays in the editor: the suggestion plugin forwards arrow
 * keys, Enter and Tab here through `ref.onKeyDown`.
 */
export function MentionMenu({
  ref,
  items,
  command,
  clientRect,
}: SuggestionProps<MentionItem, MentionItem> & { ref: Ref<MentionMenuHandle> }) {
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => setActive(0), [items]);

  useLayoutEffect(() => {
    const rect = clientRect?.();
    if (!rect) return setPosition(null);
    const height = list.current?.offsetHeight ?? 320;
    const below = rect.bottom + 6;
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
      aria-label="Mention a person, task or page"
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
      className="fixed z-50 flex max-h-80 w-64 flex-col overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((item, i) => {
        const Icon = icons[item.kind];
        return (
          <div key={`${item.kind}:${item.id}`} role="presentation">
            {items[i - 1]?.kind !== item.kind && (
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{groups[item.kind]}</div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              data-index={i}
              // Keep focus (and the selection) in the editor.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => command(item)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
