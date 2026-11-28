"use client";

import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-store";

export function SavedTaskViews({ teamId }: { teamId?: string }) {
  const { idx, slug } = useWorkspace();
  const all = (idx.boot.taskViews ?? []).filter((view) => !view.teamId || idx.teams.has(view.teamId));
  const views = teamId ? all.filter((view) => view.teamId === teamId) : all;
  if (teamId && !views.length) {
    return (
      <p className="px-6 py-8 text-sm text-muted-foreground">
        Save a view from a task list or board to find it here.
      </p>
    );
  }
  return (
    <ul className="divide-y px-6">
      {!teamId && (
        <li>
          <Link
            href={`/${slug}/my-tasks`}
            className="flex items-center justify-between gap-3 py-4 hover:underline"
          >
            <span>My tasks</span>
            <span className="text-xs text-muted-foreground">Pinned</span>
          </Link>
        </li>
      )}
      {views.map((view) => (
        <li key={view.id}>
          <Link
            href={`/${slug}/my-tasks/views/${view.id}`}
            className="flex items-center justify-between gap-3 py-4 hover:underline"
          >
            <span className="truncate">
              {view.icon && `${view.icon} `}
              {view.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {view.scope === "team" && view.teamId
                ? idx.teams.get(view.teamId)?.name
                : view.scope === "personal"
                  ? "Personal"
                  : "Workspace"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
