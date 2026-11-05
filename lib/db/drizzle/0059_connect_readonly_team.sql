-- Preserve existing mappings without inventing owner approval. Version zero is
-- deliberately inert; only an explicit owner confirmation captures a live D4 version.
ALTER TABLE connect_team_permissions ADD COLUMN delegation_version integer NOT NULL DEFAULT 0;
ALTER TABLE connect_team_permissions ADD CONSTRAINT connect_team_version_nonnegative CHECK (delegation_version >= 0);
ALTER TABLE connect_team_permissions ADD CONSTRAINT connect_team_confirmed_readonly CHECK (
  delegation_version = 0 OR (
    jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) BETWEEN 1 AND 2
    AND scopes <@ '["CATALOG_READ", "REPORTS_READ"]'::jsonb
  )
);
