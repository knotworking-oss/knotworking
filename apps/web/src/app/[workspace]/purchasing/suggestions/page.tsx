import { addDays, PURCHASE_SUGGESTIONS_DEFAULT_DAYS, PURCHASE_SUGGESTIONS_MAX_DAYS } from "@knotworking/core";
import { Alert, AlertDescription, AlertTitle } from "@knotworking/ui/components/alert";
import { Button } from "@knotworking/ui/components/button";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { Factory } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PurchasingNav } from "@/components/purchasing-nav";
import { getPurchaseSuggestions, getWorkspaceToday } from "@/lib/api";
import { loadOrderOptions } from "../options";
import { SuggestionsBoard } from "./suggestions-board";

export const metadata: Metadata = { title: "Purchase suggestions" };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What to order: production's material shortfall for a date range, less what sent orders still
 * have to bring, grouped by each item's preferred supplier. Computed on read.
 */
export default async function SuggestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [{ workspace: slug }, search] = await Promise.all([params, searchParams]);
  const today = await getWorkspaceToday(slug);
  const from = ISO.test(search.from ?? "") ? search.from! : today;
  let to = ISO.test(search.to ?? "") ? search.to! : addDays(from, PURCHASE_SUGGESTIONS_DEFAULT_DAYS);
  if (to < from) to = from;
  if (to > addDays(from, PURCHASE_SUGGESTIONS_MAX_DAYS)) to = addDays(from, PURCHASE_SUGGESTIONS_MAX_DAYS);
  const [result, options] = await Promise.all([
    getPurchaseSuggestions(slug, { from, to }),
    loadOrderOptions(slug),
  ]);
  return (
    <>
      <PageHeader>
        <h1 className="font-medium">Purchasing</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
          <PurchasingNav slug={slug} />
          <h2 className="text-xl font-semibold tracking-tight">Suggestions</h2>
          <form className="flex flex-wrap items-end gap-3">
            <Field className="w-44">
              <FieldLabel htmlFor="sug-from">Batches from</FieldLabel>
              <Input id="sug-from" name="from" type="date" required defaultValue={from} />
            </Field>
            <Field className="w-44">
              <FieldLabel htmlFor="sug-to">To</FieldLabel>
              <Input id="sug-to" name="to" type="date" required defaultValue={to} />
            </Field>
            <Button type="submit" variant="outline">
              Show
            </Button>
          </form>
          {result.data ? (
            <SuggestionsBoard slug={slug} data={result.data} options={options} />
          ) : (
            <Alert>
              <Factory />
              <AlertTitle>Suggestions need production</AlertTitle>
              <AlertDescription>
                {result.unavailable}. Orders can still be raised by hand on the Orders tab.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </>
  );
}
