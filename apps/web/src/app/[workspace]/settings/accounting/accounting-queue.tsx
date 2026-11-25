"use client";
import Link from "next/link";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const postings = () => browserApi().v1.workspaces[":slug"].accounting.connections[":id"].postings;
type State = "queued" | "unknown" | "failed" | "posted";
type List = Awaited<ReturnType<typeof fetchList>>;
type Item = Awaited<ReturnType<typeof fetchItem>>;

const fetchList = (slug: string, id: string, state: State, offset: number) =>
  unwrap(postings().$get({ param: { slug, id }, query: { state, offset: String(offset) } }));
const fetchItem = (slug: string, id: string, postingId: string) =>
  unwrap(postings()[":postingId"].$get({ param: { slug, id, postingId } }));

const tabs: { state: State; label: string; help: string }[] = [
  { state: "queued", label: "Queued", help: "Prepared and waiting to be sent." },
  {
    state: "unknown",
    label: "Needs checking",
    help: "The send may have reached the accounting system. Check for the original transaction before taking further action.",
  },
  {
    state: "failed",
    label: "Rejected",
    help: "These invoices were rejected before any entry was recorded. Fix the cause, then retry.",
  },
  {
    state: "posted",
    label: "Posted",
    help: "Confirmed by reading the transaction back from the accounting system.",
  },
];
const actionLabels: Record<string, string> = {
  queued: "Prepared",
  dispatch_started: "Sending started",
  reconciled: "Confirmed in accounting system",
  rejected: "Rejected, nothing recorded",
  unknown: "Outcome uncertain",
  deferred: "Not sent yet, back in the queue",
  retry_requested: "Retry requested",
};

/** The finance review of one connection's outbox: queued, uncertain, rejected and posted invoices. */
export function AccountingQueue({
  slug,
  connectionId,
  canReadPurchasing,
  canReadInvoicing,
  onChecked,
}: {
  slug: string;
  connectionId: string;
  canReadPurchasing: boolean;
  canReadInvoicing: boolean;
  onChecked: () => void;
}) {
  const [state, setState] = useState<State>("queued");
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<List | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [reason, setReason] = useState("");
  const [externalId, setExternalId] = useState("");
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
  const load = useCallback(
    (nextState: State, nextOffset: number) =>
      run(async () => {
        setList(await fetchList(slug, connectionId, nextState, nextOffset));
        setState(nextState);
        setOffset(nextOffset);
      }),
    [run, slug, connectionId],
  );
  useEffect(() => {
    void load("queued", 0);
  }, [load]);

  async function open(postingId: string) {
    await run(async () => {
      setItem(await fetchItem(slug, connectionId, postingId));
      setReason("");
      setExternalId("");
    });
  }
  /** After an action: show the result and refresh the list it came from. */
  async function settle(next: Item) {
    setItem(next);
    setReason("");
    setExternalId("");
    setList(await fetchList(slug, connectionId, state, offset));
  }
  const params = (postingId: string) => ({ slug, id: connectionId, postingId });
  const sendNow = (postingId: string) =>
    run(async () => {
      try {
        await settle(await unwrap(postings()[":postingId"].send.$post({ param: params(postingId) })));
      } finally {
        onChecked();
      }
    });
  function retry(e: FormEvent) {
    e.preventDefault();
    const p = item!.posting;
    void run(async () =>
      settle(
        await unwrap(
          postings()[":postingId"].retry.$post({
            param: params(p.id),
            json: { attemptId: p.attemptId!, reason },
          }),
        ),
      ),
    );
  }
  function readBack(e: FormEvent) {
    e.preventDefault();
    const p = item!.posting;
    void run(async () => {
      try {
        await settle(
          await unwrap(
            postings()[":postingId"]["read-back"].$post({
              param: params(p.id),
              json: { attemptId: p.attemptId!, externalId: externalId.trim() || undefined, reason },
            }),
          ),
        );
      } finally {
        onChecked();
      }
    });
  }

  const tab = tabs.find((t) => t.state === state)!;
  const p = item?.posting;
  return (
    <div className="border-t pt-4">
      <h4 className="font-medium">Accounting queue</h4>
      <p className="mt-1 text-sm text-muted-foreground">
        {list?.adapterInstalled
          ? "This connection can send queued invoices."
          : "Queued invoices are on hold until this connection can send."}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Button
            key={t.state}
            type="button"
            size="sm"
            variant={state === t.state ? "default" : "outline"}
            disabled={pending}
            onClick={() => void load(t.state, 0)}
          >
            {t.label}
            {list ? ` (${list.counts[t.state]})` : ""}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{tab.help}</p>
      {list && list.postings.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">Nothing here.</p>
      )}
      {list && list.postings.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Document</th>
                <th className="p-2">Date</th>
                <th className="p-2 text-right">Gross</th>
                <th className="p-2">Attempts</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {list.postings.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="p-2">
                    {row.reference}
                    {row.externalId && (
                      <span className="block text-xs text-muted-foreground">{row.externalId}</span>
                    )}
                  </td>
                  <td className="p-2">{new Date(row.date).toLocaleDateString("en-GB")}</td>
                  <td className="p-2 text-right tabular-nums">
                    {row.gross} {row.currency}
                  </td>
                  <td className="p-2">{row.attempts}</td>
                  <td className="p-2 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => void open(row.id)}
                    >
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || offset === 0}
              onClick={() => void load(state, Math.max(0, offset - 50))}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || !list.hasMore}
              onClick={() => void load(state, offset + 50)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {p && item && (
        <div className="mt-4 rounded-md border p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h5 className="font-medium">
              {p.reference} · {p.gross} {p.currency}
            </h5>
            <Badge variant="secondary">{tabs.find((t) => t.state === p.state)?.label ?? p.state}</Badge>
          </div>
          <p className="mt-1 text-muted-foreground">
            Net {p.payload.net} · Tax {p.payload.tax} · Gross {p.payload.gross} {p.currency}
          </p>
          {canReadPurchasing && p.payload.kind === "purchase_invoice" && (
            <Link className="underline" href={`/${slug}/purchasing/invoices/${p.payload.sourceId}`}>
              Open source purchase invoice
            </Link>
          )}
          {canReadInvoicing && p.payload.kind !== "purchase_invoice" && (
            <Link className="underline" href={`/${slug}/invoicing/${p.payload.sourceId}`}>
              Open source {p.payload.kind === "customer_invoice" ? "invoice" : "credit note"}
            </Link>
          )}
          {p.payload.kind === "customer_credit_note" && (
            <p className="mt-1 text-muted-foreground">
              Original Xero invoice {p.payload.originalInvoice.reference} ·{" "}
              {p.payload.originalInvoice.externalId}
            </p>
          )}
          {p.externalId && (
            <p className="mt-1 text-muted-foreground">Accounting transaction {p.externalId}</p>
          )}
          <ol className="mt-3 flex flex-col gap-2">
            {item.history.map((h) => (
              <li key={h.id}>
                {actionLabels[h.action] ?? h.action}
                <span className="block text-xs text-muted-foreground">
                  {h.actor} · {new Date(h.createdAt).toLocaleString("en-GB")} · {h.evidence}
                </span>
              </li>
            ))}
          </ol>
          {p.state === "queued" && list?.adapterInstalled && (
            <Button type="button" className="mt-3" disabled={pending} onClick={() => void sendNow(p.id)}>
              Send now
            </Button>
          )}
          {p.state === "failed" && (
            <form onSubmit={retry} className="mt-3 flex flex-col gap-3 border-t pt-3">
              <Field>
                <FieldLabel htmlFor="retry-reason">What was fixed</FieldLabel>
                <Input
                  id="retry-reason"
                  required
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <FieldDescription>Retrying sends the same prepared invoice again.</FieldDescription>
              </Field>
              <div>
                <Button type="submit" disabled={pending}>
                  Retry
                </Button>
              </div>
            </form>
          )}
          {p.state === "unknown" &&
            (list?.canReadBack ? (
              <form onSubmit={readBack} className="mt-3 flex flex-col gap-3 border-t pt-3">
                <Field>
                  <FieldLabel htmlFor="external-id">Transaction ID in the accounting system</FieldLabel>
                  <Input
                    id="external-id"
                    required={!list.canFindExisting}
                    maxLength={200}
                    value={externalId}
                    onChange={(e) => setExternalId(e.target.value)}
                  />
                  <FieldDescription>
                    {list.canFindExisting && "Leave blank to search Xero for the original bill. "}
                    Matching the transaction confirms the posting.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="read-back-reason">Review note</FieldLabel>
                  <Input
                    id="read-back-reason"
                    required
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <div>
                  <Button type="submit" disabled={pending}>
                    {list.canFindExisting && !externalId.trim()
                      ? "Find and verify in Xero"
                      : "Check and confirm"}
                  </Button>
                </div>
              </form>
            ) : (
              <p className="mt-3 text-muted-foreground">
                Checking needs an installed adapter that can read transactions back. Until then this invoice
                stays uncertain and is not resent.
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
