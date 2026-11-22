"use client";
import {
  addDays,
  isoWeekday,
  newId,
  rotaSkipReasonLabels,
  weekdayLabel,
  weekdayNames,
  WEEKDAYS_MON_FRI,
  type RotaSkipReason,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { WeekdayPicker } from "../weekday-picker";

const wf = () => browserApi().v1.workspaces[":slug"].workforce;
const ws = () => browserApi().v1.workspaces[":slug"];
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
type Rota = Awaited<ReturnType<typeof fetchRota>>;
type Shift = Rota["shifts"][number];
type Person = { id: string; staffNumber: string; firstName: string; lastName: string };
type Option = { id: string; name: string };
const fetchRota = (slug: string, from: string, to: string) =>
  unwrap(wf().rota.$get({ param: { slug }, query: { from, to } }));
const name = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`;
const mondayOf = (date: string) => addDays(date, -isoWeekday(date));
const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

function useRunner() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (fn: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, run };
}
function ErrorText({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

export function RotaView({
  slug,
  today,
  canWrite,
  canManage,
  canReadProduction,
}: {
  slug: string;
  today: string;
  canWrite: boolean;
  canManage: boolean;
  canReadProduction: boolean;
}) {
  const [week, setWeek] = useState(mondayOf(today));
  const [rota, setRota] = useState<Rota | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [roles, setRoles] = useState<Option[]>([]);
  const { pending, error, run } = useRunner();
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));

  // Only the latest request may update the grid, so a slow earlier week can't overwrite it.
  const latest = useRef(0);
  const reload = useCallback(
    () =>
      run(async () => {
        const request = ++latest.current;
        const next = await fetchRota(slug, week, addDays(week, 6));
        if (request === latest.current) setRota(next);
      }),
    [run, slug, week],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!canWrite) return;
    void (async () => {
      try {
        const [staff, jobRoles] = await Promise.all([
          unwrap(ws().people.staff.$get({ param: { slug }, query: { limit: "500" } })),
          unwrap(ws().people["job-roles"].$get({ param: { slug }, query: {} })),
        ]);
        setPeople(staff.staff);
        setRoles(jobRoles.jobRoles.filter((r) => r.status === "active"));
      } catch {
        // People access is a dependency of Workforce; without it the forms stay empty.
      }
    })();
  }, [slug, canWrite]);

  async function cancel(entry: { id: string; revision: number }) {
    const reason = window.prompt("Why is this shift being removed from the rota?");
    if (!reason) return;
    await run(async () => {
      await unwrap(
        wf().rota.entries[":id"].cancel.$post({
          param: { slug, id: entry.id },
          json: { commandId: newId(), expectedRevision: entry.revision, reason },
        }),
      );
    });
    await reload();
  }

  const activeShifts = (rota?.shifts ?? []).filter(
    (s) => s.active || rota?.entries.some((e) => e.shiftId === s.id),
  );
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <MyShifts slug={slug} today={today} />
      <Card className="gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Week of {shortDate(week)}</h2>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setWeek(addDays(week, -7))}>
              Previous week
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setWeek(mondayOf(today))}>
              This week
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setWeek(addDays(week, 7))}>
              Next week
            </Button>
          </div>
        </div>
        <ErrorText error={error} />
        {rota && !rota.absenceSourceEnabled && (
          <p className="text-sm text-muted-foreground">
            Private HR records are off, so absences can&apos;t be shown here. Check availability separately.
          </p>
        )}
        {activeShifts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {canManage ? "Add a shift below to start a rota." : "No shifts have been set up yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] table-fixed text-left text-sm">
              <thead>
                <tr>
                  <th className="w-36 p-2">Shift</th>
                  {days.map((d, i) => (
                    <th key={d} className={`p-2 ${d === today ? "text-primary" : ""}`}>
                      {weekdayNames[i]} {shortDate(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeShifts.map((s) => (
                  <tr key={s.id} className="border-t align-top">
                    <td className="p-2">
                      <span className="font-medium">{s.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {s.startTime}–{s.endTime}
                        {s.lineName ? ` · ${s.lineName}` : ""}
                      </span>
                    </td>
                    {days.map((d) => (
                      <td key={d} className="p-1">
                        <div className="flex flex-col gap-1">
                          {rota!.entries
                            .filter((e) => e.shiftId === s.id && e.workDate === d)
                            .map((e) => (
                              <div key={e.id} className="rounded-md border px-2 py-1">
                                <div className="flex items-start justify-between gap-1">
                                  <span>{name(e.staff)}</span>
                                  {canWrite && (
                                    <button
                                      type="button"
                                      className="text-xs text-muted-foreground hover:text-destructive"
                                      aria-label={`Remove ${name(e.staff)} from ${s.name} on ${shortDate(d)}`}
                                      onClick={() => void cancel(e)}
                                    >
                                      ×
                                    </button>
                                  )}
                                </div>
                                {e.jobRole && (
                                  <span className="block text-xs text-muted-foreground">
                                    {e.jobRole.name}
                                  </span>
                                )}
                                <div className="mt-0.5 flex flex-wrap gap-1">
                                  {e.agency && <Badge variant="secondary">{e.agency.name}</Badge>}
                                  {e.unavailable && <Badge variant="destructive">Unavailable</Badge>}
                                </div>
                              </div>
                            ))}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {canWrite && rota && (
        <div className="grid gap-6 lg:grid-cols-2">
          <AddEntry
            slug={slug}
            shifts={rota.shifts.filter((s) => s.active)}
            people={people}
            roles={roles}
            defaultDate={week > today ? week : today}
            onSaved={reload}
          />
          <Generate slug={slug} from={week} people={people} shifts={rota.shifts} onSaved={reload} />
        </div>
      )}
      {rota && (
        <Patterns
          slug={slug}
          canWrite={canWrite}
          shifts={rota.shifts}
          people={people}
          roles={roles}
          today={today}
        />
      )}
      {rota && (
        <Shifts
          slug={slug}
          canManage={canManage}
          canReadProduction={canReadProduction}
          shifts={rota.shifts}
          onSaved={reload}
        />
      )}
      <Agencies slug={slug} canManage={canManage} people={people} today={today} />
    </div>
  );
}

function MyShifts({ slug, today }: { slug: string; today: string }) {
  const [mine, setMine] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  const load = useCallback(
    () => unwrap(wf().rota.me.$get({ param: { slug }, query: { from: today, to: addDays(today, 13) } })),
    [slug, today],
  );
  useEffect(() => {
    void load().then(setMine, () => setMine(null));
  }, [load]);
  if (!mine?.person) return null;
  const shiftById = new Map(mine.shifts.map((s) => [s.id, s]));
  return (
    <Card className="gap-3 p-5">
      <h2 className="font-medium">My shifts (next two weeks)</h2>
      {mine.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">You&apos;re not on the rota in the next two weeks.</p>
      ) : (
        <ul className="flex flex-wrap gap-2 text-sm">
          {mine.entries.map((e) => {
            const s = shiftById.get(e.shiftId);
            return (
              <li key={e.id} className="rounded-md border px-3 py-1.5">
                {weekdayNames[isoWeekday(e.workDate)]} {shortDate(e.workDate)} · {s?.name} {s?.startTime}–
                {s?.endTime}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function AddEntry({
  slug,
  shifts,
  people,
  roles,
  defaultDate,
  onSaved,
}: {
  slug: string;
  shifts: Shift[];
  people: Person[];
  roles: Option[];
  defaultDate: string;
  onSaved: () => Promise<void>;
}) {
  const [staffId, setStaffId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [workDate, setWorkDate] = useState(defaultDate);
  const [jobRoleId, setJobRoleId] = useState("");
  const [note, setNote] = useState("");
  const { pending, error, run } = useRunner();
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        wf().rota.entries.$post({
          param: { slug },
          json: { commandId: newId(), staffId, shiftId, workDate, jobRoleId: jobRoleId || null, note },
        }),
      );
      setNote("");
      await onSaved();
    });
  }
  return (
    <Card className="gap-4 p-5">
      <h2 className="font-medium">Add to rota</h2>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="rota-person">Person</FieldLabel>
          <select
            id="rota-person"
            required
            className={selectClass}
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
          >
            <option value="">Choose a person</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {name(p)} ({p.staffNumber})
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="rota-shift">Shift</FieldLabel>
          <select
            id="rota-shift"
            required
            className={selectClass}
            value={shiftId}
            onChange={(e) => setShiftId(e.target.value)}
          >
            <option value="">Choose a shift</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} {s.startTime}–{s.endTime}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="rota-date">Date</FieldLabel>
          <Input
            id="rota-date"
            type="date"
            required
            value={workDate}
            onChange={(e) => setWorkDate(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="rota-role">Covering role (optional)</FieldLabel>
          <select
            id="rota-role"
            className={selectClass}
            value={jobRoleId}
            onChange={(e) => setJobRoleId(e.target.value)}
          >
            <option value="">No specific role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="rota-note">Note (optional)</FieldLabel>
          <Input id="rota-note" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <ErrorText error={error} />
          <div>
            <Button type="submit" disabled={pending}>
              Add to rota
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

function Generate({
  slug,
  from,
  people,
  shifts,
  onSaved,
}: {
  slug: string;
  from: string;
  people: Person[];
  shifts: Shift[];
  onSaved: () => Promise<void>;
}) {
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(addDays(from, 13));
  const [result, setResult] = useState<{
    created: number;
    skippedCount: number;
    skipped: { staffId: string; shiftId: string; workDate: string; reason: RotaSkipReason }[];
  } | null>(null);
  const { pending, error, run } = useRunner();
  const personName = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? name(p) : "Someone";
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      setResult(
        await unwrap(
          wf().rota.generate.$post({ param: { slug }, json: { commandId: newId(), from: start, to: end } }),
        ),
      );
      await onSaved();
    });
  }
  return (
    <Card className="gap-4 p-5">
      <h2 className="font-medium">Generate from working patterns</h2>
      <p className="text-sm text-muted-foreground">
        Adds an entry for every day a working pattern covers. Nothing already on the rota is changed, and each
        day that can&apos;t be added is listed with the reason.
      </p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="gen-from">From</FieldLabel>
          <Input
            id="gen-from"
            type="date"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="gen-to">To</FieldLabel>
          <Input id="gen-to" type="date" required value={end} onChange={(e) => setEnd(e.target.value)} />
          <FieldDescription>Up to 62 days at a time.</FieldDescription>
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <ErrorText error={error} />
          <div>
            <Button type="submit" disabled={pending}>
              Generate rota
            </Button>
          </div>
        </div>
      </form>
      {result && (
        <div className="text-sm">
          <p>
            Added {result.created} {result.created === 1 ? "entry" : "entries"}
            {result.skippedCount ? `; ${result.skippedCount} skipped` : ""}.
          </p>
          {result.skipped.length > 0 && (
            <ul className="mt-2 max-h-48 overflow-y-auto text-muted-foreground">
              {result.skipped.map((s) => (
                <li key={`${s.staffId}:${s.shiftId}:${s.workDate}`}>
                  {shortDate(s.workDate)} · {personName(s.staffId)} ·{" "}
                  {shifts.find((x) => x.id === s.shiftId)?.name}: {rotaSkipReasonLabels[s.reason]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function Patterns({
  slug,
  canWrite,
  shifts,
  people,
  roles,
  today,
}: {
  slug: string;
  canWrite: boolean;
  shifts: Shift[];
  people: Person[];
  roles: Option[];
  today: string;
}) {
  const [list, setList] = useState<Awaited<ReturnType<typeof load>>["patterns"]>([]);
  const [staffId, setStaffId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [weekdays, setWeekdays] = useState(WEEKDAYS_MON_FRI);
  const [jobRoleId, setJobRoleId] = useState("");
  const [validFrom, setValidFrom] = useState(today);
  const [validTo, setValidTo] = useState("");
  const { pending, error, run } = useRunner();
  const load = useCallback(() => unwrap(wf().patterns.$get({ param: { slug }, query: {} })), [slug]);
  useEffect(() => {
    void load().then(
      (r) => setList(r.patterns),
      () => {},
    );
  }, [load]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        wf().patterns.$post({
          param: { slug },
          json: {
            commandId: newId(),
            staffId,
            shiftId,
            weekdays,
            jobRoleId: jobRoleId || null,
            validFrom,
            validTo: validTo || null,
          },
        }),
      );
      setList((await load()).patterns);
    });
  }
  async function end(p: (typeof list)[number]) {
    const date = window.prompt("Last day of this pattern (YYYY-MM-DD)", today);
    if (!date) return;
    const reason = window.prompt("Why is it ending?");
    if (!reason) return;
    await run(async () => {
      await unwrap(
        wf().patterns[":id"].end.$post({
          param: { slug, id: p.id },
          json: { commandId: newId(), expectedRevision: p.revision, validTo: date, reason },
        }),
      );
      setList((await load()).patterns);
    });
  }
  return (
    <Card className="gap-4 p-5">
      <h2 className="font-medium">Working patterns</h2>
      <ErrorText error={error} />
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No working patterns yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Person</th>
                <th className="p-2">Shift</th>
                <th className="p-2">Days</th>
                <th className="p-2">From</th>
                <th className="p-2">To</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="p-2">
                    {name(p.staff)}
                    {p.jobRoleName && (
                      <span className="block text-xs text-muted-foreground">{p.jobRoleName}</span>
                    )}
                  </td>
                  <td className="p-2">{p.shiftName}</td>
                  <td className="p-2">{weekdayLabel(p.weekdays)}</td>
                  <td className="p-2">{shortDate(p.validFrom)}</td>
                  <td className="p-2">{p.validTo ? shortDate(p.validTo) : "Ongoing"}</td>
                  <td className="p-2 text-right">
                    {canWrite && (!p.validTo || p.validTo >= today) && (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => void end(p)}>
                        End
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canWrite && (
        <form onSubmit={submit} className="grid gap-3 border-t pt-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="pattern-person">Person</FieldLabel>
            <select
              id="pattern-person"
              required
              className={selectClass}
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
            >
              <option value="">Choose a person</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {name(p)}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="pattern-shift">Shift</FieldLabel>
            <select
              id="pattern-shift"
              required
              className={selectClass}
              value={shiftId}
              onChange={(e) => setShiftId(e.target.value)}
            >
              <option value="">Choose a shift</option>
              {shifts
                .filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="pattern-role">Covering role (optional)</FieldLabel>
            <select
              id="pattern-role"
              className={selectClass}
              value={jobRoleId}
              onChange={(e) => setJobRoleId(e.target.value)}
            >
              <option value="">No specific role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field className="sm:col-span-3">
            <FieldLabel htmlFor="pattern-days">Days</FieldLabel>
            <WeekdayPicker id="pattern-days" value={weekdays} onChange={setWeekdays} />
          </Field>
          <Field>
            <FieldLabel htmlFor="pattern-from">From</FieldLabel>
            <Input
              id="pattern-from"
              type="date"
              required
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="pattern-to">To (optional)</FieldLabel>
            <Input id="pattern-to" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={pending || weekdays === 0}>
              Add pattern
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function Shifts({
  slug,
  canManage,
  canReadProduction,
  shifts,
  onSaved,
}: {
  slug: string;
  canManage: boolean;
  canReadProduction: boolean;
  shifts: Shift[];
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Shift | null>(null);
  const [form, setForm] = useState({
    name: "",
    startTime: "06:00",
    endTime: "14:00",
    lineId: "",
    active: true,
  });
  const [lines, setLines] = useState<Option[]>([]);
  const { pending, error, run } = useRunner();
  useEffect(() => {
    if (!canManage || !canReadProduction) return;
    void unwrap(ws().production.lines.$get({ param: { slug } })).then(
      (r) => setLines(r.lines.filter((l) => l.active).map((l) => ({ id: l.id, name: l.name }))),
      () => {},
    );
  }, [slug, canManage, canReadProduction]);
  function edit(s: Shift | null) {
    setEditing(s);
    setForm(
      s
        ? {
            name: s.name,
            startTime: s.startTime,
            endTime: s.endTime,
            lineId: s.lineId ?? "",
            active: s.active,
          }
        : { name: "", startTime: "06:00", endTime: "14:00", lineId: "", active: true },
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const body = {
        name: form.name,
        startTime: form.startTime,
        endTime: form.endTime,
        lineId: form.lineId || null,
      };
      if (editing)
        await unwrap(
          wf().shifts[":id"].$patch({
            param: { slug, id: editing.id },
            json: { commandId: newId(), expectedRevision: editing.revision, ...body, active: form.active },
          }),
        );
      else await unwrap(wf().shifts.$post({ param: { slug }, json: { commandId: newId(), ...body } }));
      edit(null);
      await onSaved();
    });
  }
  return (
    <Card className="gap-4 p-5">
      <h2 className="font-medium">Shifts</h2>
      <ErrorText error={error} />
      <ul className="flex flex-col gap-1 text-sm">
        {shifts.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 border-t py-2">
            <span>
              {s.name} · {s.startTime}–{s.endTime}
              {s.lineName ? ` · ${s.lineName}` : ""}{" "}
              {!s.active && <Badge variant="secondary">Inactive</Badge>}
            </span>
            {canManage && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => edit(s)}>
                Edit
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <form onSubmit={submit} className="grid gap-3 border-t pt-4 sm:grid-cols-4">
          <h3 className="text-sm font-medium sm:col-span-4">
            {editing ? `Edit ${editing.name}` : "Add a shift"}
          </h3>
          <Field>
            <FieldLabel htmlFor="shift-name">Name</FieldLabel>
            <Input
              id="shift-name"
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="shift-start">Starts</FieldLabel>
            <Input
              id="shift-start"
              type="time"
              required
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="shift-end">Ends</FieldLabel>
            <Input
              id="shift-end"
              type="time"
              required
              value={form.endTime}
              onChange={(e) => setForm({ ...form, endTime: e.target.value })}
            />
            <FieldDescription>An end before the start finishes the next day.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="shift-line">Production line (optional)</FieldLabel>
            <select
              id="shift-line"
              className={selectClass}
              value={form.lineId}
              onChange={(e) => setForm({ ...form, lineId: e.target.value })}
            >
              <option value="">None</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              Active
            </label>
          )}
          <div className="flex gap-2 sm:col-span-4">
            <Button type="submit" disabled={pending}>
              {editing ? "Save shift" : "Add shift"}
            </Button>
            {editing && (
              <Button type="button" variant="outline" onClick={() => edit(null)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

function Agencies({
  slug,
  canManage,
  people,
  today,
}: {
  slug: string;
  canManage: boolean;
  people: Person[];
  today: string;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  const [agencyName, setAgencyName] = useState("");
  const [contact, setContact] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [startOn, setStartOn] = useState(today);
  const [endOn, setEndOn] = useState("");
  const [reference, setReference] = useState("");
  const { pending, error, run } = useRunner();
  const load = useCallback(() => unwrap(wf().agencies.$get({ param: { slug } })), [slug]);
  useEffect(() => {
    void load().then(setData, () => {});
  }, [load]);
  async function addAgency(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        wf().agencies.$post({ param: { slug }, json: { commandId: newId(), name: agencyName, contact } }),
      );
      setAgencyName("");
      setContact("");
      setData(await load());
    });
  }
  async function addEngagement(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        wf()["agency-engagements"].$post({
          param: { slug },
          json: { commandId: newId(), agencyId, staffId, startOn, endOn: endOn || null, reference },
        }),
      );
      setReference("");
      setData(await load());
    });
  }
  async function endEngagement(row: { id: string; revision: number }) {
    const date = window.prompt("Last day of this engagement (YYYY-MM-DD)", today);
    if (!date) return;
    const reason = window.prompt("Why is it ending?");
    if (!reason) return;
    await run(async () => {
      await unwrap(
        wf()["agency-engagements"][":id"].end.$post({
          param: { slug, id: row.id },
          json: { commandId: newId(), expectedRevision: row.revision, endOn: date, reason },
        }),
      );
      setData(await load());
    });
  }
  const agencyName_ = (id: string) => data?.agencies.find((a) => a.id === id)?.name ?? "";
  return (
    <Card className="gap-4 p-5">
      <h2 className="font-medium">Agency workers</h2>
      <p className="text-sm text-muted-foreground">
        Agency workers are People records, so training and kiosk clocking work for them as usual. An
        engagement records which agency supplies them and when.
      </p>
      <ErrorText error={error} />
      {data && data.engagements.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Worker</th>
                <th className="p-2">Agency</th>
                <th className="p-2">Reference</th>
                <th className="p-2">From</th>
                <th className="p-2">To</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {data.engagements.map((g) => (
                <tr key={g.id} className="border-t">
                  <td className="p-2">{name(g.staff)}</td>
                  <td className="p-2">{agencyName_(g.agencyId)}</td>
                  <td className="p-2">{g.reference || "—"}</td>
                  <td className="p-2">{shortDate(g.startOn)}</td>
                  <td className="p-2">{g.endOn ? shortDate(g.endOn) : "Ongoing"}</td>
                  <td className="p-2 text-right">
                    {canManage && (!g.endOn || g.endOn >= today) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => void endEngagement(g)}
                      >
                        End
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.agencies.length === 0 && (
        <p className="text-sm text-muted-foreground">No agencies yet.</p>
      )}
      {canManage && (
        <div className="grid gap-6 border-t pt-4 lg:grid-cols-2">
          <form onSubmit={addAgency} className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Add an agency</h3>
            <Field>
              <FieldLabel htmlFor="agency-name">Name</FieldLabel>
              <Input
                id="agency-name"
                required
                maxLength={120}
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agency-contact">Contact (optional)</FieldLabel>
              <Input
                id="agency-contact"
                maxLength={500}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </Field>
            <div>
              <Button type="submit" disabled={pending}>
                Add agency
              </Button>
            </div>
          </form>
          <form onSubmit={addEngagement} className="grid gap-3 sm:grid-cols-2">
            <h3 className="text-sm font-medium sm:col-span-2">Record an agency worker</h3>
            <Field>
              <FieldLabel htmlFor="engage-agency">Agency</FieldLabel>
              <select
                id="engage-agency"
                required
                className={selectClass}
                value={agencyId}
                onChange={(e) => setAgencyId(e.target.value)}
              >
                <option value="">Choose an agency</option>
                {data?.agencies
                  .filter((a) => a.active)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="engage-person">Worker (People record)</FieldLabel>
              <select
                id="engage-person"
                required
                className={selectClass}
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              >
                <option value="">Choose a person</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {name(p)}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="engage-from">From</FieldLabel>
              <Input
                id="engage-from"
                type="date"
                required
                value={startOn}
                onChange={(e) => setStartOn(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="engage-to">To (optional)</FieldLabel>
              <Input id="engage-to" type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} />
            </Field>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="engage-ref">Agency reference (optional)</FieldLabel>
              <Input
                id="engage-ref"
                maxLength={200}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={pending}>
                Record engagement
              </Button>
            </div>
          </form>
        </div>
      )}
    </Card>
  );
}
