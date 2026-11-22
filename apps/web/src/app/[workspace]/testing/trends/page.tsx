import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getSamplingPoints, getTestAnalytes, getTestTrend } from "@/lib/api";
import { TestingNav } from "../testing-nav";
import { TrendView } from "./trend-view";

export const metadata: Metadata = { title: "Testing trends" };

export default async function TestingTrendsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ analyte?: string; zone?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const [{ analytes }, { points }] = await Promise.all([
    getTestAnalytes(slug),
    getSamplingPoints(slug, "all"),
  ]);
  const analyte = search.analyte && analytes.includes(search.analyte) ? search.analyte : analytes[0];
  const zones = [...new Set(points.map((p) => p.zone).filter((z): z is string => !!z))].sort();
  const zone = search.zone && zones.includes(search.zone) ? search.zone : undefined;
  const trend = analyte ? await getTestTrend(slug, { analyte, ...(zone ? { zone } : {}) }) : null;
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Testing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
          <TestingNav slug={slug} />
          <TrendView
            slug={slug}
            analytes={analytes}
            zones={zones}
            analyte={analyte}
            zone={zone}
            trend={trend}
          />
        </div>
      </div>
    </>
  );
}
