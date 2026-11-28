import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getAttendanceSettings, getRollCall } from "@/lib/api";
import { siteDateTime } from "@/lib/attendance-format";
import { RollCallView } from "../../roll-call";

export const metadata: Metadata = { title: "Roll call" };

export default async function RollCallPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [call, settings] = await Promise.all([getRollCall(slug, id), getAttendanceSettings(slug)]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">
          <Link href={`/${slug}/attendance`} className="text-muted-foreground hover:text-foreground">
            Attendance
          </Link>{" "}
          / Roll call
        </h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <p className="text-sm text-muted-foreground">
            Started {siteDateTime(call.startedAt, settings.timeZone)}
            {call.endedAt && `, ended ${siteDateTime(call.endedAt, settings.timeZone)}`}
            {call.endedByName && ` by ${call.endedByName}`}.
          </p>
          <RollCallView key={call.id} slug={slug} call={call} />
        </div>
      </div>
    </>
  );
}
