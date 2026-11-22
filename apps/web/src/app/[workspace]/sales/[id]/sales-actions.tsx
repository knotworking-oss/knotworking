"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { newId } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
import type { SalesOrder, SalesFulfilments } from "@/lib/api";
export function SalesActions({ slug, order }: { slug: string; order: SalesOrder }) {
  const { can } = useWorkspace(),
    router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState<{ action: string; reason: string; id: string } | null>(null);
  async function act(action: "confirm" | "issue" | "cancel" | "convert") {
    setBusy(true);
    setError("");
    const commandId = attempt?.action === action && attempt.reason === reason ? attempt.id : newId();
    setAttempt({ action, reason, id: commandId });
    try {
      const api = browserApi().v1.workspaces[":slug"].sales.orders[":id"];
      const json = { commandId, expectedRevision: order.revision, reason };
      const result = await unwrap(api[action].$post({ param: { slug, id: order.id }, json }));
      router.push(`/${slug}/sales/${result.id}`);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 print:hidden">
      <div className="flex flex-wrap gap-3">
        {((order.status === "draft" && can("sales", "write")) ||
          (order.status === "confirmed" && can("sales", "manage"))) && (
          <Button variant="outline" asChild>
            <Link href={`/${slug}/sales/${order.id}/edit`}>
              {order.status === "confirmed" ? "Amend order" : "Edit draft"}
            </Link>
          </Button>
        )}
        <Button variant="outline" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      {can("sales", "manage") && order.status !== "cancelled" && (
        <div className="space-y-2 rounded-lg border p-4">
          <label className="block space-y-1 text-sm">
            Decision reason
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2000}
              placeholder="What have you reviewed or agreed?"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Actions sign the saved revision. Issuing a quote records your decision; it does not send it to the
            customer.
          </p>
          <div className="flex flex-wrap gap-2">
            {order.status === "draft" && (
              <Button
                disabled={busy || !reason.trim()}
                onClick={() => void act(order.kind === "quote" ? "issue" : "confirm")}
              >
                {order.kind === "quote" ? "Sign and issue quote" : "Confirm order"}
              </Button>
            )}
            {order.kind === "quote" && order.status === "issued" && !order.convertedOrderId && (
              <Button disabled={busy || !reason.trim()} onClick={() => void act("convert")}>
                Create order from quote
              </Button>
            )}
            <Button variant="outline" disabled={busy || !reason.trim()} onClick={() => void act("cancel")}>
              Cancel {order.kind === "quote" ? "quote" : "remaining order"}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function SalesDeliveryLinks({
  slug,
  order,
  fulfilments,
}: {
  slug: string;
  order: SalesOrder;
  fulfilments: SalesFulfilments;
}) {
  const { can } = useWorkspace(),
    router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [deliveries, setDeliveries] = useState<{ id: string; label: string }[]>([]);
  const [commandId, setCommandId] = useState(newId);
  const [despatchId, setDespatchId] = useState("");
  const [choices, setChoices] = useState<{ id: string; reference: string; despatchedOn: string }[]>([]);
  const [choiceTotal, setChoiceTotal] = useState(0);
  const [choiceOffset, setChoiceOffset] = useState(0);
  async function findDeliveries(offset = 0) {
    setBusy(true);
    setError("");
    try {
      const r = await unwrap(
        browserApi().v1.workspaces[":slug"].despatch.$get({
          param: { slug },
          query: { status: "confirmed", customerId: order.customerId, limit: "50", offset: String(offset) },
        }),
      );
      setChoices(r.despatches);
      setChoiceTotal(r.total);
      setChoiceOffset(offset);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    setError("");
    try {
      const row = await unwrap(
        browserApi().v1.workspaces[":slug"].despatch[":id"].$get({ param: { slug, id: despatchId } }),
      );
      setDeliveries(
        row.lines.map((l) => ({
          id: l.id,
          label: `${l.itemCode} · ${l.amount.display} ${l.amount.displayUnit} · lot ${l.lotCode}`,
        })),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].sales.orders[":id"].fulfilments.$post({
          param: { slug, id: order.id },
          json: {
            commandId,
            expectedRevision: order.revision,
            orderLineId: String(f.get("orderLineId")),
            despatchLineId: String(f.get("despatchLineId")),
            reason: String(f.get("reason")),
          },
        }),
      );
      setCommandId(newId());
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function correct(linkId: string, reason: string) {
    setBusy(true);
    setError("");
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].sales.orders[":id"].fulfilments[":linkId"].void.$post({
          param: { slug, id: order.id, linkId },
          json: { commandId, expectedRevision: order.revision, reason },
        }),
      );
      setCommandId(newId());
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 print:hidden">
      <h2 className="font-medium">Deliveries and returns</h2>
      <p className="text-sm text-muted-foreground">
        Link whole confirmed despatch lines. Physical returns stay in quarantine in Despatch; they do not
        automatically reopen an order or create a credit.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-2">Product</th>
              <th className="p-2">Ordered</th>
              <th className="p-2">Shipped</th>
              <th className="p-2">Returned</th>
              <th className="p-2">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {fulfilments.lines.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="p-2">{order.lines.find((o) => o.id === l.id)?.itemCode}</td>
                <td className="p-2">
                  {l.ordered} {l.baseUnit}
                </td>
                <td className="p-2">
                  {l.shipped} {l.baseUnit}
                </td>
                <td className="p-2">
                  {l.returned} {l.baseUnit}
                </td>
                <td className="p-2">
                  {l.outstanding} {l.baseUnit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fulfilments.links.map((link) => (
        <div key={link.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
          <Link className="underline" href={`/${slug}/despatch/${link.despatchId}`}>
            {link.despatchReference}
          </Link>
          <span>
            {link.status} · {link.despatchedOn} · {link.quantity} base units
          </span>
          {can("sales", "manage") && !link.voidedAt && (
            <form
              className="flex flex-wrap gap-2 print:hidden"
              onSubmit={(e) => {
                e.preventDefault();
                void correct(link.id, String(new FormData(e.currentTarget).get("reason")));
              }}
              onChange={() => setCommandId(newId())}
            >
              <Input
                name="reason"
                aria-label="Correction reason"
                placeholder="Correction reason"
                required
                maxLength={2000}
              />
              <Button size="sm" variant="outline" disabled={busy}>
                Correct link
              </Button>
            </form>
          )}
          {link.voidedAt && <span>Corrected: {link.voidReason}</span>}
        </div>
      ))}
      {can("sales", "manage") && order.status === "confirmed" && (
        <form
          onSubmit={submit}
          onChange={() => setCommandId(newId())}
          className="space-y-3 rounded-lg border p-4 print:hidden"
        >
          <h3 className="text-sm font-medium">Assign a delivery</h3>
          <div className="space-y-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void findDeliveries()}>
              Find confirmed deliveries
            </Button>
            <label className="block space-y-1 text-sm">
              Delivery
              <select
                aria-label="Delivery"
                value={despatchId}
                onChange={(e) => {
                  setDespatchId(e.target.value);
                  setDeliveries([]);
                }}
                className="h-9 w-full rounded-md border bg-background px-3"
              >
                <option value="">Choose a delivery for this customer</option>
                {choices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.reference} · {d.despatchedOn}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-3 text-xs">
              <span>{choiceTotal} confirmed deliveries</span>
              {choiceOffset > 0 && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => void findDeliveries(Math.max(0, choiceOffset - 50))}
                >
                  Newer
                </button>
              )}
              {choiceOffset + choices.length < choiceTotal && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => void findDeliveries(choiceOffset + 50)}
                >
                  Older
                </button>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load()}
              disabled={busy || !despatchId}
            >
              Load delivery lines
            </Button>
          </div>
          <label className="block space-y-1 text-sm">
            Despatch line
            <select
              name="despatchLineId"
              required
              className="h-9 w-full rounded-md border bg-background px-3"
            >
              <option value="">Choose a loaded line</option>
              {deliveries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            Order line
            <select name="orderLineId" required className="h-9 w-full rounded-md border bg-background px-3">
              {order.lines.map((l, i) => (
                <option key={l.id} value={l.id}>
                  {i + 1}. {l.itemCode} · {l.quantity} {l.unit} · {l.dueOn}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            Reason
            <Input name="reason" required maxLength={2000} />
          </label>
          <Button disabled={busy}>Link delivery</Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
