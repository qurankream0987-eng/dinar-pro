ALTER TABLE "offers" ALTER COLUMN "unit_price_minor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "pricing_mode" text DEFAULT 'FIXED' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_categories" ADD COLUMN "rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

UPDATE "marketplace_categories"
SET "attributes" = COALESCE(
  (
    SELECT jsonb_object_agg(entry.key, entry.value || '{"searchable":true,"filterable":true}'::jsonb)
    FROM jsonb_each("marketplace_categories"."attributes") AS entry
  ),
  '{}'::jsonb
),
"search_filters" = COALESCE(
  (
    SELECT jsonb_object_agg(entry.key, entry.value || '{"searchable":true,"filterable":true}'::jsonb)
    FROM jsonb_each("marketplace_categories"."search_filters") AS entry
  ),
  '{}'::jsonb
);--> statement-breakpoint

UPDATE "marketplace_categories"
SET "attributes" = jsonb_set(
  "attributes",
  '{condition}',
  '{"label":"الحالة","type":"string","operators":["eq","contains"],"requiredForPublish":false,"searchable":true,"filterable":true,"options":["جديد","مستعمل"]}'::jsonb,
  true
)
WHERE "id" IN ('electronics', 'fashion', 'home', 'other');--> statement-breakpoint

UPDATE "marketplace_categories"
SET "attributes" = jsonb_set(
  jsonb_set(
    jsonb_set("attributes", '{year,minimum}', '1900'::jsonb, true),
    '{year,maximum}',
    '2100'::jsonb,
    true
  ),
  '{mileage,minimum}',
  '0'::jsonb,
  true
)
WHERE "id" = 'cars';--> statement-breakpoint

UPDATE "marketplace_categories"
SET "attributes" = jsonb_set(
  jsonb_set(
    jsonb_set("attributes", '{bedrooms,minimum}', '0'::jsonb, true),
    '{bathrooms,minimum}',
    '0'::jsonb,
    true
  ),
  '{area,minimum}',
  '0'::jsonb,
  true
)
WHERE "id" = 'property';--> statement-breakpoint

UPDATE "marketplace_categories"
SET "rules" = jsonb_build_object(
  'display', jsonb_build_object('cardAttributes', '[]'::jsonb, 'detailAttributes', '[]'::jsonb),
  'sorting', jsonb_build_object(
    'defaultSort', 'NEWEST',
    'options', jsonb_build_array(
      jsonb_build_object('id', 'PRICE_ASC', 'label', 'السعر: الأقل أولًا', 'field', 'PRICE', 'direction', 'ASC'),
      jsonb_build_object('id', 'PRICE_DESC', 'label', 'السعر: الأعلى أولًا', 'field', 'PRICE', 'direction', 'DESC'),
      jsonb_build_object('id', 'NEWEST', 'label', 'الأحدث', 'field', 'CREATED_AT', 'direction', 'DESC')
    )
  ),
  'pricing', jsonb_build_object(
    'allowedModes', CASE WHEN "resource_type" = 'SERVICE' THEN '["FIXED","STARTING_FROM","QUOTE_REQUIRED"]'::jsonb ELSE '["FIXED"]'::jsonb END,
    'defaultMode', 'FIXED',
    'minAmountMinor', 1,
    'maxAmountMinor', 2000000000
  ),
  'inventory', CASE WHEN "resource_type" = 'SERVICE'
    THEN jsonb_build_object('semantics', 'NON_STOCK', 'allowedModes', '["UNLIMITED"]'::jsonb, 'defaultMode', 'UNLIMITED')
    ELSE jsonb_build_object('semantics', 'TRACKED', 'allowedModes', '["LIMITED","UNLIMITED"]'::jsonb, 'defaultMode', 'LIMITED', 'defaultQuantity', 1)
  END,
  'sellerDraft', jsonb_build_object(
    'requiredFields', CASE WHEN "resource_type" = 'SERVICE'
      THEN '["TITLE","DESCRIPTION","PRICE","ATTRIBUTES","FULFILMENT","LOCATION","CONTACT"]'::jsonb
      ELSE '["TITLE","DESCRIPTION","PRICE","ATTRIBUTES","INVENTORY","FULFILMENT","LOCATION","CONTACT"]'::jsonb
    END
  )
);--> statement-breakpoint

UPDATE "marketplace_categories"
SET "rules" = jsonb_set(
  jsonb_set(
    "rules",
    '{display,cardAttributes}',
    '["condition"]'::jsonb
  ),
  '{display,detailAttributes}',
  '["condition"]'::jsonb
)
WHERE "id" IN ('electronics', 'fashion', 'home', 'other');--> statement-breakpoint

UPDATE "marketplace_categories"
SET "rules" = jsonb_set(
  jsonb_set(
    jsonb_set(
      "rules",
      '{display,cardAttributes}',
      '["make","model","year","mileage"]'::jsonb
    ),
    '{display,detailAttributes}',
    '["make","model","year","mileage","transmission","fuel","condition","color"]'::jsonb
  ),
  '{inventory}',
  '{"semantics":"SINGLE","allowedModes":["LIMITED"],"defaultMode":"LIMITED","defaultQuantity":1}'::jsonb
)
WHERE "id" = 'cars';--> statement-breakpoint

UPDATE "marketplace_categories"
SET "rules" = jsonb_set(
  jsonb_set(
    jsonb_set(
      "rules",
      '{display,cardAttributes}',
      '["propertyType","transactionType","bedrooms","area"]'::jsonb
    ),
    '{display,detailAttributes}',
    '["propertyType","transactionType","bedrooms","bathrooms","area","district"]'::jsonb
  ),
  '{inventory}',
  '{"semantics":"SINGLE","allowedModes":["LIMITED"],"defaultMode":"LIMITED","defaultQuantity":1}'::jsonb
)
WHERE "id" = 'property';--> statement-breakpoint

UPDATE "marketplace_categories"
SET "rules" = jsonb_set(
  "rules",
  '{sorting,options}',
  (
    "rules" #> '{sorting,options}' ||
    jsonb_build_array(
      jsonb_build_object('id', 'YEAR_ASC', 'label', 'سنة الصنع: الأقدم أولًا', 'field', 'ATTRIBUTE', 'direction', 'ASC', 'attribute', 'year'),
      jsonb_build_object('id', 'YEAR_DESC', 'label', 'سنة الصنع: الأحدث أولًا', 'field', 'ATTRIBUTE', 'direction', 'DESC', 'attribute', 'year'),
      jsonb_build_object('id', 'MILEAGE_ASC', 'label', 'الممشى: الأقل أولًا', 'field', 'ATTRIBUTE', 'direction', 'ASC', 'attribute', 'mileage'),
      jsonb_build_object('id', 'MILEAGE_DESC', 'label', 'الممشى: الأعلى أولًا', 'field', 'ATTRIBUTE', 'direction', 'DESC', 'attribute', 'mileage')
    )
  )
)
WHERE "id" = 'cars';--> statement-breakpoint

UPDATE "marketplace_categories"
SET "rules" = jsonb_set(
  "rules",
  '{sorting,options}',
  (
    "rules" #> '{sorting,options}' ||
    jsonb_build_array(
      jsonb_build_object('id', 'PROPERTY_SIZE_ASC', 'label', 'المساحة: الأصغر أولًا', 'field', 'ATTRIBUTE', 'direction', 'ASC', 'attribute', 'area'),
      jsonb_build_object('id', 'PROPERTY_SIZE_DESC', 'label', 'المساحة: الأكبر أولًا', 'field', 'ATTRIBUTE', 'direction', 'DESC', 'attribute', 'area')
    )
  )
)
WHERE "id" = 'property';--> statement-breakpoint

ALTER TABLE "marketplace_categories" ALTER COLUMN "rules" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_pricing_valid" CHECK ((pricing_mode = 'QUOTE_REQUIRED' AND unit_price_minor IS NULL) OR (pricing_mode IN ('FIXED', 'STARTING_FROM') AND unit_price_minor >= 1));