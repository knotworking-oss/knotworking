"use client";

import { ApiError, createApiClient, unwrap } from "@knotworking/api-client";
import type { ClockKind, KioskCredential } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Spinner } from "@knotworking/ui/components/spinner";
import { cn } from "@knotworking/ui/lib/utils";
import { CloudOff, Delete, KeyRound, LogIn, LogOut, QrCode, RefreshCw, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BadgeScanner } from "./badge-scanner";
import {
  canQueueOffline,
  clearQueue,
  enqueue,
  flushQueue,
  isOfflineError,
  readQueue,
  readSyncStatus,
  type SealKey,
  type SyncStatus,
} from "./offline-queue";
import { registerKioskServiceWorker } from "./kiosk-service-worker";
import { hasPrompts, PromptsScreen, type KioskPrompts } from "./prompts-screen";
import { VisitorScreen, type VisitorDetails } from "./visitor-screen";

/**
 * The tablet kiosk. Pairing stores a device credential in this browser's local storage; staff
 * then clock in and out with their staff number and PIN (or a badge), and visitors sign in and
 * out. PINs are only held in memory for the few seconds a clock-in takes. Nothing about a person
 * is shown before their PIN is accepted, and then only their first name.
 *
 * Offline, clock events and visitors are queued, sealed to the server's key (see
 * `offline-queue.ts`), and sent when the connection is back; the PIN is checked then.
 */

const STORAGE_KEY = "knotworking.kiosk";
interface KioskSettings {
  badgeRequiresPin: boolean;
  offlineReplayHours: number;
  visitorSiteRules: string | null;
}
interface Pairing {
  token: string;
  deviceName: string;
  workspaceName: string;
  /** Kept from the last session check, so the kiosk can queue and show the rules while offline. */
  seal?: SealKey;
  settings?: KioskSettings;
  /**
   * The server's clock minus this tablet's, measured at the last session check. Sealed into each
   * offline entry, so the server can correct its time without trusting anything sent in the clear.
   */
  clockOffsetMs?: number;
}

/** A credential still being collected: a staff number or badge, before the PIN. */
type Who = { staffNumber: string } | { badge: string };

type Screen =
  | { name: "loading" }
  | { name: "pair" }
  | { name: "number" }
  | { name: "badge" }
  | { name: "pin"; who: Who }
  | {
      name: "confirm";
      cred: KioskCredential;
      firstName: string;
      expected: ClockKind;
      clientId: string;
    }
  | { name: "offline-confirm"; cred: KioskCredential; clientId: string }
  | { name: "prompts"; title: string; firstName: string; prompts: KioskPrompts }
  | { name: "visitor"; mode: "in" | "out" | null }
  | {
      name: "change-pin";
      step: "number" | "current" | "new" | "repeat";
      staffNumber: string;
      currentPin: string;
      newPin: string;
    }
  | { name: "message"; tone: "ok" | "error"; title: string; detail?: string };

const readPairing = (): Pairing | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Pairing) : null;
  } catch {
    return null;
  }
};
const savePairing = (pairing: Pairing) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
  } catch {}
};

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const clockTime = (at: string | Date) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Requests give up after this long, so a dead connection falls back to the offline queue. */
const REQUEST_TIMEOUT_MS = 10_000;
/** How often the queue is retried while anything is waiting. */
const SYNC_EVERY_MS = 20_000;
/** Abandoned screens go back to the start; reading an SOP gets longer. */
const IDLE_MS = 30_000;
/** The prompt token lasts two minutes from the last SOP read or acknowledged: the screen gives up with it. */
const READING_IDLE_MS = 2 * 60_000;

export function Kiosk() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  const [sync, setSync] = useState<SyncStatus>({ lastSyncAt: null, refused: 0 });
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);
  /** The latest prompt token: each SOP read or acknowledged returns a renewed one. */
  const promptToken = useRef<string | null>(null);
  // Someone touching, typing or scrolling restarts the idle timer (reading an SOP never changes
  // `screen`, so the timer can't key on that alone). Bumped at most every few seconds.
  const [activity, setActivity] = useState(0);
  const lastActivity = useRef(0);
  const touch = useCallback(() => {
    const t = Date.now();
    if (t - lastActivity.current < 5_000) return;
    lastActivity.current = t;
    setActivity((n) => n + 1);
  }, []);

  const api = useCallback(
    (token: string) =>
      createApiClient(`${window.location.origin}/api`, {
        headers: { authorization: `Bearer ${token}` },
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      }).v1,
    [],
  );

  const refreshQueue = useCallback(() => {
    setQueued(readQueue().length);
    setSync(readSyncStatus());
  }, []);

  /** Sends whatever is queued. Quiet: the header shows how it went. */
  const flush = useCallback(
    async (token: string) => {
      if (syncing.current || readQueue().length === 0) return;
      syncing.current = true;
      try {
        const result = await flushQueue((json) => unwrap(api(token).kiosk.replay.$post({ json })));
        setOnline(result !== null);
      } catch (err) {
        if (err instanceof ApiError && err.code === "device_required") unpair();
      } finally {
        syncing.current = false;
        refreshQueue();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, refreshQueue],
  );

  // Lets the page itself start without the network (the queue below handles what is done offline).
  useEffect(registerKioskServiceWorker, []);

  // Load the pairing and check it still works.
  useEffect(() => {
    const stored = readPairing();
    setNow(new Date());
    refreshQueue();
    if (!stored) return setScreen({ name: "pair" });
    setPairing(stored);
    setScreen({ name: "number" });
    const asked = Date.now();
    unwrap(api(stored.token).kiosk.session.$get())
      .then((s) => {
        // The server read its clock about half-way through the round trip.
        const midway = (asked + Date.now()) / 2;
        const next: Pairing = {
          ...stored,
          deviceName: s.device.name,
          workspaceName: s.workspace.name,
          seal: s.seal,
          settings: s.settings,
          clockOffsetMs: Math.round(Date.parse(String(s.now)) - midway),
        };
        setPairing(next);
        savePairing(next);
        setOnline(true);
        void flush(stored.token);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === "device_required") unpair();
        else if (isOfflineError(err)) setOnline(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Retry the queue while anything waits, and as soon as the browser says it is back online.
  useEffect(() => {
    if (!pairing) return;
    const token = pairing.token;
    const t = setInterval(() => void flush(token), SYNC_EVERY_MS);
    const back = () => void flush(token);
    window.addEventListener("online", back);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", back);
    };
  }, [pairing, flush]);

  function unpair() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    clearQueue();
    refreshQueue();
    setPairing(null);
    setScreen({ name: "pair" });
  }

  /** Back to the start after `ms`, unless someone does something first. */
  const home = useCallback((ms = 0) => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    if (ms === 0) return setScreen({ name: "number" });
    resetTimer.current = setTimeout(() => setScreen({ name: "number" }), ms);
  }, []);
  useEffect(() => {
    // Abandoned half-way (a PIN typed, then walked off): start over.
    if (
      screen.name === "number" ||
      screen.name === "pair" ||
      screen.name === "loading" ||
      screen.name === "message"
    )
      return;
    const t = setTimeout(
      () => setScreen({ name: "number" }),
      screen.name === "prompts" ? READING_IDLE_MS : IDLE_MS,
    );
    return () => clearTimeout(t);
  }, [screen, activity]);

  const show = (tone: "ok" | "error", title: string, detail?: string) => {
    setScreen({ name: "message", tone, title, ...(detail ? { detail } : {}) });
    home(tone === "ok" ? 4000 : 5000);
  };

  /**
   * Runs a request. Errors are shown, except "can't reach the server": then `offline` runs
   * instead (queue it), if given.
   */
  async function call<T>(
    work: (v1: ReturnType<typeof api>) => Promise<T>,
    offline?: () => Promise<void> | void,
  ): Promise<T | undefined> {
    if (!pairing) return;
    setBusy(true);
    try {
      const result = await work(api(pairing.token));
      setOnline(true);
      void flush(pairing.token);
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.code === "device_required") {
        unpair();
        return;
      }
      if (isOfflineError(err)) {
        setOnline(false);
        if (offline) {
          await offline();
          return;
        }
        show("error", "The kiosk is offline", "This needs the connection. Please try again shortly.");
        return;
      }
      show("error", err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      return;
    } finally {
      setBusy(false);
    }
  }

  /** Queues an event for later; tells the person whether that worked. */
  async function queue(
    type: "clock_in" | "clock_out" | "visitor_in" | "visitor_out",
    payload: unknown,
    clientId: string,
  ) {
    if (!pairing?.seal || !canQueueOffline()) {
      show(
        "error",
        "The kiosk is offline",
        "It can't keep entries on this connection. Please tell a manager, or try again shortly.",
      );
      return null;
    }
    const sealed = { ...(payload as object), clockOffsetMs: pairing.clockOffsetMs ?? 0 };
    const stored = await enqueue(pairing.seal, type, sealed, clientId).catch(() => null);
    refreshQueue();
    if (!stored) show("error", "Couldn't save that", "Please try again, or tell a manager.");
    return stored;
  }

  const credentialFor = (who: Who, pin?: string): KioskCredential =>
    "badge" in who ? { badge: who.badge, ...(pin ? { pin } : {}) } : { staffNumber: who.staffNumber, pin };

  async function identify(cred: KioskCredential) {
    const clientId = crypto.randomUUID();
    const who = await call(
      (v1) => unwrap(v1.kiosk.identify.$post({ json: cred })),
      () => {
        if (!pairing?.seal || !canQueueOffline()) {
          show(
            "error",
            "The kiosk is offline",
            "Clocking needs the connection on this tablet. Please tell a manager.",
          );
          return;
        }
        setScreen({ name: "offline-confirm", cred, clientId });
      },
    );
    if (who) setScreen({ name: "confirm", cred, firstName: who.firstName, expected: who.expected, clientId });
  }

  function badgeRead(badge: string) {
    if (pairing?.settings?.badgeRequiresPin === false) void identify({ badge });
    else setScreen({ name: "pin", who: { badge } });
  }

  async function queueClock(cred: KioskCredential, kind: ClockKind, clientId: string) {
    const stored = await queue(kind === "in" ? "clock_in" : "clock_out", cred, clientId);
    if (stored) {
      show(
        "ok",
        `${kind === "in" ? "Clock-in" : "Clock-out"} saved at ${clockTime(stored.at)}`,
        "The kiosk is offline: it will be checked and sent when the connection is back.",
      );
    }
  }

  async function clock(cred: KioskCredential, kind: ClockKind, clientId: string) {
    const done = await call(
      (v1) => unwrap(v1.kiosk.clock.$post({ json: { ...cred, kind, clientId } })),
      () => queueClock(cred, kind, clientId),
    );
    if (!done) return;
    const title =
      done.kind === "in" ? `Clocked in at ${clockTime(done.at)}` : `Clocked out at ${clockTime(done.at)}`;
    const prompts = done.prompts as KioskPrompts | null;
    if (hasPrompts(prompts)) {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      promptToken.current = prompts?.promptToken ?? null;
      setScreen({ name: "prompts", title, firstName: done.firstName, prompts });
      return;
    }
    show(
      "ok",
      title,
      done.kind === "in"
        ? `Have a good shift, ${done.firstName}.`
        : `Thanks, ${done.firstName}. See you next time.`,
    );
  }

  async function visitor(mode: "in" | "out", details: VisitorDetails) {
    const clientId = crypto.randomUUID();
    const names = { firstName: details.firstName, lastName: details.lastName };
    const signIn = {
      ...names,
      company: details.company,
      host: details.host ? { kind: details.host.kind, id: details.host.id } : null,
      acceptedRules: details.acceptedRules,
    };
    // Queued offline, the seal also carries the rules this visitor was shown and accepted.
    const siteRules = pairing?.settings?.visitorSiteRules ?? null;
    const done = await call(
      (v1) =>
        unwrap(
          mode === "in"
            ? v1.kiosk.visitors["sign-in"].$post({ json: { ...signIn, clientId } })
            : v1.kiosk.visitors["sign-out"].$post({ json: { ...names, clientId } }),
        ),
      async () => {
        const stored = await queue(
          mode === "in" ? "visitor_in" : "visitor_out",
          mode === "in"
            ? {
                ...signIn,
                // What this visitor was shown: the visit is recorded against it on replay.
                siteRules,
                hostName: details.host?.name ?? null,
              }
            : names,
          clientId,
        );
        if (stored) {
          show(
            "ok",
            mode === "in" ? `Welcome, ${details.firstName}` : `Goodbye, ${details.firstName}`,
            mode === "in"
              ? "You're signed in (the kiosk will send it when it's back online). Please sign out here when you leave."
              : "You're signed out. Thanks for visiting.",
          );
        }
      },
    );
    if (done) {
      show(
        "ok",
        mode === "in" ? `Welcome, ${done.firstName}` : `Goodbye, ${done.firstName}`,
        mode === "in"
          ? "You're signed in. Please sign out here when you leave."
          : "You're signed out. Thanks for visiting.",
      );
    }
  }

  async function changePin(staffNumber: string, currentPin: string, newPin: string) {
    const done = await call((v1) =>
      unwrap(v1.kiosk.pin.$post({ json: { staffNumber, currentPin, newPin } })),
    );
    if (done) show("ok", "PIN changed", `Use your new PIN next time, ${done.firstName}.`);
  }

  const searchHosts = useCallback(
    async (q: string) => {
      if (!pairing) return [];
      return (await unwrap(api(pairing.token).kiosk.hosts.$get({ query: { q } }))).hosts;
    },
    [api, pairing],
  );

  return (
    <main
      className="flex min-h-dvh flex-col bg-background text-foreground select-none"
      onPointerDownCapture={touch}
      onKeyDownCapture={touch}
      onScrollCapture={touch}
      onWheelCapture={touch}
    >
      <header className="flex items-center justify-between gap-4 border-b px-4 py-4 sm:px-6 short:py-2">
        <div>
          <p className="text-lg font-semibold">{pairing?.workspaceName ?? "Knotworking"}</p>
          {pairing && <p className="text-sm text-muted-foreground">{pairing.deviceName}</p>}
        </div>
        <div className="flex items-center gap-4">
          {pairing && (
            <QueueStatus
              online={online}
              queued={queued}
              sync={sync}
              onRetry={() => void flush(pairing.token)}
            />
          )}
          {now && (
            <p className="text-3xl font-semibold tabular-nums short:text-2xl" aria-label="Time now">
              {clockTime(now)}
            </p>
          )}
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center p-4 sm:p-6 short:p-3">
        <div
          className={cn(
            "w-full max-w-md",
            // Keypad screens sit side by side on short, wide screens (see DigitEntry).
            (screen.name === "number" || screen.name === "pin" || screen.name === "change-pin") &&
              "short-wide:max-w-3xl",
            (screen.name === "prompts" || screen.name === "visitor") && "max-w-xl",
          )}
        >
          {screen.name === "loading" && <Spinner className="mx-auto size-8" />}
          {screen.name === "pair" && (
            <PairScreen
              onPaired={(p) => {
                setPairing(p);
                setScreen({ name: "number" });
                // Fetch the sealing key and settings for the new pairing.
                unwrap(api(p.token).kiosk.session.$get())
                  .then((s) => {
                    const next = { ...p, seal: s.seal, settings: s.settings };
                    setPairing(next);
                    savePairing(next);
                  })
                  .catch(() => {});
              }}
            />
          )}
          {screen.name === "number" && (
            <DigitEntry
              key="number"
              title="Enter your staff number"
              masked={false}
              onDone={(staffNumber) => setScreen({ name: "pin", who: { staffNumber } })}
              extra={
                <div className="grid w-full grid-cols-2 gap-3">
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-14 text-base"
                    onClick={() => setScreen({ name: "badge" })}
                  >
                    <QrCode data-icon="inline-start" /> Scan badge
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-14 text-base"
                    onClick={() => setScreen({ name: "visitor", mode: null })}
                  >
                    <UserRound data-icon="inline-start" /> Visitor
                  </Button>
                  <Button
                    variant="ghost"
                    size="lg"
                    className="col-span-2 h-12 text-base"
                    onClick={() =>
                      setScreen({
                        name: "change-pin",
                        step: "number",
                        staffNumber: "",
                        currentPin: "",
                        newPin: "",
                      })
                    }
                  >
                    <KeyRound data-icon="inline-start" /> Change my PIN
                  </Button>
                </div>
              }
            />
          )}
          {screen.name === "badge" && <BadgeScanner onCode={badgeRead} onCancel={() => home()} />}
          {screen.name === "pin" && (
            <DigitEntry
              key="pin"
              title="Enter your PIN"
              subtitle={"badge" in screen.who ? "Badge scanned" : `Staff number ${screen.who.staffNumber}`}
              masked
              busy={busy}
              onCancel={() => home()}
              onDone={(pin) => identify(credentialFor(screen.who, pin))}
            />
          )}
          {screen.name === "confirm" && (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-3xl font-semibold">
                {greeting()}, {screen.firstName}
              </p>
              <Button
                size="lg"
                className="h-24 text-2xl"
                disabled={busy}
                onClick={() => clock(screen.cred, screen.expected, screen.clientId)}
              >
                {screen.expected === "in" ? (
                  <LogIn data-icon="inline-start" />
                ) : (
                  <LogOut data-icon="inline-start" />
                )}
                Clock {screen.expected}
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="h-14 text-base"
                disabled={busy}
                onClick={() => clock(screen.cred, screen.expected === "in" ? "out" : "in", screen.clientId)}
              >
                Clock {screen.expected === "in" ? "out" : "in"} instead
              </Button>
              <Button variant="ghost" onClick={() => home()}>
                Cancel
              </Button>
            </div>
          )}
          {screen.name === "offline-confirm" && (
            <div className="flex flex-col gap-4 text-center">
              <p className="flex items-center justify-center gap-2 text-2xl font-semibold">
                <CloudOff className="size-6" /> The kiosk is offline
              </p>
              <p className="text-muted-foreground">
                Your PIN can't be checked right now. Choose what you're doing: it is saved with the time and
                checked when the connection is back.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  size="lg"
                  className="h-24 text-2xl"
                  disabled={busy}
                  onClick={() => queueClock(screen.cred, "in", screen.clientId)}
                >
                  <LogIn data-icon="inline-start" /> Clock in
                </Button>
                <Button
                  size="lg"
                  className="h-24 text-2xl"
                  disabled={busy}
                  onClick={() => queueClock(screen.cred, "out", screen.clientId)}
                >
                  <LogOut data-icon="inline-start" /> Clock out
                </Button>
              </div>
              <Button variant="ghost" onClick={() => home()}>
                Cancel
              </Button>
            </div>
          )}
          {screen.name === "prompts" && pairing && (
            <PromptsScreen
              title={screen.title}
              firstName={screen.firstName}
              prompts={screen.prompts}
              readSop={async (sopId) => {
                const read = await unwrap(
                  api(pairing.token).kiosk.sops[":id"].read.$post({
                    param: { id: sopId },
                    json: { promptToken: promptToken.current ?? "" },
                  }),
                );
                promptToken.current = read.promptToken;
                return read;
              }}
              acknowledge={async (sop) => {
                const ack = await unwrap(
                  api(pairing.token).kiosk.sops[":id"].acknowledge.$post({
                    param: { id: sop.sopId },
                    json: { promptToken: promptToken.current ?? "", versionId: sop.versionId },
                  }),
                );
                promptToken.current = ack.promptToken;
              }}
              onDone={() => home()}
            />
          )}
          {screen.name === "visitor" && (
            <VisitorScreen
              mode={screen.mode}
              busy={busy}
              siteRules={pairing?.settings?.visitorSiteRules ?? null}
              searchHosts={online ? searchHosts : null}
              onMode={(mode) => setScreen({ name: "visitor", mode })}
              onCancel={() => home()}
              onSubmit={visitor}
            />
          )}
          {screen.name === "change-pin" && (
            <DigitEntry
              key={screen.step}
              title={
                screen.step === "number"
                  ? "Enter your staff number"
                  : screen.step === "current"
                    ? "Enter your current PIN"
                    : screen.step === "new"
                      ? "Choose a new 6-digit PIN"
                      : "Enter the new PIN again"
              }
              subtitle="Changing your PIN"
              masked={screen.step !== "number"}
              busy={busy}
              onCancel={() => home()}
              onDone={(value) => {
                if (screen.step === "number") setScreen({ ...screen, step: "current", staffNumber: value });
                else if (screen.step === "current") setScreen({ ...screen, step: "new", currentPin: value });
                else if (screen.step === "new") setScreen({ ...screen, step: "repeat", newPin: value });
                else if (value !== screen.newPin)
                  show("error", "The PINs didn't match", "Nothing was changed. Please try again.");
                else void changePin(screen.staffNumber, screen.currentPin, value);
              }}
            />
          )}
          {screen.name === "message" && (
            <button
              type="button"
              className="flex w-full flex-col items-center gap-3 rounded-xl p-6 text-center"
              onClick={() => home()}
              aria-live="polite"
            >
              <span className={cn("text-3xl font-semibold", screen.tone === "error" && "text-destructive")}>
                {screen.title}
              </span>
              {screen.detail && <span className="text-lg text-muted-foreground">{screen.detail}</span>}
              <span className="text-sm text-muted-foreground">Tap to continue</span>
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

/** The offline queue at a glance: offline or not, how many entries wait, and the last sync. */
function QueueStatus({
  online,
  queued,
  sync,
  onRetry,
}: {
  online: boolean;
  queued: number;
  sync: SyncStatus;
  onRetry: () => void;
}) {
  if (online && queued === 0 && !sync.lastSyncAt) return null;
  return (
    <div className="flex flex-col items-end text-right text-sm" aria-live="polite">
      {!online ? (
        <span className="flex items-center gap-1.5 font-medium text-destructive">
          <CloudOff className="size-4" /> Offline
        </span>
      ) : null}
      {queued > 0 ? (
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 text-muted-foreground underline-offset-2 hover:underline"
        >
          <RefreshCw className="size-3.5" /> {queued} waiting to send
        </button>
      ) : (
        sync.lastSyncAt && (
          <span className="text-muted-foreground">All sent · {clockTime(sync.lastSyncAt)}</span>
        )
      )}
      {sync.refused > 0 && (
        <span className="text-xs text-muted-foreground">
          {sync.refused} refused: a manager can see {sync.refused === 1 ? "it" : "them"}
        </span>
      )}
    </div>
  );
}

/** Six digits from a large keypad (or a keyboard). Calls `onDone` as soon as the sixth is entered. */
function DigitEntry({
  title,
  subtitle,
  masked,
  busy = false,
  onDone,
  onCancel,
  extra,
}: {
  title: string;
  subtitle?: string;
  masked: boolean;
  busy?: boolean;
  onDone: (value: string) => void;
  onCancel?: () => void;
  /** Shown under the digit boxes (beside the keypad on short, wide screens). */
  extra?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const press = useCallback(
    (key: string) => {
      if (busy) return;
      setValue((v) => {
        if (key === "back") return v.slice(0, -1);
        if (key === "clear") return "";
        if (v.length >= 6) return v;
        const next = v + key;
        if (next.length === 6) setTimeout(() => onDone(next), 120);
        return next;
      });
    },
    [busy, onDone],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("back");
      else if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, onCancel]);

  return (
    <div className="flex flex-col items-center gap-5 short:gap-3 short-wide:grid short-wide:grid-cols-2 short-wide:grid-rows-[1fr_auto] short-wide:gap-x-10 short-wide:gap-y-5">
      <div className="flex w-full flex-col items-center gap-5 short:gap-3 short-wide:col-start-1 short-wide:self-end">
        <div className="text-center">
          <p className="text-2xl font-semibold">{title}</p>
          {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex gap-2" aria-label={`${value.length} of 6 digits entered`} role="status">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              className={cn(
                "flex size-9 items-center justify-center rounded-lg border text-2xl font-semibold tabular-nums min-[360px]:size-11 sm:size-12",
                i < value.length && "border-primary",
              )}
            >
              {i < value.length ? (masked ? "•" : value[i]) : ""}
            </span>
          ))}
        </div>
        {busy && <Spinner className="size-6" />}
      </div>
      <div className="grid w-full grid-cols-3 gap-3 short:gap-2 short-wide:col-start-2 short-wide:row-span-2 short-wide:row-start-1 short-wide:self-center">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <KeypadButton key={d} onClick={() => press(d)} disabled={busy}>
            {d}
          </KeypadButton>
        ))}
        <KeypadButton onClick={() => (value ? press("clear") : onCancel?.())} disabled={busy} small>
          {value || !onCancel ? "Clear" : "Cancel"}
        </KeypadButton>
        <KeypadButton onClick={() => press("0")} disabled={busy}>
          0
        </KeypadButton>
        <KeypadButton onClick={() => press("back")} disabled={busy} small aria-label="Delete">
          <Delete />
        </KeypadButton>
      </div>
      {extra && (
        <div className="flex w-full flex-col items-center gap-3 short-wide:col-start-1 short-wide:self-start">
          {extra}
        </div>
      )}
    </div>
  );
}

function KeypadButton({ children, small, ...props }: React.ComponentProps<"button"> & { small?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-20 items-center justify-center rounded-xl border bg-card font-semibold shadow-xs transition active:scale-95 active:bg-muted disabled:opacity-50 short:h-14",
        small ? "text-base text-muted-foreground" : "text-3xl",
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function PairScreen({ onPaired }: { onPaired: (p: Pairing) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await unwrap(
        createApiClient(`${window.location.origin}/api`).v1.public.kiosk.pair.$post({ json: { code } }),
      );
      const pairing = { token: res.token, deviceName: res.device.name, workspaceName: res.workspace.name };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
      } catch {
        setError("This browser won't store the pairing (private mode?). Use a normal window.");
        return;
      }
      onPaired(pairing);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 text-center">
      <p className="text-2xl font-semibold">Set up this kiosk</p>
      <p className="text-muted-foreground">
        A manager adds a kiosk in Attendance → Settings & kiosks and gets a pairing code. Enter it here.
      </p>
      <Input
        aria-label="Pairing code"
        autoFocus
        autoComplete="off"
        autoCapitalize="characters"
        className="h-16 text-center font-mono text-3xl tracking-[0.3em]"
        maxLength={9}
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
      />
      {error && <p className="text-destructive">{error}</p>}
      <Button
        type="submit"
        size="lg"
        className="h-14 text-lg"
        disabled={busy || code.replace(/[\s-]/g, "").length !== 8}
      >
        {busy && <Spinner data-icon="inline-start" />}
        Pair kiosk
      </Button>
    </form>
  );
}
