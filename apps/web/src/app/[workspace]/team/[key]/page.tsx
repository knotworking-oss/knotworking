import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@knotworking/ui/components/button";
import { notFound } from "next/navigation";
import { DocsSection } from "@/components/docs-section";
import { DisplayOptions } from "@/components/display-options";
import { TasksView } from "@/components/tasks-view";
import { NewTaskButton } from "@/components/new-task-button";
import { PageHeader } from "@/components/page-header";
import { ViewSwitcher } from "@/components/view-switcher";
import { getBootstrap } from "@/lib/api";
import { parseOrdering } from "@/lib/model";

type Props = {
  params: Promise<{ workspace: string; key: string }>;
  searchParams: Promise<{ view?: string; order?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, key } = await params;
  const boot = await getBootstrap(workspace);
  return { title: boot.teams.find((t) => t.key === key.toUpperCase())?.name ?? "Team" };
}

export default async function TeamTasksPage({ params, searchParams }: Props) {
  const [{ workspace: slug, key }, { view, order }] = await Promise.all([params, searchParams]);
  const boot = await getBootstrap(slug);
  const team = boot.teams.find((t) => t.key === key.toUpperCase());
  if (!team) notFound();
  const mode = view === "board" || view === "calendar" ? view : "list";
  const ordering = parseOrdering(order);

  return (
    <>
      <PageHeader
        actions={
          <>
            <ViewSwitcher view={mode} />
            <DisplayOptions ordering={ordering} />
            <Button asChild variant="ghost" size="sm">
              <Link href={`/${slug}/my-tasks/views?team=${team.id}`}>Views</Link>
            </Button>
            <NewTaskButton defaults={{ teamId: team.id }} />
          </>
        }
      >
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <span>{team.icon}</span> {team.name}
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Tasks</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-auto">
        <TasksView
          teamId={team.id}
          view={mode}
          ordering={ordering}
          emptyDescription={`${team.name} has no tasks yet.`}
        />
        <DocsSection scope={{ teamId: team.id }} subject={team.name} />
      </div>
    </>
  );
}
