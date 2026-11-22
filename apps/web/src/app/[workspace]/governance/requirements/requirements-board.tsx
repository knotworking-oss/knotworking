"use client";

import {
  addDays,
  formatUkDate,
  governanceComplianceStatusLabels,
  governanceRequirementSourceLabels,
  governanceRequirementSources,
  type GovernanceRequirementSource,
} from "@knotworking/core";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { Plus } from "lucide-react";
import { useState } from "react";
import { GovernanceComplianceBadge, GovernanceDueBadge } from "@/components/governance-badges";
import type { GovernanceRequirement } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { FormDialog, useSubmit } from "../governance-forms";
import { EnumSelect, GovernanceFrame, MemberSelect } from "../governance-nav";

const gov = () => browserApi().v1.workspaces[":slug"].governance;
const assessed = ["compliant", "partial", "non_compliant"] as const;
type Assessed = (typeof assessed)[number];

/** Management review → requirements: the legal, customer and standard requirements the site meets. */
export function RequirementsBoard({
  slug,
  requirements,
}: {
  slug: string;
  requirements: GovernanceRequirement[];
}) {
  const canWrite = useWorkspace().can("governance", "write");
  const [dialog, setDialog] = useState<
    | { kind: "edit"; requirement: GovernanceRequirement | null }
    | { kind: "review"; requirement: GovernanceRequirement }
    | null
  >(null);
  return (
    <GovernanceFrame
      slug={slug}
      title="Requirements register"
      actions={
        canWrite && (
          <Button onClick={() => setDialog({ kind: "edit", requirement: null })}>
            <Plus data-icon="inline-start" /> Add requirement
          </Button>
        )
      }
    >
      {requirements.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No requirements yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Requirement</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Compliance</TableHead>
                <TableHead>Next review</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {requirements.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-md pl-4 whitespace-normal">
                    <div className="font-medium">
                      {r.title}
                      {r.status === "archived" && (
                        <Badge variant="secondary" className="ml-2">
                          Archived
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[r.reference, r.customerName, r.ownerName].filter(Boolean).join(" · ")}
                    </div>
                    {r.reviewNotes && <div className="text-xs text-muted-foreground">{r.reviewNotes}</div>}
                  </TableCell>
                  <TableCell>{governanceRequirementSourceLabels[r.source]}</TableCell>
                  <TableCell>
                    <GovernanceComplianceBadge status={r.compliance} />
                    {r.lastReviewedOn && (
                      <div className="text-xs text-muted-foreground">
                        {formatUkDate(r.lastReviewedOn)}
                        {r.lastReviewedByName ? ` · ${r.lastReviewedByName}` : ""}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      {r.reviewDueOn ? formatUkDate(r.reviewDueOn) : "—"}
                      <GovernanceDueBadge status={r.reviewStatus} />
                    </div>
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {canWrite && (
                      <div className="flex justify-end gap-2">
                        {r.status === "active" && (
                          <Button size="sm" onClick={() => setDialog({ kind: "review", requirement: r })}>
                            Review compliance
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "edit", requirement: r })}
                        >
                          Edit
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {dialog?.kind === "edit" && (
        <RequirementDialog slug={slug} requirement={dialog.requirement} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "review" && (
        <ReviewDialog slug={slug} requirement={dialog.requirement} onClose={() => setDialog(null)} />
      )}
    </GovernanceFrame>
  );
}

function RequirementDialog({
  slug,
  requirement,
  onClose,
}: {
  slug: string;
  requirement: GovernanceRequirement | null;
  onClose: () => void;
}) {
  const { pending, submit } = useSubmit(onClose);
  const [source, setSource] = useState<GovernanceRequirementSource>(requirement?.source ?? "legal");
  const [title, setTitle] = useState(requirement?.title ?? "");
  const [reference, setReference] = useState(requirement?.reference ?? "");
  const [customer, setCustomer] = useState(requirement?.customerName ?? "");
  const [description, setDescription] = useState(requirement?.description ?? "");
  const [owner, setOwner] = useState<string | null>(requirement?.ownerUserId ?? null);
  const [reviewDueOn, setReviewDueOn] = useState(requirement?.reviewDueOn ?? "");
  return (
    <FormDialog
      title={requirement ? "Edit requirement" : "Add requirement"}
      submitLabel="Save"
      pending={pending}
      onClose={onClose}
      onSubmit={() => {
        const json = {
          source,
          title: title.trim(),
          reference: reference.trim() || null,
          customerName: customer.trim() || null,
          description: description.trim() || null,
          ownerUserId: owner,
          reviewDueOn: reviewDueOn || null,
        };
        void submit(
          () =>
            unwrap(
              requirement
                ? gov().requirements[":id"].$patch({ param: { slug, id: requirement.id }, json })
                : gov().requirements.$post({ param: { slug }, json }),
            ),
          "Requirement saved",
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Source</FieldLabel>
          <EnumSelect
            label="Source"
            value={source}
            onChange={setSource}
            options={governanceRequirementSources}
            labels={governanceRequirementSourceLabels}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="req-ref">Reference</FieldLabel>
          <Input
            id="req-ref"
            maxLength={200}
            placeholder="e.g. BRCGS 1.1.2"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="req-title">Requirement</FieldLabel>
        <Input
          id="req-title"
          required
          maxLength={300}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      {source === "customer" && (
        <Field>
          <FieldLabel htmlFor="req-customer">Customer</FieldLabel>
          <Input
            id="req-customer"
            maxLength={200}
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="req-desc">What it requires</FieldLabel>
        <Textarea
          id="req-desc"
          maxLength={4000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>Owner</FieldLabel>
          <MemberSelect label="Owner" value={owner} onChange={setOwner} />
        </Field>
        <Field>
          <FieldLabel htmlFor="req-due">Review by</FieldLabel>
          <Input
            id="req-due"
            type="date"
            value={reviewDueOn}
            onChange={(e) => setReviewDueOn(e.target.value)}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function ReviewDialog({
  slug,
  requirement,
  onClose,
}: {
  slug: string;
  requirement: GovernanceRequirement;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const { pending, submit } = useSubmit(onClose);
  const [reviewedOn, setReviewedOn] = useState(today);
  const [compliance, setCompliance] = useState<Assessed>("compliant");
  const [notes, setNotes] = useState("");
  const [nextReviewOn, setNextReviewOn] = useState(addDays(today, 365));
  return (
    <FormDialog
      title="Review compliance"
      description={`${requirement.title}. Recorded in your name.`}
      submitLabel="Record review"
      pending={pending}
      onClose={onClose}
      onSubmit={() =>
        void submit(
          () =>
            unwrap(
              gov().requirements[":id"].review.$post({
                param: { slug, id: requirement.id },
                json: { reviewedOn, compliance, notes: notes.trim() || null, nextReviewOn },
              }),
            ),
          "Compliance review recorded",
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="rev-on">Reviewed on</FieldLabel>
          <Input
            id="rev-on"
            type="date"
            required
            max={today}
            value={reviewedOn}
            onChange={(e) => setReviewedOn(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>Finding</FieldLabel>
          <EnumSelect
            label="Finding"
            value={compliance}
            onChange={setCompliance}
            options={assessed}
            labels={governanceComplianceStatusLabels}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="rev-notes">Notes</FieldLabel>
        <Textarea id="rev-notes" maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="rev-next">Next review</FieldLabel>
        <Input
          id="rev-next"
          type="date"
          required
          value={nextReviewOn}
          onChange={(e) => setNextReviewOn(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
