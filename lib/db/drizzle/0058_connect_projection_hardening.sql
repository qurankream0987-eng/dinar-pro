-- Reconcile against the final header at commit, including ledger-only appends.
CREATE OR REPLACE FUNCTION connect_check_ledger_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE earned bigint; approved bigint; payable bigint; settled bigint; recovery bigint; ceiling bigint; current_state text;
BEGIN
 SELECT commission_ceiling_minor,state INTO ceiling,current_state FROM connect_transactions WHERE id=NEW.transaction_id;
 SELECT coalesce(sum(delta_minor) FILTER(WHERE bucket='EARNED'),0),coalesce(sum(delta_minor) FILTER(WHERE bucket='APPROVED'),0),coalesce(sum(delta_minor) FILTER(WHERE bucket='PAYABLE'),0),coalesce(sum(delta_minor) FILTER(WHERE bucket='SIMULATED_SETTLED'),0),coalesce(sum(delta_minor) FILTER(WHERE bucket='RECOVERY_DUE'),0)
 INTO earned,approved,payable,settled,recovery FROM connect_commission_ledger WHERE transaction_id=NEW.transaction_id;
 IF (current_state IN ('REVERSED','REJECTED','PENDING_VERIFICATION') AND earned<>0) OR (current_state='DISPUTED' AND payable<>0) OR earned<0 OR earned>ceiling OR approved<0 OR approved>earned OR payable<0 OR settled<0 OR recovery<0 OR recovery>settled OR payable+settled-recovery>approved
 THEN RAISE EXCEPTION 'External commission ledger does not reconcile' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION connect_check_transaction_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE earned bigint; header connect_transactions%ROWTYPE; BEGIN
 SELECT * INTO header FROM connect_transactions WHERE id=NEW.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT coalesce(sum(delta_minor) FILTER(WHERE bucket='EARNED'),0) INTO earned FROM connect_commission_ledger WHERE transaction_id=NEW.id;
 IF header.state='VERIFIED' AND NOT EXISTS(SELECT 1 FROM connect_commission_ledger WHERE transaction_id=NEW.id AND bucket='EARNED')
 THEN RAISE EXCEPTION 'Verified external transaction requires source-backed accrual evidence' USING ERRCODE='23514'; END IF;
 IF header.state='APPROVED' AND NOT EXISTS(SELECT 1 FROM connect_commission_ledger WHERE transaction_id=NEW.id AND bucket='APPROVED')
 THEN RAISE EXCEPTION 'Commission approval requires source-backed evidence' USING ERRCODE='23514'; END IF;
 IF header.state='PAYABLE' AND NOT EXISTS(SELECT 1 FROM connect_commission_ledger WHERE transaction_id=NEW.id AND bucket='PAYABLE' AND source_audit_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Payable commission requires a reviewed finance command' USING ERRCODE='23514'; END IF;
 IF header.state='SETTLED' AND NOT EXISTS(SELECT 1 FROM connect_commission_ledger WHERE transaction_id=NEW.id AND bucket='SIMULATED_SETTLED' AND source_audit_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Settlement state requires reconciled simulation evidence; no real money is implied' USING ERRCODE='23514'; END IF;
 IF header.state='REVERSED' AND earned<>0 THEN RAISE EXCEPTION 'Reversed commission must reconcile to zero earned' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
