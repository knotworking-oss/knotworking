"use client";

import { effectiveCurrency, effectiveTimeZone, todayInZone } from "@knotworking/core";
import { useCallback } from "react";
import { formatDateTime } from "./format";
import { useOptionalWorkspace } from "./workspace-store";

/**
 * The workspace's time zone in client components: business dates ("today", the latest date a
 * record may have, the current week) are decided in it, never in the browser's zone. Server
 * components use `getWorkspaceTimeZone` / `getWorkspaceToday` (lib/api.ts). A stored zone that
 * isn't valid falls back to the default, as it does on the server.
 */
export function useWorkspaceTimeZone(): string {
  return effectiveTimeZone(useOptionalWorkspace()?.idx.boot.workspace.timeZone).timeZone;
}

/** The workspace's currency (ISO 4217): costs and prices in client components are shown in it. */
export function useWorkspaceCurrency(): string {
  return effectiveCurrency(useOptionalWorkspace()?.idx.boot.workspace.currency);
}

/** Today (`YYYY-MM-DD`) in the workspace's time zone. */
export function useWorkspaceToday(): string {
  return todayInZone(useWorkspaceTimeZone());
}

/**
 * `formatDateTime` bound to the workspace's zone, for client components that show a timestamp:
 * the zone is explicit, so the server render and the browser agree (no hydration mismatch) and the
 * time reads the same for everyone in the workspace.
 */
export function useFormatDateTime(): (value: string | Date | null | undefined) => string {
  const timeZone = useWorkspaceTimeZone();
  return useCallback((value) => formatDateTime(value, timeZone), [timeZone]);
}
