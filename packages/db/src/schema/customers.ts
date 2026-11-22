import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pk, timestamps, workspaceRef } from "./helpers";

/** Shared customer reference data, independent of future commercial sales/pricing access. */
export const customers = pgTable(
  "customers",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    address: text("address").notNull(),
    contactName: text("contact_name"),
    email: text("email"),
    phone: text("phone"),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("customers_workspace_code_key").on(t.workspaceId, sql`lower(${t.code})`),
    index("customers_workspace_name_idx").on(t.workspaceId, t.name),
  ],
);

export const customerDeliverySites = pgTable(
  "customer_delivery_sites",
  {
    id: pk(),
    workspaceId: workspaceRef(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    address: text("address").notNull(),
    contactName: text("contact_name"),
    email: text("email"),
    phone: text("phone"),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("customer_delivery_sites_code_key").on(t.customerId, sql`lower(${t.code})`),
    index("customer_delivery_sites_workspace_idx").on(t.workspaceId, t.customerId),
  ],
);
