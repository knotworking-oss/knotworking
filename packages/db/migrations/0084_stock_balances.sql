CREATE TABLE "stock_balances" (
	"lot_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric NOT NULL,
	CONSTRAINT "stock_balances_lot_id_location_id_pk" PRIMARY KEY("lot_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_balances_live_lot_idx" ON "stock_balances" USING btree ("workspace_id","lot_id") WHERE "stock_balances"."quantity" <> 0;--> statement-breakpoint
CREATE INDEX "stock_balances_live_item_idx" ON "stock_balances" USING btree ("workspace_id","item_id") WHERE "stock_balances"."quantity" <> 0;--> statement-breakpoint
CREATE INDEX "stock_balances_live_location_idx" ON "stock_balances" USING btree ("location_id","lot_id") WHERE "stock_balances"."quantity" <> 0;--> statement-breakpoint
CREATE INDEX "stock_lots_workspace_code_prefix_idx" ON "stock_lots" USING btree ("workspace_id",lower("lot_code") text_pattern_ops);
--> statement-breakpoint
-- Balances are the running sum of the append-only ledger. Hold writes to the ledger (reads still run)
-- while the table is filled and the trigger installed, so no movement can fall between the two.
LOCK TABLE "stock_movements" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
INSERT INTO "stock_balances" ("lot_id", "location_id", "workspace_id", "item_id", "quantity")
SELECT m."lot_id", m."location_id", l."workspace_id", l."item_id", sum(m."quantity")
FROM "stock_movements" m
JOIN "stock_lots" l ON l."id" = m."lot_id"
GROUP BY m."lot_id", m."location_id", l."workspace_id", l."item_id";--> statement-breakpoint
CREATE FUNCTION "stock_balances_apply"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "stock_balances" ("lot_id", "location_id", "workspace_id", "item_id", "quantity")
  VALUES (NEW."lot_id", NEW."location_id", NEW."workspace_id", NEW."item_id", NEW."quantity")
  ON CONFLICT ("lot_id", "location_id")
  DO UPDATE SET "quantity" = "stock_balances"."quantity" + EXCLUDED."quantity";
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "stock_movements_balance" AFTER INSERT ON "stock_movements"
FOR EACH ROW EXECUTE FUNCTION "stock_balances_apply"();
