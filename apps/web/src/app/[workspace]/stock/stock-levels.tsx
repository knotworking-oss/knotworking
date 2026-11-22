"use client";

import { itemTypeLabels, itemTypes, type ItemType, type StockAmount } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@knotworking/ui/components/select";
import { Spinner } from "@knotworking/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ChevronDown, ChevronRight, MapPin, PackagePlus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ExpiryBadge, formatAmount, LotStatusBadge } from "@/components/stock-badges";
import type { Item, StockLevel, StockLocation, StockLot, Supplier } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import { ReceiveDialog } from "./receive-dialog";

interface Filters {
  q?: string | undefined;
  type?: ItemType | undefined;
  location?: string | undefined;
  expiring?: "7" | "30" | undefined;
}

const ANY = "any";

/** Stock → one row per item; a row opens to its lots with balances per location. */
export function StockLevels({
  slug,
  levels,
  total,
  locations,
  items,
  suppliers,
  filters,
  availability,
}: {
  slug: string;
  levels: StockLevel[];
  total: number;
  locations: StockLocation[];
  items: Item[];
  suppliers: Supplier[];
  filters: Filters;
  /** Per item: reserved for production batches and what is free of it. Only for people who can read production. */
  availability?: Record<string, { reserved: StockAmount; free: StockAmount }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("stock", "write");
  const [query, setQuery] = useState(filters.q ?? "");
  const [receiving, setReceiving] = useState(false);
  const [open, setOpen] = useState<Record<string, StockLot[] | "loading">>({});
  // Expanded lots are a query cache, and must not survive a refreshed stock snapshot.
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setOpen({});
  }, [levels]);

  function applyFilters(next: Partial<Filters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.type) params.set("type", merged.type);
    if (merged.location) params.set("location", merged.location);
    if (merged.expiring) params.set("expiring", merged.expiring);
    generation.current++;
    setOpen({});
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  }

  async function toggle(itemId: string) {
    if (open[itemId]) {
      setOpen(({ [itemId]: _closed, ...rest }) => rest);
      return;
    }
    const startedAt = generation.current;
    setOpen((o) => ({ ...o, [itemId]: "loading" }));
    try {
      const { lots } = await unwrap(
        browserApi().v1.workspaces[":slug"].stock.lots.$get({
          param: { slug },
          query: {
            itemId,
            limit: "200",
            ...(filters.location ? { locationId: filters.location } : {}),
            ...(filters.expiring ? { expiringWithinDays: filters.expiring } : {}),
          },
        }),
      );
      if (startedAt === generation.current) setOpen((o) => ({ ...o, [itemId]: lots }));
    } catch (err) {
      if (startedAt !== generation.current) return;
      toast.error(errorMessage(err));
      setOpen(({ [itemId]: _failed, ...rest }) => rest);
    }
  }

  const filtered = Boolean(filters.q || filters.type || filters.location || filters.expiring);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Stock</h2>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "item" : "items"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/${slug}/stock/locations`}>
              <MapPin data-icon="inline-start" /> Locations
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`/${slug}/stock/release-rules`}>
              <ShieldCheck data-icon="inline-start" /> Release rules
            </Link>
          </Button>
          {canWrite && (
            <Button onClick={() => setReceiving(true)} disabled={locations.length === 0}>
              <PackagePlus data-icon="inline-start" /> Receive stock
            </Button>
          )}
        </div>
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters({ q: query.trim() || undefined });
        }}
      >
        <Input
          className="w-64"
          placeholder="Search item name or code"
          aria-label="Search stock"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={filters.type ?? ANY}
          onValueChange={(v) => applyFilters({ type: v === ANY ? undefined : (v as ItemType) })}
        >
          <SelectTrigger className="w-44" aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>All types</SelectItem>
              {itemTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {itemTypeLabels[t]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={filters.location ?? ANY}
          onValueChange={(v) => applyFilters({ location: v === ANY ? undefined : v })}
        >
          <SelectTrigger className="w-48" aria-label="Location">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>All locations</SelectItem>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={filters.expiring ?? ANY}
          onValueChange={(v) => applyFilters({ expiring: v === ANY ? undefined : (v as "7" | "30") })}
        >
          <SelectTrigger className="w-52" aria-label="Expiry">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>Any expiry</SelectItem>
              <SelectItem value="7">Expiring within 7 days</SelectItem>
              <SelectItem value="30">Expiring within 30 days</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </form>

      {levels.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filtered
            ? "No stock matches these filters."
            : locations.length === 0
              ? "No stock yet. Add a location, then receive your first delivery."
              : "No stock yet. Receive a delivery to get started."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 pl-4" />
                <TableHead>Item</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Held</TableHead>
                {availability && <TableHead className="text-right">Reserved</TableHead>}
                {availability && <TableHead className="text-right">Free</TableHead>}
                <TableHead className="text-right">Lots</TableHead>
                <TableHead className="pr-4">Earliest expiry</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {levels.map((level) => {
                const lots = open[level.item.id];
                const held = level.quarantine.base + level.rejected.base;
                return (
                  <Fragment key={level.item.id}>
                    <TableRow className="cursor-pointer" onClick={() => void toggle(level.item.id)}>
                      <TableCell className="pl-4 text-muted-foreground">
                        {lots ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left font-medium hover:underline"
                          aria-expanded={Boolean(lots)}
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggle(level.item.id);
                          }}
                        >
                          {level.item.name}
                        </button>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {level.item.code}
                        </span>
                      </TableCell>
                      <TableCell>{itemTypeLabels[level.item.type]}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(level.onHand)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatAmount(level.available)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {held
                          ? formatAmount({
                              display: level.quarantine.display + level.rejected.display,
                              displayUnit: level.quarantine.displayUnit,
                            })
                          : "—"}
                      </TableCell>
                      {availability && (
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          {availability[level.item.id]?.reserved.base
                            ? formatAmount(availability[level.item.id]!.reserved)
                            : "—"}
                        </TableCell>
                      )}
                      {availability && (
                        <TableCell className="text-right tabular-nums">
                          {availability[level.item.id]
                            ? formatAmount(availability[level.item.id]!.free)
                            : "—"}
                        </TableCell>
                      )}
                      <TableCell className="text-right tabular-nums">{level.lotCount}</TableCell>
                      <TableCell className="pr-4">
                        <ExpiryBadge expiresOn={level.earliestExpiry} expiryType={null} empty="—" />
                      </TableCell>
                    </TableRow>
                    {lots && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={7} className="pr-4">
                          {lots === "loading" ? (
                            <Spinner />
                          ) : lots.length === 0 ? (
                            <span className="text-muted-foreground">No lots match.</span>
                          ) : (
                            <LotRows slug={slug} lots={lots} />
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {receiving && (
        <ReceiveDialog
          slug={slug}
          items={items}
          suppliers={suppliers}
          locations={locations}
          canManage={can("stock", "manage")}
          onClose={() => setReceiving(false)}
        />
      )}
    </div>
  );
}

function LotRows({ slug, lots }: { slug: string; lots: StockLot[] }) {
  return (
    <ul className="flex flex-col divide-y">
      {lots.map((lot) => (
        <li key={lot.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
          <Link
            href={`/${slug}/stock/lots/${lot.id}`}
            className="font-mono text-xs font-medium hover:underline"
          >
            {lot.lotCode}
          </Link>
          <LotStatusBadge status={lot.status} />
          <ExpiryBadge expiresOn={lot.expiresOn} expiryType={lot.expiryType} />
          <span className="text-muted-foreground">
            {lot.balances.map((b) => `${b.locationName}: ${formatAmount(b.amount)}`).join(" · ")}
          </span>
          {lot.supplierLotCode && (
            <span className="text-xs text-muted-foreground">
              {lot.supplierName ? `${lot.supplierName} ` : "Supplier "}lot {lot.supplierLotCode}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
