"use client";

import { olderClosedTaskFilter, type TaskOrdering } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { useEffect, useRef, useState } from "react";
import type { TaskRelation, TaskSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function useOlderTasks({
  teamId,
  projectId,
  assigneeId,
  sort,
}: {
  teamId?: string;
  projectId?: string;
  assigneeId?: string;
  sort: TaskOrdering;
}) {
  const { idx, tasks, slug, sync } = useWorkspace();
  const window = idx.boot.closedWindow;
  const cutoff = window?.cutoff;
  const key = JSON.stringify([slug, cutoff, teamId, projectId, assigneeId, sort]);
  const [page, setPage] = useState<{
    key: string;
    tasks: TaskSummary[];
    relations: TaskRelation[];
    cursor: string | null;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deleted = useRef(new Set<string>());
  const removedRelations = useRef(new Set<string>());
  const current = page?.key === key ? page : undefined;

  useEffect(
    () =>
      sync.onChanges((changes) => {
        const removed = changes.filter((c) => c.entity === "task" && c.action === "delete");
        const removedLinks = changes.filter((c) => c.entity === "task_relation" && c.action === "delete");
        if (removed.length === 0 && removedLinks.length === 0) return;
        for (const change of removed) deleted.current.add(change.entityId);
        for (const change of removedLinks) removedRelations.current.add(change.entityId);
        setPage(
          (page) =>
            page && {
              ...page,
              tasks: page.tasks.filter((task) => !deleted.current.has(task.id)),
              relations: page.relations.filter((relation) => !removedRelations.current.has(relation.id)),
            },
        );
      }),
    [sync],
  );

  async function load() {
    if (!cutoff || busy) return;
    setBusy(true);
    setError(undefined);
    const sinceStart = new Set(deleted.current);
    const relationDeletes = new Set(removedRelations.current);
    try {
      const response = await unwrap(
        browserApi().v1.workspaces[":slug"].tasks.$get({
          param: { slug },
          query: {
            teamId,
            projectId,
            assigneeId,
            sort,
            limit: "50",
            cursor: current?.cursor ?? undefined,
            includeRelations: "true",
            filter: JSON.stringify({ version: 1, expression: olderClosedTaskFilter(cutoff) }),
          },
        }),
      );
      const fresh = response.tasks.filter((task) => !deleted.current.has(task.id) || sinceStart.has(task.id));
      const relations = (response.relations ?? []).filter(
        (relation) => !removedRelations.current.has(relation.id) || relationDeletes.has(relation.id),
      );
      setPage((previous) => ({
        key,
        tasks: [...(previous?.key === key ? previous.tasks : []), ...fresh],
        relations: [...(previous?.key === key ? previous.relations : []), ...relations],
        cursor: response.nextCursor,
      }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const merged = current ? new Map(current.tasks.map((task) => [task.id, task])) : null;
  if (merged) for (const task of tasks) merged.set(task.id, task);
  return {
    tasks: merged ? [...merged.values()] : tasks,
    relations: current?.relations,
    show: Boolean(window?.olderCount && current?.cursor !== null) || Boolean(error),
    empty: !!current && current.tasks.length === 0 && !busy,
    busy,
    error,
    load,
  };
}

export function OlderTasksControl({ history }: { history: ReturnType<typeof useOlderTasks> }) {
  if (!history.show && !history.empty) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 px-6 py-3">
      {history.show && (
        <Button variant="outline" size="sm" disabled={history.busy} onClick={() => void history.load()}>
          {history.busy ? "Loading…" : "Load older closed tasks"}
        </Button>
      )}
      {history.empty && <span className="text-sm text-muted-foreground">No older closed tasks here.</span>}
      {history.error && (
        <span role="alert" className="text-sm text-destructive">
          {history.error}
        </span>
      )}
    </div>
  );
}
