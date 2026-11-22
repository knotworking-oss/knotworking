import { addWeeks, parsePeriod, weekStart } from "@knotworking/core";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getPlanFromDemand, getWorkspaceToday } from "@/lib/api";
import { PlanFromDemandGrid } from "./plan-grid";
import { PLAN_RANGES, type PlanRange } from "./ranges";

export const metadata: Metadata = { title: "Plan from demand" };

/**
 * Production → plan batches from demand: per product and ISO week, demand against what is
 * already planned, the gap and the whole batches that cover it. Computed on read; the person
 * edits counts and dates and creates the batches they select.
 */
export default async function PlanFromDemandPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; weeks?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const from = (search.from && parsePeriod(search.from)) || weekStart(await getWorkspaceToday(slug));
  const weeks: PlanRange = PLAN_RANGES.find((r) => String(r) === search.weeks) ?? 4;
  const plan = await getPlanFromDemand(slug, { from, to: addWeeks(from, weeks - 1) });

  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/production?week=${from}`}>Production</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Plan from demand</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        {/* Keyed by range so edits start afresh for other weeks. */}
        <PlanFromDemandGrid key={`${from}:${weeks}`} slug={slug} plan={plan} from={from} weeks={weeks} />
      </div>
    </>
  );
}
