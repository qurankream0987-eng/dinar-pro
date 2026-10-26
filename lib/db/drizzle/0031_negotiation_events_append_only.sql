CREATE OR REPLACE FUNCTION negotiation_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'negotiation_events is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER negotiation_events_append_only_row
BEFORE UPDATE OR DELETE ON "negotiation_events"
FOR EACH ROW EXECUTE FUNCTION negotiation_events_append_only();
--> statement-breakpoint
CREATE TRIGGER negotiation_events_append_only_truncate
BEFORE TRUNCATE ON "negotiation_events"
FOR EACH STATEMENT EXECUTE FUNCTION negotiation_events_append_only();
