import { afterEach, describe, expect, it } from "vitest";
import { isTransactionPooler, migrationDatabaseUrl, sanitizePostgresUrl } from "./client";

describe("sanitizePostgresUrl", () => {
  it("strips Neon's channel_binding but keeps sslmode", () => {
    expect(
      sanitizePostgresUrl(
        "postgresql://u:p@ep-cool-1-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      ),
    ).toBe("postgresql://u:p@ep-cool-1-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require");
    expect(sanitizePostgresUrl("postgresql://u:p@h/db?channel_binding=require&sslmode=require")).toBe(
      "postgresql://u:p@h/db?sslmode=require",
    );
  });

  it("drops the query string when nothing is left", () => {
    expect(sanitizePostgresUrl("postgresql://u:p@h/db?channel_binding=require")).toBe(
      "postgresql://u:p@h/db",
    );
  });

  it("strips other libpq-only options and leaves postgres.js options alone", () => {
    expect(
      sanitizePostgresUrl("postgres://u:p@h/db?gssencmode=disable&application_name=kw&sslrootcert=system"),
    ).toBe("postgres://u:p@h/db?application_name=kw&sslrootcert=system");
  });

  it("leaves URLs without libpq-only params, and odd passwords, untouched", () => {
    for (const url of [
      "postgres://postgres:postgres@localhost:5432/knotworking",
      "postgres://u:p%40ss%2Fword@h:5432/db?sslmode=require",
      "postgres://u:p@h1:5432,h2:5432/db?target_session_attrs=primary",
    ]) {
      expect(sanitizePostgresUrl(url)).toBe(url);
    }
  });
});

describe("migrationDatabaseUrl", () => {
  it("prefers MIGRATE_DATABASE_URL and falls back to DATABASE_URL", () => {
    expect(
      migrationDatabaseUrl({ DATABASE_URL: "postgres://pooled", MIGRATE_DATABASE_URL: "postgres://direct" }),
    ).toBe("postgres://direct");
    expect(migrationDatabaseUrl({ DATABASE_URL: "postgres://pooled", MIGRATE_DATABASE_URL: "" })).toBe(
      "postgres://pooled",
    );
    expect(migrationDatabaseUrl({ DATABASE_URL: "postgres://pooled" })).toBe("postgres://pooled");
    expect(migrationDatabaseUrl({})).toBeUndefined();
  });
});

describe("isTransactionPooler", () => {
  afterEach(() => delete process.env.DATABASE_POOLED);

  it("detects free-tier poolers that can't use prepared statements", () => {
    expect(isTransactionPooler("postgresql://u:p@ep-cool-1-pooler.eu-central-1.aws.neon.tech/neondb")).toBe(
      true,
    );
    expect(isTransactionPooler("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres")).toBe(
      true,
    );
    // Supabase session mode (5432) and direct connections keep prepared statements.
    expect(isTransactionPooler("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres")).toBe(
      false,
    );
    expect(isTransactionPooler("postgresql://u:p@ep-cool-1.eu-central-1.aws.neon.tech/neondb")).toBe(false);
    expect(isTransactionPooler("postgres://postgres:postgres@localhost:5432/knotworking")).toBe(false);
  });

  it("can be forced with DATABASE_POOLED", () => {
    process.env.DATABASE_POOLED = "true";
    expect(isTransactionPooler("postgres://localhost/knotworking")).toBe(true);
  });
});
