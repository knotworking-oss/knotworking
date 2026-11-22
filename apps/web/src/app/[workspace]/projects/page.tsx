import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { NewProjectButton } from "@/components/project-actions";
import { ProjectsView } from "@/components/projects-view";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <>
      <PageHeader actions={<NewProjectButton />}>
        <h1 className="font-medium">Projects</h1>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <ProjectsView />
      </div>
    </>
  );
}
