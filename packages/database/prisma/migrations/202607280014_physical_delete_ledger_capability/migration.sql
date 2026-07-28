-- A transaction explicitly authorized for physical deletion may remove only
-- the target room's immutable ledger rows. Every other ledger update/delete
-- remains blocked by the append-only boundary.
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

DROP TRIGGER IF EXISTS "LedgerEntry_append_only" ON "LedgerEntry";
CREATE TRIGGER "LedgerEntry_append_only"
BEFORE UPDATE OR DELETE ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION reject_ledger_entry_mutation();
