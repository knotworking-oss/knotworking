/** Private command receipts. Never included in workspace sync or bootstrap. */
import { jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../schema";
import { pk, ts, workspaceRef } from "./helpers";

export const ledgerCommands = pgTable(
  "ledger_commands",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    commandId: uuid("command_id").notNull(),
    operation: text("operation").notNull(),
    payloadHash: text("payload_hash").notNull(),
    result: jsonb("result").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ledger_commands_request_key").on(t.workspaceId, t.actorId, t.commandId)],
);
