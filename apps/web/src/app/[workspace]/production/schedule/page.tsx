import { addDays } from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getProductionSchedule, getWorkspaceToday } from "@/lib/api";
import { LineSchedule } from "./line-schedule";

export const metadata: Metadata = { title: "Line schedule" };

/** Monday of the week that holds `iso`. */
function weekStart(iso: string) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const today = await getWorkspaceToday(slug);
  const from = weekStart(/^\d{4}-\d{2}-\d{2}$/.test(search.from ?? "") ? search.from! : today);
  const schedule = await getProductionSchedule(slug, from, addDays(from, 6));
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Line schedule</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <LineSchedule slug={slug} today={today} from={from} schedule={schedule} />
      </div>
    </>
  );
}
