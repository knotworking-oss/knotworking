"use client";

import { demandSourceLabels, demandSources, type DemandSource } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knotworking/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knotworking/ui/components/dialog";
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
import { History, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DemandSourceBadge, weekLabel } from "@/components/demand-badges";
import { formatAmount } from "@/components/stock-badges";
import type { DemandImport, DemandLine } from "@/lib/api";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { relativeTime } from "@/lib/relative-time";
import { useWorkspace } from "@/lib/workspace-store";
import { DemandNav } from "../demand-nav";

interface Filters {
  q?: string | undefined;
  customer?: string | undefined;
  source?: DemandSource | undefined;
  from?: string | undefined;
  to?: string | undefined;
  importId?: string | undefined;
}

const ANY = "any";

/** Demand → Lines and imports: every live line with where it came from, its history, and recent imports. */
export function DemandLines({
  slug,
  lines,
  total,
  offset,
  limit,
  imports,
  filters,
}: {
  slug: string;
  lines: DemandLine[];
  total: number;
  offset: number;
  limit: number;
  imports: DemandImport[];
  filters: Filters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useWorkspace();
  const canWrite = can("demand", "write");
  const [draft, setDraft] = useState({
    q: filters.q ?? "",
    customer: filters.customer ?? "",
    from: filters.from ?? "",
    to: filters.to ?? "",
  });
  const [history, setHistory] = useState<DemandLine | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  function navigate(next: Partial<Filters>, nextOffset = 0) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    if (nextOffset) params.set("offset", String(nextOffset));
    router.replace(params.size ? `${pathname}?${params}` : pathname);
  }

  async function remove(line: DemandLine) {
    setDeleting(line.id);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].demand.lines[":id"].$delete({ param: { slug, id: line.id } }),
      );
      toast.success(`Removed ${line.item.code} ${line.week}${line.customer ? ` for ${line.customer}` : ""}`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(null);
    }
  }

  const filtered = Object.values(filters).some(Boolean);
  const importName = (id: string) => imports.find((i) => i.id === id)?.fileName ?? "an import";

  return (
    <div className="workspace-content flex flex-col gap-4 py-8">
      <div className="flex flex-col gap-2">
        <DemandNav slug={slug} current="lines" />
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Demand lines</h2>
          <p className="text-sm text-muted-foreground">
            {total} {total === 1 ? "line" : "lines"}
            {filters.importId && <> from {importName(filters.importId)}</>}
          </p>
        </div>
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          navigate({
            q: draft.q.trim() || undefined,
            customer: draft.customer.trim() || undefined,
            from: draft.from.trim() || undefined,
            to: draft.to.trim() || undefined,
          });
        }}
      >
        <Input
          className="w-56"
          placeholder="Product name or code"
          aria-label="Search products"
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
        />
        <Input
          className="w-40"
          placeholder="Customer"
          aria-label="Customer"
          value={draft.customer}
          onChange={(e) => setDraft({ ...draft, customer: e.target.value })}
        />
        <Input
          className="w-32"
          placeholder="From 2026-W46"
          aria-label="From week or date"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
        <Input
          className="w-32"
          placeholder="To 2026-W52"
          aria-label="To week or date"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
        <Select
          value={filters.source ?? ANY}
          onValueChange={(v) => navigate({ source: v === ANY ? undefined : (v as DemandSource) })}
        >
          <SelectTrigger className="w-40" aria-label="Source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ANY}>Any source</SelectItem>
              {demandSources.map((s) => (
                <SelectItem key={s} value={s}>
                  {demandSourceLabels[s]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
        {filtered && (
          <Button type="button" variant="ghost" onClick={() => router.replace(pathname)}>
            Clear
          </Button>
        )}
      </form>

      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filtered
            ? "No demand lines match these filters."
            : "No demand yet. Enter it on the Plan, or import a CSV file."}
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Week</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Last change</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="pl-4 tabular-nums" title={weekLabel(line.periodStart)}>
                    {line.week}
                  </TableCell>
                  <TableCell>
                    {line.item.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{line.item.code}</span>
                  </TableCell>
                  <TableCell className={line.customer ? "" : "text-muted-foreground"}>
                    {line.customer ?? "Any"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAmount(line.amount)}
                    {line.enteredUnit && line.enteredQuantity !== null && (
                      <span className="block text-xs text-muted-foreground">
                        entered as {line.enteredQuantity.toLocaleString("en-GB")} {line.enteredUnit}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DemandSourceBadge source={line.source} />
                  </TableCell>
                  <TableCell
                    className="max-w-56 truncate text-muted-foreground"
                    title={line.note ?? undefined}
                  >
                    {line.note}
                    {line.externalRef && <span className="ml-1 font-mono text-xs">{line.externalRef}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {line.updatedByName ?? "Someone"}, {relativeTime(line.updatedAt)}
                  </TableCell>
                  <TableCell className="pr-4 text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" aria-label="History" onClick={() => setHistory(line)}>
                      <History />
                    </Button>
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove line"
                        disabled={deleting === line.id}
                        onClick={() => void remove(line)}
                      >
                        {deleting === line.id ? <Spinner /> : <Trash2 />}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {total > limit && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          {offset + 1}–{Math.min(offset + lines.length, total)} of {total}
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => navigate({}, Math.max(0, offset - limit))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + limit >= total}
            onClick={() => navigate({}, offset + limit)}
          >
            Next
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent imports</CardTitle>
        </CardHeader>
        <CardContent>
          {imports.length === 0 ? (
            <p className="text-sm text-muted-foreground">No CSV imports yet.</p>
          ) : (
            <ul className="flex flex-col divide-y text-sm">
              {imports.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                  <Link
                    href={`/${slug}/demand/lines?importId=${i.id}`}
                    className="font-medium hover:underline"
                  >
                    {i.fileName ?? "Pasted CSV"}
                  </Link>
                  <span className="text-muted-foreground">
                    {i.actorName ?? "Someone"}, {relativeTime(i.createdAt)}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {i.rowCount} rows: {i.createdCount} new, {i.updatedCount} changed, {i.unchangedCount}{" "}
                    unchanged
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {history && <HistoryDialog slug={slug} line={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

type HistoryData = Awaited<ReturnType<typeof loadHistory>>;
const loadHistory = (slug: string, id: string) =>
  unwrap(browserApi().v1.workspaces[":slug"].demand.lines[":id"].history.$get({ param: { slug, id } }));

const historyLabels = { create: "Set", update: "Changed", remove: "Removed" } as const;

/** Every change to one product, week and customer: what it was and became, who, how and when. */
function HistoryDialog({ slug, line, onClose }: { slug: string; line: DemandLine; onClose: () => void }) {
  const [data, setData] = useState<HistoryData | null>(null);
  useEffect(() => {
    let live = true;
    loadHistory(slug, line.id)
      .then((d) => live && setData(d))
      .catch((err) => toast.error(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [slug, line.id]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {line.item.code} · {line.week}
            {line.customer ? ` · ${line.customer}` : ""}
          </DialogTitle>
          <DialogDescription>
            {line.item.name}, {weekLabel(line.periodStart)}. Every change is kept.
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <Spinner />
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead className="text-right">Was</TableHead>
                  <TableHead className="text-right">Became</TableHead>
                  <TableHead className="pr-3">Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="pl-3" title={new Date(h.createdAt).toLocaleString("en-GB")}>
                      {relativeTime(h.createdAt)}
                    </TableCell>
                    <TableCell>{h.actorName ?? "Someone"}</TableCell>
                    <TableCell>{historyLabels[h.action]}</TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {h.previous ? formatAmount(h.previous) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.amount ? formatAmount(h.amount) : "—"}
                      {h.enteredUnit && h.enteredQuantity !== null && (
                        <span className="block text-xs text-muted-foreground">
                          entered as {h.enteredQuantity.toLocaleString("en-GB")} {h.enteredUnit}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="pr-3">
                      <DemandSourceBadge source={h.source} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
