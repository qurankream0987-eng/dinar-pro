-- D17 reuse: one derived summary per AI conversation, and the trigram index that keeps an
-- owner-scoped history search bounded. The summary is disposable: deleting the conversation or
-- its messages must not leave an authoritative-looking record behind.
CREATE TABLE "conversation_summaries" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"market_id" text NOT NULL,
	"summary" text NOT NULL,
	"topics" jsonb NOT NULL,
	"source_message_ids" jsonb NOT NULL,
	"watermark_at" timestamp with time zone NOT NULL,
	"message_count" integer NOT NULL,
	"derivation" text DEFAULT 'DETERMINISTIC_EXTRACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_summaries_length_check" CHECK ("conversation_summaries"."summary" <> '' AND char_length("conversation_summaries"."summary") <= 4000 AND "conversation_summaries"."message_count" >= 0),
	CONSTRAINT "conversation_summaries_derivation_check" CHECK ("conversation_summaries"."derivation" IN ('DETERMINISTIC_EXTRACTIVE'))
);
--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_summaries_owner_idx" ON "conversation_summaries" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "messages_body_trgm_idx" ON "messages" USING gin ("body" gin_trgm_ops);
