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

  const load = useCallback(
    async (cursor?: string) => {
      if (!serialized) return;
      const id = ++requestId.current;
      setRequest({ key, loading: true });
      try {
        const result = await unwrap(
          browserApi().v1.workspaces[":slug"].tasks.$get({
            param: { slug },
            query: { teamId, projectId, assigneeId, sort, filter: serialized, limit: "50", cursor },
          }),
        );
        if (id !== requestId.current) return;
        setPage((previous) => ({
          key,
          nextCursor: result.nextCursor,
          tasks:
            cursor && previous?.key === key
              ? [...new Map([...previous.tasks, ...result.tasks].map((task) => [task.id, task])).values()]
              : result.tasks,
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
