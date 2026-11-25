# Accounting integrations

Knotworking is intended as an open source tool that can work with different accounting systems. Each installation chooses whether to connect one. The shared accounting layer is provider-neutral; product-specific APIs, SDKs, credentials and import layouts belong in separate adapters. Sage 50 Accounts is an initial adapter candidate, not a prerequisite or a global accounting choice. Xero, QuickBooks and other systems can implement the same interface.

Knotworking owns operational records, sales orders and issued customer documents. A connected accounting system owns its financial ledger, tax filing, payment processing and financial accounts. This foundation does not implement another general ledger.

## Current delivery

`apps/server/src/accounting/adapter.ts` defines `AccountingAdapter`, bound to a provider, connection UUID and external company. It declares supported document kinds and currencies. The dispatcher refuses a mismatched provider, connection, company or unsupported capability before claiming the job or calling the adapter.

The durable outbox in `apps/server/src/accounting/outbox.ts` and shared schemas in `packages/core/src/accounting.ts` accept prepared purchase invoices, customer invoices and customer credit notes. Supplier, customer, account and tax references are opaque strings: each adapter translates reviewed mappings into its destination's identifiers. Providers use extensible identifiers, so contributors do not need to edit a central enum to introduce an adapter.

Amounts are exact decimal strings validated against the document currency's precision, including zero-decimal and three-decimal currencies. Line totals reconcile exactly; the shared layer never infers a tax rate, mapping, currency conversion or rounding correction. Each adapter advertises the currencies it actually implements, even if the shared schema accepts more.

Optional administrator setup is available at `/<workspace>/settings/accounting` when the `accounting` module is enabled. Administrators can [prepare approved purchase invoices](#preparing-approved-purchase-invoices) and [issued customer documents](#preparing-customer-invoices-and-credit-notes), and connect a [Xero organisation](xero.md) when the server has Xero app credentials. The dispatcher sends these through the installed adapter. The automated suite verifies the HTTP contract with a fake Xero service. Demo Company acceptance is pending.

## Posting lifecycle and isolation

- Each workspace, connection, document kind and source ID has one immutable prepared snapshot. An identical enqueue returns its existing ID; changed source revisions or mappings conflict. A connection's provider and company cannot be rebound after use. A separate explicitly configured connection has its own source and external-ID namespace; sending to several connections will eventually need explicit finance permissions and routing rules.
- The posting UUID is a stable retry reference, distinct from each attempt UUID. A provider-local transaction ID is unique within a connection, so equal IDs from different accounting systems do not collide. Read-back must match provider, connection, company, posting reference, currency and exact totals.
- Claiming commits `unknown` before external IO. A lost reply, crash or invalid acknowledgement remains uncertain and cannot be resent automatically. A definitive no-write rejection is `failed`; an explicit reviewed retry keeps the same snapshot/key and records a new attempt. A `deferred` outcome is a no-write that may succeed later without anyone acting, such as a provider rate limit or a setup waiting to be reconnected: the posting goes back to `queued` with a `deferred` history entry. A timeout, partial write or unsuccessful search is not proof of no write.
- Positive destination read-back reconciles an uncertain posting to `posted`. Repeating the same confirmation is idempotent. Stale callbacks, mismatched destinations and contradictory transaction IDs are rejected. No-post resolution after uncertainty is deliberately deferred until a connector can prove quiescence and authoritative reconciliation.
- Every transition retains actor, attempt and evidence. Private snapshots, receipts and history bypass shared workspace sync deliberately. Raw exceptions are not stored; adapters must sanitise evidence. These functions are trusted server internals: actor labels and connection UUIDs are not authentication.

## Contributing an adapter

1. Pick a stable provider ID such as `sage_50_accounts_uk`, `xero` or a community identifier. Keep credentials, SDK models and provider-specific validation in the implementation. Provider IDs in the schemas do not imply an implemented adapter.
2. Implement `AccountingAdapter` for one configured connection/company. Declare only verified posting kinds and currencies. Translate the canonical purchase invoice through reviewed supplier/account/tax mappings. Refuse unsupported cases visibly; do not guess VAT or silently discard lines.
3. Preserve the stable posting reference and implement authoritative read-back. Return `posted` only with destination transaction evidence. Return `rejected` only when there was definitively no write, or `deferred` when there was no write and sending again later can succeed unchanged (a rate limit, a reconnect). Partial writes and ambiguous failures must remain `unknown`. File generation alone is not proof of an accounting import.
4. Test against a fake transport and run the shared outbox suite. Cover success, definitive rejection, duplicate enqueue, lost replies after a write, stale attempts, wrong company/provider/connection, unsupported currency and conflicting external IDs. Provider acceptance also needs line/account/tax verification, not only totals.
5. Use the provider's supported test facility when implementing its live adapter. Product versions, sandbox accounts and credentials are deployment/adapter concerns; they are not prerequisites for working on the shared tool. Document that adapter's limitations and acceptance evidence separately.

Installed adapters are registered as server-side factories (see [Dispatch and the finance review queue](#dispatch-and-the-finance-review-queue)). Connection metadata and reviewed mappings are stored privately. Live provider compatibility requires separate validation.

## Verification

Run the core `src/accounting.test.ts` and server `src/accounting/outbox.test.ts`, `src/accounting-invoice-producer.test.ts`, `src/accounting-queue.test.ts`, `src/accounting/adapters/xero.test.ts` and `src/accounting-xero.test.ts` suites. The server suites migrate an in-memory Postgres database and use test adapters or a fake Xero HTTP service, so they need no accounting software or credentials. `src/accounting-xero.postgres.test.ts` checks token refresh across two connection pools and runs only with `TEST_POSTGRES_URL` set (see [Xero](xero.md#access-and-automated-verification)).

## Optional setup and mappings

Enable `accounting` in `KNOTWORKING_MODULES` (or choose `all`) and open **Accounting connections** in the user menu as an owner/admin. The tool continues to work with no saved connections. Choose a provider and a friendly name; company identity can be left blank until known. Xero setup uses [authorisation and tenant confirmation](xero.md) after the metadata is saved. OAuth credentials stay in private server tables.

The admin API lives under `/v1/workspaces/:slug/accounting`: list/create connections, read/update `connections/:id`, put reviewed `connections/:id/mappings`, inspect paginated `connections/:id/history`, and search permitted local supplier/customer `references`. The environment module guard and administrator check apply on every call; personal API tokens are refused. Suppliers additionally require Items read access and customers require Customers read access; foreign-workspace records cannot be mapped. Source names are returned only while that source module is readable. Account/tax keys are local semantic names, not a second chart of accounts or tax-rate register.

Updates and mapping reviews require a current revision, reason and command UUID. Repeated commands return their receipt, stale revisions conflict, and mapping correction/withdrawal retains previous values, reviewer and reason in private history. Connections are disabled rather than deleted; disabled connections block both new snapshots and dispatch claims. Earlier uncertain postings can still be positively reconciled after a connection is disabled. The setup UI supports connection/history paging, source searching and mapping review; this first increment caps each connection at 500 mappings and refuses overflow. Backfilled foundation destinations retain no invented human author.

## Preparing approved purchase invoices

Purchasing records one header VAT amount per invoice and unrounded line values (quantity × an 8-place unit price), and its lines carry no account or tax code. Approved invoices are immutable, so this coding is a finance step at preparation, not a purchasing field. A non-stock purchase order line (a service, subscription or goods not kept in stock) may carry a free-text nominal code; the preparation view shows it on each invoice line against that order line (`nominalCode`) and, when it is exactly the local key of an enabled account mapping on the connection, suggests that account (`suggestedAccountKey`, preselected in the form). It is only a suggestion: the reviewer still codes every line, and the posting carries the mapped account as reviewed. Under **Manage** on a connection, an administrator who can also read Purchasing opens **Prepare approved invoices**, chooses an approved invoice and codes every line: description, account key, tax key, and the net and tax as printed on the supplier's invoice.

`apps/server/src/accounting/purchase-invoices.ts` checks the coding in the posting transaction, then enqueues the snapshot through the shared outbox:

- The connection revision the reviewer saw is current, the connection has a company and is enabled, and the invoice is `approved` (not a draft or superseded).
- Every live line is coded exactly once. Each net has the currency's places and is within one minor unit of the exact quantity × price; the page suggests the half-up value but never submits a figure the reviewer has not seen.
- Line tax adds up exactly to the header VAT. VAT with more places than the currency allows is refused, as are negative lines and zero-value invoices.
- The supplier and every account/tax key resolve to enabled reviewed mappings. The snapshot stores the destination references as reviewed, so a later mapping change does not alter a prepared posting.
- **Provider checks:** an installed provider can add requirements in `accounting/provider-rules.ts`. A Xero bill needs a due date on or after the invoice date, a `ContactID` supplier mapping and a two-decimal currency. These show as blockers and are refused with `provider_document_invalid`.
- **Corrections:** if any other version of the same supplier invoice number already has a posting on this connection, the corrected version is refused (`invoice_already_posted`). Record the correction in the accounting system until supplier credits and adjustments can be posted.

The command is idempotent: the same command returns its receipt, identical coding returns the existing posting, and different coding of a prepared invoice conflicts. The private posting history records the person (`user:<id>`), invoice number, version and review note. Nothing is published to workspace sync. Routes: `GET /v1/workspaces/:slug/accounting/connections/:id/purchase-invoices` (`show=open|all`), `GET …/purchase-invoices/:invoiceId` (lines, suggested nets, mappings, blockers or the existing posting) and `POST …/purchase-invoices/:invoiceId/prepare`. All three refuse personal tokens. Tests: `apps/server/src/accounting-invoice-producer.test.ts`.

Prepared postings stay `queued` until the [dispatcher](#dispatch-and-the-finance-review-queue) sends them through an installed adapter.

## Preparing customer invoices and credit notes

Under **Accounting connections → Manage → Prepare customer invoices and credit notes**, an administrator with Invoicing read access can pick an issued customer document. A customer invoice needs a reviewed contact mapping and a revenue account and tax mapping on every line. The issued descriptions and exact line amounts carry through to the posting. The connection revision and any selected mapping keys are checked inside the transaction.

Credit notes use the contact and line coding from the original invoice's verified posting to the same Xero connection. Review the original Xero invoice ID and select whether to allocate the credit to it. The review reason, immutable snapshot and eventual Xero ID are recorded in the shared queue. Repeating the same review with identical coding returns the same posting. Queue details link finance back to the source document and identify the original Xero invoice on credits.

Routes are under `/v1/workspaces/:slug/accounting/connections/:id/customer-documents`: `GET` with `offset`, `GET /:invoiceId` and `POST /:invoiceId/prepare`.

## Dispatch and the finance review queue

**Installing an adapter.** `createAccountingAdapterRegistry({ <provider>: factory })` in `apps/server/src/accounting/registry.ts` maps a provider ID to a server-side factory that builds the adapter for one connection (workspace, slug, currency, connection, company), or returns null when it can't, for example because there are no credentials yet. An adapter bound to a different connection or company is ignored. The registry is passed to `createApp` and built in `apps/server/src/index.ts`. The server registers the Xero factory when Accounting is enabled and Xero app credentials are configured. The factory only resolves a confirmed grant for the matching tenant and workspace currency.

**The dispatcher** (`accounting/dispatcher.ts`) runs every `ACCOUNTING_DISPATCH_INTERVAL_SECONDS` (default 300; `0` turns it off), and only when the `accounting` module is on and at least one adapter is installed. Each pass sends up to 25 queued postings, oldest first, for enabled connections that have a company and an installed adapter. Every send goes through the outbox, which commits `unknown` before calling the adapter, so overlapping passes or several API processes can't send the same posting twice. A refused destination or capability leaves the posting queued. If an adapter can't be built for a connection (for example a misconfigured `APP_URL` for Xero), the pass logs why and skips that connection's postings. When a send is deferred, the rest of that provider company's postings wait for the next pass, so one rate limit doesn't spend the pass on further refused calls. Unsendable postings still count towards a pass's 25, so many of them can delay newer ones; disable the connection or install its adapter.

Each posting's claim checks whether Accounting is still enabled in the workspace. Turning Accounting off leaves unclaimed work queued. Attempts already claimed can record their outcome.

**The queue** sits under **Manage → Accounting queue** for signed-in administrators (personal tokens are refused). It has four tabs:

- **Queued:** prepared and waiting. **Send now** dispatches one immediately when an adapter is installed. A deferred send returns here; its history shows **Not sent yet, back in the queue** with the reason.
- **Needs checking** (`unknown`): the send may or may not have reached the ledger. These are never resent. The reviewer enters the transaction ID or, for Xero, searches for the original document and verifies it. The adapter must return a receipt matching the provider, connection, company, posting reference and exact totals before the posting becomes `posted`. A transaction that can't be found or doesn't match leaves it uncertain (`read_back_not_verified`). There is deliberately no "mark as not posted".
- **Rejected** (`failed`): the adapter reported a definite no-write rejection. **Retry** requeues the current attempt with the same snapshot and posting key and records what was fixed.
- **Posted:** confirmed by read-back, with the accounting transaction ID.

Each posting shows its private history, with people by name and the dispatcher as "Automatic dispatch". Routes: `GET /v1/workspaces/:slug/accounting/connections/:id/postings` (`state`, `offset`; also returns counts and whether an adapter and read-back are available), `GET …/postings/:postingId`, and `POST …/postings/:postingId/send`, `/retry` (`attemptId`, `reason`) and `/read-back` (`attemptId`, `reason`, and `externalId` when reading by ID). The `attemptId` must be the current attempt, so a stale screen can't act on a newer outcome.
