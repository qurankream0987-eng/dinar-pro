CREATE TABLE "order_fulfillments" (
	"order_id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"failure_reason" text,
	"selected_by" text NOT NULL,
	"status_changed_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_fulfillments_method_valid" CHECK ("order_fulfillments"."method" IN ('PICKUP', 'SELLER_DELIVERY', 'COURIER', 'EXTERNAL_PROVIDER')),
	CONSTRAINT "order_fulfillments_status_valid" CHECK ("order_fulfillments"."status" IN ('REQUESTED', 'ACCEPTED', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED')),
	CONSTRAINT "order_fulfillments_status_method_consistent" CHECK (("order_fulfillments"."method" = 'PICKUP' AND "order_fulfillments"."status" IN ('REQUESTED', 'READY_FOR_PICKUP', 'PICKED_UP', 'CANCELLED', 'FAILED')) OR ("order_fulfillments"."method" <> 'PICKUP' AND "order_fulfillments"."status" IN ('REQUESTED', 'ACCEPTED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED'))),
	CONSTRAINT "order_fulfillments_failure_consistent" CHECK (("order_fulfillments"."status" = 'FAILED') = ("order_fulfillments"."failure_reason" IS NOT NULL) AND ("order_fulfillments"."failure_reason" IS NULL OR "order_fulfillments"."failure_reason" IN ('BUYER_UNAVAILABLE', 'ADDRESS_UNREACHABLE', 'SELLER_UNABLE', 'OTHER'))),
	CONSTRAINT "order_fulfillments_version_positive" CHECK ("order_fulfillments"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "transaction_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"market_id" text NOT NULL,
	"purpose" text NOT NULL,
	"source" text NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_meters" integer,
	"city" text DEFAULT '' NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"address_text" text,
	"note" text,
	"shared_by" text NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_locations_purpose_valid" CHECK ("transaction_locations"."purpose" IN ('DELIVERY_DESTINATION', 'PICKUP_POINT', 'SERVICE_APPOINTMENT')),
	CONSTRAINT "transaction_locations_source_valid" CHECK ("transaction_locations"."source" IN ('DEVICE', 'MANUAL')),
	CONSTRAINT "transaction_locations_coordinates_paired" CHECK (("transaction_locations"."latitude" IS NULL) = ("transaction_locations"."longitude" IS NULL)),
	CONSTRAINT "transaction_locations_coordinates_range" CHECK ("transaction_locations"."latitude" IS NULL OR ("transaction_locations"."latitude" BETWEEN -90 AND 90 AND "transaction_locations"."longitude" BETWEEN -180 AND 180)),
	CONSTRAINT "transaction_locations_accuracy_range" CHECK ("transaction_locations"."accuracy_meters" IS NULL OR "transaction_locations"."accuracy_meters" BETWEEN 0 AND 100000),
	CONSTRAINT "transaction_locations_text_lengths" CHECK (char_length("transaction_locations"."city") <= 100 AND char_length("transaction_locations"."area") <= 100 AND ("transaction_locations"."address_text" IS NULL OR char_length("transaction_locations"."address_text") <= 300) AND ("transaction_locations"."note" IS NULL OR char_length("transaction_locations"."note") <= 300)),
	CONSTRAINT "transaction_locations_content_present" CHECK ("transaction_locations"."redacted_at" IS NOT NULL OR ("transaction_locations"."source" = 'DEVICE' AND "transaction_locations"."latitude" IS NOT NULL) OR ("transaction_locations"."source" = 'MANUAL' AND "transaction_locations"."address_text" IS NOT NULL)),
	CONSTRAINT "transaction_locations_redaction_consistent" CHECK ("transaction_locations"."redacted_at" IS NULL OR ("transaction_locations"."latitude" IS NULL AND "transaction_locations"."accuracy_meters" IS NULL AND "transaction_locations"."address_text" IS NULL AND "transaction_locations"."note" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_selected_by_users_id_fk" FOREIGN KEY ("selected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_locations" ADD CONSTRAINT "transaction_locations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_locations" ADD CONSTRAINT "transaction_locations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_locations" ADD CONSTRAINT "transaction_locations_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_locations_order_purpose_unique" ON "transaction_locations" USING btree ("order_id","purpose");