import { currencyDigits, currencySchema } from "@knotworking/core";
import { z } from "zod";

const api = "https://api.xero.com";
const identity = "https://identity.xero.com/connect/token";
export const xeroScopes = [
  "offline_access",
  "accounting.invoices",
  "accounting.settings.read",
  "accounting.contacts.read",
];
export const xeroCurrency = currencySchema.refine((currency) => currencyDigits(currency) === 2);
export const xeroCallbackPath = "/v1/accounting/xero/callback";

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().max(3600),
});
export const xeroTokens = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
});
export type XeroTokens = z.infer<typeof xeroTokens>;

const tenant = z.object({
  id: z.uuid(),
  tenantId: z.uuid().transform((id) => id.toLowerCase()),
  tenantType: z.string(),
  tenantName: z.string().nullable(),
  /** The sign-in that authorised this connection; older stored attempts lack it. */
  authEventId: z.uuid().nullish(),
});
export const xeroTenants = z.array(tenant).max(100);
export const xeroOrganisation = z.object({
  OrganisationID: z.uuid().transform((id) => id.toLowerCase()),
  Name: z.string().min(1),
  BaseCurrency: currencySchema,
  PeriodLockDate: z.string().nullish(),
  EndOfYearLockDate: z.string().nullish(),
});

export class XeroHttpError extends Error {
  constructor(
    readonly status: number,
    readonly invalidGrant: boolean = false,
    readonly validationRejected: boolean = false,
  ) {
    super("Xero request did not succeed");
  }
}

type Transport = typeof globalThis.fetch;
export function xeroRequest(transport: Transport, url: string, init: RequestInit, timeout = 10000) {
  return transport(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
}

export async function xeroAccountingRequest(
  transport: Transport,
  tenantId: string,
  token: string,
  path: string,
  init: RequestInit = {},
  timeout?: number,
) {
  const response = await xeroRequest(
    transport,
    `${api}/api.xro/2.0${path}`,
    {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "xero-tenant-id": tenantId,
        ...init.headers,
      },
    },
    timeout,
  );
  if (!response.ok) {
    const body: unknown =
      response.status === 400 && init.method === "PUT" ? await response.json().catch(() => null) : null;
    const invalid = z
      .object({
        ErrorNumber: z.literal(10),
        Type: z.literal("ValidationException"),
        Elements: z
          .array(z.object({ ValidationErrors: z.array(z.object({ Message: z.string() })).min(1) }))
          .length(1),
      })
      .safeParse(body).success;
    throw new XeroHttpError(response.status, false, invalid);
  }
  return response.json() as Promise<unknown>;
}

export async function readXeroOrganisation(request: (path: string) => Promise<unknown>) {
  const data = z
    .object({ Organisations: z.array(xeroOrganisation).length(1) })
    .parse(await request("/Organisation"));
  return data.Organisations[0]!;
}

export function createXeroOAuthClient(options: {
  clientId: string;
  clientSecret: string;
  appUrl: string;
  fetch?: Transport;
}) {
  const transport = options.fetch ?? globalThis.fetch;
  const redirectUri = new URL(`/api${xeroCallbackPath}`, options.appUrl);
  if (
    redirectUri.protocol !== "https:" &&
    !(redirectUri.protocol === "http:" && redirectUri.hostname === "localhost")
  )
    throw new Error("Xero requires an HTTPS APP_URL or http://localhost for local testing");
  if (redirectUri.username || redirectUri.password)
    throw new Error("Xero APP_URL must not contain credentials");
  const basic = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`;

  async function tokens(params: Record<string, string>): Promise<XeroTokens> {
    const response = await xeroRequest(transport, identity, {
      method: "POST",
      headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    if (!response.ok) {
      const body: unknown = response.status === 400 ? await response.json().catch(() => null) : null;
      const invalidGrant = z.object({ error: z.literal("invalid_grant") }).safeParse(body).success;
      throw new XeroHttpError(response.status, invalidGrant);
    }
    const data = tokenResponse.parse(await response.json());
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000,
    };
  }
  async function connections(token: string, path = "", method = "GET") {
    const response = await xeroRequest(transport, `${api}/connections${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok && !(method === "DELETE" && response.status === 404))
      throw new XeroHttpError(response.status);
    return response;
  }
  return {
    transport,
    redirectUri: redirectUri.href,
    authorize(state: string) {
      const url = new URL("https://login.xero.com/identity/connect/authorize");
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: options.clientId,
        redirect_uri: redirectUri.href,
        scope: xeroScopes.join(" "),
        state,
      }).toString();
      return url.href;
    },
    exchange: (code: string) =>
      tokens({ grant_type: "authorization_code", code, redirect_uri: redirectUri.href }),
    refresh: (refresh_token: string) => tokens({ grant_type: "refresh_token", refresh_token }),
    async tenants(token: string, authEventId?: string) {
      const query = authEventId ? `?${new URLSearchParams({ authEventId })}` : "";
      const response = await connections(token, query);
      return xeroTenants.parse(await response.json()).filter((row) => row.tenantType === "ORGANISATION");
    },
    organisation(tenantId: string, token: string) {
      return readXeroOrganisation((path) => xeroAccountingRequest(transport, tenantId, token, path));
    },
    async disconnect(remoteId: string, token: string) {
      await connections(token, `/${encodeURIComponent(remoteId)}`, "DELETE");
    },
  };
}
