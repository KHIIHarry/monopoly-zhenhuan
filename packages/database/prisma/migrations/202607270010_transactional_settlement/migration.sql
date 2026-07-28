ALTER TABLE "Room"
  ADD COLUMN "startedAt" TIMESTAMP(3);

UPDATE "Room"
SET "startedAt" = "createdAt"
WHERE "status" = 'PLAYING' AND "startedAt" IS NULL;

UPDATE "Room" AS room
SET "status" = 'ENDED', "currentTurnPlayerId" = NULL
WHERE room."status" = 'FINISHED'
  AND NOT EXISTS (
    SELECT 1 FROM "GameSettlement" AS settlement
    WHERE settlement."roomId" = room."id"
  );

ALTER TABLE "GameSettlement"
  ADD COLUMN "overriddenBlockersJson" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION zhenhuan_reject_post_finalization_settlement_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "RoomStatus";
BEGIN
  SELECT "status" INTO parent_status FROM "Room" WHERE "id" = NEW."roomId";
  IF parent_status IN ('FINISHED', 'CLOSED') THEN
    RAISE EXCEPTION 'settlement history is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "GameSettlement_reject_post_finalization_insert"
BEFORE INSERT ON "GameSettlement"
FOR EACH ROW EXECUTE FUNCTION zhenhuan_reject_post_finalization_settlement_insert();

CREATE OR REPLACE FUNCTION zhenhuan_reject_post_finalization_player_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "RoomStatus";
BEGIN
  SELECT room."status" INTO parent_status
  FROM "GameSettlement" AS settlement
  JOIN "Room" AS room ON room."id" = settlement."roomId"
  WHERE settlement."id" = NEW."settlementId";
  IF parent_status IN ('FINISHED', 'CLOSED') THEN
    RAISE EXCEPTION 'settlement history is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SettlementPlayer_reject_post_finalization_insert"
BEFORE INSERT ON "SettlementPlayer"
FOR EACH ROW EXECUTE FUNCTION zhenhuan_reject_post_finalization_player_insert();

CREATE OR REPLACE FUNCTION zhenhuan_guard_settled_room_terminal_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('FINISHED', 'CLOSED')
    AND NEW."status" IS DISTINCT FROM OLD."status"
    AND EXISTS (SELECT 1 FROM "GameSettlement" WHERE "roomId" = OLD."id") THEN
    RAISE EXCEPTION 'settled room terminal status is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Room_settlement_terminal_guard"
BEFORE UPDATE ON "Room"
FOR EACH ROW EXECUTE FUNCTION zhenhuan_guard_settled_room_terminal_status();
