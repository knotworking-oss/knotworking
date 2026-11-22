"use client";

import {
  sopReviewState,
  sopVersionStatusLabels,
  type SopReviewState,
  type SopVersionStatus,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { useWorkspaceToday } from "@/lib/workspace-time";

const versionClasses: Record<SopVersionStatus, string> = {
  approved: "bg-label-green-bg text-label-green",
  in_review: "bg-label-yellow-bg text-label-yellow",
  rejected: "bg-label-red-bg text-label-red",
  superseded: "bg-muted text-muted-foreground",
};

/** The state of one SOP version in document control. */
export function SopVersionStatusBadge({ status }: { status: SopVersionStatus }) {
  return (
    <Badge className={`border-transparent ${versionClasses[status]}`}>{sopVersionStatusLabels[status]}</Badge>
  );
}

/** A small marker on an SOP row: a draft in progress, or a version waiting for review. */
export function SopFlagBadge({ kind }: { kind: "draft" | "in_review" | "acknowledged" | "archived" }) {
  switch (kind) {
    case "draft":
      return (
        <Badge variant="outline" className="border-dashed text-muted-foreground">
          Draft in progress
        </Badge>
      );
    case "in_review":
      return <Badge className={`border-transparent ${versionClasses.in_review}`}>In review</Badge>;
    case "acknowledged":
      return <Badge className="border-transparent bg-label-green-bg text-label-green">Acknowledged</Badge>;
    case "archived":
      return <Badge variant="secondary">Archived</Badge>;
  }
}

const reviewClasses: Record<Exclude<SopReviewState, "ok">, { label: string; className: string }> = {
  overdue: { label: "Review overdue", className: "bg-label-red-bg text-label-red" },
  soon: { label: "Review due soon", className: "bg-label-orange-bg text-label-orange" },
};

/** Flags a review date that has passed or is close (today in the workspace's time zone); nothing when it is comfortably ahead. */
export function SopReviewBadge({ reviewDueOn }: { reviewDueOn: string | null | undefined }) {
  const state = sopReviewState(reviewDueOn, useWorkspaceToday());
  if (!state || state === "ok") return null;
  const { label, className } = reviewClasses[state];
  return <Badge className={`border-transparent ${className}`}>{label}</Badge>;
}
