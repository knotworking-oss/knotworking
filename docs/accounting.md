# Accounting integrations

Knotworking is intended as an open source tool that can work with different accounting systems. Each installation chooses whether to connect one. The shared accounting layer is provider-neutral; product-specific APIs, SDKs, credentials and import layouts belong in separate adapters. Sage 50 Accounts is an initial adapter candidate, not a prerequisite or a global accounting choice. Xero, QuickBooks and other systems can implement the same interface.

Knotworking owns operational records and sales orders. A connected accounting system owns its financial ledger, tax filing, payment processing and financial accounts. This foundation does not implement another general ledger.

## Current delivery

`apps/server/src/accounting/adapter.ts` defines `AccountingAdapter`, bound to a provider, connection UUID and external company. It declares supported document kinds and currencies. The dispatcher refuses a mismatched provider, connection, company or unsupported capability before claiming the job or calling the adapter.

The durable outbox in `apps/server/src/accounting/outbox.ts` and shared schemas in `packages/core/src/accounting.ts` accept prepared purchase invoices. Supplier, account and tax references are opaque strings: each adapter translates reviewed mappings into its destination's identifiers. Providers use extensible identifiers, so contributors do not need to edit a central enum to introduce an adapter.

Amounts are exact decimal strings validated against the document currency's precision, including zero-decimal and three-decimal currencies. Line totals reconcile exactly; the shared layer never infers a tax rate, mapping, currency conversion or rounding correction. Each adapter advertises the currencies it actually implements, even if the shared schema accepts more.

Current delivery is an internal backend foundation. Optional administrator setup is available at `/<workspace>/settings/accounting` when the `accounting` module is explicitly enabled. Administrators can [prepare approved purchase invoices](#preparing-approved-purchase-invoices) into the private outbox. A [Xero HTTP adapter library](xero.md) is implemented with fake-transport tests. Live authentication/acceptance and scheduled dispatchers remain future work. The shared tests use fake adapters representing independent providers; the Xero implementation also tests its HTTP contract with a fake transport. They prove software behaviour without external accounts; they do not establish live Sage, Xero or QuickBooks compatibility. Phase 3.4.2 remains in progress.

## Posting lifecycle and isolation

- Each workspace, connection and source invoice has one immutable prepared snapshot. An identical enqueue returns its existing ID; changed source revisions or mappings conflict. A connection's provider and company cannot be rebound after use. A separate explicitly configured connection has its own source and external-ID namespace; sending to several connections will eventually need explicit finance permissions and routing rules.
- The posting UUID is a stable retry reference, distinct from each attempt UUID. A provider-local transaction ID is unique within a connection, so equal IDs from different accounting systems do not collide. Read-back must match provider, connection, company, posting reference, currency and exact totals.
- Claiming commits `unknown` before external IO. A lost reply, crash or invalid acknowledgement remains uncertain and cannot be resent automatically. A definitive no-write rejection is `failed`; an explicit reviewed retry keeps the same snapshot/key and records a new attempt. A timeout, partial write or unsuccessful search is not proof of no write.
- Positive destination read-back reconciles an uncertain posting to `posted`. Repeating the same confirmation is idempotent. Stale callbacks, mismatched destinations and contradictory transaction IDs are rejected. No-post resolution after uncertainty is deliberately deferred until a connector can prove quiescence and authoritative reconciliation.
- Every transition retains actor, attempt and evidence. Private snapshots, receipts and history bypass shared workspace sync deliberately. Raw exceptions are not stored; adapters must sanitise evidence. These functions are trusted server internals: actor labels and connection UUIDs are not authentication.

## Contributing an adapter

1. Pick a stable provider ID such as `sage_50_accounts_uk`, `xero` or a community identifier. Keep credentials, SDK models and provider-specific validation in the implementation. Provider IDs in the schemas do not imply an implemented adapter.
2. Implement `AccountingAdapter` for one configured connection/company. Declare only verified posting kinds and currencies. Translate the canonical purchase invoice through reviewed supplier/account/tax mappings. Refuse unsupported cases visibly; do not guess VAT or silently discard lines.
3. Preserve the stable posting reference and implement authoritative read-back. Return `posted` only with destination transaction evidence. Return `rejected` only when there was definitively no write. Partial writes and ambiguous failures must remain `unknown`. File generation alone is not proof of an accounting import.
4. Test against a fake transport and run the shared outbox suite. Cover success, definitive rejection, duplicate enqueue, lost replies after a write, stale attempts, wrong company/provider/connection, unsupported currency and conflicting external IDs. Provider acceptance also needs line/account/tax verification, not only totals.
5. Use the provider's supported test facility when implementing its live adapter. Product versions, sandbox accounts and credentials are deployment/adapter concerns; they are not prerequisites for working on the shared tool. Document that adapter's limitations and acceptance evidence separately.

Installed adapters are registered as server-side factories (see [Dispatch and the finance review queue](#dispatch-and-the-finance-review-queue)). Connection metadata and reviewed mappings are stored privately. Live provider compatibility requires separate validation.

## Verification

Run the core `src/accounting.test.ts` and server `src/accounting/outbox.test.ts`, `src/accounting-invoice-producer.test.ts` and `src/accounting-queue.test.ts` suites. The latter migrates an in-memory Postgres database. It exercises the shared lifecycle using test adapters without requiring accounting software or credentials.

## Optional setup and mappings

Enable `accounting` in `KNOTWORKING_MODULES` (or choose `all`) and open **Accounting connections** in the user menu as an owner/admin. The tool continues to work with no saved connections. Choose a provider and a friendly name; company identity can be left blank until known. No passwords, access tokens or client secrets are accepted by setup routes, and the UI does not claim a live connection has been established.

The admin API lives under `/v1/workspaces/:slug/accounting`: list/create connections, read/update `connections/:id`, put reviewed `connections/:id/mappings`, inspect paginated `connections/:id/history`, and search permitted local supplier/customer `references`. The environment module guard and administrator check apply on every call; personal API tokens are refused. Suppliers additionally require Items read access and customers require Customers read access; foreign-workspace records cannot be mapped. Source names are returned only while that source module is readable. Account/tax keys are local semantic names, not a second chart of accounts or tax-rate register.

Updates and mapping reviews require a current revision, reason and command UUID. Repeated commands return their receipt, stale revisions conflict, and mapping correction/withdrawal retains previous values, reviewer and reason in private history. Connections are disabled rather than deleted; disabled connections block both new snapshots and dispatch claims. Earlier uncertain postings can still be positively reconciled after a connection is disabled. The setup UI supports connection/history paging, source searching and mapping review; this first increment caps each connection at 500 mappings and refuses overflow. Backfilled foundation destinations retain no invented human author.

## Preparing approved purchase invoices

Purchasing records one header VAT amount per invoice and unrounded line values (quantity × an 8-place unit price), and its lines carry no account or tax code. Approved invoices are immutable, so this coding is a finance step at preparation, not a purchasing field. Under **Manage** on a connection, an administrator who can also read Purchasing opens **Prepare approved invoices**, chooses an approved invoice and codes every line: description, account key, tax key, and the net and tax as printed on the supplier's invoice.

`apps/server/src/accounting/purchase-invoices.ts` checks the coding in the posting transaction, then enqueues the snapshot through the shared outbox:

- The connection revision the reviewer saw is current, the connection has a company and is enabled, and the invoice is `approved` (not a draft or superseded).
- Every live line is coded exactly once. Each net has the currency's places and is within one minor unit of the exact quantity × price; the page suggests the half-up value but never submits a figure the reviewer has not seen.
- Line tax adds up exactly to the header VAT. VAT with more places than the currency allows is refused, as are negative lines and zero-value invoices.
- The supplier and every account/tax key resolve to enabled reviewed mappings. The snapshot stores the destination references as reviewed, so a later mapping change does not alter a prepared posting.
- **Corrections:** if any other version of the same supplier invoice number already has a posting on this connection, the corrected version is refused (`invoice_already_posted`). Record the correction in the accounting system until credit notes and adjustments are supported.

The command is idempotent: the same command returns its receipt, identical coding returns the existing posting, and different coding of a prepared invoice conflicts. The private posting history records the person (`user:<id>`), invoice number, version and review note. Nothing is published to workspace sync. Routes: `GET /v1/workspaces/:slug/accounting/connections/:id/purchase-invoices` (`show=open|all`), `GET …/purchase-invoices/:invoiceId` (lines, suggested nets, mappings, blockers or the existing posting) and `POST …/purchase-invoices/:invoiceId/prepare`. All three refuse personal tokens. Tests: `apps/server/src/accounting-invoice-producer.test.ts`.

Prepared postings stay `queued` until the [dispatcher](#dispatch-and-the-finance-review-queue) sends them through an installed adapter.

## Dispatch and the finance review queue

**Installing an adapter.** `createAccountingAdapterRegistry({ <provider>: factory })` in `apps/server/src/accounting/registry.ts` maps a provider ID to a server-side factory that builds the adapter for one connection (workspace, slug, currency, connection, company), or returns null when it can't, for example because there are no credentials yet. An adapter bound to a different connection or company is ignored. The registry is passed to `createApp` and built in `apps/server/src/index.ts`. **It is empty in this repository:** no live adapter is installed until provider sign-in and credential storage exist, so saving connections and preparing invoices never sends anything.

**The dispatcher** (`accounting/dispatcher.ts`) runs every `ACCOUNTING_DISPATCH_INTERVAL_SECONDS` (default 300; `0` turns it off), and only when the `accounting` module is on and at least one adapter is installed. Each pass sends up to 25 queued postings, oldest first, for enabled connections that have a company and an installed adapter. Every send goes through the outbox, which commits `unknown` before calling the adapter, so overlapping passes or several API processes can't send the same posting twice. A refused destination or capability leaves the posting queued. Unsendable postings still count towards a pass's 25, so many of them can delay newer ones; disable the connection or install its adapter.

Each posting's claim checks whether Accounting is still enabled in the workspace. Turning Accounting off leaves unclaimed work queued. Attempts already claimed can record their outcome.

**The queue** sits under **Manage → Accounting queue** for signed-in administrators (personal tokens are refused). It has four tabs:

- **Queued:** prepared and waiting. **Send now** dispatches one immediately when an adapter is installed.
- **Needs checking** (`unknown`): the send may or may not have reached the ledger. These are never resent. The reviewer finds the transaction in the accounting system and enters its ID. The adapter's `readBack` must return a receipt matching the provider, connection, company, posting reference and exact totals before the posting becomes `posted`. A transaction that can't be found or doesn't match leaves it uncertain (`read_back_not_verified`). There is deliberately no "mark as not posted".
- **Rejected** (`failed`): the adapter reported a definite no-write rejection. **Retry** requeues the current attempt with the same snapshot and posting key and records what was fixed.
- **Posted:** confirmed by read-back, with the accounting transaction ID.

Each posting shows its private history, with people by name and the dispatcher as "Automatic dispatch". Routes: `GET /v1/workspaces/:slug/accounting/connections/:id/postings` (`state`, `offset`; also returns counts and whether an adapter and read-back are available), `GET …/postings/:postingId`, and `POST …/postings/:postingId/send`, `/retry` (`attemptId`, `reason`) and `/read-back` (`attemptId`, `externalId`, `reason`). The `attemptId` must be the current attempt, so a stale screen can't act on a newer outcome.
