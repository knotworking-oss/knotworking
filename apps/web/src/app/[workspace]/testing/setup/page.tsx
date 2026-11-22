import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getAllItems, getSamplingPoints, getTestLaboratories, getTestPlans } from "@/lib/api";
import { TestingNav } from "../testing-nav";
import { TestingSetup } from "./testing-setup";

export const metadata: Metadata = { title: "Testing setup" };

export default async function TestingSetupPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const [labs, points, plans, items] = await Promise.all([
    getTestLaboratories(slug, "all"),
    getSamplingPoints(slug, "all"),
    getTestPlans(slug, "all"),
    getAllItems(slug, { status: "active" }),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Testing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
          <TestingNav slug={slug} />
          <TestingSetup
            slug={slug}
            laboratories={labs.laboratories}
            points={points.points}
            plans={plans.plans}
            items={items.items}
          />
        </div>
      </div>
    </>
  );
}
