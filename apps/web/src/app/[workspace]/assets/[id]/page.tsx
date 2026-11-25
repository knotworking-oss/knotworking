import { assetKindLabels, formatMoney } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AssetKindBadge } from "@/components/asset-dialog";
import { PageHeader } from "@/components/page-header";
import { canReadModule, getAsset, getAssets, getMembers, getWorkspaceCurrency } from "@/lib/api";
import { formatLongDate } from "@/lib/format";
import { AssetActions } from "../asset-controls";

export const metadata: Metadata = { title: "Asset" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AssetPage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  if (!UUID.test(id)) notFound();
  const [asset, { assets: areas }, { members }, currency, haccp, maintenance] = await Promise.all([
    getAsset(slug, id),
    getAssets(slug, { kind: "area", status: "all", limit: "500" }),
    getMembers(slug),
    getWorkspaceCurrency(slug),
    canReadModule(slug, "haccp"),
    canReadModule(slug, "maintenance"),
  ]);
  const inside =
    asset.kind === "area" ? (await getAssets(slug, { areaId: id, status: "all", limit: "200" })).assets : [];
  const base = `/${slug}/assets`;
  const row = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value ?? "—"}</dd>
    </div>
  );

  return (
    <>
      <PageHeader
        actions={
          <AssetActions
            slug={slug}
            asset={asset}
            status={asset.status}
            areas={areas.map((a) => ({ id: a.id, name: a.name, code: a.code }))}
            members={members.filter((m) => !m.deactivatedAt).map((m) => ({ id: m.userId, name: m.name }))}
          />
        }
      >
        <Link href={base} className="text-muted-foreground hover:underline">
          Assets
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="truncate font-medium">{asset.name}</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
          <div className="flex flex-wrap items-center gap-3">
            <AssetKindBadge kind={asset.kind} status={asset.status} />
            {asset.code && <span className="font-mono text-sm">{asset.code}</span>}
          </div>
          <dl className="divide-y rounded-lg border px-4">
            {row("Kind", assetKindLabels[asset.kind])}
            {row(
              asset.kind === "area" ? "Inside area" : "Area",
              asset.parentArea ? (
                <Link className="underline" href={`${base}/${asset.parentArea.id}`}>
                  {asset.parentArea.name}
                </Link>
              ) : null,
            )}
            {row("Location", asset.location)}
            {asset.kind !== "area" && (
              <>
                {row("Manufacturer", asset.manufacturer)}
                {row("Model", asset.model)}
                {row("Serial number", asset.serialNumber)}
                {row("Purchased", asset.purchasedOn ? formatLongDate(asset.purchasedOn) : null)}
                {row("Cost", asset.purchaseCost !== null ? formatMoney(asset.purchaseCost, currency) : null)}
                {row(
                  "Warranty until",
                  asset.warrantyExpiresOn ? formatLongDate(asset.warrantyExpiresOn) : null,
                )}
              </>
            )}
            {row("Looked after by", asset.custodianName)}
            {row("Notes", asset.notes ? <span className="whitespace-pre-wrap">{asset.notes}</span> : null)}
          </dl>
          {(haccp || maintenance) && (
            <div className="flex flex-wrap gap-2 text-sm">
              {haccp && (asset.kind === "area" || asset.kind === "equipment") && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/${slug}/haccp/records`}>Cleaning & calibration</Link>
                </Button>
              )}
              {maintenance && asset.kind !== "area" && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/${slug}/maintenance`}>Planned maintenance</Link>
                </Button>
              )}
            </div>
          )}
          {asset.kind === "area" && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">In this area ({inside.length})</h2>
              {inside.length ? (
                <ul className="divide-y rounded-lg border">
                  {inside.map((a) => (
                    <li key={a.id}>
                      <Link
                        href={`${base}/${a.id}`}
                        className="flex items-center justify-between gap-3 p-3 text-sm hover:bg-muted/60"
                      >
                        <span>
                          {a.name} {a.code && <span className="font-mono text-xs">{a.code}</span>}
                        </span>
                        <AssetKindBadge kind={a.kind} status={a.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing is recorded in this area.</p>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
