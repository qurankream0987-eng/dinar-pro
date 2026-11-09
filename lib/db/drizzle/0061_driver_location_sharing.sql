-- DINAR first-party driver location sharing (additive, reviewed).
-- One row per courier assignment, holding only the latest validated position while the driver
-- has explicitly started sharing. No movement history is stored: each update overwrites the row,
-- and ending the session (driver stop, delivery end, cancellation, revocation) clears coordinates.
CREATE TABLE "driver_location_shares" (
  "assignment_id" text PRIMARY KEY NOT NULL REFERENCES "delivery_assignments"("id"),
  "order_id" text NOT NULL REFERENCES "orders"("id"),
  "market_id" text NOT NULL REFERENCES "markets"("id"),
  "driver_id" text NOT NULL REFERENCES "users"("id"),
  "status" text DEFAULT 'ACTIVE' NOT NULL,
  "consented_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "end_reason" text,
  "latitude" double precision,
  "longitude" double precision,
  "accuracy_meters" integer,
  "observed_at" timestamp with time zone,
  "received_at" timestamp with time zone,
  "sequence" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "driver_location_shares_status_valid" CHECK ("status" IN ('ACTIVE', 'ENDED')),
  CONSTRAINT "driver_location_shares_end_consistent" CHECK (("status" = 'ENDED') = ("ended_at" IS NOT NULL) AND ("status" = 'ENDED') = ("end_reason" IS NOT NULL)),
  CONSTRAINT "driver_location_shares_end_reason_valid" CHECK ("end_reason" IS NULL OR "end_reason" IN ('DRIVER_STOPPED', 'DELIVERY_ENDED', 'ASSIGNMENT_ENDED', 'EXPIRED')),
  CONSTRAINT "driver_location_shares_no_position_after_end" CHECK ("status" = 'ACTIVE' OR ("latitude" IS NULL AND "longitude" IS NULL AND "accuracy_meters" IS NULL AND "observed_at" IS NULL)),
  CONSTRAINT "driver_location_shares_position_complete" CHECK (("latitude" IS NULL) = ("longitude" IS NULL) AND ("latitude" IS NULL) = ("observed_at" IS NULL)),
  CONSTRAINT "driver_location_shares_position_range" CHECK ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180)),
  CONSTRAINT "driver_location_shares_accuracy_range" CHECK ("accuracy_meters" IS NULL OR "accuracy_meters" BETWEEN 0 AND 5000),
  CONSTRAINT "driver_location_shares_sequence_nonnegative" CHECK ("sequence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "driver_location_shares_one_active_per_order" ON "driver_location_shares" ("order_id") WHERE "status" = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX "driver_location_shares_driver_status_idx" ON "driver_location_shares" ("driver_id", "status");
