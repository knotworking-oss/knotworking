import { addDays } from "@knotworking/core";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@knotworking/ui/components/breadcrumb";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@knotworking/ui/components/table";
import { ShoppingCart } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ShortfallBadge } from "@/components/production-badges";
import { formatAmount } from "@/components/stock-badges";
import { canReadModule, getMaterialRequirements, getWorkspaceToday } from "@/lib/api";
import { recipeTerms } from "@/lib/recipe-terms";

export const metadata: Metadata = { title: "Material requirements" };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Production → material requirements: what the planned and in-progress batches in a date range
 * need of each ingredient or material, against stock usable today. Computed on read; nothing is reserved.
 */
export default async function RequirementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const today = await getWorkspaceToday(slug);
  const from = ISO.test(search.from ?? "") ? search.from! : today;
  let to = ISO.test(search.to ?? "") ? search.to! : addDays(from, 6);
  if (to < from) to = from;
  if (to > addDays(from, 366)) to = addDays(from, 366);
  const [data, purchasing, foodItems] = await Promise.all([
    getMaterialRequirements(slug, from, to),
    canReadModule(slug, "purchasing"),
    canReadModule(slug, "food_items"),
  ]);
  const terms = recipeTerms(foodItems);
  const short = data.requirements.filter((r) => r.shortfall.base > 0).length;

  return (
    <>
      <PageHeader>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${slug}/production?week=${from}`}>Production</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Material requirements</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content flex flex-col gap-6 py-8">
          <form className="flex flex-wrap items-end gap-3">
            <Field className="w-44">
              <FieldLabel htmlFor="req-from">From</FieldLabel>
              <Input id="req-from" name="from" type="date" required defaultValue={from} />
            </Field>
            <Field className="w-44">
              <FieldLabel htmlFor="req-to">To</FieldLabel>
              <Input id="req-to" name="to" type="date" required defaultValue={to} />
            </Field>
            <Button type="submit" variant="outline">
              Show
            </Button>
            {purchasing && short > 0 && (
              <Button variant="outline" asChild className="ml-auto">
                <Link href={`/${slug}/purchasing/suggestions?from=${from}&to=${to}`}>
                  <ShoppingCart data-icon="inline-start" /> Suggest purchase orders
                </Link>
              </Button>
            )}
          </form>

          <p className="text-sm text-muted-foreground">
            {data.batches.length} open batch{data.batches.length === 1 ? "" : "es"} planned between {from} and{" "}
            {to}
            {data.requirements.length > 0 &&
              ` · ${short ? `${short} ${terms.line}${short === 1 ? "" : "s"} short` : "stock covers everything"}`}
            . Available stock is released and not past its use-by date today; quarantined stock is shown
            separately. Nothing is reserved.
          </p>

          {data.requirements.length === 0 ? (
            <p className="text-sm text-muted-foreground">No planned or in-progress batches in this range.</p>
          ) : (
            <Card className="overflow-x-auto py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{terms.lineTitle}</TableHead>
                    <TableHead className="text-right">Required</TableHead>
                    <TableHead className="text-right">Consumed</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Quarantine</TableHead>
                    <TableHead className="pr-4">Cover</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.requirements.map((r) => (
                    <TableRow key={r.item.id} className="align-top">
                      <TableCell className="pl-4 whitespace-normal">
                        <span className="font-medium">{r.item.name}</span>{" "}
                        <span className="font-mono text-xs text-muted-foreground">{r.item.code}</span>
                        <ul className="mt-1 flex flex-col text-xs text-muted-foreground">
                          {r.batches.map((b) => (
                            <li key={b.batchId}>
                              <Link
                                href={`/${slug}/production/batches/${b.batchId}`}
                                className="font-mono hover:underline"
                              >
                                {b.batchCode}
                              </Link>{" "}
                              {b.plannedOn} ·{" "}
                              {b.outstanding ? formatAmount(b.outstanding) : "unit can't be converted"}
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(r.required)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(r.consumed)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(r.outstanding)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <Link
                          href={`/${slug}/stock?q=${encodeURIComponent(r.item.code)}`}
                          className="hover:underline"
                        >
                          {formatAmount(r.available)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {formatAmount(r.quarantine)}
                      </TableCell>
                      <TableCell className="pr-4">
                        <div className="flex flex-col items-start gap-1">
                          <ShortfallBadge shortfall={r.shortfall} />
                          {r.incomplete && (
                            <span className="text-xs text-muted-foreground">
                              A recipe line can&apos;t be converted
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
