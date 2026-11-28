"use client";

import { DEFAULT_HACCP_REVIEW_INTERVAL_MONTHS } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Label } from "@knotworking/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { BadgeCheck, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { DueStateBadge } from "@/components/haccp-badges";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import type { HaccpPlanRow } from "@/lib/api";
import { browserApi, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";

/** HACCP plans: each a controlled document with one current approved version. */
export function PlansManager({
  slug,
  plans,
  templates,
  showArchived,
}: {
  slug: string;
  plans: HaccpPlanRow[];
  templates: { id: string; name: string }[];
  showArchived: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("haccp", "write");
  const canManage = can("haccp", "manage");
  const [creating, setCreating] = useState(false);
  const [signing, setSigning] = useState(false);

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">HACCP plans</h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="plans-archived"
              checked={showArchived}
              onCheckedChange={(on) => router.replace(on === true ? `${pathname}?status=all` : pathname)}
            />
            <Label htmlFor="plans-archived">Show archived</Label>
          </div>
          {canManage && plans.length > 0 && (
            <Button variant="outline" onClick={() => setSigning(true)}>
              <BadgeCheck data-icon="inline-start" /> Sign off a day
            </Button>
          )}
          {canWrite && (
            <Button onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" /> New plan
            </Button>
          )}
        </div>
      </div>

      {plans.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No HACCP plans yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>CCPs</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Review due</TableHead>
                <TableHead className="pr-4">Hazard review due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow key={plan.id}>
                  <TableCell className="pl-4 font-mono text-xs">{plan.code}</TableCell>
                  <TableCell>
                    <Link href={`/${slug}/haccp/plans/${plan.id}`} className="font-medium hover:underline">
                      {plan.name}
                    </Link>
                    <span className="ml-2 inline-flex gap-1">
                      {plan.status === "archived" && <Badge variant="secondary">Archived</Badge>}
                      {plan.hasDraft && (
                        <Badge variant="outline" className="border-dashed text-muted-foreground">
                          Draft v{plan.draftVersionNumber}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    {plan.currentVersion ? `v${plan.currentVersion.versionNumber}` : "—"}
                    {plan.upcomingVersion && (
                      <div className="text-xs text-muted-foreground">
                        v{plan.upcomingVersion.versionNumber} effective from{" "}
                        {formatLongDate(plan.upcomingVersion.effectiveOn)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{plan.currentVersion?.ccpCount ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {plan.currentVersion
                      ? plan.currentVersion.wholeSite
                        ? "Whole site"
                        : "Selected products"
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {plan.currentVersion?.effectiveOn ? formatLongDate(plan.currentVersion.effectiveOn) : "—"}
                    {plan.currentVersion?.inForceUntil && (
                      <div className="text-xs text-muted-foreground">
                        In force until {formatLongDate(plan.currentVersion.inForceUntil)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {plan.currentVersion?.reviewDueOn
                        ? formatLongDate(plan.currentVersion.reviewDueOn)
                        : "—"}
                      {(plan.reviewState === "overdue" || plan.reviewState === "due") && (
                        <DueStateBadge state={plan.reviewState} />
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="pr-4">
                    <span className="flex items-center gap-2">
                      {plan.hazardReviewDueOn ? formatLongDate(plan.hazardReviewDueOn) : "—"}
                      {(plan.hazardReviewState === "overdue" || plan.hazardReviewState === "due") && (
                        <DueStateBadge state={plan.hazardReviewState} />
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {creating && <NewPlanDialog slug={slug} templates={templates} onClose={() => setCreating(false)} />}
      {signing && <BulkSignoffDialog slug={slug} plans={plans} onClose={() => setSigning(false)} />}
    </div>
  );
}

const NO_TEMPLATE = "none";

function NewPlanDialog({
  slug,
  templates,
  onClose,
}: {
  slug: string;
  templates: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(NO_TEMPLATE);
  const [months, setMonths] = useState(String(DEFAULT_HACCP_REVIEW_INTERVAL_MONTHS));
  return (
    <HaccpDialog
      title="New HACCP plan"
      description="Start with the header; add the scope and critical control points in the draft."
      submitLabel="Create plan"
      onClose={onClose}
      onSubmit={async () => {
        const created = await unwrap(
          browserApi().v1.workspaces[":slug"].haccp.plans.$post({
            param: { slug },
            json: {
              code: code.trim(),
              name: name.trim(),
              reviewIntervalMonths: Number(months),
              ...(template === NO_TEMPLATE
                ? { draft: { scope: { itemIds: [], recipeIds: [] }, ccps: [] } }
                : { templateId: template }),
            },
          }),
        );
        router.push(`/${slug}/haccp/plans/${created.id}`);
        return `${created.code} created`;
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <Field>
          <FieldLabel htmlFor="plan-code">Code</FieldLabel>
          <Input
            id="plan-code"
            required
            maxLength={40}
            placeholder="HACCP-01"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="plan-name">Name</FieldLabel>
          <Input
            id="plan-name"
            required
            maxLength={200}
            placeholder="Cooked soups"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
      {templates.length > 0 && (
        <SelectField
          id="plan-template"
          label="Start from"
          value={template}
          onChange={setTemplate}
          options={[[NO_TEMPLATE, "A blank plan"], ...templates.map((t) => [t.id, t.name] as const)]}
          description="A template's hazard analysis and CCPs are copied into the first draft; the plan keeps its own copy."
        />
      )}
      <Field>
        <FieldLabel htmlFor="plan-review">Review every (months)</FieldLabel>
        <Input
          id="plan-review"
          className="w-32"
          type="number"
          min={1}
          max={60}
          required
          value={months}
          onChange={(e) => setMonths(e.target.value)}
        />
      </Field>
    </HaccpDialog>
  );
}

/**
 * One sign-off of a day for several plans or the whole site, all or nothing: if a plan still has
 * readings awaiting review, or is already signed off, none is signed and the server says which.
 */
function BulkSignoffDialog({
  slug,
  plans,
  onClose,
}: {
  slug: string;
  plans: HaccpPlanRow[];
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const [day, setDay] = useState(today);
  const [note, setNote] = useState("");
  const [wholeSite, setWholeSite] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const signable = plans.filter((p) => p.status === "active");
  return (
    <HaccpDialog
      title="Sign off a day"
      description="Sign off the day's monitoring records for several plans, or the whole site, in one step. Either every plan is signed off or none is."
      submitLabel="Sign off"
      disabled={!day || (!wholeSite && chosen.length === 0)}
      onClose={onClose}
      onSubmit={async () => {
        const done = await unwrap(
          browserApi().v1.workspaces[":slug"].haccp.signoffs.bulk.$post({
            param: { slug },
            json: {
              day,
              ...(wholeSite ? { wholeSite: true } : { planIds: chosen }),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          }),
        );
        return `${done.signedOff} plan${done.signedOff === 1 ? "" : "s"} signed off for ${day}`;
      }}
    >
      <Field>
        <FieldLabel htmlFor="bulk-day">Day</FieldLabel>
        <Input
          id="bulk-day"
          className="w-44"
          type="date"
          max={today}
          required
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox id="bulk-site" checked={wholeSite} onCheckedChange={(on) => setWholeSite(on === true)} />
        <Label htmlFor="bulk-site">
          The whole site: every active plan in force that day (plans already signed off stay as they are)
        </Label>
      </div>
      {!wholeSite && (
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border p-3">
          {signable.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <Checkbox
                id={`bulk-${p.id}`}
                checked={chosen.includes(p.id)}
                onCheckedChange={(on) =>
                  setChosen((list) => (on === true ? [...list, p.id] : list.filter((id) => id !== p.id)))
                }
              />
              <Label htmlFor={`bulk-${p.id}`}>
                <span className="font-mono text-xs">{p.code}</span> {p.name}
              </Label>
            </div>
          ))}
        </div>
      )}
      <Field>
        <FieldLabel htmlFor="bulk-note">Note (optional)</FieldLabel>
        <Input id="bulk-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </HaccpDialog>
  );
}
