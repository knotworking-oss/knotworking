"use client";
import {
  addDays,
  decimalHours,
  newId,
  payrollRunStateLabels,
  type PayrollRunSnapshot,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const api = () => browserApi().v1.workspaces[":slug"].workforce.hr["payroll-runs"];
type List = Awaited<ReturnType<typeof fetchList>>;
type Detail = Awaited<ReturnType<typeof fetchDetail>>;
type Adapter = List["adapters"][number];
const fetchList = (slug: string, offset = 0) =>
  unwrap(api().$get({ param: { slug }, query: { offset: String(offset) } }));
const fetchDetail = (slug: string, id: string) => unwrap(api()[":id"].$get({ param: { slug, id } }));
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
const hours = (m: number) => decimalHours(m).toLocaleString("en-GB");
const day = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const actionLabels: Record<string, string> = {
  prepared: "Prepared",
  approved: "Approved",
  exported: "Exported",
  superseded: "Superseded by a correction",
  correction_prepared: "Correction prepared",
  withdrawn: "Withdrawn",
  correction_withdrawn: "Correction withdrawn",
};

function download(fileName: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

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
const ErrorText = ({ error }: { error: string }) =>
  error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;

/** Snapshot tables: employees with hours and absence days, then agency workers. */
function SnapshotTables({ snapshot }: { snapshot: PayrollRunSnapshot }) {
  return (
    <div className="flex flex-col gap-4">
      {snapshot.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {snapshot.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-2">Employee</th>
              <th className="p-2">Payroll ref</th>
              <th className="p-2 text-right">Shifts</th>
              <th className="p-2 text-right">Basic h</th>
              <th className="p-2 text-right">Overtime h</th>
              <th className="p-2 text-right">Annual leave</th>
              <th className="p-2 text-right">Other leave</th>
              <th className="p-2 text-right">Sickness</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.employees.map((e) => (
              <tr key={e.staffId} className="border-t">
                <td className="p-2">
                  {e.firstName} {e.lastName} <span className="text-muted-foreground">({e.staffNumber})</span>
                </td>
                <td className="p-2">{e.payrollReference ?? "—"}</td>
                <td className="p-2 text-right tabular-nums">{e.shifts}</td>
                <td className="p-2 text-right tabular-nums">{hours(e.basicMinutes)}</td>
                <td className="p-2 text-right tabular-nums">{hours(e.overtimeMinutes)}</td>
                <td className="p-2 text-right tabular-nums">{e.absenceDays.annual_leave}</td>
                <td className="p-2 text-right tabular-nums">{e.absenceDays.other_leave}</td>
                <td className="p-2 text-right tabular-nums">{e.absenceDays.sickness}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {snapshot.employees.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">No employees with hours or absences.</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Absences are calendar days in the period. Your payroll package applies its own pay rules.
        </p>
      </div>
      {snapshot.agencyWorkers.length > 0 && (
        <div className="overflow-x-auto">
          <h4 className="text-sm font-medium">Agency workers (paid by their agency, not exported)</h4>
          <table className="mt-1 w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Worker</th>
                <th className="p-2">Agency</th>
                <th className="p-2 text-right">Shifts</th>
                <th className="p-2 text-right">Hours</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.agencyWorkers.map((a) => (
                <tr key={a.staffId} className="border-t">
                  <td className="p-2">
                    {a.firstName} {a.lastName}
                  </td>
                  <td className="p-2">
                    {a.agencyName}
                    {a.reference ? ` · ${a.reference}` : ""}
                  </td>
                  <td className="p-2 text-right tabular-nums">{a.shifts}</td>
                  <td className="p-2 text-right tabular-nums">{hours(a.basicMinutes + a.overtimeMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PayrollRuns({ slug, today }: { slug: string; today: string }) {
  const [list, setList] = useState<List | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(addDays(today, -1));
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof fetchPreview>> | null>(null);
  const { pending, error, run } = useRunner();
  const fetchPreview = (f: string, t: string) =>
    unwrap(api().preview.$get({ param: { slug }, query: { from: f, to: t } }));
  const [offset, setOffset] = useState(0);
  const reloadList = useCallback(async () => setList(await fetchList(slug, offset)), [slug, offset]);
  useEffect(() => {
    void run(reloadList);
    // Default to the last finished pay period from Attendance settings.
    void unwrap(
      browserApi().v1.workspaces[":slug"].attendance.payroll.$get({ param: { slug }, query: {} }),
    ).then(
      (p) => {
        setFrom(p.from);
        setTo(p.to);
      },
      () => {},
    );
  }, [run, reloadList, slug]);

  async function prepare(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const created = await unwrap(
        api().$post({ param: { slug }, json: { commandId: newId(), from, to, note } }),
      );
      setPreview(null);
      setNote("");
      await reloadList();
      setSelected(created.id);
    });
  }
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <Card className="gap-4 p-5">
        <h2 className="font-medium">Prepare a payroll run</h2>
        <p className="text-sm text-muted-foreground">
          A run freezes the period&apos;s paid hours from Attendance and absence days from Private HR records.
          Someone else approves it, and payroll files are built from the approved run. Knotworking doesn&apos;t
          calculate pay.
        </p>
        <form onSubmit={prepare} className="grid gap-3 sm:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="run-from">From</FieldLabel>
            <Input
              id="run-from"
              type="date"
              required
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="run-to">To</FieldLabel>
            <Input
              id="run-to"
              type="date"
              required
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="run-note">Note (optional)</FieldLabel>
            <Input id="run-note" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex gap-2 sm:col-span-4">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void run(async () => setPreview(await fetchPreview(from, to)))}
            >
              Preview
            </Button>
            <Button type="submit" disabled={pending || (preview?.blockers.length ?? 0) > 0}>
              Prepare run
            </Button>
          </div>
        </form>
        <ErrorText error={error} />
        {preview && (
          <div className="flex flex-col gap-3 border-t pt-3">
            {preview.blockers.length > 0 && (
              <ul className="list-disc pl-5 text-sm text-destructive">
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <SnapshotTables snapshot={preview.snapshot} />
          </div>
        )}
      </Card>

      <Card className="gap-3 p-5">
        <h2 className="font-medium">Runs</h2>
        {list && list.runs.length === 0 && (
          <p className="text-sm text-muted-foreground">No payroll runs yet.</p>
        )}
        {list && list.runs.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Period</th>
                <th className="p-2">Version</th>
                <th className="p-2">State</th>
                <th className="p-2 text-right">Employees</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {list.runs.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">
                    {day(r.from)} – {day(r.to)}
                  </td>
                  <td className="p-2">v{r.version}</td>
                  <td className="p-2">
                    <Badge variant={r.state === "approved" ? "default" : "secondary"}>
                      {payrollRunStateLabels[r.state]}
                    </Badge>
                  </td>
                  <td className="p-2 text-right tabular-nums">{r.employees}</td>
                  <td className="p-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setSelected(r.id)}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {list && (offset > 0 || list.hasMore) && (
        <div className="-mt-3 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Newer runs
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !list.hasMore}
            onClick={() => setOffset(offset + 50)}
          >
            Older runs
          </Button>
        </div>
      )}
      {selected && list && (
        <RunDetail
          key={selected}
          slug={slug}
          id={selected}
          adapters={list.adapters}
          onChanged={reloadList}
          onOpen={setSelected}
        />
      )}
    </div>
  );
}

function RunDetail({
  slug,
  id,
  adapters,
  onChanged,
  onOpen,
}: {
  slug: string;
  id: string;
  adapters: Adapter[];
  onChanged: () => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [adapterId, setAdapterId] = useState(adapters[0]?.id ?? "");
  const [acknowledge, setAcknowledge] = useState(false);
  const [exported, setExported] = useState<{
    fileName: string;
    fileHash: string;
    manualAbsences: {
      firstName: string;
      lastName: string;
      staffNumber: string;
      absenceDays: Record<string, number>;
    }[];
  } | null>(null);
  const { pending, error, run } = useRunner();
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    const next = await fetchDetail(slug, id);
    if (request === latest.current) setDetail(next);
  }, [slug, id]);
  useEffect(() => {
    void run(load);
  }, [run, load]);
  if (!detail) return <ErrorText error={error} />;
  const r = detail.run;
  const adapter = adapters.find((a) => a.id === adapterId);
  const unverified = adapter?.compatibility.status === "unverified";

  async function approve(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        api()[":id"].approve.$post({
          param: { slug, id },
          json: { commandId: newId(), expectedRevision: r.revision, note: text },
        }),
      );
      setText("");
      await load();
      await onChanged();
    });
  }
  async function correct() {
    const reason = window.prompt("Why does this run need correcting?");
    if (!reason) return;
    await run(async () => {
      const created = await unwrap(
        api()[":id"].correct.$post({
          param: { slug, id },
          json: { commandId: newId(), expectedRevision: r.revision, reason },
        }),
      );
      await onChanged();
      onOpen(created.id);
    });
  }
  async function withdraw() {
    const reason = window.prompt("Why is this run being withdrawn?");
    if (!reason) return;
    await run(async () => {
      await unwrap(
        api()[":id"].withdraw.$post({
          param: { slug, id },
          json: { commandId: newId(), expectedRevision: r.revision, reason },
        }),
      );
      await load();
      await onChanged();
    });
  }
  async function exportFile(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const file = await unwrap(
        api()[":id"].export.$post({
          param: { slug, id },
          json: { commandId: newId(), adapterId, acknowledgeUnverified: unverified && acknowledge },
        }),
      );
      download(file.fileName, file.csv);
      setExported(file);
      await load();
    });
  }
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">
          {day(r.from)} – {day(r.to)} · v{r.version}
        </h2>
        <Badge variant={r.state === "approved" ? "default" : "secondary"}>
          {payrollRunStateLabels[r.state]}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Prepared by {r.preparedByName ?? "a former member"}
        {r.approvedByName ? ` · approved by ${r.approvedByName}` : ""} · snapshot{" "}
        {r.snapshotHash.slice(0, 12)}
        {r.note ? ` · ${r.note}` : ""}
      </p>
      <ErrorText error={error} />
      <SnapshotTables snapshot={detail.snapshot} />

      {r.state === "prepared" && !detail.canApprove && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-sm text-muted-foreground">
          <span>
            Waiting for approval by someone who didn&apos;t prepare it and isn&apos;t included in it.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void withdraw()}
          >
            Withdraw run
          </Button>
        </div>
      )}
      {r.state === "prepared" && detail.canApprove && (
        <form onSubmit={approve} className="flex flex-col gap-3 border-t pt-4">
          <Field>
            <FieldLabel htmlFor="approve-note">Approval note</FieldLabel>
            <Input
              id="approve-note"
              required
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <FieldDescription>
              Someone other than the preparer approves, and not anyone included in the run.
            </FieldDescription>
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              Approve run
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => void withdraw()}>
              Withdraw run
            </Button>
          </div>
        </form>
      )}

      {r.state === "approved" && (
        <form onSubmit={exportFile} className="flex flex-col gap-3 border-t pt-4">
          <Field>
            <FieldLabel htmlFor="export-adapter">Export for</FieldLabel>
            <select
              id="export-adapter"
              className={selectClass}
              value={adapterId}
              onChange={(e) => setAdapterId(e.target.value)}
            >
              {adapters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.compatibility.status === "unverified" ? " (unverified)" : ""}
                </option>
              ))}
            </select>
            {adapter && <FieldDescription>{adapter.description}</FieldDescription>}
          </Field>
          {unverified && adapter?.compatibility.status === "unverified" && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={acknowledge}
                onChange={(e) => setAcknowledge(e.target.checked)}
              />
              <span>
                This layout hasn&apos;t been verified against the package&apos;s own import.{" "}
                {adapter.compatibility.checkBeforeUse} I understand, and this is recorded with the export.
              </span>
            </label>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || (unverified && !acknowledge)}>
              Download file
            </Button>
            {detail.pendingCorrectionId ? (
              <Button type="button" variant="outline" onClick={() => onOpen(detail.pendingCorrectionId!)}>
                Open the pending correction
              </Button>
            ) : (
              <Button type="button" variant="outline" disabled={pending} onClick={() => void correct()}>
                Prepare a correction
              </Button>
            )}
          </div>
          {exported && (
            <div className="text-sm">
              <p>
                Downloaded {exported.fileName} · SHA-256 {exported.fileHash.slice(0, 16)}…
              </p>
              {exported.manualAbsences.length > 0 && (
                <>
                  <p className="mt-2 font-medium">Enter these absences in the payroll package by hand:</p>
                  <ul className="text-muted-foreground">
                    {exported.manualAbsences.map((m) => (
                      <li key={m.staffNumber}>
                        {m.firstName} {m.lastName} ({m.staffNumber}): annual leave{" "}
                        {m.absenceDays.annual_leave}, other leave {m.absenceDays.other_leave}, sickness{" "}
                        {m.absenceDays.sickness} days
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </form>
      )}

      <div className="border-t pt-4">
        <h3 className="text-sm font-medium">History</h3>
        <ol className="mt-2 flex flex-col gap-2 text-sm">
          {detail.history.map((h) => (
            <li key={h.id}>
              {actionLabels[h.action] ?? h.action}
              {h.action === "exported" && typeof h.detail.fileName === "string"
                ? `: ${h.detail.fileName}`
                : ""}
              {h.detail.acknowledgedUnverified === true ? " (unverified layout acknowledged)" : ""}
              <span className="block text-xs text-muted-foreground">
                {h.actorName} · {new Date(h.createdAt).toLocaleString("en-GB")}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
