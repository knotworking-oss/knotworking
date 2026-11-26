/**
 * Knotworking database schema.
 *
 * Conventions (they exist so desktop/mobile clients can sync later):
 *  - `id` is a UUIDv7 that clients may generate themselves (offline creates).
 *  - Every row carries `workspace_id` — the unit of sync, access control and
 *    (eventually) sharding / row-level security.
 *  - `created_at` / `updated_at` on everything; `deleted_at` soft-deletes so
 *    deletions can propagate to offline clients as tombstones.
 *  - Enum-like columns are `text` validated in @knotworking/core, not Postgres enums,
 *    so old clients tolerate new values and no blocking migrations are needed.
 *  - Manual ordering uses fractional-index strings (`sort_order`).
 *  - Rich text is JSON block trees (see @knotworking/core `DocContent`).
 *  - Every accepted write appends to `sync_changes` in the same transaction.
 */
import type {
  ApiTokenScope,
  ModuleAccessLevel,
  ModuleId,
  NotificationData,
  NotificationType,
  TagColorName,
  WorkspaceRole,
} from "@knotworking/core";
import { pk, timestamps, ts, workspaceRef } from "./schema/helpers";
import { documents } from "./schema/docs";
import { tasks } from "./schema/tasks";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// This file holds the platform: identity, auth, teams, attachments, notifications, API tokens and
// the sync log. Every module's tables live in ./schema/<module>.ts (the original four included) and
// are re-exported at the end of this file; column helpers are in ./schema/helpers.
// ─── Identity & tenancy ──────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: pk(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    timezone: text("timezone"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    /**
     * IANA zone that decides every business date in the workspace: "today", due dates, report
     * periods, print ranges and attendance shift dates. Instants stay UTC. Owners and admins set it.
     */
    timeZone: text("time_zone").notNull().default("Europe/London"),
    /** ISO 4217 code costs and prices are shown in. Amounts are plain numbers; this converts nothing. */
    currency: text("currency").notNull().default("GBP"),
    /**
     * Month (1 = January … 12 = December) the financial year starts in. Reports and dashboards use
     * it for "this financial year", quarters and year-to-date. Calendar months only.
     */
    financialYearStartMonth: integer("financial_year_start_month").notNull().default(1),
    /** Null inherits the installation's enabled modules. An empty array enables only the platform. */
    enabledModules: text("enabled_modules").array().$type<ModuleId[]>(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("workspaces_slug_key").on(t.slug)],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<WorkspaceRole>().notNull().default("member"),
    /** Opt-out for notification emails in this workspace (only sent when SMTP is configured). */
    notifyEmail: boolean("notify_email").notNull().default(true),
    /**
     * The org chart: a job title and department shown when hovering the member's avatar, and who
     * they report to (another member of the workspace). For display only: access comes from `role`
     * and module access, never from here. Set by admins.
     */
    title: text("title"),
    department: text("department"),
    reportsToUserId: uuid("reports_to_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("workspace_members_workspace_user_key").on(t.workspaceId, t.userId),
    index("workspace_members_reports_to_idx").on(t.workspaceId, t.reportsToUserId),
  ],
);

/**
 * A member's explicit level in one module (`@knotworking/core` modules.ts). No row means the
 * module's default for the member's role. Owners and admins always have full access, whatever is
 * stored here. Kept when a module is switched off in the environment, so switching it back on
 * restores who could use it.
 */
export const memberModuleAccess = pgTable(
  "member_module_access",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A `ModuleId`; text so rows of a module this build doesn't know are tolerated. */
    moduleId: text("module_id").notNull(),
    level: text("level").$type<ModuleAccessLevel>().notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("member_module_access_key").on(t.workspaceId, t.userId, t.moduleId)],
);

// ─── Authentication (Better Auth) ───────────────────────────────────────────
// Sessions, linked sign-in methods and one-time tokens. Managed by Better Auth
// (apps/server/src/auth.ts); never synced to clients.

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_key").on(t.token), index("sessions_user_idx").on(t.userId)],
);

/** One row per sign-in method: "credential" (password) or an OAuth provider. */
export const accounts = pgTable(
  "accounts",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    /** Password hash (credential provider only). */
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

/** Short-lived tokens (password resets, OAuth state). */
export const verifications = pgTable(
  "verifications",
  {
    id: pk(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/**
 * Knotworking is invite-only: an admin invites an email address with a role, and
 * only invited addresses can create an account (via the invite link, or by
 * signing in with Google/GitHub using that email). Only a hash of the token is
 * stored.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    email: text("email").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    invitedById: uuid("invited_by_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("invitations_token_hash_key").on(t.tokenHash),
    index("invitations_workspace_email_idx").on(t.workspaceId, t.email),
  ],
);

// ─── Teams ───────────────────────────────────────────────────────────────────

export const teams = pgTable(
  "teams",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Short uppercase key used in the team's URL, e.g. "ENG" → /acme/team/ENG. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    color: text("color").$type<TagColorName>().notNull().default("gray"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("teams_workspace_key_key").on(t.workspaceId, t.key)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("team_members_team_user_key").on(t.teamId, t.userId)],
);

// ─── Attachments ─────────────────────────────────────────────────────────────

/**
 * Uploaded files and images. The bytes live in the API's storage (local disk or S3-compatible,
 * `apps/server/src/storage`) under `storage_key`, which the server derives from ids alone and
 * never sends to clients. The metadata is workspace data and goes through the sync log.
 * Deleting soft-deletes the row (a tombstone for sync clients) and removes the bytes.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    uploaderId: uuid("uploader_id").references(() => users.id, { onDelete: "set null" }),
    /** Optional association: shown in the task's Attachments section, or used by a document. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
    /**
     * Or a module record (polymorphic, so no foreign key): `entityType` is the record's sync entity
     * type (`attachmentTargets` in core), `entityId` its id. The server checks the record exists in
     * the workspace, and the module's access, on every read and write.
     */
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    /** What the file is (certificate, photo, ...) on a module record. */
    kind: text("kind"),
    /**
     * The file this one replaced (a new version of a file on a module record). The earlier file is
     * deleted with the replacement unless its record is locked, in which case it stays beside the
     * new one. No foreign key: the earlier row may be soft-deleted, and ids are never reused.
     */
    replacesId: uuid("replaces_id"),
    /** Display name only (sanitized); never part of a path. */
    filename: text("filename").notNull(),
    /** Sanitized: an image type only when the bytes prove it, else a safe download type. */
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    storageKey: text("storage_key").notNull(),
    ...timestamps(),
  },
  (t) => [
    index("attachments_task_idx").on(t.taskId),
    index("attachments_document_idx").on(t.documentId),
    index("attachments_workspace_idx").on(t.workspaceId),
    index("attachments_entity_idx").on(t.workspaceId, t.entityType, t.entityId),
    check(
      "attachments_one_parent",
      sql`(${t.taskId} is not null)::int + (${t.documentId} is not null)::int + (${t.entityId} is not null)::int <= 1`,
    ),
  ],
);

// ─── Notifications ───────────────────────────────────────────────────────────

/**
 * A per-user inbox entry. Personal, like `calendar_events`: it is NOT written
 * to the workspace sync log (that would broadcast it to every member). Clients
 * fetch their own via `GET /v1/workspaces/:slug/notifications`.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Recipient. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Who caused it (null when the actor was deleted). Never equal to `userId`. */
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").$type<NotificationType>().notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<NotificationData>().notNull(),
    /**
     * The module the notification is about (null: tasks and documents, which hide by their own
     * subject). Hidden from anyone who can no longer read it, and while the module is inactive.
     */
    module: text("module").$type<ModuleId>(),
    /**
     * Due-date notifications: one per subject per due occurrence, e.g.
     * `cleaning:<assetId>:<dueOn>`. The unique index makes the sweep idempotent, also across API
     * instances racing each other (`on conflict do nothing`). Null for event notifications.
     */
    dedupeKey: text("dedupe_key"),
    // Embedded transactional email outbox, private and never synced.
    emailState: text("email_state").$type<"pending" | "sent" | "skipped">().notNull().default("pending"),
    emailAttempts: integer("email_attempts").notNull().default(0),
    emailNextAttemptAt: ts("email_next_attempt_at").notNull().defaultNow(),
    emailLeaseUntil: ts("email_lease_until"),
    emailLeaseToken: uuid("email_lease_token"),
    emailLastError: text("email_last_error"),
    emailSentAt: ts("email_sent_at"),
    readAt: ts("read_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_workspace_idx").on(t.userId, t.workspaceId, t.id),
    index("notifications_unread_idx")
      .on(t.userId, t.workspaceId)
      .where(sql`${t.readAt} is null`),
    index("notifications_email_pending_idx")
      .on(t.emailNextAttemptAt)
      .where(sql`${t.emailState} = 'pending'`),
    uniqueIndex("notifications_dedupe_key").on(t.workspaceId, t.userId, t.dedupeKey),
  ],
);

/**
 * Per-type email preferences (a row only where the member changed the default, which is email
 * on). The Inbox entry is always created. `workspace_members.notify_email` stays the master switch.
 * Personal, never synced.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<NotificationType>().notNull(),
    email: boolean("email").notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("notification_preferences_key").on(t.workspaceId, t.userId, t.type)],
);

/**
 * Which modules the due-date sweep has already swept in a workspace. The first sweep of a module
 * (a new workspace, or a module just switched on) creates its Inbox entries without emailing them,
 * so a deploy doesn't email managers the whole backlog. Server bookkeeping, never synced.
 */
export const notificationSweeps = pgTable(
  "notification_sweeps",
  {
    workspaceId: workspaceRef(),
    module: text("module").$type<ModuleId>().notNull(),
    firstSweptAt: ts("first_swept_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.module] })],
);

// ─── API tokens ──────────────────────────────────────────────────────────────

/**
 * Personal API tokens for non-browser agents (e.g. the MCP server). The token
 * itself (`knw_` + 32 random bytes, base64url) is shown once at creation; only
 * its SHA-256 hash is stored, like invitation tokens. `prefix` is the first few
 * characters of the plaintext, kept for display. Per-user data: never written
 * to the workspace sync log.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    scope: text("scope").$type<ApiTokenScope>().notNull(),
    /**
     * `personal` tokens are made by the member and listed; `assistant` tokens are minted for one
     * assistant turn (minutes long), never listed, never counted toward the member's limit.
     */
    kind: text("kind").$type<"personal" | "assistant">().notNull().default("personal"),
    /** Module allowlist (`ModuleId`s); null = every module the owner can use. */
    modules: jsonb("modules").$type<string[]>(),
    /**
     * Person-only actions (`TokenActionId`s) this token may use once the workspace has switched
     * them on. Null = every action the workspace has switched on (how tokens made before this
     * column behave); a list (empty by default for a new token) restricts it to those.
     */
    tokenActions: jsonb("token_actions").$type<string[]>(),
    /** Largest purchase order value this token may send (`purchasing.send`). Null = no limit. */
    maxOrderValue: numeric("max_order_value", { precision: 18, scale: 2, mode: "number" }),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_key").on(t.tokenHash),
    index("api_tokens_user_idx").on(t.userId, t.createdAt),
  ],
);

// ─── API access toggles ("token actions") ────────────────────────────────────
// Person-only module actions an owner or admin has opened to API tokens (`@knotworking/core`
// token-actions.ts), and the audit of every call a token made through one.

/** A row means the action is on for the workspace; deleting it turns it off. */
export const workspaceTokenActions = pgTable(
  "workspace_token_actions",
  {
    /** The sync log's entity id for this switch (it changes when the action is switched off and on again). */
    id: pk(),
    workspaceId: workspaceRef(),
    /** A `TokenActionId`; text so rows of an action this build doesn't know are tolerated. */
    action: text("action").notNull(),
    enabledBy: uuid("enabled_by").references(() => users.id, { onDelete: "set null" }),
    enabledAt: ts("enabled_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_token_actions_key").on(t.workspaceId, t.action)],
);

/**
 * Append-only audit: one row per request a token made through an action switched on in
 * `workspace_token_actions`, with the response status. Written outside the request's own
 * transaction, so a refused or failed call is recorded too. Never synced.
 */
export const apiTokenActionLog = pgTable(
  "api_token_action_log",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    tokenId: uuid("token_id").references(() => apiTokens.id, { onDelete: "set null" }),
    /** The token's name when it was used: revoked tokens are deleted after 30 days, the audit isn't. */
    tokenName: text("token_name").notNull(),
    /** The token's owner, on whose behalf it acted. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    /** HTTP status of the response. */
    status: smallint("status").notNull(),
    /** Why a call was refused by the token's own allowlist or limit, in words (null otherwise). */
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("api_token_action_log_workspace_created_idx").on(t.workspaceId, t.createdAt.desc())],
);

// ─── Sync log ────────────────────────────────────────────────────────────────

/**
 * Append-only change log. `id` is the sync cursor. Writers take a per-workspace
 * advisory lock before appending (see `recordChanges`), so within a workspace
 * cursors become visible in commit order and clients never skip a change.
 */
export const syncChanges = pgTable(
  "sync_changes",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: workspaceRef(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").$type<"upsert" | "delete">().notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    actorId: uuid("actor_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("sync_changes_workspace_cursor_idx").on(t.workspaceId, t.id)],
);

// ─── Modules (one file each) ─────────────────────────────────────────────────
export * from "./schema/tasks";
export * from "./schema/docs";
export * from "./schema/time";
export * from "./schema/calendar";
export * from "./schema/assets";
export * from "./schema/items";
export * from "./schema/food-items";
export * from "./schema/recipes";
export * from "./schema/sops";
export * from "./schema/stock";
export * from "./schema/customers";
export * from "./schema/despatch";
export * from "./schema/incidents";
export * from "./schema/authenticity";
export * from "./schema/distribution";
export * from "./schema/demand";
export * from "./schema/production";
export * from "./schema/production-devices";
export * from "./schema/haccp";
export * from "./schema/people";
export * from "./schema/training";
export * from "./schema/attendance";
export * from "./schema/quality";
export * from "./schema/purchasing";
export * from "./schema/site";
export * from "./schema/checklists";
export * from "./schema/maintenance";
export * from "./schema/labels";
export * from "./schema/specifications";
export * from "./schema/testing";
export * from "./schema/npd";
export * from "./schema/defence";
export * from "./schema/governance";
export * from "./schema/bi";
export * from "./schema/assistant";

export * from "./schema/ledger-commands";

export * from "./schema/assistant-runtime";
export * from "./schema/costing";

export * from "./schema/sales";

export * from "./schema/hse";
export * from "./schema/hse-incidents";

export * from "./schema/accounting";

export * from "./schema/workforce";
export * from "./schema/purchase-requests";
export * from "./schema/client-services";
export * from "./schema/crm";
export * from "./schema/invoicing";
