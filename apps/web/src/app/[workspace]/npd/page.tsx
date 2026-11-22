import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getNpdProjects } from "@/lib/api";
import { NpdBoard } from "./npd-board";

export const metadata: Metadata = { title: "Product development" };

export default async function NpdPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = search.status === "all" ? "all" : "open";
  const { projects } = await getNpdProjects(slug, status);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Product development</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <NpdBoard slug={slug} projects={projects} status={status} />
      </div>
    </>
  );
}
