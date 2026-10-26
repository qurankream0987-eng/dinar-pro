CREATE TABLE "tutorial_learning_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"idempotency_key" text NOT NULL,
	"tutorial_id" text NOT NULL,
	"event_type" text NOT NULL,
	"milestone_percent" integer,
	"current_time_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tutorial_learning_events_type_check" CHECK ("tutorial_learning_events"."event_type" IN ('TUTORIAL_OPENED', 'PLAYBACK_STARTED', 'PLAYBACK_PROGRESS_MILESTONE', 'TEXT_FALLBACK_VIEWED', 'CONTINUATION_TRIGGERED')),
	CONSTRAINT "tutorial_learning_events_tutorial_check" CHECK ("tutorial_learning_events"."tutorial_id" IN ('SELL_FIRST_LISTING', 'PHOTO_FIRST_SELLING', 'PROMOTION_OVERVIEW', 'FEATURED_EXPLAINER', 'VIP_EXPLAINER', 'DEMAND_CAPTURE_EXPLAINER')),
	CONSTRAINT "tutorial_learning_events_milestone_check" CHECK (("tutorial_learning_events"."event_type" = 'PLAYBACK_PROGRESS_MILESTONE' AND "tutorial_learning_events"."milestone_percent" IN (25, 50, 75, 100)) OR ("tutorial_learning_events"."event_type" <> 'PLAYBACK_PROGRESS_MILESTONE' AND "tutorial_learning_events"."milestone_percent" IS NULL)),
	CONSTRAINT "tutorial_learning_events_time_check" CHECK ("tutorial_learning_events"."current_time_seconds" IS NULL OR "tutorial_learning_events"."current_time_seconds" BETWEEN 0 AND 3600)
);
CREATE UNIQUE INDEX "tutorial_learning_events_user_key_uq" ON "tutorial_learning_events" ("user_id", "idempotency_key");
CREATE INDEX "tutorial_learning_events_user_created_idx" ON "tutorial_learning_events" ("user_id", "created_at");
