"use client";

import { evaluateTaskFilter, type TaskFilter, type TaskOrdering } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

export function needsFullTaskGraph(filter?: TaskFilter) {
  return (
    !!filter &&
    evaluateTaskFilter(filter.expression, {
      condition: ({ field }) => field === "hasSubtasks" || field === "blocked",
      and: (children) => children.some(Boolean),
      or: (children) => children.some(Boolean),
    })
  );
}

/** Relationship filters need children and dependencies beyond the browser's task window. */
export function useFilteredTasks({
  filter,
  teamId,
  projectId,
  assigneeId,
  sort,
}: {
  filter?: TaskFilter;
  teamId?: string;
  projectId?: string;
  assigneeId?: string;
  sort: TaskOrdering;
}) {
  const { slug, sync } = useWorkspace();
  const serialized = filter ? JSON.stringify(filter) : undefined;
  const key = JSON.stringify([slug, serialized, teamId, projectId, assigneeId, sort]);
  const [page, setPage] = useState<{ key: string; tasks: TaskSummary[]; nextCursor: string | null }>();
  const [request, setRequest] = useState<{ key: string; loading: boolean; error?: string }>();
  const requestId = useRef(0);
  const loaded = useRef<{ key: string; pages: number } | undefined>(undefined);

  const load = useCallback(
    async (cursor?: string) => {
      if (!serialized) return;
      const id = ++requestId.current;
      setRequest({ key, loading: true });
      try {
        const previousDepth = loaded.current?.key === key ? loaded.current.pages : 0;
        const depth = cursor ? 1 : Math.max(1, previousDepth);
        const tasks: TaskSummary[] = [];
        let nextCursor = cursor ?? null;
        let pages = 0;
        do {
          const result = await unwrap(
            browserApi().v1.workspaces[":slug"].tasks.$get({
              param: { slug },
              query: {
                teamId,
                projectId,
                assigneeId,
                sort,
                filter: serialized,
                limit: "50",
                cursor: nextCursor ?? undefined,
              },
            }),
          );
          if (id !== requestId.current) return;
          tasks.push(...result.tasks);
          nextCursor = result.nextCursor;
          pages++;
        } while (nextCursor && pages < depth);
        loaded.current = { key, pages: cursor ? previousDepth + pages : pages };
        setPage((previous) => ({
          key,
          nextCursor,
          tasks: [
            ...new Map(
              [...(cursor && previous?.key === key ? previous.tasks : []), ...tasks].map((task) => [
                task.id,
                task,
              ]),
            ).values(),
          ],
        }));
        setRequest({ key, loading: false });
      } catch (err) {
        if (id === requestId.current) setRequest({ key, loading: false, error: errorMessage(err) });
      }
    },
    [key, serialized, slug, teamId, projectId, assigneeId, sort],
  );

  useEffect(() => {
    if (!serialized) return;
    void load();
    const unsubscribe = sync.onChanges((changes) => {
      if (
        changes.some(
          ({ entity }) =>
            entity === "task" ||
            entity === "task_relation" ||
            entity === "workflow_state" ||
            entity === "task_label" ||
            entity === "team",
        )
      )
        void load();
    });
    return () => {
      requestId.current++;
      unsubscribe();
    };
  }, [serialized, load, sync]);

  const current = page?.key === key ? page : undefined;
  return {
    tasks: current?.tasks ?? [],
    loading: request?.key !== key || request.loading,
    error: request?.key === key ? request.error : undefined,
    nextCursor: current?.nextCursor,
    load,
  };
}

export function FilteredTasksControl({ result }: { result: ReturnType<typeof useFilteredTasks> }) {
  if (!result.loading && !result.error && !result.nextCursor) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 px-6 py-3">
      {result.loading && (
        <span role="status" className="text-sm text-muted-foreground">
          Loading matching tasks…
        </span>
      )}
      {result.error && (
        <span role="alert" className="text-sm text-destructive">
          {result.error}
        </span>
      )}
      {(result.error || result.nextCursor) && (
        <Button
          size="sm"
          variant="outline"
          disabled={result.loading}
          onClick={() => void result.load(result.error ? undefined : (result.nextCursor ?? undefined))}
        >
          {result.error ? "Retry" : "Load more matching tasks"}
        </Button>
      )}
    </div>
  );
}
