-- Technical readiness is recorded separately from legal approval. Nothing here records, infers or
-- implies a legal review, counsel signature, owner approval or activation: every intake row seeded
-- below starts empty (NOT_REVIEWED / BLOCKED / NOT_RUN) and every topic starts unreviewed.
CREATE TABLE "market_technical_readiness" (
	"market_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'NOT_VERIFIED' NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_technical_readiness_status_check" CHECK ("status" IN ('NOT_VERIFIED', 'READY', 'NOT_READY')),
	CONSTRAINT "market_technical_readiness_ready_verified" CHECK ("status" <> 'READY' OR ("verified_at" IS NOT NULL AND "verified_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "market_technical_readiness" ADD CONSTRAINT "market_technical_readiness_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_technical_readiness" ADD CONSTRAINT "market_technical_readiness_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Palestine was seeded with EGP; its circulating currency is ILS. Only an unpriced, inactive row changes.
UPDATE "markets" SET "currency_code" = 'ILS', "currency_symbol_ar" = '₪', "minor_unit_scale" = 2, "updated_at" = now()
WHERE "id" = 'PS' AND "currency_code" = 'EGP' AND "unit_price_minor" IS NULL AND NOT "is_active";
--> statement-breakpoint
-- Arabic currency symbols, only where the row still shows the bare ISO code.
UPDATE "markets" m SET "currency_symbol_ar" = s."symbol", "updated_at" = now()
FROM (VALUES
  ('AE','د.إ'),('BH','د.ب'),('DZ','د.ج'),('EG','ج.م'),('IQ','د.ع'),('JO','د.أ'),('KM','ف.ق'),
  ('DJ','ف.ج'),('KW','د.ك'),('LB','ل.ل'),('LY','د.ل'),('MA','د.م'),('MR','أ.م'),('OM','ر.ع'),
  ('QA','ر.ق'),('SA','ر.س'),('SO','ش.ص'),('SD','ج.س'),('SY','ل.س'),('TN','د.ت'),('YE','ر.ي')
) AS s("id", "symbol")
WHERE m."id" = s."id" AND m."currency_symbol_ar" = m."currency_code";
--> statement-breakpoint
-- Empty legal intake packages for every Arab League market, so the owner can add documents later
-- without rebuilding the market. ON CONFLICT keeps JO/KW/SA packages (and any progress) untouched.
INSERT INTO "market_legal_intakes" ("id", "market_id")
SELECT 'd16-intake-' || m."id", m."id"
FROM "markets" m
WHERE m."id" IN ('AE','BH','DZ','EG','IQ','JO','KM','DJ','KW','LB','LY','MA','MR','OM','PS','QA','SA','SO','SD','SY','TN','YE')
ON CONFLICT ("market_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "market_legal_intake_topics" ("id", "intake_id", "topic_key")
SELECT 'd16-topic-' || i."market_id" || '-' || topic."topic_key", i."id", topic."topic_key"
FROM "market_legal_intakes" i
CROSS JOIN (VALUES
  ('OPERATING_ENTITY'),('MARKETPLACE_RULES'),('SELLER_ELIGIBILITY'),('BUSINESS_KYC'),
  ('CONSUMER_PROTECTION'),('FEES_AND_TAX'),('PAYMENTS'),('DELIVERY_LOGISTICS'),('PERSONAL_DATA'),
  ('EXTERNAL_AI'),('MINORS_RESTRICTED_GOODS_ADVERTISING'),('IP_COMPLAINTS_DISPUTES'),
  ('INCIDENT_NOTIFICATION'),('POLICY_VERSIONS'),('OFFICIAL_REFERENCES'),('COUNSEL_FINDINGS')
) AS topic("topic_key")
WHERE i."market_id" IN ('AE','BH','DZ','EG','IQ','JO','KM','DJ','KW','LB','LY','MA','MR','OM','PS','QA','SA','SO','SD','SY','TN','YE')
ON CONFLICT ("intake_id", "topic_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "market_technical_readiness" ("market_id")
SELECT m."id" FROM "markets" m
WHERE m."id" IN ('AE','BH','DZ','EG','IQ','JO','KM','DJ','KW','LB','LY','MA','MR','OM','PS','QA','SA','SO','SD','SY','TN','YE')
ON CONFLICT ("market_id") DO NOTHING;
