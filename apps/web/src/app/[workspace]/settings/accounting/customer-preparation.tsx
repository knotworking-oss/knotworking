"use client";

import { newId } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Textarea } from "@knotworking/ui/components/textarea";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const api = () => browserApi().v1.workspaces[":slug"].accounting.connections[":id"]["customer-documents"];
const loadPage = (slug: string, id: string, offset: number) =>
  unwrap(api().$get({ param: { slug, id }, query: { offset: String(offset) } }));
const loadDocument = (slug: string, id: string, invoiceId: string) =>
  unwrap(api()[":invoiceId"].$get({ param: { slug, id, invoiceId } }));
const selectClass = "h-9 max-w-full rounded-md border bg-background px-2 text-sm";

export function CustomerPreparation({
  slug,
  connectionId,
  onPrepared,
}: {
  slug: string;
  connectionId: string;
  onPrepared: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Awaited<ReturnType<typeof loadPage>> | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof loadDocument>> | null>(null);
  const [commandId, setCommandId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const run = useCallback(async (action: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }, []);
  const pageAt = useCallback(
    (next: number) =>
      run(async () => {
        setPage(await loadPage(slug, connectionId, next));
        setOffset(next);
      }),
    [connectionId, run, slug],
  );

  useEffect(() => {
    void pageAt(0);
  }, [pageAt]);

  function review(invoiceId: string) {
    return run(async () => {
      setDetail(await loadDocument(slug, connectionId, invoiceId));
      setCommandId(newId());
    });
  }

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !commandId) return;
    const data = new FormData(event.currentTarget);
    await run(async () => {
      await unwrap(
        api()[":invoiceId"].prepare.$post({
          param: { slug, id: connectionId, invoiceId: detail.document.id },
          json: {
            commandId,
            expectedRevision: detail.connectionRevision,
            reason: String(data.get("reason") ?? ""),
            allocate: data.has("allocate"),
            lines: detail.original
              ? []
              : detail.document.lines.map((line) => ({
                  id: line.id,
                  accountKey: String(data.get(`account-${line.id}`) ?? ""),
                  taxKey: String(data.get(`tax-${line.id}`) ?? ""),
                })),
          },
        }),
      );
      onPrepared();
      setDetail(await loadDocument(slug, connectionId, detail.document.id));
      setPage(await loadPage(slug, connectionId, offset));
    });
  }

  return (
    <section className="space-y-3 border-t pt-4">
      <h4 className="font-medium">Prepare customer invoices and credit notes</h4>
      {page?.documents.length ? (
        <>
          <ul className="divide-y rounded-md border">
            {page.documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                <span>
                  {doc.number} · {doc.customer.name}
                  <br />
                  <span className="text-muted-foreground">
                    {doc.currency} {doc.gross} · {doc.postingState ?? "Awaiting review"}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => void review(doc.id)}
                >
                  Review
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || offset === 0}
              onClick={() => void pageAt(Math.max(0, offset - 50))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || !page.hasMore}
              onClick={() => void pageAt(offset + 50)}
            >
              Next
            </Button>
          </div>
        </>
      ) : (
        page && <p className="text-sm text-muted-foreground">No issued customer documents.</p>
      )}
      {detail && (
        <div className="space-y-3 rounded-lg border p-3 text-sm">
          <h5 className="font-medium">
            <Link className="underline" href={`/${slug}/invoicing/${detail.document.id}`}>
              {detail.document.number}
            </Link>{" "}
            · {detail.document.customer}
          </h5>
          <p>
            Net {detail.document.net} · Tax {detail.document.tax} · Total {detail.document.gross}{" "}
            {detail.document.currency}
          </p>
          {detail.mappings.customer && (
            <p className="break-all text-muted-foreground">Xero Contact ID {detail.mappings.customer}</p>
          )}
          {detail.original?.externalId && (
            <p className="break-all text-muted-foreground">
              Original invoice {detail.original.number} · Xero ID {detail.original.externalId}
            </p>
          )}
          {detail.posting ? (
            <p className="capitalize">
              Posting {detail.posting.state}
              {detail.posting.externalId && ` · ${detail.posting.externalId}`}
            </p>
          ) : detail.blockers.length ? (
            <ul className="list-inside list-disc">
              {detail.blockers.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : (
            <form key={commandId} onSubmit={prepare} className="space-y-3">
              <fieldset className="space-y-2" disabled={pending}>
                {detail.document.lines.map((line, index) => (
                  <div key={line.id} className="space-y-2 rounded-md border p-2">
                    <p>
                      {line.description} · {line.net} net · {line.tax} tax ({line.taxRate}%)
                    </p>
                    {detail.original ? (
                      <p className="text-muted-foreground">
                        Original account {detail.original.coding[index]?.accountReference} · Tax{" "}
                        {detail.original.coding[index]?.taxReference}
                      </p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="grid gap-1">
                          Revenue account
                          <select
                            className={selectClass}
                            name={`account-${line.id}`}
                            required
                            defaultValue=""
                          >
                            <option value="">Choose mapping</option>
                            {detail.mappings.accounts.map((mapping) => (
                              <option key={mapping.key} value={mapping.key}>
                                {mapping.key} · {mapping.value}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="grid gap-1">
                          Tax type
                          <select className={selectClass} name={`tax-${line.id}`} required defaultValue="">
                            <option value="">Choose mapping</option>
                            {detail.mappings.taxes.map((mapping) => (
                              <option key={mapping.key} value={mapping.key}>
                                {mapping.key} · {mapping.value}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                  </div>
                ))}
                {detail.original && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="allocate" />
                    Allocate the full credit to the original invoice in Xero
                  </label>
                )}
                <label className="grid gap-1">
                  Review reason
                  <Textarea name="reason" required maxLength={2000} />
                </label>
              </fieldset>
              <Button type="submit" disabled={pending}>
                Queue for Xero
              </Button>
            </form>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
