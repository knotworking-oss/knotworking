# Plan: modular industries

Goal: make Knotworking fit food businesses beyond manufacturing (foodservice, distribution, retail) and
generic businesses (services, trades, retail, discrete manufacturing), while staying fully modular:
a workspace switches on only the modules it needs, and no module drags in another industry's concepts.

## Principles

- **Hard vs soft dependencies.** `dependsOn` is for modules a module cannot work without. Integrations
  that only add value when another module is on go in `enhancedBy`: code checks `isModuleActive` /
  `canRead` at runtime and degrades gracefully (hides fields, omits links, reports a `basis`).
- **Generic core, industry extensions.** Shared master data (items, assets, checklists) carries no
  food-only concepts in its required shape. Food concepts live in food modules that extend it.
- **Follow the module contract** in [modules.md](../modules.md#contract-for-a-new-module) for every
  new or changed module: manifest, schema, zod, services, routes + rule + classification, leaks, MCP,
  web + sidebar, dates, docs.
- **One migration per step**, generated with `pnpm db:generate` on that step's branch. Steps run one
  at a time, so migration numbers never collide.
- **Data-preserving migrations.** Existing workspaces keep their data and behaviour; extractions copy
  or re-point rows, never drop them.

## Branching

- Integration branch `feat/modular-industries`, cut from `main`.
- Each step on `feat/mi-<NN>-<slug>`, cut from the integration tip, committed, verified
  (`pnpm typecheck`, relevant tests, full `pnpm test` on schema steps), then merged `--no-ff` into the
  integration branch before the next step starts.

## Steps

### Foundation

1. **Soft dependencies.** Add `enhancedBy` to `ModuleDefinition` (validated like `dependsOn`, shown in
   docs and settings). Loosen: `haccp` no longer needs `production`; `production` no longer needs
   `demand`; `quality` no longer needs `items`/`stock`. Code paths that assumed them check at runtime.
2. **Non-stock purchasing.** `purchasing` no longer needs `stock` (or `items` for free-text lines):
   order lines for services/subscriptions/non-stock goods, receipts that post no movement, invoice
   matching still works.
3. **Assets module.** New `assets` module (areas, equipment, vehicles, IT, tools) extracted from
   `haccp_assets`. `haccp` and `site` depend on (or are enhanced by) `assets`; `site` no longer needs
   `haccp`. Data migrated from `haccp_assets`.
4. **Maintenance module.** Planned maintenance tasks, records and work orders move out of `site` into
   `maintenance` (depends on `assets`). `site` keeps the food prerequisite programmes.
   Existing Maintenance API paths remain aliases and check access to Maintenance.
5. **Checklists module.** The checklist builder (`site_checklist_*`) becomes `checklists`: templates,
   scheduled/recurring checks, results, failures raising actions. `site` pre-start/changeover checks
   use it.
6. **Generic items.** New item types (raw material, component, consumable, spare part, merchandise,
   service) and unit dimensions (length, area, time). Food attributes (allergens, may-contain,
   storage, shelf life) are exposed only when the new `food_items` module is on; food modules
   (`recipes` allergen roll-up, `labels`, `specifications`, `haccp`, `npd`) depend on or are enhanced
   by it. `recipes` presents as "Bills of materials" when `food_items` is off.
7. **Management system.** `governance` generalised: wording no longer food-only (food safety culture
   becomes an optional focus), and standards packs for ISO 9001, 14001, 45001 and 27001 beside BRCGS.
8. **Label jurisdictions.** `labels` rules become per-jurisdiction packs: UK PPDS (existing), EU FIC,
   US FDA Nutrition Facts.
9. **Composable presets.** Replace the two exclusive presets with bundles (base + add-on packs):
   Core, Professional services, Trades & field service, Retail, Distribution, General manufacturing,
   Food manufacturing, Foodservice, Food distribution, plus standards packs. Setup and module settings
   let you combine them; dependencies resolve automatically.

### New generic modules

10. **Invoicing** (`invoicing`): sales invoices and credit notes, numbering, tax lines, PDF/print,
    draft from client-services sign-off and from sales/despatch when active, accounting outbox.
11. **CRM** (`crm`, depends on `customers`): leads, opportunities, pipeline stages, activities.
12. **Expenses** (`expenses`): claims, receipts (attachments), mileage, approval, accounting outbox.
13. **Service desk** (`service_desk`): tickets from customers or staff, SLAs, queues.
14. **Field service** (`field_service`, depends on `customers`): jobs at customer sites, scheduling,
    on-site sign-off, enhanced by `assets`, `checklists`, `time`, `invoicing`.
15. **Contracts** (`contracts`): customer and supplier contract register with renewal/expiry alerts.
16. **Bookings** (`bookings`): book rooms, equipment and vehicles (enhanced by `assets`).
17. **Risk register** (`risk`): enterprise risks, scoring, owners, controls, reviews.
18. **Recruitment** (`recruitment`, depends on `people`): openings, candidates, stages, hire into People.
19. **Routings** (`routings`, depends on `recipes`, `production`): work centres and operations for
    discrete manufacturing.

### Food beyond manufacturing

20. **Foodservice food safety** (`food_diary`): opening/closing checks, probe logs, daily sign-off for
    kitchens; depends on `checklists`, enhanced by `assets`, `haccp`.
21. **Menus and allergen matrix** (`menus`, depends on `recipes`, `food_items`): dishes, menus,
    allergen matrix for front of house.
22. **Waste** (`waste`, depends on `items`): waste logging by reason with cost, enhanced by `stock`.
23. **EPOS sales import** (`pos_import`, depends on `items`): import till sales to deplete stock and
    report gross profit per dish/product.
24. **Simple stock mode**: stock for items without lot tracking (retail), counts and variances.

### Out of scope here

- Multi-site / outlets as a platform concept: needs its own design (affects every module's scoping).
