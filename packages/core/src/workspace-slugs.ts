/**
 * Workspace slugs become the first URL path segment (`/acme/tasks`), so they must not collide with
 * the web app's other top-level routes or with paths the reverse proxy sends elsewhere (`/mcp`,
 * `/api/*`). Keep this in sync with `apps/web/src/app` and `deploy/Caddyfile` when adding routes.
 */
export const RESERVED_WORKSPACE_SLUGS: readonly string[] = [
  // Reverse-proxy / API surface
  "api",
  "mcp",
  "v1",
  "health",
  "healthz",
  // Web app top-level routes
  "login",
  "logout",
  "setup",
  "invite",
  "forgot-password",
  "reset-password",
  "design",
  "settings",
  "not-found",
  "error",
  "kiosk",
  // Framework and static paths
  "_next",
  "static",
  "public",
  "assets",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  // Conventional names ("workspace" is deliberately not reserved: it is setup's fallback slug) that would be confusing or are likely future routes
  "admin",
  "auth",
  "oauth",
  "new",
  "workspaces",
];

const reserved = new Set(RESERVED_WORKSPACE_SLUGS);

export const isReservedWorkspaceSlug = (slug: string): boolean => reserved.has(slug.trim().toLowerCase());

/**
 * Returns `slug` unchanged, or with `-workspace` appended when it is reserved
 * (`api` becomes `api-workspace`).
 */
export const safeWorkspaceSlug = (slug: string): string =>
  isReservedWorkspaceSlug(slug) ? `${slug.trim().toLowerCase()}-workspace` : slug;
