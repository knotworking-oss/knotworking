"use client";

import { classifyExpiry, expiryTypeLabels, type ExpiryType } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { useWorkspaceToday } from "@/lib/workspace-time";

/**
 * A lot's expiry date with its type, highlighted when it has passed (red) or is within a week
 * (amber). Measured against today in the workspace's time zone; `today` is for previews.
 */
export function ExpiryBadge({
  expiresOn,
  expiryType,
  today,
  empty = "No expiry",
}: {
  expiresOn: string | null;
  expiryType: ExpiryType | null;
  today?: string;
  empty?: string;
}) {
  const workspaceToday = useWorkspaceToday();
  if (!expiresOn) return <span className="text-muted-foreground">{empty}</span>;
  const state = classifyExpiry(expiresOn, today ?? workspaceToday);
  const label = `${expiryType ? `${expiryTypeLabels[expiryType]} ` : ""}${expiresOn}`;
  if (state === "ok") return <span className="tabular-nums">{label}</span>;
  return (
    <Badge
      className={`border-transparent tabular-nums ${
        state === "expired" ? "bg-label-red-bg text-label-red" : "bg-label-yellow-bg text-label-yellow"
      }`}
      title={state === "expired" ? "Expired" : "Expiring within 7 days"}
    >
      {state === "expired" ? "Expired · " : ""}
      {label}
    </Badge>
  );
}
