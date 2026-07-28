-- Test cleanup requires both an isolated `_test` database and an explicit,
-- transaction-local capability. A database name alone must never disable the
-- append-only history boundary.
CREATE OR REPLACE FUNCTION reject_append_only_history_truncate()
RETURNS trigger AS $$
BEGIN
  IF RIGHT(current_database(), 5) <> '_test'
     OR current_setting('zhenhuan.allow_history_truncate', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION '% is append-only and cannot be truncated', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
