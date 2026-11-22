import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getProductionDayPlan, getProductionLines, getWorkspaceToday } from "@/lib/api";
import { DayPlanView } from "./day-plan";

export const metadata: Metadata = { title: "Day plan" };

const isDate = (v?: string) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? "");

export default async function DayPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ line?: string; date?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const [today, { lines }] = await Promise.all([getWorkspaceToday(slug), getProductionLines(slug)]);
  const date = isDate(search.date) ? search.date! : today;
  const line = lines.find((l) => l.id === search.line) ?? lines.find((l) => l.active) ?? lines[0];
  const plan = line ? await getProductionDayPlan(slug, line.id, date) : null;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Day plan</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <DayPlanView
          slug={slug}
          date={date}
          lines={lines.map((l) => ({ id: l.id, name: l.name, active: l.active }))}
          plan={plan}
        />
      </div>
    </>
  );
}
