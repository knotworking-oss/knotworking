"use client";

import { isWeakPin, STAFF_CSV_TEMPLATE, staffDisplayName, type StaffStatus } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
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
import { Tabs, TabsList, TabsTrigger } from "@knotworking/ui/components/tabs";
import { Archive, ArchiveRestore, FileUp, KeyRound, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { KioskPinBadge, StaffNumber, StaffStatusBadge } from "@/components/people-badges";
import type { JobRole, StaffMember } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { formatLongDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-store";
import { useWorkspaceTimeZone } from "@/lib/workspace-time";

type StatusFilter = StaffStatus | "all";
const NO_MEMBER = "__none__";
const people = () => browserApi().v1.workspaces[":slug"].people;

/** People → the staff register, job roles and kiosk PINs. */
export function PeopleManager({
  slug,
  staff,
  jobRoles,
}: {
  slug: string;
  staff: StaffMember[];
  jobRoles: JobRole[];
}) {
  const { can } = useWorkspace();
  const canWrite = can("people", "write");
  const canManage = can("people", "manage");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<StaffMember | "new" | null>(null);
  const [pinFor, setPinFor] = useState<StaffMember | null>(null);
  const [importing, setImporting] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return staff.filter(
      (s) =>
        (status === "all" || s.status === status) &&
        (!q ||
          [staffDisplayName(s), s.staffNumber, s.jobTitle, s.department, s.payrollReference]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(q))),
    );
  }, [staff, status, query]);
  const counts = {
    active: staff.filter((s) => s.status === "active").length,
    leaver: staff.filter((s) => s.status === "leaver").length,
  };

  return (
    <div className="workspace-content flex flex-col gap-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Staff</h2>
        {canWrite && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp data-icon="inline-start" /> Import CSV
            </Button>
            <Button onClick={() => setEditing("new")}>
              <Plus data-icon="inline-start" /> Add person
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <TabsList>
            <TabsTrigger value="active">Active ({counts.active})</TabsTrigger>
            <TabsTrigger value="leaver">Leavers ({counts.leaver})</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative min-w-48 flex-1 sm:max-w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search staff"
            placeholder="Name, number, department…"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {staff.length === 0 ? "No one in the staff register yet." : "No one matches."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Staff no.</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Job title</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Kiosk</TableHead>
                {status !== "active" && <TableHead>Status</TableHead>}
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4">
                    <StaffNumber value={s.staffNumber} />
                  </TableCell>
                  <TableCell>
                    {canWrite ? (
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => setEditing(s)}
                      >
                        {staffDisplayName(s)}
                      </button>
                    ) : (
                      <span className="font-medium">{staffDisplayName(s)}</span>
                    )}
                    {s.user && <span className="ml-2 text-xs text-muted-foreground">{s.user.email}</span>}
                    {can("training") && (
                      <Link
                        href={`/${slug}/training/staff/${s.id}`}
                        className="ml-2 text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        Training
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>{s.jobTitle ?? "—"}</TableCell>
                  <TableCell>{s.department ?? "—"}</TableCell>
                  <TableCell className="max-w-56 truncate">
                    {s.jobRoles.length ? s.jobRoles.map((r) => r.name).join(", ") : "—"}
                  </TableCell>
                  <TableCell>
                    <KioskPinBadge hasPin={s.hasPin} lockedUntil={s.pinLockedUntil as string | null} />
                  </TableCell>
                  {status !== "active" && (
                    <TableCell>
                      <StaffStatusBadge status={s.status} />
                      {s.endDate && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {formatLongDate(s.endDate)}
                        </span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="pr-4 text-right">
                    {canManage && s.status === "active" && (
                      <Button variant="outline" size="sm" onClick={() => setPinFor(s)}>
                        <KeyRound data-icon="inline-start" /> PIN
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <JobRoles slug={slug} jobRoles={jobRoles} canWrite={canWrite} />

      {editing && (
        <StaffDialog
          key={editing === "new" ? "new" : editing.id}
          slug={slug}
          person={editing === "new" ? null : editing}
          jobRoles={jobRoles}
          onClose={() => setEditing(null)}
        />
      )}
      {pinFor && <PinDialog key={pinFor.id} slug={slug} person={pinFor} onClose={() => setPinFor(null)} />}
      {importing && <StaffImportDialog slug={slug} onClose={() => setImporting(false)} />}
    </div>
  );
}

// ─── Import from CSV ─────────────────────────────────────────────────────────

const staffImportLabels = {
  staffNumber: "Staff number",
  firstName: "First name",
  lastName: "Last name",
  jobTitle: "Job title",
  department: "Department",
  jobRoles: "Job roles",
  startDate: "Start date",
  endDate: "End date",
  payrollReference: "Payroll reference",
  status: "Status",
};

/** Create and update staff from a CSV file, matched by staff number. Never PINs. */
function StaffImportDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  return (
    <CsvImportDialog
      id="staff-csv"
      title="Import staff from CSV"
      description="One row per person, matched by staff number. A staff number never changes through an import: a different number is a different person. Kiosk PINs are never imported."
      columns={
        <>
          Columns: <code>staff number</code> (6 digits; format the column as text so leading zeros stay);{" "}
          <code>first name</code> and <code>last name</code> for new people; optional <code>job title</code>,{" "}
          <code>department</code>, <code>job roles</code> (existing role names, separated by semicolons;
          replaces their roles), <code>start date</code> (2026-01-05 or 05/01/2026), <code>end date</code>,{" "}
          <code>payroll reference</code>, <code>status</code> (active or leaver). A column you leave out keeps
          what people have; an empty cell clears it.
        </>
      }
      template={STAFF_CSV_TEMPLATE}
      templateFileName="staff-template.csv"
      placeholder={"staff number,first name,last name,department\n100001,Ada,Lovelace,Production"}
      noun="person"
      keyLabel="Staff number"
      columnLabels={staffImportLabels}
      run={(csv, fileName, dryRun) =>
        unwrap(
          browserApi().v1.workspaces[":slug"].people.staff.import.$post({
            param: { slug },
            json: { csv, dryRun, ...(fileName ? { fileName } : {}) },
          }),
        )
      }
      onClose={onClose}
    />
  );
}

// ─── Add / edit a person ─────────────────────────────────────────────────────

function StaffDialog({
  slug,
  person,
  jobRoles,
  onClose,
}: {
  slug: string;
  person: StaffMember | null;
  jobRoles: JobRole[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { idx, can } = useWorkspace();
  // Linking a login decides whose hours "my times" shows: managers only.
  const canLink = can("people", "manage");
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState({
    staffNumber: person?.staffNumber ?? "",
    firstName: person?.firstName ?? "",
    lastName: person?.lastName ?? "",
    jobTitle: person?.jobTitle ?? "",
    department: person?.department ?? "",
    startDate: person?.startDate ?? "",
    endDate: person?.endDate ?? "",
    payrollReference: person?.payrollReference ?? "",
    userId: person?.userId ?? NO_MEMBER,
    leaver: person?.status === "leaver",
  });
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set(person?.jobRoles.map((r) => r.id) ?? []));
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const members = [...idx.users.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Archived roles stay listed only while the person still holds them.
  const roleChoices = jobRoles.filter((r) => r.status === "active" || roleIds.has(r.id));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    const json = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      jobTitle: form.jobTitle.trim() || null,
      department: form.department.trim() || null,
      startDate: form.startDate || null,
      payrollReference: form.payrollReference.trim() || null,
      jobRoleIds: [...roleIds],
    };
    const userId = form.userId === NO_MEMBER ? null : form.userId;
    const linkChanged = canLink && userId !== (person?.userId ?? null);
    const number = form.staffNumber.trim();
    try {
      if (person) {
        await unwrap(
          people().staff[":id"].$patch({
            param: { slug, id: person.id },
            json: {
              ...json,
              ...(linkChanged ? { userId } : {}),
              ...(number !== person.staffNumber ? { staffNumber: number } : {}),
              status: form.leaver ? "leaver" : "active",
              ...(form.leaver ? { endDate: form.endDate || null } : {}),
            },
          }),
        );
      } else {
        const created = await unwrap(
          people().staff.$post({
            param: { slug },
            json: { ...json, ...(linkChanged ? { userId } : {}), ...(number ? { staffNumber: number } : {}) },
          }),
        );
        toast.success(`${staffDisplayName(created)} added as staff number ${created.staffNumber}`);
      }
      if (person) toast.success(`${json.firstName} ${json.lastName} saved`);
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{person ? "Edit person" : "Add person"}</DialogTitle>
            <DialogDescription>
              {person
                ? "The kiosk PIN is set separately, with the PIN button."
                : "Leave the staff number blank to use the next free one. Numbers are never reused."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <div className="grid gap-4 sm:grid-cols-[9rem_1fr_1fr]">
              <Field>
                <FieldLabel htmlFor="staff-number">Staff no.</FieldLabel>
                <Input
                  id="staff-number"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder={person ? undefined : "Next free"}
                  required={Boolean(person)}
                  className="font-mono"
                  value={form.staffNumber}
                  onChange={(e) => setForm((f) => ({ ...f, staffNumber: e.target.value.replace(/\D/g, "") }))}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="staff-first">First name</FieldLabel>
                <Input
                  id="staff-first"
                  required
                  maxLength={100}
                  value={form.firstName}
                  onChange={set("firstName")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="staff-last">Last name</FieldLabel>
                <Input
                  id="staff-last"
                  required
                  maxLength={100}
                  value={form.lastName}
                  onChange={set("lastName")}
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="staff-title">Job title</FieldLabel>
                <Input id="staff-title" maxLength={200} value={form.jobTitle} onChange={set("jobTitle")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="staff-dept">Department</FieldLabel>
                <Input id="staff-dept" maxLength={200} value={form.department} onChange={set("department")} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="staff-start">Start date</FieldLabel>
                <Input id="staff-start" type="date" value={form.startDate} onChange={set("startDate")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="staff-payroll">Payroll reference</FieldLabel>
                <Input
                  id="staff-payroll"
                  maxLength={60}
                  value={form.payrollReference}
                  onChange={set("payrollReference")}
                />
                <FieldDescription>Only if the payroll package uses a different number.</FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel id="staff-member-label">Signs in as</FieldLabel>
              <Select
                disabled={!canLink}
                value={form.userId}
                onValueChange={(userId) => setForm((f) => ({ ...f, userId }))}
              >
                <SelectTrigger aria-labelledby="staff-member-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={NO_MEMBER}>No login</SelectItem>
                    {members.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Most shop-floor staff have no login.{!canLink && " Only managers can change this."}
              </FieldDescription>
            </Field>
            {roleChoices.length > 0 && (
              <Field>
                <FieldLabel>Job roles</FieldLabel>
                <div className="grid gap-2 sm:grid-cols-2">
                  {roleChoices.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={roleIds.has(r.id)}
                        onCheckedChange={(checked) =>
                          setRoleIds((ids) => {
                            const next = new Set(ids);
                            if (checked) next.add(r.id);
                            else next.delete(r.id);
                            return next;
                          })
                        }
                      />
                      {r.name}
                      {r.status === "archived" && (
                        <span className="text-xs text-muted-foreground">(archived)</span>
                      )}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            {person && (
              <div className="grid gap-4 rounded-lg border p-3 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.leaver}
                    onCheckedChange={(checked) => setForm((f) => ({ ...f, leaver: checked === true }))}
                  />
                  Has left
                </label>
                {form.leaver && (
                  <Field>
                    <FieldLabel htmlFor="staff-end">Last day</FieldLabel>
                    <Input id="staff-end" type="date" value={form.endDate} onChange={set("endDate")} />
                    <FieldDescription>Default today. Leavers can't use the kiosk.</FieldDescription>
                  </Field>
                )}
              </div>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {person ? "Save" : "Add person"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Kiosk PIN ───────────────────────────────────────────────────────────────

function PinDialog({ slug, person, onClose }: { slug: string; person: StaffMember; onClose: () => void }) {
  const timeZone = useWorkspaceTimeZone();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [chosen, setChosen] = useState("");
  /** The PIN just set: shown once, then gone for good. */
  const [revealed, setRevealed] = useState<string | null>(null);
  const name = staffDisplayName(person);
  const locked = Boolean(person.pinLockedUntil);
  const chosenWeak = chosen.length === 6 && isWeakPin(chosen, person.staffNumber);
  const api = () => people().staff[":id"];

  async function run(action: () => Promise<unknown>, done: string) {
    setPending(true);
    try {
      await action();
      toast.success(done);
      router.refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function setPin(pin?: string) {
    let result: { pin: string } | undefined;
    const ok = await run(async () => {
      result = await unwrap(api().pin.$put({ param: { slug, id: person.id }, json: pin ? { pin } : {} }));
    }, `New PIN set for ${name}`);
    if (ok && result) setRevealed(result.pin);
  }

  if (revealed) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>PIN for {name}</DialogTitle>
            <DialogDescription>
              Give this to {person.firstName} now. It won't be shown again; if it's lost, set a new one.
            </DialogDescription>
          </DialogHeader>
          <p
            className="py-4 text-center font-mono text-4xl tracking-[0.4em] tabular-nums"
            aria-label="New PIN"
          >
            {revealed}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            Staff number <StaffNumber value={person.staffNumber} />
          </p>
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kiosk PIN: {name}</DialogTitle>
          <DialogDescription>
            {person.hasPin
              ? `A PIN was set${person.pinSetAt ? ` ${formatLongDate(person.pinSetAt as string, timeZone)}` : ""}. Setting a new one replaces it.`
              : "No PIN yet: they can't clock in at the kiosk until one is set."}{" "}
            Your name and the time are recorded.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-4">
          {locked && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 p-3 text-sm">
              <span>Locked after too many wrong PINs.</span>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(
                    () => unwrap(api().unlock.$post({ param: { slug, id: person.id } })),
                    `${name} unlocked`,
                  ).then((ok) => ok && onClose())
                }
              >
                Unlock
              </Button>
            </div>
          )}
          <Button disabled={pending} onClick={() => setPin()}>
            {pending && <Spinner data-icon="inline-start" />}
            Generate a new PIN
          </Button>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (chosen.length === 6 && !chosenWeak) void setPin(chosen);
            }}
          >
            <Field>
              <FieldLabel htmlFor="pin-chosen">Or choose one</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="pin-chosen"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  className="font-mono tracking-widest"
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value.replace(/\D/g, ""))}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={pending || chosen.length !== 6 || chosenWeak}
                >
                  Set
                </Button>
              </div>
              <FieldDescription className={chosenWeak ? "text-destructive" : undefined}>
                {chosenWeak
                  ? "Too easy to guess: avoid repeats, runs and the staff number."
                  : "Six digits. Staff can change it themselves at the kiosk."}
              </FieldDescription>
            </Field>
          </form>
        </div>
        <DialogFooter className="sm:justify-between">
          {person.hasPin ? (
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={pending}
              onClick={() =>
                run(
                  () => unwrap(api().pin.$delete({ param: { slug, id: person.id } })),
                  `${name}'s PIN removed`,
                ).then((ok) => ok && onClose())
              }
            >
              Remove PIN
            </Button>
          ) : (
            <span />
          )}
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Job roles ───────────────────────────────────────────────────────────────

function JobRoles({ slug, jobRoles, canWrite }: { slug: string; jobRoles: JobRole[]; canWrite: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const shown = jobRoles.filter((r) => showArchived || r.status === "active");
  const archivedCount = jobRoles.length - jobRoles.filter((r) => r.status === "active").length;

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
      router.refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight">Job roles</h2>
      <Card className="py-0">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No job roles yet.</p>
        ) : (
          <ul className="divide-y">
            {shown.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className={r.status === "archived" ? "text-muted-foreground" : "font-medium"}>
                  {r.name}
                  {r.status === "archived" && " (archived)"}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-muted-foreground tabular-nums">
                    {r.staffCount} {r.staffCount === 1 ? "person" : "people"}
                  </span>
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={r.status === "active" ? `Archive ${r.name}` : `Restore ${r.name}`}
                      onClick={() =>
                        run(() =>
                          unwrap(
                            people()["job-roles"][":id"].$patch({
                              param: { slug, id: r.id },
                              json: { status: r.status === "active" ? "archived" : "active" },
                            }),
                          ),
                        )
                      }
                    >
                      {r.status === "active" ? <Archive /> : <ArchiveRestore />}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {canWrite ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              void run(() =>
                unwrap(people()["job-roles"].$post({ param: { slug }, json: { name: trimmed } })),
              ).then((ok) => ok && setName(""));
            }}
          >
            <Input
              aria-label="New job role"
              placeholder="New job role"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={pending || !name.trim()}>
              Add
            </Button>
          </form>
        ) : (
          <span />
        )}
        {archivedCount > 0 && (
          <Button variant="link" size="sm" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
          </Button>
        )}
      </div>
    </section>
  );
}
