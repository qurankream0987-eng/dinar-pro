ALTER TABLE "business_subscriptions" ADD COLUMN "provider_key" text;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD COLUMN "provider_subscription_id" text;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD COLUMN "provider_checkout_id" text;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD COLUMN "renewal_reminder_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_subscriptions_provider_subscription_unique" ON "business_subscriptions" USING btree ("provider_key","provider_subscription_id") WHERE "business_subscriptions"."provider_subscription_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_provider_link" CHECK ("business_subscriptions"."provider_subscription_id" IS NULL OR "business_subscriptions"."provider_key" IS NOT NULL);
