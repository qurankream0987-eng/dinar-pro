ALTER TABLE "connect_tools" ADD COLUMN "card_mapping" jsonb;--> statement-breakpoint
ALTER TABLE "connect_tools" ADD COLUMN "public_read" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connect_tools" DROP CONSTRAINT "connect_tools_valid";--> statement-breakpoint
ALTER TABLE "connect_tools" ADD CONSTRAINT "connect_tools_valid" CHECK ("connect_tools"."status" IN ('DISCOVERED','AUTHORIZED','REVOKED') AND "connect_tools"."access" IN ('READ','WRITE')
        AND "connect_tools"."capability" IN ('READ','SEARCH','DISCOVER','OBSERVE','TRACK','CREATE','UPDATE','DELETE','BOOK','SCHEDULE','MESSAGE','PAY','REFUND','CANCEL')
        AND ("connect_tools"."access" = 'WRITE') = ("connect_tools"."capability" IN ('CREATE','UPDATE','DELETE','BOOK','SCHEDULE','MESSAGE','PAY','REFUND','CANCEL'))
        AND ("connect_tools"."status" <> 'AUTHORIZED' OR ("connect_tools"."authorized_by" IS NOT NULL AND "connect_tools"."authorized_at" IS NOT NULL))
        AND "connect_tools"."input_schema_sha256" ~ '^[0-9a-f]{64}$'
        AND (NOT "connect_tools"."public_read" OR "connect_tools"."access" = 'READ'));
