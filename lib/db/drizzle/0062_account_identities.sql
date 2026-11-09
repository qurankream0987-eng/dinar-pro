-- DINAR external sign-in identities (additive, reviewed).
-- A Google account is linked to exactly one DINAR account and an account has at most one
-- Google identity. The link is created only after the DINAR phone verification succeeds:
-- an external identity never replaces phone ownership.
CREATE TABLE "account_identities" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "provider" text NOT NULL,
  "subject" text NOT NULL,
  "email" text,
  "email_verified" boolean DEFAULT false NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "account_identities_provider_valid" CHECK ("provider" IN ('GOOGLE')),
  CONSTRAINT "account_identities_subject_length" CHECK (char_length("subject") BETWEEN 1 AND 255),
  CONSTRAINT "account_identities_email_length" CHECK ("email" IS NULL OR char_length("email") <= 320)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_identities_provider_subject_unique" ON "account_identities" ("provider", "subject");
--> statement-breakpoint
CREATE UNIQUE INDEX "account_identities_user_provider_unique" ON "account_identities" ("user_id", "provider");
