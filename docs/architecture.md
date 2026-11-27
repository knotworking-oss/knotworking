# Architecture

## Goals

1. **One backend for every client.** The web app is the first client, not a special one. Desktop and mobile apps will use the same API, validation rules and sync protocol.
2. **Offline-capable by design.** The data model and API already support clients that create records offline and catch up incrementally.
3. **Shared code where it is portable.** Domain logic, validation and the API client live in packages with no DOM or Node dependencies.

## Overview

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Web app    │  │ Desktop app  │  │  Mobile app  │
│  (Next.js)   │  │   (Tauri)    │  │    (Expo)    │   ← future
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │   @knotworking/api-client (typed)    │
       └────────────────┬──────────────────┘
                        ▼
              ┌──────────────────┐
              │   API (Hono)     │  validation: @knotworking/core
              │  apps/server     │
              └────────┬─────────┘
                       ▼
              ┌──────────────────┐
              │ Postgres (Drizzle)│  entity rows + sync_changes log
              │ PGlite / Neon     │  see docs/database.md
              └──────────────────┘
```

### Packages and what they may depend on

| Package                   | Runs on               | Depends on                                       |
| ------------------------- | --------------------- | ------------------------------------------------ |
| `@knotworking/core`       | anywhere              | zod, uuidv7, fractional-indexing                 |
| `@knotworking/api-client` | anywhere with `fetch` | hono/client (types from `@knotworking/server`)   |
| `@knotworking/db`         | server                | core, drizzle, postgres / pglite                 |
| `@knotworking/server`     | server                | core, db, hono                                   |
| `@knotworking/ui`         | web (React DOM)       | core, shadcn/ui (Radix, Tailwind)                |
| `apps/web`                | web                   | ui, api-client, core                             |
| `apps/mcp`                | server                | api-client, core, MCP SDK (see [mcp.md](mcp.md)) |
| `apps/desktop`            | desktop (Tauri, Rust) | none yet; loads the web app from a server        |

Keep `core` and `api-client` free of DOM and Node APIs — they are what desktop and mobile apps will share. Workspace packages ship TypeScript source; the server bundles them with tsup and Next.js transpiles them.

## The web app

Next.js App Router with React Server Components. Pages fetch from the API on the server (`apps/web/src/lib/api.ts`) using the typed client. The web app never imports `@knotworking/db`, which keeps it honest as just another client.

Reads use the **bootstrap** payload, a normalised snapshot of the workspace, and join it on the client side (`lib/model.ts`).

**Live data** comes from `WorkspaceProvider` (`lib/workspace-store.tsx`), which the workspace layout mounts with the server-rendered bootstrap. It holds the client sync store (see [Client sync store](#client-sync-store)): the snapshot is its seed, `/sync` keeps it current and `/events` tells it when to pull, so other people's edits show up without a reload. Task views (`TasksView`, the project Timeline, the task page's title, properties, subtasks, dependencies and Time section) read `tasks` and `idx` from it (`idx.loggedMinutes` totals finished time per task), and its mutations (`updateTask`, `createTask`, `deleteTask`, `createTaskRelation`, `deleteTaskRelation`, `logTime`, `updateTimeEntry`, `deleteTimeEntry`, `startTimer`, `stopTimer`, and `createProject`, `updateProject`, `deleteProject` for the Projects page, and `attachDocument` for a doc's team and project) are optimistic and roll back with a toast on failure. Features beyond tasks can use `sync` from `useWorkspace()` to read any entity's rows or run their own optimistic writes.

Server-rendered parts that read the bootstrap directly (the sidebar's counts, the command menu, a task's description) are still a snapshot from the last render.

**Ordering and drag-and-drop.** Views order tasks by priority (the default), manual order, creation date or last update, chosen in the Display menu (`?order=`). Dropping a task (dnd-kit, `components/task-dnd.tsx`) can change its state (the target column) and its `sortOrder`, a fractional key between its new neighbours (`sortKeyForMove`), so only the moved task is written. Under priority ordering, the task takes the priority of the slot it was dropped into. The API rejects malformed sort keys.

## The API

Hono app in `apps/server/src/app.ts`, versioned under `/v1`:

| Route                                                                                                   | Purpose                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me`                                                                                            | Current user and their workspaces                                                                                             |
| `GET/POST /v1/me/api-tokens`, `DELETE /v1/me/api-tokens/:id`                                            | Personal API tokens for agents (sign-in session only; per-user, not in sync log)                                              |
| `/v1/me/assistant/*`, `/…/assistant/*`                                                                  | The AI sidebar: each member's provider API keys and settings, personal chats ([assistant.md](assistant.md))                   |
| `/api/auth/*`                                                                                           | Better Auth: sign in/out, sessions, OAuth callbacks, password reset                                                           |
| `/v1/public/*`                                                                                          | Login config, first-run setup, invitation acceptance (no session)                                                             |
| `/v1/workspaces/:slug/members`, `/invitations`                                                          | Member and invitation management (admins)                                                                                     |
| `GET /v1/workspaces/:slug/bootstrap`                                                                    | Full snapshot + sync cursor (heavy fields excluded)                                                                           |
| `GET /v1/workspaces/:slug/sync?after=`                                                                  | Ordered changes since a cursor                                                                                                |
| `GET /v1/workspaces/:slug/events`                                                                       | Server push (SSE): "the sync log advanced", with the cursor                                                                   |
| `GET/POST /…/tasks`, `GET/PATCH/DELETE /…/tasks/:id`                                                    | Tasks, addressed by ID (no per-team numbers, as in Asana)                                                                     |
| `POST /…/task-relations`, `DELETE /…/task-relations/:id`                                                | Task dependencies (blocks / blocked by); bootstrapped, see below                                                              |
| `GET/POST /…/tasks/:id/comments`, `PATCH/DELETE /…/comments/:id`                                        | Task comments, fetched per task (not bootstrapped)                                                                            |
| `GET/POST /…/tasks/:id/time-entries`, `PATCH/DELETE /…/time-entries/:id`                                | Time logged on a task, with per-task totals (see [Time tracking](#time-tracking))                                             |
| `POST /…/tasks/:id/timer`, `POST /…/timer/stop`, `GET /…/projects/:id/time`                             | The caller's timer; a project's logged and estimated time per task and person                                                 |
| `GET /…/time-report`, `GET /…/time-report.csv`                                                          | Time reports: logged vs estimated per project, person, task or day; one-row-per-entry CSV (see [Time reports](#time-reports)) |
| `POST /…/attachments`, `GET/DELETE /…/attachments/:id`, `GET /…/attachments/:id/content`                | Images and files (multipart upload, metadata, bytes); see [Attachments](#attachments)                                         |
| `GET /…/tasks/:id/attachments`                                                                          | A task's files, fetched per task (not bootstrapped)                                                                           |
| `GET /…/notifications`, `POST /…/notifications/read-all`                                                | The signed-in user's inbox (per-user, not in the sync log)                                                                    |
| `POST/PATCH /…/teams`, `/teams/:id/members`, `/teams/:id/states`, `/states/:id`, `/labels`              | Teams (archive/restore), members, workflow states and labels (owners and admins)                                              |
| `GET/POST /…/projects`, `PATCH/DELETE /…/projects/:id`                                                  | Projects with progress; edits replace the linked teams                                                                        |
| `GET/POST /…/documents`, `GET/PATCH/DELETE /…/documents/:id`                                            | Docs tree (PATCH takes an optional `expectedUpdatedAt`, see below)                                                            |
| `GET /…/documents/:id/revisions`, `GET …/revisions/:revisionId`, `POST …/revisions/:revisionId/restore` | Document version history (see [below](#document-version-history))                                                             |
| `GET /…/search?q=&scope=&limit=`                                                                        | Full-text search over docs and tasks, with snippets (see [Search](#search))                                                   |
| `GET /…/documents/:id/backlinks`, `GET /…/tasks/:id/backlinks`                                          | What mentions a doc or task (see [Mentions and backlinks](#mentions-and-backlinks))                                           |

Routes are chained so their types flow into `AppType`. `@knotworking/api-client` turns that into a fully typed client with no code generation:

```ts
const api = createApiClient("http://127.0.0.1:4000");
const task = await unwrap(
  api.v1.workspaces[":slug"].tasks.$post({ param: { slug: "acme" }, json: { teamId, title: "Fix login" } }),
);
task.title; // "Fix login" (typed)
```

Errors use a single shape: `{ error: { code, message, details? } }`.

### Document edits and `expectedUpdatedAt`

`PATCH /…/documents/:id` accepts an optional `expectedUpdatedAt`: an ISO datetime, exactly the `updatedAt` the client last read from `GET /documents/:id` (or from the previous PATCH response). The server compares it with the stored `updatedAt` as instants (millisecond precision) inside the UPDATE's `WHERE`, so it is checked under the row lock in the same transaction as the write. On a mismatch it responds `409 { error: { code: "document_conflict", message } }` and writes nothing: no row change and no `sync_changes` entry. Of two concurrent writers holding the same value exactly one wins. A missing or deleted document is still `404`.

The 409 body also carries the stored document, so a client can show or merge it without another request: `{ error: { code: "document_conflict", message, details: { current: { id, title, content, updatedAt, … } } } }` (`ApiError.details` in `@knotworking/api-client`).

When the field is absent the update is unconditional (last write wins on the whole title and body; this is what a client that doesn't send it, or MCP `update_document` with `content` and no `expected_updated_at`, gets). The web editor and the MCP server's `append` send it. `expectedUpdatedAt` is a precondition only and is never persisted. Every document update advances `updatedAt` by at least one millisecond, so two writes in the same millisecond still invalidate each other's precondition.

**There is no merging and no real-time co-editing** (no Yjs/CRDT): two people typing in the same page are not shown each other's cursor or changes. The guarantee is that a save never silently replaces content the saver hasn't seen. Document content is not in the bootstrap or the sync log's client view, so an open editor is not updated when someone else saves; it finds out when its own next save is refused.

**Web editor** (`components/document-editor.tsx`, `lib/doc-save.ts`). The page passes the loaded `updatedAt`; `createDocSaver` sends it with every autosave PATCH and adopts each response's `updatedAt` as the next precondition, so one editor's rapid autosaves (the `useAutosave` queue sends one request at a time) chain without conflicts. On a 409 the saver compares the stored title and body with the version the edit was based on, for the fields being written: if only something else changed (the page was moved, or retitled while you edit the body) it rebases and retries silently; if the title or body you are saving was changed it throws `DocumentConflictError`, writes nothing and `useAutosave` pauses (status `conflict`, no retry loop, no toast) while keeping the unsaved changes. The page then shows "This page was changed by someone else" with two actions: **Reload their version** (drops the unsaved text, loads the stored version, saving resumes on top of it) and **Keep my version as a copy** (creates a sibling page "<title> (my version)" with the text on screen, then loads theirs; if the copy fails the conflict stays open and nothing is lost). Unsaved text is only lost by choosing Reload, or by navigating away or closing the tab while the notice is showing (the browser asks before closing).

**Task descriptions** (`PATCH /tasks/:id`) have no such precondition yet: they are last-write-wins, and their editor is likewise not updated by other people's saves.

### Document version history

Every document keeps a history of its title and body in `document_revisions` (a snapshot per row: `title`, `content`, `authorId`, `kind`, `createdAt`, `updatedAt`). `createDocument`, `updateDocument` (the service behind `PATCH`, and so behind MCP `update_document`, whose author is the token's user) and restore write the snapshot **in the same transaction** as the document row and its `recordChanges` entry.

- **Not in the sync log.** Revisions hold whole document bodies, so, like comments' fetch-on-demand reads (but unlike comment writes), they are neither bootstrapped nor written to `sync_changes`; clients fetch them when someone opens History. The document write itself is logged as always, so a restore reaches sync clients as an ordinary `document` upsert.
- **Throttle.** Autosave must not create a revision per keystroke. If the document's latest revision is an `edit` by the same author that was started less than `REVISION_THROTTLE_MINUTES` (10) ago, the save updates it in place (`updatedAt` moves, `createdAt` stays); otherwise it adds one. So there is at most one `edit` revision per document, author and 10-minute window, and an edit by someone else (or after a restore) always starts a new one. The window is measured by the database clock in the same statement, not by the app server's.
- **What counts as a change.** Only a changed title or body is captured. A save that sends the same title and body (compared as JSON, ignoring key order), a move, an icon or an attachment change leaves the history alone. Creating a document records its first revision. A document from before version history existed has no revisions: its first captured edit also stores the previous version as the baseline, so it is not lost.
- **Retention.** The newest `MAX_REVISIONS_PER_DOCUMENT` (100) revisions are kept per document; inserting one prunes the older ones in the same transaction (updating in place never prunes). Deleting a document is a soft delete, so its revisions stay in the table but are unreadable; a hard delete cascades.
- **Reading.** `GET …/revisions` lists `{ id, documentId, title, authorId, kind, createdAt, updatedAt }` newest first, with no bodies; `GET …/revisions/:revisionId` returns the full snapshot (`content` included). Any member, guests included, can read the history of a document they can read. A deleted document, a document or revision of another workspace, or a revision that belongs to a different document is `404`. `authorId` is `null` once the account is gone. Both are token-ok (read-scope tokens allowed).
- **Restore.** `POST …/revisions/:revisionId/restore` (writers only, body `{ expectedUpdatedAt? }`) runs in one transaction: it snapshots the current state as a `before-restore` revision (so a restore can be undone by restoring that one), then applies the revision's title and body as a normal document update (`lastEditedById` is the restorer, a sync-log upsert is recorded, and the optional `expectedUpdatedAt` precondition applies exactly as for `PATCH`) and records the result as a `restore` revision, never folded into an earlier one. A precondition failure is `409 document_conflict` and rolls everything back, snapshot included. The response is the updated document, like `PATCH`. Parent, icon, team and project are not part of a revision and stay as they are. It is classified token-ok: a write token can already `PATCH` any content, restore is narrower and reversible, and read-scope tokens are refused as for every write.
- **Kinds:** `edit` (a save or the creation), `restore`, `before-restore`.

**Web** (`components/doc-history.tsx`, rendered by `DocumentEditor`). A **History** button next to the title opens a side sheet: versions listed newest first (relative time, author, "Restored version" / "Before a restore" labels), a read-only preview of the selected one (`DocRenderer`) and, for writers, **Restore this version** behind a confirmation dialog. The list is fetched when the sheet opens. A restore first lets the editor save what it has pending and wait for it, then sends the editor's own last-saved `updatedAt` as `expectedUpdatedAt`: if someone else changed the page, nothing is restored and a toast says so (the editor's own conflict notice still handles that case on its next save). On success the editor loads the restored title and body **the same way "Reload their version" does** (`reload` in `document-editor.tsx`): the saver adopts the restore response's `updatedAt` as its base, pending edits are dropped, and the editor remounts with the restored text. Without that rebase the next autosave would carry the pre-restore `updatedAt`, be refused with 409 and show the "changed by someone else" banner for the user's own action. A diff or compare view is not implemented.

### Docs on teams and projects

A document may be attached to one team (`teamId`) and one project (`projectId`), independently; both are optional and nothing about the doc tree (`parentId`) depends on them. `POST /…/documents` and `PATCH /…/documents/:id` accept both fields (the same `documentCreateSchema` / `documentUpdateSchema` in `@knotworking/core`):

- **Validation.** In the write's transaction, `assertRefs` requires the team or project to exist, be live (a deleted project or archived team is refused) and belong to the same workspace, otherwise `400 Unknown teamId` / `Unknown projectId`. Malformed values are a `400` from the schema.
- **Clearing.** `null` detaches; leaving a field out keeps it. Each side is independent, so detaching the project keeps the team.
- **Sync log.** Every attach or detach is an ordinary document upsert (with the new `teamId` / `projectId` in `data`) recorded by `recordChanges` in the same transaction.
- **Deleting a project** soft-deletes it and, in the same transaction, clears `projectId` on its live docs and logs an upsert for each, next to the project's own delete. The docs stay (like its tasks, which are detached too).
- **Archiving a team** hides the team but keeps its docs and their `teamId`: docs are workspace wiki pages, not team-scoped records like tasks, so they are not hidden or deleted and no document changes are logged. Clients treat a link to a team they do not have as no attachment (`resolveAttachment` in `lib/doc-attachments.ts`), so the Docs section and the chip disappear while it is archived and the link is back once the team is restored. Nothing hard-deletes a team, so the `ON DELETE SET NULL` on `documents.team_id` is only a backstop.

In the web app, the team page and the project page end with a **Docs** section (`DocsSection`) listing the attached docs from the live store, with a "New doc here" button (`NewDocButton` with a `scope`) that creates a doc already attached and opens it. The doc page shows the attachment as two small chips (`DocAttachment`): each links to the team or project, and a picker (attach, change, detach through `attachDocument` in the workspace store, which is optimistic and rolls back on failure) is offered to writers only. Guests see the chips and the list, never the buttons. The sidebar no longer lists docs as a tree: it shows the viewer's five most recently opened docs (see Sidebar).

### Search

`GET /v1/workspaces/:slug/search?q=&scope=all|documents|tasks&limit=` searches document and task titles and bodies with Postgres full-text search (no stored index, no migration; see [database.md](database.md#search)). It is read-only, so API tokens may use it, and it has the same visibility as the lists it searches: every member, guests included, sees live documents and tasks of that workspace only. Soft-deleted documents and tasks, tasks of archived teams and other workspaces never appear (a workspace you don't belong to is `404`).

- **Query:** `q` is trimmed, 1 to 200 characters (`searchQuerySchema` in `@knotworking/core`); `limit` is 1 to 50 per kind (default 10). All words must match, in any order, each as a prefix, case-insensitively; the whole query is also matched as a substring. Operators, quotes and punctuation are plain text, never search syntax.
- **Response:** `{ query, documents: [...], tasks: [...] }` ranked best first (title matches above body matches, newest first on ties). Each hit has `id`, `title`, `titleMatches` (ranges to highlight in the title), `snippet` (a window of the body around the first match with whitespace collapsed and `…` at cut ends; the start of the body if only the title matched), `snippetMatches` (ranges in `snippet`) and `updatedAt`, plus the ids the UI needs to link and label it (`parentId`, `teamId`, `projectId`, `stateId`). Ranges are `[start, end)` offsets, so clients render highlights without parsing HTML. The text helpers (`searchTerms`, `makeSnippet`, `findMatches`, `splitByRanges`) live in `@knotworking/core`.
- **Clients:** `searchWorkspace(api, slug, q, { scope, limit, signal })` in `@knotworking/api-client`; the MCP `search_documents` tool ([mcp.md](mcp.md)).
- **Web:** the ⌘K menu keeps filtering titles locally and instantly. From two characters on, after a 200 ms pause (earlier requests are aborted, late answers dropped), it asks the server and lists hits whose body matched under **Content matches**, with the snippet and the match highlighted (`lib/content-search.ts`). A failed or slow search leaves the local results as they are, and guests get the same results.

### Mentions and backlinks

Documents and task descriptions can mention people, tasks and pages with an inline **`mention`** node: `{ type: "mention", attrs: { kind: "user" | "task" | "doc", id, label } }` (`MentionAttrs` in `@knotworking/core`). `docContentSchema` validates it (`kind` in the enum, `id` a UUID, `label` a string up to 512 characters, no children, at most 500 per body), so every write path (API, MCP, editor) rejects malformed ones. `id` is what counts; **`label` is only a cache** of the name or title when it was written, so readers that can look the target up do (the web chip reads the live store) and show a muted "Unavailable task/page/person" chip when it is gone (deleted, archived team, left the workspace). Comments use a plain textarea today, so they carry no mentions.

- **Plain text.** `docToPlainText` flattens a mention to `@Ada`, `[[Doc title]]` or `#Task title` (from the cached label), so MCP reads, notifications and search snippets stay readable. `extractMentions` and `addedMentions` (core) list the distinct mentions of a body and what a save added.
- **Web.** Typing `@` opens a picker (`doc-editor/mention.ts`, `mention-menu.tsx`, a second `@tiptap/suggestion` plugin next to the slash menu) listing people, tasks and pages from the live client store: nothing is requested, and `filterMentionItems` (`lib/mentions.ts`) ranks starts-with above word-start above contains, five per kind. Query words end at a space. The chip (`MentionChip`) is shared by the editor's node view and `DocRenderer`; tasks and pages link to `/<workspace>/task/<id>` and `/<workspace>/docs/<id>`, people are only a chip. `isEditableContent` accepts mentions; content with a node the editor doesn't know still falls back to read-only.
- **Backlinks, with no schema change.** `GET /v1/workspaces/:slug/documents/:id/backlinks` and `…/tasks/:id/backlinks` return `{ documents: [{ id, title, icon, updatedAt }], tasks: [{ id, title, teamId, stateId, updatedAt }] }`: the live documents and tasks whose body mentions the target (`services/backlinks.ts`). There is no link table: the query runs a `jsonb_path_exists` for a `mention` node with that kind and id over the workspace's 2,000 most recently updated live documents (and tasks of non-archived teams), the same bounded window search uses, so it behaves the same on PGlite and hosted Postgres. Kind and id are bound parameters of the jsonpath, never text in it. Results are newest first, at most 50 per kind; deleted rows, archived teams, other workspaces and the row itself never appear, and a deleted or foreign target is `404`. Read-only, so API tokens and guests may use them. The doc page shows the result as **Linked from** and the task page as **Mentioned in** (server-rendered, so it is fresh per visit). If a workspace outgrows the scan, a `document_links` table written in the same transaction as the content (and logged to no one: it is derived data) is the next step; the route's shape would not change.
- **Notifications.** Saving a body that adds a mention of a person creates a `mentioned` notification (see [notifications](notifications.md)).

### Personal API tokens

Tokens (`knw_…`, sign-in session required to manage them) are per-user and stay out of the sync log. Beyond scope and expiry (default 90 days):

- A user may hold at most 25 active (not revoked, not expired) tokens; creating another is `400 too_many_tokens`.
- Creating a token also deletes that user's tokens that were revoked or expired more than 30 days ago.
- All of a user's live tokens are revoked when their password is reset (`emailAndPassword.onPasswordReset`) or changed (`/change-password`, via an `account.update` database hook on the credential account), because a leaked credential may be what prompted it.
- Requests made with a token are rate limited by the API itself (`apiTokenRateLimit` in `middleware/rate-limit.ts`, run right after `requireSession`): 600 reads (GET/HEAD/OPTIONS) and 120 writes per token per minute by default, in separate budgets (`API_TOKEN_READ_LIMIT_PER_MINUTE`, `API_TOKEN_WRITE_LIMIT_PER_MINUTE`, `0` = off). Over budget the answer is `429 rate_limited` with `Retry-After`. Counters are keyed by the token's database id (never the plaintext), the table is size-capped, and sessions are never limited. The state is per API process: a restart resets it and N replicas allow N times the budget (so it brakes runaway agents; it is not an exact distributed quota). The MCP server's own per-token limit applies in front of it, per MCP process. A `/events` stream counts once, when it connects.
- Access is a deny-list (`forbidTokens`, `requireAdmin`, `requireSessionCredential`). `apps/server/src/route-classification.test.ts` enumerates every route under `/v1` and `/api` and fails until a new route is classified as `token-ok`, `token-forbidden` or `public`; forbidden ones are exercised with a write token to prove they are refused. Personal and admin routes must be guarded with `forbidTokens`.

### Workspace slugs

A workspace slug is the first URL segment (`/acme/tasks`), so it must not shadow top-level routes. `RESERVED_WORKSPACE_SLUGS` in `@knotworking/core` (`api`, `mcp`, `v1`, `login`, `setup`, `invite`, `design`, `health`, `_next`, …) lists them; first-run setup's slugify appends `-workspace` to a reserved result (`API` becomes `api-workspace`). Setup is the only place a slug is generated. Workspaces that already existed with a now-reserved slug are renamed by migration `0007_reserved_workspace_slugs`: the slug becomes `<slug>-workspace` (or `-workspace-2`, `-3`, … when taken; soft-deleted workspaces count as taken and are renamed too), and each renamed live workspace gets a `workspace` upsert in the sync log so connected clients see the new slug. The migration carries the reserved list inline (a frozen copy); `packages/db/src/reserved-workspace-slugs-migration.test.ts` fails if it drifts from `RESERVED_WORKSPACE_SLUGS`, so a later change to the list needs its own migration. Old links to the previous slug stop working. Add new top-level web routes, and paths the proxy sends elsewhere (`deploy/Caddyfile`), to that list.

### Comments

Comments are **fetched per task, not included in the bootstrap snapshot**. They are numerous, unbounded and only read on one screen, so bootstrapping them would grow every client's first load for little benefit (the same reasoning that keeps task descriptions and document content out of it). The task page loads `GET /tasks/:id/comments` (oldest first) next to the task.

Comment writes still go through a transaction that calls `recordChanges` (`comment` upserts and tombstones), so sync clients that follow `/sync` can keep a local comment cache current. A client that wants to cache comments offline should apply those changes and fetch a task's comments when it opens the task.

- `body` uses the shared block format (`DocContent`), the same as task descriptions and documents. The composer writes plain paragraphs (`textToDoc`) today; the rich editor can replace it with no API or schema change. Blank bodies and bodies over 20,000 characters of text are rejected (counted on `docToPlainText`, so a table counts its cell text plus one `" | "` per cell boundary and one newline per row). Tables (`table > tableRow > tableHeader | tableCell`) are validated structurally by `docContentSchema` (rows and cells only, at most 200 rows and 50 columns, positive integer spans, nesting at most 24 deep), and `mention` nodes by their attributes (see [Mentions and backlinks](#mentions-and-backlinks)); other node types stay open-ended.
- **Permissions:** guests are read-only. Only the author can edit a comment. Authors can delete their own comments, and owners and admins can delete any. A comment whose author's account is gone has `authorId: null` and can only be deleted by an admin.
- Replies (`parentId`) are accepted by the API, must point at a live comment on the same task, and are deleted with their parent. The task page shows a flat thread for now.
- Comments on a deleted task are not served.

### Task queries

`GET /v1/workspaces/:slug/tasks` returns compact task summaries with `nextCursor` (`null` at the end). It accepts the existing `teamId`, `projectId`, `assigneeId` and `stateType` parameters. They combine with the optional URL-encoded JSON `filter`, for example:

```json
{
  "version": 1,
  "expression": {
    "and": [
      { "field": "assigneeId", "op": "eq", "value": null },
      { "field": "dueDate", "op": "lte", "value": "2026-12-31" }
    ]
  }
}
```

- Conditions accept `eq` and `ne` on `teamId`, `stateId`, `stateType`, `assigneeId`, `creatorId`, `projectId`, `parentId`, `labelId`, `priority`, `hasSubtasks` and `blocked`. Label comparisons test membership. A task is blocked when a live task on a visible team blocks it and that blocker is still open.
- Date conditions also accept `lt`, `lte`, `gt` and `gte`. Use `YYYY-MM-DD` for `startDate` and `dueDate`, and ISO datetimes with a timezone for `createdAt`, `updatedAt` and `completedAt`. Nullable fields accept `null` with `eq` and `ne`. Range comparisons exclude unset values.
- An expression can nest `and` and `or` groups up to five levels, with 16 children per group and 64 nodes total. The filter parameter is limited to 8,192 characters before URL encoding.
- `sort` accepts `manual`, `priority`, `created` and `updated`. Omitting it uses the legacy ordering by manual key then newest creation time. Every sort has an ID tie-breaker.
- `group` accepts `teamId`, `projectId`, `assigneeId`, `stateId`, `stateType` and `priority`. Groups order by key with unset values first. The page's `groups` array contains `{ key, taskIds }` entries for the returned tasks. A group can span pages.
- `title` optionally narrows the query by case-insensitive substring. `includeRelations=true` returns the visible dependencies touching at least one task on the page.
- `limit` is 1–500, default 250. Continue with `cursor=nextCursor` and the same query parameters apart from the page size. A cursor marks a position in the ordering. Edits between requests can move tasks across that position.

SQL filters and paginates before task summaries are returned. The browser uses the shared filter evaluator on the workspace snapshot. MCP exposes the paginated API through `query_tasks`.

### Recent-task bootstrap

The browser requests `GET /bootstrap?taskWindow=recent`. It gets every open task and closed tasks updated since the start of the workspace day 30 calendar days ago by default. Owners and admins can change `closedTaskWindowDays` in General settings. Closed tasks include completed and canceled tasks. This uses last update so that an older closed task returns to the working set when someone edits it.

The `closedWindow` object contains the cutoff and full-workspace task, label and project aggregates. Task label links, dependencies and completed time entries are limited to the loaded tasks. Running timers stay in the snapshot. Task pages fetch their parent, children, dependencies and time entries directly. The browser loads older tasks in pages on request and searches older titles from the command menu and task picker.

Omitting `taskWindow` returns the complete replica for API clients, including MCP. Both modes use the same sync cursor and stream. The browser can accept a reopened task immediately and fetch its unchanged links and time history. The window applies at snapshot time and its cutoff is recalculated on the next bootstrap.

### Task dates and dependencies

Tasks have an optional `startDate` next to `dueDate` (both `YYYY-MM-DD`), groundwork for a timeline/Gantt view. A start date after the due date is refused with `400 invalid_input`: the shared schema checks both when they are sent together, and the server checks a PATCH of one against the stored other.

Dependencies are `task_relation` rows: `{ id, blockingTaskId, blockedTaskId }` reads "blocking blocks blocked" (and the blocked task is "blocked by" the other). They are small and every list shows them, so unlike comments they **are in the bootstrap** (`taskRelations`) and in the sync log.

- `POST /…/task-relations` (`{ id?, blockingTaskId, blockedTaskId }`) creates one; `DELETE /…/task-relations/:id` removes it (a hard delete and a tombstone, like `task_label`, so the pair can be linked again). Writers only; API tokens with `write` scope may use both.
- Refused: a task blocking itself (`400`), an existing pair (`409 relation_exists`), and anything that would close a cycle, including the reverse of an existing pair (`409 relation_cycle`). The cycle check walks the graph under the workspace's advisory lock, so two concurrent requests can't each add half of a cycle. Both tasks must be live and in a live team (`404` otherwise).
- Deleting a task deletes its relations (tombstones in the same transaction). Archiving a team keeps the rows but sends tombstones for the relations of its tasks, and restoring re-sends those whose other task is visible, the same way the team's tasks are hidden and re-sent. The bootstrap only lists relations whose two tasks are visible. Hidden relations still count for the cycle check, so a restore can't reveal a cycle.
- A task is shown as **blocked** while at least one blocking task is open (not completed or canceled). `WorkspaceIndex` exposes `blockedBy`, `blocking` and `openBlockers`; `wouldCreateBlockingCycle` (`@knotworking/core`) lets clients hide choices the server would refuse.

**Timeline (Gantt) view.** A project page has List, Board and Timeline views (`?view=timeline`). `ProjectTimeline` (`components/project-timeline.tsx`) reads the project's tasks and the relations between them from the workspace store and hands them to `GanttChart` (`components/gantt-chart.tsx`), which is presentational so `/design` can show it with sample data. All date and layout math is in `lib/timeline.ts` (pure, unit-tested): dates become UTC day numbers so nothing shifts with time zones or DST, and days are inclusive.

- **Rows:** subtasks under their parent, siblings by the day they start (a parent without dates by its first subtask), then manual order. Tasks with neither date are listed under the chart as **Unscheduled**, with start and due date pickers. A task with one date is a single-day diamond.
- **Drawing:** bars are coloured by state category (`bg-status-*`), open tasks past their due date get a red end, the assignee's avatar sits after the bar. The project's start-to-target range is shaded with labelled markers, and a line marks today. Zoom is day, week or month (pixels per day); the task column and header are sticky and the chart scrolls to today.
- **Dependencies:** an SVG arrow from the end of each blocking bar to the start of the blocked one, for relations whose tasks are both drawn (relations to tasks in other projects are not shown). A blocked task that starts on or before the day its blocker ends is a **violation** (dashed red arrow, and the bar's label says so). Nothing is rescheduled automatically.
- **Rescheduling:** drag a bar to move it, or an edge to change the start or due date, snapped to days; dragging the free edge of a diamond adds the missing date. From the keyboard, arrows move a focused bar, Shift+arrows change the due date and Alt+Shift+arrows the start date, saved on key release (Escape cancels). An edge can't be dragged past the other, so a start never ends up after the due date. Saving is `updateTask` with only the changed dates, so it is optimistic, syncs and rolls back on failure. Guests can open tasks from the chart but not move them.

### Time tracking

`time_entries` (`services/time-entries.ts`, `routes/time.ts`) record time on a task in whole minutes. Tasks have an optional **time** estimate, `estimateMinutes`, set through the normal task PATCH (there is no point/sizing estimate). Durations, limits and parsing (`formatMinutes`, `parseDuration`, `timerMinutes`) live in `@knotworking/core` (`time.ts`) so every client rounds the same way.

- **Entries** have `minutes` (1–1440), `entryDate` (the day in the user's calendar; the server defaults to today in the workspace's time zone, the web app sends the local date) and an optional `note` (up to 500 characters).
- **Timers:** `POST /tasks/:id/timer` inserts a row with `minutes: null` and `startedAt`. Each user has at most one running timer per workspace: starting another first stops the running one in the same transaction (under the workspace's sync-log lock, so concurrent starts queue), and a partial unique index backs the rule up. `POST /timer/stop` stops the caller's timer (`404` when none runs), rounding to the nearest minute, at least 1 and at most 24 hours (a forgotten timer is capped; edit it afterwards). A running entry's note and day can be edited but not its duration.
- **Permissions:** guests are read-only. Members log, edit and delete their own time; owners and admins can also log time for another member (`userId`) and edit or delete anyone's entries. Timers are always the caller's own. All routes accept API tokens (workspace data; the role checks are in the service, as for comments).
- **Totals:** `GET /tasks/:id/time-entries` returns the entries (newest day first) and `totals` (`loggedMinutes`, `estimateMinutes`, per-user minutes). `GET /projects/:id/time` returns a project's `loggedMinutes`, the sum of its tasks' `estimateMinutes`, and the split per task and per person. Only finished entries count, entries on deleted tasks don't, and a subtask counts towards its own project, not its parent's. These are the building blocks for reports.
- **Sync:** every write records `time_entry` upserts and tombstones; the bootstrap includes `timeEntries` (live entries on live tasks, including running timers), so clients total time locally and see other people's time and timers live. Unlike comments they are bootstrapped, because task rows show logged time. If workspaces accumulate very many entries this is the first collection to move to a windowed or per-task fetch.

### Attachments

Images in documents and task descriptions, document covers, and files on tasks. The bytes live in a `Storage` (`apps/server/src/storage/`): `LocalStorage` on disk (`UPLOAD_DIR`, by default `<repo>/.data/uploads` in development and the `uploads` volume in compose) or `S3Storage` for any S3-compatible bucket (`UPLOAD_STORAGE=s3`, plain `fetch` with SigV4 signing, so no SDK and no extra runtime externals). The metadata is the `attachments` table: workspace, uploader, sanitized filename, sanitized content type, size, storage key, an optional task or document, and `deletedAt`.

- **Upload:** `POST /…/attachments` takes `multipart/form-data` with one `file` part and optional `taskId`, `documentId` and `id` fields (`attachmentUploadFieldsSchema`). The body is streamed (busboy) straight into storage and cut off at `UPLOAD_MAX_BYTES` (default 10 MB, `413 file_too_large`); a declared `Content-Length` that can't fit is refused before reading. The storage key is `<workspaceId>/<fresh uuid>`, never derived from the filename, and storage implementations refuse any other shape. If anything fails after the bytes are stored (bad ids, an `id` conflict), the object is deleted. The row and its `attachment` upsert in the sync log are written in one transaction (`recordChanges`); the payload leaves out the storage key.
- **Content types:** the stored type is `sanitizeContentType` (`@knotworking/core`): PNG, JPEG, GIF or WebP only when the file's magic bytes prove it (`sniffImageType`), otherwise a short list of safe download types, otherwise `application/octet-stream`. SVG, HTML, XML and JavaScript never keep their type.
- **Serving:** `GET /…/attachments/:id/content` passes the same `requireSession` + `workspaceAccess` as every workspace route (other workspaces get 404). Verified raster images are served inline with their type; everything else is `application/octet-stream` with `Content-Disposition: attachment`. Every response has `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; …; sandbox`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: private, no-cache` with an `ETag`, so browsers revalidate (and re-run the access checks) instead of keeping a copy that outlives someone's access. `?download=1` forces a download. Files of a deleted task or document are not served.
- **Permissions:** guests and read tokens can list and download; uploads need a writer (`requireWriter`) and, for tokens, `write` scope. The uploader or an owner/admin can delete. Deleting soft-deletes the row (an `attachment` tombstone in the sync log) and then removes the bytes.
- **References:** an image block is `{ type: "image", attrs: { attachmentId, filename, alt } }` (`DocImageAttrs`), and `documents.coverUrl` holds `attachment:<id>` (`attachmentRef`), which the API only accepts for a live inline image in the same workspace. Neither is ever a remote URL. Clients build the content URL with `attachmentContentPath` (the web app adds its `/api` prefix and the browser sends the session cookie). `docToPlainText` renders images as `[image: filename]`, which is what MCP reads show.
- **Through the proxies:** the web app's `/api/*` route streams request bodies to the API (`duplex: "half"`) instead of buffering them; Caddy has no body limit of its own.

Attachments are not part of the bootstrap: the task page loads `GET /tasks/:id/attachments`, and images load their bytes on demand. Bytes of attachments whose task or document was deleted, and of images removed from a document's text, stay in storage until the attachment itself is deleted.

### Time reports

`GET /…/time-report?from=&to=&projectId=&teamId=&userId=&groupBy=project|person|task|day` (`routes/reports.ts`, `services/time-report.ts`) aggregates finished time entries; `GET /…/time-report.csv` takes the same query and exports one row per entry. No schema change: it reads `time_entries` joined to `tasks`, `projects`, `teams` and `users`. The query is validated by `timeReportQuerySchema` in `@knotworking/core` (`from` and `to` required, real `YYYY-MM-DD` dates, `from <= to`, at most 366 days inclusive; the CSV ignores `groupBy`).

- **What counts:** entries with `minutes` set (a running timer counts once stopped), not deleted, with `entryDate` from `from` to `to` inclusive (the day the work happened, so there is no time-zone arithmetic), on a task that is not deleted. A task without a project reports as "No project", time whose user account is gone as "Former member". Filters combine with AND; an id that matches nothing gives an empty report, not an error. A task counts towards its _current_ project and team.
- **Response:** `{ from, to, groupBy, groups, totals }`. A group is `{ key, name, loggedMinutes, entryCount, taskCount, estimateMinutes, loggedOnEstimatedMinutes }` (`key` is the project, user or task id, or the date for `day`, or null for "No project" and "Former member"); `totals` has the same sums over everything. Biggest first, except `day`, which is oldest first.
- **Estimates:** `tasks.estimateMinutes` is one figure for a task's whole life, so the report holds the time logged _in the range_ against the estimate of the tasks that have time in the range. `project` and `task` groups carry `estimateMinutes` (null when no task in the group has an estimate) and `loggedOnEstimatedMinutes` (time on the estimated tasks only), so time on unestimated tasks never looks like an overrun: over or under is `loggedOnEstimatedMinutes - estimateMinutes` (`estimateVariance` in core). `person` and `day` groups have `estimateMinutes: null`, because a task's estimate can't be split between the people or days that worked on it. `totals.estimateMinutes` counts each task once. A range that covers only part of a task's work will look "under"; widen it for a fair comparison.
- **Permissions:** every workspace member (owner, admin, member and guest) and every API token of one can read the report for everyone, with read scope sufficing. This is deliberately the visibility time entries already have: `GET /tasks/:id/time-entries`, `GET /projects/:id/time` (per-person totals) and the bootstrap (`timeEntries`, with person and note) already hand every member all entries, so a report only aggregates what they can read; limiting it to own entries would add inconsistency, not privacy. If time ever becomes private per person, change the entries routes and the bootstrap first and this follows. Reports show names, never email addresses (guests don't get them). The routes are read-only and classified `token-ok`.
- **CSV:** header `Date, Person, Project, Team, Task, Minutes, Hours, Note`; rows oldest day first; `Hours` is decimal ("1.50"). RFC 4180 quoting with CRLF line endings, and every text cell goes through `csvCell` (`@knotworking/core`), which also neutralises spreadsheet formula injection: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return (after optional spaces) gets a leading `'`, so a note like `=HYPERLINK(...)` opens as text. Numbers are written bare. Response headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="time-report-<slug>-<from>-to-<to>.csv"`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. An export over 50,000 entries is refused with `400` (narrow the range).
- **Web:** `/<workspace>/time` (sidebar "Time", visible to everyone). The page is a server component that reads the filters from the URL (`parseReportFilters` in `lib/time-report.ts`: `preset=this-week|last-week|this-month|custom`, `from`, `to`, `project`, `team`, `person`, `groupBy`; weeks run Monday to Sunday), fetches the report with the viewer's cookie and renders `TimeReportTable` (`@knotworking/ui`) with over/under cues; an invalid range shows the error and falls back to this week. The toolbar navigates by changing the URL. **Export CSV** is a plain link to `/api/v1/workspaces/:slug/time-report.csv?...`, so the browser downloads it through the `/api/*` proxy, which streams any response body and passes `Content-Disposition` and `Content-Type` through unchanged.
- **MCP:** `get_time_report` ([mcp.md](mcp.md)).

### Org chart

Each membership (`workspace_members`) holds a job title, a department and who the member reports to. It is a **visual reference only**: what anyone may do comes from their workspace role (`owner`, `admin`, `member`, `guest`) and module access, never from the org chart. A "head of technical" is whoever is given `manage` on the quality module; their title just says so.

- **Editing** (`PATCH /…/members/:userId/profile` with any of `title`, `department`, `reportsToUserId`; `memberProfileSchema` in core): owners and admins, signed in (`requireAdmin`, tokens refused), for anyone including owners and themselves. A deactivated member can't be changed (`409 member_deactivated`; reactivate first). The manager must be an active member, not the person themselves, and the line can't loop back (`wouldCreateReportingCycle`, `409 reporting_cycle`); the workspace lock keeps two edits from making a loop between them. Blank text clears a field. The change is a `workspace_member` upsert in the sync log, so open clients refetch the snapshot.
- **Reading**: `GET /…/members` and the bootstrap's `users` carry `title`, `department` and `reportsToUserId`. **Guests** (outside collaborators) get them blanked, in the members list, the bootstrap and the sync log alike, as they get email addresses blanked, and have no org chart page; the MCP tool `get_workspace_overview` gives each member's title, department and manager's name.
- **Web**: hovering a member's avatar (`MemberAvatar`, which looks the person up in the workspace snapshot) shows their card (`MemberCard`): name, title, department, who they report to, workspace role and email. It opens on hover or keyboard focus. Used in comments, project pages and lists, time entries and the member tables; never inside a link or button (subtask rows, doc history, pickers and Gantt bars keep the plain avatar). `/<workspace>/org-chart` (sidebar and ⌘K) shows everyone active as an indented tree (`buildOrgChart` in core: someone whose manager has left sits at the top; loops in old data are broken, nobody is dropped). Admins set titles and reporting lines from Settings → Members, "Title and reporting line": the manager list leaves out the member and everyone under them, shows a manager who has since been deactivated as such, and only changed fields are sent.

## The workspace currency and UK dates

Every workspace has a currency, an ISO 4217 code (`workspaces.currency`, default `GBP`; set like the time zone, `PATCH …/settings`, owners and admins, never a token; on the bootstrap's `workspace`). Money is stored as plain numbers; the currency only decides how it is shown (`formatMoney`, `useWorkspaceCurrency`, `getWorkspaceCurrency`). Dates people read are UK (`08/11/2026`, 24-hour `12:41`) from one set of helpers in `@knotworking/core` `format-date.ts`, used by `apps/web/src/lib/format.ts` and `print.ts`.

## The workspace time zone

Every workspace has one time zone, an IANA name (`workspaces.time_zone`, default `Europe/London`). Owners and admins change it under Workspace settings (`PATCH /v1/workspaces/:slug/settings`, refused to API tokens); everyone, tokens included, reads it with `GET …/settings`, and it is on the bootstrap's `workspace`. It is validated against `Intl.supportedValuesOf("timeZone")` (plus `UTC`; names a runtime lists under an older spelling, such as `Asia/Kolkata`, are accepted too).

- **Invalid stored zones fall back**: the migration copied each workspace's old free-text attendance zone, which may not be a valid IANA name (`GMT`, `utc`, `+01:00`, `Etc/GMT+5`). Anywhere the zone is read (`workspaceTimeZone`, the workspace middleware's `c.var.workspace.timeZone`, the web hooks and `getWorkspaceTimeZone`) a stored value `timeZoneSchema` refuses is replaced by `DEFAULT_TIME_ZONE` (`effectiveTimeZone` in core). The bootstrap's `workspace` and `GET …/settings` return the zone in effect plus `timeZoneInvalid: true`, and the settings page asks an admin to pick a proper zone. `timeZoneSchema` stores the listed, correctly cased name (`asia/kolkata` becomes the name the runtime lists, e.g. `Asia/Calcutta`).
- **Looked up once per request**: the workspace middleware opens a per-request scope (`withTimeZoneScope`, an `AsyncLocalStorage`) seeded with the zone it already read, so services' `workspaceTimeZone` / `workspaceToday` calls cost no further SELECT during a request. Nothing outlives the request, and changing the zone clears it, so the next request sees the new zone. Outside a request (the sweep, kiosks) each call reads the row.
- **Timestamps on screen**: `formatShortDate` / `formatLongDate` / `formatDateTime` take the workspace zone for timestamps (date-only values are left as they are); client components use `useFormatDateTime()` / `useWorkspaceTimeZone()`, never `toLocaleString` without a zone.
- **What it decides**: every business date. "Today" in every module, the latest date a record may have (no future dates, no back-dating), what is due (HACCP checks and calibrations, site programmes, SOP and plan reviews, training, quality, purchasing, stock expiry), report periods (costing ISO weeks and months, demand and production weeks, supplier performance, attendance shifts and pay periods, quality summaries), the notification sweep's due dates, and the `from`/`to` days of record prints and record lists.
- **What it doesn't change**: instants. Times are stored as UTC `timestamptz`; only the step between an instant and a calendar date goes through the zone, so changing the zone moves no record. A date-only column (`YYYY-MM-DD`) stays the calendar day it was entered as.
- **One helper set**: `@knotworking/core` `time-zone.ts` (`Intl` only, so desktop and mobile share it): `todayInZone`, `dateInZone`, `startOfDayInZone` / `endOfDayInZone` / `dateRangeInZone` (a local day's instants, end exclusive, correct on 23- and 25-hour days), `weekStartInZone`, `isoWeekInZone`, `monthStartInZone`, `monthInZone`, `timeZoneSchema`. On the server, routes have the zone as `c.var.workspace.timeZone` (`todayIn(c)`), and services read it with `workspaceTimeZone` / `workspaceToday` (`services/time-zone.ts`). The web app uses `useWorkspaceTimeZone` / `useWorkspaceToday` in client components and `getWorkspaceTimeZone` / `getWorkspaceToday` in server components, never the browser's zone. Range filters compare instants with the local days' bounds rather than `at time zone` in SQL.
- **Attendance** has no zone of its own: shifts and pay periods use the workspace's. The attendance settings still return `timeZone` (read-only); a patch that sends one is refused. Migration `0037_workspace_time_zone` moved each workspace's saved attendance zone onto the workspace.
- **Still in UTC, on purpose**: all-day calendar meetings (stored as UTC midnight, the providers' convention), task due dates and the Gantt timeline (calendar days; "overdue" is checked against today in the workspace's zone), the kiosk's offline replay window and visitor retention (lengths of time, not dates), and the `ST-…` stocktake reference and CSV file names (labels). Exports carry full ISO instants.

## Sync protocol

Every mutation runs in a transaction that also appends to `sync_changes`:

```
client ──mutation──▶ API ──tx──▶ tasks row  +  sync_changes row (cursor N)
client ◀── GET /sync?after=N-1 ── { changes: [...], cursor: "N", hasMore }
```

- **Bootstrap**, then **catch up** with `/sync?after=<cursor>`. The cursor is read before the snapshot, so a racing change is replayed. Upserts are idempotent.
- **Upserts carry the full entity** and deletes are tombstones, so clients need no merge logic for the server's state.
- **Ordering is guaranteed per workspace.** Writers take a transaction-scoped advisory lock on the workspace before appending, so cursors become visible in commit order. A client can never skip a change that commits late.
- **Client-generated IDs** (UUIDv7) let clients create records offline and send them later. `POST` accepts an `id`.
- **Guests** get email addresses blanked in `/sync` as in the bootstrap.
- **Private data stays out.** Personal `calendar_events` are never written to the log, so neither `/sync` nor `/events` can expose them.

### Server push

`GET /v1/workspaces/:slug/events` is a server-sent event stream that only nudges; data still comes from `/sync`, so it needs no access rules of its own.

```
event: ready              ← on connect: the current cursor, so a reconnecting client catches up
data: {"cursor":"41"}

event: sync               ← the log advanced: pull if this is ahead of your cursor
data: {"cursor":"42"}

: ping                    ← every 25 s, keeps proxies from closing an idle stream
```

`SyncHub` (`apps/server/src/sync-hub.ts`) watches the log rather than hooking each write: one `max(id)` query per workspace with listeners every 2 s, plus an immediate check after any successful write this process handles (a middleware in `app.ts`). That catches every writer (other API instances, the calendar scheduler) on any Postgres driver. Streams end after 10 minutes, so clients reconnect and their session is checked again. Because the credential is only checked when the stream opens, an open stream re-checks every 30 s (`DEFAULT_STREAM_REVALIDATE_MS`) and ends cleanly when it no longer holds: for API tokens when the token is revoked or expired or its owner is deactivated or has no active membership (`isApiTokenValid`), and for every stream (token or session) when the user is no longer a member of the workspace. Sessions are not otherwise re-validated mid-stream: they stay bounded by the 10-minute lifetime, and deactivating a user deletes their sessions; a stream carries only cursors, never entity data. Responses carry `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` so compressing or buffering proxies (Next.js `compress`, Caddy `encode`, nginx) pass events through; the web app's `/api/*` proxy streams the body and aborts the upstream request when the browser disconnects.

### Client sync store

`SyncStore` (`@knotworking/core`, `sync-store.ts`) is the portable part, with no DOM, Node or timer APIs, so desktop and mobile reuse it with their own transport and persistence:

- **Tables per entity type** (`task`, `task_label`, …) hold rows as the log carries them. It is generic: an entity type it has never seen gets a table, so new entities need no store changes.
- **Applying changes** is idempotent: upserts replace the row, deletes (and upserts with `deletedAt` set) remove it. Changes at or before the store's cursor are skipped. Only touched tables are copied, so unchanged collections keep their identity (cheap re-renders).
- **Pulling** follows `hasMore` page by page and is single-flight: calls during a pull schedule exactly one more. A snapshot reset mid-pull restarts it from the new cursor. A server that says `hasMore` without advancing is an error, not a loop.
- **Optimistic mutations** are overlays (pure functions over the tables) recomputed on top of server state. Incoming changes rebase them for free, and a failed request just removes its overlay, so a rollback can't clobber newer data from someone else. A remote delete wins over a pending patch.
- **Reconciliation:** a successful write keeps its overlay until a pull that _started after_ the response finishes. The server commits before it responds and cursors become visible in commit order, so that pull contains the write's own change and nothing flickers back. A create can swap in the server's returned row (`confirmed`) for that window.

The web wrapper (`apps/web/src/lib/`):

| File                  | Role                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync-model.ts`       | Maps bootstrap collections to entity types and projects the tables back into a `Bootstrap`-shaped snapshot (task `labelIds` from `task_label` rows, heavy fields dropped, API ordering). Add new collections here.                                                                                                                                       |
| `workspace-sync.ts`   | One workspace: the store, the base snapshot, `/sync` transport. Adopts newer server-rendered snapshots (navigation, `router.refresh()`), ignores older ones. `workspace`/`user`/`workspace_member` changes refetch the bootstrap (members are users joined with roles). Lost access (401/404) refreshes the page.                                        |
| `sync-push.ts`        | `EventSource` on `/api/v1/workspaces/:slug/events`. Pulls on `ready` and `sync`, reconnects with exponential backoff and jitter (1 s → 60 s), polls `/sync` every 30 s while the stream is down (every 5 min while it is up), pulls when the tab becomes visible or the network returns, and closes the stream after 30 s hidden to free the connection. |
| `workspace-store.tsx` | React provider: `useSyncExternalStore` over the snapshot, and the task, project and time-tracking mutations (`logTime`, `updateTimeEntry`, `deleteTimeEntry`, `startTimer`, `stopTimer`; starting a timer stops the running one optimistically too).                                                                                                     |

To make another entity live in the web app: include it in the bootstrap, add its collection to `sync-model.ts`, and write through `sync.store.mutate({ apply, send })`.

Over plain HTTP/1.1 (`next dev`, or Caddy on `:80` on a LAN) a browser allows about six connections per host, and each visible tab holds one for its stream; hidden tabs give theirs up after 30 s. With a domain, Caddy serves HTTPS and HTTP/2, which has no such limit.

## Authentication and access

[Better Auth](https://www.better-auth.com) runs inside the API (`apps/server/src/auth.ts`) and stores users, sessions and linked accounts in our Postgres (`users`, `sessions`, `accounts`, `verifications`). It is self-hosted, free and works offline on a LAN.

| Client           | Credential                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web              | http-only session cookie. The browser only talks to the web origin, which proxies `/api/*` to the API (`apps/web/src/app/api/[...path]/route.ts`), so cookies are first-party on any host. |
| Desktop / mobile | The same session as a bearer token (`Authorization: Bearer …`, Better Auth `bearer` plugin), stored in the OS keychain or secure storage.                                                  |
| Agents / scripts | A personal API token (`Authorization: Bearer knw_…`, see [API tokens](#api-tokens)), for clients that can't sign in, such as the MCP server.                                               |

`requireSession` resolves any of them into `c.var.user` (and `c.var.credential`, which says whether it was a session or a token), so routes don't care which client is calling.

**Managed access:**

- **No public sign-up** (`disableSignUp`). Accounts are created by first-run setup (`POST /v1/public/setup`, only while there are no users) or by accepting an invitation (`/v1/public/invitations/:token/accept`). Invitation tokens are random 32-byte values; only their SHA-256 hash is stored, and they expire after 7 days.
- **OAuth sign-ups** (Google, Microsoft or GitHub, optional) pass through a `user.create.before` hook that requires a provider-verified email with a pending invitation. No provider is "trusted" for implicit account linking, so an unverified email can't take over an existing account.
- **First-run setup** needs a one-time code printed in the API log, and runs under an advisory lock so only one setup can succeed.
- **CSRF**: cookie-authenticated `/v1` writes must carry an `Origin` matching `APP_URL` (or `TRUSTED_ORIGINS`), on top of `SameSite=Lax` cookies.
- **Client IP** (for rate limits): the web proxy derives it from `TRUSTED_PROXIES` hops of `X-Forwarded-For` (Caddy in `compose.yaml`), strips anything the browser sent, and passes it to the API in `x-knotworking-client-ip`.
- **Deactivation** soft-deletes the workspace membership and deletes the user's sessions. A `session.create.before` hook blocks sign-in for users with no active membership.
- **Roles** (`owner`, `admin`, `member`, `guest`) are per workspace. Admin routes use `requireAdmin`; writes use `requireWriter` (guests are read-only and don't receive teammates' emails); only owners can manage owners (or task admins' reset links); and the last owner can't be demoted or removed.
- **Password reset** links are created by Better Auth. Admins can generate one for a member, and it's returned to them as well as emailed when SMTP is configured.

### API tokens

Personal API tokens let non-browser agents (the MCP server, scripts) call the API without a sign-in session. A user creates them with `POST /v1/me/api-tokens` (`{ name, scope, expiresInDays? }`, 1–365 days, no expiry by default), lists them with `GET /v1/me/api-tokens` and revokes them with `DELETE /v1/me/api-tokens/:id` (`api_tokens` table, `services/api-tokens.ts`, `routes/api-tokens.ts`).

- **Format:** `knw_` + 32 random bytes as base64url, sent as `Authorization: Bearer knw_…` to any route guarded by `requireSession`. The plaintext is returned **once**, in the creation response. Only its SHA-256 hash is stored (as for invitation tokens), plus the first 8 characters (`prefix`) for display. `lastUsedAt` is refreshed at most every 5 minutes.
- **Scopes:** `read` allows only `GET`/`HEAD`/`OPTIONS`; any other method is refused with `403 token_read_only`. `write` acts with the owner's full permissions, and the owner's workspace role still applies (`workspaceAccess`, `requireWriter`), so a guest's write token is still read-only.
- **Never reaches Better Auth:** `requireSession` resolves `knw_` values itself, and `/api/auth/*` refuses them (`403 token_not_allowed`). Unknown, revoked and expired tokens get `401 unauthenticated`, and so do tokens whose owner has no active workspace membership (the sign-in rule), so deactivating a member also stops their tokens. Deleting a user deletes their tokens.
- **Managing tokens needs a real session.** The `/v1/me/api-tokens` routes answer `403 session_required` to a token, so a leaked token can't mint more.
- **Tokens never get admin routes:** `requireAdmin` answers `403 token_not_allowed` whatever the owner's role. The same code covers personal calendar data: `/v1/calendar/*`, the combined calendar view (`GET /v1/workspaces/:slug/calendar`) and importing a calendar event (`POST …/meetings/import`).
- **CSRF** only applies to requests that carry a cookie, so bearer clients are unaffected.
- Tokens are per-user, not workspace data, so creating or revoking one is **not** written to the sync log.

## Calendar sync

`apps/server/src/calendar/` holds a provider-neutral sync engine with adapters for Google Calendar (REST v3) and Microsoft Graph. See [calendar.md](calendar.md) for the user-facing behaviour.

| Table                           | Visibility | Purpose                                                                                                      |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `calendar_connections`          | private    | One per member per provider: the linked Better Auth account (encrypted tokens), the delta cursor, and status |
| `calendar_events`               | private    | A rolling mirror of the member's calendar. Never written to the sync log.                                    |
| `meetings`, `meeting_attendees` | workspace  | Team meetings, written to the sync log like other entities                                                   |

**One sync run** (`syncConnection`), under a per-connection lease that only its holder can release. Immediate pushes after an edit take the same lease, so pushes never overlap:

1. Push meetings with `syncState` `pending` or `error` to the organizer's calendar (create, update or cancel). The provider sends invitations. A push only marks a meeting `synced` if its `localVersion` hasn't changed in the meantime, so an edit made during a push goes out on the next run.
2. Pull changes since the cursor (`syncToken` / `deltaLink`). Expired cursors and weekly re-baselines trigger a full reload of the window.
3. Apply the changes:
   - Mirror the events.
   - Update meetings linked by (connection, external id). Organizer-side edits win unless Knotworking has unpushed changes.
   - Match invitees' copies by iCalUID to dedupe them and record RSVPs. Occurrences of a recurring series must also match the start time, and the match is limited to the person's own workspaces.

A scheduler polls every connection (default 5 minutes). Webhooks (Google `watch`, Graph subscriptions) can be added later to trigger runs sooner on public deployments. The engine is tested with an in-memory fake provider; the adapters are tested against documented request and response shapes.

## Reliable cross-module commands and read models

The internal bootstrap returns every visible task, without a hidden row cap. Public task lists retain their requested limit. Label links are resolved in chunks to stay below Postgres's bind-parameter limit. The cursor is still read before the snapshot so concurrent changes are replayed.

Stock ledger primitives and serializers live in `services/stock-ledger.ts`. Cross-module callers use the explicit exports in `services/ports/` for stock, production, demand, training and invoice prices. These APIs preserve the caller's transaction; they do not turn coordinated writes into separate requests. `module-boundaries.test.ts` checks the import boundary. QA lot decisions and supplier approval acquire the same workspace advisory lock as the ledger before reading or updating their subject.

Stock receipts, purchasing receipts, production consumption and production output accept an optional UUID `commandId`, or the matching `Idempotency-Key` header. A private `ledger_commands` receipt stores the actor, workspace, operation, normalized payload hash and original result in the same transaction as the ledger changes. Replaying the same command returns that result without new rows or sync entries; changing its payload or target returns `409 command_conflict`. Failed transactions consume no key. Existing callers without keys retain their existing behavior. Receipt records have no automatic expiry, so old retries cannot silently become new writes.

The typed API client adds a key and retries a failed ledger transport once. Open web receipt/consumption/output forms retain their command ID for manual retries; agent receipt tools accept `command_id` for the same purpose. A changed payload after a successful command needs a new ID. The transport never automatically retries unrelated writes or an HTTP rejection.

Paginated manufacturing read models refresh when the workspace sync log carries relevant changes. `module-invalidation.ts` follows manifest dependencies plus optional readers: for example, invoices invalidate costing, reservations invalidate stock availability, and HACCP changes invalidate batch views. Route refreshes are debounced and preserve form state; expanded stock-lot query caches are cleared when the stock snapshot changes. Task/doc views keep their existing live replica behavior.

`GET /production/batches/:id/readiness` is the shared advisory food-safety assessment for batch completion and output release: missing CCP checks, pending reviews and open corrective actions. It reports `checked: false` and no details when HACCP is unreadable, never an implicit pass. Existing sign-off rules remain in force; the assessment warns rather than adding a new blocking policy.

Notification rows contain an embedded transactional email outbox. A worker recovers pending deliveries after restart, claims each with a fenced expiring lease, rechecks current access and preferences, and retries failures with exponential backoff. Delivery status and attempt fields are private and omitted from API responses. Existing inbox history is marked skipped on migration to avoid a historical email flood. SMTP delivery is at-least-once: a crash after SMTP accepts a message but before the success is stored can cause a duplicate email.

## Sidebar

The sidebar shows **one module at a time** instead of every module at once, so it stays short however many modules are on.

- **Module picker.** The workspace name at the top is a button. It opens a searchable list of the modules the viewer can use (`AreaSwitcher`); choosing one opens that module's first page and the sidebar shows its sections. The same modules are in ⌘K under "Switch module". The list, the sections of each module and the access each page needs live in `apps/web/src/lib/sidebar-nav.ts` (`navAreas`). A "Workspace" area holds the platform pages (members, org chart, teams and workflows, task labels, connected calendars, raise a concern).
- **Always there.** Task planning and the calendar are global tools, so they are not modules to switch to: Search, Assistant, New task and Inbox, then My tasks, Projects, Calendar and the team boards (each when the viewer has the module; the **Teams** list folds away with its heading, the choice is kept in the cookie `knw_teams_<slug>`, and the team whose page is open stays listed while it is folded), are in the sidebar whichever module is showing (`pinnedItems` in `sidebar-nav.ts`). Under the module's sections, a **Wiki** link opens the docs index, which works as the company wiki (`wikiItem`).
- **Which module is showing.** The module the current page belongs to (`areaForPath`: longest matching item path, plus detail routes such as `/task/:id`); on pages that belong to none (the inbox, tasks, the calendar, the wiki) the last module shown, then the viewer's default, then the Workspace area.
- **Default module.** The star beside a module makes it the one the workspace opens on (`/<workspace>` redirects to its first page); starring it again clears it. Without one, the old landing page applies (My tasks, else Docs, else Inbox).
- **Recent docs.** Under the Wiki link, the last five docs the viewer opened in this workspace, newest first. Opening `/<workspace>/docs/:id` records it; docs that were deleted or that the viewer can no longer read are skipped.
- **Where it is kept.** In the browser (or the desktop app's window), not on the server, so it is per device: the default and last module are cookies `knw_home_<slug>` and `knw_area_<slug>` (cookies so the server renders `/<workspace>` and the first paint correctly), the recent docs are in localStorage keyed by person and workspace. Nothing is synced, and clearing site data resets it. Code: `lib/sidebar-prefs.ts`.
