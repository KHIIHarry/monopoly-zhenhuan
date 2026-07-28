-- Preserve strict replay semantics for newly written idempotent operations.
ALTER TABLE "GameRequest" ADD COLUMN IF NOT EXISTS "requestHash" TEXT;
ALTER TABLE "IdempotencyRecord" ADD COLUMN IF NOT EXISTS "requestHash" TEXT;

-- Apply append-only history and strict dice checks to databases created by the
-- earlier version of the initial migration. The statements are also safe after
-- a fresh install that already contains these definitions.
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_roomId_fkey";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_roomId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Turn" DROP CONSTRAINT IF EXISTS "Turn_dice_check";
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_dice_check" CHECK (
  ("die1" IS NULL AND "die2" IS NULL AND "diceValue" IS NULL)
  OR (
    "die1" IS NOT NULL AND
    "die2" IS NOT NULL AND
    "diceValue" IS NOT NULL AND
    "die1" BETWEEN 1 AND 6 AND
    "die2" BETWEEN 1 AND 6 AND
    "diceValue" = "die1" + "die2"
  )
);

CREATE OR REPLACE FUNCTION reject_append_only_history_change()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "LedgerEntry_append_only" ON "LedgerEntry";
CREATE TRIGGER "LedgerEntry_append_only"
BEFORE UPDATE OR DELETE ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION reject_append_only_history_change();

DROP TRIGGER IF EXISTS "AuditLog_append_only" ON "AuditLog";
CREATE TRIGGER "AuditLog_append_only"
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION reject_append_only_history_change();
