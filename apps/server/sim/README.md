# Simulation and audit harness

End-to-end "year in the life" tests for a food manufacturer. They drive the real API in-process (no
browser, no network) with a faked clock, so a year of business dates runs in 30 to 45 minutes. Nothing
here runs under `pnpm test`; run it on purpose, from `apps/server`:

```bash
# Full year: 20 people, purchasing to despatch, HACCP, quality, training, mid-year events, then probes.
SIM_WEEKS=52 SIM_SEED=1 npx vitest run -c sim/vitest.sim.config.ts sim/full.sim.ts

# Every registered route: unauthenticated, cross-tenant, guest and ungranted-member access, and 500s.
npx vitest run -c sim/vitest.sim.config.ts sim/routes.sim.ts

# Authorization and session probes on a populated workspace (roles, invitations, sync leakage, CSRF).
npx vitest run -c sim/vitest.sim.config.ts sim/authz.sim.ts

# Short run followed by the adversarial probes only.
SIM_WEEKS=3 npx vitest run -c sim/vitest.sim.config.ts sim/probes.sim.ts
```

By default each run uses in-memory PGlite. Set `SIM_PG_URL=postgres://user:pass@host:5432/db` to run on
a real, **empty** Postgres database instead (it migrates and seeds it, so recreate it between runs).
Only real Postgres can show lock races that PGlite's single connection hides.

`SIM_SEED` makes a run repeatable. `SIM_END` sets the last simulated day (default 2026-11-13); the run
starts `SIM_WEEKS` weeks before it. Results are written to `sim/out/` (ignored by git).

## Large-ledger scale test (real Postgres only)

`sim/scale/` loads millions of synthetic stock movements into a Postgres database and times the real API
on top of them. It needs its own empty database (`simbig` below), and about 1 GB of disk per million movements.

```bash
createdb simbig
SIM_PG_URL=postgres://user:pass@localhost:5432/simbig npx vitest run -c sim/vitest.sim.config.ts sim/scale/base.sim.ts
sim/scale/run-tiers.sh   # measures 1M, then loads and measures about 4M and 12M movements
```

`base.sim.ts` builds the real people, master data and a fortnight of activity and writes ids to
`sim/out/scale-base.json`. `load.sh <lots> <tag>` bulk-inserts lots, four movements per lot and the matching
sync-log rows with SQL. `measure.sim.ts` (set `TIER`) times every read route with no path parameters,
targeted ledger reads, single writes, 20 concurrent writers, 30 concurrent readers, and readers mixed with
writers. Tune Postgres first (shared_buffers, work_mem) and run `analyze` after each load.

## What it checks

- **Ledger**: the server's stock levels against an independent model kept by the simulation, every
  Friday and at the end; lot balances against movements; no negative stock.
- **Traceability**: backward trace of finished lots against what was consumed; recall impact lists
  every customer who received derived product; order fulfilment against what was despatched.
- **Safety rules**: quarantined and use-by-expired lots cannot be consumed or despatched; concurrent
  consumption cannot overdraw; replayed commands act once; deletes on records with history are
  refused; a deactivated person loses access at once; cleaning needs a second person to verify.
- **Food safety**: the server's verdict on each CCP reading matches the critical limit.
- **Scale**: timing and size of the main reads at one year of data, and a full sync-log replay.
- **Security**: see `routes.sim.ts` and `authz.sim.ts`.

Anything unexpected is recorded as a finding (collapsed by kind, with a count). Server errors (5xx)
always are. Most early findings were mistakes in the harness itself, so read the detail before
assuming a product bug.

## Known limits

- The plant is simplistic: purchasing is reactive, so a seed can run short of ingredients and cancel
  many batches. That is realistic enough for ledger checks, not for operational planning.
- Business dates are backdated and the application clock is faked, but database `now()` defaults use
  the real time, so `createdAt` and `updatedAt` do not follow the simulated dates.
- Not covered: attendance kiosks, workforce rota and payroll, accounting and costing exports, SOP and
  document review cycles, the assistant, the calendar, backup and restore, and the web UI.
