UPDATE "Player" AS player
SET "status" = 'LEFT'
FROM "RoomMember" AS member
WHERE player."memberId" = member."id"
  AND player."status" = 'ACTIVE'
  AND member."status" <> 'ACTIVE';
