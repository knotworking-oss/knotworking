import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getDefenceChecks, getDefenceControls } from "@/lib/api";
import { ControlsBoard } from "./controls-board";

export const metadata: Metadata = { title: "Security controls" };

export default async function DefenceControlsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = search.status === "all" ? "all" : "active";
  const [{ controls }, { checks }] = await Promise.all([
    getDefenceControls(slug, status),
    getDefenceChecks(slug, "all"),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Food defence</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ControlsBoard slug={slug} controls={controls} checks={checks} status={status} />
      </div>
    </>
  );
}
