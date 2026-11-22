"use client";

import {
  roundQuantity,
  scaleRecipe,
  units,
  unitsOfDimension,
  type RecipeScaleTarget,
  type UnitCode,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { CheckCircle2, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AllergenBadges } from "@/components/item-badges";
import { AllergenDriftAlert, AllergenMismatchAlert, RecipeVersionBadge } from "@/components/recipe-badges";
import { formatLongDate } from "@/lib/format";
import type { Recipe, RecipeVersion } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { DraftEditor, type DraftStart } from "./draft-editor";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";
import { VersionCompare } from "./version-compare";

const money = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 4 });
const BATCHES = "batches";

/** A recipe: its current approved version, any draft beside it, the history, and the draft editor. */
export function RecipeDetail({ slug, recipe }: { slug: string; recipe: Recipe }) {
  const timeZone = useWorkspaceTimeZone();
  const router = useRouter();
  const { can } = useWorkspace();
  const canWrite = can("recipes", "write");
  const canManage = can("recipes", "manage");
  const [editing, setEditing] = useState<DraftStart | null>(null);
  const [viewed, setViewed] = useState<RecipeVersion | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const current = recipe.currentVersion;
  const approved = current?.status === "approved" ? current : null;
  const draft = current?.status === "draft" ? current : recipe.draftVersion;
  const api = () => browserApi().v1.workspaces[":slug"].recipes;

  async function run(label: string, action: () => Promise<unknown>, done: string) {
    setPending(label);
    try {
      await action();
      toast.success(done);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const fetchVersion = async (versionId: string) =>
    (await unwrap(
      api()[":id"].versions[":versionId"].$get({ param: { slug, id: recipe.id, versionId }, query: {} }),
    )) as unknown as RecipeVersion;

  async function viewVersion(versionId: string) {
    setPending(versionId);
    try {
      setViewed(await fetchVersion(versionId));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  /** Opens the editor with a copy of an older version's content as the next draft. */
  async function draftFrom(versionId: string) {
    setPending(`copy-${versionId}`);
    try {
      setEditing(await fetchVersion(versionId));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            <Link href={`/${slug}/recipes`} className="hover:underline">
              Recipes
            </Link>{" "}
            / <span className="font-mono text-xs">{recipe.code}</span>
          </p>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {recipe.name}
            {recipe.status === "archived" && <Badge variant="secondary">Archived</Badge>}
          </h2>
          <p className="text-sm text-muted-foreground">
            Makes{" "}
            {recipe.outputItem ? `${recipe.outputItem.code} · ${recipe.outputItem.name}` : "an unknown item"}
          </p>
          {recipe.description && <p className="max-w-prose text-sm">{recipe.description}</p>}
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                void run(
                  "status",
                  () =>
                    unwrap(
                      api()[":id"].$patch({
                        param: { slug, id: recipe.id },
                        json: { status: recipe.status === "active" ? "archived" : "active" },
                      }),
                    ),
                  recipe.status === "active" ? "Recipe archived" : "Recipe restored",
                )
              }
            >
              {recipe.status === "active" ? "Archive" : "Restore"}
            </Button>
            {recipe.status === "active" && !draft && current && (
              <Button onClick={() => setEditing(current)}>
                <Pencil data-icon="inline-start" /> New draft from v{current.versionNumber}
              </Button>
            )}
            {recipe.status === "active" && !current && recipe.outputItem && (
              <Button
                onClick={() =>
                  setEditing({
                    status: "draft",
                    versionNumber: 1,
                    yieldQuantity: 0,
                    yieldUnit: recipe.outputItem!.unit,
                    method: null,
                    changeNote: null,
                    outputItem: recipe.outputItem!,
                    lines: [],
                  })
                }
              >
                <Pencil data-icon="inline-start" /> Start a draft
              </Button>
            )}
          </div>
        )}
      </div>

      {approved ? (
        <VersionCard version={approved} title="Current version" />
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No approved version yet. A recipe can&apos;t be used until a draft is approved.
        </p>
      )}

      {draft && (
        <VersionCard
          version={draft}
          title="Draft"
          actions={
            <>
              {can("labels") && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/${slug}/labels/preview/${recipe.id}/${draft.id}`}>Preview label</Link>
                </Button>
              )}
              {canWrite && recipe.status === "active" && (
                <Button variant="outline" size="sm" onClick={() => setEditing(draft)}>
                  <Pencil data-icon="inline-start" /> Edit draft
                </Button>
              )}
              {canWrite && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => {
                    if (!window.confirm("Discard this draft? The approved version is not affected.")) return;
                    void run(
                      "discard",
                      () => unwrapEmpty(api()[":id"].draft.$delete({ param: { slug, id: recipe.id } })),
                      "Draft discarded",
                    );
                  }}
                >
                  Discard
                </Button>
              )}
              {canManage && recipe.status === "active" && (
                <Button
                  size="sm"
                  disabled={pending !== null || draft.lines.length === 0 || !(draft.yieldQuantity > 0)}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Approve v${draft.versionNumber}? It becomes the current version${approved ? ` and v${approved.versionNumber} is superseded` : ""}. This is recorded against your name.`,
                      )
                    )
                      return;
                    void run(
                      "approve",
                      () => unwrap(api()[":id"].draft.approve.$post({ param: { slug, id: recipe.id } })),
                      `v${draft.versionNumber} approved`,
                    );
                  }}
                >
                  {pending === "approve" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <CheckCircle2 data-icon="inline-start" />
                  )}{" "}
                  Approve
                </Button>
              )}
            </>
          }
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Version history</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          {recipe.versions.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <RecipeVersionBadge status={v.status} versionNumber={v.versionNumber} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {v.changeNote ?? "No change note"}
                {v.approvedAt &&
                  ` · approved ${formatLongDate(v.approvedAt, timeZone)}${v.approvedByName ? ` by ${v.approvedByName}` : ""}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending !== null}
                onClick={() => void viewVersion(v.id)}
              >
                {pending === v.id && <Spinner data-icon="inline-start" />} View
              </Button>
              {canWrite && recipe.status === "active" && !draft && v.status === "superseded" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => void draftFrom(v.id)}
                >
                  {pending === `copy-${v.id}` && <Spinner data-icon="inline-start" />} New draft from this
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {recipe.versions.length > 1 && <VersionCompare slug={slug} recipe={recipe} />}

      {viewed && (
        <VersionCard
          version={viewed}
          title={`Version ${viewed.versionNumber}`}
          actions={
            <>
              {canWrite && recipe.status === "active" && !draft && viewed.status === "superseded" && (
                <Button variant="outline" size="sm" onClick={() => setEditing(viewed)}>
                  <Pencil data-icon="inline-start" /> New draft from v{viewed.versionNumber}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setViewed(null)}>
                Close
              </Button>
            </>
          }
        />
      )}

      {editing && (
        <DraftEditor
          key={`${editing.status}-${editing.versionNumber}`}
          slug={slug}
          recipeId={recipe.id}
          start={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** One version: yield, ingredient lines (with an optional scale), method, allergens and cost. */
function VersionCard({
  version,
  title,
  actions,
}: {
  version: RecipeVersion;
  title: string;
  actions?: React.ReactNode;
}) {
  const timeZone = useWorkspaceTimeZone();
  const [mode, setMode] = useState<string>(BATCHES);
  const [amount, setAmount] = useState("");
  const { rollup } = version;
  const yieldUnits = unitsOfDimension(version.yieldUnit);

  const wanted = Number(amount);
  const target: RecipeScaleTarget | null =
    amount.trim() === "" || !(wanted > 0)
      ? null
      : mode === BATCHES
        ? { batches: wanted }
        : { outputQuantity: wanted, outputUnit: mode as UnitCode };
  const scale = target
    ? scaleRecipe(
        version.lines,
        { yieldQuantity: version.yieldQuantity, yieldUnit: version.yieldUnit },
        target,
        version.outputItem,
      )
    : null;
  const costPerUnit = rollup.cost.costPerOutputUnit;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          {title} <RecipeVersionBadge status={version.status} versionNumber={version.versionNumber} />
        </CardTitle>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          One batch makes{" "}
          <span className="font-medium text-foreground">
            {roundQuantity(version.yieldQuantity)} {units[version.yieldUnit].label}
          </span>
          {version.approvedAt &&
            ` · approved ${formatLongDate(version.approvedAt, timeZone)}${version.approvedByName ? ` by ${version.approvedByName}` : ""}`}
          {version.changeNote && ` · ${version.changeNote}`}
        </p>

        <AllergenDriftAlert drift={version.allergenDrift} />
        <AllergenMismatchAlert mismatch={rollup.allergenMismatch} />

        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Allergens from the ingredients</h3>
          <AllergenBadges
            contains={rollup.allergens.contains}
            mayContain={rollup.allergens.mayContain}
            empty="None from the ingredients"
          />
        </div>

        <div className="flex flex-wrap items-end gap-6 text-sm">
          <div>
            <p className="text-muted-foreground">Cost per batch</p>
            <p className="text-lg font-semibold">{money(rollup.cost.batchCost)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Cost per {units[rollup.cost.outputUnit].label}</p>
            <p className="text-lg font-semibold">{costPerUnit === null ? "—" : money(costPerUnit)}</p>
          </div>
          {!rollup.cost.costComplete && (
            <p className="text-label-orange">
              Partial: no cost for{" "}
              {[...rollup.cost.missingCostCodes, ...rollup.cost.unconvertibleCodes].join(", ")}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`scale-${version.id}`} className="text-sm font-medium">
            Scale to
          </label>
          <Input
            id={`scale-${version.id}`}
            className="w-28"
            inputMode="decimal"
            placeholder="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger className="w-36" aria-label="Scale by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={BATCHES}>batches</SelectItem>
                {yieldUnits.map((u) => (
                  <SelectItem key={u} value={u}>
                    {units[u].label} made
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {scale && (
            <span className="text-sm text-muted-foreground">
              {roundQuantity(scale.factor)} batches · makes {roundQuantity(scale.outputQuantity)}{" "}
              {units[scale.outputUnit].label}
            </span>
          )}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ingredient</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              {scale && <TableHead className="text-right">Scaled</TableHead>}
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {version.lines.map((line, i) => (
              <TableRow key={line.id}>
                <TableCell>
                  <span className="font-mono text-xs">{line.item.code}</span> · {line.item.name}
                  {line.item.status === "archived" && (
                    <Badge variant="secondary" className="ml-2">
                      Archived
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {roundQuantity(line.quantity)} {units[line.unit].label}
                </TableCell>
                {scale && (
                  <TableCell className="text-right font-medium tabular-nums">
                    {roundQuantity(scale.quantities[i]!)} {units[line.unit].label}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">{line.note ?? ""}</TableCell>
              </TableRow>
            ))}
            {version.lines.length === 0 && (
              <TableRow>
                <TableCell colSpan={scale ? 4 : 3} className="text-center text-muted-foreground">
                  No ingredients yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {version.method && (
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Method</h3>
            <p className="text-sm whitespace-pre-wrap">{version.method}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
