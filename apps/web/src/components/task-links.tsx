"use client";

import type { TaskLinkCreateInput } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { TaskPicker } from "./task-pickers";

const captions = { related: "Related to", duplicate_of: "Duplicate of", duplicated_by: "Duplicated by" };

function linksApi() {
  return browserApi().v1.workspaces[":slug"].tasks[":id"].links;
}

type Links = Awaited<ReturnType<typeof readLinks>>["links"];

function readLinks(slug: string, id: string) {
  return unwrap(linksApi().$get({ param: { slug, id } }));
}

export function TaskLinks({ taskId, teamId }: { taskId: string; teamId: string }) {
  const { slug, sync, idx, canEditTasks } = useWorkspace();
  const [links, setLinks] = useState<Links>([]);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [close, setClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const currentTeamId = idx.tasks.get(taskId)?.teamId ?? teamId;
  const hasCanceledState = idx.boot.workflowStates.some(
    (s) => s.teamId === currentTeamId && s.type === "canceled",
  );
  const hasOriginal = links.some((link) => link.kind === "duplicate_of");

  useEffect(
    () =>
      sync.onChanges((changes) => {
        if (
          changes.some(
            (row) =>
              row.entity === "task_link" &&
              Array.isArray(row.data?.taskIds) &&
              row.data.taskIds.includes(taskId),
          )
        ) {
          setRevision((value) => value + 1);
        }
      }),
    [sync, taskId],
  );

  useEffect(() => {
    let current = true;
    readLinks(slug, taskId).then(
      ({ links }) => {
        if (!current) return;
        setLinks(links);
        setError(undefined);
      },
      (err) => {
        if (current) setError(errorMessage(err));
      },
    );
    return () => {
      current = false;
    };
  }, [slug, taskId, revision]);

  async function change(input: TaskLinkCreateInput | string) {
    setBusy(true);
    const param = { slug, id: taskId };
    try {
      if (typeof input === "string") {
        await unwrap(linksApi()[":linkId"].$delete({ param: { ...param, linkId: input } }));
      } else {
        await unwrap(linksApi().$post({ param, json: input }));
        setClose(false);
      }
      setRevision((value) => value + 1);
      sync.pull();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!canEditTasks && !links.length && !error) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Task links">
      <h2 className="text-sm font-medium text-muted-foreground">Task links</h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {links.map((link) => {
        const task = idx.tasks.get(link.task.id) ?? link.task;
        return (
          <div key={link.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted">
            <span className="shrink-0 text-muted-foreground">{captions[link.kind]}</span>
            <Link href={`/${slug}/task/${task.id}`} className="min-w-0 flex-1 truncate hover:underline">
              {task.reference && <span className="mr-2 text-muted-foreground">{task.reference}</span>}
              {task.title}
            </Link>
            {canEditTasks && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label={`Remove link to ${task.title}`}
                onClick={() => void change(link.id)}
              >
                <X />
              </Button>
            )}
          </div>
        );
      })}
      {canEditTasks && (
        <div className="flex flex-wrap items-center gap-2">
          <TaskPicker
            exclude={(id) =>
              id === taskId || links.some((link) => link.kind === "related" && link.task.id === id)
            }
            onChange={(targetId) => targetId && void change({ kind: "related", targetId })}
          >
            <Button type="button" variant="ghost" size="xs" disabled={busy}>
              <Plus /> Add related task
            </Button>
          </TaskPicker>
          {!hasOriginal && (
            <TaskPicker
              exclude={(id) => id === taskId}
              onChange={(targetId) =>
                targetId && void change({ kind: "duplicate_of", targetId, close: hasCanceledState && close })
              }
            >
              <Button type="button" variant="ghost" size="xs" disabled={busy}>
                <Plus /> Mark as duplicate
              </Button>
            </TaskPicker>
          )}
          {!hasOriginal && hasCanceledState && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={close} onChange={(event) => setClose(event.target.checked)} />
              Close when marked as duplicate
            </label>
          )}
        </div>
      )}
    </section>
  );
}
