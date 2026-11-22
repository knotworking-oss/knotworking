import type { ReleaseCheck, ReleaseCheckRef } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { CircleCheck, CircleX, EyeOff, Info } from "lucide-react";
import Link from "next/link";

type Check = ReleaseCheck & { hidden?: boolean };

/** Where a check's reference leads, by the module it came from. */
function refHref(slug: string, check: Check, ref: ReleaseCheckRef) {
  if (check.module === "testing") return `/${slug}/testing/samples/${ref.id}`;
  if (check.module === "specifications") return `/${slug}/specifications/${ref.id}`;
  return null;
}

/**
 * What a lot's release is checked against: each check met, blocking, or for the record. Checks
 * whose module the viewer can't read still show, without their references.
 */
export function ReleaseChecklist({ slug, checks }: { slug: string; checks: readonly Check[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {checks.map((c) => (
        <li key={c.kind} className="flex gap-2">
          {c.status === "pass" ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-label-green" aria-label="Met" />
          ) : c.status === "block" ? (
            <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Blocks release" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="For the record" />
          )}
          <div className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-1 font-medium">
              {c.label}
              {c.fromRule && (
                <Badge variant="outline" className="text-xs font-normal">
                  Release rule
                </Badge>
              )}
            </span>
            <span className="text-muted-foreground">{c.detail}</span>
            {c.hidden ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <EyeOff className="size-3" /> You can&apos;t open these records; ask someone with access.
              </span>
            ) : (
              c.refs.length > 0 && (
                <span className="flex flex-wrap gap-x-2 text-xs">
                  {c.refs.map((r) => {
                    const href = refHref(slug, c, r);
                    return href ? (
                      <Link key={r.id} href={href} className="font-mono hover:underline">
                        {r.label}
                      </Link>
                    ) : (
                      <span key={r.id} className="font-mono">
                        {r.label}
                      </span>
                    );
                  })}
                </span>
              )
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
