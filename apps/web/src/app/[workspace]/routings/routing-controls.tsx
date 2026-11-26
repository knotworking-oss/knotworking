"use client";

import { routingVersionStatusLabels, ROUTING_MAX_OPERATIONS } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { ArrowDown, ArrowUp, Check, Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { HaccpDialog, SelectField } from "@/components/haccp-forms";
import type { Routing, RoutingVersion, WorkCentre } from "@/lib/api";
import { browserApi, errorMessage, unwrap, unwrapEmpty } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

const routingsApi = () => browserApi().v1.workspaces[":slug"].routings;

/** "New routing" on the list: a bill of materials without one, a code and a name. */
export function NewRouting({
  slug,
  boms,
}: {
  slug: string;
  boms: readonly { id: string; code: string; name: string }[];
}) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [recipeId, setRecipeId] = useState(boms[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  if (!can("routings", "write")) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={!boms.length}>
        <Plus /> New routing
      </Button>
      {open && (
        <HaccpDialog
          title="New routing"
          description="The ordered operations that make a bill of materials. Add them as a draft, then approve it."
          submitLabel="Create"
          disabled={!recipeId || !code.trim() || !name.trim()}
          onClose={() => setOpen(false)}
          onSubmit={async () => {
            const made = await unwrap(
              routingsApi().$post({
                param: { slug },
                json: { recipeId, code: code.trim(), name: name.trim(), draft: { operations: [] } },
              }),
            );
            router.push(`/${slug}/routings/${made.id}`);
            return `${made.code} created`;
          }}
        >
          <SelectField
            id="routing-bom"
            label="Bill of materials"
            value={recipeId}
            onChange={setRecipeId}
            options={boms.map((b) => [b.id, `${b.code} · ${b.name}`] as const)}
          />
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <Field>
              <FieldLabel htmlFor="routing-code">Code</FieldLabel>
              <Input id="routing-code" required maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="routing-name">Name</FieldLabel>
              <Input id="routing-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
        </HaccpDialog>
      )}
    </>
  );
}

export function VersionBadge({ status }: { status: RoutingVersion["status"] }) {
  return (
    <Badge variant={status === "approved" ? "default" : status === "draft" ? "secondary" : "outline"}>
      {routingVersionStatusLabels[status]}
    </Badge>
  );
}

type Row = {
  key: string;
  name: string;
  workCentreId: string;
  setupMinutes: string;
  runMinutes: string;
  instructions: string;
};

const rowOf = (op: RoutingVersion["operations"][number]): Row => ({
  key: op.id,
  name: op.name,
  workCentreId: op.workCentreId,
  setupMinutes: String(op.setupMinutes),
  runMinutes: String(op.runMinutes),
  instructions: op.instructions ?? "",
});

/**
 * The routing editor: the draft's operations in order (or, without a draft, the approved ones as
 * the starting point of the next version). Save keeps a draft; approving is `manage`.
 */
export function RoutingEditor({
  slug,
  routing,
  workCentres,
}: {
  slug: string;
  routing: Routing;
  workCentres: readonly WorkCentre[];
}) {
  const { can } = useWorkspace();
  const router = useRouter();
  const draft = routing.versions.find((v) => v.status === "draft");
  const approved = routing.versions.find((v) => v.status === "approved");
  const base = draft ?? approved;
  const [rows, setRows] = useState<Row[]>(() => (base?.operations ?? []).map(rowOf));
  const [changeNote, setChangeNote] = useState(draft?.changeNote ?? "");
  const [pending, setPending] = useState(false);
  const editable = can("routings", "write") && routing.status === "active";
  const active = workCentres.filter((w) => w.status === "active");
  const centreOptions = active.map((w) => [w.id, `${w.code} · ${w.name}`] as const);

  const update = (index: number, patch: Partial<Row>) =>
    setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const move = (index: number, by: -1 | 1) =>
    setRows((list) => {
      const next = [...list];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row!);
      return next;
    });

  async function run(action: () => Promise<string>) {
    setPending(true);
    try {
      toast.success(await action());
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const save = () =>
    run(async () => {
      await unwrap(
        routingsApi()[":id"].draft.$put({
          param: { slug, id: routing.id },
          json: {
            changeNote: changeNote.trim() || null,
            operations: rows.map((r) => ({
              name: r.name.trim(),
              workCentreId: r.workCentreId,
              setupMinutes: Number(r.setupMinutes) || 0,
              runMinutes: Number(r.runMinutes) || 0,
              instructions: r.instructions.trim() || null,
            })),
          },
        }),
      );
      return "Draft saved";
    });

  if (!editable) return null;
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="routing-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="routing-editor" className="font-medium">
          {draft ? `Draft version ${draft.versionNumber}` : "Start the next version"}
        </h2>
        <div className="flex flex-wrap gap-2">
          {draft && can("routings", "manage") && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await unwrap(routingsApi()[":id"].draft.approve.$post({ param: { slug, id: routing.id } }));
                  return `Version ${draft.versionNumber} approved`;
                })
              }
            >
              <Check /> Approve
            </Button>
          )}
          {draft && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  await unwrapEmpty(routingsApi()[":id"].draft.$delete({ param: { slug, id: routing.id } }));
                  return "Draft discarded";
                })
              }
            >
              <Trash2 /> Discard draft
            </Button>
          )}
        </div>
      </div>
      {!active.length && (
        <p className="text-sm text-muted-foreground">Add a work centre first: every operation is done at one.</p>
      )}
      <ol className="space-y-3">
        {rows.map((row, index) => (
          <li key={row.key} className="grid gap-3 rounded-md border p-3 md:grid-cols-[2rem_1fr_14rem_6rem_6rem_auto]">
            <span className="pt-7 text-sm font-medium tabular-nums">{index + 1}.</span>
            <Field>
              <FieldLabel htmlFor={`op-name-${row.key}`}>Operation</FieldLabel>
              <Input
                id={`op-name-${row.key}`}
                required
                maxLength={200}
                value={row.name}
                onChange={(e) => update(index, { name: e.target.value })}
              />
            </Field>
            <SelectField
              id={`op-centre-${row.key}`}
              label="Work centre"
              value={row.workCentreId}
              onChange={(workCentreId) => update(index, { workCentreId })}
              options={centreOptions}
            />
            <Field>
              <FieldLabel htmlFor={`op-setup-${row.key}`}>Setup min</FieldLabel>
              <Input
                id={`op-setup-${row.key}`}
                type="number"
                min={0}
                step="0.01"
                value={row.setupMinutes}
                onChange={(e) => update(index, { setupMinutes: e.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`op-run-${row.key}`}>Run min</FieldLabel>
              <Input
                id={`op-run-${row.key}`}
                type="number"
                min={0}
                step="0.01"
                value={row.runMinutes}
                onChange={(e) => update(index, { runMinutes: e.target.value })}
              />
            </Field>
            <div className="flex items-end gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Move down"
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove operation"
                onClick={() => setRows((list) => list.filter((_, i) => i !== index))}
              >
                <Trash2 />
              </Button>
            </div>
            <Field className="md:col-span-6 md:col-start-2">
              <FieldLabel htmlFor={`op-instructions-${row.key}`}>Instructions (optional)</FieldLabel>
              <Textarea
                id={`op-instructions-${row.key}`}
                rows={2}
                maxLength={4000}
                value={row.instructions}
                onChange={(e) => update(index, { instructions: e.target.value })}
              />
            </Field>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        Setup is once per batch; run minutes are per batch of the bill&apos;s yield.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!active.length || rows.length >= ROUTING_MAX_OPERATIONS}
          onClick={() =>
            setRows((list) => [
              ...list,
              {
                key: crypto.randomUUID(),
                name: "",
                workCentreId: active[0]!.id,
                setupMinutes: "0",
                runMinutes: "0",
                instructions: "",
              },
            ])
          }
        >
          <Plus /> Add operation
        </Button>
        <Field className="min-w-60 flex-1">
          <FieldLabel htmlFor="routing-change-note">Change note (optional)</FieldLabel>
          <Input
            id="routing-change-note"
            maxLength={2000}
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
          />
        </Field>
        <Button size="sm" disabled={pending || rows.some((r) => !r.name.trim())} onClick={() => void save()}>
          <Save /> Save draft
        </Button>
      </div>
    </section>
  );
}

/** Archive or restore a routing (write). An archived routing makes no new job cards. */
export function RoutingStatusButton({ slug, routing }: { slug: string; routing: Pick<Routing, "id" | "status"> }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  if (!can("routings", "write")) return null;
  const next = routing.status === "active" ? "archived" : "active";
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await unwrap(routingsApi()[":id"].$patch({ param: { slug, id: routing.id }, json: { status: next } }));
          toast.success(next === "archived" ? "Routing archived" : "Routing restored");
          router.refresh();
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setPending(false);
        }
      }}
    >
      {next === "archived" ? "Archive" : "Restore"}
    </Button>
  );
}
