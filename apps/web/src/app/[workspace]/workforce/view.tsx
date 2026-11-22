"use client";
import { absenceKindLabels, addDays, newId, type AbsenceKind } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useState, type FormEvent } from "react";
import type { getMyAbsences } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
type Mine = Awaited<ReturnType<typeof getMyAbsences>>;
const api = () => browserApi().v1.workspaces[":slug"].workforce;
const selectStyle = "h-9 rounded-md border border-input bg-background px-3 text-sm";
export function LeaveAndAvailability({
  slug,
  initial,
  today,
}: {
  slug: string;
  initial: Mine;
  today: string;
}) {
  const [mine, setMine] = useState(initial);
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState<AbsenceKind>("annual_leave");
  const [startOn, setStart] = useState(today);
  const [endOn, setEnd] = useState(today);
  const [ongoing, setOngoing] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [withdrawId, setWithdrawId] = useState("");
  const [reason, setReason] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 30));
  const [availabilityOffset, setAvailabilityOffset] = useState(0);
  const [availability, setAvailability] = useState<
    Array<{
      staffId: string;
      staffNumber: string;
      firstName: string;
      lastName: string;
      from: string;
      to: string;
    }>
  >([]);
  const [more, setMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sourceEnabled, setSourceEnabled] = useState(true);
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
    const data = await unwrap(api().me.$get({ param: { slug }, query: { offset: String(next) } }));
    setMine(data);
    setOffset(next);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        api().me.absences.$post({
          param: { slug },
          json: {
            commandId: newId(),
            kind,
            startOn,
            endOn: kind === "sickness" && ongoing ? null : endOn,
            staffNote: note,
          },
        }),
      );
      setNote("");
      await load(0);
    });
  }
  async function withdraw(e: FormEvent) {
    e.preventDefault();
    const row = mine.absences.find((a) => a.id === withdrawId);
    if (!row) return;
    await run(async () => {
      await unwrap(
        api().me.absences[":id"].withdraw.$post({
          param: { slug, id: row.id },
          json: { commandId: newId(), expectedRevision: row.revision, reason },
        }),
      );
      setWithdrawId("");
      setReason("");
      await load();
    });
  }
  async function search(next = 0) {
    await run(async () => {
      const result = await unwrap(
        api().availability.$get({ param: { slug }, query: { from, to, offset: String(next) } }),
      );
      setAvailability(result.availability);
      setAvailabilityOffset(next);
      setMore(result.hasMore);
      setLoaded(true);
      setSourceEnabled(result.sourceEnabled);
    });
  }
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 p-6">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <fieldset disabled={pending} className="contents">
        <Card className="gap-4 p-5">
          <h2 className="font-medium">My leave and sickness requests</h2>
          {!mine.enabled ? (
            <p className="text-sm text-muted-foreground">
              An administrator needs to enable private HR records before requests can be recorded.
            </p>
          ) : !mine.person ? (
            <p className="text-sm text-muted-foreground">
              Ask a People manager to link your sign-in to your active staff record before submitting a
              request.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                For {mine.person.firstName} {mine.person.lastName} · {mine.person.staffNumber}. These are
                whole-day date ranges. Allowances and pay are not calculated.
              </p>
              <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="absence-kind">Absence type</FieldLabel>
                  <select
                    id="absence-kind"
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
                  <FieldLabel htmlFor="absence-start">First absence day</FieldLabel>
                  <Input
                    id="absence-start"
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
                    <FieldLabel htmlFor="absence-end">Last absence day</FieldLabel>
                    <Input
                      id="absence-end"
                      type="date"
                      required
                      min={startOn}
                      value={endOn}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </Field>
                )}
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="absence-note">Note for HR (optional)</FieldLabel>
                  <Textarea
                    id="absence-note"
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
                <div>
                  <Button type="submit">{kind === "sickness" ? "Report sickness" : "Request leave"}</Button>
                </div>
              </form>
              <div className="border-t pt-4">
                <h3 className="font-medium">Records you submitted</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pending leave can be withdrawn. HR handles changes to approved leave and sickness records.
                </p>
                {mine.absences.length === 0 && (
                  <p className="mt-3 text-sm text-muted-foreground">No requests submitted.</p>
                )}
                {mine.absences.map((row) => (
                  <div
                    key={row.id}
                    className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {absenceKindLabels[row.kind]} · {row.state}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {row.startOn} to {row.endOn ?? "ongoing"}
                      </p>
                      {row.staffNote && <p className="mt-1 text-sm">{row.staffNote}</p>}
                    </div>
                    {row.state === "pending" && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setWithdrawId(row.id);
                          setReason("");
                        }}
                      >
                        Withdraw request
                      </Button>
                    )}
                  </div>
                ))}
                {withdrawId && (
                  <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={withdraw}>
                    <Field>
                      <FieldLabel htmlFor="withdraw-reason">Withdrawal reason</FieldLabel>
                      <Input
                        id="withdraw-reason"
                        required
                        maxLength={2000}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </Field>
                    <Button type="submit">Confirm withdrawal</Button>
                    <Button variant="outline" type="button" onClick={() => setWithdrawId("")}>
                      Keep request
                    </Button>
                  </form>
                )}
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    disabled={offset === 0}
                    onClick={() => void run(() => load(Math.max(0, offset - 50)))}
                  >
                    Previous requests
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!mine.hasMore}
                    onClick={() => void run(() => load(offset + 50))}
                  >
                    Next requests
                  </Button>
                  <Button variant="outline" onClick={() => void run(() => load())}>
                    Refresh requests
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
        <Card className="gap-4 p-5">
          <h2 className="font-medium">Availability for planning</h2>
          <p className="text-sm text-muted-foreground">
            Shows unavailable dates from approved leave and reported absence. Reasons, health details and HR
            notes are private. Pending leave is not included.
          </p>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Field>
              <FieldLabel htmlFor="availability-from">From</FieldLabel>
              <Input
                id="availability-from"
                type="date"
                required
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="availability-to">To</FieldLabel>
              <Input
                id="availability-to"
                type="date"
                required
                min={from}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Button type="submit">Show availability</Button>
          </form>
          {loaded && !sourceEnabled && (
            <p className="text-sm text-muted-foreground">
              Private absence records are switched off, so availability cannot be determined.
            </p>
          )}
          {loaded && sourceEnabled && availability.length === 0 && (
            <p className="text-sm text-muted-foreground">No unavailable dates recorded in this window.</p>
          )}
          <div className="overflow-x-auto">
            {availability.length > 0 && (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">Colleague</th>
                    <th className="p-2">From</th>
                    <th className="p-2">To</th>
                    <th className="p-2">Availability</th>
                  </tr>
                </thead>
                <tbody>
                  {availability.map((row) => (
                    <tr key={`${row.staffId}:${row.from}:${row.to}`} className="border-t">
                      <td className="p-2">
                        {row.firstName} {row.lastName} · {row.staffNumber}
                      </td>
                      <td className="p-2">{row.from}</td>
                      <td className="p-2">{row.to}</td>
                      <td className="p-2">Unavailable</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {loaded && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={availabilityOffset === 0}
                onClick={() => void search(Math.max(0, availabilityOffset - 100))}
              >
                Previous availability
              </Button>
              <Button
                variant="outline"
                disabled={!more}
                onClick={() => void search(availabilityOffset + 100)}
              >
                Next availability
              </Button>
            </div>
          )}
        </Card>
      </fieldset>
    </div>
  );
}
