"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  hseIncidentBodySchema,
  hseIncidentKindLabels,
  hseIncidentKinds,
  newId,
  type HseIncidentBody,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useWorkspace } from "@/lib/workspace-store";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import type { HseIncident } from "@/lib/api";
import { HsePicker } from "./reference-picker";
export function IncidentEditor({
  slug,
  today,
  incident,
}: {
  slug: string;
  today: string;
  incident?: HseIncident;
}) {
  const router = useRouter(),
    { can, viewer, idx } = useWorkspace();
  const [body, setBody] = useState<HseIncidentBody>(
    () =>
      incident?.body ??
      hseIncidentBodySchema.parse({
        kind: "near_miss",
        occurredOn: today,
        place: "Draft",
        summary: "Draft",
        immediateActions: "Draft",
        ownerUserId: viewer.id,
      }),
  );
  const [selected, setSelected] = useState("");
  const [commandId, setCommandId] = useState(newId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function patch(p: Partial<HseIncidentBody>) {
    setBody((b) => ({ ...b, ...p }));
    setCommandId(newId());
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const parsed = hseIncidentBodySchema.parse(body);
      const api = browserApi().v1.workspaces[":slug"].hse.incidents;
      const r = incident
        ? await unwrap(
            api[":id"].$put({
              param: { slug, id: incident.id },
              json: {
                commandId,
                expectedRevision: incident.revision,
                body: parsed,
                reason: String(new FormData(e.currentTarget).get("reason")),
              },
            }),
          )
        : await unwrap(api.$post({ param: { slug }, json: { commandId, body: parsed } }));
      router.push(`/${slug}/hse/incidents/${r.id}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!can("hse_incidents", "write") || incident?.status === "closed") return null;
  const field = (
    key:
      | "place"
      | "summary"
      | "healthDetails"
      | "immediateActions"
      | "investigation"
      | "rootCause"
      | "correctiveActions"
      | "effectiveness"
      | "reportingBasis"
      | "reportReference",
    label: string,
    required = false,
  ) => (
    <label key={key} className="block space-y-1 text-sm">
      {label}
      <Textarea
        aria-label={label}
        required={required}
        maxLength={
          key === "place" ? 500 : key === "summary" ? 3000 : key === "immediateActions" ? 4000 : 6000
        }
        value={!incident && body[key] === "Draft" ? "" : body[key]}
        onChange={(e) => patch({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <form
      onSubmit={submit}
      onChange={() => setCommandId(newId())}
      className="space-y-5 rounded-lg border p-5 print:hidden"
    >
      <h2 className="text-lg font-medium">
        {incident ? "Update investigation" : "Record restricted incident"}
      </h2>
      <p className="text-sm text-muted-foreground">
        Visible only to people granted Restricted HSE incidents access. Nothing is copied into general staff
        records, tasks, workspace sync or assistant tools. Keep personal evidence files in your approved
        restricted store and record its reference here.
      </p>
      <fieldset disabled={busy} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            Incident kind
            <select
              aria-label="Incident kind"
              value={body.kind}
              onChange={(e) => patch({ kind: e.target.value as HseIncidentBody["kind"] })}
              className="h-9 w-full rounded-md border bg-background px-3"
            >
              {hseIncidentKinds.map((k) => (
                <option key={k} value={k}>
                  {hseIncidentKindLabels[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Occurred on
            <Input
              type="date"
              max={today}
              required
              value={body.occurredOn}
              onChange={(e) => patch({ occurredOn: e.target.value })}
            />
          </label>
          <label className="space-y-1 text-sm">
            Investigation owner
            <select
              aria-label="Investigation owner"
              value={body.ownerUserId}
              onChange={(e) => patch({ ownerUserId: e.target.value })}
              className="h-9 w-full rounded-md border bg-background px-3"
            >
              {idx.boot.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {field("place", "Location", true)}
        {field("summary", "Incident summary", true)}
        <HsePicker
          slug={slug}
          kind="staff"
          label="Affected staff member"
          value={selected}
          onChange={setSelected}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!selected}
          onClick={() => {
            patch({ staffIds: [...new Set([...body.staffIds, selected])] });
            setSelected("");
          }}
        >
          Add affected person
        </Button>
        {body.staffIds.map((id, i) => (
          <div key={id} className="flex items-center gap-3 text-sm">
            <span>
              {incident?.affectedPeople.find((p) => p.id === id)
                ? `${incident.affectedPeople.find((p) => p.id === id)?.firstName} ${incident.affectedPeople.find((p) => p.id === id)?.lastName}`
                : `Selected person ${i + 1}`}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => patch({ staffIds: body.staffIds.filter((v) => v !== id) })}
            >
              Remove person
            </Button>
          </div>
        ))}
        {/* Only managers see (and so edit) the health details once recorded; the server keeps them otherwise. */}
        {(!incident || incident.canSeeRestricted) &&
          field("healthDetails", "Restricted injury / health details")}
        {field("immediateActions", "Immediate actions and containment", true)}
        {field("investigation", "Investigation evidence and findings")}
        {field("rootCause", "Root cause")}
        {field("correctiveActions", "Corrective actions and owners / completion evidence")}
        {field("effectiveness", "Effectiveness verification")}
        <label className="block space-y-1 text-sm">
          Reporting decision
          <select
            aria-label="Reporting decision"
            value={body.reportingDecision}
            onChange={(e) =>
              patch({ reportingDecision: e.target.value as HseIncidentBody["reportingDecision"] })
            }
            className="h-9 w-full rounded-md border bg-background px-3"
          >
            <option value="not_assessed">Not yet assessed</option>
            <option value="required">Reporting required</option>
            <option value="not_required">Reporting not required</option>
          </select>
        </label>
        {field(
          "reportingBasis",
          "Applicable reporting requirement, decision basis and responsible person's assessment",
        )}
        {body.reportingDecision === "required" && (
          <label className="block space-y-1 text-sm">
            Deadline from the applicable requirement
            <Input
              type="date"
              value={body.reportingDueOn ?? ""}
              onChange={(e) => patch({ reportingDueOn: e.target.value || null })}
              required
            />
          </label>
        )}
        {field("reportReference", "Submission / restricted evidence reference")}
        {incident && (
          <label className="block space-y-1 text-sm">
            Investigation update reason
            <Input name="reason" required maxLength={2000} />
          </label>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy}>
        {busy ? "Saving…" : incident ? "Save investigation update" : "Record incident"}
      </Button>
    </form>
  );
}
export function IncidentClose({ slug, incident }: { slug: string; incident: HseIncident }) {
  const { can } = useWorkspace(),
    router = useRouter();
  const [reason, setReason] = useState(""),
    [commandId, setCommandId] = useState(newId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function close() {
    setBusy(true);
    setError("");
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].hse.incidents[":id"].close.$post({
          param: { slug, id: incident.id },
          json: { commandId, expectedRevision: incident.revision, reason },
        }),
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return can("hse_incidents", "manage") && incident.status === "open" ? (
    <section className="space-y-3 rounded-lg border p-4 print:hidden">
      <label className="block space-y-1 text-sm">
        Signed closure decision
        <Input
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setCommandId(newId());
          }}
          maxLength={2000}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        Closure requires a saved investigation, root cause, corrective actions (none still open),
        effectiveness check and assessed reporting decision with required submission evidence.
      </p>
      <Button disabled={busy || !reason.trim()} onClick={() => void close()}>
        Sign and close investigation
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  ) : null;
}
