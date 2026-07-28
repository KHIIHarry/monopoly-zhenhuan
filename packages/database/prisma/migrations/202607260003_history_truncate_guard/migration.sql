-- UPDATE and DELETE are already rejected by the append-only row triggers.
-- TRUNCATE needs statement-level triggers because it bypasses row triggers.
CREATE OR REPLACE FUNCTION reject_append_only_history_truncate()
RETURNS trigger AS $$
BEGIN
  IF RIGHT(current_database(), 5) <> '_test' THEN
    RAISE EXCEPTION '% is append-only and cannot be truncated', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "LedgerEntry_reject_truncate" ON "LedgerEntry";
CREATE TRIGGER "LedgerEntry_reject_truncate"
BEFORE TRUNCATE ON "LedgerEntry"
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_history_truncate();

DROP TRIGGER IF EXISTS "AuditLog_reject_truncate" ON "AuditLog";
CREATE TRIGGER "AuditLog_reject_truncate"
BEFORE TRUNCATE ON "AuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_history_truncate();
