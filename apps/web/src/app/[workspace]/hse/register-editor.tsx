"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  hseContentSchema,
  hseKinds,
  hseKindLabels,
  newId,
  type HseContent,
  type HseKind,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import { useWorkspace } from "@/lib/workspace-store";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import type { HseRecord } from "@/lib/api";
import { HsePicker } from "./reference-picker";
export function RegisterEditor({ slug, today, record }: { slug: string; today: string; record?: HseRecord }) {
  const { can, idx, viewer } = useWorkspace(),
    router = useRouter();
  const [kind, setKind] = useState<HseKind>(record?.kind ?? "risk_assessment");
  const [content, setContent] = useState<HseContent>(
    () => record?.draft?.content ?? hseContentSchema.parse({ ownerUserId: viewer.id }),
  );
  const [commandId, setCommandId] = useState(newId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [newCourse, setNewCourse] = useState("");
  const [task, setTask] = useState("");
  function patch(p: Partial<HseContent>) {
    setContent((c) => ({ ...c, ...p }));
    setCommandId(newId());
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      const parsed = hseContentSchema.parse(content);
      const api = browserApi().v1.workspaces[":slug"].hse.registers;
      const r = record
        ? await unwrap(
            api[":id"].draft.$put({
              param: { slug, id: record.id },
              json: {
                commandId,
                expectedRevision: record.revision,
                reason: String(f.get("reason")),
                content: parsed,
              },
            }),
          )
        : await unwrap(
            api.$post({
              param: { slug },
              json: { commandId, title: String(f.get("title")), kind, content: parsed },
            }),
          );
      router.push(`/${slug}/hse/registers/${r.id}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (!can("hse", "write") || (record && !record.draft))
    return (
      <p className="p-6 text-sm text-muted-foreground">
        An editable draft and HSE write access are required.
      </p>
    );
  const notes = (
    key:
      | "scope"
      | "basis"
      | "controls"
      | "response"
      | "subject"
      | "evidenceReference"
      | "unit"
      | "wasteCode"
      | "authorisationReference",
    label: string,
    short = false,
  ) => (
    <label className="block space-y-1 text-sm" key={key}>
      {label}
      {short ? (
        <Input
          aria-label={label}
          value={content[key]}
          onChange={(e) => patch({ [key]: e.target.value })}
          maxLength={key === "unit" ? 30 : key === "wasteCode" ? 80 : key === "subject" ? 500 : 300}
        />
      ) : (
        <Textarea
          aria-label={label}
          value={content[key]}
          onChange={(e) => patch({ [key]: e.target.value })}
          maxLength={6000}
        />
      )}
    </label>
  );
  return (
    <form
      onSubmit={submit}
      onChange={() => setCommandId(newId())}
      className="workspace-content space-y-5 py-6"
    >
      <h1 className="text-xl font-medium">{record ? `Edit draft: ${record.title}` : "New HSE register"}</h1>
      <p className="text-sm text-muted-foreground">
        Keep personal injury and health details in Restricted incidents. This draft does not replace the
        current signed assessment until approved.
      </p>
      <fieldset disabled={busy} className="space-y-5">
        <label className="block space-y-1 text-sm">
          Title
          <Input name="title" required readOnly={!!record} defaultValue={record?.title} maxLength={200} />
        </label>
        <label className="block space-y-1 text-sm">
          Register type
          <select
            aria-label="Register type"
            value={kind}
            disabled={!!record}
            onChange={(e) => setKind(e.target.value as HseKind)}
            className="h-9 w-full rounded-md border bg-background px-3"
          >
            {hseKinds.map((k) => (
              <option key={k} value={k}>
                {hseKindLabels[k]}
              </option>
            ))}
          </select>
        </label>
        {notes("scope", "Scope, locations and activities")}
        {notes("basis", "Applicable requirement, assessment method and rationale")}
        {notes("controls", "Controls, safe working / handling arrangements")}
        {notes("response", "Failure response, emergency and escalation arrangements")}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            Accountable owner
            <select
              aria-label="Accountable owner"
              value={content.ownerUserId ?? ""}
              onChange={(e) => patch({ ownerUserId: e.target.value || null })}
              className="h-9 w-full rounded-md border bg-background px-3"
            >
              <option value="">Choose owner</option>
              {idx.boot.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            Review due
            <Input
              type="date"
              value={content.reviewDueOn ?? ""}
              onChange={(e) => patch({ reviewDueOn: e.target.value || null })}
            />
          </label>
          <label className="space-y-1 text-sm">
            First check / exercise / reporting due
            <Input
              type="date"
              value={content.firstCheckDueOn ?? ""}
              onChange={(e) => patch({ firstCheckDueOn: e.target.value || null })}
            />
          </label>
          <label className="space-y-1 text-sm">
            Repeat checks every (days, optional)
            <Input
              type="number"
              min="1"
              max="3650"
              value={content.frequencyDays ?? ""}
              onChange={(e) => patch({ frequencyDays: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
        </div>
        {notes(
          "evidenceReference",
          kind === "coshh"
            ? "SDS reference and revision / exposure routes, PPE, storage and first-aid evidence"
            : "Supporting evidence / procedure reference",
        )}
        {["coshh", "utility"].includes(kind) &&
          notes("subject", kind === "coshh" ? "Substance / product and hazards" : "Resource / meter", true)}
        {kind === "coshh" && (
          <label className="block space-y-1 text-sm">
            SDS issued on
            <Input
              type="date"
              max={today}
              value={content.sdsIssuedOn ?? ""}
              onChange={(e) => patch({ sdsIssuedOn: e.target.value || null })}
            />
          </label>
        )}
        {["contractor", "waste"].includes(kind) && can("items") && (
          <HsePicker
            slug={slug}
            kind="supplier"
            label="Service provider"
            value={content.supplierId ?? ""}
            onChange={(id) => patch({ supplierId: id || null })}
          />
        )}
        {kind === "contractor" && (
          <>
            <label className="block space-y-1 text-sm">
              Competence evidence expires on
              <Input
                type="date"
                value={content.competenceExpiresOn ?? ""}
                onChange={(e) => patch({ competenceExpiresOn: e.target.value || null })}
              />
            </label>
            <HsePicker
              slug={slug}
              kind="course"
              label="Required course"
              value={newCourse}
              onChange={setNewCourse}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!newCourse}
              onClick={() => {
                patch({ courseIds: [...new Set([...content.courseIds, newCourse])] });
                setNewCourse("");
              }}
            >
              Add required course
            </Button>
            {content.courseIds.map((id, i) => (
              <div key={id} className="flex items-center gap-3 text-sm">
                <span>Required course {i + 1}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => patch({ courseIds: content.courseIds.filter((c) => c !== id) })}
                >
                  Remove
                </Button>
              </div>
            ))}
          </>
        )}
        {["waste", "utility"].includes(kind) && notes("unit", "Measurement unit (e.g. kg, kWh, m³)", true)}
        {kind === "waste" && (
          <>
            {notes("wasteCode", "Waste classification / code", true)}
            {notes("authorisationReference", "Carrier / disposal authorisation reference", true)}
          </>
        )}
        {kind === "risk_assessment" && (
          <section className="space-y-3">
            <h2 className="font-medium">Hazards and residual risk</h2>
            {content.hazards.map((h, i) => (
              <fieldset key={i} className="space-y-3 rounded-lg border p-4">
                <legend className="px-1 text-sm">Hazard {i + 1}</legend>
                {(["hazard", "peopleAtRisk", "controls", "rationale"] as const).map((key) => (
                  <label key={key} className="block space-y-1 text-sm">
                    {
                      {
                        hazard: "Hazard",
                        peopleAtRisk: "People at risk",
                        controls: "Risk controls",
                        rationale: "Residual risk rationale",
                      }[key]
                    }
                    <Textarea
                      value={h[key]}
                      required
                      maxLength={key === "controls" ? 3000 : key === "rationale" ? 2000 : 1000}
                      onChange={(e) =>
                        patch({
                          hazards: content.hazards.map((v, n) =>
                            n === i ? { ...v, [key]: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
                <div className="grid grid-cols-2 gap-3">
                  {(["likelihood", "severity", "residualLikelihood", "residualSeverity"] as const).map(
                    (key) => (
                      <label key={key} className="space-y-1 text-sm">
                        {
                          {
                            likelihood: "Initial likelihood (1–5)",
                            severity: "Initial severity (1–5)",
                            residualLikelihood: "Residual likelihood (1–5)",
                            residualSeverity: "Residual severity (1–5)",
                          }[key]
                        }
                        <Input
                          type="number"
                          min="1"
                          max="5"
                          required
                          value={h[key]}
                          onChange={(e) =>
                            patch({
                              hazards: content.hazards.map((v, n) =>
                                n === i ? { ...v, [key]: Number(e.target.value) } : v,
                              ),
                            })
                          }
                        />
                      </label>
                    ),
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => patch({ hazards: content.hazards.filter((_, n) => n !== i) })}
                >
                  Remove hazard
                </Button>
              </fieldset>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                patch({
                  hazards: [
                    ...content.hazards,
                    {
                      hazard: "",
                      peopleAtRisk: "",
                      controls: "",
                      rationale: "",
                      likelihood: 1,
                      severity: 1,
                      residualLikelihood: 1,
                      residualSeverity: 1,
                    },
                  ],
                })
              }
            >
              Add hazard
            </Button>
          </section>
        )}
        {can("tasks") && (
          <section className="space-y-3">
            <h2 className="font-medium">Existing follow-up tasks</h2>
            <HsePicker slug={slug} kind="task" label="Follow-up task" value={task} onChange={setTask} />
            <Button
              type="button"
              variant="outline"
              disabled={!task}
              onClick={() => {
                patch({ actionTaskIds: [...new Set([...(content.actionTaskIds ?? []), task])] });
                setTask("");
              }}
            >
              Link task
            </Button>
            {(content.actionTaskIds ?? []).map((id, i) => (
              <div key={id} className="flex gap-3 text-sm">
                <span>{idx.boot.tasks.find((t) => t.id === id)?.title ?? `Linked task ${i + 1}`}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => patch({ actionTaskIds: content.actionTaskIds.filter((t) => t !== id) })}
                >
                  Remove link
                </Button>
              </div>
            ))}
          </section>
        )}
        {record && (
          <label className="block space-y-1 text-sm">
            Reason for this revision
            <Input name="reason" required maxLength={2000} />
          </label>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy}>{busy ? "Saving…" : "Save draft"}</Button>
    </form>
  );
}
