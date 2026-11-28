import {
  testInvestigationStatuses,
  testOutcomes,
  type TestInvestigationStatus,
  type TestOutcome,
} from "@knotworking/core";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import {
  getSamplingPoints,
  getStockLots,
  getTestLaboratories,
  getTestPlans,
  getTestSamples,
} from "@/lib/api";
import { SamplesBoard } from "./samples-board";
import { TestingNav } from "./testing-nav";

export const metadata: Metadata = { title: "Testing" };

export default async function TestingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; outcome?: string; investigation?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const filters = {
    q: search.q?.trim() || undefined,
    outcome: (testOutcomes as readonly string[]).includes(search.outcome ?? "")
      ? (search.outcome as TestOutcome)
      : undefined,
    investigation: (testInvestigationStatuses as readonly string[]).includes(search.investigation ?? "")
      ? (search.investigation as TestInvestigationStatus)
      : undefined,
  };
  const [page, plans, labs, points, lots] = await Promise.all([
    getTestSamples(slug, {
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      ...(filters.investigation ? { investigation: filters.investigation } : {}),
    }),
    getTestPlans(slug),
    getTestLaboratories(slug),
    getSamplingPoints(slug),
    getStockLots(slug, {}),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Testing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-4 py-8">
          <TestingNav slug={slug} />
          <SamplesBoard
            slug={slug}
            samples={page.samples}
            total={page.total}
            plans={plans.plans}
            laboratories={labs.laboratories}
            points={points.points}
            lots={lots.lots}
            filters={filters}
          />
        </div>
      </div>
    </>
  );
}
