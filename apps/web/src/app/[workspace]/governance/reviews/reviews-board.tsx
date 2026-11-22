"use client";

import { addDays, formatUkDate } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import type { ManagementReviewRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { FormDialog } from "../governance-forms";
import { GovernanceFrame } from "../governance-nav";

/** Management review → reviews: each review, its period and whether it is signed. */
export function ReviewsBoard({ slug, reviews }: { slug: string; reviews: ManagementReviewRow[] }) {
  const canWrite = useWorkspace().can("governance", "write");
  const [creating, setCreating] = useState(false);
  return (
    <GovernanceFrame
      slug={slug}
      title="Management reviews"
      actions={
        canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> New review
          </Button>
        )
      }
    >
      {reviews.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No management reviews yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Review</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Held</TableHead>
                <TableHead>Decisions</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reviews.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="pl-4">
                    <Link
                      href={`/${slug}/governance/reviews/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {formatUkDate(r.periodFrom)} – {formatUkDate(r.periodTo)}
                  </TableCell>
                  <TableCell>{r.heldOn ? formatUkDate(r.heldOn) : "—"}</TableCell>
                  <TableCell>{r.decisions}</TableCell>
                  <TableCell className="pr-4">
                    {r.status === "signed" ? (
                      <Badge
                        variant="outline"
                        className="border-transparent bg-label-green-bg text-label-green"
                      >
                        Signed
                      </Badge>
                    ) : (
                      <Badge variant="outline">Draft</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {creating && <NewReviewDialog slug={slug} onClose={() => setCreating(false)} />}
    </GovernanceFrame>
  );
}

function NewReviewDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const router = useRouter();
  const today = useWorkspaceToday();
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState("");
  const [periodFrom, setPeriodFrom] = useState(addDays(today, -365));
  const [periodTo, setPeriodTo] = useState(today);
  return (
    <FormDialog
      title="New management review"
      description="The period it looks back over; the evidence is gathered for these dates."
      submitLabel="Start review"
      pending={pending}
      onClose={onClose}
      onSubmit={() => {
        setPending(true);
        void unwrap(
          browserApi().v1.workspaces[":slug"].governance.reviews.$post({
            param: { slug },
            json: { title: title.trim(), periodFrom, periodTo },
          }),
        )
          .then((r) => router.push(`/${slug}/governance/reviews/${r.id}`))
          .catch((err) => {
            toast.error(errorMessage(err));
            setPending(false);
          });
      }}
    >
      <Field>
        <FieldLabel htmlFor="rev-title">Title</FieldLabel>
        <Input
          id="rev-title"
          required
          maxLength={200}
          placeholder="e.g. Annual management review 2026"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="rev-from">From</FieldLabel>
          <Input
            id="rev-from"
            type="date"
            required
            value={periodFrom}
            onChange={(e) => setPeriodFrom(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="rev-to">To</FieldLabel>
          <Input
            id="rev-to"
            type="date"
            required
            value={periodTo}
            onChange={(e) => setPeriodTo(e.target.value)}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
