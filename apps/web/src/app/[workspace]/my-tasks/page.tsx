import type { Metadata } from "next";
import { DisplayOptions } from "@/components/display-options";
import { TasksView } from "@/components/tasks-view";
import { NewTaskButton } from "@/components/new-task-button";
import { ModuleDashboardsLink } from "@/components/module-dashboards-link";
import { PageHeader } from "@/components/page-header";
import { getMe } from "@/lib/api";
import { parseOrdering } from "@/lib/model";

export const metadata: Metadata = { title: "My tasks" };

export default async function MyTasksPage({ searchParams }: { searchParams: Promise<{ order?: string }> }) {
  const [{ order }, me] = await Promise.all([searchParams, getMe()]);
  const ordering = parseOrdering(order);

  return (
    <>
      <PageHeader
        actions={
          <>
            <ModuleDashboardsLink module="tasks" />
            <DisplayOptions ordering={ordering} />
            <NewTaskButton defaults={{ assigneeId: me.user.id }} />
          </>
        }
      >
        <h1 className="font-medium">My tasks</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <TasksView assignedToMe view="list" ordering={ordering} />
      </div>
    </>
  );
}
