-- Append-only correction: do not rewrite the already published 0041 migration.
-- 0042..0044 are reserved on Qoder; 0045 was checked unused before authoring.
CREATE OR REPLACE FUNCTION dinar_search_number(value jsonb) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE text_value text; base integer; digit integer; accumulator numeric := 0; result double precision; i integer;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  IF value = 'null'::jsonb THEN RETURN 0; END IF;
  IF value = 'true'::jsonb THEN RETURN 1; END IF;
  IF value = 'false'::jsonb THEN RETURN 0; END IF;
  text_value := btrim(dinar_search_string(value), E' \t\n\r\f' || chr(11) || chr(160) || chr(5760) ||
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
EXCEPTION
  WHEN numeric_value_out_of_range THEN
    -- strtod reports a finite underflow-to-zero as ERANGE; Number returns zero.
    -- Huge negative exponents can also exceed PostgreSQL numeric's scale limit.
    IF text_value ~ '[eE]-[0-9]+$' THEN
      IF substring(text_value from '[eE](-[0-9]+)$')::numeric < -length(text_value) - 400 THEN RETURN 0; END IF;
      BEGIN
        IF abs(text_value::numeric) < 1e-323::numeric THEN RETURN 0; END IF;
      EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN NULL;
      END;
    END IF;
    RETURN NULL;
  WHEN invalid_text_representation THEN RETURN NULL;
END;
$$;
