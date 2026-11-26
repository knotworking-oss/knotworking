import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import type { Metadata } from "next";
import Link from "next/link";
import { formatCost } from "@/components/costing-badges";
import { PageHeader } from "@/components/page-header";
import { getRouting, getWorkCentres, getWorkspaceCurrency } from "@/lib/api";
import { RoutingEditor, RoutingStatusButton, VersionBadge } from "../routing-controls";

type Props = { params: Promise<{ workspace: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, id } = await params;
  return { title: `Routing ${(await getRouting(workspace, id)).code}` };
}

/** One routing: the editor for its draft, and every version with its operations. */
export default async function RoutingPage({ params }: Props) {
  const { workspace: slug, id } = await params;
  const [routing, { workCentres }, currency] = await Promise.all([
    getRouting(slug, id),
    getWorkCentres(slug, { status: "all" }),
    getWorkspaceCurrency(slug),
  ]);
  return (
    <>
      <PageHeader actions={<RoutingStatusButton slug={slug} routing={routing} />}>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/routings`}>Routings</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{routing.code}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
          <div className="space-y-1">
            <h1 className="text-lg font-medium">{routing.name}</h1>
            <p className="text-sm text-muted-foreground">
              Makes{" "}
              {routing.recipe ? (
                <Link className="underline" href={`/${slug}/recipes/${routing.recipe.id}`}>
                  {routing.recipe.code} · {routing.recipe.name}
                </Link>
              ) : (
                "—"
              )}
              {routing.status === "archived" && " · archived"}
            </p>
            {routing.description && <p className="text-sm">{routing.description}</p>}
          </div>
          <RoutingEditor slug={slug} routing={routing} workCentres={workCentres} />
          {routing.versions.map((version) => (
            <section key={version.id} className="space-y-2" aria-labelledby={`version-${version.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h2 id={`version-${version.id}`} className="font-medium">
                  Version {version.versionNumber}
                </h2>
                <VersionBadge status={version.status} />
                {version.approvedBy && (
                  <span className="text-sm text-muted-foreground">Approved by {version.approvedBy.name}</span>
                )}
              </div>
              {version.changeNote && <p className="text-sm text-muted-foreground">{version.changeNote}</p>}
              {version.operations.length ? (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left">
                      <tr>
                        <th className="p-2">#</th>
                        <th className="p-2">Operation</th>
                        <th className="p-2">Work centre</th>
                        <th className="p-2 text-right">Setup min</th>
                        <th className="p-2 text-right">Run min</th>
                        <th className="p-2 text-right">Cost per yield</th>
                      </tr>
                    </thead>
                    <tbody>
                      {version.operations.map((op) => (
                        <tr key={op.id} className="border-t align-top">
                          <td className="p-2 tabular-nums">{op.position}</td>
                          <td className="p-2">
                            {op.name}
                            {op.instructions && (
                              <span className="block text-xs text-muted-foreground">{op.instructions}</span>
                            )}
                          </td>
                          <td className="p-2">{op.workCentre ? `${op.workCentre.code} · ${op.workCentre.name}` : "—"}</td>
                          <td className="p-2 text-right tabular-nums">{op.setupMinutes}</td>
                          <td className="p-2 text-right tabular-nums">{op.runMinutes}</td>
                          <td className="p-2 text-right tabular-nums">{formatCost(op.expectedCost, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t font-medium">
                        <td className="p-2" colSpan={3}>
                          Total
                        </td>
                        <td className="p-2 text-right tabular-nums">{version.totals.setupMinutes}</td>
                        <td className="p-2 text-right tabular-nums">{version.totals.runMinutes}</td>
                        <td className="p-2 text-right tabular-nums">
                          {formatCost(version.totals.expectedCost, currency)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No operations yet.</p>
              )}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
