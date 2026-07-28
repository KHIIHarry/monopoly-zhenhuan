-- Physical deletion is the sole exception to append-only history. The
-- capability is bound to the active transaction, so it cannot leak to a
-- pooled connection or authorize a later delete.
CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('zhenhuan.physical_delete_txid', true)
       = pg_current_xact_id()::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AuditLog_append_only" ON "AuditLog";
CREATE TRIGGER "AuditLog_append_only"
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

CREATE OR REPLACE FUNCTION "reject_security_log_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('zhenhuan.physical_delete_txid', true)
       = pg_current_xact_id()::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SecurityLog is append-only';
END;
$$ LANGUAGE plpgsql;
