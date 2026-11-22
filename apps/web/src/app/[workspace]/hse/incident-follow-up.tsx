"use client";

import {
  hseIncidentOutcomeLabels,
  hseIncidentOutcomes,
  hseIncidentKindLabels,
  hsePersonTypeLabels,
  hsePersonTypes,
  hseReportableKinds,
  hseTreatmentLabels,
  hseTreatments,
  newId,
  type HseIncidentOutcome,
  type HsePersonType,
  type HseTreatment,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { Lock, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { HseIncident } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";

const select = "h-9 w-full rounded-md border bg-background px-3 text-sm";
const incidents = () => browserApi().v1.workspaces[":slug"].hse.incidents;

interface InjuryDraft {
  staffId: string | null;
  personName: string;
  personType: HsePersonType;
  nature: string;
  bodyPart: string;
  treatment: HseTreatment;
  daysAbsent: string;
}
const blank = (): InjuryDraft => ({
  staffId: null,
  personName: "",
  personType: "employee",
  nature: "",
  bodyPart: "",
  treatment: "first_aid",
  daysAbsent: "",
});

/**
 * The people hurt and the worst outcome. Managers (signed in) edit them together; everyone else
 * sees how many people were hurt and a "Restricted" placeholder.
 */
export function PeopleHurt({ slug, incident: i }: { slug: string; incident: HseIncident }) {
  const router = useRouter();
  const open = i.status === "open";
  const [people, setPeople] = useState<InjuryDraft[]>(
    (i.injuries ?? []).map((x) => ({
      staffId: x.staffId,
      personName: x.personName,
      personType: x.personType,
      nature: x.nature,
      bodyPart: x.bodyPart ?? "",
      treatment: x.treatment,
      daysAbsent: x.daysAbsent === null ? "" : String(x.daysAbsent),
    })),
  );
  const [outcome, setOutcome] = useState<HseIncidentOutcome>(i.body.outcome ?? "none");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (n: number, patch: Partial<InjuryDraft>) =>
    setPeople((list) => list.map((p, j) => (j === n ? { ...p, ...patch } : p)));
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await unwrap(
        incidents()[":id"].injuries.$put({
          param: { slug, id: i.id },
          json: {
            commandId: newId(),
            expectedRevision: i.revision,
            reason: reason.trim(),
            outcome: people.length ? (outcome === "none" ? "first_aid" : outcome) : "none",
            injuries: people.map((p) => ({
              staffId: p.staffId,
              personName: p.personName.trim(),
              personType: p.personType,
              nature: p.nature.trim(),
              bodyPart: p.bodyPart.trim() || null,
              treatment: p.treatment,
              daysAbsent: p.daysAbsent === "" ? null : Number(p.daysAbsent),
            })),
          },
        }),
      );
      toast.success("People hurt saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const count =
    i.injuryCount === 0 ? "Nobody" : i.injuryCount === 1 ? "One person" : `${i.injuryCount} people`;
  return (
    <section className="space-y-3 rounded-lg border p-4 text-sm">
      <div>
        <h2 className="font-medium">People hurt · {hseIncidentOutcomeLabels[i.body.outcome ?? "none"]}</h2>
        <p className="text-muted-foreground">
          {i.canSeeRestricted
            ? "Restricted to signed-in Restricted HSE incident managers. Never synced or shown to API tokens."
            : `${count} recorded as hurt. Who and how is only shown to Restricted HSE incident managers.`}
        </p>
      </div>
      {!i.canSeeRestricted ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Lock className="size-4" /> Restricted
        </p>
      ) : !open ? (
        (i.injuries ?? []).map((x) => (
          <p key={x.id}>
            {x.personName} ({hsePersonTypeLabels[x.personType]}): {x.nature}
            {x.bodyPart ? `, ${x.bodyPart}` : ""} · {hseTreatmentLabels[x.treatment]}
            {x.daysAbsent !== null ? ` · ${x.daysAbsent} days away` : ""}
          </p>
        ))
      ) : (
        <form onSubmit={(e) => void save(e)} className="space-y-3">
          {people.map((p, n) => (
            <div key={n} className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
              <label className="space-y-1">
                Name
                <Input
                  required
                  maxLength={200}
                  value={p.personName}
                  onChange={(e) => set(n, { personName: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                Who
                <select
                  className={select}
                  value={p.personType}
                  onChange={(e) => set(n, { personType: e.target.value as HsePersonType })}
                >
                  {hsePersonTypes.map((t) => (
                    <option key={t} value={t}>
                      {hsePersonTypeLabels[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 sm:col-span-2">
                Injury or ill health
                <Input
                  required
                  maxLength={500}
                  value={p.nature}
                  onChange={(e) => set(n, { nature: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                Part of body
                <Input
                  maxLength={200}
                  value={p.bodyPart}
                  onChange={(e) => set(n, { bodyPart: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                Treatment
                <select
                  className={select}
                  value={p.treatment}
                  onChange={(e) => set(n, { treatment: e.target.value as HseTreatment })}
                >
                  {hseTreatments.map((t) => (
                    <option key={t} value={t}>
                      {hseTreatmentLabels[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                Days away from work
                <Input
                  type="number"
                  min={0}
                  max={3650}
                  value={p.daysAbsent}
                  onChange={(e) => set(n, { daysAbsent: e.target.value })}
                />
              </label>
              <div className="flex items-end justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPeople((l) => l.filter((_, j) => j !== n))}
                >
                  <Trash2 data-icon="inline-start" /> Remove
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setPeople((l) => [...l, blank()])}>
            <Plus data-icon="inline-start" /> Add a person hurt
          </Button>
          {people.length > 0 && (
            <label className="block space-y-1">
              Worst outcome
              <select
                aria-label="Worst outcome"
                className={select}
                value={outcome === "none" ? "first_aid" : outcome}
                onChange={(e) => setOutcome(e.target.value as HseIncidentOutcome)}
              >
                {hseIncidentOutcomes
                  .filter((o) => o !== "none")
                  .map((o) => (
                    <option key={o} value={o}>
                      {hseIncidentOutcomeLabels[o]}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="block space-y-1">
            Reason for the change
            <Input required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button disabled={busy}>Save people hurt</Button>
        </form>
      )}
    </section>
  );
}

/** Owned corrective actions: anyone with write adds; the owner or a manager completes; a manager cancels. */
export function IncidentActions({
  slug,
  incident: i,
  today,
}: {
  slug: string;
  incident: HseIncident;
  today: string;
}) {
  const router = useRouter();
  const { can, viewer, idx } = useWorkspace();
  const open = i.status === "open";
  const canWrite = can("hse_incidents", "write") && open;
  const isManager = can("hse_incidents", "manage");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>, done: string, after?: () => void) {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      after?.();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  const complete = (actionId: string, status: "done" | "cancelled") =>
    run(
      () =>
        unwrap(
          incidents()[":id"].actions[":actionId"].complete.$post({
            param: { slug, id: i.id, actionId },
            json: {
              commandId: newId(),
              expectedRevision: i.revision,
              status,
              note: (notes[actionId] ?? "").trim(),
            },
          }),
        ),
      status === "done" ? "Action done" : "Action cancelled",
    );
  return (
    <section className="space-y-3 rounded-lg border p-4 text-sm">
      <h2 className="font-medium">Corrective actions</h2>
      {i.actions.length === 0 && <p className="text-muted-foreground">No actions yet.</p>}
      {i.actions.map((a) => {
        const mine = a.ownerUserId === viewer.id;
        return (
          <div key={a.id} className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <span>{a.description}</span>
              <span className={a.state === "overdue" ? "text-destructive" : "text-muted-foreground"}>
                {a.ownerName ?? "—"} · due {a.dueOn} · {a.state}
              </span>
            </div>
            {a.completionNote && (
              <p className="text-muted-foreground">
                {a.completedByName ?? "—"}: {a.completionNote}
              </p>
            )}
            {open && a.status === "open" && (mine || isManager) && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="What was done"
                  className="max-w-md"
                  placeholder="What was done"
                  maxLength={2000}
                  value={notes[a.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                />
                <Button
                  size="sm"
                  disabled={busy || !(notes[a.id] ?? "").trim()}
                  onClick={() => void complete(a.id, "done")}
                >
                  Done
                </Button>
                {isManager && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !(notes[a.id] ?? "").trim()}
                    onClick={() => void complete(a.id, "cancelled")}
                  >
                    Cancel action
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {canWrite && (
        <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_12rem_10rem_auto] sm:items-end">
          <label className="space-y-1">
            New action
            <Input maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="space-y-1">
            Owner
            <select
              aria-label="Action owner"
              className={select}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            >
              <option value="">Choose…</option>
              {[...idx.boot.users]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="space-y-1">
            Due
            <Input type="date" min={today} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </label>
          <Button
            disabled={busy || !description.trim() || !owner || !dueOn}
            onClick={() =>
              void run(
                () =>
                  unwrap(
                    incidents()[":id"].actions.$post({
                      param: { slug, id: i.id },
                      json: {
                        commandId: newId(),
                        expectedRevision: i.revision,
                        description: description.trim(),
                        ownerUserId: owner,
                        dueOn,
                      },
                    }),
                  ),
                "Action added",
                () => {
                  setDescription("");
                  setOwner("");
                  setDueOn("");
                },
              )
            }
          >
            Add
          </Button>
        </div>
      )}
    </section>
  );
}

/** Report an incident in which nobody was hurt (HSE write). Only its reference comes back. */
export function ReportNearMissButton({ slug }: { slug: string }) {
  const { can } = useWorkspace();
  const today = useWorkspaceToday();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof hseReportableKinds)[number]>("near_miss");
  const [occurredOn, setOccurredOn] = useState(today);
  const [place, setPlace] = useState("");
  const [summary, setSummary] = useState("");
  const [immediate, setImmediate] = useState("");
  const [busy, setBusy] = useState(false);
  if (!can("hse", "write")) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await unwrap(
        browserApi().v1.workspaces[":slug"].hse.reports.$post({
          param: { slug },
          json: {
            commandId: newId(),
            kind,
            occurredOn,
            place: place.trim(),
            summary: summary.trim(),
            immediateActions: immediate.trim(),
          },
        }),
      );
      toast.success(`Reported as ${r.reference}. Thank you.`);
      setOpen(false);
      setPlace("");
      setSummary("");
      setImmediate("");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Report a near miss
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={(e) => void submit(e)} className="space-y-3 text-sm">
            <DialogHeader>
              <DialogTitle>Report a near miss or unsafe condition</DialogTitle>
              <DialogDescription>
                For incidents in which nobody was hurt. It goes to the people who investigate incidents. If
                someone was hurt, tell your manager or the HSE lead so they can record it.
              </DialogDescription>
            </DialogHeader>
            <label className="block space-y-1">
              What happened
              <select
                aria-label="Kind"
                className={select}
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                {hseReportableKinds.map((k) => (
                  <option key={k} value={k}>
                    {hseIncidentKindLabels[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              Date
              <Input
                type="date"
                required
                max={today}
                value={occurredOn}
                onChange={(e) => setOccurredOn(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              Where
              <Input required maxLength={500} value={place} onChange={(e) => setPlace(e.target.value)} />
            </label>
            <label className="block space-y-1">
              Description
              <Textarea
                required
                maxLength={3000}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              Immediate action
              <Textarea maxLength={4000} value={immediate} onChange={(e) => setImmediate(e.target.value)} />
            </label>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button disabled={busy}>Report</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
