import Link from "next/link";
import { notFound } from "next/navigation";
import { DisplayOptions } from "@/components/display-options";
import { PageHeader } from "@/components/page-header";
import { TasksView } from "@/components/tasks-view";
import { ViewSwitcher } from "@/components/view-switcher";
import { getBootstrap } from "@/lib/api";
import { taskOrderings } from "@/lib/model";

type Props = {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ view?: string; order?: string }>;
};

export default async function SavedViewPage({ params, searchParams }: Props) {
  const [{ workspace, id }, { view, order }] = await Promise.all([params, searchParams]);
  const boot = await getBootstrap(workspace);
  const saved = boot.taskViews.find((row) => row.id === id);
  if (!saved) notFound();
  const layout = view === "board" || view === "list" || view === "calendar" ? view : saved.spec.layout;
  const ordering = taskOrderings.find((value) => value === order) ?? saved.spec.sort;
  return (
    <>
      <PageHeader
        actions={
          <>
            <ViewSwitcher view={layout} explicitDefault />
            <DisplayOptions
              ordering={ordering}
              defaultGroup={saved.spec.group}
              defaultSubgroup={saved.spec.subgroup}
              layout={layout}
              defaultProperties={saved.spec.properties}
              explicitDefault
            />
          </>
        }
      >
        <div className="flex items-center gap-2">
          <Link
            className="text-sm text-muted-foreground hover:underline"
            href={`/${workspace}/my-tasks/views`}
          >
            Views
          </Link>
          <span aria-hidden="true">/</span>
          <h1 className="min-w-0 truncate font-medium">{saved.name}</h1>
        </div>
      </PageHeader>
      <div className="flex-1 overflow-auto">
        <TasksView teamId={saved.teamId ?? undefined} view={layout} ordering={ordering} savedView={saved} />
      </div>
    </>
  );
}
