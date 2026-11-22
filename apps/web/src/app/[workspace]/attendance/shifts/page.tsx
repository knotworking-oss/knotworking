import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getShifts, getStaffList, getVisits, getWorkspaceTimeZone } from "@/lib/api";
import { weekRange } from "@/lib/attendance-format";
import { ShiftsView } from "./shifts-view";

export const metadata: Metadata = { title: "Shifts" };

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export default async function ShiftsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string; issues?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const week = weekRange(await getWorkspaceTimeZone(slug));
  const from = search.from && isoDate.test(search.from) ? search.from : week.from;
  const to = search.to && isoDate.test(search.to) && search.to >= from ? search.to : week.to;
  const issues = search.issues === "1";
  const [report, { staff }, { visits }] = await Promise.all([
    getShifts(slug, { from, to, ...(issues ? { issues: "true" as const } : {}) }),
    getStaffList(slug),
    getVisits(slug, { from, to }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Attendance</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <ShiftsView slug={slug} report={report} staff={staff} visits={visits} issuesOnly={issues} />
      </div>
    </>
  );
}
