/**
 * Documents module (`docs`): the team wiki and its version history. See docs/modules.md.
 */
import type { DocContent, DocumentRevisionKind } from "@knotworking/core";
import { index, jsonb, pgTable, text, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { teams, users } from "../schema";
import { pk, timestamps, ts, workspaceRef } from "./helpers";
import { projects } from "./tasks";

export const documents = pgTable(
  "documents",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    /** Nesting: documents form a tree (Notion-style pages within pages). */
    parentId: uuid("parent_id").references((): AnyPgColumn => documents.id, { onDelete: "cascade" }),
    /** Optional association, so a team or project can have its own docs. */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    title: text("title").notNull().default(""),
    icon: text("icon"),
    coverUrl: text("cover_url"),
    content: jsonb("content").$type<DocContent>(),
    sortOrder: text("sort_order").notNull(),
    creatorId: uuid("creator_id").references(() => users.id, { onDelete: "set null" }),
    lastEditedById: uuid("last_edited_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("documents_workspace_parent_idx").on(t.workspaceId, t.parentId),
    index("documents_project_idx").on(t.projectId),
  ],
);

/**
 * A snapshot of a document's title and body, for version history. Workspace data but, like
 * `comments`, NOT in the sync log: content is large, so clients fetch revisions on demand through
 * `GET …/documents/:id/revisions`. Written by `services/document-revisions.ts` in the same
 * transaction as the document write.
 */
export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    content: jsonb("content").$type<DocContent>(),
    /** Who saved it. Null once that account is gone. */
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** "edit" | "restore" | "before-restore" (see `DocumentRevisionKind` in `@knotworking/core`). */
    kind: text("kind").$type<DocumentRevisionKind>().notNull().default("edit"),
    /** When the revision was started. Saves within the throttle window update it in place. */
    createdAt: ts("created_at").notNull().defaultNow(),
    /** When the snapshot last changed (later than `createdAt` after in-place updates). */
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("document_revisions_document_idx").on(t.documentId, t.createdAt)],
);
