import { ledgerFetch } from "./ledger-fetch";
import type { AppType } from "@knotworking/server";
import { hc, type ClientRequestOptions, type ClientResponse, type InferResponseType } from "hono/client";

/**
 * Typed API client. Request and response types are inferred from the server's
 * route definitions, so every client (web, desktop, mobile) stays in lockstep
 * with the API without code generation.
 *
 *   const api = createApiClient("http://localhost:4000");
 *   const res = await api.v1.workspaces[":slug"].tasks.$get({ param: { slug }, query: {} });
 */
export function createApiClient(baseUrl: string, options?: ClientRequestOptions) {
  return hc<AppType>(baseUrl, { ...options, fetch: ledgerFetch(options?.fetch ?? fetch) });
}

export type ApiClient = ReturnType<typeof createApiClient>;
export type { InferResponseType };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The error body's `details`, when the API sent any (e.g. the `current` document of a 409). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Unwrap a typed response, throwing `ApiError` for non-2xx statuses. */
export async function unwrap<T>(responsePromise: Promise<ClientResponse<T>>): Promise<T> {
  const res = await responsePromise;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? "unknown",
      body?.error?.message ?? `Request failed (${res.status})`,
      body?.error?.details,
    );
  }
  return (await res.json()) as T;
}

export interface SearchOptions {
  /** Search documents, tasks, or both (default). */
  scope?: "all" | "documents" | "tasks";
  /** Hits per kind, 1-50 (default 10). */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Full-text search over a workspace's documents and tasks (title and body). Hits carry a snippet and
 * the ranges to highlight (see `SearchResponse` in `@knotworking/core`).
 */
export function searchWorkspace(api: ApiClient, slug: string, q: string, options: SearchOptions = {}) {
  return unwrap(
    api.v1.workspaces[":slug"].search.$get(
      {
        param: { slug },
        query: {
          q,
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.limit ? { limit: String(options.limit) } : {}),
        },
      },
      options.signal ? { init: { signal: options.signal } } : undefined,
    ),
  );
}
