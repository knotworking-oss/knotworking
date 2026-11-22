# Demo business loader (Knotmilk Dairy)

`pnpm --filter @knotworking/server demo:business` fills a running Knotworking install with a complete, internally consistent mock business: a fictional UK dairy making milk, yogurt, butter, cream and soft cheese. It is for demos, screenshots and testing every module against realistic data.

It goes through the **HTTP API** as a workspace owner, so everything is written exactly as the app would write it (transactions, sync log, audit trails, four-eyes approvals). That is also why it works against a Docker install whose database you can't reach directly. Use an isolated demo instance. The loader creates privileged demo accounts and assigns them a random password.

```bash
KNW_URL=http://localhost:3000 KNW_SLUG=knotmilk \
KNW_EMAIL=<owner email> KNW_PASSWORD=<owner password> \
  pnpm --filter @knotworking/server demo:business
```

The loader accepts loopback targets by default. For an isolated remote demo, use an HTTPS origin and set `KNW_ALLOW_REMOTE=1`. The generated demo member password is shown once. Save it privately and pass it as `KNW_DEMO_PASSWORD` on reruns. Existing members still using the old public demo password require a fresh demo instance or a password reset before rerunning.

`KNW_ONLY=production,sales` runs just those waves (master data, members and a few lookups always run first, because later waves need their ids).

## What it creates

Waves run in dependency order: `members` (named manager accounts with titles, reporting lines and module access) → `foundation` (job roles, ~35 staff, suppliers with approval, items, locations, approved recipes) → `commercial` (customers, price lists, production lines) → `purchasing` (weekly purchase orders, approved above the threshold by Finance, goods-in with lots) → `production` (daily milk intake, batches that consume real lots, QA release) → `sales` (orders, despatches with allocate/pack/load check/proof of delivery, open orders, quotes) → `qms` (SOPs under document control, training courses, requirements and records) → `specifications` → `quality` → `haccp` → `site` → `testing` → `workforce` → `attendance` → `hse` / `hseIncidents` → `governance` → `labelling` / `npd` / `defence` → `finance` → `work` (teams, projects, tasks, wiki, meetings) → `supplierControls` / `stockHygiene` → `bi` / `authenticity`.

## Behaviour to know

- **Idempotent.** Each wave looks for what it created (by code, title or reference) and skips it, so re-running only fills gaps. Quantities that depend on current stock can still add a little.
- **Four-eyes.** Approvals are made by other accounts (`rhys@`, `hannah@`, `priya.d@knotmilk.example`), using the password generated for the demo instance.
- **History uses the real clock for some checks.** The API rejects expired lots, so historic production and despatches use lots that are still in date today, and production output lots carry today's received date. Raw milk is recorded without a use-by for the same reason.
- **Sign-in is rate limited.** The client waits and retries on `429`.

## Not covered

Permits to work, a real accounting adapter (Sage, Xero, QuickBooks), calendar sync, kiosk pairing and API tokens need credentials or hardware, so they are left for you to set up.
