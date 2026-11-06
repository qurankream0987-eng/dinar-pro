-- DINAR Connect merchant participation modes (additive, reviewed).
-- Every partner that exists before this migration participates through external referral
-- (the only Connect commerce path that existed), so it keeps BUY_ON_MERCHANT_WEBSITE.
-- Choosing a mode never enables native checkout by itself; that capability is derived server-side.
ALTER TABLE "connect_partners"
  ADD COLUMN "participation_mode" text DEFAULT 'BUY_ON_MERCHANT_WEBSITE' NOT NULL;
--> statement-breakpoint
ALTER TABLE "connect_partners"
  ADD COLUMN "participation_mode_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "connect_partners"
  ADD CONSTRAINT "connect_partners_participation_mode_valid"
  CHECK ("participation_mode" IN ('SELL_INSIDE_DINAR', 'BUY_ON_MERCHANT_WEBSITE', 'HYBRID'));
