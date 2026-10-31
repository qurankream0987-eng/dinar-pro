-- C1: index-backed necessary predicates and ordered, bounded cursor retrieval.
-- Arabic matching remains the canonical TypeScript authority, not a lossy SQL approximation.
CREATE INDEX offers_search_public_order_idx ON offers (market_id, status, created_at, id);
--> statement-breakpoint
CREATE INDEX offers_search_public_price_idx ON offers (market_id, status, unit_price_minor, created_at DESC, id);
--> statement-breakpoint
CREATE INDEX offers_search_owner_order_idx ON offers (market_id, seller_id, created_at, id);
--> statement-breakpoint
CREATE INDEX offers_search_category_idx ON offers (market_id, (data->'categoryId'), status);
--> statement-breakpoint
CREATE INDEX offers_search_legacy_category_idx ON offers (market_id, (data->'category'), status);
--> statement-breakpoint
-- JSON scalar/array conversion needed by Number(attribute) in the existing sort contract.
CREATE FUNCTION dinar_search_string(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE result text;
BEGIN
  IF value IS NULL OR value = 'null'::jsonb THEN RETURN ''; END IF;
  IF jsonb_typeof(value) = 'string' THEN RETURN value #>> '{}'; END IF;
  IF jsonb_typeof(value) = 'object' THEN RETURN '[object Object]'; END IF;
  IF jsonb_typeof(value) = 'array' THEN
    SELECT coalesce(string_agg(dinar_search_string(item), ',' ORDER BY ordinal), '') INTO result
    FROM jsonb_array_elements(value) WITH ORDINALITY AS element(item, ordinal);
    RETURN result;
  END IF;
  RETURN value::text;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION dinar_search_number(value jsonb) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE text_value text; base integer; digit integer; accumulator numeric := 0; result double precision; i integer;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  IF value = 'null'::jsonb THEN RETURN 0; END IF;
  IF value = 'true'::jsonb THEN RETURN 1; END IF;
  IF value = 'false'::jsonb THEN RETURN 0; END IF;
  text_value := btrim(dinar_search_string(value), E' \t\n\r\f\v' || chr(160) || chr(5760) ||
    chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) ||
    chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279));
  IF text_value = '' THEN RETURN 0; END IF;
  IF text_value ~* '^0(x[0-9a-f]+|b[01]+|o[0-7]+)$' THEN
    base := CASE lower(substr(text_value, 2, 1)) WHEN 'x' THEN 16 WHEN 'b' THEN 2 ELSE 8 END;
    FOR i IN 3..length(text_value) LOOP
      digit := strpos('0123456789abcdef', lower(substr(text_value, i, 1))) - 1;
      accumulator := accumulator * base + digit;
    END LOOP;
    result := accumulator::double precision;
  ELSIF text_value ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' THEN
    result := text_value::double precision;
  ELSE RETURN NULL;
  END IF;
  IF result IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8) THEN RETURN NULL; END IF;
  RETURN result;
EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN NULL;
END;
$$;
