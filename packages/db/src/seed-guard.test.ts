import { describe, expect, it } from "vitest";
import { isLocalDatabaseUrl, seedRefusal } from "./seed-guard";

describe("seedRefusal", () => {
  it("allows local development targets with no flags", () => {
    expect(seedRefusal({})).toBeNull();
    expect(seedRefusal({ DATABASE_URL: "" })).toBeNull();
    expect(seedRefusal({ DATABASE_URL: "pglite://.data/pglite" })).toBeNull();
    expect(seedRefusal({ DATABASE_URL: "memory://" })).toBeNull();
    expect(
      seedRefusal({ DATABASE_URL: "postgres://postgres:postgres@localhost:5432/knotworking" }),
    ).toBeNull();
    expect(seedRefusal({ DATABASE_URL: "postgres://u:p@127.0.0.1/db" })).toBeNull();
    expect(seedRefusal({ DATABASE_URL: "postgres://u:p@[::1]:5432/db" })).toBeNull();
  });

  it("refuses hosted databases unless ALLOW_DEMO_SEED=1", () => {
    const url = "postgresql://u:p@ep-cool-1-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";
    expect(seedRefusal({ DATABASE_URL: url })).toMatch(/ALLOW_DEMO_SEED=1/);
    expect(seedRefusal({ DATABASE_URL: url, ALLOW_DEMO_SEED: "true" })).not.toBeNull();
    expect(seedRefusal({ DATABASE_URL: url, ALLOW_DEMO_SEED: "1" })).toBeNull();
    expect(seedRefusal({ DATABASE_URL: "postgres://u:p@db:5432/knotworking" })).not.toBeNull();
  });

  it("is not fooled by a local-looking username or path", () => {
    expect(isLocalDatabaseUrl("postgres://localhost:pw@evil.example.com/localhost")).toBe(false);
    expect(isLocalDatabaseUrl("postgres://u:p@evil.example.com/db?host=localhost")).toBe(false);
    expect(isLocalDatabaseUrl("postgres://u:p@localhost,evil.example.com/db")).toBe(false);
  });

  it("always refuses in production", () => {
    expect(seedRefusal({ NODE_ENV: "production" })).toMatch(/production/);
    expect(seedRefusal({ NODE_ENV: "production", ALLOW_DEMO_SEED: "1" })).toMatch(/production/);
  });
});
