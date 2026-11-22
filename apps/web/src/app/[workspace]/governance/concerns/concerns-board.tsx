"use client";

import {
  formatUkDate,
  governanceConcernCategoryLabels,
  governanceConcernStatuses,
  governanceConcernStatusLabels,
  type GovernanceConcernStatus,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Lock } from "lucide-react";
import { useState } from "react";
import { GovernanceConcernBadge } from "@/components/governance-badges";
import type { GovernanceConcern } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { FormDialog, useSubmit } from "../governance-forms";
import { EnumSelect, GovernanceFrame } from "../governance-nav";

/** Management review → concerns (managers only): confidential reports and how they were handled. */
export function ConcernsBoard({ slug, concerns }: { slug: string; concerns: GovernanceConcern[] }) {
  const [handling, setHandling] = useState<GovernanceConcern | null>(null);
  return (
    <GovernanceFrame
      slug={slug}
      title="Confidential concerns"
      description="Reports any member raised about food safety, authenticity, legality or practices. Visible only to Governance managers; never synced, searched or sent to agents. Anonymous reports keep no record of who raised them."
    >
      {concerns.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No concerns have been raised.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {concerns.map((c) => (
            <Card key={c.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{c.reference}</span>
                  {governanceConcernCategoryLabels[c.category]}
                  <GovernanceConcernBadge status={c.status} />
                </CardTitle>
                <CardDescription className="flex items-center gap-1">
                  {c.anonymous && <Lock className="size-3" aria-hidden />}
                  Raised {formatUkDate(c.raisedOn)}{" "}
                  {c.anonymous ? "anonymously" : `by ${c.raisedByName ?? "a former member"}`}
                  {c.handledByName ? ` · handled by ${c.handledByName}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <p className="whitespace-pre-wrap">{c.description}</p>
                {c.investigation && (
                  <div>
                    <span className="font-medium">Investigation: </span>
                    {c.investigation}
                  </div>
                )}
                {c.outcome && (
                  <div>
                    <span className="font-medium">
                      Outcome{c.anonymous ? "" : " (the reporter sees this)"}:{" "}
                    </span>
                    {c.outcome}
                  </div>
                )}
                <div>
                  <Button size="sm" variant="outline" onClick={() => setHandling(c)}>
                    Handle
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {handling && <HandleDialog slug={slug} concern={handling} onClose={() => setHandling(null)} />}
    </GovernanceFrame>
  );
}

function HandleDialog({
  slug,
  concern,
  onClose,
}: {
  slug: string;
  concern: GovernanceConcern;
  onClose: () => void;
}) {
  const { pending, submit } = useSubmit(onClose);
  const [status, setStatus] = useState<GovernanceConcernStatus>(
    concern.status === "open" ? "investigating" : concern.status,
  );
  const [investigation, setInvestigation] = useState(concern.investigation ?? "");
  const [outcome, setOutcome] = useState(concern.outcome ?? "");
  return (
    <FormDialog
      title={`Handle ${concern.reference}`}
      submitLabel="Save"
      pending={pending}
      onClose={onClose}
      onSubmit={() =>
        void submit(
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].governance.concerns[":id"].$patch({
                param: { slug, id: concern.id },
                json: {
                  status,
                  investigation: investigation.trim() || null,
                  outcome: outcome.trim() || null,
                },
              }),
            ),
          "Concern updated",
        )
      }
    >
      <Field>
        <FieldLabel>Status</FieldLabel>
        <EnumSelect
          label="Status"
          value={status}
          onChange={setStatus}
          options={governanceConcernStatuses}
          labels={governanceConcernStatusLabels}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="con-investigation">Investigation (confidential)</FieldLabel>
        <Textarea
          id="con-investigation"
          maxLength={10_000}
          value={investigation}
          onChange={(e) => setInvestigation(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="con-outcome">Outcome</FieldLabel>
        <Textarea
          id="con-outcome"
          required={status === "closed"}
          maxLength={4000}
          placeholder={concern.anonymous ? "What was done" : "What the reporter is told"}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
