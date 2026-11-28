import type { Metadata } from "next";
import { DisplayOptions } from "@/components/display-options";
import { TasksView } from "@/components/tasks-view";
import { NewTaskButton } from "@/components/new-task-button";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { ViewSwitcher } from "@/components/view-switcher";
import { getMe } from "@/lib/api";
import { parseOrdering } from "@/lib/model";

export const metadata: Metadata = { title: "My tasks" };

export default async function MyTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; view?: string }>;
}) {
  const [{ order, view }, me] = await Promise.all([searchParams, getMe()]);
  const ordering = parseOrdering(order);
  const mode = view === "board" || view === "calendar" ? view : "list";

  return (
    <>
      <PageHeader
        actions={
          <>
            <ModuleDashboardsLink module="tasks" />
            <ViewSwitcher view={mode} />
            <DisplayOptions ordering={ordering} layout={mode} />
            <NewTaskButton defaults={{ assigneeId: me.user.id }} />
          </>
        }
      >
        <h1 className="font-medium">My tasks</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <TasksView assignedToMe view={mode} ordering={ordering} />
      </div>
    </>
  );
}
