-- Bind test cleanup authority to one PostgreSQL transaction. A session-level
-- setting left behind in a pooled connection cannot authorize a later command.
CREATE OR REPLACE FUNCTION reject_append_only_history_truncate()
RETURNS trigger AS $$
BEGIN
  IF RIGHT(current_database(), 5) <> '_test'
     OR current_setting('zhenhuan.history_truncate_txid', true)
        IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION '% is append-only and cannot be truncated', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
