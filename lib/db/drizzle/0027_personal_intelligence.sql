CREATE TABLE "personal_memories" (
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"parent" text,
	"value" text,
	"confidence" double precision NOT NULL,
	"signal_count" integer NOT NULL,
	"source_types" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"conversation_id" text,
	CONSTRAINT "personal_memories_user_id_topic_kind_pk" PRIMARY KEY("user_id","topic","kind"),
	CONSTRAINT "personal_memories_confidence_check" CHECK ("personal_memories"."confidence" BETWEEN 0 AND 1 AND "personal_memories"."signal_count" >= 0),
	CONSTRAINT "personal_memories_status_check" CHECK ("personal_memories"."status" IN ('ACTIVE', 'SUPPRESSED', 'FORGOTTEN')),
	CONSTRAINT "personal_memories_kind_check" CHECK ("personal_memories"."kind" IN ('SESSION_CONTEXT','EXPLICIT_PREFERENCES','INFERRED_INTERESTS','NEGATIVE_PREFERENCES','BEHAVIORAL_SIGNALS','LONG_TERM_FACTS','CONVERSATION_STYLE','RECENT_CONTEXT'))
);
--> statement-breakpoint
CREATE TABLE "personal_memory_controls" (
	"user_id" text NOT NULL,
	"control" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_memory_controls_user_id_control_pk" PRIMARY KEY("user_id","control")
);
--> statement-breakpoint
CREATE TABLE "personal_memory_events" (
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"topic" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "personal_memory_events_user_id_event_id_topic_kind_pk" PRIMARY KEY("user_id","event_id","topic","kind"),
	CONSTRAINT "personal_memory_events_source_check" CHECK ("personal_memory_events"."source" IN ('EXPLICIT_USER_STATEMENT','CONVERSATION','SEARCH','LISTING_VIEW','SAVE','PURCHASE','SELLER_ACTIVITY','REPEATED_TOPIC','USER_CORRECTION'))
);
--> statement-breakpoint
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_controls" ADD CONSTRAINT "personal_memory_controls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_memory_events" ADD CONSTRAINT "personal_memory_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_memories_user_recency_idx" ON "personal_memories" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "personal_memory_events_topic_idx" ON "personal_memory_events" USING btree ("user_id","topic");