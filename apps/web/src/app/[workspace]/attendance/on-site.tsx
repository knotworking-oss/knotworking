"use client";

import { staffDisplayName } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Siren, Printer, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { StaffNumber } from "@/components/people-badges";
import type { OnSite, RollCall, RollCallSummary } from "@/lib/api";
import { siteDateTime, siteTime } from "@/lib/attendance-format";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { AttendanceNav } from "./attendance-nav";
import { RollCallView } from "./roll-call";

/** Attendance → On site: the evacuation register, roll calls, and links to the rest. */
export function OnSiteView({
  slug,
  onSite,
  rollCalls,
  current,
  timeZone,
}: {
  slug: string;
  onSite: OnSite;
  rollCalls: RollCallSummary[];
  current: RollCall | null;
  timeZone: string;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  // Fresh every 30 seconds while the page is open (the fire marshal's phone), every 10 during a
  // roll call so marshals see each other's ticks.
  const rollCallRunning = Boolean(current && !current.endedAt);
  useEffect(() => {
    const t = setInterval(() => router.refresh(), rollCallRunning ? 10_000 : 30_000);
    return () => clearInterval(t);
  }, [router, rollCallRunning]);

  async function start(kind: "drill" | "real") {
    setStarting(true);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].attendance["roll-calls"].$post({
          param: { slug },
          json: { kind },
        }),
      );
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  const total = onSite.staff.length + onSite.visitors.length;
  const left = onSite.possiblyLeft.staff.length + onSite.possiblyLeft.visitors.length;

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">On site now</h2>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "person" : "people"} at {siteTime(onSite.at, timeZone)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer data-icon="inline-start" /> Print
          </Button>
          {!current && (
            <>
              <Button variant="outline" disabled={starting} onClick={() => start("drill")}>
                <ShieldCheck data-icon="inline-start" /> Start drill
              </Button>
              <Button variant="destructive" disabled={starting} onClick={() => start("real")}>
                <Siren data-icon="inline-start" /> Evacuation roll call
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="print:hidden">
        <AttendanceNav slug={slug} />
      </div>

      {current && <RollCallView key={current.id} slug={slug} call={current} />}

      <section className="grid gap-4 md:grid-cols-2">
        <PeopleCard
          title={`Staff (${onSite.staff.length})`}
          empty="Nobody is clocked in."
          rows={onSite.staff.map((s) => ({
            key: s.id,
            name: staffDisplayName(s),
            detail: <StaffNumber value={s.staffNumber} />,
            extra: s.department,
            since: siteTime(s.since, timeZone),
          }))}
        />
        <PeopleCard
          title={`Visitors (${onSite.visitors.length})`}
          empty="No visitors signed in."
          rows={onSite.visitors.map((v) => ({
            key: v.id,
            name: `${v.firstName} ${v.lastName}`,
            detail: <Badge variant="outline">Visitor</Badge>,
            extra: visitorExtra(v),
            since: siteTime(v.since, timeZone),
          }))}
        />
      </section>

      {left > 0 && (
        <PeopleCard
          title={`May have left without clocking out (${left})`}
          empty=""
          note="Clocked in longer ago than the maximum shift, or a visitor signed in before today. Roll calls include them."
          rows={[
            ...onSite.possiblyLeft.staff.map((s) => ({
              key: s.id,
              name: staffDisplayName(s),
              detail: <StaffNumber value={s.staffNumber} />,
              extra: s.department,
              since: siteDateTime(s.since, timeZone),
            })),
            ...onSite.possiblyLeft.visitors.map((v) => ({
              key: v.id,
              name: `${v.firstName} ${v.lastName}`,
              detail: <Badge variant="outline">Visitor</Badge>,
              extra: visitorExtra(v),
              since: siteDateTime(v.since, timeZone),
            })),
          ]}
        />
      )}

      {rollCalls.filter((r) => r.endedAt).length > 0 && (
        <section className="flex flex-col gap-2 print:hidden">
          <h3 className="font-medium">Past roll calls</h3>
          <Card className="py-0">
            <ul className="divide-y text-sm">
              {rollCalls
                .filter((r) => r.endedAt)
                .map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <Link
                      href={`/${slug}/attendance/roll-calls/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.kind === "real" ? "Evacuation" : "Drill"} · {siteDateTime(r.startedAt, timeZone)}
                    </Link>
                    <span className="text-muted-foreground">
                      {r.counts.safe} safe
                      {r.counts.missing > 0 && `, ${r.counts.missing} missing`}
                      {r.counts.unaccounted > 0 && `, ${r.counts.unaccounted} not accounted for`}
                      {r.startedByName && ` · ${r.startedByName}`}
                    </span>
                  </li>
                ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}

/** "Acme Ltd · visiting Grace Hopper": who a visitor is with and who they came to see. */
const visitorExtra = (v: { company: string | null; hostName: string | null }) =>
  [v.company, v.hostName && `visiting ${v.hostName}`].filter(Boolean).join(" · ") || null;

function PeopleCard({
  title,
  empty,
  note,
  rows,
}: {
  title: string;
  empty: string;
  note?: string;
  rows: { key: string; name: string; detail: React.ReactNode; extra: string | null; since: string }[];
}) {
  return (
    <Card className="gap-0 py-0">
      <div className="border-b px-4 py-2.5">
        <h3 className="font-medium">{title}</h3>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-3 px-4 py-2">
              <span className="min-w-0">
                <span className="font-medium">{r.name}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  {r.detail}
                  {r.extra && ` · ${r.extra}`}
                </span>
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">since {r.since}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
