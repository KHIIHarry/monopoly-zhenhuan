DROP INDEX IF EXISTS "Player_roomId_pawnColor_key";
DROP INDEX IF EXISTS "Player_roomId_turnOrder_key";

CREATE UNIQUE INDEX "Player_roomId_pawnColor_active_character_key"
ON "Player"("roomId", "pawnColor")
WHERE "status" = 'ACTIVE' AND "characterId" IS NOT NULL;

CREATE UNIQUE INDEX "Player_roomId_turnOrder_active_character_key"
ON "Player"("roomId", "turnOrder")
WHERE "status" = 'ACTIVE' AND "characterId" IS NOT NULL;
