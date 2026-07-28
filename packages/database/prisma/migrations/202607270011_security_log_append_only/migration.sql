CREATE OR REPLACE FUNCTION "reject_security_log_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SecurityLog is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SecurityLog_append_only"
BEFORE UPDATE OR DELETE ON "SecurityLog"
FOR EACH ROW EXECUTE FUNCTION "reject_security_log_mutation"();

CREATE TRIGGER "SecurityLog_reject_truncate"
BEFORE TRUNCATE ON "SecurityLog"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_security_log_mutation"();

CREATE INDEX "SecurityLog_actorAccountId_createdAt_id_idx"
ON "SecurityLog"("actorAccountId", "createdAt", "id");
