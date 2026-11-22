# Database

Knotworking uses **PostgreSQL**. It's free and open source, every major host runs it, and it's what the sync design relies on (transactions, advisory locks, JSONB). Every option below costs nothing at the scale of a test project or a small team, and you switch between them by changing `DATABASE_URL`.

| Option                      | Cost                  | Best for                                                  | Setup                                               |
| --------------------------- | --------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| **PGlite** (default)        | Free, runs in-process | Solo development, demos, CI                               | Nothing — leave `DATABASE_URL` unset                |
| **Neon** (recommended host) | Free tier             | A shared test project or small team                       | Sign up → copy the pooled connection string         |
| **Supabase**                | Free tier             | Same, if you also want their extras (auth, storage) later | Create project → copy the transaction pooler string |
| **Docker Postgres**         | Free, self-hosted     | Local dev against a full server                           | `docker compose -f compose.dev.yaml up -d`          |

Free tiers change. Check each provider's pricing page for current storage and compute limits. For a small team's tasks and docs, the data stays small (megabytes, not gigabytes).

### Neon free plan (as of November 2026)

Source: [neon.com/pricing](https://neon.com/pricing) and the [free plan FAQ](https://neon.com/faqs/free-plan-limits-and-quotas). No time limit and no credit card.

| Limit                | Free plan                                                               |
| -------------------- | ----------------------------------------------------------------------- |
| Projects             | 100                                                                     |
| Storage              | 1 GB per project (20 GB across all projects)                            |
| Compute              | 100 CU-hours per project per month; compute sizes up to 2 CU (8 GB RAM) |
| Branches             | 10 per project                                                          |
| Public data transfer | 5 GB per month                                                          |
| Team members         | Unlimited                                                               |

- Compute auto-suspends when idle and uses no CU-hours while suspended, so the first request after a pause is slower.
- Past 1 GB, writes that would grow storage fail until you free space or upgrade. Free projects are never billed for overages.
- Suspended databases still count toward the storage cap.
- Some older third-party pages list 0.5 GB per project. That is out of date.

## Why Neon is the recommended host

- It's plain Postgres, so there's no lock-in. You can move to Supabase, RDS, or your own server with `pg_dump`.
- It scales to zero when idle, which is what makes the free tier free.
- Database branching gives you a copy of production data for a preview or test in seconds.

Supabase is a good alternative. Its free projects pause after a period of inactivity, and Knotworking handles sign-in itself (see [architecture](architecture.md#authentication-and-access)), so it only needs the Postgres part.

## Hosted databases start empty

A new Neon or Supabase database has no data. Do **not** run `pnpm db:seed` or `pnpm db:setup` against it: the demo data includes an owner account (`ada@knotworking.dev`) with a **publicly documented password**, and seeding skips the first-run setup, so anyone who knows the demo login could sign in to your workspace. The seed script refuses to run against a non-local database unless you set `ALLOW_DEMO_SEED=1`; only do that for a throwaway test database.

Instead, apply the migrations (the Docker image does this on start; with `pnpm dev` run `pnpm db:migrate` first) and start the API. Because there are no users yet, it prints a one-time setup link in its log (or uses `SETUP_TOKEN` if you set one). Open it, and the first-run setup screen creates your workspace and owner account. See [self-hosting.md](self-hosting.md#1-install).

## Using Neon

1. Create a free account at neon.tech and a project (choose a region near your users).
2. In **Connection details**, enable **Connection pooling** and copy the connection string. The host contains `-pooler`.
3. Put it in `.env` (or `deploy/.env` when self-hosting):
   ```bash
   DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
   ```
   Neon's copied string often ends in `&channel_binding=require`. Knotworking removes that parameter automatically (the Postgres driver can't pass it on), but you can also delete it from the string yourself.
4. Also copy the **direct** (non-pooled) string, with the same host minus `-pooler`, and set it as `MIGRATE_DATABASE_URL`. Migrations use it instead of the pooler, which is more reliable for schema changes:
   ```bash
   MIGRATE_DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx.REGION.aws.neon.tech/neondb?sslmode=require
   ```
   If you leave it unset, migrations run over `DATABASE_URL`.
5. Create the schema. The Docker image does this automatically when the API container starts. Otherwise run:
   ```bash
   pnpm db:migrate
   ```

## Using Supabase

1. Create a free project at supabase.com.
2. **Connect → Connection string → Transaction pooler** (port `6543`). Copy it and fill in your password.
3. `DATABASE_URL=postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres?sslmode=require`
4. Use the **pooler** strings, not the "direct connection" host (`db.PROJECT.supabase.co`): on the free plan the direct host only has an IPv6 address, which most home networks, VMs and Docker setups can't reach. The **session pooler** string (port `5432` on the same `pooler.supabase.com` host, IPv4-capable) is a good choice for `MIGRATE_DATABASE_URL`; the transaction pooler (port `6543`) is for `DATABASE_URL`.
5. Create the schema with `pnpm db:migrate` (the Docker image does it on start). Don't seed (see above).

## Hosted database with the Docker Compose stack

Set `DATABASE_URL` (and `MIGRATE_DATABASE_URL`) in `deploy/.env`. The `api` container uses them instead of the bundled Postgres; the bundled `db` container still starts (and `POSTGRES_PASSWORD` is still required) but nothing uses it. Back up the hosted database with `pg_dump` against the direct URL, as described in [self-hosting.md](self-hosting.md#6-backups).

## Connection details handled for you

- **Poolers:** Neon's `-pooler` hosts and Supabase's port-6543 pooler run in _transaction mode_, which doesn't support prepared statements. Knotworking detects these hosts and disables prepared statements automatically (`isTransactionPooler` in `packages/db/src/client.ts`). Set `DATABASE_POOLED=true|false` to override.
- **TLS:** `?sslmode=require` in the URL turns on TLS.
- **Migrations:** run over `MIGRATE_DATABASE_URL` when set (use a direct, non-pooled URL), otherwise `DATABASE_URL`. The pooled `DATABASE_URL` is used for everything else.
- **`channel_binding`:** removed from Neon URLs automatically.
- **Pool size:** `DATABASE_POOL_SIZE` (default 10) controls connections per API process. Keep it low on free tiers.

## Migrations

Migrations are plain SQL in `packages/db/migrations`, so they run unchanged on PGlite, Neon, Supabase or any Postgres 14+ server. After migrating, the API analyzes any table that has never been analyzed (autovacuum only does so after about 50 changed rows, so small master tables would otherwise keep default planner estimates). The Docker image applies pending migrations each time the API container starts. Elsewhere, run `pnpm db:migrate` yourself. Both use `MIGRATE_DATABASE_URL` if set, otherwise `DATABASE_URL`.

## Search

`GET /v1/workspaces/:slug/search` (docs and tasks, title and body) runs on plain Postgres full-text search, with **no stored index and no migration**, so it behaves the same on PGlite, Neon, Supabase and Docker Postgres (Postgres 12+: it uses `jsonb_path_query` and `to_tsvector`/`to_tsquery`, both built in). See [architecture.md](architecture.md#search) for the API; this is the database side.

- **Plain text on the fly.** Bodies are JSONB block trees. The query derives one line per text block (paragraph, heading, code block) with a `jsonb_path_query` over the same shape `docToPlainText` reads, concatenating a block's text nodes so bold or linked fragments inside a word stay one word.
- **Candidate set.** Each search looks at the workspace's 2000 most recently updated live rows per kind (`SEARCH_CANDIDATE_LIMIT` in `apps/server/src/services/search.ts`), a few milliseconds of work for a small team. Rows beyond the cap (older than the 2000 newest) are not searched.
- **Matching.** `to_tsvector('simple', …)` (no stemming or stop words: language-neutral and independent of the server's locale settings) against a `to_tsquery` built from the query's letter and digit runs as prefixes (`plan:*`), all required, in any order; **or** a case-insensitive substring match of the whole query (`ILIKE … ESCAPE`, with `%`, `_` and `!` escaped) for what the text-search parser splits differently (`C++`, `foo.bar()`, email addresses). User input only reaches SQL as bound parameters.
- **Ranking.** `ts_rank` with titles weighted above bodies, plus bonuses for a title containing or starting with the query; newest first on ties.
- **Scaling up.** If a workspace outgrows the candidate cap, store the extracted text in a generated `tsvector` column with a GIN index (maintained in the same transaction as the document write, like `recordChanges`) and keep the query shape; that needs a migration, so it is deferred until it is needed.

## Stock balances and upgrading a large ledger

`stock_balances` is the running sum of `stock_movements` per lot and location, kept by a trigger. Migration `0084_stock_balances` creates it, fills it from the existing ledger and installs the trigger in one transaction, holding a `SHARE ROW EXCLUSIVE` lock on `stock_movements` so no movement can slip in between. Reads continue; writes to the ledger wait until it commits. Measured on PostgreSQL 16 with 12 million movements and 3 million lots it took about 2.5 minutes, most of it building indexes, so for a ledger that large run the upgrade in a quiet period. A small ledger takes well under a second. After restoring a dump made without triggers, run `reconcileStockBalances` (it reads the whole ledger) and, if it reports differences, re-fill the table from the ledger.
