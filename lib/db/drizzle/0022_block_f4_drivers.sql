CREATE TABLE "delivery_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"market_id" text NOT NULL,
	"driver_profile_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"status" text DEFAULT 'ACCEPTED' NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_assignments_status_valid" CHECK ("delivery_assignments"."status" IN ('ACCEPTED', 'RELEASED')),
	CONSTRAINT "delivery_assignments_release_consistent" CHECK (("delivery_assignments"."status" = 'RELEASED') = ("delivery_assignments"."released_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "driver_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"availability" text DEFAULT 'UNAVAILABLE' NOT NULL,
	"vehicle_type" text,
	"service_city" text,
	"reviewed_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_profiles_status_valid" CHECK ("driver_profiles"."status" IN ('DRAFT', 'PENDING_VERIFICATION', 'APPROVED', 'SUSPENDED')),
	CONSTRAINT "driver_profiles_availability_valid" CHECK ("driver_profiles"."availability" IN ('AVAILABLE', 'UNAVAILABLE')),
	CONSTRAINT "driver_profiles_available_requires_approval" CHECK ("driver_profiles"."availability" = 'UNAVAILABLE' OR "driver_profiles"."status" = 'APPROVED'),
	CONSTRAINT "driver_profiles_vehicle_valid" CHECK ("driver_profiles"."vehicle_type" IS NULL OR "driver_profiles"."vehicle_type" IN ('CAR', 'MOTORCYCLE', 'BICYCLE')),
	CONSTRAINT "driver_profiles_city_length" CHECK ("driver_profiles"."service_city" IS NULL OR char_length("driver_profiles"."service_city") BETWEEN 1 AND 100),
	CONSTRAINT "driver_profiles_version_positive" CHECK ("driver_profiles"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_driver_profile_id_driver_profiles_id_fk" FOREIGN KEY ("driver_profile_id") REFERENCES "public"."driver_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_assignments_one_active_per_order" ON "delivery_assignments" USING btree ("order_id") WHERE "delivery_assignments"."status" = 'ACCEPTED';--> statement-breakpoint
CREATE INDEX "delivery_assignments_driver_status_idx" ON "delivery_assignments" USING btree ("driver_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_profiles_user_market_unique" ON "driver_profiles" USING btree ("user_id","market_id");