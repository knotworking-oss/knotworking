import type { Metadata } from "next";
import Link from "next/link";
import { hasModuleLevel, todayInZone } from "@knotworking/core";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getHrAbsences } from "@/lib/api";
import { HrAbsences } from "./view";
export const metadata: Metadata = { title: "Private HR absence records" };
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [boot, records] = await Promise.all([getBootstrap(slug), getHrAbsences(slug)]);
  const canManage = hasModuleLevel(boot.modules.find((m) => m.id === "workforce_hr")?.access, "manage");
  const canRunPayroll =
    canManage && hasModuleLevel(boot.modules.find((m) => m.id === "attendance")?.access, "manage");
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Private HR absence records</h1>
        {canRunPayroll && (
          <Link
            href={`/${slug}/workforce/hr/payroll`}
            className="ml-auto text-sm text-primary hover:underline"
          >
            Payroll runs
          </Link>
        )}
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <HrAbsences
          slug={slug}
          initial={records}
          canManage={canManage}
          today={todayInZone(boot.workspace.timeZone)}
        />
      </div>
    </>
  );
}
