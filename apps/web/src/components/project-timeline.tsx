"use client";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@knotworking/ui/components/empty";
import { ChartGantt } from "lucide-react";
import { useRouter } from "next/navigation";
import { todayInZone } from "@knotworking/core";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";
import { GanttChart, type GanttTask } from "./gantt-chart";
import { OlderTasksControl, useOlderTasks } from "./older-tasks";

/**
 * The project page's Timeline view: the project's tasks on a Gantt chart, live from the workspace
 * store. Rescheduling goes through the optimistic `updateTask`, so it syncs and rolls back on failure.
 */
export function ProjectTimeline({ projectId }: { projectId: string }) {
  const { idx, slug, canEditTasks: canEdit, updateTask } = useWorkspace();
  const history = useOlderTasks({ projectId, sort: "manual" });
  const { tasks } = history;
  const router = useRouter();
  const project = idx.projects.get(projectId);
  const milestones = (idx.boot.projectMilestones ?? []).filter(
    (row) => row.projectId === projectId && row.targetDate,
  );
  const timeZone = useWorkspaceTimeZone();
  // "Today" is the workspace's calendar day, worked out after mount: the server render and the
  // browser may disagree about it around midnight, so neither decides it during hydration.
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => setToday(todayInZone(timeZone)), [timeZone]);

  const rows = useMemo<GanttTask[]>(
    () =>
      tasks
        .filter((t) => t.projectId === projectId)
        .map((t) => {
          const state = idx.states.get(t.stateId);
          const assignee = t.assigneeId ? idx.users.get(t.assigneeId) : undefined;
          return {
            id: t.id,
            parentId: t.parentId,
            startDate: t.startDate,
            dueDate: t.dueDate,
            sortOrder: t.sortOrder,
            title: t.title,
            status: state?.type ?? "backlog",
            statusProgress: idx.stateProgress(t.stateId),
            assignee: assignee ? { name: assignee.name, avatarUrl: assignee.avatarUrl } : null,
            href: `/${slug}/task/${t.id}`,
          };
        }),
    [tasks, idx, projectId, slug],
  );
  const ids = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const relations = useMemo(
    () =>
      [
        ...new Map(
          [...(history.relations ?? []), ...(idx.boot.taskRelations ?? [])].map((relation) => [
            relation.id,
            relation,
          ]),
        ).values(),
      ].filter((r) => ids.has(r.blockingTaskId) && ids.has(r.blockedTaskId)),
    [idx, ids, history.relations],
  );

  if (rows.length === 0 && milestones.length === 0) {
    return (
      <>
        <OlderTasksControl history={history} />
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChartGantt />
            </EmptyMedia>
            <EmptyTitle>No tasks</EmptyTitle>
            <EmptyDescription>
              Tasks in this project show up here once they have start or due dates.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  if (!today) return null;

  return (
    <>
      <OlderTasksControl history={history} />
      <GanttChart
        tasks={rows}
        relations={relations}
        project={project ? { startDate: project.startDate, targetDate: project.targetDate } : undefined}
        milestones={milestones}
        today={today}
        canEdit={canEdit}
        onReschedule={(id, patch) => void updateTask(id, patch)}
        onOpen={(t) => t.href && router.push(t.href)}
      />
    </>
  );
}
