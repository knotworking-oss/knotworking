import type { Metadata } from "next";
import { hasModuleLevel, todayInZone } from "@knotworking/core";
import { PageHeader } from "@/components/page-header";
import { getBootstrap } from "@/lib/api";
import { StaffingView } from "./view";
export const metadata: Metadata = { title: "Staffing" };
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const boot = await getBootstrap(slug);
  const level = (id: string) => boot.modules.find((m) => m.id === id)?.access;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Staffing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <StaffingView
          slug={slug}
          today={todayInZone(boot.workspace.timeZone)}
          canManage={hasModuleLevel(level("workforce"), "manage")}
          canReadTraining={hasModuleLevel(level("training"), "read")}
        />
      </div>
    </>
  );
}
