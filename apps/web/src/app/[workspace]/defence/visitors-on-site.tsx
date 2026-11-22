"use client";

import type { DefenceOverview } from "@/lib/api";
import { useFormatDateTime } from "@/lib/workspace-time";

/** Visitors signed in now, from the Attendance register; long visits may have missed signing out. */
export function VisitorsOnSite({
  visitors,
}: {
  visitors: NonNullable<DefenceOverview["visitors"]>["onSite"];
}) {
  const at = useFormatDateTime();
  if (visitors.length === 0)
    return <p className="text-sm text-muted-foreground">Nobody is signed in as a visitor.</p>;
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {visitors.map((v) => (
        <li key={v.id}>
          <span className="font-medium">{v.name}</span>
          {v.company ? <span className="text-muted-foreground"> · {v.company}</span> : null}
          <div className={v.longVisit ? "text-destructive" : "text-muted-foreground"}>
            In since {at(String(v.signedInAt))}
            {v.hostName ? ` · visiting ${v.hostName}` : ""}
            {v.longVisit ? " · possibly not signed out" : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}
