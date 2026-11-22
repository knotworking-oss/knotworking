import type { Metadata } from "next";
import { todayInZone } from "@knotworking/core";
import { PageHeader } from "@/components/page-header";
import { getBootstrap, getMyAbsences } from "@/lib/api";
import { LeaveAndAvailability } from "./view";
export const metadata: Metadata = { title: "Leave and availability" };
export default async function Page({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [boot, mine] = await Promise.all([getBootstrap(slug), getMyAbsences(slug)]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Leave and availability</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <LeaveAndAvailability slug={slug} initial={mine} today={todayInZone(boot.workspace.timeZone)} />
      </div>
    </>
  );
}
