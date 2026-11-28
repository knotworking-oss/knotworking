import { serviceQuoteListSchema, serviceQuoteStatusLabels } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { getServiceQuotes } from "@/lib/api";
import { ServiceQuoteEditor } from "./quote-controls";

export const metadata: Metadata = { title: "Client services" };

export default async function ClientServicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const [{ workspace: slug }, rawQuery] = await Promise.all([params, searchParams]);
  const query = serviceQuoteListSchema.safeParse(rawQuery);
  const { quotes, nextCursor } = await getServiceQuotes(slug, query.success ? query.data : {});
  const base = `/${slug}/client-services`;
  return (
    <>
      <PageHeader actions={<ServiceQuoteEditor />}>
        <h1 className="font-medium">Client services</h1>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <div className="workspace-content space-y-4 py-4 md:py-6">
          {quotes.length ? (
            <ul className="divide-y rounded-lg border">
              {quotes.map((quote) => (
                <li key={quote.id}>
                  <Link
                    href={`${base}/${quote.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm hover:bg-muted/60"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium break-words">{quote.title}</span>
                      <span className="text-muted-foreground">
                        {quote.reference} · {quote.recipient.name}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">
                        {quote.quoteTotal} {quote.currency}
                      </span>
                      <Badge variant="secondary">{serviceQuoteStatusLabels[quote.status]}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No service quotes yet.
            </p>
          )}
          {nextCursor && (
            <Button asChild size="sm" variant="outline">
              <Link href={`${base}?before=${nextCursor}`}>Older quotes</Link>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
