import type { Metadata } from "next";
import { hasModuleLevel, todayInZone } from "@knotworking/core";
import { PageHeader } from "@/components/page-header";
import { getBootstrap } from "@/lib/api";
import { RotaView } from "./view";
export const metadata: Metadata = { title: "Rota" };
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const boot = await getBootstrap(slug);
  const level = (id: string) => boot.modules.find((m) => m.id === id)?.access;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Rota</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <RotaView
          slug={slug}
          today={todayInZone(boot.workspace.timeZone)}
          canWrite={hasModuleLevel(level("workforce"), "write")}
          canManage={hasModuleLevel(level("workforce"), "manage")}
          canReadProduction={hasModuleLevel(level("production"), "read")}
        />
      </div>
    </>
  );
}
