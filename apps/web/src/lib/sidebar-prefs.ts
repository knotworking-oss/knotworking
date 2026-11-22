"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { defaultAreaCookie, lastAreaCookie, teamsCollapsedCookie } from "./sidebar-cookies";

/**
 * Sidebar preferences, kept in this browser (or the desktop app's window):
 *
 *  - the **default area**: what opening the workspace lands on. A cookie, so the server can
 *    redirect `/{slug}` without a flash;
 *  - the **last area**: what the sidebar shows on pages that belong to no area (the inbox);
 *    also a cookie, so the first paint is right;
 *  - the **recent docs**: the docs this person opened last in this workspace (localStorage, keyed by
 *    person and workspace so a shared browser doesn't mix them up).
 */

export const RECENT_DOCS_SHOWN = 5;
/** Kept beyond what is shown so deleted docs don't leave the list short. */
const RECENT_DOCS_KEPT = 12;

const recentDocsKey = (userId: string, slug: string) => `knw:recent-docs:${userId}:${slug}`;

const ONE_YEAR = 60 * 60 * 24 * 365;

// ── a tiny change feed, so every hook in this tab updates when a preference is written ──

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Other tabs write localStorage; cookies have no event, so they refresh on focus.
  window.addEventListener("storage", listener);
  window.addEventListener("focus", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
    window.removeEventListener("focus", listener);
  };
};

// ── cookies ──

export function readCookie(
  name: string,
  source: string = typeof document === "undefined" ? "" : document.cookie,
) {
  for (const part of source.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function writeCookie(name: string, value: string | null) {
  document.cookie =
    value === null
      ? `${name}=; path=/; max-age=0; samesite=lax`
      : `${name}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  notify();
}

/**
 * A cookie preference. `initial` is what the server saw, used for the first (server and hydration)
 * render so they agree; after that the live cookie wins.
 */
function useCookie(name: string, initial: string | null) {
  const value = useSyncExternalStore(
    subscribe,
    () => readCookie(name),
    () => initial,
  );
  const set = useCallback((next: string | null) => writeCookie(name, next), [name]);
  return [value, set] as const;
}

export function useDefaultArea(slug: string, initial: string | null) {
  return useCookie(defaultAreaCookie(slug), initial);
}

export function useLastArea(slug: string, initial: string | null) {
  return useCookie(lastAreaCookie(slug), initial);
}

/** Whether the Teams list is folded away (open until the viewer folds it). */
export function useTeamsCollapsed(slug: string, initial: boolean) {
  const [value, set] = useCookie(teamsCollapsedCookie(slug), initial ? "1" : null);
  const setCollapsed = useCallback((collapsed: boolean) => set(collapsed ? "1" : null), [set]);
  return [value === "1", setCollapsed] as const;
}

// ── recent docs ──

/** Puts `id` first, drops repeats, and keeps the newest `max`. */
export function pushRecent(list: readonly string[], id: string, max = RECENT_DOCS_KEPT): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

/** Parses what is stored; anything unexpected reads as "no recent docs". */
export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function readRaw(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage blocked (private mode): the list just stays empty
  }
}

/** Notes that this person opened a doc. */
export function recordRecentDoc(userId: string, slug: string, docId: string) {
  const key = recentDocsKey(userId, slug);
  const current = parseRecent(readRaw(key));
  if (current[0] === docId) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(pushRecent(current, docId)));
  } catch {
    return;
  }
  notify();
}

/** The doc ids this person opened, newest first. Empty on the server and until hydrated. */
export function useRecentDocIds(userId: string, slug: string): string[] {
  const key = recentDocsKey(userId, slug);
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
  return useMemo(() => parseRecent(raw), [raw]);
}
