"use client";

import { Button } from "@knotworking/ui/components/button";
import { Printer } from "lucide-react";
import Link from "next/link";
import { SnapshotBody, type FrozenSnapshot } from "@/components/snapshot-view";
import type { SnapshotDetail } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceCurrency } from "@/lib/workspace-time";

export function SnapshotPage({ slug, snapshot }: { slug: string; snapshot: SnapshotDetail }) {
  const currency = useWorkspaceCurrency();
  const { idx } = useWorkspace();
  const taker = snapshot.takenBy ? (idx.users.get(snapshot.takenBy)?.name ?? "Someone") : "Someone";
  return (
    <div className="workspace-content flex flex-col gap-6 py-6 print:p-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-muted-foreground">
          {snapshot.kind === "analysis" ? "Made" : "Taken"} by {taker} on{" "}
          {new Date(snapshot.takenAt).toLocaleString("en-GB")}.
          {snapshot.dashboardId && (
            <>
              {" "}
              <Link
                href={`/${slug}/dashboards/${snapshot.dashboardId}`}
                className="underline-offset-4 hover:underline"
              >
                Open the live dashboard
              </Link>
            </>
          )}
        </p>
        <Button size="sm" variant="outline" className="print:hidden" onClick={() => window.print()}>
          <Printer /> Print
        </Button>
      </div>
      <SnapshotBody
        snapshot={snapshot as unknown as FrozenSnapshot}
        previous={snapshot.previous as unknown as FrozenSnapshot | null}
        base={`/${slug}`}
        workspaceCurrency={currency}
      />
    </div>
  );
}
