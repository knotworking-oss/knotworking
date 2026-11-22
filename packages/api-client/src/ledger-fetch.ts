/** UUIDv4 without depending on randomUUID's secure-context availability (self-hosted HTTP). */
function commandId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Retrying these commands is safe only with a stable key, persisted by the API transaction. */
export function ledgerFetch(
  fetchImpl: (input: string | Request | URL, init?: RequestInit) => Response | Promise<Response> = fetch,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const ledger =
      request.method === "POST" &&
      /\/(stock\/receipts|purchasing\/orders\/[^/]+\/receipts|production\/batches\/[^/]+\/(consumption|output))$/.test(
        path,
      );
    if (!ledger) return fetchImpl(input, init);
    const headers = new Headers(request.headers);
    // A caller-supplied commandId also supports manual retries after an ambiguous response.
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as { commandId?: string } | null;
    if (!headers.has("Idempotency-Key")) headers.set("Idempotency-Key", body?.commandId ?? commandId());
    const keyed = new Request(request, { headers });
    try {
      return await fetchImpl(keyed.clone());
    } catch (error) {
      if (request.signal.aborted) throw error;
      return fetchImpl(keyed.clone());
    }
  };
}
