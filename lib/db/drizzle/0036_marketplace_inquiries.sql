-- DINAR NEXT G2: buyer–seller inquiries mediated by DINAR. Messages reuse `messages`
-- under a `conversations` row of kind INQUIRY; the header and events live here.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_shape_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_shape_check" CHECK ((kind = 'ORDER' AND order_id IS NOT NULL) OR (kind = 'AI' AND order_id IS NULL AND owner_user_id IS NOT NULL AND market_id IS NOT NULL) OR (kind = 'INQUIRY' AND order_id IS NULL AND owner_user_id IS NULL AND market_id IS NOT NULL));--> statement-breakpoint
CREATE TABLE "marketplace_inquiries" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_conversation_id" text NOT NULL REFERENCES "conversations"("id"),
	"listing_id" text NOT NULL REFERENCES "offers"("id"),
	"market_id" text NOT NULL REFERENCES "markets"("id"),
	"buyer_id" text NOT NULL REFERENCES "users"("id"),
	"seller_id" text NOT NULL REFERENCES "users"("id"),
	"initiator_role" text NOT NULL,
	"relationship" text NOT NULL,
	"negotiation_id" text REFERENCES "negotiations"("id"),
	"order_id" text REFERENCES "orders"("id"),
	"status" text NOT NULL,
	"buyer_conversation_id" text REFERENCES "conversations"("id"),
	"seller_conversation_id" text REFERENCES "conversations"("id"),
	"blocked_by_role" text,
	"last_message_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_inquiries_thread_conversation_id_unique" UNIQUE("thread_conversation_id"),
	CONSTRAINT "marketplace_inquiries_parties_distinct" CHECK ("marketplace_inquiries"."buyer_id" <> "marketplace_inquiries"."seller_id"),
	CONSTRAINT "marketplace_inquiries_initiator_valid" CHECK ("marketplace_inquiries"."initiator_role" IN ('BUYER', 'SELLER')),
	CONSTRAINT "marketplace_inquiries_relationship_valid" CHECK ("marketplace_inquiries"."relationship" IN ('LISTING_INQUIRY', 'NEGOTIATION', 'ORDER')),
	CONSTRAINT "marketplace_inquiries_status_valid" CHECK ("marketplace_inquiries"."status" IN ('AWAITING_SELLER', 'AWAITING_BUYER', 'CLOSED', 'BLOCKED')),
	CONSTRAINT "marketplace_inquiries_blocked_consistent" CHECK (("marketplace_inquiries"."status" = 'BLOCKED') = ("marketplace_inquiries"."blocked_by_role" IS NOT NULL)),
	CONSTRAINT "marketplace_inquiries_blocked_role_valid" CHECK ("marketplace_inquiries"."blocked_by_role" IS NULL OR "marketplace_inquiries"."blocked_by_role" IN ('BUYER', 'SELLER')),
	CONSTRAINT "marketplace_inquiries_seller_scope" CHECK ("marketplace_inquiries"."initiator_role" = 'BUYER' OR "marketplace_inquiries"."relationship" IN ('NEGOTIATION', 'ORDER'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_inquiries_one_open_per_pair_listing" ON "marketplace_inquiries" ("listing_id", "buyer_id") WHERE "marketplace_inquiries"."status" NOT IN ('CLOSED', 'BLOCKED');--> statement-breakpoint
CREATE INDEX "marketplace_inquiries_seller_idx" ON "marketplace_inquiries" ("seller_id", "last_message_at");--> statement-breakpoint
CREATE INDEX "marketplace_inquiries_buyer_idx" ON "marketplace_inquiries" ("buyer_id", "last_message_at");--> statement-breakpoint
CREATE TABLE "marketplace_inquiry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"inquiry_id" text NOT NULL REFERENCES "marketplace_inquiries"("id"),
	"message_id" text REFERENCES "messages"("id"),
	"event_type" text NOT NULL,
	"actor_role" text NOT NULL,
	"actor_id" text REFERENCES "users"("id"),
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_inquiry_events_type_valid" CHECK ("marketplace_inquiry_events"."event_type" IN ('INQUIRY_SUBMITTED', 'INQUIRY_DELIVERED', 'INQUIRY_READ', 'INQUIRY_REPLIED', 'INQUIRY_CLOSED', 'INQUIRY_FAILED', 'INQUIRY_BLOCKED')),
	CONSTRAINT "marketplace_inquiry_events_role_valid" CHECK ("marketplace_inquiry_events"."actor_role" IN ('BUYER', 'SELLER', 'SYSTEM'))
);--> statement-breakpoint
CREATE INDEX "marketplace_inquiry_events_inquiry_idx" ON "marketplace_inquiry_events" ("inquiry_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_inquiry_events_message_type_unique" ON "marketplace_inquiry_events" ("message_id", "event_type") WHERE "marketplace_inquiry_events"."message_id" IS NOT NULL;
