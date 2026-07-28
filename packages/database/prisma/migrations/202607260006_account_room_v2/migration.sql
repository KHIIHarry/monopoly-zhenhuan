ALTER TYPE "RoomStatus" ADD VALUE IF NOT EXISTS 'FINISHED';

CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'LEFT');
CREATE TYPE "RoleSwapStatus" AS ENUM ('PENDING_TARGET', 'PENDING_BANK', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'CONFLICTED');

CREATE TABLE "Account" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
  "canCreateRoom" BOOLEAN NOT NULL DEFAULT false,
  "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoginAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Account_username_key" ON "Account"("username");

INSERT INTO "Account" ("id", "username", "passwordHash", "displayName", "status", "note")
VALUES ('legacy-system-account', 'legacy-system', 'disabled', '旧版迁移系统', 'DISABLED', 'V2 migration system account')
ON CONFLICT ("username") DO NOTHING;

INSERT INTO "Account" ("id", "username", "passwordHash", "displayName", "status", "note")
SELECT 'legacy-account-' || "id", 'legacy-' || "id", 'disabled', "displayName", 'DISABLED', 'Migrated from device-token identity'
FROM "RoomMember"
ON CONFLICT ("username") DO NOTHING;

CREATE TABLE "AccountSession" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "sessionTokenHash" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "deviceName" TEXT NOT NULL,
  "browser" TEXT NOT NULL,
  "operatingSystem" TEXT NOT NULL,
  "userAgent" TEXT NOT NULL,
  "loginIp" TEXT NOT NULL,
  "lastIp" TEXT NOT NULL,
  "ipRegion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" TEXT,
  CONSTRAINT "AccountSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountSession_sessionTokenHash_key" ON "AccountSession"("sessionTokenHash");
CREATE INDEX "AccountSession_accountId_revokedAt_expiresAt_idx" ON "AccountSession"("accountId", "revokedAt", "expiresAt");
ALTER TABLE "AccountSession" ADD CONSTRAINT "AccountSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Room"
  ADD COLUMN "createdByAccountId" TEXT,
  ADD COLUMN "passwordHash" TEXT,
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';

UPDATE "Room" SET "createdByAccountId" = 'legacy-system-account';
ALTER TABLE "Room" ALTER COLUMN "createdByAccountId" SET NOT NULL;
ALTER TABLE "Room" ADD CONSTRAINT "Room_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RoomMember"
  ADD COLUMN "accountId" TEXT,
  ADD COLUMN "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "characterId" TEXT,
  ADD COLUMN "activeSessionId" TEXT,
  ADD COLUMN "controlClaimedAt" TIMESTAMP(3),
  ADD COLUMN "leftAt" TIMESTAMP(3);

ALTER TABLE "RoomMember" ALTER COLUMN "deviceTokenHash" DROP NOT NULL;

UPDATE "RoomMember" SET
  "accountId" = 'legacy-account-' || "id",
  "status" = 'LEFT',
  "leftAt" = CURRENT_TIMESTAMP,
  "deviceTokenHash" = NULL,
  "onlineStatus" = 'OFFLINE';

UPDATE "RoomMember" AS member
SET "characterId" = player."characterId"
FROM "Player" AS player
WHERE player."memberId" = member."id";

ALTER TABLE "RoomMember" ALTER COLUMN "accountId" SET NOT NULL;
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_activeSessionId_fkey" FOREIGN KEY ("activeSessionId") REFERENCES "AccountSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "RoomMember_roomId_accountId_key" ON "RoomMember"("roomId", "accountId");
CREATE UNIQUE INDEX "RoomMember_roomId_characterId_key" ON "RoomMember"("roomId", "characterId");
CREATE INDEX "RoomMember_activeSessionId_idx" ON "RoomMember"("activeSessionId");
CREATE UNIQUE INDEX "RoomMember_one_active_bank_per_room" ON "RoomMember"("roomId") WHERE "role" = 'BANK' AND "status" = 'ACTIVE';

UPDATE "GameRequest" SET "status" = 'CANCELLED', "rejectionReason" = 'V2_IDENTITY_MIGRATION', "resolvedAt" = CURRENT_TIMESTAMP WHERE "status" = 'PENDING';
UPDATE "Turn" SET "status" = 'ENDED', "endedAt" = COALESCE("endedAt", CURRENT_TIMESTAMP) WHERE "status" = 'ACTIVE';

CREATE TABLE "RoleSwapRequest" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "requesterMembershipId" TEXT NOT NULL,
  "targetMembershipId" TEXT NOT NULL,
  "requesterCharacterId" TEXT,
  "targetCharacterId" TEXT NOT NULL,
  "status" "RoleSwapStatus" NOT NULL DEFAULT 'PENDING_TARGET',
  "bankApprovedById" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "RoleSwapRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RoleSwapRequest_roomId_status_createdAt_idx" ON "RoleSwapRequest"("roomId", "status", "createdAt");
ALTER TABLE "RoleSwapRequest" ADD CONSTRAINT "RoleSwapRequest_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleSwapRequest" ADD CONSTRAINT "RoleSwapRequest_requesterMembershipId_fkey" FOREIGN KEY ("requesterMembershipId") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoleSwapRequest" ADD CONSTRAINT "RoleSwapRequest_targetMembershipId_fkey" FOREIGN KEY ("targetMembershipId") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoleSwapRequest" ADD CONSTRAINT "RoleSwapRequest_bankApprovedById_fkey" FOREIGN KEY ("bankApprovedById") REFERENCES "RoomMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "GameSettlement" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "endedByAccountId" TEXT NOT NULL,
  "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "totalTurns" INTEGER NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "forced" BOOLEAN NOT NULL DEFAULT false,
  "forceReason" TEXT,
  "winnersJson" JSONB NOT NULL,
  "rankingJson" JSONB NOT NULL,
  CONSTRAINT "GameSettlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GameSettlement_roomId_key" ON "GameSettlement"("roomId");
ALTER TABLE "GameSettlement" ADD CONSTRAINT "GameSettlement_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameSettlement" ADD CONSTRAINT "GameSettlement_endedByAccountId_fkey" FOREIGN KEY ("endedByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SettlementPlayer" (
  "id" TEXT NOT NULL,
  "settlementId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "displayNameSnapshot" TEXT NOT NULL,
  "characterNameSnapshot" TEXT,
  "cash" INTEGER NOT NULL,
  "unmortgagedPropertyValue" INTEGER NOT NULL,
  "mortgagedPropertyNetValue" INTEGER NOT NULL,
  "buildingSellValue" INTEGER NOT NULL,
  "totalWealth" INTEGER NOT NULL,
  "rank" INTEGER NOT NULL,
  "isWinner" BOOLEAN NOT NULL,
  "propertyDetailsJson" JSONB NOT NULL,
  CONSTRAINT "SettlementPlayer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SettlementPlayer_settlementId_accountId_key" ON "SettlementPlayer"("settlementId", "accountId");
CREATE INDEX "SettlementPlayer_settlementId_rank_idx" ON "SettlementPlayer"("settlementId", "rank");
ALTER TABLE "SettlementPlayer" ADD CONSTRAINT "SettlementPlayer_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "GameSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SettlementPlayer" ADD CONSTRAINT "SettlementPlayer_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SecurityLog" (
  "id" TEXT NOT NULL,
  "accountId" TEXT,
  "actorAccountId" TEXT,
  "action" TEXT NOT NULL,
  "detailsJson" JSONB,
  "ip" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecurityLog_accountId_createdAt_idx" ON "SecurityLog"("accountId", "createdAt");
CREATE INDEX "SecurityLog_action_createdAt_idx" ON "SecurityLog"("action", "createdAt");
ALTER TABLE "SecurityLog" ADD CONSTRAINT "SecurityLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SecurityLog" ADD CONSTRAINT "SecurityLog_actorAccountId_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION zhenhuan_reject_settlement_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'settlement history is immutable';
END;
$$;

CREATE TRIGGER "GameSettlement_immutable_update_delete" BEFORE UPDATE OR DELETE ON "GameSettlement" FOR EACH ROW EXECUTE FUNCTION zhenhuan_reject_settlement_mutation();
CREATE TRIGGER "SettlementPlayer_immutable_update_delete" BEFORE UPDATE OR DELETE ON "SettlementPlayer" FOR EACH ROW EXECUTE FUNCTION zhenhuan_reject_settlement_mutation();
CREATE TRIGGER "GameSettlement_immutable_truncate" BEFORE TRUNCATE ON "GameSettlement" FOR EACH STATEMENT EXECUTE FUNCTION zhenhuan_reject_settlement_mutation();
CREATE TRIGGER "SettlementPlayer_immutable_truncate" BEFORE TRUNCATE ON "SettlementPlayer" FOR EACH STATEMENT EXECUTE FUNCTION zhenhuan_reject_settlement_mutation();
