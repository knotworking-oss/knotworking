"use client";
import {
  addDays,
  ALL_WEEKDAYS,
  isoWeekday,
  newId,
  staffingAppliesWhen,
  staffingAppliesWhenLabels,
  staffingGapReasonLabels,
  weekdayLabel,
  weekdayNames,
  type StaffingAppliesWhen,
  type StaffingGapReason,
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
type Check = Awaited<ReturnType<typeof fetchCheck>>;
type Requirements = Awaited<ReturnType<typeof fetchRequirements>>["requirements"];
type Requirement = Requirements[number];
type Option = { id: string; name: string };
const fetchCheck = (slug: string, from: string, to: string) =>
  unwrap(wf().staffing.$get({ param: { slug }, query: { from, to } }));
const fetchRequirements = (slug: string) => unwrap(wf().staffing.requirements.$get({ param: { slug } }));
const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const notApplied: Record<string, string> = {
  no_production_planned: "No production planned on the line",
  non_working_day: "Non-working day for the line",
  production_unavailable: "Production planning isn't available, so this can't be checked",
  training_unavailable: "Training isn't available, so this can't be checked",
};

export function StaffingView({
  slug,
  today,
  canManage,
  canReadTraining,
}: {
  slug: string;
  today: string;
  canManage: boolean;
  canReadTraining: boolean;
}) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 6));
  const [shortOnly, setShortOnly] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [requirements, setRequirements] = useState<Requirements>([]);
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
  // Only the latest request may update the view, so a slow earlier check can't overwrite it.
  const latest = useRef(0);
  const refresh = useCallback(
    () =>
      run(async () => {
        const request = ++latest.current;
        const [c, r] = await Promise.all([fetchCheck(slug, from, to), fetchRequirements(slug)]);
        if (request !== latest.current) return;
        setCheck(c);
        setRequirements(r.requirements);
      }),
    [run, slug, from, to],
  );
  useEffect(() => {
    void refresh();
    // First load only; later checks run when the form is submitted.
  }, []);

  const personName = (slot: Check["shifts"][number], staffId: string) => {
    const p = slot.people.find((x) => x.staff.id === staffId);
    return p ? `${p.staff.firstName} ${p.staff.lastName}` : "Someone";
  };
  const slots = (check?.shifts ?? []).filter(
    (s) => !shortOnly || s.requirements.some((r) => r.applies && r.shortfall > 0),
  );
  return (
    <div className="workspace-content flex flex-col gap-6 py-6">
      <Card className="gap-4 p-5">
        <h2 className="font-medium">Staffing check</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void refresh();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <Field>
            <FieldLabel htmlFor="staffing-from">From</FieldLabel>
            <Input
              id="staffing-from"
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="staffing-to">To</FieldLabel>
            <Input id="staffing-to" type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button type="submit" disabled={pending}>
            Check staffing
          </Button>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={shortOnly} onChange={(e) => setShortOnly(e.target.checked)} />
            Only shifts with a shortfall
          </label>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {check && (
          <>
            <p className="text-sm">
              {check.summary.shortfalls === 0 ? (
                <span>No shortfalls in {check.summary.requirementsChecked} requirement checks.</span>
              ) : (
                <span className="text-destructive">
                  {check.summary.shortfalls}{" "}
                  {check.summary.shortfalls === 1 ? "shift requirement is" : "shift requirements are"} short
                  by {check.summary.unfilledPositions}{" "}
                  {check.summary.unfilledPositions === 1 ? "person" : "people"}.
                </span>
              )}
            </p>
            {!check.absenceSourceEnabled && (
              <p className="text-sm text-muted-foreground">
                Private HR records are off, so absences aren&apos;t taken into account.
              </p>
            )}
            {!check.trainingSourceEnabled && (
              <p className="text-sm text-muted-foreground">
                Training is off, so training requirements can&apos;t be checked.
              </p>
            )}
          </>
        )}
      </Card>

      {slots.map((slot) => (
        <Card key={`${slot.date}:${slot.shift.id}`} className="gap-3 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium">
              {weekdayNames[isoWeekday(slot.date)]} {shortDate(slot.date)} · {slot.shift.name}{" "}
              {slot.shift.startTime}–{slot.shift.endTime}
            </h3>
            {slot.production && (
              <span className="text-sm text-muted-foreground">
                {slot.production.nonWorkingDay
                  ? "Non-working day"
                  : slot.production.planned === null
                    ? ""
                    : `${slot.production.planned} ${slot.production.planned === 1 ? "batch" : "batches"} planned`}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Rostered:{" "}
            {slot.people.length
              ? slot.people
                  .map(
                    (p) => `${p.staff.firstName} ${p.staff.lastName}${p.agency ? ` (${p.agency.name})` : ""}`,
                  )
                  .join(", ")
              : "nobody"}
          </p>
          {slot.requirements.length === 0 && (
            <p className="text-sm text-muted-foreground">No requirements for this shift.</p>
          )}
          {slot.requirements.map((r) => (
            <div key={r.requirementId} className="border-t pt-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.name}</span>
                {r.applies === true ? (
                  r.shortfall > 0 ? (
                    <Badge variant="destructive">
                      {r.counted.length} of {r.headcount} · short by {r.shortfall}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">
                      {r.counted.length} of {r.headcount} · covered
                    </Badge>
                  )
                ) : (
                  <span className="text-muted-foreground">
                    {notApplied[r.reason ?? ""] ?? "Doesn't apply"}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {[r.jobRole?.name, ...(r.courses ?? []).map((c) => `${c.code} ${c.title}`)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {r.applies === true && r.counted.length > 0 && (
                <p className="mt-1">Counts: {r.counted.map((id) => personName(slot, id)).join(", ")}</p>
              )}
              {r.applies === true && r.excluded.length > 0 && (
                <ul className="mt-1 text-muted-foreground">
                  {r.excluded.map((x) => (
                    <li key={x.staffId}>
                      {personName(slot, x.staffId)}:{" "}
                      {x.reasons
                        .map((reason) => {
                          const label =
                            staffingGapReasonLabels[reason.reason as StaffingGapReason] ?? reason.reason;
                          const course = r.courses?.find((c) => c.id === reason.courseId);
                          const until = reason.expiresOn ? ` (${shortDate(reason.expiresOn)})` : "";
                          return course ? `${label}: ${course.code}${until}` : label;
                        })
                        .join("; ")}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </Card>
      ))}
      {check && slots.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {shortOnly
            ? "No shortfalls in this window."
            : "Nothing is rostered and no requirements apply in this window."}
        </p>
      )}

      <RequirementsPanel
        slug={slug}
        today={today}
        canManage={canManage}
        canReadTraining={canReadTraining}
        requirements={requirements}
        onSaved={refresh}
      />
    </div>
  );
}

function RequirementsPanel({
  slug,
  today,
  canManage,
  canReadTraining,
  requirements,
  onSaved,
}: {
  slug: string;
  today: string;
  canManage: boolean;
  canReadTraining: boolean;
  requirements: Requirements;
  onSaved: () => Promise<void>;
}) {
  const blank = {
    shiftId: "",
    name: "",
    headcount: 1,
    jobRoleId: "",
    courseIds: [] as string[],
    weekdays: ALL_WEEKDAYS,
    appliesWhen: "always" as StaffingAppliesWhen,
    validFrom: today,
    validTo: "",
    active: true,
  };
  const [editing, setEditing] = useState<Requirement | null>(null);
  const [form, setForm] = useState(blank);
  const [shifts, setShifts] = useState<(Option & { lineId: string | null })[]>([]);
  const [roles, setRoles] = useState<Option[]>([]);
  const [courses, setCourses] = useState<(Option & { code: string })[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!canManage) return;
    void (async () => {
      try {
        const [s, r] = await Promise.all([
          unwrap(wf().shifts.$get({ param: { slug } })),
          unwrap(ws().people["job-roles"].$get({ param: { slug }, query: {} })),
        ]);
        setShifts(
          s.shifts.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, lineId: x.lineId })),
        );
        setRoles(r.jobRoles.filter((x) => x.status === "active"));
        if (canReadTraining) {
          const c = await unwrap(ws().training.courses.$get({ param: { slug }, query: {} }));
          setCourses(
            c.courses
              .filter((x) => x.status === "active")
              .map((x) => ({ id: x.id, name: x.title, code: x.code })),
          );
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, [slug, canManage, canReadTraining]);
  function edit(r: Requirement | null) {
    setEditing(r);
    setForm(
      r
        ? {
            shiftId: r.shiftId,
            name: r.name,
            headcount: r.headcount,
            jobRoleId: r.jobRoleId ?? "",
            courseIds: r.courseIds,
            weekdays: r.weekdays,
            appliesWhen: r.appliesWhen,
            validFrom: r.validFrom,
            validTo: r.validTo ?? "",
            active: r.active,
          }
        : blank,
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError("");
    try {
      const body = {
        shiftId: form.shiftId,
        name: form.name,
        headcount: form.headcount,
        jobRoleId: form.jobRoleId || null,
        courseIds: form.courseIds,
        weekdays: form.weekdays,
        appliesWhen: form.appliesWhen,
        validFrom: form.validFrom,
        validTo: form.validTo || null,
      };
      if (editing)
        await unwrap(
          wf().staffing.requirements[":id"].$patch({
            param: { slug, id: editing.id },
            json: { commandId: newId(), expectedRevision: editing.revision, ...body, active: form.active },
          }),
        );
      else
        await unwrap(
          wf().staffing.requirements.$post({ param: { slug }, json: { commandId: newId(), ...body } }),
        );
      edit(null);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  const selectedShift = shifts.find((s) => s.id === form.shiftId);
  return (
    <Card className="gap-4 p-5">
      <h2 className="font-medium">Staffing requirements</h2>
      {requirements.length === 0 ? (
        <p className="text-sm text-muted-foreground">No requirements yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Shift</th>
                <th className="p-2">Requirement</th>
                <th className="p-2">Needs</th>
                <th className="p-2">When</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {requirements.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="p-2">{r.shiftName}</td>
                  <td className="p-2">
                    {r.name} {!r.active && <Badge variant="secondary">Inactive</Badge>}
                  </td>
                  <td className="p-2">
                    {r.headcount} ×{" "}
                    {[
                      r.jobRoleName,
                      ...(r.courses
                        ? r.courses.map((c) => (c.active ? c.code : `${c.code} (archived)`))
                        : r.courseIds.length
                          ? [
                              `${r.courseIds.length} training ${r.courseIds.length === 1 ? "course" : "courses"}`,
                            ]
                          : []),
                    ]
                      .filter(Boolean)
                      .join(" + ")}
                  </td>
                  <td className="p-2">
                    {weekdayLabel(r.weekdays)}
                    {r.appliesWhen === "production_planned" && (
                      <span className="block text-xs text-muted-foreground">When production is planned</span>
                    )}
                  </td>
                  <td className="p-2 text-right">
                    {canManage && (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => edit(r)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && (
        <form onSubmit={submit} className="grid gap-3 border-t pt-4 sm:grid-cols-3">
          <h3 className="text-sm font-medium sm:col-span-3">
            {editing ? `Edit ${editing.name}` : "Add a requirement"}
          </h3>
          <Field>
            <FieldLabel htmlFor="req-shift">Shift</FieldLabel>
            <select
              id="req-shift"
              required
              className={selectClass}
              value={form.shiftId}
              onChange={(e) => setForm({ ...form, shiftId: e.target.value })}
            >
              <option value="">Choose a shift</option>
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="req-name">Name</FieldLabel>
            <Input
              id="req-name"
              required
              maxLength={120}
              value={form.name}
              placeholder="Allergen-trained operatives"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="req-headcount">People needed</FieldLabel>
            <Input
              id="req-headcount"
              type="number"
              min={1}
              max={500}
              required
              value={form.headcount}
              onChange={(e) => setForm({ ...form, headcount: Number(e.target.value) })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="req-role">Job role (optional)</FieldLabel>
            <select
              id="req-role"
              className={selectClass}
              value={form.jobRoleId}
              onChange={(e) => setForm({ ...form, jobRoleId: e.target.value })}
            >
              <option value="">Any role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="req-courses">Training required (optional)</FieldLabel>
            {canReadTraining ? (
              <div id="req-courses" role="group" className="flex max-h-32 flex-wrap gap-3 overflow-y-auto">
                {[
                  ...courses,
                  // Courses already on the requirement but since archived: listed so they can be removed.
                  ...(editing?.courses ?? [])
                    .filter((c) => form.courseIds.includes(c.id) && !courses.some((x) => x.id === c.id))
                    .map((c) => ({ id: c.id, code: c.code, name: `${c.title} (archived)` })),
                ].map((c) => (
                  <label key={c.id} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={form.courseIds.includes(c.id)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          courseIds: e.target.checked
                            ? [...form.courseIds, c.id]
                            : form.courseIds.filter((x) => x !== c.id),
                        })
                      }
                    />
                    {c.code} {c.name}
                  </label>
                ))}
              </div>
            ) : (
              <FieldDescription>
                {form.courseIds.length
                  ? `Keeps its ${form.courseIds.length} required training ${form.courseIds.length === 1 ? "course" : "courses"}. `
                  : ""}
                You need Training access to change courses.
              </FieldDescription>
            )}
          </Field>
          <Field className="sm:col-span-3">
            <FieldLabel htmlFor="req-days">Days</FieldLabel>
            <WeekdayPicker
              id="req-days"
              value={form.weekdays}
              onChange={(weekdays) => setForm({ ...form, weekdays })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="req-when">Applies</FieldLabel>
            <select
              id="req-when"
              className={selectClass}
              value={form.appliesWhen}
              onChange={(e) => setForm({ ...form, appliesWhen: e.target.value as StaffingAppliesWhen })}
            >
              {staffingAppliesWhen.map((w) => (
                <option
                  key={w}
                  value={w}
                  disabled={w === "production_planned" && !!selectedShift && !selectedShift.lineId}
                >
                  {staffingAppliesWhenLabels[w]}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="req-from">From</FieldLabel>
            <Input
              id="req-from"
              type="date"
              required
              value={form.validFrom}
              onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="req-to">To (optional)</FieldLabel>
            <Input
              id="req-to"
              type="date"
              value={form.validTo}
              onChange={(e) => setForm({ ...form, validTo: e.target.value })}
            />
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
          <div className="flex flex-col gap-2 sm:col-span-3">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={pending || form.weekdays === 0 || (!form.jobRoleId && form.courseIds.length === 0)}
              >
                {editing ? "Save requirement" : "Add requirement"}
              </Button>
              {editing && (
                <Button type="button" variant="outline" onClick={() => edit(null)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </form>
      )}
    </Card>
  );
}
