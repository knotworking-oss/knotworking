import type { IncidentSummary } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
export function IncidentOverview({ incident, ownerName }: { incident: IncidentSummary; ownerName: string }) {
  return (
    <section className="space-y-2 rounded-md border p-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{incident.kind}</Badge>
        <Badge variant={incident.severity === "critical" ? "destructive" : "secondary"}>
          {incident.severity}
        </Badge>
        <Badge variant="outline">{incident.status}</Badge>
      </div>
      <p className="text-sm">
        {incident.reference} · Owner {ownerName}
      </p>
      <p className="text-xs text-muted-foreground">
        Opened {incident.createdAt}
        {incident.closedAt
          ? ` · Signed closed ${incident.closedAt}`
          : " · Live incident evidence remains under review"}
      </p>
    </section>
  );
}
