"use client";

import { cn } from "@knotworking/ui/lib/utils";
import type { SaveStatus } from "@/lib/use-autosave";

const labels: Record<SaveStatus, string> = {
  idle: "",
  pending: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save",
  conflict: "Not saved: page changed",
};

/** Quiet autosave indicator. */
export function SaveStatusText({ status, className }: { status: SaveStatus; className?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "text-xs text-muted-foreground",
        (status === "error" || status === "conflict") && "text-destructive",
        className,
      )}
    >
      {labels[status]}
    </span>
  );
}
