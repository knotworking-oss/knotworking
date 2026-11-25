# Knotworking

Tasks, projects, meetings and a team wiki in one workspace for any kind of team: assign work, group it into projects, and see what's due, with the speed of a keyboard-first app and the calm of a writing tool.

Use Knotworking in a browser or through the [Tauri desktop app](#desktop-app). The desktop app loads the web interface from your server.

|                   |                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tasks**         | Teams with custom workflows, priorities, labels, estimates, subtasks; list and board views                                                                                                                          |
| **Projects**      | Cross-team projects with status, health, lead, dates and live progress                                                                                                                                              |
| **Calendar**      | Team meetings with two-way Google Calendar and Outlook / Microsoft 365 sync, RSVPs, video links and linked notes                                                                                                    |
| **Docs**          | Nested wiki pages with block-based rich content                                                                                                                                                                     |
| **Manufacturing** | Opt-in modules: items and suppliers, recipes, SOPs, stock, demand, production, HACCP, quality, purchasing and invoices, costing, site programmes, and labels and nutrition (see [docs/modules.md](docs/modules.md)) |
| **Workforce**     | Opt-in modules: the staff register, training matrix and sign-off, and attendance with a tablet kiosk, payroll export and roll calls                                                                                 |
| **Business operations** | Projects from onboarding and client kickoff templates, internal purchase approvals, and fixed-fee or hourly service quotes with delivery projects and draft billing exports |
| **UI**            | [shadcn/ui](https://ui.shadcn.com) (Radix + Tailwind) with ⌘K search (titles and doc and task text), dark mode — browse it at `/design`                                                                             |

## Quick start

Requires Node 22.12 or later and pnpm 10 (`corepack enable`).

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:setup        # create the schema and seed a demo workspace
pnpm dev             # API on :4000, web on :3000
```

Open http://localhost:3000 and sign in as **ada@knotworking.dev** with password **knotworking-demo** (the seeded workspace owner; the other demo users share the password). The demo is a small company, Acme Inc, with Marketing, Operations and Sales teams, projects like a product launch and a team offsite, and this week's meetings. Due dates are set relative to the day you seed it. The design system is at http://localhost:3000/design.

### Self-hosting

Run Knotworking on a local server or cloud VM with Docker Compose. Use a fresh database for real deployments. The quick-start demo accounts are for local development only.

```bash
cp deploy/env.example deploy/.env   # set APP_URL, BETTER_AUTH_SECRET, and POSTGRES_PASSWORD
docker compose --env-file deploy/.env up -d --build
```

Follow the [HTTPS setup](docs/self-hosting.md#4-https-on-a-public-server) before exposing Knotworking to the internet. The [self-hosting guide](docs/self-hosting.md) also covers invites, updates, and backups.

### Accounts and access

Sign-in is handled by [Better Auth](https://www.better-auth.com), running inside the API. It's self-hosted and free, with accounts stored in your own database. Access is managed:

- Knotworking is **invite-only**. Admins invite people by email with a role (owner, admin, member or guest), and only invited addresses can create an account.
- **Deactivating** someone signs them out everywhere and blocks sign-in.
- Admins can create **password-reset links**. Email (SMTP) is optional: without it, admins share links from the Members page by copying them or showing a **QR code**.
- People sign in with **email and password**. **Google, Microsoft and GitHub** sign-in can be added, and still only work for invited addresses.

### Database: free at every stage

Knotworking runs on PostgreSQL, and none of these options cost anything for a test project or small team:

- **Local (default):** nothing to install. The API uses an embedded [PGlite](https://pglite.dev) database (real Postgres compiled to WASM) stored in `.data/`.
- **Shared/hosted:** create a free [Neon](https://neon.tech) (recommended) or [Supabase](https://supabase.com) project, paste its connection string into `DATABASE_URL`, and run `pnpm db:migrate`. Hosted databases start empty; don't seed them. The first-run setup screen creates your owner.
- **Docker:** `docker compose -f compose.dev.yaml up -d` gives you a local Postgres server.

See [docs/database.md](docs/database.md) for step-by-step setup.

> PGlite allows one process at a time. Stop `pnpm dev` before running `db:*` scripts.

## Desktop app

The Tauri desktop app is available to build from source. It connects to a running Knotworking server, either from the [local quick start](#quick-start) or a [self-hosted installation](docs/self-hosting.md). This is a source-only release.

1. Install Node.js 22.12 or later, pnpm 10, stable Rust, and the [Tauri prerequisites for your OS](https://tauri.app/start/prerequisites/).
2. Clone the repository if you need a checkout. From its root, install the workspace dependencies and build the desktop package.

   ```bash
   git clone https://github.com/knotworking-oss/knotworking.git
   cd knotworking
   pnpm install --frozen-lockfile
   pnpm --filter @knotworking/desktop desktop:build
   ```

3. Install or run the [package for your OS](docs/desktop.md#build-and-install) from `apps/desktop/src-tauri/target/release/bundle/`. Launch Knotworking, enter the web address of your server, and sign in. For the local quick start, enter `http://localhost:3000`.

Run `pnpm desktop` from the repository root to open the development build. The [desktop guide](docs/desktop.md#running-it) covers platform setup, build options, and known limitations.

## Repository layout

```
apps/
  web/          Next.js 16 web app (App Router, React 19, Tailwind CSS 4)
  server/       Hono HTTP API — the single backend for every client
  desktop/      Tauri desktop client for a running Knotworking server
  mcp/          MCP server: lets AI agents read and write tasks, projects, docs and comments via the API
packages/
  core/         Domain model shared by every client: enums, zod schemas, IDs, ordering, sync protocol
  db/           Drizzle schema, SQL migrations, client factory (Postgres / PGlite), seed data
  api-client/   End-to-end typed API client (inferred from the server's routes, no codegen)
  ui/           shadcn/ui components + theme (globals.css) + Knotworking components (status, priority, labels)
docs/           Architecture, data model and design system guides
```

## Scripts

| Command                                    | What it does                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                 | Run API, web app and MCP server (:4100) in watch mode                                                            |
| `pnpm build`                               | Production build of every package and app                                                                        |
| `pnpm typecheck`                           | Type-check everything                                                                                            |
| `pnpm test`                                | Run unit and API integration tests (in-memory Postgres)                                                          |
| `pnpm format`                              | Format with Prettier (sorts Tailwind classes)                                                                    |
| `pnpm db:generate`                         | Generate a SQL migration after editing `packages/db/src/schema/<module>.ts` (or `schema.ts` for platform tables) |
| `pnpm db:migrate` / `db:seed` / `db:setup` | Apply migrations / seed demo data / both                                                                         |
| `pnpm db:reset`                            | Drop the local database and set it up again                                                                      |
| `pnpm ui:add <component>`                  | Add a shadcn/ui component to `packages/ui`                                                                       |
| `pnpm desktop`                             | Run the desktop app (needs Rust; see `docs/desktop.md`)                                                          |

## Documentation

- [Architecture](docs/architecture.md) — how the pieces fit, and the sync protocol
- [Workforce delivery](docs/workforce.md) — leave/absence, rotas and agency workers, competence-based staffing checks and privacy boundaries
- [Xero adapter](docs/xero.md) — purchase-invoice HTTP implementation, tests and live-acceptance limits
- [Accounting integrations](docs/accounting.md) — shared posting foundation, optional provider adapters and contribution guide
- [Modules](docs/modules.md) — switching modules on per environment, per-member access, and the contract for new modules
- [Data model](docs/data-model.md) — entities and the conventions that make them sync-friendly
- [Self-hosting](docs/self-hosting.md) — Docker Compose on a local server or cloud VM, HTTPS, backups, managing access
- [Desktop app](docs/desktop.md) — the Tauri app: running it, how it connects to a server
- [MCP server](docs/mcp.md) — let AI agents (Claude Code, Claude Desktop) use Knotworking through scoped API tokens
- [Assistant](docs/assistant.md) — the ⌘J AI sidebar, using each person's own API key (Claude, OpenAI, Gemini and more) with their permissions
- [Business intelligence](docs/modules.md#dashboards-bi) — dashboards, board packs and verified analyses
- [Calendar sync](docs/calendar.md): connecting Google and Microsoft, what syncs, and provider setup
- [Database](docs/database.md) — free hosting options (Neon, Supabase) and connection setup
- [Design system](docs/design-system.md) — shadcn/ui setup, theme, Knotworking components and how to add more

## Status

Built so far: the data model, API, sync log, design system, read views and task editing. Task editing covers optimistic create, edit and delete, property menus in list rows, board cards and the task sidebar, and drag-and-drop between states and within manual or priority ordering.

Keyboard: `⌘K` opens the command menu (it also searches the text of docs and tasks), `C` creates a task and `?` lists every shortcut. In a list or board, `J`/`K` (or the arrow keys) move focus between tasks, `←`/`→` hop between board columns, `Enter` opens the focused task, `S`, `P`, `A` and `L` open its status, priority, assignee and label menus, `X` marks it done (or reopens it) and `Esc` clears focus. The same four keys work on a task page. In an open property menu, number keys pick an option. To move a task in a list or board, focus it, press `Space`, use the arrow keys, then press `Space` again. Shortcuts stay out of the way while you type in a field, while a menu or dialog is open, and during a drag.

## Contributing and licensing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

Knotworking is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
