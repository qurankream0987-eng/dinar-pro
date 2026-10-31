-- C1: PostgreSQL search foundation. Additive only: one table, two defaulted columns, indexes, triggers.
-- pg_trgm is a trusted extension (PostgreSQL 13+): the database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "offer_search_documents" (
	"offer_id" text PRIMARY KEY NOT NULL,
	"search_text" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"text_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "search_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "search_document_stale" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_search_documents" ADD CONSTRAINT "offer_search_documents_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_search_documents_text_trgm_idx" ON "offer_search_documents" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "offer_search_documents_version_idx" ON "offer_search_documents" USING btree ("text_version");--> statement-breakpoint
CREATE INDEX "offers_market_status_created_idx" ON "offers" USING btree ("market_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "offers_market_status_price_idx" ON "offers" USING btree ("market_id","status","unit_price_minor");--> statement-breakpoint
CREATE INDEX "offers_search_stale_idx" ON "offers" USING btree ("market_id") WHERE "offers"."search_document_stale";--> statement-breakpoint
CREATE INDEX "offers_market_category_id_idx" ON "offers" USING btree ("market_id",("data"->>'categoryId'));--> statement-breakpoint
CREATE INDEX "offers_market_category_label_idx" ON "offers" USING btree ("market_id",("data"->>'category'));--> statement-breakpoint
CREATE INDEX "offers_seller_created_idx" ON "offers" USING btree ("seller_id","created_at","id");--> statement-breakpoint
-- Any change to a listing's data advances its search revision and marks its document stale, so a
-- document is trusted only for the exact revision it was built from. New rows always start stale.
CREATE OR REPLACE FUNCTION offers_search_revision_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.search_revision := 0;
    NEW.search_document_stale := true;
  ELSIF NEW.data IS DISTINCT FROM OLD.data THEN
    NEW.search_revision := OLD.search_revision + 1;
    NEW.search_document_stale := true;
  ELSIF NEW.search_revision < OLD.search_revision THEN
    NEW.search_revision := OLD.search_revision;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER offers_search_revision BEFORE INSERT OR UPDATE ON "offers" FOR EACH ROW EXECUTE FUNCTION offers_search_revision_guard();--> statement-breakpoint
-- A category's label, aliases or attribute schema shape the searchable text of every listing that
-- names it (by id or, for older rows, by label): all of them become stale.
CREATE OR REPLACE FUNCTION marketplace_categories_search_invalidate() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE "offers" SET search_document_stale = true, search_revision = search_revision + 1
    WHERE data->>'categoryId' = OLD.id OR data->>'category' = OLD.label;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE "offers" SET search_document_stale = true, search_revision = search_revision + 1
    WHERE data->>'categoryId' = NEW.id OR data->>'category' = NEW.label;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER marketplace_categories_search_invalidate AFTER INSERT OR UPDATE OR DELETE ON "marketplace_categories" FOR EACH ROW EXECUTE FUNCTION marketplace_categories_search_invalidate();
