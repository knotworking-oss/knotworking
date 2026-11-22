"use client";

import type { CostingPeriod } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatDateTime } from "@/lib/format";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

/**
 * A period's status in the costing report: open (a person with manage can close it once it has
 * ended), or closed with its figures frozen (and, for a manager, a way to reopen it with a reason).
 */
export function PeriodCloseControls({
  slug,
  period,
  periodStart,
  label,
  ended,
  canManage,
  frozen,
}: {
  slug: string;
  period: CostingPeriod;
  periodStart: string;
  label: string;
  ended: boolean;
  canManage: boolean;
  frozen: {
    closeId: string;
    closedAt: string;
    closedBy: { name: string } | null;
    changedSince: boolean;
  } | null;
}) {
  const router = useRouter();
  const timeZone = useWorkspaceTimeZone();
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const api = () => browserApi().v1.workspaces[":slug"].costing.closes;

  async function close(acknowledgeGaps = false) {
    setPending(true);
    try {
      await unwrap(api().$post({ param: { slug }, json: { period, of: periodStart, acknowledgeGaps } }));
      toast.success(`${label} closed`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "period_has_gaps") {
        if (window.confirm(`${err.message}`)) return void close(true);
      } else toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function reopen() {
    if (!frozen || !reason?.trim()) return;
    setPending(true);
    try {
      await unwrap(
        api()[":id"].reopen.$post({
          param: { slug, id: frozen.closeId },
          json: { reason: reason.trim() },
        }),
      );
      toast.success(`${label} reopened`);
      setReason(null);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (frozen) {
    return (
      <div className="flex flex-col items-end gap-1 text-xs">
        <Badge variant="secondary" className="gap-1">
          <Lock className="size-3" /> Closed
        </Badge>
        <span className="text-muted-foreground">
          {frozen.closedBy?.name ?? "Someone"}, {formatDateTime(frozen.closedAt, timeZone)}
        </span>
        {frozen.changedSince && (
          <span className="text-label-orange" title="Today's figures differ from the frozen ones">
            Figures have moved since
          </span>
        )}
        {canManage &&
          (reason === null ? (
            <Button size="xs" variant="ghost" onClick={() => setReason("")}>
              Reopen
            </Button>
          ) : (
            <span className="flex items-center gap-1">
              <Input
                aria-label="Why reopen"
                placeholder="Why?"
                className="h-7 w-40"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button size="xs" disabled={pending || reason.trim().length < 3} onClick={() => void reopen()}>
                {pending && <Spinner />} Reopen
              </Button>
            </span>
          ))}
      </div>
    );
  }
  if (!canManage || !ended) {
    return <span className="text-xs text-muted-foreground">{ended ? "Open" : "In progress"}</span>;
  }
  return (
    <Button size="xs" variant="outline" disabled={pending} onClick={() => void close()}>
      {pending && <Spinner />} Close period
    </Button>
  );
}
