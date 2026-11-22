import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAttendanceSettings, getOnSite, getRollCall, getRollCalls } from "@/lib/api";
import { OnSiteView } from "./on-site";

export const metadata: Metadata = { title: "On site" };

export default async function AttendancePage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [onSite, { rollCalls }, settings] = await Promise.all([
    getOnSite(slug),
    getRollCalls(slug),
    getAttendanceSettings(slug),
  ]);
  const open = rollCalls.find((r) => !r.endedAt);
  const current = open ? await getRollCall(slug, open.id) : null;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Attendance</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <OnSiteView
          slug={slug}
          onSite={onSite}
          rollCalls={rollCalls}
          current={current}
          timeZone={settings.timeZone}
        />
      </div>
    </>
  );
}
