"use client";

import { BI_PACK_LIMITS, type BiBoardPackItem } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import { Checkbox } from "@knotworking/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@knotworking/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import { Textarea } from "@knotworking/ui/components/textarea";
import { ArrowDown, ArrowUp, Printer, Send, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { SnapshotBody, type FrozenSnapshot } from "@/components/snapshot-view";
import type { PackDetail, SnapshotSummary } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceCurrency } from "@/lib/workspace-time";

interface Definition {
  label: string;
  definition: string;
  unit: string;
  version?: string;
}

/**
 * A board pack: its cover, contents, each frozen snapshot with commentary and the change since the
 * previous snapshot, and the definitions of every figure. Drafts are edited here by people who
 * manage dashboards; an issued pack never changes. Prints one section per page.
 */
export function PackView({
  slug,
  pack,
  snapshots,
  people,
}: {
  slug: string;
  pack: PackDetail;
  snapshots: SnapshotSummary[];
  /** Active, non-guest members who can be named in the audience. */
  people: Array<{ userId: string; name: string }>;
}) {
  const currency = useWorkspaceCurrency();
  const { idx } = useWorkspace();
  const name = (id: string | null) => (id ? (idx.users.get(id)?.name ?? "Someone") : "Someone");
  const definitions = Object.entries(pack.definitions as unknown as Record<string, Definition>).sort((a, b) =>
    a[1].label.localeCompare(b[1].label),
  );
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8 p-6 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Badge variant={pack.status === "issued" ? "secondary" : "outline"}>
          {pack.status === "issued" ? "Issued" : "Draft"}
        </Badge>
        <span className="mr-auto text-sm text-muted-foreground">
          {pack.status === "issued"
            ? `Issued by ${name(pack.issuedBy)} on ${new Date(pack.issuedAt!).toLocaleDateString("en-GB")}. It never changes.`
            : "Only people who manage dashboards see this draft."}
        </span>
        <Button size="sm" variant="outline" onClick={() => window.print()}>
          <Printer /> Print
        </Button>
      </div>
      {pack.canEdit && (
        // Keyed by version: after a save the editor starts again from what the server stored.
        <PackEditor key={pack.version} slug={slug} pack={pack} snapshots={snapshots} people={people} />
      )}

      <section
        className="flex min-h-[50vh] flex-col justify-center gap-4 rounded-lg border p-10 print:min-h-screen print:border-0"
        aria-label="Cover"
      >
        <p className="text-sm text-muted-foreground">Board pack · as at {pack.asAt}</p>
        <h2 className="text-3xl font-semibold tracking-tight">{pack.title}</h2>
        {pack.cover && <p className="max-w-2xl whitespace-pre-wrap">{pack.cover}</p>}
        <ol className="mt-4 flex list-decimal flex-col gap-1 pl-5 text-sm">
          {pack.items.map((item) => (
            <li key={item.snapshot.id}>{item.snapshot.title}</li>
          ))}
          {definitions.length > 0 && <li>Definitions</li>}
        </ol>
      </section>

      {pack.items.map((item, i) => (
        <section
          key={item.snapshot.id}
          className="flex flex-col gap-4 print:break-before-page"
          aria-label={item.snapshot.title}
        >
          <h2 className="text-xl font-semibold tracking-tight">
            {i + 1}. {item.snapshot.title}
          </h2>
          {item.commentary && (
            <div className="rounded-md border-l-4 bg-muted/40 p-3 text-sm">
              <p className="whitespace-pre-wrap">{item.commentary}</p>
            </div>
          )}
          <SnapshotBody
            snapshot={item.snapshot as unknown as FrozenSnapshot}
            previous={item.previous as unknown as FrozenSnapshot | null}
            base={`/${slug}`}
            workspaceCurrency={currency}
          />
        </section>
      ))}

      {definitions.length > 0 && (
        <section className="flex flex-col gap-3 print:break-before-page" aria-labelledby="definitions">
          <h2 id="definitions" className="text-xl font-semibold tracking-tight">
            Definitions
          </h2>
          <dl className="divide-y rounded-lg border">
            {definitions.map(([key, d]) => (
              <div key={key} className="flex flex-col gap-1 px-4 py-3">
                <dt className="font-medium">
                  {d.label}
                  {d.version && (
                    <span className="ml-2 text-xs text-muted-foreground">certified, {d.version}</span>
                  )}
                </dt>
                <dd className="text-sm">{d.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

/** Edits a draft: title, date, cover, and the ordered snapshots with their commentary; then issues it. */
function PackEditor({
  slug,
  pack,
  snapshots,
  people,
}: {
  slug: string;
  pack: PackDetail;
  snapshots: SnapshotSummary[];
  people: Array<{ userId: string; name: string }>;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(pack.title);
  const [asAt, setAsAt] = useState(pack.asAt);
  const [cover, setCover] = useState(pack.cover ?? "");
  const [items, setItems] = useState<BiBoardPackItem[]>(
    pack.items.map((i) => ({ snapshotId: i.snapshot.id, commentary: i.commentary ?? "" })),
  );
  const [pending, setPending] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const titleOf = new Map(snapshots.map((s) => [s.id, `${s.title} (${s.asAt})`]));
  const api = browserApi().v1.workspaces[":slug"].bi.packs[":id"];
  const param = { slug, id: pack.id };
  const dirty =
    title.trim() !== pack.title ||
    asAt !== pack.asAt ||
    cover.trim() !== (pack.cover ?? "") ||
    // Whitespace-only commentary is saved as none.
    JSON.stringify(items.map((i) => [i.snapshotId, i.commentary?.trim() ? i.commentary : ""])) !==
      JSON.stringify(pack.items.map((i) => [i.snapshot.id, i.commentary ?? ""]));

  async function save() {
    setPending(true);
    try {
      await unwrap(
        api.$patch({
          param,
          json: {
            title,
            asAt,
            cover: cover.trim() || null,
            items: items.map((i) => ({
              snapshotId: i.snapshotId,
              ...(i.commentary?.trim() ? { commentary: i.commentary } : {}),
            })),
            expectedVersion: pack.version,
          },
        }),
      );
      toast.success("Pack saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this draft pack? Its snapshots are kept.")) return;
    try {
      await unwrap(api.$delete({ param }));
      router.push(`/${slug}/dashboards/packs`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const move = (i: number, d: -1 | 1) =>
    setItems((list) => {
      const next = [...list];
      [next[i], next[i + d]] = [next[i + d]!, next[i]!];
      return next;
    });
  const free = snapshots.filter((s) => !items.some((i) => i.snapshotId === s.id));

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle className="text-sm">Edit the draft</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="pack-title">Title</FieldLabel>
              <Input
                id="pack-title"
                value={title}
                maxLength={160}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="pack-as-at">For the meeting on</FieldLabel>
              <Input id="pack-as-at" type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="pack-cover">Cover</FieldLabel>
            <Textarea
              id="pack-cover"
              value={cover}
              maxLength={BI_PACK_LIMITS.cover}
              onChange={(e) => setCover(e.target.value)}
            />
            <FieldDescription>
              Commentary for the cover page. Figures come only from the snapshots.
            </FieldDescription>
          </Field>
          <div className="flex flex-col gap-2">
            <FieldLabel>Snapshots, in order</FieldLabel>
            {items.map((item, i) => (
              <div key={item.snapshotId} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <span className="mr-auto text-sm font-medium">
                    {titleOf.get(item.snapshotId) ?? "Snapshot"}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={i === items.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove from the pack"
                    onClick={() => setItems((l) => l.filter((_, j) => j !== i))}
                  >
                    <X />
                  </Button>
                </div>
                <Textarea
                  aria-label="Commentary"
                  placeholder="Commentary shown above this snapshot (optional)"
                  value={item.commentary ?? ""}
                  maxLength={BI_PACK_LIMITS.commentary}
                  onChange={(e) =>
                    setItems((l) => l.map((x, j) => (j === i ? { ...x, commentary: e.target.value } : x)))
                  }
                />
              </div>
            ))}
            <Select
              value=""
              onValueChange={(snapshotId) => setItems((l) => [...l, { snapshotId, commentary: "" }])}
              disabled={free.length === 0 || items.length >= BI_PACK_LIMITS.items}
            >
              <SelectTrigger className="w-full md:w-96" aria-label="Add a snapshot">
                <SelectValue
                  placeholder={
                    free.length ? "Add a snapshot…" : "No other snapshots: take one from a dashboard"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {free.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.title} ({s.asAt})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={!dirty || pending}>
              {pending && <Spinner data-icon="inline-start" />} Save
            </Button>
            <Button
              variant="outline"
              onClick={() => setIssuing(true)}
              disabled={dirty || pack.items.length === 0}
            >
              <Send /> Issue…
            </Button>
            <Button variant="ghost" className="ml-auto" onClick={() => void remove()}>
              <Trash2 /> Delete draft
            </Button>
          </div>
          {dirty && <p className="text-xs text-muted-foreground">Save your changes before issuing.</p>}
        </FieldGroup>
      </CardContent>
      {issuing && <IssueDialog slug={slug} pack={pack} people={people} onClose={() => setIssuing(false)} />}
    </Card>
  );
}

function IssueDialog({
  slug,
  pack,
  people,
  onClose,
}: {
  slug: string;
  pack: PackDetail;
  people: Array<{ userId: string; name: string }>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [audience, setAudience] = useState<"workspace" | "members">("members");
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  async function issue() {
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].bi.packs[":id"].issue.$post({
          param: { slug, id: pack.id },
          json: {
            audience,
            memberIds: audience === "members" ? [...members] : [],
            expectedVersion: pack.version,
          },
        }),
      );
      toast.success("Pack issued");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue “{pack.title}”</DialogTitle>
          <DialogDescription>
            The people you choose see these frozen figures as they were taken, even where they can't read the
            underlying data. An issued pack never changes.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={audience} onValueChange={(v) => setAudience(v as "workspace" | "members")}>
          <Field orientation="horizontal">
            <RadioGroupItem value="members" id="pack-aud-members" />
            <FieldLabel htmlFor="pack-aud-members">Named people (the board)</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="workspace" id="pack-aud-ws" />
            <FieldLabel htmlFor="pack-aud-ws">Every member who can open dashboards</FieldLabel>
          </Field>
        </RadioGroup>
        {audience === "members" && (
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-md border p-2">
            <p className="text-xs text-muted-foreground">
              Members only (never guests). Someone without access to Dashboards won't be able to open it.
            </p>
            {people.map((p) => (
              <label key={p.userId} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={members.has(p.userId)}
                  onCheckedChange={(on) => {
                    const next = new Set(members);
                    if (on) next.add(p.userId);
                    else next.delete(p.userId);
                    setMembers(next);
                  }}
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => void issue()}
            disabled={pending || (audience === "members" && members.size === 0)}
          >
            {pending && <Spinner data-icon="inline-start" />} Issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
