CREATE TABLE "delivery_progress_events" (
  "id" text PRIMARY KEY NOT NULL,
  "order_id" text NOT NULL REFERENCES "orders"("id"),
  "market_id" text NOT NULL REFERENCES "markets"("id"),
  "assignment_id" text REFERENCES "delivery_assignments"("id"),
  "actor_id" text NOT NULL REFERENCES "users"("id"),
  "type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "delivery_progress_type_valid" CHECK ("type" IN ('PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'HANDED_OFF', 'BUYER_RECEIVED')),
  CONSTRAINT "delivery_progress_assignment_consistent" CHECK (("type" = 'BUYER_RECEIVED') = ("assignment_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_progress_order_type_unique" ON "delivery_progress_events" ("order_id", "type");
--> statement-breakpoint
CREATE INDEX "delivery_progress_order_created_idx" ON "delivery_progress_events" ("order_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION delivery_progress_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'delivery_progress_events is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER delivery_progress_events_append_only_row
BEFORE UPDATE OR DELETE ON "delivery_progress_events"
FOR EACH ROW EXECUTE FUNCTION delivery_progress_events_append_only();
--> statement-breakpoint
CREATE TRIGGER delivery_progress_events_append_only_truncate
BEFORE TRUNCATE ON "delivery_progress_events"
FOR EACH STATEMENT EXECUTE FUNCTION delivery_progress_events_append_only();
