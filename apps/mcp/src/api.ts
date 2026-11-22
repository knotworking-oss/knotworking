import { createApiClient, type ApiClient } from "@knotworking/api-client";
import type { ClientResponse } from "hono/client";

/**
 * A failure to report to the agent as a tool result (`isError: true`), never as a protocol error.
 * `code` is the API's error code when the API answered, otherwise one of this server's own
 * (`api_unreachable`, `not_found`, `invalid_input`, `ambiguous`, `internal_error`).
 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { status?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ApiOptions {
  baseUrl: string;
  /** The caller's `knw_…` API token. Only ever sent to `baseUrl` as a bearer header. */
  token: string;
  /** Override for tests. */
  fetch?: typeof fetch;
  /**
   * Share expensive reads (`memo`) between everything that uses this `Api` object. Only turn this on for an
   * `Api` that lives as long as ONE HTTP request: it is never invalidated by time, so a process-wide
   * instance (stdio) would serve stale data forever.
   */
  memoize?: boolean;
}

export interface Api {
  client: ApiClient;
  /** Awaits a typed client call; non-2xx responses and network failures become `ToolError`s. */
  call<T>(response: Promise<ClientResponse<T>>): Promise<T>;
  /** Removes the token from any text before it reaches the agent or a log. */
  redact(text: string): string;
  /**
   * Runs `load` once per key for the life of this `Api` (concurrent callers share the in-flight promise;
   * failures are not kept). A plain pass-through unless `memoize` was set.
   */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
  /** Forgets every memoized read. Called after a write so later reads see it. */
  invalidate(): void;
}

/** Fields of the API's validation error (zod issues) worth showing an agent. */
function describeIssues(details: unknown): string {
  if (!Array.isArray(details)) return "";
  const parts = details
    .slice(0, 5)
    .map((issue: { path?: unknown[]; message?: string }) => {
      const path = Array.isArray(issue?.path) ? issue.path.join(".") : "";
      return `${path ? `${path}: ` : ""}${issue?.message ?? "invalid"}`;
    })
    .filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

export function createApi({ baseUrl, token, fetch: fetchImpl, memoize = false }: ApiOptions): Api {
  const redact = (text: string) => (token ? text.split(token).join("[redacted]") : text);
  const client = createApiClient(baseUrl, {
    headers: { Authorization: `Bearer ${token}` },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  async function call<T>(response: Promise<ClientResponse<T>>): Promise<T> {
    let res: Awaited<typeof response>;
    try {
      res = await response;
    } catch {
      // Deliberately generic: fetch errors can carry the URL, and the agent can't fix infrastructure.
      throw new ToolError(
        "api_unreachable",
        "Could not reach the Knotworking API. Ask the operator to check it.",
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: unknown };
      } | null;
      const error = body?.error;
      throw new ToolError(
        error?.code ?? "unknown",
        redact(`${error?.message ?? `Request failed (${res.status})`}${describeIssues(error?.details)}`),
        { status: res.status, details: error?.details },
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const cache = new Map<string, Promise<unknown>>();
  function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!memoize) return load();
    let pending = cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      const created = load();
      pending = created;
      cache.set(key, created);
      // A failed read must be retried by the next caller, not replayed.
      created.catch(() => {
        if (cache.get(key) === created) cache.delete(key);
      });
    }
    return pending;
  }

  return { client, call, redact, memo, invalidate: () => cache.clear() };
}
