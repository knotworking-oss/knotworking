import { newId } from "@knotworking/core";
import { timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "../schema";

/** Column helpers shared by every schema file. (`workspaces` is only read lazily, inside `references`.) */

export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const pk = () => uuid("id").primaryKey().$defaultFn(newId);

export const timestamps = () => ({
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: ts("deleted_at"),
});

export const workspaceRef = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });
