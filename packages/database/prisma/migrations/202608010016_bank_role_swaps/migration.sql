CREATE TYPE "RoleSwapKind" AS ENUM ('CHARACTER', 'BANK');

ALTER TABLE "RoleSwapRequest"
  ADD COLUMN "kind" "RoleSwapKind" NOT NULL DEFAULT 'CHARACTER',
  ALTER COLUMN "targetCharacterId" DROP NOT NULL;

UPDATE "RoleSwapRequest" AS request
SET
  "status" = 'CANCELLED',
  "rejectionReason" = 'ROLE_SWAP_LOBBY_ONLY',
  "resolvedAt" = CURRENT_TIMESTAMP
FROM "Room" AS room
WHERE request."roomId" = room."id"
  AND room."status" <> 'LOBBY'
  AND request."status" = 'PENDING_BANK';
