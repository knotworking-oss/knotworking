import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { formatCost } from "@/components/costing-badges";
import { PageHeader } from "@/components/page-header";
import { getWorkCentres, getWorkspaceCurrency } from "@/lib/api";
import { NewWorkCentre, WorkCentreActions } from "./work-centre-controls";

export const metadata: Metadata = { title: "Work centres" };

/** Work centres: where operations are done, their capacity and cost per hour. */
export default async function WorkCentresPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = search.status === "archived" || search.status === "all" ? search.status : "active";
  const [{ workCentres }, currency] = await Promise.all([
    getWorkCentres(slug, { status }),
    getWorkspaceCurrency(slug),
  ]);
  const base = `/${slug}/routings/work-centres`;
  return (
    <>
      <PageHeader actions={<NewWorkCentre slug={slug} />}>
        <h1 className="font-medium">Work centres</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            {(["active", "archived", "all"] as const).map((s) => (
              <Button key={s} size="sm" variant={status === s ? "secondary" : "ghost"} asChild>
                <Link href={s === "active" ? base : `${base}?status=${s}`}>
                  {s === "active" ? "Active" : s === "archived" ? "Archived" : "All"}
                </Link>
              </Button>
            ))}
          </nav>
          {workCentres.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-2">Work centre</th>
                    <th className="p-2 text-right">Hours a day</th>
                    <th className="p-2 text-right">Stations</th>
                    <th className="p-2 text-right">Capacity (h/day)</th>
                    <th className="p-2 text-right">Cost per hour</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {workCentres.map((centre) => (
                    <tr key={centre.id} className="border-t">
                      <td className="p-2">
                        <span className="font-medium">{centre.name}</span>{" "}
                        <span className="font-mono text-xs">{centre.code}</span>
                        {centre.status === "archived" && (
                          <Badge variant="secondary" className="ml-2">
                            Archived
                          </Badge>
                        )}
                        {centre.description && (
                          <span className="block text-xs text-muted-foreground">{centre.description}</span>
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums">{centre.hoursPerDay}</td>
                      <td className="p-2 text-right tabular-nums">{centre.stations}</td>
                      <td className="p-2 text-right tabular-nums">{centre.capacityHoursPerDay}</td>
                      <td className="p-2 text-right tabular-nums">
                        {formatCost(centre.costPerHour, currency)}
                      </td>
                      <td className="p-2 text-right">
                        <WorkCentreActions slug={slug} centre={centre} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No work centres yet.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
