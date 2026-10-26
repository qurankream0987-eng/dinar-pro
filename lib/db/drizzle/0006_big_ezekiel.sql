CREATE TABLE "ai_result_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"market_id" text NOT NULL,
	"message_id" text,
	"query" jsonb NOT NULL,
	"resource_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_ui_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"block_type" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "market_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "kind" text DEFAULT 'ORDER' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "title" text DEFAULT 'محادثة جديدة' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "actor" text DEFAULT 'USER' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "content_type" text DEFAULT 'TEXT' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "conversations" AS "conversation"
SET "owner_user_id" = "orders"."buyer_id",
    "market_id" = "orders"."market_id"
FROM "orders"
WHERE "conversation"."order_id" = "orders"."id";--> statement-breakpoint
ALTER TABLE "ai_result_sets" ADD CONSTRAINT "ai_result_sets_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_result_sets" ADD CONSTRAINT "ai_result_sets_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_result_sets" ADD CONSTRAINT "ai_result_sets_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_ui_blocks" ADD CONSTRAINT "ai_ui_blocks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_ui_blocks" ADD CONSTRAINT "ai_ui_blocks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_result_sets_conversation_idx" ON "ai_result_sets" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_ui_blocks_message_idx" ON "ai_ui_blocks" USING btree ("message_id","ordinal");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_owner_updated_idx" ON "conversations" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversations_market_updated_idx" ON "conversations" USING btree ("market_id","updated_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_shape_check" CHECK ((kind = 'ORDER' AND order_id IS NOT NULL) OR (kind = 'AI' AND order_id IS NULL AND owner_user_id IS NOT NULL AND market_id IS NOT NULL));