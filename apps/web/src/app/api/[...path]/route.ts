import { CLIENT_IP_HEADER } from "@knotworking/core";
import type { NextRequest } from "next/server";

/**
 * Same-origin gateway to the Knotworking API. Browsers only ever talk to the web
 * app's own origin, so sign-in cookies are first-party on any host (LAN server,
 * cloud VM, custom domain). Configured at runtime via API_URL, so one Docker
 * image works everywhere.
 *
 *   /api/auth/*  → API /api/auth/*   (Better Auth)
 *   /api/v1/*    → API /v1/*         (Knotworking API)
 */
const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";
const HOP_BY_HOP = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"];
/** Client-supplied address headers — never trusted as-is. */
const SPOOFABLE = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "true-client-ip",
  "cf-connecting-ip",
  CLIENT_IP_HEADER,
];

/**
 * How many reverse proxies sit in front of this server and append to
 * X-Forwarded-For (compose.yaml runs Caddy, so 1). The client address is the
 * entry that the outermost trusted proxy recorded; anything further left could
 * have been sent by the browser. In development Next.js fills it in itself.
 */
const TRUSTED_PROXIES = Number(
  process.env.TRUSTED_PROXIES ?? (process.env.NODE_ENV === "production" ? 0 : 1),
);

function clientIp(req: NextRequest) {
  if (TRUSTED_PROXIES <= 0) return undefined; // unknown → the API rate-limits conservatively
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return chain[chain.length - TRUSTED_PROXIES];
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = path[0] === "v1" ? `/${path.join("/")}` : `/api/${path.join("/")}`;
  const url = new URL(target + req.nextUrl.search, API_URL);

  const headers = new Headers(req.headers);
  for (const h of [...HOP_BY_HOP, ...SPOOFABLE]) headers.delete(h);
  const ip = clientIp(req);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  headers.set("x-forwarded-host", req.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", req.nextUrl.protocol.replace(":", ""));

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    // Streamed, not buffered: file uploads (`POST /v1/workspaces/:slug/attachments`) can be
    // several MB, and the API enforces its own size limit while reading. Route handlers have no
    // body-size limit of their own (that only applies to Server Actions and `proxy.ts`).
    body: hasBody ? req.body : undefined,
    // Required by fetch for a streamed request body.
    ...(hasBody ? { duplex: "half" as const } : {}),
    redirect: "manual", // pass OAuth / reset-password redirects through to the browser
    cache: "no-store",
    // When the browser goes away, so does the upstream request (matters for the
    // long-lived `/events` stream, which would otherwise stay open on the API).
    signal: req.signal,
  });

  const out = new Headers(upstream.headers);
  // fetch already decoded the body.
  out.delete("content-encoding");
  out.delete("content-length");
  for (const h of HOP_BY_HOP) out.delete(h);
  // Creating a token returns its plaintext once; keep that response out of every cache.
  if (path[0] === "v1" && path[1] === "me" && path[2] === "api-tokens") out.set("cache-control", "no-store");
  // The body is passed through as a stream, unbuffered, so server-sent events
  // (`/v1/workspaces/:slug/events`) arrive as they're written. The API marks
  // them `no-transform` so Next.js compression leaves them alone.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export const dynamic = "force-dynamic";
export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT };
