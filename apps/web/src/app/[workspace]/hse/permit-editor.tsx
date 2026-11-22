"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { hsePermitBodySchema, newId } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useWorkspace } from "@/lib/workspace-store";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import type { HsePermit } from "@/lib/api";
import { HsePicker } from "./reference-picker";
export function PermitEditor({
  slug,
  today,
  permit: p,
}: {
  slug: string;
  today: string;
  permit?: HsePermit;
}) {
  const { can } = useWorkspace(),
    router = useRouter();
  const [contractor, setContractor] = useState(p?.body.contractorRecordId ?? ""),
    [asset, setAsset] = useState(p?.assetId ?? ""),
    [staff, setStaff] = useState(p?.body.staffId ?? "");
  const [assessment, setAssessment] = useState("");
  const [assessments, setAssessments] = useState(p?.body.assessmentIds ?? []);
  const [isolation, setIsolation] = useState(p?.isolationRequired ?? true);
  const [commandId, setCommandId] = useState(newId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget),
      text = (k: string) => String(f.get(k) ?? "");
    const parsed = hsePermitBodySchema.safeParse({
      contractorRecordId: contractor,
      assessmentIds: assessments,
      assetId: asset,
      staffId: staff || null,
      visitId: p?.body.visitId ?? null,
      startsOn: text("from"),
      endsOn: text("to"),
      workScope: text("work"),
      precautions: text("precautions"),
      isolationRequired: isolation,
      isolationPoints: text("isolation"),
      inductionChecked: f.has("induction"),
      ppeChecked: f.has("ppe"),
      emergencyReady: f.has("emergency"),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("; "));
      setBusy(false);
      return;
    }
    try {
      const api = browserApi().v1.workspaces[":slug"].hse.permits;
      const result = p
        ? await unwrap(
            api[":id"].$put({
              param: { slug, id: p.id },
              json: { commandId, expectedRevision: p.revision, body: parsed.data, reason: text("reason") },
            }),
          )
        : await unwrap(
            api.$post({ param: { slug }, json: { commandId, title: text("title"), body: parsed.data } }),
          );
      router.push(`/${slug}/hse/permits/${result.id}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!can("hse", "write") || (p && p.status !== "draft"))
    return (
      <p className="p-6 text-sm text-muted-foreground">A draft permit and HSE write access are required.</p>
    );
  return (
    <form
      onSubmit={submit}
      onChange={() => setCommandId(newId())}
      className="mx-auto w-full max-w-4xl space-y-5 p-6"
    >
      <h1 className="text-xl font-medium">{p ? `Edit permit: ${p.title}` : "Prepare contractor permit"}</h1>
      <p className="text-sm text-muted-foreground">
        Preparing a draft does not authorise work. Issue requires a signed-in HSE manager, current
        contractor/assessment evidence and any required worker training.
      </p>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1 text-sm">
          Permit title
          <Input name="title" required maxLength={200} readOnly={!!p} defaultValue={p?.title} />
        </label>
        <HsePicker
          slug={slug}
          kind="contractor"
          label="Contractor competence record"
          value={contractor}
          onChange={setContractor}
          required
        />
        <HsePicker slug={slug} kind="asset" label="Site asset" value={asset} onChange={setAsset} required />
        <HsePicker
          slug={slug}
          kind="assessment"
          label="Risk or COSHH assessment"
          value={assessment}
          onChange={setAssessment}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!assessment}
          onClick={() => {
            setAssessments((a) => [...new Set([...a, assessment])]);
            setAssessment("");
            setCommandId(newId());
          }}
        >
          Add assessment
        </Button>
        {assessments.map((id, i) => (
          <div key={id} className="flex gap-3 text-sm">
            <span>{p?.assessments.find((a) => a.id === id)?.title ?? `Selected assessment ${i + 1}`}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAssessments((a) => a.filter((v) => v !== id));
                setCommandId(newId());
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <HsePicker
          slug={slug}
          kind="staff"
          label="Registered worker (required when courses are specified)"
          value={staff}
          onChange={setStaff}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            Work starts
            <Input type="date" name="from" required defaultValue={p?.body.startsOn ?? today} />
          </label>
          <label className="space-y-1 text-sm">
            Work ends
            <Input type="date" name="to" required defaultValue={p?.body.endsOn ?? today} />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          Work scope
          <Textarea name="work" required maxLength={4000} defaultValue={p?.body.workScope} />
        </label>
        <label className="block space-y-1 text-sm">
          Precautions and safe system of work
          <Textarea name="precautions" required maxLength={4000} defaultValue={p?.body.precautions} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isolation} onChange={(e) => setIsolation(e.target.checked)} />
          Asset isolation required
        </label>
        {isolation && (
          <label className="block space-y-1 text-sm">
            Isolation points and zero-energy checks
            <Textarea name="isolation" required maxLength={4000} defaultValue={p?.body.isolationPoints} />
          </label>
        )}
        {(
          [
            ["induction", "Induction checked", p?.body.inductionChecked],
            ["ppe", "PPE checked", p?.body.ppeChecked],
            ["emergency", "Emergency arrangements ready", p?.body.emergencyReady],
          ] as const
        ).map(([key, label, value]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name={key} defaultChecked={value} />
            {label}
          </label>
        ))}
        {p && (
          <label className="block space-y-1 text-sm">
            Change reason
            <Input name="reason" required maxLength={2000} />
          </label>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy}>Save permit draft</Button>
    </form>
  );
}
