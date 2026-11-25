CREATE TABLE "smart_store_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"conversation_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"card" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smart_store_cards_revision_valid" CHECK ("smart_store_cards"."revision" >= 1)
);--> statement-breakpoint
ALTER TABLE "smart_store_cards" ADD CONSTRAINT "smart_store_cards_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_store_cards" ADD CONSTRAINT "smart_store_cards_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_store_cards" ADD CONSTRAINT "smart_store_cards_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "smart_store_cards_owner_idx" ON "smart_store_cards" USING btree ("owner_user_id","created_at");
