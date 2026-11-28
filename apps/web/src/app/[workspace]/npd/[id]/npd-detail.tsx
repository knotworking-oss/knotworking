"use client";

import {
  isNpdFinal,
  npdSignoffKeys,
  npdTrialKindLabels,
  npdTrialKinds,
  npdTrialOutcomeLabels,
  npdTrialOutcomes,
  npdWorkingStages,
  npdStatusLabels,
  storageConditions,
  storageLabels,
  type NpdSignoffKey,
  type NpdTrialKind,
  type NpdTrialOutcome,
  type StorageCondition,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
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
import { Textarea } from "@knotworking/ui/components/textarea";
import { Pencil, Plus, Rocket } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { NpdChecklist, NpdStatusBadge } from "@/components/npd-badges";
import { RecordAttachments } from "@/components/record-attachments";
import type { Item, NpdProject, RecipeRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone, useWorkspaceToday } from "@/lib/workspace-time";

const NONE = "none";
const signoffButtons: Record<NpdSignoffKey, string> = {
  haccp_reviewed: "Record HACCP review",
  artwork_agreed: "Record artwork agreed",
  customer_signoff: "Record customer sign-off",
};
type Dialogs = "brief" | "trial" | "cancel" | { signoff: NpdSignoffKey } | null;

/** A product development project: brief, launch checklist, trials, sign-offs and documents. */
export function NpdDetail({
  slug,
  project: p,
  items,
  recipes,
}: {
  slug: string;
  project: NpdProject;
  items: Item[];
  recipes: RecipeRow[];
}) {
  const timeZone = useWorkspaceTimeZone();
  const day = (v: string | null) => (v ? formatLongDate(v, timeZone) : "—");
  const router = useRouter();
  const { can } = useWorkspace();
  const open = !isNpdFinal(p.status);
  const canWrite = can("npd", "write") && open;
  const canManage = can("npd", "manage") && open;
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, setPending] = useState<string | null>(null);
  const api = () => browserApi().v1.workspaces[":slug"].npd.projects[":id"];

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
  const signable = npdSignoffKeys.filter((k) => k !== "customer_signoff" || p.customerName);

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">
            <Link href={`/${slug}/npd`} className="hover:underline">
              Product development
            </Link>{" "}
            / <span className="font-mono text-xs">{p.code}</span>
          </p>
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {p.name} <NpdStatusBadge status={p.status} />
          </h2>
          <p className="text-sm text-muted-foreground">
            {p.customerName ? `For ${p.customerName}` : "Own brand"}
            {p.targetLaunchOn ? ` · target launch ${day(p.targetLaunchOn)}` : ""}
            {p.launchedAt
              ? ` · launched ${formatLongDate(String(p.launchedAt), timeZone)} by ${p.launchedByName ?? "someone"}`
              : ""}
            {p.status === "cancelled" ? ` · cancelled: ${p.cancelReason}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && (
            <Select
              value={p.status}
              onValueChange={(v) =>
                void run(
                  "stage",
                  () =>
                    unwrap(
                      api().$patch({
                        param: { slug, id: p.id },
                        json: { status: v as (typeof npdWorkingStages)[number] },
                      }),
                    ),
                  "Stage changed",
                )
              }
            >
              <SelectTrigger className="w-40" aria-label="Stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {npdWorkingStages.map((s) => (
                    <SelectItem key={s} value={s}>
                      {npdStatusLabels[s]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          {canWrite && (
            <Button variant="outline" onClick={() => setDialog("cancel")}>
              Cancel project
            </Button>
          )}
          {canManage && (
            <Button
              disabled={pending !== null || !p.readyToLaunch}
              title={p.readyToLaunch ? undefined : "Every checklist item must be met"}
              onClick={() =>
                void run(
                  "launch",
                  () => unwrap(api().launch.$post({ param: { slug, id: p.id } })),
                  `${p.name} launched`,
                )
              }
            >
              {pending === "launch" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Rocket data-icon="inline-start" />
              )}{" "}
              Launch
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle>Brief</CardTitle>
            </div>
            {canWrite && (
              <Button variant="ghost" size="sm" onClick={() => setDialog("brief")}>
                <Pencil data-icon="inline-start" /> Edit
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
              <Row label="Concept">{p.brief}</Row>
              <Row label="Makes">{p.outputItem ? `${p.outputItem.code} · ${p.outputItem.name}` : null}</Row>
              <Row label="Recipe">
                {p.recipe ? (
                  <Link href={`/${slug}/recipes/${p.recipe.id}`} className="hover:underline">
                    {p.recipe.code} · {p.recipe.name}
                  </Link>
                ) : null}
              </Row>
              <Row label="Shelf life">{p.targetShelfLifeDays ? `${p.targetShelfLifeDays} days` : null}</Row>
              <Row label="Storage">{p.storage ? storageLabels[p.storage] : null}</Row>
              <Row label="Target cost">{p.targetCost != null ? String(p.targetCost) : null}</Row>
              <Row label="Claims">{p.claims.length ? p.claims.join(", ") : null}</Row>
              <Row label="Constraints">{p.constraints}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Launch checklist
              {open && (
                <Badge variant={p.readyToLaunch ? "secondary" : "outline"}>
                  {p.readyToLaunch ? "Ready" : "Not ready"}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <NpdChecklist checks={p.checklist} />
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                {signable.map((k) => (
                  <Button key={k} variant="outline" size="sm" onClick={() => setDialog({ signoff: k })}>
                    {signoffButtons[k]}
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Trials</CardTitle>
          </div>
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => setDialog("trial")}>
              <Plus data-icon="inline-start" /> Record trial
            </Button>
          )}
        </CardHeader>
        <CardContent className="px-0">
          {p.trials.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">No trials yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">#</TableHead>
                  <TableHead>Trial</TableHead>
                  <TableHead>Held</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="pr-6">Findings</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.trials.map((t) => (
                  <TableRow key={t.id} className="align-top">
                    <TableCell className="pl-6">{t.trialNumber}</TableCell>
                    <TableCell className="max-w-xs whitespace-normal">
                      <div className="font-medium">{npdTrialKindLabels[t.kind]}</div>
                      <div className="text-muted-foreground">{t.description}</div>
                      {t.recipeVersionNumber && (
                        <div className="text-xs text-muted-foreground">Recipe v{t.recipeVersionNumber}</div>
                      )}
                    </TableCell>
                    <TableCell>{day(t.heldOn)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          t.outcome === "fail"
                            ? "destructive"
                            : t.outcome === "pass"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {npdTrialOutcomeLabels[t.outcome]}
                      </Badge>
                      {t.achievedShelfLifeDays != null && (
                        <div className="text-xs text-muted-foreground">{t.achievedShelfLifeDays} days</div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-sm pr-6 whitespace-normal">{t.findings ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <RecordAttachments entityType="npd_project" entityId={p.id} />
        </CardContent>
      </Card>

      {dialog === "brief" && (
        <BriefDialog
          slug={slug}
          project={p}
          items={items}
          recipes={recipes}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "trial" && <TrialDialog slug={slug} project={p} onClose={() => setDialog(null)} />}
      {dialog === "cancel" && <CancelDialog slug={slug} project={p} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && (
        <SignoffDialog slug={slug} project={p} signoff={dialog.signoff} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{children ?? "—"}</dd>
    </>
  );
}

function useSave(onClose: () => void) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const save = async (e: FormEvent, action: () => Promise<unknown>, done: string) => {
    e.preventDefault();
    setPending(true);
    try {
      await action();
      toast.success(done);
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return { pending, save };
}

function Shell(props: {
  title: string;
  description: string;
  submitLabel: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={props.onSubmit}>
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">{props.children}</FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={props.pending}>
              {props.pending && <Spinner data-icon="inline-start" />} {props.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BriefDialog({
  slug,
  project: p,
  items,
  recipes,
  onClose,
}: {
  slug: string;
  project: NpdProject;
  items: Item[];
  recipes: RecipeRow[];
  onClose: () => void;
}) {
  const { pending, save } = useSave(onClose);
  const [f, setF] = useState({
    name: p.name,
    brief: p.brief ?? "",
    customerName: p.customerName ?? "",
    targetLaunchOn: p.targetLaunchOn ?? "",
    targetShelfLifeDays: p.targetShelfLifeDays != null ? String(p.targetShelfLifeDays) : "",
    targetCost: p.targetCost != null ? String(p.targetCost) : "",
    storage: (p.storage ?? NONE) as StorageCondition | typeof NONE,
    claims: p.claims.join(", "),
    constraints: p.constraints ?? "",
    outputItemId: p.outputItemId ?? NONE,
    recipeId: p.recipeId ?? NONE,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const recipeOptions = recipes.filter((r) => f.outputItemId === NONE || r.outputItem?.id === f.outputItemId);
  return (
    <Shell
      title="Edit brief"
      description="The targets the launch checklist checks against."
      submitLabel="Save brief"
      pending={pending}
      onClose={onClose}
      onSubmit={(e) =>
        void save(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].npd.projects[":id"].$patch({
                param: { slug, id: p.id },
                json: {
                  name: f.name.trim(),
                  brief: f.brief.trim() || null,
                  customerName: f.customerName.trim() || null,
                  targetLaunchOn: f.targetLaunchOn || null,
                  targetShelfLifeDays: f.targetShelfLifeDays
                    ? Math.round(Number(f.targetShelfLifeDays))
                    : null,
                  targetCost: f.targetCost ? Number(f.targetCost) : null,
                  storage: f.storage === NONE ? null : f.storage,
                  claims: f.claims
                    .split(",")
                    .map((c) => c.trim())
                    .filter(Boolean),
                  constraints: f.constraints.trim() || null,
                  outputItemId: f.outputItemId === NONE ? null : f.outputItemId,
                  recipeId: f.recipeId === NONE ? null : f.recipeId,
                },
              }),
            ),
          "Brief saved",
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="b-name">Name</FieldLabel>
        <Input id="b-name" required maxLength={200} value={f.name} onChange={set("name")} />
      </Field>
      <Field>
        <FieldLabel htmlFor="b-brief">Concept</FieldLabel>
        <Textarea id="b-brief" maxLength={10_000} value={f.brief} onChange={set("brief")} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="b-customer">Customer</FieldLabel>
          <Input id="b-customer" maxLength={200} value={f.customerName} onChange={set("customerName")} />
        </Field>
        <Field>
          <FieldLabel htmlFor="b-launch">Target launch</FieldLabel>
          <Input id="b-launch" type="date" value={f.targetLaunchOn} onChange={set("targetLaunchOn")} />
        </Field>
        <Field>
          <FieldLabel htmlFor="b-shelf">Shelf life (days)</FieldLabel>
          <Input
            id="b-shelf"
            type="number"
            min={1}
            max={3650}
            value={f.targetShelfLifeDays}
            onChange={set("targetShelfLifeDays")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="b-storage">Storage</FieldLabel>
          <Select
            value={f.storage}
            onValueChange={(v) => setF((x) => ({ ...x, storage: v as StorageCondition | typeof NONE }))}
          >
            <SelectTrigger id="b-storage" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NONE}>Not set</SelectItem>
                {storageConditions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {storageLabels[s]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="b-cost">Target cost per unit</FieldLabel>
          <Input
            id="b-cost"
            type="number"
            min={0}
            step="any"
            value={f.targetCost}
            onChange={set("targetCost")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="b-claims">Claims</FieldLabel>
          <Input id="b-claims" placeholder="Comma-separated" value={f.claims} onChange={set("claims")} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="b-constraints">Constraints</FieldLabel>
        <Textarea
          id="b-constraints"
          maxLength={4000}
          placeholder="Allergens to avoid, line, pack format, price point"
          value={f.constraints}
          onChange={set("constraints")}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="b-item">Makes</FieldLabel>
        <Select
          value={f.outputItemId}
          onValueChange={(v) => setF((x) => ({ ...x, outputItemId: v, recipeId: NONE }))}
        >
          <SelectTrigger id="b-item" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NONE}>Not linked yet</SelectItem>
              {items.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.code} · {i.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="b-recipe">Recipe</FieldLabel>
        <Select value={f.recipeId} onValueChange={(v) => setF((x) => ({ ...x, recipeId: v }))}>
          <SelectTrigger id="b-recipe" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={NONE}>Not linked yet</SelectItem>
              {recipeOptions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.code} · {r.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </Shell>
  );
}

function TrialDialog({
  slug,
  project: p,
  onClose,
}: {
  slug: string;
  project: NpdProject;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const { pending, save } = useSave(onClose);
  const [kind, setKind] = useState<NpdTrialKind>("kitchen");
  const [heldOn, setHeldOn] = useState(today);
  const [description, setDescription] = useState("");
  const [outcome, setOutcome] = useState<NpdTrialOutcome>("pass");
  const [findings, setFindings] = useState("");
  const [achieved, setAchieved] = useState("");
  return (
    <Shell
      title="Record trial"
      description="What was tried and how it went. A shelf-life study records the life the product kept to."
      submitLabel="Record trial"
      pending={pending}
      onClose={onClose}
      onSubmit={(e) =>
        void save(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].npd.projects[":id"].trials.$post({
                param: { slug, id: p.id },
                json: {
                  kind,
                  heldOn,
                  description,
                  outcome,
                  findings: findings.trim() || null,
                  ...(kind === "shelf_life"
                    ? {
                        achievedShelfLifeDays: achieved ? Math.round(Number(achieved)) : null,
                        storage: p.storage,
                      }
                    : {}),
                },
              }),
            ),
          "Trial recorded",
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="t-kind">Kind</FieldLabel>
          <Select value={kind} onValueChange={(v) => setKind(v as NpdTrialKind)}>
            <SelectTrigger id="t-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {npdTrialKinds.map((k) => (
                  <SelectItem key={k} value={k}>
                    {npdTrialKindLabels[k]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="t-held">Held on</FieldLabel>
          <Input
            id="t-held"
            type="date"
            max={today}
            required
            value={heldOn}
            onChange={(e) => setHeldOn(e.target.value)}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="t-description">What was tried</FieldLabel>
        <Textarea
          id="t-description"
          required
          maxLength={4000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="t-outcome">Outcome</FieldLabel>
          <Select value={outcome} onValueChange={(v) => setOutcome(v as NpdTrialOutcome)}>
            <SelectTrigger id="t-outcome" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {npdTrialOutcomes.map((o) => (
                  <SelectItem key={o} value={o}>
                    {npdTrialOutcomeLabels[o]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {kind === "shelf_life" && (
          <Field>
            <FieldLabel htmlFor="t-achieved">Life achieved (days)</FieldLabel>
            <Input
              id="t-achieved"
              type="number"
              min={0}
              max={3650}
              required
              value={achieved}
              onChange={(e) => setAchieved(e.target.value)}
            />
          </Field>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor="t-findings">Findings</FieldLabel>
        <Textarea
          id="t-findings"
          maxLength={4000}
          value={findings}
          onChange={(e) => setFindings(e.target.value)}
        />
      </Field>
    </Shell>
  );
}

function SignoffDialog({
  slug,
  project: p,
  signoff,
  onClose,
}: {
  slug: string;
  project: NpdProject;
  signoff: NpdSignoffKey;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const { pending, save } = useSave(onClose);
  const [by, setBy] = useState("");
  const [on, setOn] = useState(today);
  const [reference, setReference] = useState("");
  return (
    <Shell
      title={signoffButtons[signoff]}
      description="Who signed and when. Your name is recorded with it."
      submitLabel="Record sign-off"
      pending={pending}
      onClose={onClose}
      onSubmit={(e) =>
        void save(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].npd.projects[":id"].signoffs.$post({
                param: { slug, id: p.id },
                json: { key: signoff, by, on, reference: reference.trim() || null },
              }),
            ),
          "Sign-off recorded",
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="s-by">Signed by</FieldLabel>
        <Input
          id="s-by"
          required
          maxLength={200}
          placeholder={signoff === "customer_signoff" ? "The customer's signatory" : "Who reviewed it"}
          value={by}
          onChange={(e) => setBy(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="s-on">On</FieldLabel>
          <Input
            id="s-on"
            type="date"
            max={today}
            required
            value={on}
            onChange={(e) => setOn(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="s-ref">Reference</FieldLabel>
          <Input
            id="s-ref"
            maxLength={200}
            placeholder="Document, proof, PO"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
      </div>
    </Shell>
  );
}

function CancelDialog({
  slug,
  project: p,
  onClose,
}: {
  slug: string;
  project: NpdProject;
  onClose: () => void;
}) {
  const { pending, save } = useSave(onClose);
  const [reason, setReason] = useState("");
  return (
    <Shell
      title={`Cancel ${p.code}`}
      description="A cancelled project is kept, read-only."
      submitLabel="Cancel project"
      pending={pending}
      onClose={onClose}
      onSubmit={(e) =>
        void save(
          e,
          () =>
            unwrap(
              browserApi().v1.workspaces[":slug"].npd.projects[":id"].$patch({
                param: { slug, id: p.id },
                json: { status: "cancelled", cancelReason: reason },
              }),
            ),
          "Project cancelled",
        )
      }
    >
      <Field>
        <FieldLabel htmlFor="c-reason">Why</FieldLabel>
        <Textarea
          id="c-reason"
          required
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </Shell>
  );
}
