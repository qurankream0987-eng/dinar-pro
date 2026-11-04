-- D16: incident rows cannot be created without their opening audit event, and closed records
-- cannot be rewritten or deleted outside the transition service.
CREATE FUNCTION d16_reject_closed_incident_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'Closed security incidents are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER security_incidents_closed_immutable
BEFORE UPDATE OR DELETE ON security_incidents
FOR EACH ROW EXECUTE FUNCTION d16_reject_closed_incident_mutation();
--> statement-breakpoint
CREATE FUNCTION d16_require_incident_opened_event() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM security_incident_events
    WHERE incident_id = NEW.id
      AND event_type = 'OPENED'
      AND from_status IS NULL
      AND to_status = 'OPEN'
      AND actor_id = NEW.opened_by
  ) THEN
    RAISE EXCEPTION 'Security incident requires a matching OPENED audit event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER security_incidents_opened_event_required
AFTER INSERT ON security_incidents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION d16_require_incident_opened_event();
