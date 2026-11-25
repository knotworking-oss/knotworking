import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import {
  canReadModule,
  requireModule,
  getChecklistChecks,
  getChecklistTemplates,
  getProductionBatches,
  getSiteAreas,
} from "@/lib/api";
import { ChecksBoard } from "@/components/checks-board";

export const metadata: Metadata = { title: "Pre-start and changeover checks" };

export default async function ChecksPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  await requireModule(slug, "checklists");
  const production = await canReadModule(slug, "production");
  const [{ templates }, { checks }, { areas }, { batches }] = await Promise.all([
    getChecklistTemplates(slug),
    getChecklistChecks(slug),
    getSiteAreas(slug),
    production ? getProductionBatches(slug, { status: "all" }) : { batches: [] },
  ]);
  return (
    <>
      <SiteHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <ChecksBoard
          slug={slug}
          templates={templates}
          checks={checks}
          areas={areas}
          withProduction={production}
          batches={batches.slice(0, 100).map((b) => ({ id: b.id, label: b.batchCode }))}
        />
      </div>
    </>
  );
}
