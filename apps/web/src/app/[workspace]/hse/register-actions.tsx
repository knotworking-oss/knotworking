"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { newId, hseEntrySchema } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useWorkspace } from "@/lib/workspace-store";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import type { HseRecord, HseEntryRow } from "@/lib/api";
import { RecordAttachments } from "@/components/record-attachments";
export function RegisterActions({ slug, record: r }: { slug: string; record: HseRecord }) {
  const { can } = useWorkspace(),
    router = useRouter();
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [attempt, setAttempt] = useState<{ op: string; reason: string; id: string } | null>(null);
  async function act(op: "approve" | "review" | "archive") {
    setBusy(true);
    setError("");
    const commandId = attempt?.op === op && attempt.reason === reason ? attempt.id : newId();
    setAttempt({ op, reason, id: commandId });
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].hse.registers[":id"][op].$post({
          param: { slug, id: r.id },
          json: { commandId, expectedRevision: r.revision, reason },
        }),
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 print:hidden">
      <div className="flex gap-3">
        {r.draft && r.status === "active" && can("hse", "write") && (
          <Button asChild variant="outline">
            <Link href={`/${slug}/hse/registers/${r.id}/edit`}>Edit draft</Link>
          </Button>
        )}
        <Button variant="outline" onClick={() => window.print()}>
          Print evidence
        </Button>
      </div>
      {r.status === "active" && can("hse", "write") && (
        <div className="space-y-2 rounded-lg border p-4">
          <label className="block space-y-1 text-sm">
            Decision / review reason
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </label>
          <div className="flex flex-wrap gap-2">
            {r.draft && can("hse", "manage") && (
              <Button disabled={busy || !reason.trim()} onClick={() => void act("approve")}>
                Approve saved assessment
              </Button>
            )}
            {!r.draft && r.approved && (
              <Button disabled={busy || !reason.trim()} onClick={() => void act("review")}>
                Start a review
              </Button>
            )}
            {can("hse", "manage") && (
              <Button variant="outline" disabled={busy || !reason.trim()} onClick={() => void act("archive")}>
                Archive register
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function HseEntryForm({
  slug,
  record: r,
  today,
  entries,
}: {
  slug: string;
  record: HseRecord;
  today: string;
  entries: HseEntryRow[];
}) {
  const { can } = useWorkspace(),
    router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [commandId, setCommandId] = useState(newId);
  const quantity = ["waste", "utility"].includes(r.kind);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const text = (key: string) => String(f.get(key) ?? "");
    const parsed = hseEntrySchema.safeParse({
      commandId,
      expectedRevision: r.revision,
      performedOn: text("performedOn"),
      outcome: text("outcome"),
      findings: text("findings"),
      actions: text("actions"),
      evidenceReference: text("evidence"),
      nextDueOn: text("nextDueOn") || null,
      quantity: quantity ? Number(text("quantity")) : null,
      periodFrom: text("periodFrom") || null,
      resolvesEntryId: text("resolves") || null,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("; "));
      setBusy(false);
      return;
    }
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].hse.registers[":id"].entries.$post({
          param: { slug, id: r.id },
          json: parsed.data,
        }),
      );
      router.refresh();
      setCommandId(newId());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!can("hse", "write") || !r.approved || r.status !== "active") return null;
  return (
    <form
      onSubmit={submit}
      onChange={() => setCommandId(newId())}
      className="space-y-3 rounded-lg border p-4 print:hidden"
    >
      <h3 className="font-medium">
        {quantity ? "Record measured quantity" : "Sign a check / exercise result"}
      </h3>
      <fieldset disabled={busy} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            Performed / period end
            <Input name="performedOn" type="date" required max={today} defaultValue={today} />
          </label>
          <label className="space-y-1 text-sm">
            Outcome
            <select
              aria-label="Check outcome"
              name="outcome"
              defaultValue={quantity ? "recorded" : "pass"}
              className="h-9 w-full rounded-md border bg-background px-3"
            >
              {quantity ? (
                <option value="recorded">Measured record</option>
              ) : (
                <>
                  <option value="pass">Pass</option>
                  <option value="fail">Fail</option>
                </>
              )}
            </select>
          </label>
          {quantity && (
            <label className="space-y-1 text-sm">
              Quantity ({r.approved.content.unit})
              <Input name="quantity" type="number" min="0.0001" step="0.0001" max="1000000000" required />
            </label>
          )}
          {r.kind === "utility" && (
            <label className="space-y-1 text-sm">
              Period start
              <Input name="periodFrom" type="date" required max={today} />
            </label>
          )}
          <label className="space-y-1 text-sm">
            Next due (optional override)
            <Input name="nextDueOn" type="date" />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          Findings / measurement basis
          <Textarea name="findings" required maxLength={6000} />
        </label>
        <label className="block space-y-1 text-sm">
          Immediate and follow-up actions
          <Textarea name="actions" maxLength={6000} />
        </label>
        <label className="block space-y-1 text-sm">
          Evidence / certificate / waste transfer reference
          <Input name="evidence" required maxLength={2000} />
        </label>
        {!quantity && (
          <label className="block space-y-1 text-sm">
            Explicitly resolve a failed check (optional)
            <select
              aria-label="Resolve failed check"
              name="resolves"
              className="h-9 w-full rounded-md border bg-background px-3"
            >
              <option value="">No failure resolved by this check</option>
              {entries
                .filter((e) => e.outcome === "fail" && !e.voidedAt)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.performedOn} · {e.findings.slice(0, 100)}
                  </option>
                ))}
            </select>
          </label>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy}>Sign and record</Button>
    </form>
  );
}
export function HseEntryEvidence({
  slug,
  record: r,
  entry,
}: {
  slug: string;
  record: HseRecord;
  entry: HseEntryRow;
}) {
  const { can } = useWorkspace(),
    router = useRouter();
  const [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [commandId, setCommandId] = useState(newId);
  async function correct(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].hse.registers[":id"].entries[":entryId"].void.$post({
          param: { slug, id: r.id, entryId: entry.id },
          json: {
            commandId,
            expectedRevision: r.revision,
            reason: String(new FormData(e.currentTarget).get("reason")),
          },
        }),
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 print:hidden">
      <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
        Evidence files
      </Button>
      {open && <RecordAttachments entityType="hse_entry" entityId={entry.id} />}{" "}
      {!entry.voidedAt && can("hse", "manage") && (
        <form onSubmit={correct} onChange={() => setCommandId(newId())} className="flex flex-wrap gap-2">
          <Input
            aria-label="Verification correction reason"
            name="reason"
            placeholder="Correction reason"
            required
            maxLength={2000}
          />
          <Button variant="outline" size="sm" disabled={busy}>
            Correct this entry
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
