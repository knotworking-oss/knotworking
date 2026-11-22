"use client";

import {
  defenceControlKindLabels,
  defenceControlKinds,
  formatUkDate,
  type DefenceCheckOutcome,
  type DefenceControlKind,
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
import { RadioGroup, RadioGroupItem } from "@knotworking/ui/components/radio-group";
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
import { Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DefenceDueBadge } from "@/components/defence-badges";
import type { DefenceCheckRow, DefenceControlRow } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceToday } from "@/lib/workspace-time";
import { DefenceFrame } from "../defence-nav";

const defenceApi = () => browserApi().v1.workspaces[":slug"].defence;

/** Food defence → controls and checks: the check schedule, what's overdue and failures to resolve. */
export function ControlsBoard({
  slug,
  controls,
  checks,
  status,
}: {
  slug: string;
  controls: DefenceControlRow[];
  checks: DefenceCheckRow[];
  status: "active" | "all";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("defence", "write");
  const [dialog, setDialog] = useState<
    | { kind: "new" }
    | { kind: "edit"; control: DefenceControlRow }
    | { kind: "check"; control: DefenceControlRow }
    | { kind: "resolve"; check: DefenceCheckRow }
    | null
  >(null);
  const open = checks.filter((c) => c.outcome === "fail" && !c.resolvedAt);
  return (
    <DefenceFrame
      slug={slug}
      title="Controls and checks"
      actions={
        <>
          <Button
            variant={status === "all" ? "secondary" : "outline"}
            aria-pressed={status === "all"}
            onClick={() => router.replace(status === "all" ? pathname : `${pathname}?status=all`)}
          >
            Include archived
          </Button>
          {canWrite && (
            <Button onClick={() => setDialog({ kind: "new" })}>
              <Plus data-icon="inline-start" /> New control
            </Button>
          )}
        </>
      }
    >
      {controls.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No security controls yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Control</TableHead>
                <TableHead>Every</TableHead>
                <TableHead>Last checked</TableHead>
                <TableHead>Next due</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {controls.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium">
                      {c.name}
                      {c.status === "archived" && (
                        <Badge variant="secondary" className="ml-2">
                          Archived
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {defenceControlKindLabels[c.kind]}
                      {c.area ? ` · ${c.area}` : ""}
                      {c.openFailures > 0 && (
                        <span className="text-destructive"> · {c.openFailures} open failure</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{c.frequencyDays === 1 ? "Daily" : `${c.frequencyDays} days`}</TableCell>
                  <TableCell>{c.lastCheckedOn ? formatUkDate(c.lastCheckedOn) : "Never"}</TableCell>
                  <TableCell>{c.dueOn ? formatUkDate(c.dueOn) : "—"}</TableCell>
                  <TableCell>
                    {c.status === "active" ? <DefenceDueBadge status={c.dueStatus} /> : "—"}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {canWrite && (
                      <div className="flex justify-end gap-2">
                        {c.status === "active" && (
                          <Button size="sm" onClick={() => setDialog({ kind: "check", control: c })}>
                            Record check
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: "edit", control: c })}
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

      <Card>
        <CardHeader>
          <CardTitle>Failed checks to resolve</CardTitle>
        </CardHeader>
        <CardContent>
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground">No failed checks are open.</p>
          ) : (
            <ul className="flex flex-col gap-3 text-sm">
              {open.map((f) => (
                <li key={f.id} className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <span className="font-medium">{f.controlName}</span>{" "}
                    <span className="text-muted-foreground">
                      · {formatUkDate(f.checkedOn)} · {f.checkedByName ?? "someone"}
                    </span>
                    <div>{f.notes}</div>
                    {f.actionTaken && (
                      <div className="text-muted-foreground">Action taken: {f.actionTaken}</div>
                    )}
                  </div>
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDialog({ kind: "resolve", check: f })}
                    >
                      Resolve
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-x-auto">
        <CardHeader>
          <CardTitle>Recent checks</CardTitle>
        </CardHeader>
        <CardContent>
          {checks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No checks recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Control</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{formatUkDate(c.checkedOn)}</TableCell>
                    <TableCell>{c.controlName}</TableCell>
                    <TableCell>
                      {c.outcome === "pass" ? (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-label-green-bg text-label-green"
                        >
                          Pass
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-label-red-bg text-label-red"
                        >
                          Fail{c.resolvedAt ? " · resolved" : ""}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{c.checkedByName ?? "—"}</TableCell>
                    <TableCell className="max-w-sm text-sm whitespace-normal text-muted-foreground">
                      {c.notes}
                      {c.resolution ? ` · Resolved: ${c.resolution}` : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {(dialog?.kind === "new" || dialog?.kind === "edit") && (
        <ControlDialog
          slug={slug}
          control={dialog.kind === "edit" ? dialog.control : null}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "check" && (
        <CheckDialog slug={slug} control={dialog.control} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "resolve" && (
        <ResolveDialog slug={slug} check={dialog.check} onClose={() => setDialog(null)} />
      )}
    </DefenceFrame>
  );
}

function useSubmit(onClose: () => void) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return {
    pending,
    submit: async (fn: () => Promise<unknown>, done: string) => {
      setPending(true);
      try {
        await fn();
        toast.success(done);
        onClose();
        router.refresh();
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setPending(false);
      }
    },
  };
}

function ControlDialog({
  slug,
  control,
  onClose,
}: {
  slug: string;
  control: DefenceControlRow | null;
  onClose: () => void;
}) {
  const { pending, submit } = useSubmit(onClose);
  const [name, setName] = useState(control?.name ?? "");
  const [kind, setKind] = useState<DefenceControlKind>(control?.kind ?? "access");
  const [area, setArea] = useState(control?.area ?? "");
  const [frequency, setFrequency] = useState(String(control?.frequencyDays ?? 7));
  const [instructions, setInstructions] = useState(control?.instructions ?? "");
  function save(e: FormEvent) {
    e.preventDefault();
    const json = {
      name: name.trim(),
      kind,
      area: area.trim() || null,
      frequencyDays: Number(frequency),
      instructions: instructions.trim() || null,
    };
    void submit(
      () =>
        unwrap(
          control
            ? defenceApi().controls[":id"].$patch({ param: { slug, id: control.id }, json })
            : defenceApi().controls.$post({ param: { slug }, json }),
        ),
      control ? "Control saved" : "Control added",
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save}>
          <DialogHeader>
            <DialogTitle>{control ? "Edit control" : "New security control"}</DialogTitle>
            <DialogDescription>What is checked, where, and how often.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="ctl-name">Name</FieldLabel>
              <Input
                id="ctl-name"
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Kind</FieldLabel>
                <Select value={kind} onValueChange={(v) => setKind(v as DefenceControlKind)}>
                  <SelectTrigger aria-label="Kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {defenceControlKinds.map((k) => (
                        <SelectItem key={k} value={k}>
                          {defenceControlKindLabels[k]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="ctl-frequency">Check every (days)</FieldLabel>
                <Input
                  id="ctl-frequency"
                  type="number"
                  required
                  min={1}
                  max={730}
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="ctl-area">Area</FieldLabel>
              <Input id="ctl-area" maxLength={200} value={area} onChange={(e) => setArea(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="ctl-instructions">What to check</FieldLabel>
              <Textarea
                id="ctl-instructions"
                maxLength={4000}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            {control && (
              <Button
                type="button"
                variant="outline"
                className="mr-auto"
                disabled={pending}
                onClick={() =>
                  void submit(
                    () =>
                      unwrap(
                        defenceApi().controls[":id"].$patch({
                          param: { slug, id: control.id },
                          json: { status: control.status === "active" ? "archived" : "active" },
                        }),
                      ),
                    control.status === "active" ? "Archived" : "Restored",
                  )
                }
              >
                {control.status === "active" ? "Archive" : "Restore"}
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CheckDialog({
  slug,
  control,
  onClose,
}: {
  slug: string;
  control: DefenceControlRow;
  onClose: () => void;
}) {
  const today = useWorkspaceToday();
  const { pending, submit } = useSubmit(onClose);
  const [checkedOn, setCheckedOn] = useState(today);
  const [outcome, setOutcome] = useState<DefenceCheckOutcome>("pass");
  const [notes, setNotes] = useState("");
  const [actionTaken, setActionTaken] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              () =>
                unwrap(
                  defenceApi().controls[":id"].checks.$post({
                    param: { slug, id: control.id },
                    json: {
                      checkedOn,
                      outcome,
                      notes: notes.trim() || null,
                      actionTaken: actionTaken.trim() || null,
                    },
                  }),
                ),
              "Check recorded",
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Record check: {control.name}</DialogTitle>
            <DialogDescription>{control.instructions ?? "Recorded in your name."}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="chk-date">Checked on</FieldLabel>
              <Input
                id="chk-date"
                type="date"
                required
                max={today}
                value={checkedOn}
                onChange={(e) => setCheckedOn(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Outcome</FieldLabel>
              <RadioGroup
                value={outcome}
                onValueChange={(v) => setOutcome(v as DefenceCheckOutcome)}
                className="flex gap-6"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="pass" /> Pass
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="fail" /> Fail
                </label>
              </RadioGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="chk-notes">{outcome === "fail" ? "What was wrong" : "Notes"}</FieldLabel>
              <Textarea
                id="chk-notes"
                required={outcome === "fail"}
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
            {outcome === "fail" && (
              <Field>
                <FieldLabel htmlFor="chk-action">Action taken</FieldLabel>
                <Textarea
                  id="chk-action"
                  maxLength={2000}
                  value={actionTaken}
                  onChange={(e) => setActionTaken(e.target.value)}
                />
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Record check
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({
  slug,
  check,
  onClose,
}: {
  slug: string;
  check: DefenceCheckRow;
  onClose: () => void;
}) {
  const { pending, submit } = useSubmit(onClose);
  const [resolution, setResolution] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              () =>
                unwrap(
                  defenceApi().checks[":id"].resolve.$post({
                    param: { slug, id: check.id },
                    json: { resolution: resolution.trim() },
                  }),
                ),
              "Failure resolved",
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Resolve failed check</DialogTitle>
            <DialogDescription>
              {check.controlName}, {formatUkDate(check.checkedOn)}: {check.notes}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="res-text">How it was put right</FieldLabel>
              <Textarea
                id="res-text"
                required
                maxLength={2000}
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />} Resolve
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
