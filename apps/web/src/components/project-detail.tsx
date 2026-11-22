"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import { Button } from "@knotworking/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@knotworking/ui/components/empty";
import { ProjectHealthBadge, ProjectStatusBadge } from "@knotworking/ui/components/project-badges";
import { Progress } from "@knotworking/ui/components/progress";
import { TimeSummary } from "@knotworking/ui/components/time-tracking";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { formatShortDate } from "@/lib/format";
import { parseOrdering } from "@/lib/model";
import { noProgress, projectProgress } from "@/lib/projects";
import { projectTime } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace-store";
import { DisplayOptions } from "./display-options";
import { DocsSection } from "./docs-section";
import { NewTaskButton } from "./new-task-button";
import { PageHeader } from "./page-header";
import { ProjectActions } from "./project-actions";
import { ProjectTimeline } from "./project-timeline";
import { TasksView } from "./tasks-view";
import { ViewSwitcher } from "./view-switcher";
import { MemberAvatar } from "@/components/member-avatar";

/** One project: its details and its tasks, live from the workspace store. */
export function ProjectDetail({ id, view, order }: { id: string; view?: string; order?: string }) {
  const { idx, tasks, slug } = useWorkspace();
  const router = useRouter();
  const project = idx.projects.get(id);
  const progress = useMemo(() => projectProgress(tasks, idx).get(id) ?? noProgress, [tasks, idx, id]);
  const time = useMemo(() => projectTime(tasks, idx.loggedMinutes).get(id), [tasks, idx, id]);
  const mode = view === "board" || view === "timeline" ? view : "list";
  const ordering = parseOrdering(order);

  if (!project) {
    return (
      <>
        <PageHeader>
          <h1 className="font-medium">Project not found</h1>
        </PageHeader>
        <Empty className="mt-10">
          <EmptyHeader>
            <EmptyTitle>This project doesn&apos;t exist</EmptyTitle>
            <EmptyDescription>It may have been deleted.</EmptyDescription>
          </EmptyHeader>
          <Button asChild variant="outline" size="sm">
            <Link href={`/${slug}/projects`}>Back to projects</Link>
          </Button>
        </Empty>
      </>
    );
  }

  const lead = project.leadId ? idx.users.get(project.leadId) : undefined;
  const teams = idx.boot.projectTeams
    .filter((l) => l.projectId === id)
    .map((l) => idx.teams.get(l.teamId))
    .filter((t) => t !== undefined);
  const pct = Math.round(progress.ratio * 100);

  return (
    <>
      <PageHeader
        actions={
          <>
            <ViewSwitcher view={mode} timeline />
            {mode !== "timeline" && <DisplayOptions ordering={ordering} />}
            <NewTaskButton defaults={{ projectId: id }} />
            <ProjectActions project={project} onDeleted={() => router.push(`/${slug}/projects`)} />
          </>
        }
      >
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/projects`}>Projects</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>
                {project.icon} {project.name}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>

      <div className="flex-1 overflow-auto">
        <section className="flex flex-col gap-3 border-b px-6 py-4 text-sm">
          {project.description && <p className="max-w-3xl text-muted-foreground">{project.description}</p>}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <ProjectStatusBadge status={project.status} />
            {project.health && <ProjectHealthBadge health={project.health} />}
            <span className="flex items-center gap-2">
              {lead && (
                <MemberAvatar userId={lead.id} name={lead.name} src={lead.avatarUrl} className="size-5" />
              )}
              {lead?.name ?? <span className="text-muted-foreground">No lead</span>}
            </span>
            {(project.startDate || project.targetDate) && (
              <span className="text-muted-foreground">
                {project.startDate ? formatShortDate(project.startDate) : "…"} →{" "}
                {project.targetDate ? formatShortDate(project.targetDate) : "…"}
              </span>
            )}
            {teams.length > 0 && (
              <span className="text-muted-foreground">
                {teams.map((t) => `${t.icon ?? ""} ${t.name}`.trim()).join(", ")}
              </span>
            )}
            <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              {time && (time.logged > 0 || time.estimate > 0) && (
                <TimeSummary logged={time.logged} estimate={time.estimate || null} className="mr-2" />
              )}
              {progress.completed}/{progress.total} tasks
              <Progress value={pct} className="w-28" aria-label={`${project.name} progress`} />
              <span className="tabular-nums">{pct}%</span>
            </span>
          </div>
        </section>
        {mode === "timeline" ? (
          <ProjectTimeline projectId={id} />
        ) : (
          <TasksView
            projectId={id}
            view={mode}
            ordering={ordering}
            emptyDescription="No tasks in this project yet. Create one or add an existing task to it."
          />
        )}
        <DocsSection scope={{ projectId: id }} subject="this project" />
      </div>
    </>
  );
}
