"use client";

import type { CostingBatchListStatus } from "@knotworking/core";
import { ExportCsvButton } from "@/components/export-csv-button";
import { browserApi, unwrap } from "@/lib/auth-client";
import { batchCostsCsv, collectPages } from "@/lib/csv-export";

/** Every batch matching the list's filters (not just the page shown), as CSV. */
export function BatchCostsExport({
  slug,
  status,
  q,
  product,
}: {
  slug: string;
  status: CostingBatchListStatus;
  q: string | undefined;
  product: string | undefined;
}) {
  return (
    <ExportCsvButton
      name="Batch costs"
      rows={async () =>
        batchCostsCsv(
          await collectPages(async (offset) => {
            const r = await unwrap(
              browserApi().v1.workspaces[":slug"].costing.batches.$get({
                param: { slug },
                query: {
                  status,
                  ...(q ? { q } : {}),
                  ...(product ? { outputItemId: product } : {}),
                  limit: "100",
                  offset: String(offset),
                },
              }),
            );
            return { rows: r.batches, total: r.total };
          }),
        )
      }
    />
  );
}
