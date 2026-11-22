"use client";

import { createApiClient, unwrap, ApiError } from "@knotworking/api-client";
import { createAuthClient } from "better-auth/react";

/** Better Auth in the browser — talks to /api/auth on this origin. */
export const authClient = createAuthClient();

/**
 * Typed API client for browser-side mutations (same-origin /api/v1 → API). Client components may
 * build it while rendering (only calling it from handlers), which also runs during the server
 * render, where there is no `window`: that client gets a placeholder origin and is never called.
 */
export const browserApi = () =>
  createApiClient(`${typeof window === "undefined" ? "http://localhost" : window.location.origin}/api`);

export { unwrap, ApiError };

/** Like `unwrap` for endpoints that answer 204 No Content: resolves on success, throws `ApiError` otherwise. */
export async function unwrapEmpty(responsePromise: Promise<Response>) {
  const res = await responsePromise;
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  throw new ApiError(
    res.status,
    body?.error?.code ?? "unknown",
    body?.error?.message ?? `Request failed (${res.status})`,
  );
}

export function errorMessage(err: unknown) {
  if (err instanceof ApiError) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string")
    return err.message;
  return "Something went wrong. Please try again.";
}
