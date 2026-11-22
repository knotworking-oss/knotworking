import { backoffDelay, SYNC_NUDGE_EVENT, type SyncNudge } from "@knotworking/core";

export type PushStatus = "connecting" | "live" | "polling";

/** Pull this often while the event stream is down (or unsupported). */
const POLL_MS = 30_000;
/** …and this often while it's up, as a safety net for a silently stalled stream. */
const SAFETY_POLL_MS = 5 * 60_000;
/** Close the stream once a tab has been hidden this long (frees a connection; we catch up on return). */
const HIDDEN_GRACE_MS = 30_000;

/**
 * Keeps a server-sent event stream to `/events` open and turns it into
 * "pull now" calls: on every nudge, on (re)connect, when the tab becomes
 * visible or the network comes back, and on a polling fallback while the
 * stream is unavailable. Reconnects with exponential backoff and jitter.
 *
 * Returns a function that tears everything down.
 */
export function connectSyncPush({
  url,
  onPull,
  onStatus,
}: {
  url: string;
  /** Called with the server's cursor when known; pull if it's ahead of ours (or always, when absent). */
  onPull: (cursor?: string) => void;
  onStatus?: (status: PushStatus) => void;
}): () => void {
  let source: EventSource | null = null;
  let attempt = 0;
  let status: PushStatus = "connecting";
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPull = Date.now();
  let stopped = false;
  const supported = typeof EventSource !== "undefined";

  const setStatus = (next: PushStatus) => {
    if (next === status) return;
    status = next;
    onStatus?.(next);
  };
  const pull = (cursor?: string) => {
    lastPull = Date.now();
    onPull(cursor);
  };
  const parse = (e: MessageEvent) => {
    try {
      return (JSON.parse(e.data) as SyncNudge).cursor;
    } catch {
      return undefined;
    }
  };

  const close = () => {
    source?.close();
    source = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  const open = () => {
    if (stopped || !supported || source || document.visibilityState === "hidden") return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const es = new EventSource(url, { withCredentials: true });
    source = es;
    // `ready` comes first on every connection, with the current cursor: catch up on anything missed.
    es.addEventListener("ready", (e) => {
      attempt = 0;
      setStatus("live");
      pull(parse(e as MessageEvent));
    });
    es.addEventListener(SYNC_NUDGE_EVENT, (e) => pull(parse(e as MessageEvent)));
    es.onerror = () => {
      // Includes the server ending a stream normally (it does every few minutes). We manage the
      // retry ourselves: EventSource gives up for good on HTTP errors and retries blindly otherwise.
      if (source !== es) return;
      close();
      setStatus("polling");
      if (stopped) return;
      reconnectTimer = setTimeout(open, backoffDelay(attempt++, { base: 1000, max: 60_000 }));
    };
  };

  const poll = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    const due = status === "live" ? SAFETY_POLL_MS : POLL_MS;
    if (Date.now() - lastPull >= due) pull();
  }, 5_000);

  const onVisibility = () => {
    clearTimeout(hiddenTimer);
    if (document.visibilityState === "hidden") {
      hiddenTimer = setTimeout(() => {
        close();
        setStatus("polling");
      }, HIDDEN_GRACE_MS);
      return;
    }
    if (!source) {
      attempt = 0;
      open(); // `ready` pulls
      if (!supported) pull();
    }
  };
  const onOnline = () => {
    attempt = 0;
    if (!source) open();
    pull();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  if (supported) open();
  else setStatus("polling");

  return () => {
    stopped = true;
    close();
    clearInterval(poll);
    clearTimeout(hiddenTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
  };
}
