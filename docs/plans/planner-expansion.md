# Planner expansion: closing the gap with Linear and Asana

"The planner" here means the **Tasks** and **Time** modules and the projects inside Tasks: tasks, workflow states, labels, dependencies, comments, projects, project templates, List/Board/Timeline views, My tasks, time tracking. It does not mean production or demand planning, which are separate modules.

The goal is to make the planner feel like Linear for fast issue work and like Asana for structured, multi-team project delivery, without breaking what the rest of Knotworking relies on: the module contract ([modules.md](../modules.md#contract-for-a-new-module)), the sync log, API tokens, MCP, project templates and the BI catalogue.

## 1. Where we are

| Area | Today |
| --- | --- |
| Tasks | Team-scoped; title, rich description, one assignee, priority 0–4, estimate, start and due date, labels, parent/subtasks, manual sort key. No numeric identifiers: migration `0004` removed `ENG-42` on purpose, tasks are addressed by ID. |
| Workflow | Per-team workflow states in five fixed categories (`backlog`, `unstarted`, `started`, `completed`, `canceled`). Started/completed/canceled timestamps follow the category. |
| Dependencies | `task_relations`: "blocks / blocked by" only, cycle-checked, in the bootstrap and the sync log. |
| Projects | Name, description, icon, colour, status, health, lead, start and target date, several teams. Templates (onboarding, client kickoff, and module-aware steps). No milestones, updates, members or custom data. |
| Views | List, Board, and a project Timeline (Gantt with drag rescheduling). A "Display" menu holds ordering only, kept in the URL. My tasks. No saved views, no filters UI beyond team/project/assignee, no grouping choice, no calendar view, no bulk edit. |
| Collaboration | Threaded comments with mentions, attachments, `task_assigned` / `task_status_changed` / `task_commented` notifications. No followers, no activity history on a task. |
| Time | Timers, manual entries, estimate vs logged, time reports (module `time`). |
| Platform hooks | MCP task and project tools, task search, BI `tasks` dataset, task descriptions that link module records. |
| Missing entirely | Custom fields, saved views and filters, cycles/sprints, milestones, project updates, initiatives/roadmap, recurring tasks, automation rules, webhooks, intake forms and triage, multiple assignees/followers, task activity log, duplicate/related relations, bulk edit, workload, goals. |

Two properties of the current design shape every phase below:

1. **Tasks are bootstrapped.** Every live task is in the bootstrap snapshot and the sync log, and the web views filter on the client. That is what makes Linear-style speed possible, and it will not scale to workspaces with years of closed work. Phase 0 deals with that before we add more columns and more entities.
2. **Dates and numbers are deliberate.** Tasks have no `ENG-42` numbers; the team dropped them. Whether to bring back a short human reference is an open question (section 7), not an assumption.

## 2. Feature gap

Priority: **A** = needed to be credible against either tool, **B** = strong differentiator, **C** = later.

| Capability | Linear | Asana | Us | Priority | Phase |
| --- | --- | --- | --- | --- | --- |
| Saved views with filters, grouping, sub-grouping, display properties | yes | yes (saved searches, custom views) | no | A | 1 |
| Filter query shared by UI, API, MCP and automations | yes | yes | no | A | 0/1 |
| Calendar view of tasks | yes | yes | no | A | 1 |
| Bulk select and edit, multi-select keyboard | yes | yes | no | A | 1 |
| Task activity history (who changed what) | yes | yes | no | A | 0 |
| Followers / subscribers | yes | yes (collaborators) | no | A | 1 |
| Sub-task rollup (progress, dates) | yes | yes | no | A | 1 |
| Custom fields (task and project) | limited | yes, core | no | A | 2 |
| Milestones inside a project | yes | yes | no | A | 2 |
| Project updates (status posts with health) | yes | yes (status updates) | health field only | A | 2 |
| Relation types: related, duplicate | yes | yes | blocks only | B | 2 |
| Sections within a project (Asana-style lists) | no | yes | no | B | 2 |
| Cycles / sprints, capacity, rollover, burndown | yes | partial | no | B | 3 |
| Estimates in points or t-shirt sizes | yes | yes (custom field) | minutes only | B | 3 |
| Initiatives / portfolios and a roadmap | yes | yes (portfolios) | no | B | 4 |
| Workload view (assigned vs capacity) | no | yes | no | B | 4 |
| Goals linked to projects | partial | yes | `governance` objectives exist, unlinked | C | 4 |
| Recurring tasks | no | yes | no | A | 5 |
| Automation rules (trigger, condition, action) | yes (workflows) | yes (rules) | no | B | 5 |
| Outgoing webhooks | yes | yes | no | B | 5 |
| Intake forms and triage queue | yes (triage, Asks) | yes (forms) | no | B | 5 |
| Email-in to create a task | yes | yes | no | C | 5 |
| Task, cycle and throughput analytics | yes (Insights) | yes (reporting) | BI `tasks` dataset (counts only) | B | 6 |
| Task and project templates beyond project-from-template | yes | yes | project templates only | C | 5 |
| Real-time co-editing of descriptions | yes | yes | no, by design | skip | none |

Out of scope on purpose: real-time cursor co-editing (see [data-model.md](../data-model.md) on documents), Git-provider integrations and a public app marketplace. Webhooks plus the existing API tokens and MCP cover integrations.

## 3. Principles

- **Keep one task model.** Every new feature hangs off `tasks` and `projects` as additive tables or nullable columns. Nothing forks the task into a second shape.
- **Modular at two levels.**
  - *Module level* (environment and per-member access, the existing mechanism): heavy, separable capabilities become their own modules that depend on `tasks`.
  - *Team level* (new, small): feature switches on the team, the way Linear scopes cycles, triage and estimates per team, so a support team can turn on triage and a platform team can turn on cycles without anyone else seeing the extra UI.
- **Core stays small.** Anything that every task view needs (saved views, custom fields, activity, followers, milestones) is part of `tasks`. Anything a team can reasonably live without (cycles, roadmap, automation, intake) is a module.
- **One filter language.** A single serialisable filter expression in `@knotworking/core`, used by saved views, the list endpoint, MCP, automations, webhooks and BI. No feature grows its own ad hoc filter.
- **Every write goes through the contract.** Transaction, `recordChanges`, route rule in `modules/routes.ts`, classification in `route-classification.test.ts`, token action or `forbidTokens`, MCP tool with a fake, docs. Dates use the workspace time zone helpers.
- **Small reference data in sync, everything else paginated.** Views, cycles, milestones, custom field definitions and initiatives are small and join the bootstrap. Activity, updates, automation runs and webhook deliveries are ledgers and are fetched on demand.

## 4. Module layout

| Module | Id | Depends on | Holds | Default access |
| --- | --- | --- | --- | --- |
| Tasks (extended) | `tasks` | | Existing content plus: activity log, saved views, custom fields, followers, milestones, sections, project updates, extra relation types | unchanged |
| Time | `time` | `tasks` | Unchanged; later also reads cycles for capacity | unchanged |
| Cycles | `cycles` | `tasks` | Cycles per team, capacity, rollover, burndown, point estimates | role default, like Tasks |
| Roadmap | `roadmap` | `tasks` | Initiatives, project ordering on a roadmap, workload view, goal links (enhanced by `governance`) | role default |
| Automation | `automation` | `tasks` | Recurring tasks, rules, webhooks, run history | `manage` to author, `read` to see runs |
| Intake | `intake` | `tasks` | Forms, triage queue, email-in | role default |

Why these boundaries:

- Saved views, custom fields and activity are touched by every task screen, the MCP tools and the BI dataset. Making them optional modules would force `canRead` checks into each of those paths for little gain.
- Cycles, roadmap, automation and intake each add their own pages, tables, tools and token actions, and are used by a subset of teams. They fit the module contract cleanly and can be switched on per environment like Invoicing and CRM.
- Automation and Intake are the only ones that can create data without a person at the keyboard, so they get the strictest token and audit treatment (section 6).

New module ids are appended to `moduleIds` after `tasks`. Soft integrations go in `enhancedBy` (Roadmap and `governance` objectives; Cycles and `time` capacity; Intake and `crm`/`client_services` for creating a customer-linked task).

## 5. Phases

Effort: S ≈ 2–3 days, M ≈ 1 week, L ≈ 2+ weeks, for one engineer including tests and docs. Each phase ships on its own and leaves the product coherent.

### Phase 0: foundations (M–L)

Nothing user-visible beyond history. Everything later depends on it.

Phase 0 includes task activity history, versioned task filters, SQL-backed queries, the recent-task browser snapshot and team planner switches. The window defaults to 30 workspace calendar days, based on when a closed task was last updated. Older work loads on demand. The 50,000-task server fixture verifies that the snapshot excludes older rows and retains full counts. Browser startup latency remains to be measured on a representative deployment.

1. **Task activity log.** `task_events` holds the workspace, task, actor, event details, source and timestamp. Events are written in the same transaction as the corresponding sync changes and fetched per task. The Activity section and MCP tool provide the first read surfaces. Integrating system events into the comment stream and recording automated changes are follow-up work.
2. **Shared filter expression** (`packages/core/src/task-filter.ts`). A small, versioned, zod-validated JSON shape: `{ and | or: [...] , field, op, value }` over system fields (state, state type, assignee, creator, team, project, label, priority, due/start/created/updated/completed dates, parent, has-subtasks, blocked) and, from Phase 2, custom fields. Two evaluators from one definition: a pure function over bootstrapped rows for the client, and a SQL builder for the server. A conformance test runs the same fixtures through both so they cannot drift.
3. **Server-side task query.** Extend `GET /tasks` to accept a filter expression, sort, group and a cursor. The existing `taskListQuerySchema` keeps working.
4. **Bootstrap windowing.** The browser opts into the recent-task snapshot. The `closedWindow` metadata supplies exact server counts for projects and settings. Older task views, historical title search and direct detail reads use scoped endpoints. Full-replica clients retain the complete default bootstrap.
5. **Team feature switches.** Team administrators set `cycles`, `triage` and `estimates` in team settings. The switches default off and sync with the team. Later phases will read them when their capabilities ship.
6. **Module registry.** Add the new module ids to the manifest with empty implementations only when their phase starts, not now.

Exit criteria: a workspace seeded with 50k closed tasks opens in the same time as today's demo; a view filtered by an expression returns identical rows from the client and server evaluators.

### Phase 1: views and everyday ergonomics (L)

The filter bar supports status, assignee, priority, label and due date. The URL stores the validated expression, and loading older closed tasks uses the same filter. Saved views persist list, board and calendar layouts, filters, sorting and grouping with personal, team and workspace scopes. Bulk actions update priority, state, assignee, project and labels, move teams, or delete tasks as one transaction. The calendar shows month and week views and reschedules dates by dragging. Task followers receive status and comment notifications. Task actions include duplication and moves between team workflows. Sub-grouping, visible columns, the pinned My Tasks view and subtask rollups remain.

1. **Saved views.** `task_views` (name, icon, owner, scope `personal` | `team` | `workspace`, team, filter expression, group-by, sub-group-by, ordering, visible properties, layout `list` | `board` | `calendar` | `timeline`). Small, so in the bootstrap and sync log. Appear in the sidebar under their team and under Views. The URL stays the source of truth for an unsaved view; "Save view" snapshots it. Editing a shared view needs `write` plus ownership or `manage`.
2. **Filter bar and display menu.** A chip-based filter builder driven by the Phase 0 expression, plus grouping (state, assignee, project, priority, label, due week), sub-grouping and column choice in the Display menu. Replaces the single `ordering` parameter.
3. **Calendar view.** Month and week by due date (and start→due spans), drag to reschedule through the existing optimistic `updateTask`. Reuses the Timeline's date snapping.
4. **Bulk actions.** Multi-select with shift/cmd-click and keyboard (`x` to select, then state, assignee, priority, project, label, move team, delete). One `POST /tasks/bulk` with a list of ids and a patch, capped (for example 200), applied in one transaction with one sync batch and one activity event per task. Partial failure is all-or-nothing.
5. **Followers.** `task_followers`; creators, assignees and commenters follow automatically, anyone can follow or unfollow. Notifications for status changes and comments go to followers, replacing the hardcoded "assignee and creator" rule. Keeps single assignee as a deliberate choice.
6. **Subtask rollup.** Computed from children: progress, earliest start and latest due date, shown on parents and in the Gantt. No new column; derived in `lib/model.ts` and in the SQL evaluator so server and client agree.
7. **Triage-free quick wins.** Duplicate task, copy link, move between teams (re-maps state by category), "My tasks" built as a pinned saved view so the same filter engine serves it.

### Phase 2: structure and data (L)

Projects now have dated milestones, milestone assignment and filtering, progress totals, and timeline diamonds. The Client kickoff template creates its anchor milestone. Projects also have ordered sections with task assignment and list or board grouping. Custom fields, project updates, memberships, additional relations, and the rest of the template expansion remain.

1. **Custom fields.**
   - `custom_field_definitions` (workspace, scope `task` | `project`, optional team or project restriction, name, type, options, required, sort order) and `custom_field_values` (target kind and id, field id, typed value columns: text, number as `numeric`, date, option id(s), user id, boolean). Types: text, number, date, single select, multi select, person, checkbox, URL. Definitions and values for tasks are small enough for the bootstrap with the Phase 0 windowing; revisit if values grow past a threshold.
   - Fields appear in the filter language, group-by, saved views, Gantt colouring, CSV export and the MCP task tools.
   - Not formulas or rollups in this phase.
2. **Milestones.** `project_milestones` (project, name, target date, sort order, completed at); tasks get a nullable `milestone_id`. Shown as diamonds on the project Timeline, progress per milestone, and a filter field. Project templates can declare milestones (data-only change in `project-templates.ts`).
3. **Sections.** Optional ordered `project_sections` for Asana-style lists ("Design", "Build"), with a `section_id` on tasks and a project-level grouping on the board. Independent of workflow state.
4. **Project updates.** `project_updates` (project, author, health, rich body, created at): a status post that also sets the project's health and a "last updated" marker. Fetched per project, comment-capable, notifying project followers and the lead. Weekly nudge when a project is `active` and has no update for N days, through the existing notification sweep.
5. **Project members and followers.** `project_members` with lead/contributor, used for visibility defaults and notifications; no per-project permissions yet (permissions stay at module level).
6. **More relation types.** Extend `task_relations` with `kind` (`blocks`, `related`, `duplicate_of`). `blocks` keeps its cycle check and the Gantt arrows; `duplicate_of` can close the duplicate with a canceled state. Migration backfills existing rows as `blocks`.
7. **Project templates v2.** Templates can carry milestones, sections and custom field defaults. The existing `planProjectTemplate` stays the single planner so the preview and the server cannot disagree.

### Phase 3: cycles module (M–L)

Module `cycles`, depends on `tasks`, switched on per team through the Phase 0 team feature.

1. `cycles` (team, number, name, start and end date, state derived from dates, auto-created from a team's cadence setting) and a nullable `cycle_id` on tasks. At most one active cycle per team (partial unique index).
2. **Planning.** A cycle page with backlog on the left and the cycle on the right, drag to commit; capacity from the sum of estimates against a team velocity set by an average of the last N cycles.
3. **Rollover.** At cycle end, a scheduled sweep (same mechanism as the notification sweep) moves unfinished tasks to the next cycle and records an activity event. Idempotent and safe to retry.
4. **Estimates.** A per-team estimate scale: minutes (today), points (Fibonacci, linear, t-shirt). Stored as `estimate_points` beside `estimate_minutes`; the time module keeps comparing minutes only.
5. **Burndown and velocity.** Computed from `task_events` and completion timestamps, served by a paginated report endpoint; charts reuse the BI chart components rather than adding a chart library.

### Phase 4: roadmap module (M–L)

Module `roadmap`, depends on `tasks`, enhanced by `governance`.

1. **Initiatives.** `initiatives` (name, description, owner, status, health, target date) with a join to projects, and nested initiatives one level deep. Own page with progress rolled up from projects and their tasks.
2. **Roadmap view.** A Gantt of projects grouped by initiative or team, reusing `gantt-chart.tsx` with project rows instead of task rows, with milestone diamonds from Phase 2.
3. **Workload view.** Assigned estimate minutes (or points) per person per week against a working-hours setting, read-only to start with. Pulls attendance absences when `workforce` is on (soft dependency).
4. **Goals.** Link an initiative or project to a `governance` objective, shown both ways; nothing else from governance is duplicated.

### Phase 5: automation and intake modules (L)

These create data without someone at the keyboard, so they come after the audit log and the filter language exist.

**`automation` module**

1. **Recurring tasks.** `task_recurrences` (template task fields, RRULE-style schedule limited to daily/weekly/monthly with interval and weekday set, time zone from the workspace, "create when" `on schedule` | `when previous is completed`, next run). A scheduler tick creates tasks idempotently using a deterministic command id per occurrence, so a restart or a second process cannot create duplicates. Check how checklists and maintenance compute their next due dates and reuse that logic where it fits.
2. **Rules.** `automation_rules` (team or workspace scope, trigger, filter expression, actions, enabled, creator). Triggers: task created, state changed, assignee changed, label added, due date passed, moved into cycle. Actions: set state, assign, add label, set field, create subtask, comment, notify, call webhook. Rules run from the same transaction path that writes the activity event, with a **loop guard** (events caused by an automation do not re-trigger rules, plus a per-task depth and per-minute cap) and a dry-run mode. Every run writes a `automation_runs` row with the event, the result and any error.
3. **Webhooks.** `webhooks` (URL, signing secret stored hashed or via the existing secret mechanism, event types, filter) and `webhook_deliveries` with attempts, status and next retry. HMAC-signed payloads, SSRF protection on the target URL (no private ranges unless the self-hoster allows it), exponential backoff, disable after repeated failure. Admin-only (`forbidTokens`).

**`intake` module**

1. **Forms.** `intake_forms` (target team and project, default state, fields mapped to task fields and custom fields, public or members-only, enabled). Public forms are unauthenticated, rate-limited and spam-protected; they create tasks with `source: "form"` and no creator.
2. **Triage.** A per-team queue of tasks in a `triage` state category (a sixth workflow state category, `triage`, which is a migration and an enum change touching `lifecycleFor`, the BI dataset and the Board, so it is its own task). Accept, decline, mark duplicate or snooze.
3. **Email-in.** Optional, only when SMTP inbound is configured; address per team or form. Treated as untrusted content and run through the same sanitiser as comments.

### Phase 6: reporting (S–M)

Extend the BI `tasks` dataset rather than building a separate reports area: dimensions for team, project, cycle, milestone, initiative and custom fields; measures for throughput, cycle time, lead time, open age and overdue. Ship packs ("Delivery health", "Team throughput") through `bi/templates.ts`. The existing time reports stay in the Time module.

## 6. Cross-cutting requirements

- **Permissions.** Module `read`/`write`/`manage` stays the model. New `manage` actions: saved views at workspace scope, custom field definitions, initiatives, automation rules, webhooks, intake forms. No per-project ACLs in this plan; that is a separate decision (section 7).
- **API tokens and MCP.** Reads and ordinary writes are token-ok. Managing custom field definitions, rules, webhooks and forms use `personOrToken` with entries in `tokenActions` that default to off, or `forbidTokens` for webhook secrets. New MCP tools stay coarse, as the contract asks: `list_views` / `run_view`, `bulk_update_tasks`, `list_cycles`, `get_cycle`, `list_milestones`, `post_project_update`, `list_initiatives`, with the rest as resources.
- **Sync.** Bootstrapped: views, custom field definitions, milestones, sections, cycles, initiatives, followers (for open tasks only). Fetched: activity, updates, automation runs, webhook deliveries, intake submissions. Each new entity is added to `syncEntities` of its module and redacted for modules the member cannot read.
- **Notifications.** New types (`task_followed_changed`, `project_update_posted`, `cycle_started`, `cycle_ending`, `triage_item_added`, `automation_failed`), each with a module and a preference row, using the existing notification definitions.
- **Search.** Include custom field text values and milestone, cycle and initiative names, filtered by `canRead` of the owning module.
- **Time zones.** Cycle boundaries, recurrences, "due week" grouping and overdue rules use the workspace zone helpers, not the browser's.
- **Accessibility and keyboard.** Every new view works from the keyboard, as the existing Gantt does, and appears on `/design`.
- **Docs.** Each phase adds its section to `modules.md` and `data-model.md` and its tools to `mcp.md`.
- **Migrations.** Per the contract, edit schemas only on feature branches and generate one migration when each phase merges to the integration branch.

## 7. Accepted decisions

1. Optional per-team references such as `ENG-42` are available for new tasks. UUIDs remain canonical API identifiers.
2. Keep one assignee per task and add followers.
3. Defer project-level permissions. Revisit private teams if a customer needs them.
4. Model triage as a workflow category when Intake ships. Update lifecycle handling, BI, boards and imports in that phase.
5. Start with a configurable 30-day bootstrap window for closed tasks. Verify the default with workspace sizes and the scale harness before rollout.
6. Cap the goal hierarchy at initiatives and one-way links to governance objectives.
7. Prioritize recurrence and intake ahead of Cycles for operations and client-service teams.

## 8. Sequencing and risks

Start with Phase 0. Phases 1 and 2 can proceed in parallel on separate branches. Follow with recurrence and intake (Phase 5), Cycles (Phase 3), Roadmap (Phase 4) and Reporting (Phase 6).

Phases 1 and 2 collide in one place, the filter builder, which needs custom fields. Ship the filter builder in Phase 1 for system fields and extend it in Phase 2 by adding field types to the Phase 0 expression, which is why the expression is versioned and defined once.

| Risk | Mitigation |
| --- | --- |
| Bootstrap windowing breaks views that assume every task is loaded | Phase 0 audit list, a `closedWindow` flag in the store, tests that run the views against a windowed store, and a load test with a large seeded workspace using the existing `apps/server/sim` scale harness. |
| Client and server filter evaluators drift | One definition, shared fixture tests, run in CI for both. |
| Automation loops and runaway rules | Loop guard, caps, dry run, per-rule disable on repeated failure, run history visible to admins. |
| Webhooks as an SSRF and exfiltration path | Block private ranges by default, signed payloads, admin only, deliveries logged with response status only (no response bodies). |
| Public intake forms attract spam | Rate limit, honeypot and optional captcha hook, review-before-create option, `source: form` on the task. |
| Custom fields bloating the sync payload | Definitions only in the bootstrap, values windowed with the tasks they belong to, a size threshold that moves values to the query endpoint. |
| Scope creep toward a full Asana clone | Each phase has exit criteria and a "not in this phase" list; decision 6 sets the ceiling. |
| Migration ordering on parallel branches | Follow the contract: schema edits only on branches, one generated migration per phase at integration. |

Working budget for parallel work follows the machine's limits: no more than three agents at a time and `vitest --maxWorkers=2`.

## 9. Test plan

- **Core:** filter expression grammar, both evaluators against shared fixtures, rollup maths, recurrence next-run calculation across DST changes and month ends, cycle rollover, estimate scale conversion.
- **Server:** one test file per service in the style of `task-relations.test.ts` and `projects.test.ts`; module activation, forbidden and token cases through `modules.test.ts` and `route-classification.test.ts`; idempotence of the recurrence tick and of rollover; webhook retry and signature; bulk update atomicity; activity events written in the same transaction as the change.
- **Web:** component tests for the filter bar, saved view round trip (URL ↔ saved view), calendar drag, bulk select, and `sidebar-nav.test.ts` coverage for new links.
- **MCP:** a fake per module and tests beside the tools, per the contract.
- **Scale:** extend the simulation harness with a large-workspace scenario before Phase 0 merges.
- **Manual and browser checks** on the demo workspace per phase, since the team already runs browser-check passes before merging.
