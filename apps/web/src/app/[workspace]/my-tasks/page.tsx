import type { Metadata } from "next";
import { myTasksView } from "@knotworking/core";
import { DisplayOptions } from "@/components/display-options";
import { TasksView } from "@/components/tasks-view";
import { NewTaskButton } from "@/components/new-task-button";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { ViewSwitcher } from "@/components/view-switcher";
import { getMe } from "@/lib/api";
import { taskOrderings } from "@/lib/model";

export const metadata: Metadata = { title: "My tasks" };

export default async function MyTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; view?: string }>;
}) {
  const [{ order, view }, me] = await Promise.all([searchParams, getMe()]);
  const pinned = myTasksView(me.user.id);
  const ordering = taskOrderings.find((option) => option === order) ?? pinned.spec.sort;
  const mode = view === "board" || view === "calendar" ? view : pinned.spec.layout;
  const assigneeId = pinned.spec.filter.expression.value;

  return (
    <>
      <PageHeader
        actions={
          <>
            <ModuleDashboardsLink module="tasks" />
            <ViewSwitcher view={mode} />
            <DisplayOptions ordering={ordering} layout={mode} defaultGroup={pinned.spec.group} />
            <NewTaskButton defaults={{ assigneeId }} />
          </>
        }
      >
        <h1 className="font-medium">{pinned.name}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <TasksView assigneeId={assigneeId} view={mode} ordering={ordering} />
      </div>
    </>
  );
}
