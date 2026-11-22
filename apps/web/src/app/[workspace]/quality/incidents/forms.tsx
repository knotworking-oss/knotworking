"use client";
import {
  newId,
  incidentEventKinds,
  incidentEventSchema,
  incidentCreateSchema,
  type IncidentDetail,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useRouter } from "next/navigation";
import { useState, useId, cloneElement, type FormEvent, type ReactElement } from "react";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";

function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
const selectClass = "rounded-md border bg-background p-2 text-sm";
function LotChoice({ slug }: { slug: string }) {
  const [q, setQ] = useState("");
  const [lots, setLots] = useState<{ id: string; lotCode: string; item: { name: string } }[]>([]);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  async function search() {
    setError("");
    try {
      const result = await unwrap(
        browserApi().v1.workspaces[":slug"].stock.lots.$get({
          param: { slug },
          query: { q, includeEmpty: "true", order: "newest", limit: "50" },
        }),
      );
      setLots(result.lots);
      setMore(result.total > result.lots.length);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="grid gap-2">
      <Field label="Find the affected lot">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lot code" maxLength={200} />
      </Field>
      <Button type="button" variant="outline" onClick={search}>
        Find lots
      </Button>
      <Field label="Root lot">
        <select name="lot" className={selectClass} required>
          <option value="">Choose a lot</option>
          {lots.map((l) => (
            <option key={l.id} value={l.id}>
              {l.lotCode} · {l.item.name}
            </option>
          ))}
        </select>
      </Field>
      {more && (
        <p className="text-xs text-muted-foreground">Showing 50 results; refine the lot code to find more.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
function CapaChoice({ slug }: { slug: string }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ id: string; reference: string; title: string }[]>([]);
  const [error, setError] = useState("");
  async function search() {
    try {
      const result = await unwrap(
        browserApi().v1.workspaces[":slug"].quality.nonconformances.$get({
          param: { slug },
          query: { status: "closed", q, limit: "100" },
        }),
      );
      setRows(result.nonconformances);
      setError(
        result.total > result.nonconformances.length ? "Showing 100 results; refine your search." : "",
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="grid gap-2">
      <Field label="Find verified CAPA (optional)">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Reference or title" />
      </Field>
      <Button type="button" variant="outline" onClick={search}>
        Find verified CAPA
      </Button>
      <Field label="Verified CAPA">
        <select name="nc" className={selectClass}>
          <option value="">No CAPA linked — give a reason below</option>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.reference} · {r.title}
            </option>
          ))}
        </select>
      </Field>
      {error && <p className="text-sm text-muted-foreground">{error}</p>}
    </div>
  );
}
export function IncidentCreate({ slug }: { slug: string }) {
  const { can, viewer, idx } = useWorkspace();
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [commandId] = useState(newId);
  if (!can("quality", "write")) return null;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      const json = incidentCreateSchema.parse({
        commandId,
        title: f.get("title"),
        kind: f.get("kind"),
        severity: f.get("severity"),
        ownerUserId: f.get("owner"),
        assessment: f.get("assessment"),
      });
      const c = await unwrap(
        browserApi().v1.workspaces[":slug"].quality.incidents.$post({ param: { slug }, json }),
      );
      router.push(`/${slug}/quality/incidents/${c.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-md border p-4">
      <summary className="cursor-pointer font-medium">Open a live case</summary>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Case title">
          <Input name="title" required maxLength={200} />
        </Field>
        <Field label="Case type">
          <select className={selectClass} name="kind">
            <option>incident</option>
            <option>withdrawal</option>
            <option>recall</option>
          </select>
        </Field>
        <Field label="Severity">
          <select className={selectClass} name="severity">
            <option>major</option>
            <option>critical</option>
            <option>minor</option>
          </select>
        </Field>
        <Field label="Owner">
          <select className={selectClass} name="owner" defaultValue={viewer.id}>
            {[...idx.users.values()].map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Initial risk assessment">
          <Textarea name="assessment" required maxLength={8000} />
        </Field>
        <Button disabled={busy} className="self-end">
          Open case
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
export function IncidentForms({ slug, detail }: { slug: string; detail: IncidentDetail }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [action, setAction] = useState("event");
  const [kind, setKind] = useState("assessment");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [commandId, setCommand] = useState(newId);
  if (detail.status !== "open" || !can("quality", "write")) return null;
  const deliveries = [
    ...new Map(detail.snapshots.flatMap((s) => s.report.deliveries.lines).map((l) => [l.lineId, l])).values(),
  ];
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const api = browserApi().v1.workspaces[":slug"].quality.incidents[":id"];
    const param = { slug, id: detail.id };
    try {
      const note = text("note");
      if (action === "contain")
        await unwrap(
          api.contain.$post({
            param,
            json: {
              commandId,
              lotId: text("lot"),
              depth: Number(text("depth")),
              note,
              acknowledgePartial: f.has("partial"),
            },
          }),
        );
      else if (action === "release")
        await unwrap(api.release.$post({ param, json: { commandId, lotId: text("lot"), note } }));
      else if (action === "close")
        await unwrap(
          api.close.$post({
            param,
            json: {
              commandId,
              note,
              coverageReview: text("coverage"),
              reconciliation: text("reconciliation"),
              ...(text("nc") ? { nonconformanceId: text("nc") } : { noCapaReason: text("noCapa") }),
            },
          }),
        );
      else {
        const data = incidentEventSchema.parse({
          commandId,
          kind,
          note,
          party: text("party") || undefined,
          contact: text("contact") || undefined,
          contactStatus: text("contactStatus") || undefined,
          dueAt: text("due") ? new Date(text("due")).toISOString() : undefined,
          requirementSource: text("source") || undefined,
          deliveryLineId: text("delivery") || undefined,
          disposition: text("disposition") || undefined,
          quantity: text("quantity") ? Number(text("quantity")) : undefined,
          correctsEventId: text("corrects") || undefined,
        });
        await unwrap(api.events.$post({ param, json: data }));
      }
      setCommand(newId());
      form.reset();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-md border p-4">
      <h2 className="font-medium">Work this case</h2>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Action">
          <select
            className={selectClass}
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setCommand(newId());
              setError("");
            }}
          >
            <option value="event">Record evidence</option>
            {can("quality", "manage") && (
              <>
                <option value="contain">Snapshot distribution and hold lots</option>
                <option value="release">Release one case hold</option>
                <option value="close">Sign closure</option>
              </>
            )}
          </select>
        </Field>
        {action === "contain" && (
          <>
            <LotChoice slug={slug} />
            <Field label="Production depth">
              <Input type="number" name="depth" defaultValue={20} min={1} max={20} required />
            </Field>
            <label className="text-sm">
              <input type="checkbox" name="partial" /> I have reviewed and accept partial recorded trace
              coverage. Further investigation remains required.
            </label>
            <p className="text-sm text-muted-foreground">
              Refresh the same root after production changes. Every recorded affected lot will be held again,
              including previously released case holds.
            </p>
          </>
        )}
        {action === "release" && (
          <>
            <Field label="Held lot">
              <select name="lot" className={selectClass} required>
                <option value="">Choose a lot</option>
                {detail.holds
                  .filter((h) => !h.releasedAt)
                  .map((h) => (
                    <option key={h.lotId} value={h.lotId}>
                      {detail.snapshots.flatMap((s) => s.report.lots).find((l) => l.id === h.lotId)
                        ?.lotCode ?? h.lotId}
                    </option>
                  ))}
              </select>
            </Field>
            <p className="text-sm text-muted-foreground">
              Releases this case's hold only. Stock remains in QA quarantine until a separate stock release
              sign-off.
            </p>
          </>
        )}
        {action === "event" && (
          <>
            <Field label="Evidence type">
              <select
                className={selectClass}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setCommand(newId());
                }}
              >
                {incidentEventKinds.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </Field>
            {(kind === "contact" || kind === "recovery") && (
              <Field label="Delivery line">
                <select className={selectClass} name="delivery" required={kind === "recovery"}>
                  <option value="">General case contact</option>
                  {deliveries.map((l) => (
                    <option key={l.lineId} value={l.lineId}>
                      {l.reference} · {l.customerName} · {l.lotCode} · {l.amount.display}{" "}
                      {l.amount.displayUnit}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {kind === "contact" && (
              <>
                <Field label="Contact party">
                  <select className={selectClass} name="party">
                    <option>customer</option>
                    <option>regulator</option>
                    <option>certification</option>
                    <option>internal</option>
                  </select>
                </Field>
                <Field label="Contact recipient / channel">
                  <Input name="contact" required maxLength={1000} />
                </Field>
                <Field label="Contact status">
                  <select className={selectClass} name="contactStatus">
                    <option>planned</option>
                    <option>completed</option>
                  </select>
                </Field>
                <Field label="Deadline (your local time, optional)">
                  <Input type="datetime-local" name="due" />
                </Field>
                <Field label="Applicable deadline requirement / source">
                  <Input name="source" maxLength={2000} />
                </Field>
                <p className="text-sm text-muted-foreground">
                  This records the contact plan or evidence only. Send messages through your agreed incident
                  process.
                </p>
              </>
            )}
            {kind === "recovery" && (
              <>
                <Field label="Off-site disposition">
                  <select className={selectClass} name="disposition">
                    <option value="recovered_offsite">Recovered and held off site</option>
                    <option value="destroyed_offsite">Destroyed off site</option>
                    <option value="return_reported">Return reported (not yet received)</option>
                  </select>
                </Field>
                <Field label="Quantity in the delivery's displayed unit">
                  <Input name="quantity" type="number" required min="0.0001" step="any" />
                </Field>
                <p className="text-sm text-muted-foreground">
                  Mutually exclusive quantities; correct earlier evidence before changing disposition. These
                  records do not post stock. Receive physical returns through Despatch.
                </p>
              </>
            )}
            {kind === "correction" && (
              <Field label="Event being corrected">
                <select name="corrects" className={selectClass} required>
                  {detail.events
                    .filter(
                      (e) =>
                        !["correction", "containment", "hold_release"].includes(e.data.kind) &&
                        !detail.events.some((x) => x.data.correctsEventId === e.id),
                    )
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.data.kind}: {e.data.note.slice(0, 100)}
                      </option>
                    ))}
                </select>
              </Field>
            )}
          </>
        )}
        {action === "close" && (
          <>
            <Field label="Coverage and customer/regulator/certification contact review">
              <Textarea name="coverage" required maxLength={8000} />
            </Field>
            <Field label="Quantity reconciliation, outstanding goods and final disposition">
              <Textarea name="reconciliation" required maxLength={8000} />
            </Field>
            <CapaChoice slug={slug} />
            <Field label="If no CAPA: reason">
              <Textarea name="noCapa" maxLength={8000} />
            </Field>
            <p className="text-sm text-muted-foreground">
              A manager signs that containment, decisions, contact coverage and effectiveness have been
              reviewed. All case holds must first be released; QA quarantine remains separate.
            </p>
          </>
        )}
        <Field label={action === "close" ? "Closure decision and signature note" : "Evidence / reason"}>
          <Textarea name="note" required maxLength={8000} />
        </Field>
        <Button className="self-end" disabled={busy}>
          {" "}
          {busy ? "Saving…" : action === "close" ? "Sign and close case" : "Save case record"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
