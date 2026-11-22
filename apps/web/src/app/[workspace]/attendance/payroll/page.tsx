import { lastFinishedPayPeriod, payrollFormatIds, todayInZone } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAttendanceSettings, getPayrollPreview } from "@/lib/api";
import { PayrollView } from "./payroll-view";

export const metadata: Metadata = { title: "Payroll export" };

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export default async function PayrollPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string; format?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const settings = await getAttendanceSettings(slug);
  // The last finished pay period (the setting), on the workspace's calendar.
  const period = lastFinishedPayPeriod(todayInZone(settings.timeZone), {
    kind: settings.payPeriodKind,
    anchor: settings.payPeriodAnchor,
  });
  const from = search.from && isoDate.test(search.from) ? search.from : period.from;
  const to = search.to && isoDate.test(search.to) && search.to >= from ? search.to : period.to;
  const format = payrollFormatIds.find((f) => f === search.format) ?? settings.payrollFormat;
  const preview = await getPayrollPreview(slug, { from, to, format });
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Attendance</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PayrollView slug={slug} preview={preview} payPeriod={settings} />
      </div>
    </>
  );
}
