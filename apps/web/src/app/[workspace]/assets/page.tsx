import { assetKindLabels, assetKinds, assetListQuerySchema } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { AssetKindBadge } from "@/components/asset-dialog";
import { PageHeader } from "@/components/page-header";
import { getAssets, getMembers } from "@/lib/api";
import { NewAsset } from "./asset-controls";

export const metadata: Metadata = { title: "Assets" };

const PAGE = 50;

/** The asset register: areas, equipment, vehicles, IT, tools and other assets. */
export default async function AssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ workspace: slug }, raw] = await Promise.all([params, searchParams]);
  const parsed = assetListQuerySchema.safeParse({ ...raw, limit: PAGE });
  const query = parsed.success ? parsed.data : assetListQuerySchema.parse({ limit: PAGE });
  const [page, { assets: areas }, { members }] = await Promise.all([
    getAssets(slug, {
      ...(query.q ? { q: query.q } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.areaId ? { areaId: query.areaId } : {}),
      status: query.status,
      limit: String(PAGE),
      offset: String(query.offset),
    }),
    getAssets(slug, { kind: "area", status: "all", limit: "500" }),
    getMembers(slug),
  ]);
  const base = `/${slug}/assets`;
  const href = (patch: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | number | undefined> = {
      q: query.q,
      kind: query.kind,
      areaId: query.areaId,
      status: query.status === "active" ? undefined : query.status,
      ...patch,
    };
    for (const [key, value] of Object.entries(merged))
      if (value !== undefined && value !== "") next.set(key, String(value));
    const qs = next.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const areaChoices = areas.map((a) => ({ id: a.id, name: a.name, code: a.code }));
  const memberChoices = members.filter((m) => !m.deactivatedAt).map((m) => ({ id: m.userId, name: m.name }));
  const areaName = query.areaId ? areas.find((a) => a.id === query.areaId)?.name : undefined;

  return (
    <>
      <PageHeader actions={<NewAsset slug={slug} areas={areaChoices} members={memberChoices} />}>
        <h1 className="font-medium">Assets</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-4 py-4 md:py-6">
          <form action={base} className="flex flex-wrap items-end gap-2" role="search">
            <input
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Search name, code, serial, make or model"
              aria-label="Search assets"
              className="h-8 min-w-60 flex-1 rounded-md border bg-transparent px-2 text-sm"
            />
            {query.kind && <input type="hidden" name="kind" value={query.kind} />}
            {query.areaId && <input type="hidden" name="areaId" value={query.areaId} />}
            {query.status !== "active" && <input type="hidden" name="status" value={query.status} />}
            <Button size="sm" type="submit" variant="outline">
              Search
            </Button>
          </form>
          <nav aria-label="Filter by kind" className="flex flex-wrap gap-1.5">
            <Button size="sm" variant={query.kind ? "ghost" : "secondary"} asChild>
              <Link href={href({ kind: undefined, offset: undefined })}>All kinds</Link>
            </Button>
            {assetKinds.map((kind) => (
              <Button key={kind} size="sm" variant={query.kind === kind ? "secondary" : "ghost"} asChild>
                <Link
                  href={href({ kind, offset: undefined })}
                  aria-current={query.kind === kind ? "page" : undefined}
                >
                  {assetKindLabels[kind]}
                </Link>
              </Button>
            ))}
          </nav>
          <nav aria-label="Filter by status" className="flex flex-wrap items-center gap-1.5 text-sm">
            {(["active", "archived", "all"] as const).map((status) => (
              <Button
                key={status}
                size="sm"
                variant={query.status === status ? "secondary" : "ghost"}
                asChild
              >
                <Link href={href({ status: status === "active" ? undefined : status, offset: undefined })}>
                  {status === "active" ? "Active" : status === "archived" ? "Archived" : "All"}
                </Link>
              </Button>
            ))}
            {areaName && (
              <span className="ml-2 text-muted-foreground">
                In {areaName} ·{" "}
                <Link className="underline" href={href({ areaId: undefined, offset: undefined })}>
                  any area
                </Link>
              </span>
            )}
          </nav>
          {page.assets.length ? (
            <ul className="divide-y rounded-lg border">
              {page.assets.map((asset) => (
                <li key={asset.id}>
                  <Link
                    href={`${base}/${asset.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium break-words">
                        {asset.name} {asset.code && <span className="font-mono text-xs">{asset.code}</span>}
                      </span>
                      <span className="text-muted-foreground">
                        {[
                          asset.parentArea?.name,
                          asset.location,
                          [asset.manufacturer, asset.model].filter(Boolean).join(" "),
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </span>
                    </span>
                    <AssetKindBadge kind={asset.kind} status={asset.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No assets match.
            </p>
          )}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {page.total === 0
                ? "0 assets"
                : `${page.offset + 1}–${page.offset + page.assets.length} of ${page.total}`}
            </span>
            <span className="flex gap-2">
              {page.offset > 0 && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={href({ offset: Math.max(0, page.offset - PAGE) || undefined })}>Previous</Link>
                </Button>
              )}
              {page.offset + page.assets.length < page.total && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={href({ offset: page.offset + PAGE })}>Next</Link>
                </Button>
              )}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
