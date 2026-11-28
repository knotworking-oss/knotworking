"use client";
import { newId, type accountingMappingKinds } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Card } from "@knotworking/ui/components/card";
import { Input } from "@knotworking/ui/components/input";
import { Field, FieldLabel, FieldDescription } from "@knotworking/ui/components/field";
import { Badge } from "@knotworking/ui/components/badge";
import { useEffect, useState, type FormEvent } from "react";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";
import type { getAccountingConnections } from "@/lib/api";
import { CustomerPreparation } from "./customer-preparation";
import { InvoicePreparation } from "./invoice-preparation";
import { XeroConnection } from "./xero-connection";
import { AccountingQueue } from "./accounting-queue";
type Setup = Awaited<ReturnType<typeof getAccountingConnections>>;
type Connection = Setup["connections"][number];
const client = () => browserApi().v1.workspaces[":slug"].accounting;
const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
export function AccountingSettings({
  slug,
  initial,
  callbackConnection,
  callbackFailed,
}: {
  slug: string;
  initial: Setup;
  callbackConnection?: Connection;
  callbackFailed: boolean;
}) {
  const [setup, setSetup] = useState(initial);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Connection | null>(callbackConnection ?? null);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [customProvider, setCustomProvider] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const providerId = provider === "custom" ? customProvider : provider;
  async function load(next = offset) {
    const result = await unwrap(
      client().connections.$get({ param: { slug }, query: { offset: String(next) } }),
    );
    setSetup(result);
    setOffset(next);
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError("");
    try {
      const connection = await unwrap(
        client().connections.$post({
          param: { slug },
          json: {
            commandId: newId(),
            name,
            provider: providerId,
            companyId: providerId === "xero" ? "" : companyId,
          },
        }),
      );
      await load(0);
      setSelected(connection);
      setName("");
      setCompanyId("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="workspace-content flex flex-col gap-6 py-6">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Card className="gap-4 p-5">
        <h3 className="font-medium">Add accounting setup</h3>
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="connection-name">Connection name</FieldLabel>
            <Input
              id="connection-name"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Company bookkeeping"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="accounting-provider">Accounting software</FieldLabel>
            <select
              required
              id="accounting-provider"
              className={selectClass}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="" disabled>
                Choose accounting software
              </option>
              {setup.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="custom">Other / community adapter</option>
            </select>
          </Field>
          {provider === "custom" && (
            <Field>
              <FieldLabel htmlFor="custom-provider">Adapter identifier</FieldLabel>
              <Input
                id="custom-provider"
                required
                pattern="[a-z][a-z0-9_]{0,79}"
                value={customProvider}
                onChange={(e) => setCustomProvider(e.target.value)}
                placeholder="community_ledger"
              />
              <FieldDescription>Use the identifier supplied by the adapter maintainer.</FieldDescription>
            </Field>
          )}
          {providerId !== "xero" && (
            <Field>
              <FieldLabel htmlFor="accounting-company">Company identifier (optional)</FieldLabel>
              <Input
                id="accounting-company"
                maxLength={200}
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              />
              <FieldDescription>
                Add the company or organisation identifier from your accounting system when known. Credentials
                are not needed here.
              </FieldDescription>
            </Field>
          )}
          <div className="sm:col-span-2">
            <Button disabled={pending} type="submit">
              {pending ? "Saving…" : "Save setup"}
            </Button>
            {providerId === "xero" && (
              <p className="mt-2 text-sm text-muted-foreground">Connect Xero after saving this setup.</p>
            )}
          </div>
        </form>
      </Card>
      <div className="flex flex-col gap-3">
        <h3 className="font-medium">Saved connections</h3>
        {setup.connections.length === 0 && (
          <p className="text-sm text-muted-foreground">No accounting connections configured.</p>
        )}
        {setup.connections.map((c) => (
          <Card key={c.id} className="flex flex-row items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">
                {c.name} <Badge variant="secondary">{c.disabled ? "Disabled" : "Setup saved"}</Badge>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {setup.providers.find((p) => p.id === c.provider)?.name ?? c.provider} ·{" "}
                {c.companyId || "Company not set"}
              </p>
            </div>
            <Button variant="outline" onClick={() => setSelected(c)}>
              Manage
            </Button>
          </Card>
        ))}
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={offset === 0 || pending}
            onClick={() => void load(Math.max(0, offset - 50)).catch((e) => setError(errorMessage(e)))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={!setup.hasMore || pending}
            onClick={() => void load(offset + 50).catch((e) => setError(errorMessage(e)))}
          >
            Next
          </Button>
        </div>
      </div>
      {selected && (
        <ConnectionEditor
          key={selected.id}
          slug={slug}
          connection={selected}
          setup={setup}
          callbackFailed={callbackFailed && selected.id === callbackConnection?.id}
          onSaved={async (c) => {
            setSelected(c);
            await load();
          }}
        />
      )}
    </div>
  );
}
function ConnectionEditor({
  slug,
  connection,
  setup,
  callbackFailed,
  onSaved,
}: {
  slug: string;
  connection: Connection;
  setup: Setup;
  callbackFailed: boolean;
  onSaved: (c: Connection) => Promise<void>;
}) {
  const [current, setCurrent] = useState(connection);
  const [name, setName] = useState(connection.name);
  const [company, setCompany] = useState(connection.companyId);
  const [disabled, setDisabled] = useState(connection.disabled);
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<(typeof accountingMappingKinds)[number]>("account");
  const [local, setLocal] = useState("");
  const [external, setExternal] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [mappingReason, setMappingReason] = useState("");
  const [mappings, setMappings] = useState<
    Array<{
      kind: string;
      localReference: string;
      externalReference: string;
      enabled: boolean;
      localLabel: string;
    }>
  >([]);
  const [refs, setRefs] = useState<Array<{ id: string; code: string | null; name: string }>>([]);
  const [query, setQuery] = useState("");
  const [refsMore, setRefsMore] = useState(false);
  const [history, setHistory] = useState<
    Array<{ revision: number; action: string; reason: string; actorName: string; createdAt: string }>
  >([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyMore, setHistoryMore] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [xeroRefresh, setXeroRefresh] = useState(0);
  const [queueRefresh, setQueueRefresh] = useState(0);
  const params = { slug, id: current.id };
  useEffect(() => {
    let active = true;
    setPending(true);
    void unwrap(client().connections[":id"].$get({ param: { slug, id: connection.id } }))
      .then((data) => {
        if (!active) return;
        setCurrent(data.connection);
        setName(data.connection.name);
        setCompany(data.connection.companyId);
        setDisabled(data.connection.disabled);
        setMappings(data.mappings);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [slug, connection.id]);
  async function refresh() {
    const data = await unwrap(client().connections[":id"].$get({ param: params }));
    setCurrent(data.connection);
    setName(data.connection.name);
    setCompany(data.connection.companyId);
    setDisabled(data.connection.disabled);
    setMappings(data.mappings);
    await onSaved(data.connection);
  }
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        client().connections[":id"].$patch({
          param: params,
          json: {
            commandId: newId(),
            expectedRevision: current.revision,
            name,
            companyId: company,
            disabled,
            reason,
          },
        }),
      );
      setReason("");
      await refresh();
    });
  }
  async function saveMapping(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await unwrap(
        client().connections[":id"].mappings.$put({
          param: params,
          json: {
            commandId: newId(),
            expectedRevision: current.revision,
            kind,
            localReference: local,
            externalReference: external,
            enabled,
            reason: mappingReason,
          },
        }),
      );
      setMappingReason("");
      await refresh();
    });
  }
  async function search() {
    if (kind !== "supplier" && kind !== "customer") return;
    await run(async () => {
      const result = await unwrap(client().references.$get({ param: { slug }, query: { kind, q: query } }));
      setRefs(result.references);
      setRefsMore(result.hasMore);
    });
  }
  async function showHistory(offset = 0) {
    await run(async () => {
      const result = await unwrap(
        client().connections[":id"].history.$get({ param: params, query: { offset: String(offset) } }),
      );
      setHistory(result.events);
      setHistoryOffset(offset);
      setHistoryMore(result.hasMore);
    });
  }
  return (
    <Card className="gap-5 p-5">
      <fieldset disabled={pending} className="contents">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium">Manage {current.name}</h3>
          <Button variant="outline" disabled={pending} onClick={() => void run(refresh)}>
            Reload setup and mappings
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="saved-name">Name</FieldLabel>
            <Input
              id="saved-name"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {current.provider !== "xero" && (
            <Field>
              <FieldLabel htmlFor="saved-company">Company identifier</FieldLabel>
              <Input
                id="saved-company"
                maxLength={200}
                readOnly={!!current.companyId}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
              <FieldDescription>
                Once set, the provider and company stay fixed to protect posting history. Use a separate
                connection for another company.
              </FieldDescription>
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            Disable invoice preparation and sending
          </label>
          <Field>
            <FieldLabel htmlFor="setup-reason">Reason for this change</FieldLabel>
            <Input
              id="setup-reason"
              required
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" disabled={pending}>
              Save changes
            </Button>
          </div>
        </form>
        {current.provider === "xero" && (
          <XeroConnection
            slug={slug}
            id={current.id}
            revision={current.revision}
            configured={setup.xeroConfigured}
            callbackFailed={callbackFailed}
            refreshKey={xeroRefresh}
            onChanged={refresh}
          />
        )}
        <div className="border-t pt-4">
          <h4 className="font-medium">Reviewed mappings</h4>
          <form onSubmit={saveMapping} className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="mapping-kind">Type</FieldLabel>
              <select
                id="mapping-kind"
                className={selectClass}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as typeof kind);
                  setLocal("");
                  setRefs([]);
                }}
              >
                <option value="account">Account</option>
                <option value="tax">Tax</option>
                {setup.canMapSuppliers && <option value="supplier">Supplier</option>}
                {setup.canMapCustomers && <option value="customer">Customer</option>}
              </select>
            </Field>
            {(kind === "supplier" || kind === "customer") && (
              <div className="flex items-end gap-2">
                <Field>
                  <FieldLabel htmlFor="reference-search">Find a {kind}</FieldLabel>
                  <Input id="reference-search" value={query} onChange={(e) => setQuery(e.target.value)} />
                </Field>
                <Button type="button" variant="outline" disabled={pending} onClick={() => void search()}>
                  Search
                </Button>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="local-reference">
                {kind === "supplier" || kind === "customer" ? `Local ${kind}` : "Local mapping key"}
              </FieldLabel>
              {kind === "supplier" || kind === "customer" ? (
                <select
                  id="local-reference"
                  required
                  className={selectClass}
                  value={local}
                  onChange={(e) => setLocal(e.target.value)}
                >
                  <option value="">Search and choose a record</option>
                  {refs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.code ? `${r.code} · ` : ""}
                      {r.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id="local-reference"
                  required
                  maxLength={200}
                  value={local}
                  onChange={(e) => setLocal(e.target.value)}
                  placeholder={kind === "account" ? "materials" : "standard_rate"}
                />
              )}
              {refsMore && (
                <FieldDescription>Showing the first 100 matches. Narrow your search.</FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="external-reference">
                {current.provider === "xero"
                  ? kind === "account"
                    ? "Xero account code"
                    : kind === "tax"
                      ? "Xero tax type"
                      : "Xero ContactID"
                  : "Reference in accounting software"}
              </FieldLabel>
              <Input
                id="external-reference"
                required
                maxLength={200}
                value={external}
                onChange={(e) => setExternal(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="mapping-reason">Review reason</FieldLabel>
              <Input
                id="mapping-reason"
                required
                maxLength={2000}
                value={mappingReason}
                onChange={(e) => setMappingReason(e.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Mapping enabled
            </label>
            <div>
              <Button disabled={pending} type="submit">
                Save reviewed mapping
              </Button>
            </div>
          </form>
          {mappings.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">Type</th>
                    <th className="p-2">Local reference</th>
                    <th className="p-2">Accounting reference</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m) => (
                    <tr key={`${m.kind}:${m.localReference}`} className="border-t">
                      <td className="p-2">{m.kind}</td>
                      <td className="p-2">{m.localLabel}</td>
                      <td className="p-2">{m.externalReference}</td>
                      <td className="p-2">{m.enabled ? "Enabled" : "Disabled"}</td>
                      <td className="p-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            pending ||
                            (m.kind === "supplier" && !setup.canMapSuppliers) ||
                            (m.kind === "customer" && !setup.canMapCustomers)
                          }
                          onClick={() => {
                            setKind(m.kind as typeof kind);
                            setLocal(m.localReference);
                            setExternal(m.externalReference);
                            setEnabled(m.enabled);
                            setMappingReason("");
                            if (m.kind === "supplier" || m.kind === "customer")
                              setRefs([{ id: m.localReference, code: "", name: m.localLabel }]);
                          }}
                        >
                          Review
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {setup.canPrepareInvoices && (
          <InvoicePreparation key={`invoices-${current.revision}`} slug={slug} connectionId={current.id} />
        )}
        {current.provider === "xero" && setup.canPrepareCustomerDocuments && (
          <CustomerPreparation
            key={`customers-${current.revision}`}
            slug={slug}
            connectionId={current.id}
            onPrepared={() => setQueueRefresh((count) => count + 1)}
          />
        )}
        <AccountingQueue
          key={`queue-${current.revision}-${queueRefresh}`}
          slug={slug}
          connectionId={current.id}
          canReadPurchasing={setup.canPrepareInvoices}
          canReadInvoicing={setup.canPrepareCustomerDocuments}
          onChecked={() => setXeroRefresh((n) => n + 1)}
        />
        <div className="border-t pt-4">
          <Button variant="outline" disabled={pending} onClick={() => void showHistory()}>
            View change history
          </Button>
          {history.map((h) => (
            <p key={h.revision} className="mt-2 text-sm">
              Revision {h.revision}: {h.reason}
              <span className="block text-xs text-muted-foreground">
                {h.actorName} · {new Date(h.createdAt).toLocaleString("en-GB")}
              </span>
            </p>
          ))}
          {history.length > 0 && (
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                disabled={pending || historyOffset === 0}
                onClick={() => void showHistory(Math.max(0, historyOffset - 50))}
              >
                Previous history
              </Button>
              <Button
                variant="outline"
                disabled={pending || !historyMore}
                onClick={() => void showHistory(historyOffset + 50)}
              >
                Next history
              </Button>
            </div>
          )}
        </div>
      </fieldset>
    </Card>
  );
}
