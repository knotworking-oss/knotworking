ALTER TABLE "attendance_settings" ADD COLUMN "pay_period_kind" text DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD COLUMN "pay_period_anchor" date;