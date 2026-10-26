CREATE TABLE "marketplace_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"label" text NOT NULL,
	"label_en" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource_type" text DEFAULT 'PRODUCT' NOT NULL,
	"renderer" text DEFAULT 'GENERIC' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allow_additional_attributes" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_categories_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE INDEX "marketplace_categories_parent_idx" ON "marketplace_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "marketplace_categories_active_idx" ON "marketplace_categories" USING btree ("is_active");--> statement-breakpoint
INSERT INTO "marketplace_categories" (
	"id", "label", "label_en", "aliases", "resource_type", "renderer",
	"attributes", "search_filters", "allow_additional_attributes", "is_active"
) VALUES
(
	'electronics', 'إلكترونيات', 'Electronics', '["إلكترونيات","الكترونيات","هاتف","كمبيوتر","جوال","electronics"]'::jsonb,
	'PRODUCT', 'GENERIC', '{}'::jsonb, '{}'::jsonb, true, true
),
(
	'fashion', 'أزياء', 'Fashion', '["أزياء","ملابس","فستان","قميص","تيشيرت","fashion","clothing"]'::jsonb,
	'PRODUCT', 'GENERIC', '{}'::jsonb, '{}'::jsonb, true, true
),
(
	'services', 'خدمات', 'Services', '["خدمات","خدمة","تنظيف","صيانة","service","services"]'::jsonb,
	'SERVICE', 'GENERIC', '{}'::jsonb, '{}'::jsonb, true, true
),
(
	'home', 'منزل', 'Home & Living', '["منزل","أثاث","كنب","مصباح","home","furniture"]'::jsonb,
	'PRODUCT', 'GENERIC', '{}'::jsonb, '{}'::jsonb, true, true
),
(
	'digital-services', 'خدمات رقمية', 'Digital Services', '["خدمات رقمية","رقمي","تصميم","برمجة","digital services"]'::jsonb,
	'SERVICE', 'GENERIC', '{}'::jsonb, '{}'::jsonb, true, true
),
(
	'cars', 'سيارات', 'Cars', '["سيارة","سيارات","مركبة","مركبات","car","cars"]'::jsonb,
	'PRODUCT', 'CAR',
	'{"make":{"label":"الشركة المصنّعة","type":"string","operators":["eq","contains"],"requiredForPublish":true},"model":{"label":"الطراز","type":"string","operators":["eq","contains"],"requiredForPublish":true},"year":{"label":"سنة الصنع","type":"number","operators":["eq","gt","gte","lt","lte"],"requiredForPublish":true},"mileage":{"label":"الممشى (كم)","type":"number","operators":["eq","gt","gte","lt","lte"]},"transmission":{"label":"ناقل الحركة","type":"string","operators":["eq","contains"],"options":["أوتوماتيك","يدوي"]},"fuel":{"label":"الوقود","type":"string","operators":["eq","contains"],"options":["بنزين","ديزل","كهرباء","هجين"]},"condition":{"label":"الحالة","type":"string","operators":["eq","contains"],"requiredForPublish":true,"options":["جديد","مستعمل"]},"color":{"label":"اللون","type":"string","operators":["eq","contains"]}}'::jsonb,
	'{"price":{"label":"السعر","type":"number","operators":["gt","gte","lt","lte","eq"]},"city":{"label":"المدينة","type":"string","operators":["eq","contains"]},"area":{"label":"المنطقة","type":"string","operators":["eq","contains"]}}'::jsonb,
	false, true
),
(
	'property', 'عقارات', 'Property', '["عقار","عقارات","شقة","شقق","بيت","منزل","property","apartment"]'::jsonb,
	'PRODUCT', 'PROPERTY',
	'{"propertyType":{"label":"نوع العقار","type":"string","operators":["eq","contains"],"requiredForPublish":true},"transactionType":{"label":"نوع المعاملة","type":"string","operators":["eq","contains"],"requiredForPublish":true},"bedrooms":{"label":"غرف النوم","type":"number","operators":["eq","gt","gte","lt","lte"]},"bathrooms":{"label":"الحمامات","type":"number","operators":["eq","gt","gte","lt","lte"]},"area":{"label":"المساحة","type":"number","operators":["eq","gt","gte","lt","lte"]},"district":{"label":"الحي","type":"string","operators":["eq","contains"]}}'::jsonb,
	'{"price":{"label":"السعر","type":"number","operators":["gt","gte","lt","lte","eq"]},"city":{"label":"المدينة","type":"string","operators":["eq","contains"]}}'::jsonb,
	false, true
),
(
	'other', 'أخرى', 'Other', '["أخرى","عام","منتج آخر","خدمة أخرى","other","miscellaneous"]'::jsonb,
	'MIXED', 'GENERIC', '{}'::jsonb, '{}'::jsonb, true, true
);