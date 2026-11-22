"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "./auth-client";

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error" | "conflict";

/**
 * Debounced autosave for partial updates (e.g. a PATCH body).
 *
 * `schedule` merges a patch into the pending changes and saves after `delay` ms
 * of quiet; `flush` saves now. One request is in flight at a time: edits made
 * meanwhile are sent right after it. A failed save keeps its changes pending,
 * shows a toast with a retry, and is retried on the next edit. Pending changes
 * are flushed on unmount, and the browser warns before leaving with unsaved ones.
 *
 * `pauseOn` marks errors that must not be retried automatically (a save conflict): the changes stay
 * pending, nothing more is sent and no toast is shown (status `conflict`), until `resume` (send them
 * anyway) or `discard` (drop them) is called.
 */
export function useAutosave<T extends object>(
  save: (patch: T) => Promise<unknown>,
  {
    delay = 800,
    errorTitle = "Couldn't save your changes",
    pauseOn,
  }: { delay?: number; errorTitle?: string; pauseOn?: (err: unknown) => boolean } = {},
) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const pending = useRef<T | null>(null);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paused = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const pauseOnRef = useRef(pauseOn);
  pauseOnRef.current = pauseOn;

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (saving.current || paused.current || !pending.current) return;
    const patch = pending.current;
    pending.current = null;
    saving.current = true;
    setStatus("saving");
    let failed = false;
    try {
      await saveRef.current(patch);
    } catch (err) {
      failed = true;
      // Keep the failed changes, under anything typed since.
      pending.current = { ...patch, ...(pending.current as T | null) };
      if (pauseOnRef.current?.(err)) {
        paused.current = true;
        return setStatus("conflict"); // `finally` still clears `saving`
      }
      toast.error(errorTitle, {
        id: "autosave-error",
        description: errorMessage(err),
        action: { label: "Retry", onClick: () => void flush() },
      });
    } finally {
      saving.current = false;
    }
    if (failed) return setStatus("error");
    toast.dismiss("autosave-error");
    if (pending.current) return flush();
    setStatus("saved");
  }, [errorTitle]);

  const schedule = useCallback(
    (patch: T) => {
      pending.current = { ...pending.current, ...patch } as T;
      if (paused.current) return;
      setStatus("pending");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [delay, flush],
  );

  /** Sends the paused changes after all (the caller has dealt with the reason they were held back). */
  const resume = useCallback(() => {
    paused.current = false;
    return flush();
  }, [flush]);

  /** Drops the pending changes and unpauses (e.g. after loading the other version). */
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    paused.current = false;
    setStatus("idle");
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current || saving.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      // Navigating away within the app: send what's left.
      void flush();
    };
  }, [flush]);

  return { status, schedule, flush, resume, discard };
}
