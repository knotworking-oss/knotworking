import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import { Separator } from "@knotworking/ui/components/separator";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Subtasks, TaskActions, TaskDependencies, TaskProperties, TaskTitle } from "@/components/task-detail";
import { Backlinks } from "@/components/backlinks";
import { PageHeader } from "@/components/page-header";
import { TaskAttachments } from "@/components/task-attachments";
import { TaskComments } from "@/components/task-comments";
import { TaskDescription } from "@/components/task-description";
import { TaskTime } from "@/components/task-time";
import {
  getBootstrap,
  getTask,
  getTaskAttachments,
  getTaskBacklinks,
  getTaskComments,
  type TaskSummary,
} from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { indexWorkspace } from "@/lib/model";

type Props = { params: Promise<{ workspace: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  const task = await getTask(workspace, id);
  return { title: task.title };
}

export default async function TaskPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const [boot, task, { comments }, { attachments }, backlinks] = await Promise.all([
    getBootstrap(slug),
    getTask(slug, id),
    getTaskComments(slug, id),
    getTaskAttachments(slug, id),
    getTaskBacklinks(slug, id),
  ]);
  const idx = indexWorkspace(boot);
  // The task's team is missing from the bootstrap when it has been archived.
  const team = idx.teams.get(task.teamId);
  if (!team) notFound();
  const creator = task.creatorId ? idx.users.get(task.creatorId) : undefined;
  const parent = task.parentId ? boot.tasks.find((i) => i.id === task.parentId) : undefined;
  const { description, children: _children, ...summary } = task;
  const initial: TaskSummary = summary;

  return (
    <>
      <PageHeader actions={<TaskActions initial={initial} teamKey={team.key} />}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/team/${team.key}`}>{team.name}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            {parent && (
              <>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={`/${slug}/task/${parent.id}`} className="max-w-60 truncate">
                      {parent.title}
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            )}
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-80 truncate">{task.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <article className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 sm:px-10 sm:py-12">
            <TaskTitle initial={initial} />
            {/* The properties sidebar only fits from `lg`; below that they sit under the title. */}
            <section
              aria-label="Properties"
              className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-4 lg:hidden"
            >
              <TaskProperties initial={initial} stacked />
            </section>
            <TaskDescription key={task.id} taskId={task.id} initial={description} />
            <Subtasks initial={initial} />
            <TaskDependencies initial={initial} />
            <TaskTime initial={initial} />
            <TaskAttachments taskId={task.id} initial={attachments} />
            <Backlinks
              slug={slug}
              heading="Mentioned in"
              backlinks={backlinks}
              teamKeys={new Map(boot.teams.map((t) => [t.id, t.key]))}
            />
            <TaskComments taskId={task.id} initial={comments} />
          </div>
        </article>

        <aside className="hidden w-80 shrink-0 flex-col gap-1 overflow-y-auto border-l bg-muted/30 p-5 lg:flex">
          <TaskProperties initial={initial} />
          <Separator className="my-3" />
          <p className="text-xs text-muted-foreground">
            Created by {creator?.name ?? "someone"} on{" "}
            {formatLongDate(task.createdAt, boot.workspace.timeZone)}
          </p>
        </aside>
      </div>
    </>
  );
}
