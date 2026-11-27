"use client";

import { taskActivityFields, type TaskActivityDetails, type TaskActivityField } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { useState } from "react";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";
import { useWorkspace } from "@/lib/workspace-store";

const fieldLabels: Record<TaskActivityField, string> = {
  title: "title",
  description: "description",
  stateId: "status",
  priority: "priority",
  estimateMinutes: "estimate",
  assigneeId: "assignee",
  projectId: "project",
  parentId: "parent task",
  startDate: "start date",
  dueDate: "due date",
  sortOrder: "manual order",
  labelIds: "labels",
};

function activityText(details: TaskActivityDetails) {
  switch (details.kind) {
    case "created":
      return "created the task";
    case "updated": {
      const fields = taskActivityFields
        .filter((field) => details.changes[field])
        .map((field) => fieldLabels[field]);
      return `changed the ${new Intl.ListFormat("en", { type: "conjunction" }).format(fields)}`;
    }
    case "dependency_added":
      return "added a dependency";
    case "dependency_removed":
      return "removed a dependency";
  }
}

type ActivityEvent = {
  id: string;
  actorId: string | null;
  createdAt: string;
  details: TaskActivityDetails;
};

export function TaskActivity({ taskId }: { taskId: string }) {
  const { slug, idx } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(before?: string) {
    setLoading(true);
    setError(null);
    try {
      const page = await unwrap(
        browserApi().v1.workspaces[":slug"].tasks[":id"].activity.$get({
          param: { slug, id: taskId },
          query: { before },
        }),
      );
      setEvents((current) => (before ? [...current, ...page.events] : page.events));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-4 flex flex-col gap-2" aria-labelledby="task-activity-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 id="task-activity-heading" className="text-sm font-medium text-muted-foreground">
          Activity
        </h2>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          disabled={loading}
          onClick={() => {
            setOpen(!open);
            if (!open) void load();
          }}
        >
          {open ? "Hide history" : "Show history"}
        </Button>
      </div>
      {open && (
        <div aria-busy={loading} className="space-y-2">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!loading && !error && events.length === 0 && (
            <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
          )}
          <ul className="space-y-2 text-sm">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-1"
              >
                <span>
                  <span className="font-medium">
                    {(event.actorId && idx.users.get(event.actorId)?.name) || "Unknown member"}
                  </span>{" "}
                  {activityText(event.details)}
                </span>
                <time dateTime={event.createdAt} className="text-xs text-muted-foreground">
                  {relativeTime(event.createdAt)}
                </time>
              </li>
            ))}
          </ul>
          {cursor && (
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(cursor)}>
              Load older activity
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
