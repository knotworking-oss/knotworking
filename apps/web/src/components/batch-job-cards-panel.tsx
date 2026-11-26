"use client";

import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Route } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { formatCost } from "@/components/costing-badges";
import { JobCardStatusBadge } from "@/components/job-card-status-badge";
import type { BatchJobCards } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

/**
 * A batch's operations (Routings, for people who can read it): its job cards in order with good,
 * scrap and time, or a button to make them from the bill's approved routing.
 */
export function BatchJobCardsPanel({
  slug,
  data,
  currency,
}: {
  slug: string;
  data: BatchJobCards;
  currency: string;
}) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const canMake =
    can("routings", "write") &&
    data.jobCards.length === 0 &&
    (data.batch.status === "planned" || data.batch.status === "in_progress");
  async function make() {
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].routings.batches[":batchId"]["job-cards"].$post({
          param: { slug, batchId: data.batch.id },
        }),
      );
      toast.success("Job cards made");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  if (!data.jobCards.length && !canMake) return null;
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pb-8">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Route className="size-4" /> Operations
            {data.routing && (
              <Link className="text-sm font-normal underline" href={`/${slug}/routings/${data.routing.id}`}>
                {data.routing.code}
              </Link>
            )}
          </CardTitle>
          {canMake && (
            <Button size="sm" disabled={pending || !data.routing} onClick={() => void make()}>
              Make job cards
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {data.jobCards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {data.routing
                ? "One job card per operation of the approved routing, with expected minutes for this batch."
                : "This batch's bill of materials has no routing yet."}
            </p>
          ) : (
            <>
              <ol className="divide-y rounded-lg border text-sm">
                {data.jobCards.map((card) => (
                  <li key={card.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <Link className="font-medium underline" href={`/${slug}/routings/job-cards/${card.id}`}>
                      {card.position}. {card.name}
                    </Link>
                    <span className="text-muted-foreground tabular-nums">
                      {card.workCentre?.code} · {card.good.display} good / {card.scrap.display} scrap ·{" "}
                      {card.actualMinutes} of {card.expected.totalMinutes} min
                    </span>
                    <JobCardStatusBadge status={card.status} />
                  </li>
                ))}
              </ol>
              <p className="text-sm text-muted-foreground">
                {data.summary.completed} of {data.summary.cards} operations complete · work-centre cost{" "}
                {formatCost(data.summary.actualCost, currency)} (expected {formatCost(data.summary.expectedCost, currency)})
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
