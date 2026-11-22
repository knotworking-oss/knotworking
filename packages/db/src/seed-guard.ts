const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** True for targets that only exist on this machine: PGlite, in-memory, or Postgres on localhost. */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (url.startsWith("pglite://") || url === "memory://") return true;
  if (!/^postgres(ql)?:\/\//.test(url)) return false;
  try {
    // A multi-host list is local only if every host is.
    const authority = url.slice(url.indexOf("://") + 3).split(/[/?#]/)[0]!;
    const hosts = authority.slice(authority.lastIndexOf("@") + 1).split(",");
    return hosts.every((h) => LOCAL_HOSTS.has(h.replace(/:\d+$/, "").toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * The demo seed creates an owner account (ada@knotworking.dev) with a publicly documented
 * password, and skips first-run setup. It must never run against a real deployment by accident.
 * Returns a refusal message, or null when seeding is allowed.
 */
export function seedRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV === "production") {
    return "Refusing to seed demo data: NODE_ENV=production. The demo workspace has a public owner password; use first-run setup instead.";
  }
  if (env.ALLOW_DEMO_SEED === "1" || isLocalDatabaseUrl(env.DATABASE_URL)) return null;
  return [
    "Refusing to seed demo data into a non-local database.",
    "The demo workspace creates ada@knotworking.dev as owner with a public password.",
    "If you really want this (a throwaway database), re-run with ALLOW_DEMO_SEED=1.",
    "For a real deployment, skip seeding and use first-run setup instead.",
  ].join("\n");
}
