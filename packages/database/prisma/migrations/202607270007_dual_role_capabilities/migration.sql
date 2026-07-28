ALTER TABLE "RoomMember"
  ADD COLUMN "isBank" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Room" SET "status" = 'FINISHED', "currentTurnPlayerId" = NULL WHERE "status" IN ('LOBBY', 'PLAYING', 'ENDED');

UPDATE "RoomMember" SET "isBank" = true WHERE "role" = 'BANK';

DROP INDEX IF EXISTS "RoomMember_one_active_bank_per_room";
DROP INDEX IF EXISTS "RoomMember_roomId_role_idx";
DROP INDEX IF EXISTS "RoomMember_deviceTokenHash_key";

ALTER TABLE "RoomMember"
  DROP COLUMN "role",
  DROP COLUMN "deviceTokenHash",
  DROP COLUMN "onlineStatus",
  DROP COLUMN "bankControlGrantedAt",
  DROP COLUMN "lastSeenAt";

DROP TYPE "OnlineStatus";

CREATE UNIQUE INDEX "RoomMember_one_active_bank_per_room" ON "RoomMember"("roomId") WHERE "isBank" = true AND "status" = 'ACTIVE';
