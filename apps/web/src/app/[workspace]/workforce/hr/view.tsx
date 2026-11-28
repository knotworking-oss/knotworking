"use client";
import { absenceKindLabels, absenceStates, newId, type AbsenceKind } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useState, type FormEvent } from "react";
import type { getHrAbsences } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
type Listing = Awaited<ReturnType<typeof getHrAbsences>>;
type Row = Listing["absences"][number];
const api = () => browserApi().v1.workspaces[":slug"].workforce.hr;
const selectStyle = "h-9 rounded-md border border-input bg-background px-3 text-sm";
export function HrAbsences({
  slug,
  initial,
  canManage,
  today,
}: {
  slug: string;
  initial: Listing;
  canManage: boolean;
  today: string;
}) {
  const [listing, setListing] = useState(initial);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [staff, setStaff] = useState<
    Array<{ id: string; staffNumber: string; firstName: string; lastName: string; status: string }>
  >([]);
  const [q, setQ] = useState("");
  const [staffMore, setStaffMore] = useState(false);
  const [staffId, setStaffId] = useState("");
  const [kind, setKind] = useState<AbsenceKind>("annual_leave");
  const [startOn, setStart] = useState(today);
  const [endOn, setEnd] = useState(today);
  const [ongoing, setOngoing] = useState(false);
  const [staffNote, setStaffNote] = useState("");
  const [hrNote, setHrNote] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      revision: number;
      actorName: string;
      action: string;
      reason: string;
      snapshot: Record<string, unknown>;
      createdAt: string;
    }>
  >([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyMore, setHistoryMore] = useState(false);
  const [action, setAction] = useState<"approve" | "reject" | "record" | "cancel">("approve");
  const [reason, setReason] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [correctStart, setCorrectStart] = useState(today);
  const [correctEnd, setCorrectEnd] = useState(today);
  const [correctOngoing, setCorrectOngoing] = useState(false);
  const [correctReason, setCorrectReason] = useState("");
  async function run(fn: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }
  async function load(next = offset) {
    const result = await unwrap(
      api().absences.$get({
        param: { slug },
        query: { offset: String(next), ...(filter ? { state: filter as Row["state"] } : {}) },
      }),
    );
    setListing(result);
    setOffset(next);
  }
  async function searchStaff() {
    await run(async () => {
      const result = await unwrap(api().staff.$get({ param: { slug }, query: { q } }));
      setStaff(result.staff);
      setStaffMore(result.hasMore);
    });
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        api().absences.$post({
          param: { slug },
          json: {
            commandId: newId(),
            staffId,
            kind,
            startOn,
            endOn: kind === "sickness" && ongoing ? null : endOn,
            staffNote,
            hrNote,
          },
        }),
      );
      setStaffNote("");
      setHrNote("");
      await load(0);
    });
  }
  async function show(row: Row, next = 0) {
    const result = await unwrap(
      api().absences[":id"].history.$get({ param: { slug, id: row.id }, query: { offset: String(next) } }),
    );
    const current = { ...row, ...result.absence };
    setSelected(current);
    setHistory(result.events);
    setHistoryOffset(next);
    setHistoryMore(result.hasMore);
    setReason("");
    setCorrectReason("");
    setReviewNote(current.hrNote);
    setCorrectStart(current.startOn);
    setCorrectEnd(current.endOn ?? today);
    setCorrectOngoing(!current.endOn);
    setAction(current.state === "reported" ? "record" : current.state === "pending" ? "approve" : "cancel");
  }
  async function decide(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    await run(async () => {
      await unwrap(
        api().absences[":id"].decision.$post({
          param: { slug, id: selected.id },
          json: {
            commandId: newId(),
            expectedRevision: selected.revision,
            action,
            reason,
            hrNote: reviewNote,
          },
        }),
      );
      await show(selected);
      await load();
    });
  }
  async function correct(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    await run(async () => {
      await unwrap(
        api().absences[":id"].correct.$post({
          param: { slug, id: selected.id },
          json: {
            commandId: newId(),
            expectedRevision: selected.revision,
            startOn: correctStart,
            endOn: selected.kind === "sickness" && correctOngoing ? null : correctEnd,
            reason: correctReason,
            hrNote: reviewNote,
          },
        }),
      );
      await show(selected);
      await load();
    });
  }
  const active = selected && ["pending", "approved", "reported", "recorded"].includes(selected.state);
  return (
    <div className="workspace-content flex flex-col gap-5 py-6">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={pending} className="contents">
        {canManage && (
          <Card className="gap-4 p-5">
            <h2 className="font-medium">Record leave or sickness for a colleague</h2>
            <div className="flex flex-wrap items-end gap-3">
              <Field>
                <FieldLabel htmlFor="hr-staff-search">Find a staff member</FieldLabel>
                <Input id="hr-staff-search" value={q} onChange={(e) => setQ(e.target.value)} />
              </Field>
              <Button variant="outline" type="button" onClick={() => void searchStaff()}>
                Search staff
              </Button>
            </div>
            <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="hr-staff">Staff member</FieldLabel>
                <select
                  id="hr-staff"
                  className={selectStyle}
                  required
                  value={staffId}
                  onChange={(e) => setStaffId(e.target.value)}
                >
                  <option value="">Search and choose a colleague</option>
                  {staff.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.staffNumber} · {p.firstName} {p.lastName}
                      {p.status === "leaver" ? " (leaver)" : ""}
                    </option>
                  ))}
                </select>
                {staffMore && (
                  <p className="text-xs text-muted-foreground">First 100 matches. Narrow your search.</p>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="hr-kind">Absence type</FieldLabel>
                <select
                  id="hr-kind"
                  className={selectStyle}
                  value={kind}
                  onChange={(e) => {
                    const value = e.target.value as AbsenceKind;
                    setKind(value);
                    setOngoing(value === "sickness");
                  }}
                >
                  {Object.entries(absenceKindLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="hr-start">First absence day</FieldLabel>
                <Input
                  id="hr-start"
                  type="date"
                  required
                  value={startOn}
                  onChange={(e) => setStart(e.target.value)}
                />
              </Field>
              {kind === "sickness" && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={ongoing} onChange={(e) => setOngoing(e.target.checked)} />
                  Sickness is ongoing
                </label>
              )}
              {!(kind === "sickness" && ongoing) && (
                <Field>
                  <FieldLabel htmlFor="hr-end">Last absence day</FieldLabel>
                  <Input
                    id="hr-end"
                    type="date"
                    min={startOn}
                    required
                    value={endOn}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="hr-staff-note">Submission note (optional)</FieldLabel>
                <Textarea
                  id="hr-staff-note"
                  maxLength={2000}
                  value={staffNote}
                  onChange={(e) => setStaffNote(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="hr-private-note">Private HR note (optional)</FieldLabel>
                <Textarea
                  id="hr-private-note"
                  maxLength={4000}
                  value={hrNote}
                  onChange={(e) => setHrNote(e.target.value)}
                />
              </Field>
              <div>
                <Button type="submit">
                  {kind === "sickness" ? "Record sickness report" : "Record leave request"}
                </Button>
              </div>
            </form>
          </Card>
        )}
        <Card className="gap-4 p-5">
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="mr-auto font-medium">Absence records</h2>
            <Field>
              <FieldLabel htmlFor="hr-state">Status filter</FieldLabel>
              <select
                id="hr-state"
                className={selectStyle}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">All statuses</option>
                {absenceStates.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </Field>
            <Button variant="outline" onClick={() => void run(() => load(0))}>
              Apply filter
            </Button>
          </div>
          {listing.absences.length === 0 && (
            <p className="text-sm text-muted-foreground">No absence records.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-2">Colleague</th>
                  <th className="p-2">Type</th>
                  <th className="p-2">Dates</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Record</th>
                </tr>
              </thead>
              <tbody>
                {listing.absences.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-2">
                      {row.firstName} {row.lastName} · {row.staffNumber}
                    </td>
                    <td className="p-2">{absenceKindLabels[row.kind]}</td>
                    <td className="p-2">
                      {row.startOn} to {row.endOn ?? "ongoing"}
                    </td>
                    <td className="p-2">
                      {row.state}
                      {row.overlapNeedsReview && (
                        <p className="text-xs text-muted-foreground">Overlapping dates: HR review needed</p>
                      )}
                    </td>
                    <td className="p-2">
                      <Button variant="outline" size="sm" onClick={() => void run(() => show(row))}>
                        Review record
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() => void run(() => load(Math.max(0, offset - 50)))}
            >
              Previous records
            </Button>
            <Button
              variant="outline"
              disabled={!listing.hasMore}
              onClick={() => void run(() => load(offset + 50))}
            >
              Next records
            </Button>
          </div>
        </Card>
        {selected && (
          <Card className="gap-4 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="mr-auto font-medium">
                {selected.firstName} {selected.lastName}: {absenceKindLabels[selected.kind]} ·{" "}
                {selected.state}
              </h2>
              <Button variant="outline" onClick={() => void run(() => show(selected))}>
                Reload record
              </Button>
            </div>
            <p className="text-sm">
              {selected.startOn} to {selected.endOn ?? "ongoing"}
            </p>
            {selected.staffNote && (
              <p className="text-sm">
                <strong>Submission note:</strong> {selected.staffNote}
              </p>
            )}
            {selected.hrNote && (
              <p className="text-sm">
                <strong>Private HR note:</strong> {selected.hrNote}
              </p>
            )}
            {canManage && active && (
              <>
                <form onSubmit={decide} className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="hr-decision">Decision</FieldLabel>
                    <select
                      id="hr-decision"
                      className={selectStyle}
                      value={action}
                      onChange={(e) => setAction(e.target.value as typeof action)}
                    >
                      {selected.state === "pending" && (
                        <>
                          <option value="approve">Approve leave</option>
                          <option value="reject">Reject leave</option>
                        </>
                      )}
                      {selected.state === "reported" && (
                        <option value="record">Acknowledge sickness record</option>
                      )}
                      <option value="cancel">Cancel record</option>
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="hr-review-reason">Decision reason</FieldLabel>
                    <Input
                      id="hr-review-reason"
                      required
                      maxLength={2000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </Field>
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="hr-review-note">Private HR note</FieldLabel>
                    <Textarea
                      id="hr-review-note"
                      maxLength={4000}
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                    />
                  </Field>
                  <div>
                    <Button type="submit">Save decision</Button>
                  </div>
                </form>
                <form onSubmit={correct} className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                  <h3 className="font-medium sm:col-span-2">Correct dates or record the last sickness day</h3>
                  <Field>
                    <FieldLabel htmlFor="correct-start">Correct first day</FieldLabel>
                    <Input
                      id="correct-start"
                      type="date"
                      required
                      value={correctStart}
                      onChange={(e) => setCorrectStart(e.target.value)}
                    />
                  </Field>
                  {selected.kind === "sickness" && (
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={correctOngoing}
                        onChange={(e) => setCorrectOngoing(e.target.checked)}
                      />
                      Keep sickness ongoing
                    </label>
                  )}
                  {!(selected.kind === "sickness" && correctOngoing) && (
                    <Field>
                      <FieldLabel htmlFor="correct-end">Correct last day</FieldLabel>
                      <Input
                        id="correct-end"
                        type="date"
                        required
                        min={correctStart}
                        value={correctEnd}
                        onChange={(e) => setCorrectEnd(e.target.value)}
                      />
                    </Field>
                  )}
                  <Field>
                    <FieldLabel htmlFor="correct-reason">Correction reason</FieldLabel>
                    <Input
                      id="correct-reason"
                      required
                      maxLength={2000}
                      value={correctReason}
                      onChange={(e) => setCorrectReason(e.target.value)}
                    />
                  </Field>
                  <div className="self-end">
                    <Button type="submit" variant="outline">
                      Save corrected dates
                    </Button>
                  </div>
                </form>
              </>
            )}
            <div className="border-t pt-4">
              <h3 className="font-medium">Retained history</h3>
              {history.map((event) => (
                <div key={event.id} className="mt-3 border-t pt-3 text-sm">
                  <p>
                    Revision {event.revision}: {event.action} · {event.reason}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {event.actorName} · {new Date(event.createdAt).toLocaleString("en-GB")}
                  </p>
                  <p>
                    {String(event.snapshot.startOn ?? "")} to {String(event.snapshot.endOn ?? "ongoing")} ·{" "}
                    {String(event.snapshot.state ?? "")}
                  </p>
                  {typeof event.snapshot.hrNote === "string" && event.snapshot.hrNote && (
                    <p>Retained HR note: {event.snapshot.hrNote}</p>
                  )}
                </div>
              ))}
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  disabled={historyOffset === 0}
                  onClick={() => void run(() => show(selected, Math.max(0, historyOffset - 50)))}
                >
                  Previous history
                </Button>
                <Button
                  variant="outline"
                  disabled={!historyMore}
                  onClick={() => void run(() => show(selected, historyOffset + 50))}
                >
                  Next history
                </Button>
              </div>
            </div>
          </Card>
        )}
      </fieldset>
    </div>
  );
}
