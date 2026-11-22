"use client";
import { useWorkspace } from "@/lib/workspace-store";
import type { HseContent } from "@knotworking/core";
export interface HseContentReferences {
  suppliers: Record<string, string>;
  courses: Record<string, string>;
}
export function HseContentView({
  content: c,
  references,
}: {
  content: HseContent;
  /** Names of the service provider and required courses, resolved by the API. */
  references?: HseContentReferences;
}) {
  const { idx, can, slug } = useWorkspace();
  const values = [
    ["Accountable owner", idx.boot.users.find((u) => u.id === c.ownerUserId)?.name ?? "Unassigned"],
    ["Scope", c.scope],
    ["Basis and requirement", c.basis],
    ["Controls", c.controls],
    ["Failure / emergency response", c.response],
    ["Subject / substance", c.subject],
    [
      "Service provider",
      c.supplierId
        ? (references?.suppliers[c.supplierId] ?? "A service provider that can't be named here")
        : null,
    ],
    [
      "Required training courses",
      c.courseIds.length
        ? c.courseIds.map((id) => references?.courses[id] ?? "A course that can't be named here").join("\n")
        : null,
    ],
    ["Evidence reference", c.evidenceReference],
    ["SDS date", c.sdsIssuedOn],
    ["Competence expiry", c.competenceExpiresOn],
    ["Review due", c.reviewDueOn],
    ["First check due", c.firstCheckDueOn],
    ["Repeat every", c.frequencyDays ? `${c.frequencyDays} days` : null],
    ["Unit", c.unit],
    ["Waste code", c.wasteCode],
    ["Authorisation reference", c.authorisationReference],
  ];
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid gap-4 sm:grid-cols-2">
        {values
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="font-medium">{label}</dt>
              <dd className="whitespace-pre-line">{value}</dd>
            </div>
          ))}
      </dl>
      {(c.actionTaskIds ?? []).length > 0 && (
        <section>
          <h3 className="font-medium">Follow-up tasks</h3>
          {can("tasks") ? (
            (c.actionTaskIds ?? []).map((id) => (
              <p key={id}>
                <a className="underline" href={`/${slug}/task/${id}`}>
                  {idx.boot.tasks.find((t) => t.id === id)?.title ?? "Open linked task"}
                </a>
              </p>
            ))
          ) : (
            <p>Task references retained; Tasks access is required to open them.</p>
          )}
        </section>
      )}
      {c.hazards.map((h, i) => (
        <section key={i} className="space-y-1 rounded-md border p-3">
          <h3 className="font-medium">{h.hazard}</h3>
          <p>People at risk: {h.peopleAtRisk}</p>
          <p>
            Initial likelihood/severity: {h.likelihood}/{h.severity}; residual: {h.residualLikelihood}/
            {h.residualSeverity}
          </p>
          <p className="whitespace-pre-line">{h.controls}</p>
          <p className="whitespace-pre-line">{h.rationale}</p>
        </section>
      ))}
    </div>
  );
}
