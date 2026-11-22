"use client";

import {
  formatParameterLimit,
  specificationKindLabels,
  specificationParameterCategoryLabels,
  storageLabels,
  type SpecificationDiff,
} from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { CheckCircle2, EyeOff, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AllergenBadges } from "@/components/item-badges";
import { RecordAttachments } from "@/components/record-attachments";
import {
  SpecificationBlockers,
  SpecificationChanges,
  SpecificationDiscrepancies,
  SpecificationReviewBadge,
  SpecificationVersionBadge,
} from "@/components/specification-badges";
import type { Specification, SpecificationImpact, SpecificationVersion } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";
import { SpecificationDraftEditor } from "./specification-draft-editor";

type ViewedVersion = SpecificationVersion & {
  changes: SpecificationDiff;
  previousVersionNumber: number | null;
};

/**
 * A specification: the approved version, any draft beside it with what it changes and what
 * blocks approval, where the item record disagrees, what a change could affect, the history and
 * the attached documents.
 */
export function SpecificationDetail({
  slug,
  specification: spec,
  impact,
}: {
  slug: string;
  specification: Specification;
  impact: SpecificationImpact;
}) {
  const timeZone = useWorkspaceTimeZone();
  const router = useRouter();
  const { can, viewer } = useWorkspace();
  const canWrite = can("specifications", "write");
  const canManage = can("specifications", "manage");
  const [editing, setEditing] = useState<{ start: SpecificationVersion | null } | null>(null);
  const [viewed, setViewed] = useState<ViewedVersion | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const api = () => browserApi().v1.workspaces[":slug"].specifications[":id"];
  const approved = spec.approvedVersion;
  const draft = spec.draftVersion;
  const archived = spec.status === "archived";
  const neverApproved = spec.versions.every((v) => v.status === "draft");
  const lastEditedByMe = draft?.lastEditedBy === viewer?.id;

  async function run(label: string, action: () => Promise<unknown>, done: string, after?: () => void) {
    setPending(label);
    try {
      await action();
      toast.success(done);
      if (after) after();
      else router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  async function viewVersion(versionId: string) {
    setPending(versionId);
    try {
      setViewed(
        (await unwrap(
          api().versions[":versionId"].$get({ param: { slug, id: spec.id, versionId } }),
        )) as unknown as ViewedVersion,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const party =
    spec.party === "supplier"
      ? `Supplier: ${spec.supplier?.name ?? "unknown"}`
      : spec.party === "customer"
        ? `Customer: ${spec.customerName}`
        : "Internal specification";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            <Link href={`/${slug}/specifications`} className="hover:underline">
              Specifications
            </Link>{" "}
            / <span className="font-mono text-xs">{spec.code}</span>
          </p>
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {spec.title}
            {archived && <Badge variant="secondary">Archived</Badge>}
            <SpecificationReviewBadge state={spec.reviewState} reviewDueOn={approved?.reviewDueOn} />
          </h2>
          <p className="text-sm text-muted-foreground">
            {specificationKindLabels[spec.kind]} · <span className="font-mono text-xs">{spec.item.code}</span>{" "}
            {spec.item.name} · {party}
          </p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {!draft && !archived && (
              <Button onClick={() => setEditing({ start: approved })}>
                <Plus data-icon="inline-start" /> {approved ? "Revise" : "Start draft"}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                void run(
                  "status",
                  () =>
                    unwrap(
                      api().$patch({
                        param: { slug, id: spec.id },
                        json: { status: archived ? "active" : "archived" },
                      }),
                    ),
                  archived ? "Specification restored" : "Specification archived",
                )
              }
            >
              {archived ? "Restore" : "Archive"}
            </Button>
            {neverApproved && (
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() =>
                  void run(
                    "delete",
                    () => unwrapEmpty(api().$delete({ param: { slug, id: spec.id } })),
                    "Specification deleted",
                    () => router.push(`/${slug}/specifications`),
                  )
                }
              >
                Delete
              </Button>
            )}
          </div>
        )}
      </div>

      <SpecificationDiscrepancies discrepancies={spec.discrepancies} />

      {draft && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <SpecificationVersionBadge status="draft" versionNumber={draft.versionNumber} /> Draft
            </CardTitle>
            <CardDescription>
              Last edited by {draft.lastEditedByName ?? "someone"}. Approving it{" "}
              {approved ? `supersedes v${approved.versionNumber}` : "makes it the first approved version"}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <SpecificationBlockers blockers={spec.draftBlockers} />
            <SpecificationDiscrepancies
              discrepancies={spec.draftDiscrepancies}
              title="Once approved, the item record would disagree with it"
            />
            {spec.draftChanges && (
              <div>
                <h3 className="mb-2 text-sm font-medium">
                  {approved ? `Changes from v${approved.versionNumber}` : "Content"}
                </h3>
                <SpecificationChanges diff={spec.draftChanges} />
              </div>
            )}
            {(canWrite || canManage) && !archived && (
              <div className="flex flex-wrap gap-2">
                {canWrite && (
                  <Button variant="outline" onClick={() => setEditing({ start: draft })}>
                    <Pencil data-icon="inline-start" /> Edit draft
                  </Button>
                )}
                {canManage && (
                  <Button
                    disabled={pending !== null || spec.draftBlockers.length > 0}
                    title={
                      lastEditedByMe
                        ? "You made the last edit: someone else with manage access approves it, unless nobody else can"
                        : undefined
                    }
                    onClick={() =>
                      void run(
                        "approve",
                        () => unwrap(api().draft.approve.$post({ param: { slug, id: spec.id } })),
                        `v${draft.versionNumber} approved`,
                      )
                    }
                  >
                    {pending === "approve" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <CheckCircle2 data-icon="inline-start" />
                    )}
                    Approve
                  </Button>
                )}
                {canWrite && (
                  <Button
                    variant="ghost"
                    disabled={pending !== null}
                    onClick={() =>
                      void run(
                        "discard",
                        () => unwrapEmpty(api().draft.$delete({ param: { slug, id: spec.id } })),
                        "Draft discarded",
                      )
                    }
                  >
                    Discard draft
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {approved ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <SpecificationVersionBadge status="approved" versionNumber={approved.versionNumber} /> Current
              specification
            </CardTitle>
            <CardDescription>
              Approved {approved.approvedAt ? formatLongDate(approved.approvedAt, timeZone) : ""} by{" "}
              {approved.approvedByName ?? "someone"} · review due{" "}
              {formatLongDate(approved.reviewDueOn, timeZone)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SpecificationContentView version={approved} kind={spec.kind} />
          </CardContent>
        </Card>
      ) : (
        !draft && (
          <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            No content yet. Start a draft to record the specification.
          </p>
        )
      )}

      <ImpactCard slug={slug} impact={impact} hasDraft={!!draft} />

      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Version</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Approved</TableHead>
                <TableHead className="pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {spec.versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="pl-6">
                    <SpecificationVersionBadge status={v.status} versionNumber={v.versionNumber} />
                  </TableCell>
                  <TableCell className="max-w-md whitespace-normal">{v.changeNote ?? "—"}</TableCell>
                  <TableCell>
                    {v.approvedAt
                      ? `${formatLongDate(v.approvedAt, timeZone)} · ${v.approvedByName ?? ""}`
                      : "—"}
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() => void viewVersion(v.id)}
                    >
                      {pending === v.id && <Spinner data-icon="inline-start" />} View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <RecordAttachments entityType="specification" entityId={spec.id} />
        </CardContent>
      </Card>

      {editing && (
        <SpecificationDraftEditor
          slug={slug}
          specificationId={spec.id}
          kind={spec.kind}
          party={spec.party}
          start={editing.start}
          onClose={() => setEditing(null)}
        />
      )}

      {viewed && (
        <Dialog open onOpenChange={(open) => !open && setViewed(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <SpecificationVersionBadge status={viewed.status} versionNumber={viewed.versionNumber} />{" "}
                {spec.code}
              </DialogTitle>
              <DialogDescription>{viewed.changeNote ?? "No change note."}</DialogDescription>
            </DialogHeader>
            <SpecificationContentView version={viewed} kind={spec.kind} />
            <div>
              <h3 className="mb-2 text-sm font-medium">
                {viewed.previousVersionNumber
                  ? `Changes from v${viewed.previousVersionNumber}`
                  : "First version"}
              </h3>
              <SpecificationChanges diff={viewed.changes} />
            </div>
            {canWrite && !draft && !archived && viewed.status !== "draft" && (
              <Button
                variant="outline"
                className="self-start"
                onClick={() => {
                  setEditing({ start: viewed });
                  setViewed(null);
                }}
              >
                Start a draft from v{viewed.versionNumber}
              </Button>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** A version's content: what was agreed, read-only. */
function SpecificationContentView({
  version: v,
  kind,
}: {
  version: SpecificationVersion;
  kind: Specification["kind"];
}) {
  const timeZone = useWorkspaceTimeZone();
  const row = (label: string, value: React.ReactNode) => (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words whitespace-pre-wrap">{value ?? "—"}</dd>
    </div>
  );
  return (
    <div className="flex flex-col gap-4 text-sm">
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
        {row("Description", v.description)}
        {kind === "packaging" && row("Packaging details", v.packagingDetails)}
        {row("Storage", v.storage ? storageLabels[v.storage] : null)}
        {v.storageInstructions && row("Storage instructions", v.storageInstructions)}
        {row("Shelf life", v.shelfLifeDays != null ? `${v.shelfLifeDays} days` : null)}
        {kind !== "product" &&
          row(
            "Minimum life on receipt",
            v.minimumLifeOnReceiptDays != null ? `${v.minimumLifeOnReceiptDays} days` : null,
          )}
        {kind !== "packaging" &&
          row("Allergens", <AllergenBadges contains={v.allergens} mayContain={v.mayContain} />)}
        {row("Country of origin", v.countryOfOrigin)}
        {v.provenance && row("Provenance", v.provenance)}
        {row("Claims", v.claims.length ? v.claims.join(", ") : null)}
        {row(
          "Agreement",
          v.agreedOn
            ? `${v.agreedBy} on ${formatLongDate(v.agreedOn, timeZone)}${v.agreementReference ? ` · ${v.agreementReference}` : ""}`
            : null,
        )}
        {row("Review due", v.reviewDueOn ? formatLongDate(v.reviewDueOn, timeZone) : null)}
      </dl>
      {v.parameters.length > 0 ? (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Category</TableHead>
                <TableHead>Parameter</TableHead>
                <TableHead>Limit</TableHead>
                <TableHead className="pr-4">Method</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {v.parameters.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-4 text-muted-foreground">
                    {specificationParameterCategoryLabels[p.category]}
                  </TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>{formatParameterLimit(p)}</TableCell>
                  <TableCell className="pr-4">{p.method ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-muted-foreground">No parameters or limits recorded.</p>
      )}
    </div>
  );
}

const relationLabels = {
  makes: "Makes the item",
  ingredient: "Uses it",
  indirect: "Uses it through",
} as const;
const hiddenLabels = { recipes: "recipes", labels: "labels", production: "production batches" } as const;

/** What a change to the specification could affect, as far as the viewer can see. */
function ImpactCard({
  slug,
  impact,
  hasDraft,
}: {
  slug: string;
  impact: SpecificationImpact;
  hasDraft: boolean;
}) {
  const { recipes, labels, batches } = impact;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where it is used</CardTitle>
        <CardDescription>
          {hasDraft && impact.changes?.impacting
            ? "The draft changes what these recipes, labels and batches rely on: check them before approving."
            : "Recipes, labels and open production that rely on this item. A change to the specification may need them reviewed."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {impact.hidden.length > 0 && (
          <Alert>
            <EyeOff />
            <AlertTitle>Not everything is shown</AlertTitle>
            <AlertDescription>
              You can&apos;t see{" "}
              {impact.hidden.map((h) => hiddenLabels[h as keyof typeof hiddenLabels]).join(", ")}, so some
              affected records may be missing. Ask someone with access to check.
            </AlertDescription>
          </Alert>
        )}
        {(impact.depthLimited || impact.truncated.length > 0) && (
          <Alert>
            <EyeOff />
            <AlertTitle>The list is incomplete</AlertTitle>
            <AlertDescription>
              {impact.depthLimited && `Recipes more than ${impact.maxDepth} levels away were not followed. `}
              {impact.truncated.length > 0 && `Long lists were cut short: ${impact.truncated.join(", ")}.`}
            </AlertDescription>
          </Alert>
        )}
        {recipes && (
          <section>
            <h3 className="mb-1 font-medium">Recipes ({recipes.length})</h3>
            {recipes.length === 0 ? (
              <p className="text-muted-foreground">No recipe uses or makes this item.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {recipes.map((r) => (
                  <li key={r.id}>
                    <Link href={`/${slug}/recipes/${r.id}`} className="font-mono text-xs hover:underline">
                      {r.code}
                    </Link>{" "}
                    {r.name}{" "}
                    <span className="text-muted-foreground">
                      · {relationLabels[r.relation]}
                      {r.relation === "indirect" ? ` ${r.depth - 1} step${r.depth > 2 ? "s" : ""}` : ""}
                      {r.status === "archived" ? " · archived" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {labels && (
          <section>
            <h3 className="mb-1 font-medium">Product labels ({labels.length})</h3>
            {labels.length === 0 ? (
              <p className="text-muted-foreground">No draft or approved label for these recipes.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {labels.map((l) => (
                  <li key={l.id}>
                    <Link href={`/${slug}/labels/${l.id}`} className="hover:underline">
                      {l.productName}
                    </Link>{" "}
                    <span className="text-muted-foreground">
                      · {l.recipeCode} {l.variant} v{l.versionNumber} · {l.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {batches && (
          <section>
            <h3 className="mb-1 font-medium">Open production batches ({batches.length})</h3>
            {batches.length === 0 ? (
              <p className="text-muted-foreground">No planned or in-progress batch of these recipes.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {batches.map((b) => (
                  <li key={b.id}>
                    <Link
                      href={`/${slug}/production/batches/${b.id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {b.batchCode}
                    </Link>{" "}
                    <span className="text-muted-foreground">
                      · {b.recipeCode} · {b.plannedOn} ·{" "}
                      {b.status === "in_progress" ? "in progress" : "planned"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
