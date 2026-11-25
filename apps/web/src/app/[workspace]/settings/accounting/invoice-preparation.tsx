"use client";
import { newId } from "@knotworking/core";
import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@knotworking/ui/components/field";
import { Input } from "@knotworking/ui/components/input";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const invoices = () => browserApi().v1.workspaces[":slug"].accounting.connections[":id"]["purchase-invoices"];
type Detail = Awaited<ReturnType<typeof fetchDetail>>;
type Row = Awaited<ReturnType<typeof fetchList>>["invoices"][number];
type Coding = { accountKey: string; taxKey: string; description: string; net: string; tax: string };
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const stateLabels: Record<string, string> = {
  queued: "Queued",
  unknown: "Awaiting confirmation",
  failed: "Failed",
  posted: "Posted",
};

const fetchList = (slug: string, id: string, offset: number, show: "open" | "all") =>
  unwrap(invoices().$get({ param: { slug, id }, query: { offset: String(offset), show } }));
const fetchDetail = (slug: string, id: string, invoiceId: string) =>
  unwrap(invoices()[":invoiceId"].$get({ param: { slug, id, invoiceId } }));

/** Sums decimal strings with `digits` places exactly; null when one isn't a valid amount. */
function sum(values: string[], digits: number) {
  const pattern = new RegExp(`^\\d+${digits ? `\\.\\d{${digits}}` : ""}$`);
  if (values.some((v) => !pattern.test(v))) return null;
  const total = values.reduce((acc, v) => acc + BigInt(v.replace(".", "")), 0n);
  const text = total.toString().padStart(digits + 1, "0");
  return digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
}

/**
 * Codes an approved purchase invoice for one connection and queues it: the reviewer picks each
 * line's account and tax keys and enters the net and tax printed on the supplier's invoice.
 */
export function InvoicePreparation({ slug, connectionId }: { slug: string; connectionId: string }) {
  const [show, setShow] = useState<"open" | "all">("open");
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<{ invoices: Row[]; hasMore: boolean } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [coding, setCoding] = useState<Record<string, Coding>>({});
  const [reason, setReason] = useState("");
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
  const loadList = useCallback(
    (nextOffset: number, nextShow: "open" | "all") =>
      run(async () => {
        setList(await fetchList(slug, connectionId, nextOffset, nextShow));
        setOffset(nextOffset);
        setShow(nextShow);
      }),
    [run, slug, connectionId],
  );
  useEffect(() => {
    void loadList(0, "open");
  }, [loadList]);

  async function open(invoiceId: string) {
    await run(async () => {
      const next = await fetchDetail(slug, connectionId, invoiceId);
      setDetail(next);
      setReason("");
      const single = next.lines.length === 1;
      setCoding(
        Object.fromEntries(
          next.lines.map((l) => [
            l.id,
            {
              // A non-stock order line's nominal code, when it is a mapped account key.
              accountKey:
                l.suggestedAccountKey ?? (next.accountKeys.length === 1 ? next.accountKeys[0]! : ""),
              taxKey: next.taxKeys.length === 1 ? next.taxKeys[0]! : "",
              description: l.description.slice(0, 200),
              net: l.suggestedNet,
              tax: single && next.invoice.vat ? next.invoice.vat : "",
            },
          ]),
        ),
      );
    });
  }
  const edit = (lineId: string, patch: Partial<Coding>) =>
    setCoding((c) => ({ ...c, [lineId]: { ...c[lineId]!, ...patch } }));

  async function prepare(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    await run(async () => {
      await unwrap(
        invoices()[":invoiceId"].prepare.$post({
          param: { slug, id: connectionId, invoiceId: detail.invoice.id },
          json: {
            commandId: newId(),
            expectedRevision: detail.connection.revision,
            reason,
            lines: detail.lines.map((l) => ({ invoiceLineId: l.id, ...coding[l.id]! })),
          },
        }),
      );
      setDetail(await fetchDetail(slug, connectionId, detail.invoice.id));
      setList(await fetchList(slug, connectionId, offset, show));
    });
  }

  const digits = detail?.invoice.vat?.split(".")[1]?.length ?? 2;
  const allocated = detail
    ? sum(
        detail.lines.map((l) => coding[l.id]?.tax ?? ""),
        digits,
      )
    : null;
  const net = detail
    ? sum(
        detail.lines.map((l) => coding[l.id]?.net ?? ""),
        digits,
      )
    : null;

  return (
    <div className="border-t pt-4">
      <h4 className="font-medium">Prepare approved invoices</h4>
      <p className="mt-1 text-sm text-muted-foreground">
        Code each line with an account and tax key and the net and tax printed on the supplier&apos;s invoice.
        Line tax must add up to the invoice VAT. A prepared invoice is fixed; it waits in a private queue
        until an accounting adapter sends it.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={show === "open" ? "default" : "outline"}
          disabled={pending}
          onClick={() => void loadList(0, "open")}
        >
          Not yet prepared
        </Button>
        <Button
          type="button"
          size="sm"
          variant={show === "all" ? "default" : "outline"}
          disabled={pending}
          onClick={() => void loadList(0, "all")}
        >
          All approved
        </Button>
      </div>
      {list && list.invoices.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {show === "open" ? "Every approved invoice has been prepared." : "No approved invoices."}
        </p>
      )}
      {list && list.invoices.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Invoice</th>
                <th className="p-2">Supplier</th>
                <th className="p-2">Date</th>
                <th className="p-2">Accounting</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {list.invoices.map((i) => (
                <tr key={i.id} className="border-t">
                  <td className="p-2">
                    {i.invoiceNumber}
                    {i.version > 1 && <span className="text-muted-foreground"> v{i.version}</span>}
                  </td>
                  <td className="p-2">{i.supplierName}</td>
                  <td className="p-2">{new Date(i.invoiceDate).toLocaleDateString("en-GB")}</td>
                  <td className="p-2">
                    {i.postingState ? (
                      <Badge variant="secondary">{stateLabels[i.postingState] ?? i.postingState}</Badge>
                    ) : (
                      <span className="text-muted-foreground">Not prepared</span>
                    )}
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => void open(i.id)}
                    >
                      {i.postingState ? "View" : "Code lines"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || offset === 0}
              onClick={() => void loadList(Math.max(0, offset - 50), show)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || !list.hasMore}
              onClick={() => void loadList(offset + 50, show)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {detail && (
        <div className="mt-4 rounded-md border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h5 className="font-medium">
              {detail.invoice.invoiceNumber}
              {detail.invoice.version > 1 && ` v${detail.invoice.version}`} · {detail.invoice.supplier.name}
            </h5>
            <span className="text-sm text-muted-foreground">
              VAT {detail.invoice.vat ?? "—"} {detail.invoice.currency}
            </span>
          </div>
          {detail.posting ? (
            <div className="mt-3 text-sm">
              <p>
                <Badge variant="secondary">{stateLabels[detail.posting.state] ?? detail.posting.state}</Badge>{" "}
                Net {detail.posting.payload.net} · Tax {detail.posting.payload.tax} · Gross{" "}
                {detail.posting.payload.gross} {detail.posting.payload.currency}
              </p>
              <table className="mt-3 w-full text-left">
                <thead>
                  <tr>
                    <th className="p-2">Description</th>
                    <th className="p-2">Account</th>
                    <th className="p-2">Tax code</th>
                    <th className="p-2 text-right">Net</th>
                    <th className="p-2 text-right">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.posting.payload.lines.map((l, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-2">{l.description}</td>
                      <td className="p-2">{l.accountReference}</td>
                      <td className="p-2">{l.taxReference}</td>
                      <td className="p-2 text-right tabular-nums">{l.net}</td>
                      <td className="p-2 text-right tabular-nums">{l.tax}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">
                References are as sent to the accounting software when prepared.
              </p>
            </div>
          ) : detail.blockers.length > 0 ? (
            <ul className="mt-3 list-disc pl-5 text-sm text-destructive">
              {detail.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            <form onSubmit={prepare} className="mt-3 flex flex-col gap-3">
              {detail.lines.map((l) => {
                const c = coding[l.id]!;
                return (
                  <div key={l.id} className="grid gap-2 border-t pt-3 sm:grid-cols-6">
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor={`desc-${l.id}`}>Line {l.lineNo}</FieldLabel>
                      <Input
                        id={`desc-${l.id}`}
                        required
                        maxLength={200}
                        value={c.description}
                        onChange={(e) => edit(l.id, { description: e.target.value })}
                      />
                      <FieldDescription>
                        {l.quantity} {l.unit ?? ""} × {l.unitPrice} = {l.exactValue}
                        {l.nominalCode ? ` · ordered against ${l.nominalCode}` : ""}
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`account-${l.id}`}>Account</FieldLabel>
                      <select
                        id={`account-${l.id}`}
                        required
                        className={selectClass}
                        value={c.accountKey}
                        onChange={(e) => edit(l.id, { accountKey: e.target.value })}
                      >
                        <option value="">Choose</option>
                        {detail.accountKeys.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`tax-key-${l.id}`}>Tax</FieldLabel>
                      <select
                        id={`tax-key-${l.id}`}
                        required
                        className={selectClass}
                        value={c.taxKey}
                        onChange={(e) => edit(l.id, { taxKey: e.target.value })}
                      >
                        <option value="">Choose</option>
                        {detail.taxKeys.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`net-${l.id}`}>Net</FieldLabel>
                      <Input
                        id={`net-${l.id}`}
                        required
                        inputMode="decimal"
                        value={c.net}
                        onChange={(e) => edit(l.id, { net: e.target.value.trim() })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`line-tax-${l.id}`}>Tax amount</FieldLabel>
                      <Input
                        id={`line-tax-${l.id}`}
                        required
                        inputMode="decimal"
                        value={c.tax}
                        onChange={(e) => edit(l.id, { tax: e.target.value.trim() })}
                      />
                    </Field>
                  </div>
                );
              })}
              <p className="border-t pt-3 text-sm">
                Net {net ?? "—"} · Tax allocated{" "}
                <span
                  className={allocated === detail.invoice.vat ? "text-status-completed" : "text-destructive"}
                >
                  {allocated ?? "—"}
                </span>{" "}
                of {detail.invoice.vat} VAT
              </p>
              <Field>
                <FieldLabel htmlFor="prepare-reason">Review note</FieldLabel>
                <Input
                  id="prepare-reason"
                  required
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Checked against the supplier's invoice"
                />
              </Field>
              <div>
                <Button type="submit" disabled={pending || allocated !== detail.invoice.vat}>
                  {pending ? "Preparing…" : "Prepare for accounting"}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
