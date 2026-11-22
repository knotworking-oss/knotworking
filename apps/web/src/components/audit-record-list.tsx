import type { ReactNode } from "react";
import type { AuditEntry } from "@/lib/audit-records";

/**
 * The records of one audit section, as they go on paper: when, what, the outcome, who did it, what
 * it corrected or was replaced by, and who signed it off. A replaced record stays on the page
 * (struck through) so the audit shows what was first written.
 */
export function AuditRecordList({
  title,
  description,
  entries,
  empty = "No records in this range.",
}: {
  title: string;
  description?: ReactNode;
  entries: readonly AuditEntry[];
  empty?: string;
}) {
  return (
    <section className="mt-6">
      <h2 className="border-b border-black pb-1 text-base font-bold">
        {title} <span className="text-[12px] font-normal text-muted-foreground">({entries.length})</span>
      </h2>
      {description && <p className="mt-1 text-[12px] text-muted-foreground">{description}</p>}
      {entries.length === 0 ? (
        <p className="py-3 text-[12px] text-muted-foreground">{empty}</p>
      ) : (
        <ol className="divide-y divide-black/25">
          {entries.map((e) => (
            <li key={e.id} className="break-inside-avoid py-2 text-[12px]">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className={`font-semibold ${e.replaced ? "line-through decoration-1" : ""}`}>{e.title}</p>
                <p className="text-muted-foreground tabular-nums">{e.atText}</p>
              </div>
              {e.result && (
                <p
                  className={`${e.problem ? "font-bold" : ""} ${e.replaced ? "line-through decoration-1" : ""}`}
                >
                  {e.result}
                </p>
              )}
              {e.lines.length > 0 && (
                <ul className={`text-muted-foreground ${e.replaced ? "line-through decoration-1" : ""}`}>
                  {e.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
              {e.note && <p>Note: {e.note}</p>}
              <dl className="mt-0.5 grid grid-cols-[5.5rem_1fr] gap-x-3">
                {e.doneBy && (
                  <>
                    <dt className="text-muted-foreground">Who</dt>
                    <dd>{e.doneBy}</dd>
                  </>
                )}
                {e.corrects && (
                  <>
                    <dt className="font-semibold">Correction</dt>
                    <dd>
                      Replaces {e.corrects.summary}
                      {e.corrects.reason ? `. Reason: ${e.corrects.reason}` : ""}
                    </dd>
                  </>
                )}
                {e.replaced && (
                  <>
                    <dt className="font-semibold">Replaced</dt>
                    <dd>{e.replacedNote ?? "A later record corrects this one; it no longer counts."}</dd>
                  </>
                )}
                {e.followUps.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Actions</dt>
                    <dd>{e.followUps.join("; ")}</dd>
                  </>
                )}
                {e.signOff && (
                  <>
                    <dt className="text-muted-foreground">Sign-off</dt>
                    <dd>{e.signOff}</dd>
                  </>
                )}
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
