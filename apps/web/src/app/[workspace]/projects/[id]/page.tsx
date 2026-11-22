import type { Metadata } from "next";
import { ProjectDetail } from "@/components/project-detail";
import { getBootstrap } from "@/lib/api";

type Props = {
  params: Promise<{ workspace: string; id: string }>;
  searchParams: Promise<{ view?: string; order?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  const boot = await getBootstrap(workspace);
  return { title: boot.projects.find((p) => p.id === id)?.name ?? "Project" };
}

export default async function ProjectPage({ params, searchParams }: Props) {
  const [{ id }, { view, order }] = await Promise.all([params, searchParams]);
  // The project is read from the workspace store, so it follows edits and shows
  // a "not found" state itself if it has been deleted.
  return <ProjectDetail id={id} view={view} order={order} />;
}
