ALTER TABLE "Room"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAfter" TIMESTAMP(3),
  ADD COLUMN "deletedByAccountId" TEXT;

CREATE INDEX "Room_deletedAt_purgeAfter_idx"
  ON "Room"("deletedAt", "purgeAfter");

ALTER TABLE "Room" ADD CONSTRAINT "Room_deletedByAccountId_fkey"
  FOREIGN KEY ("deletedByAccountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION reject_ledger_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('zhenhuan.physical_delete_txid', true)
       = pg_current_xact_id()::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'LedgerEntry is append-only';
END;
$$ LANGUAGE plpgsql;

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

CREATE OR REPLACE FUNCTION reject_security_log_mutation()
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

CREATE OR REPLACE FUNCTION zhenhuan_reject_settlement_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('zhenhuan.physical_delete_txid', true)
       = pg_current_xact_id()::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'settlement history is immutable';
END;
$$ LANGUAGE plpgsql;
