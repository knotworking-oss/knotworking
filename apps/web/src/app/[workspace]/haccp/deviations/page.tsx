import type { Metadata } from "next";
import { HaccpHeader } from "@/components/haccp-header";
import { canReadModule, getCorrectiveActions, getProductionBatches } from "@/lib/api";
import { DeviationsBoard } from "./deviations-board";

export const metadata: Metadata = { title: "Deviations and corrective actions" };

const STATUSES = ["open", "closed", "all"] as const;

export default async function DeviationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = STATUSES.find((s) => s === search.status) ?? "open";
  // Production is a soft dependency of HACCP: batches to link only for its readers.
  const [page, batches] = await Promise.all([
    getCorrectiveActions(slug, status),
    canReadModule(slug, "production").then(async (can) =>
      can ? (await getProductionBatches(slug, { status: "all" })).batches : [],
    ),
  ]);
  return (
    <>
      <HaccpHeader slug={slug} />
      <div className="flex-1 overflow-y-auto">
        <DeviationsBoard
          slug={slug}
          status={status}
          actions={page.correctiveActions}
          total={page.total}
          batches={batches
            .filter((b) => b.status === "in_progress" || b.status === "completed")
            .map((b) => ({ id: b.id, batchCode: b.batchCode }))}
        />
      </div>
    </>
  );
}
