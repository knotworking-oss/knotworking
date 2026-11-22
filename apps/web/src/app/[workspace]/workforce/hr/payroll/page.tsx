import type { Metadata } from "next";
import { hasModuleLevel, todayInZone } from "@knotworking/core";
import { PageHeader } from "@/components/page-header";
import { getBootstrap } from "@/lib/api";
import { PayrollRuns } from "./view";
export const metadata: Metadata = { title: "Payroll runs" };
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const boot = await getBootstrap(slug);
  const level = (id: string) => boot.modules.find((m) => m.id === id)?.access;
  const allowed =
    hasModuleLevel(level("workforce_hr"), "manage") && hasModuleLevel(level("attendance"), "manage");
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Payroll runs</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        {allowed ? (
          <PayrollRuns slug={slug} today={todayInZone(boot.workspace.timeZone)} />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">
            Payroll runs need manage access to both Private HR records and Attendance.
          </p>
        )}
      </div>
    </>
  );
}
