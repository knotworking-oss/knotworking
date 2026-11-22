import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getPendingSignOffs } from "@/lib/api";
import { hasModuleLevel } from "@knotworking/core";
import { TrainingNav } from "../training-nav";
import { SignOffList } from "./sign-off-list";

export const metadata: Metadata = { title: "Training sign-off" };

export default async function TrainingSignOffPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const boot = await getBootstrap(slug);
  if (!hasModuleLevel(boot.modules.find((m) => m.id === "training")?.access, "manage")) notFound();
  const pending = await getPendingSignOffs(slug);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Training</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
          <h2 className="text-xl font-semibold tracking-tight">Awaiting sign-off</h2>
          <TrainingNav slug={slug} pendingCount={pending.total} />
          <SignOffList slug={slug} records={pending.records} />
        </div>
      </div>
    </>
  );
}
