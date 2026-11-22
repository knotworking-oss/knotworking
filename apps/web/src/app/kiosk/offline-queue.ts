import { ApiError } from "@knotworking/api-client";
import {
  KIOSK_REPLAY_BATCH,
  KIOSK_SEAL_HKDF_SALT,
  kioskSealAad,
  type KioskOfflineType,
} from "@knotworking/core";

/**
 * The kiosk's offline queue. When the network (or the API) is down, clock-ins, clock-outs and
 * visitor sign-ins and sign-outs are kept in this browser's local storage with the time they
 * happened and a random client id, and replayed when the connection is back
 * (`POST /v1/kiosk/replay`, idempotent on the client id).
 *
 * Who it was (staff number, badge, PIN, a visitor's details) is sealed to the server's public key
 * before it is stored: ECDH P-256 with a fresh key per event, HKDF-SHA-256 and AES-256-GCM, bound
 * to the event's client id, type and time. Only the server can open it, so the tablet's storage
 * holds no PIN or name anyone could read, and the server checks the PIN when it replays the event.
 */

export interface SealKey {
  version: string;
  kid: string;
  publicKey: string;
}

export interface QueuedEvent {
  clientId: string;
  type: KioskOfflineType;
  at: string;
  sealed: string;
  /** Deferred by the server (a clock-out waiting for its clock-in): not sent again before this. */
  retryAt?: string;
}

/** How long a deferred entry waits before it is sent again. */
export const DEFERRED_RETRY_MS = 2 * 60_000;

export interface SyncStatus {
  /** When the last replay reached the server. */
  lastSyncAt: string | null;
  /** Events refused for good by the last replay that sent any (a manager sees them under Settings & kiosks). */
  refused: number;
}

const QUEUE_KEY = "knotworking.kiosk.queue";
const STATUS_KEY = "knotworking.kiosk.sync";

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

export const readQueue = () => read<QueuedEvent[]>(QUEUE_KEY, []);
export const readSyncStatus = () => read<SyncStatus>(STATUS_KEY, { lastSyncAt: null, refused: 0 });
export const writeSyncStatus = (status: SyncStatus) => write(STATUS_KEY, status);

/** Forgets the queue (unpairing: a new pairing may be another workspace with another key). */
export function clearQueue() {
  try {
    localStorage.removeItem(QUEUE_KEY);
    localStorage.removeItem(STATUS_KEY);
  } catch {}
}

/** Whether this browser can seal events (WebCrypto needs a secure context: HTTPS or localhost). */
export const canQueueOffline = () =>
  typeof window !== "undefined" && window.isSecureContext && Boolean(globalThis.crypto?.subtle);

/**
 * Whether an error means "can't reach the server" rather than "the server said no": a network
 * failure or timeout, or the web app's proxy failing to reach the API (no JSON error body).
 */
export function isOfflineError(err: unknown) {
  if (err instanceof ApiError) return err.code === "unknown" && err.status >= 500;
  return err instanceof TypeError || (err instanceof DOMException && err.name === "TimeoutError");
}

const encoder = new TextEncoder();
const b64u = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (value: string) => {
  const s = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function seal(key: SealKey, event: Omit<QueuedEvent, "sealed">, payload: unknown) {
  const subtle = globalThis.crypto.subtle;
  const server = await subtle.importKey(
    "raw",
    fromB64u(key.publicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "ECDH", public: server }, eph.privateKey, 256);
  const hkdf = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(KIOSK_SEAL_HKDF_SALT),
      info: encoder.encode("aes-256-gcm"),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(kioskSealAad(event)) },
    aes,
    encoder.encode(JSON.stringify(payload)),
  );
  const epk = await subtle.exportKey("raw", eph.publicKey);
  return [key.version, key.kid, b64u(epk), b64u(iv), b64u(data)].join(".");
}

/** Seals and queues an event that happened now. Returns false if it couldn't be stored. */
export async function enqueue(
  key: SealKey,
  type: KioskOfflineType,
  payload: unknown,
  clientId: string = crypto.randomUUID(),
): Promise<{ at: Date } | null> {
  const at = new Date();
  const event = { clientId, type, at: at.toISOString() };
  const sealed = await seal(key, event, payload);
  const queue = readQueue();
  if (queue.some((q) => q.clientId === clientId)) return { at };
  return write(QUEUE_KEY, [...queue, { ...event, sealed }]) ? { at } : null;
}

export type ReplayResults = { clientId: string; status: string; code?: string }[];

/**
 * Sends the queue in batches. Accepted, duplicate and refused events leave the queue. Deferred
 * ones stay: a clock-out waiting for a clock-in another kiosk still holds (`awaiting_clock_in`)
 * waits `DEFERRED_RETRY_MS` and is sent again (the server refuses it once it is older than the
 * replay window); when the kiosk hit its wrong-PIN throttle, sending stops until the next flush.
 * Everything after a network failure stays too. Returns how many were refused, or null if the
 * server couldn't be reached.
 */
export async function flushQueue(
  send: (batch: { sentAt: string; events: QueuedEvent[] }) => Promise<{ results: ReplayResults }>,
  now: () => number = Date.now,
): Promise<{ refused: number } | null> {
  let refused = 0;
  let sent = 0;
  const tried = new Set<string>();
  for (;;) {
    const due = readQueue().filter(
      (q) => !tried.has(q.clientId) && (!q.retryAt || Date.parse(q.retryAt) <= now()),
    );
    if (due.length === 0) break;
    const batch = due.slice(0, KIOSK_REPLAY_BATCH).map(({ retryAt: _retryAt, ...event }) => event);
    let results: ReplayResults;
    try {
      ({ results } = await send({ sentAt: new Date(now()).toISOString(), events: batch }));
    } catch (err) {
      if (isOfflineError(err)) return null;
      throw err;
    }
    for (const event of batch) tried.add(event.clientId);
    const done = new Set(results.filter((r) => r.status !== "deferred").map((r) => r.clientId));
    const waiting = new Set(
      results.filter((r) => r.status === "deferred" && r.code === "awaiting_clock_in").map((r) => r.clientId),
    );
    refused += results.filter((r) => r.status === "rejected").length;
    sent += done.size;
    const retryAt = new Date(now() + DEFERRED_RETRY_MS).toISOString();
    // Re-read: an event may have been queued while the batch was in flight.
    write(
      QUEUE_KEY,
      readQueue()
        .filter((q) => !done.has(q.clientId))
        .map((q) => (waiting.has(q.clientId) ? { ...q, retryAt } : q)),
    );
    if (results.some((r) => r.status === "deferred" && r.code !== "awaiting_clock_in")) break; // Throttled.
  }
  writeSyncStatus({
    lastSyncAt: new Date(now()).toISOString(),
    refused: sent > 0 ? refused : readSyncStatus().refused,
  });
  return { refused };
}
