CREATE TABLE "checkout_requests" (
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_requests_pkey" PRIMARY KEY("user_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reservation_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "orders"
SET "reservation_expires_at" = CASE
  WHEN ("data"->>'expiresAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    THEN ("data"->>'expiresAt')::timestamptz
  ELSE "created_at" + interval '30 minutes'
END
WHERE "status" = 'CREATED';--> statement-breakpoint
ALTER TABLE "checkout_requests" ADD CONSTRAINT "checkout_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_requests_created_idx" ON "checkout_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_reservation_expiry_idx" ON "orders" USING btree ("status","reservation_expires_at");