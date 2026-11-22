"use client";

import { shiftIssueLabels, staffDisplayName } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
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
import { Switch } from "@knotworking/ui/components/switch";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, Printer } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { StaffNumber } from "@/components/people-badges";
import { stackedTable } from "@/components/stacked-table";
import type { ShiftsReport, StaffMember, Visit } from "@/lib/api";
import { hoursAndMinutes, siteDateTime, siteTime } from "@/lib/attendance-format";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { AttendanceNav } from "../attendance-nav";

type Person = ShiftsReport["people"][number];
const shiftDays = (from: string, to: string, by: number) => {
  const shift = (d: string) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + by);
    return x.toISOString().slice(0, 10);
  };
  return { from: shift(from), to: shift(to) };
};

/** Attendance → Shifts: hours per person for a period, the events behind them, and fixing gaps. */
export function ShiftsView({
  slug,
  report,
  staff,
  visits,
  issuesOnly,
}: {
  slug: string;
  report: ShiftsReport;
  staff: StaffMember[];
  visits: Visit[];
  issuesOnly: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const [open, setOpen] = useState<Set<string>>(
    new Set(report.people.filter((p) => p.totals.issues).map((p) => p.staff.id)),
  );
  const [adding, setAdding] = useState<{ staffId?: string; kind?: "in" | "out"; at?: string } | null>(null);
  const [voiding, setVoiding] = useState<Person["events"][number] | null>(null);
  const tz = report.timeZone;
  const days = Math.round((Date.parse(report.to) - Date.parse(report.from)) / 86_400_000) + 1;

  const go = (next: { from: string; to: string; issues?: boolean }) => {
    const params = new URLSearchParams({ from: next.from, to: next.to });
    if (next.issues ?? issuesOnly) params.set("issues", "1");
    router.replace(`${pathname}?${params}`);
  };

  async function signOutVisit(id: string) {
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].attendance.visits[":id"]["sign-out"].$post({
          param: { slug, id },
        }),
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Shifts</h2>
        <Button onClick={() => setAdding({})}>
          <Plus data-icon="inline-start" /> Add missed clock event
        </Button>
      </div>
      <AttendanceNav slug={slug} />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Earlier"
          onClick={() => go(shiftDays(report.from, report.to, -days))}
        >
          <ChevronLeft />
        </Button>
        <Input
          type="date"
          aria-label="From"
          className="w-40"
          value={report.from}
          onChange={(e) =>
            e.target.value &&
            go({ from: e.target.value, to: report.to < e.target.value ? e.target.value : report.to })
          }
        />
        <span className="text-sm text-muted-foreground">to</span>
        <Input
          type="date"
          aria-label="To"
          className="w-40"
          value={report.to}
          min={report.from}
          onChange={(e) => e.target.value && go({ from: report.from, to: e.target.value })}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label="Later"
          onClick={() => go(shiftDays(report.from, report.to, days))}
        >
          <ChevronRight />
        </Button>
        <label className="ml-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={issuesOnly}
            onCheckedChange={(issues) => go({ from: report.from, to: report.to, issues })}
          />
          Only problems {report.issues > 0 && <Badge variant="destructive">{report.issues}</Badge>}
        </label>
      </div>

      {report.people.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No clock events in this period.
        </p>
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y">
            {report.people.map((p) => {
              const expanded = open.has(p.staff.id);
              return (
                <li key={p.staff.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-muted/40 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2"
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (expanded) next.delete(p.staff.id);
                        else next.add(p.staff.id);
                        return next;
                      })
                    }
                  >
                    <span className="flex items-center gap-2">
                      {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                      <span className="font-medium">{staffDisplayName(p.staff)}</span>
                      <span className="text-xs text-muted-foreground">
                        <StaffNumber value={p.staff.staffNumber} />
                      </span>
                      {p.totals.issues > 0 && (
                        <Badge variant="destructive">
                          {p.totals.issues} {p.totals.issues === 1 ? "problem" : "problems"}
                        </Badge>
                      )}
                    </span>
                    <span className="pl-6 text-sm text-muted-foreground tabular-nums sm:pl-0">
                      {p.totals.shifts} {p.totals.shifts === 1 ? "shift" : "shifts"} ·{" "}
                      <span className="font-medium text-foreground">
                        {hoursAndMinutes(p.totals.paidMinutes)}
                      </span>
                      {p.totals.overtimeMinutes > 0 &&
                        ` (${hoursAndMinutes(p.totals.overtimeMinutes)} overtime)`}
                    </span>
                  </button>
                  {expanded && (
                    <div className="flex flex-col gap-3 border-t bg-muted/20 px-4 py-3 text-sm max-md:px-0">
                      <table className={`w-full ${stackedTable}`}>
                        <thead className="text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="py-1 font-medium">Day</th>
                            <th className="font-medium">In</th>
                            <th className="font-medium">Out</th>
                            <th className="font-medium">Paid</th>
                            <th className="font-medium" />
                          </tr>
                        </thead>
                        <tbody>
                          {p.shifts.map((s, i) => (
                            <tr key={`${s.inEventId ?? s.outEventId}-${i}`}>
                              <td className="py-1" data-primary>
                                {formatLongDate(s.date)}
                              </td>
                              <td className="tabular-nums" data-label="In">
                                {siteTime(s.start, tz)}
                              </td>
                              <td className="tabular-nums" data-label="Out">
                                {s.open ? "On site" : siteTime(s.end, tz)}
                              </td>
                              <td className="tabular-nums" data-label="Paid">
                                {s.issue || s.open ? "—" : hoursAndMinutes(s.paidMinutes)}
                              </td>
                              <td className="text-right" data-actions>
                                {s.issue && (
                                  <span className="flex flex-wrap items-center justify-end gap-2">
                                    <Badge variant="destructive">{shiftIssueLabels[s.issue]}</Badge>
                                    {s.issue !== "too_long" && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          setAdding({
                                            staffId: p.staff.id,
                                            kind: s.issue === "missing_out" ? "out" : "in",
                                          })
                                        }
                                      >
                                        Add {s.issue === "missing_out" ? "clock-out" : "clock-in"}
                                      </Button>
                                    )}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <details className="max-md:px-4">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          Clock events ({p.events.length})
                        </summary>
                        <ul className="mt-2 flex flex-col gap-1">
                          {p.events.map((e) => (
                            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2">
                              <span className={e.voidedAt ? "text-muted-foreground line-through" : undefined}>
                                {e.kind === "in" ? "In" : "Out"} {siteDateTime(e.at, tz)} ·{" "}
                                {e.source === "kiosk"
                                  ? `kiosk${e.deviceName ? ` (${e.deviceName})` : ""}`
                                  : `added by ${e.recordedByName ?? "a manager"}: ${e.reason}`}
                                {e.offline && " · saved offline"}
                              </span>
                              {e.voidedAt ? (
                                <span className="text-xs text-muted-foreground">
                                  Voided by {e.voidedByName}: {e.voidReason}
                                </span>
                              ) : (
                                can("attendance", "manage") && (
                                  <Button size="sm" variant="ghost" onClick={() => setVoiding(e)}>
                                    Void
                                  </Button>
                                )
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {visits.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Visitors ({visits.length})</h3>
          <Card className="py-0">
            <ul className="divide-y text-sm">
              {visits.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <span>
                    <span className="font-medium">
                      {v.firstName} {v.lastName}
                    </span>
                    {(v.company || v.hostName) && (
                      <span className="text-muted-foreground">
                        {" · "}
                        {[v.company, v.hostName && `visiting ${v.hostName}`].filter(Boolean).join(" · ")}
                      </span>
                    )}
                    {v.hostMissing && (
                      <span className="text-xs text-muted-foreground">
                        {" · "}host had left when it was sent: check who they visited
                      </span>
                    )}
                    {v.siteRulesAcceptedAt && (
                      <span className="text-xs text-muted-foreground" title={v.siteRules ?? undefined}>
                        {" · "}site rules accepted
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    {siteDateTime(v.signedInAt, tz)} –{" "}
                    {v.signedOutAt ? siteTime(v.signedOutAt, tz) : "still signed in"}
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/${slug}/attendance/visits/${v.id}/print`}>
                        <Printer data-icon="inline-start" /> Pass
                      </Link>
                    </Button>
                    {!v.signedOutAt && (
                      <Button size="sm" variant="outline" onClick={() => signOutVisit(v.id)}>
                        Sign out
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {adding && (
        <AddEventDialog slug={slug} staff={staff} initial={adding} onClose={() => setAdding(null)} />
      )}
      {voiding && (
        <VoidEventDialog slug={slug} event={voiding} timeZone={tz} onClose={() => setVoiding(null)} />
      )}
    </div>
  );
}

function AddEventDialog({
  slug,
  staff,
  initial,
  onClose,
}: {
  slug: string;
  staff: StaffMember[];
  initial: { staffId?: string; kind?: "in" | "out" };
  onClose: () => void;
}) {
  const router = useRouter();
  const [staffId, setStaffId] = useState(initial.staffId ?? "");
  const [kind, setKind] = useState<"in" | "out">(initial.kind ?? "in");
  const [at, setAt] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const people = staff.filter((s) => s.status === "active" || s.id === initial.staffId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].attendance.events.$post({
          param: { slug },
          // `datetime-local` is the browser's local time: send it as an instant.
          json: { staffId, kind, at: new Date(at).toISOString(), reason: reason.trim() },
        }),
      );
      toast.success("Clock event added");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Add a missed clock event</DialogTitle>
            <DialogDescription>
              For when someone forgot to clock in or out. Your name, the time you added it and the reason are
              kept with it.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel id="add-staff-label">Person</FieldLabel>
              <Select value={staffId} onValueChange={setStaffId}>
                <SelectTrigger aria-labelledby="add-staff-label" className="w-full">
                  <SelectValue placeholder="Choose a person" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {people.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.staffNumber} · {staffDisplayName(s)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
              <Field>
                <FieldLabel id="add-kind-label">Clock</FieldLabel>
                <Select value={kind} onValueChange={(v) => setKind(v as "in" | "out")}>
                  <SelectTrigger aria-labelledby="add-kind-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="in">In</SelectItem>
                      <SelectItem value="out">Out</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="add-at">Date and time</FieldLabel>
                <Input
                  id="add-at"
                  type="datetime-local"
                  required
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="add-reason">Reason</FieldLabel>
              <Input
                id="add-reason"
                required
                maxLength={500}
                placeholder="e.g. Forgot to clock out; confirmed with supervisor"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !staffId || !at || !reason.trim()}>
              {pending && <Spinner data-icon="inline-start" />}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VoidEventDialog({
  slug,
  event,
  timeZone,
  onClose,
}: {
  slug: string;
  event: Person["events"][number];
  timeZone: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].attendance.events[":id"].void.$post({
          param: { slug, id: event.id },
          json: { reason: reason.trim() },
        }),
      );
      toast.success("Clock event voided");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Void clock event</DialogTitle>
            <DialogDescription>
              Clock {event.kind} at {siteDateTime(event.at, timeZone)}. It stays on the record, marked, and no
              longer counts. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="void-event-reason">Why</FieldLabel>
              <Input
                id="void-event-reason"
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending || !reason.trim()}>
              Void event
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
