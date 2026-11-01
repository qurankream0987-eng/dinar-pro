ALTER TABLE "offers" ADD COLUMN "business_profile_id" text;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_business_profile_id_business_profiles_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offers_business_profile_idx" ON "offers" USING btree ("business_profile_id") WHERE "offers"."business_profile_id" IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION offers_business_owner_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.business_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM business_profiles bp
    WHERE bp.id = NEW.business_profile_id AND bp.owner_user_id = NEW.seller_id AND bp.market_id = NEW.market_id
  ) THEN
    RAISE EXCEPTION 'a listing may only belong to a business of the same owner and market' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER offers_business_owner_guard_row
BEFORE INSERT OR UPDATE OF business_profile_id, seller_id, market_id ON "offers"
FOR EACH ROW EXECUTE FUNCTION offers_business_owner_guard();
