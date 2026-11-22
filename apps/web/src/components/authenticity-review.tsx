import {
  authenticityFactorLabels,
  authenticityControlStatus,
  type AuthenticityVersion,
  type AuthenticityVerification,
  type AuthenticitySummary,
} from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import Link from "next/link";
import { printDate, printDateTime } from "@/lib/print";
export function AuthenticityStatus({ assessment }: { assessment: AuthenticitySummary }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Badge variant={assessment.vulnerability === "high" ? "destructive" : "secondary"}>
          {assessment.vulnerability} vulnerability
        </Badge>
        <Badge variant="outline">{assessment.status}</Badge>
        {assessment.draftVersionId && <Badge variant="outline">Draft review in progress</Badge>}
        {assessment.needsReview && assessment.status === "active" && (
          <Badge variant="destructive">Review required</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {assessment.reference} · {assessment.itemCode} · {assessment.itemName}
        {assessment.supplierName ? ` · ${assessment.supplierName}` : " · All supply sources"}
      </p>
      <p className="text-sm">
        {assessment.overdueControls} overdue/expired controls · {assessment.failedControls} failed ·{" "}
        {assessment.pendingControls} awaiting verification · {assessment.openTriggers} open review triggers
      </p>
    </div>
  );
}
export function AuthenticityReview({
  version,
  verifications,
  today,
  users,
  slug,
  showTesting = false,
  timeZone,
}: {
  version: AuthenticityVersion;
  verifications: AuthenticityVerification[];
  today: string;
  users: { id: string; name: string }[];
  slug: string;
  showTesting?: boolean;
  timeZone: string;
}) {
  const body = version.body,
    name = (id: string | null) => users.find((u) => u.id === id)?.name ?? "Former member";
  const evidence = verifications.filter((v) => v.versionId === version.id);
  return (
    <article className="space-y-5 rounded-md border p-4 text-sm">
      <header className="space-y-1">
        <h3 className="font-medium">
          Revision {version.number} · {version.status}
        </h3>
        <p>
          {version.subject.itemCode} · {version.subject.itemName}
          {version.subject.supplierName ? ` · ${version.subject.supplierName}` : " · All supply sources"}
        </p>
        <p className="text-muted-foreground">
          Owner: {body.ownerUserId ? name(body.ownerUserId) : "Unassigned"} · Next review{" "}
          {body.reviewDueOn ? printDate(body.reviewDueOn) : "Not set"}
        </p>
        {version.approvedAt && (
          <p>
            Signed {printDateTime(version.approvedAt, timeZone)} by {name(version.approvedBy)} ·{" "}
            {version.approvalNote}
          </p>
        )}
      </header>
      <section className="space-y-2">
        <h4 className="font-medium">Scope, origin and supply chain</h4>
        <p className="whitespace-pre-wrap">{body.scope || "Not described"}</p>
        <p>Origin: {body.origin || "Not described"}</p>
        <p className="whitespace-pre-wrap">{body.supplyChain || "Supply chain not described"}</p>
      </section>
      <section className="space-y-3">
        <h4 className="font-medium">Vulnerability judgement</h4>
        {body.factors.map((f) => (
          <div className="rounded-md bg-muted/40 p-3" key={f.factor}>
            <p className="font-medium">
              {authenticityFactorLabels[f.factor]} · {f.level}
            </p>
            <p className="whitespace-pre-wrap">{f.rationale || "Rationale not recorded"}</p>
          </div>
        ))}
        <p className="font-medium">Overall vulnerability: {body.vulnerability}</p>
        <p className="whitespace-pre-wrap">{body.rationale || "Conclusion not recorded"}</p>
      </section>
      <section>
        <h4 className="font-medium">Intelligence sources and findings</h4>
        <ul className="mt-2 space-y-3">
          {body.sources.map((s, i) => (
            <li className="rounded-md border p-3" key={i}>
              <p className="font-medium">
                {s.title} · Checked {printDate(s.checkedOn)}
              </p>
              <p className="break-words text-muted-foreground">{s.reference}</p>
              <p className="mt-1 whitespace-pre-wrap">{s.findings}</p>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="font-medium">Provenance, claims and supporting evidence</h4>
        <ul className="mt-2 space-y-3">
          {body.evidence.map((e, i) => (
            <li className="rounded-md border p-3" key={i}>
              <p className="font-medium">
                {e.title} · {e.kind}
              </p>
              <p className="break-words text-muted-foreground">{e.reference}</p>
              {e.validUntil && (
                <p>
                  Valid until {printDate(e.validUntil)}
                  {e.validUntil < today ? " · Expired" : ""}
                </p>
              )}
              {e.note && <p className="whitespace-pre-wrap">{e.note}</p>}
              {e.sampleId &&
                (showTesting ? (
                  <Link className="underline" href={`/${slug}/testing/samples/${e.sampleId}`}>
                    View linked test in Testing
                  </Link>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    A test is referenced; its source record requires Testing access.
                  </p>
                ))}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="font-medium">Control plan and verification status</h4>
        <p className="text-xs text-muted-foreground">
          Status calculated at {printDate(today)} from this revision's own uncorrected records. Signing the
          plan does not verify its controls.
        </p>
        <ul className="mt-2 space-y-3">
          {body.controls.map((c) => {
            const status = authenticityControlStatus(c, evidence, today);
            return (
              <li key={c.id} className="space-y-1 rounded-md border p-3">
                <p className="font-medium">
                  {c.description} · {status.state}
                </p>
                <p>
                  Owner {name(c.ownerUserId)} · {c.kind} ·{" "}
                  {c.frequencyDays ? `Every ${c.frequencyDays} days after verification` : "One-off control"}
                </p>
                <p>Acceptance: {c.acceptanceCriteria}</p>
                <p>
                  Next due:{" "}
                  {status.nextDueOn
                    ? printDate(status.nextDueOn)
                    : status.state === "verified"
                      ? "Verified one-off control"
                      : "Evidence review required"}
                </p>
                <ul className="mt-2 divide-y">
                  {evidence
                    .filter((v) => v.controlId === c.id)
                    .map((v) => (
                      <li key={v.id} className="space-y-1 py-2">
                        <p>
                          {printDate(v.verifiedOn)} · {v.outcome}
                          {v.voidedAt ? " · Corrected (excluded from current status)" : ""} ·{" "}
                          {name(v.actorId)}
                        </p>
                        <p className="break-words">
                          {v.evidenceReference}
                          {v.evidenceValidUntil ? ` · Valid until ${printDate(v.evidenceValidUntil)}` : ""}
                        </p>
                        <p>{v.note}</p>
                        {v.voidedAt && (
                          <p>
                            Correction {printDateTime(v.voidedAt, timeZone)} by {name(v.voidedBy)}:{" "}
                            {v.voidReason}
                          </p>
                        )}
                      </li>
                    ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </section>
    </article>
  );
}
