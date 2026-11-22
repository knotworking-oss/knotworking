"use client";

import { cn } from "@knotworking/ui/lib/utils";
import { AtSign, FileText, Hash } from "lucide-react";
import Link from "next/link";
import { mentionHref, resolveMention } from "@/lib/mentions";
import { useOptionalWorkspace } from "@/lib/workspace-store";

const unavailableNames: Record<string, string> = { user: "person", task: "task", doc: "page" };

const chipClass =
  "inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-px align-baseline text-[0.92em] font-medium leading-snug text-foreground";

/**
 * An inline mention of a person, task or page, shared by `DocRenderer` and the editor's node view. The
 * stored `label` is only a cache: the name or title is read live from the workspace store, and a target
 * that is gone (deleted, archived team, left the workspace) shows as a muted "unavailable" chip.
 * Tasks and pages link to their page; people are just a chip. Outside a workspace (the design page) it
 * shows the cached label without a link.
 *
 * `editing`: inside the editor, a plain click selects the chip (so it can be deleted or moved); hold
 * Cmd or Ctrl to follow the link.
 */
export function MentionChip({
  kind,
  id,
  label,
  editing = false,
}: {
  kind: string;
  id: string;
  label?: string;
  editing?: boolean;
}) {
  const workspace = useOptionalWorkspace();
  const resolved = workspace ? resolveMention(workspace.idx, { kind, id, label }) : null;
  const Icon = kind === "user" ? AtSign : kind === "task" ? Hash : FileText;

  if (resolved && !resolved.available) {
    return (
      <span
        data-mention-unavailable=""
        title={resolved.label ? `${resolved.label} (no longer available)` : "No longer available"}
        className={cn(chipClass, "bg-muted/50 font-normal text-muted-foreground italic")}
      >
        <Icon aria-hidden className="size-3 shrink-0 opacity-60" />
        <span className="truncate">Unavailable {unavailableNames[kind] ?? "item"}</span>
      </span>
    );
  }

  const text = resolved?.label || label || "Untitled";
  const body = (
    <>
      <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{text}</span>
    </>
  );
  const href = workspace ? mentionHref(workspace.slug, kind, id) : null;
  if (!href) return <span className={chipClass}>{body}</span>;
  return (
    <Link
      href={href}
      className={cn(chipClass, "no-underline hover:bg-accent hover:text-accent-foreground")}
      onClick={(e) => {
        if (editing && !(e.metaKey || e.ctrlKey)) e.preventDefault();
      }}
    >
      {body}
    </Link>
  );
}
