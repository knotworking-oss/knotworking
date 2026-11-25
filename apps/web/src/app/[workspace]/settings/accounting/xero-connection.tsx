"use client";

import { Button } from "@knotworking/ui/components/button";
import { Field, FieldLabel } from "@knotworking/ui/components/field";
import { newId } from "@knotworking/core";
import { useEffect, useState } from "react";
import { browserApi, errorMessage, unwrap } from "@/lib/auth-client";

const client = () => browserApi().v1.workspaces[":slug"].accounting.connections[":id"].xero;
const getStatus = (param: { slug: string; id: string }) => unwrap(client().$get({ param }));
const getReview = (param: { slug: string; id: string }, json: { flowId: string; tenantId: string }) =>
  unwrap(client().review.$post({ param, json }));

export function XeroConnection({
  slug,
  id,
  revision,
  configured,
  callbackFailed,
  refreshKey,
  onChanged,
}: {
  slug: string;
  id: string;
  revision: number;
  configured: boolean;
  callbackFailed: boolean;
  refreshKey: number;
  onChanged: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getStatus>> | null>(null);
  const [review, setReview] = useState<Awaited<ReturnType<typeof getReview>> | null>(null);
  const [tenantId, setTenantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    callbackFailed ? "Xero sign-in did not finish. Start again to connect." : "",
  );
  const [notice, setNotice] = useState("");
  const param = { slug, id };
  useEffect(() => {
    if (!configured) return;
    let active = true;
    void getStatus({ slug, id })
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [configured, slug, id, refreshKey]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
      await getStatus(param)
        .then(setStatus)
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!review || !status?.pending) return;
    await unwrap(
      client().confirm.$post({
        param,
        json: {
          tenantId: review.tenantId,
          organisationId: review.organisationId,
          baseCurrency: review.baseCurrency,
          flowId: status.pending.id,
          expectedRevision: revision,
          commandId: newId(),
        },
      }),
    );
    setReview(null);
    setStatus(await getStatus(param));
    await onChanged();
  }
  async function disconnect() {
    const result = await unwrap(
      client().disconnect.$post({
        param,
        json: { expectedRevision: revision, commandId: newId() },
      }),
    );
    setReview(null);
    setStatus(await getStatus(param));
    setNotice(
      result.remoteRemoved
        ? "Xero is disconnected."
        : "Knotworking removed its credentials. Remove the app in Xero's Connected apps to finish revoking access.",
    );
    await onChanged();
  }
  return (
    <section className="flex flex-col gap-3 border-t pt-4">
      <h4 className="font-medium">Xero connection</h4>
      {!configured && (
        <p className="text-sm text-muted-foreground">
          Ask your server administrator to configure a Xero app.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {status?.destination && (
        <div className="text-sm">
          <p>
            {status.destination.name} · {status.destination.baseCurrency}
          </p>
          <p className="break-all text-muted-foreground">Tenant {status.destination.tenantId}</p>
          <p className="text-muted-foreground">
            Last verified {new Date(status.destination.verifiedAt).toLocaleString("en-GB")}
          </p>
        </div>
      )}
      {status && (
        <>
          <p className="text-sm">
            {status.status === "connected"
              ? "Connected"
              : status.status === "reconnect_required"
                ? "Reconnect required"
                : "Disconnected"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await unwrap(client().start.$post({ param }));
                  window.location.assign(result.authorizationUrl);
                })
              }
            >
              {status.destination ? "Reconnect Xero" : "Connect Xero"}
            </Button>
            {status.status === "connected" && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await unwrap(client().verify.$post({ param }));
                    setStatus(await getStatus(param));
                    setNotice("Xero organisation and base currency verified.");
                  })
                }
              >
                Verify connection
              </Button>
            )}
            {(status.status !== "disconnected" || status.pending) && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void run(disconnect)}>
                {status.status === "disconnected" ? "Cancel Xero setup" : "Disconnect Xero"}
              </Button>
            )}
          </div>
          {status.pending &&
            (status.pending.tenants.length ? (
              <div className="flex flex-col items-start gap-3 rounded-md border p-3">
                <Field>
                  <FieldLabel htmlFor="xero-tenant">Authorised organisation</FieldLabel>
                  <select
                    id="xero-tenant"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={tenantId}
                    disabled={busy}
                    onChange={(e) => {
                      setTenantId(e.target.value);
                      setReview(null);
                    }}
                  >
                    <option value="">Choose an organisation</option>
                    {status.pending.tenants.map((tenant) => (
                      <option key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !tenantId}
                  onClick={() =>
                    void run(async () => {
                      setReview(await getReview(param, { tenantId, flowId: status.pending!.id }));
                    })
                  }
                >
                  Review organisation
                </Button>
                {review && (
                  <div className="flex flex-col items-start gap-2 text-sm">
                    <p>
                      {review.name} · Base currency {review.baseCurrency}
                    </p>
                    <p className="break-all text-muted-foreground">Tenant {review.tenantId}</p>
                    {!review.compatible && (
                      <p className="text-destructive">
                        Xero and this workspace must use the same two-decimal base currency.
                      </p>
                    )}
                    <Button
                      type="button"
                      disabled={busy || !review.compatible}
                      onClick={() => void run(confirm)}
                    >
                      Confirm organisation and currency
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-destructive">
                Xero did not return an eligible organisation for this setup. Sign in again with access to the
                intended organisation.
              </p>
            ))}
        </>
      )}
    </section>
  );
}
