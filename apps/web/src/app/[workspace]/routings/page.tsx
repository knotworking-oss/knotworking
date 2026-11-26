import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getRecipes, getRoutings } from "@/lib/api";
import { NewRouting } from "./routing-controls";

export const metadata: Metadata = { title: "Routings" };

/** Routings: for each bill of materials, the ordered operations that make it. */
export default async function RoutingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const status = search.status === "archived" || search.status === "all" ? search.status : "active";
  const [page, recipes, all] = await Promise.all([
    getRoutings(slug, { status, ...(search.q ? { q: search.q } : {}) }),
    getRecipes(slug, { status: "active" }),
    getRoutings(slug, { status: "all" }),
  ]);
  const routed = new Set(all.routings.map((r) => r.recipe?.id));
  const boms = recipes.recipes.filter((r) => !routed.has(r.id)).map((r) => ({ id: r.id, code: r.code, name: r.name }));
  const base = `/${slug}/routings`;

  return (
    <>
      <PageHeader actions={<NewRouting slug={slug} boms={boms} />}>
        <h1 className="font-medium">Routings</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          <form action={base} className="flex flex-wrap items-end gap-2" role="search">
            <input
              name="q"
              defaultValue={search.q ?? ""}
              placeholder="Search routing or bill code or name"
              aria-label="Search routings"
              className="h-8 min-w-60 flex-1 rounded-md border bg-transparent px-2 text-sm"
            />
            {status !== "active" && <input type="hidden" name="status" value={status} />}
            <Button size="sm" type="submit" variant="outline">
              Search
            </Button>
          </form>
          <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
            {(["active", "archived", "all"] as const).map((s) => (
              <Button key={s} size="sm" variant={status === s ? "secondary" : "ghost"} asChild>
                <Link href={s === "active" ? base : `${base}?status=${s}`}>
                  {s === "active" ? "Active" : s === "archived" ? "Archived" : "All"}
                </Link>
              </Button>
            ))}
          </nav>
          {page.routings.length ? (
            <ul className="divide-y rounded-lg border">
              {page.routings.map((routing) => (
                <li key={routing.id}>
                  <Link
                    href={`${base}/${routing.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {routing.name} <span className="font-mono text-xs">{routing.code}</span>
                      </span>
                      <span className="text-muted-foreground">
                        {routing.recipe ? `${routing.recipe.code} · ${routing.recipe.name}` : "—"}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      {routing.approvedVersion ? (
                        <Badge>
                          v{routing.approvedVersion.versionNumber} · {routing.approvedVersion.operations} operations
                        </Badge>
                      ) : (
                        <Badge variant="outline">Not approved</Badge>
                      )}
                      {routing.draftVersion && (
                        <Badge variant="secondary">Draft v{routing.draftVersion.versionNumber}</Badge>
                      )}
                      {routing.status === "archived" && <Badge variant="secondary">Archived</Badge>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No routings yet. Give a bill of materials its operations with New routing.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
