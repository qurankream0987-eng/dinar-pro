UPDATE "marketplace_categories"
SET
  "aliases" = CASE
    WHEN "aliases" ? 'جاكيت' THEN "aliases"
    ELSE "aliases" || '["جاكيت","معطف"]'::jsonb
  END,
  "attributes" = "attributes" || jsonb_build_object(
    'season', jsonb_build_object(
      'label', 'الموسم',
      'type', 'string',
      'operators', jsonb_build_array('eq', 'contains'),
      'options', jsonb_build_array('شتوي', 'شتوية', 'صيفي', 'صيفية'),
      'searchable', true,
      'filterable', true
    ),
    'audience', jsonb_build_object(
      'label', 'الفئة',
      'type', 'string',
      'operators', jsonb_build_array('eq', 'contains'),
      'options', jsonb_build_array('أطفال', 'نسائي', 'رجالي'),
      'searchable', true,
      'filterable', true
    )
  )
WHERE "id" = 'fashion';
