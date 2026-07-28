-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('LOBBY', 'PLAYING', 'ENDED', 'CLOSED');
CREATE TYPE "RuleProfile" AS ENUM ('STANDARD', 'CUSTOM');
CREATE TYPE "Difficulty" AS ENUM ('SIMPLE', 'NIGHTMARE', 'HELL', 'CUSTOM');
CREATE TYPE "BankMode" AS ENUM ('SHARED_SELF_SERVICE', 'DESIGNATED_PARTICIPANT', 'DEDICATED_MODERATOR');
CREATE TYPE "CharacterAssignmentMode" AS ENUM ('RANDOM', 'PLAYER_SELECT');
CREATE TYPE "StoryMoneyCounterpartyMode" AS ENUM ('TREASURY', 'CURRENT_PROPERTY_OWNER');
CREATE TYPE "Role" AS ENUM ('PLAYER', 'BANK', 'ADMIN');
CREATE TYPE "OnlineStatus" AS ENUM ('ONLINE', 'OFFLINE');
CREATE TYPE "DiceMode" AS ENUM ('ELECTRONIC', 'PHYSICAL');
CREATE TYPE "VictoryMode" AS ENUM ('LAST_SOLVENT', 'TIME_LIMIT', 'ASSET_TARGET', 'CUSTOM');
CREATE TYPE "AssetValuationPolicy" AS ENUM ('LIQUIDATION_VALUE', 'CUSTOM');
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXECUTED', 'REVERSED');
CREATE TYPE "TransactionStatus" AS ENUM ('COMMITTED', 'REVERSED');
CREATE TYPE "PlayerStatus" AS ENUM ('ACTIVE', 'BANKRUPT', 'LEFT');
CREATE TYPE "TurnStatus" AS ENUM ('ACTIVE', 'ENDED', 'INVALIDATED');
CREATE TYPE "LandingSpaceType" AS ENUM ('PROPERTY', 'START', 'PLOT', 'COMPANION', 'COLD_PALACE', 'OTHER');
CREATE TYPE "LandingEventStatus" AS ENUM ('DECLARED', 'CONFIRMED', 'INVALIDATED');
CREATE TYPE "DebtCreditorType" AS ENUM ('TREASURY', 'PLAYER');
CREATE TYPE "DebtStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'SETTLED', 'WRITTEN_OFF');

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'LOBBY',
    "ruleProfile" "RuleProfile" NOT NULL DEFAULT 'STANDARD',
    "difficulty" "Difficulty" NOT NULL DEFAULT 'SIMPLE',
    "participantCount" INTEGER NOT NULL,
    "playerLimit" INTEGER NOT NULL DEFAULT 5,
    "bankMode" "BankMode" NOT NULL DEFAULT 'SHARED_SELF_SERVICE',
    "characterAssignmentMode" "CharacterAssignmentMode" NOT NULL DEFAULT 'RANDOM',
    "initialBalance" INTEGER NOT NULL,
    "diceMode" "DiceMode" NOT NULL DEFAULT 'ELECTRONIC',
    "skillEnabled" BOOLEAN NOT NULL DEFAULT false,
    "storyMoneyCounterpartyMode" "StoryMoneyCounterpartyMode" NOT NULL,
    "transferApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "criticalActionApprovalRequired" BOOLEAN NOT NULL DEFAULT true,
    "autoSkipTurn" BOOLEAN NOT NULL DEFAULT true,
    "bankUndoAllowed" BOOLEAN NOT NULL DEFAULT true,
    "showTotalAssets" BOOLEAN NOT NULL DEFAULT true,
    "startReward" INTEGER NOT NULL DEFAULT 1000,
    "redemptionFee" INTEGER NOT NULL DEFAULT 200,
    "victoryMode" "VictoryMode" NOT NULL,
    "scheduledEndAt" TIMESTAMP(3),
    "assetTarget" INTEGER,
    "customVictoryRule" TEXT,
    "assetValuationPolicy" "AssetValuationPolicy" NOT NULL DEFAULT 'LIQUIDATION_VALUE',
    "currentTurnPlayerId" TEXT,
    "turnNumber" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "allowMidgameJoin" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Room_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Room_participantCount_check" CHECK ("participantCount" BETWEEN 2 AND 6),
    CONSTRAINT "Room_playerLimit_check" CHECK ("playerLimit" BETWEEN 2 AND 6),
    CONSTRAINT "Room_money_check" CHECK ("initialBalance" >= 0 AND "startReward" >= 0 AND "redemptionFee" >= 0),
    CONSTRAINT "Room_turnNumber_check" CHECK ("turnNumber" IS NULL OR "turnNumber" > 0),
    CONSTRAINT "Room_assetTarget_check" CHECK ("assetTarget" IS NULL OR "assetTarget" >= 0)
);

-- CreateTable
CREATE TABLE "RoomMember" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "bankControlGrantedAt" TIMESTAMP(3),
    "displayName" TEXT NOT NULL,
    "deviceTokenHash" TEXT NOT NULL,
    "onlineStatus" "OnlineStatus" NOT NULL DEFAULT 'ONLINE',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoomMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "characterId" TEXT,
    "pawnColor" TEXT NOT NULL,
    "balance" INTEGER NOT NULL,
    "status" "PlayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "turnOrder" INTEGER,
    "remainingSkipTurns" INTEGER NOT NULL DEFAULT 0,
    "partnerCardCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Player_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Player_balance_check" CHECK ("balance" >= 0),
    CONSTRAINT "Player_turnOrder_check" CHECK ("turnOrder" IS NULL OR "turnOrder" > 0),
    CONSTRAINT "Player_remainingSkipTurns_check" CHECK ("remainingSkipTurns" >= 0),
    CONSTRAINT "Player_partnerCardCount_check" CHECK ("partnerCardCount" BETWEEN 0 AND 3),
    CONSTRAINT "Player_version_check" CHECK ("version" >= 0)
);

-- CreateTable
CREATE TABLE "PropertyDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "mortgagePrice" INTEGER NOT NULL,
    "purchasePrice" INTEGER NOT NULL,
    "buildCost" INTEGER NOT NULL,
    "buildingSellPrice" INTEGER NOT NULL,
    "tollEmpty" INTEGER NOT NULL,
    "tollLevel1" INTEGER NOT NULL,
    "tollLevel2" INTEGER NOT NULL,
    "tollLevel3" INTEGER NOT NULL,
    "tollLevel4" INTEGER NOT NULL,
    "tollPalace" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "PropertyDefinition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PropertyDefinition_displayOrder_check" CHECK ("displayOrder" > 0),
    CONSTRAINT "PropertyDefinition_prices_check" CHECK (
        "mortgagePrice" >= 0 AND "purchasePrice" >= 0 AND "buildCost" >= 0 AND "buildingSellPrice" >= 0
    ),
    CONSTRAINT "PropertyDefinition_tolls_check" CHECK (
        "tollEmpty" >= 0 AND "tollLevel1" >= 0 AND "tollLevel2" >= 0 AND
        "tollLevel3" >= 0 AND "tollLevel4" >= 0 AND "tollPalace" >= 0
    )
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initialPropertyId" TEXT NOT NULL,
    "skillCode" TEXT NOT NULL,
    "skillConfig" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomProperty" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "propertyDefinitionId" TEXT NOT NULL,
    "ownerPlayerId" TEXT,
    "buildingLevel" INTEGER NOT NULL DEFAULT 0,
    "mortgaged" BOOLEAN NOT NULL DEFAULT false,
    "lockedByRequestId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "RoomProperty_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RoomProperty_buildingLevel_check" CHECK ("buildingLevel" BETWEEN 0 AND 5),
    CONSTRAINT "RoomProperty_version_check" CHECK ("version" >= 0),
    CONSTRAINT "RoomProperty_mortgage_check" CHECK (NOT "mortgaged" OR "buildingLevel" = 0),
    CONSTRAINT "RoomProperty_owner_check" CHECK ("ownerPlayerId" IS NOT NULL OR ("buildingLevel" = 0 AND NOT "mortgaged"))
);

-- CreateTable
CREATE TABLE "GameRequest" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "actorPlayerId" TEXT,
    "targetPlayerId" TEXT,
    "propertyId" TEXT,
    "landingEventId" TEXT,
    "turnId" TEXT,
    "amount" INTEGER,
    "quantity" INTEGER,
    "note" TEXT,
    "payload" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "approvedByMemberId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "GameRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GameRequest_quantity_check" CHECK ("quantity" IS NULL OR "quantity" >= 0)
);

-- CreateTable
CREATE TABLE "GameTransaction" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'COMMITTED',
    "requestId" TEXT,
    "reversible" BOOLEAN NOT NULL DEFAULT true,
    "reversedByTransactionId" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LedgerEntry_balance_check" CHECK (
        "balanceBefore" >= 0 AND "balanceAfter" >= 0 AND "balanceAfter" = "balanceBefore" + "amount"
    )
);

-- CreateTable
CREATE TABLE "Turn" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "turnNumber" INTEGER NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" "TurnStatus" NOT NULL DEFAULT 'ACTIVE',
    "die1" INTEGER,
    "die2" INTEGER,
    "diceValue" INTEGER,
    "rolledAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    CONSTRAINT "Turn_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Turn_turnNumber_check" CHECK ("turnNumber" > 0),
    CONSTRAINT "Turn_dice_check" CHECK (
        ("die1" IS NULL AND "die2" IS NULL AND "diceValue" IS NULL) OR
        (
            "die1" IS NOT NULL AND "die2" IS NOT NULL AND "diceValue" IS NOT NULL AND
            "die1" BETWEEN 1 AND 6 AND "die2" BETWEEN 1 AND 6 AND "diceValue" = "die1" + "die2"
        )
    )
);

-- CreateTable
CREATE TABLE "LandingEvent" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "turnId" TEXT,
    "playerId" TEXT NOT NULL,
    "spaceType" "LandingSpaceType" NOT NULL,
    "propertyId" TEXT,
    "status" "LandingEventStatus" NOT NULL DEFAULT 'DECLARED',
    "plotResolved" BOOLEAN NOT NULL DEFAULT false,
    "propertyActionsCancelled" BOOLEAN NOT NULL DEFAULT false,
    "declaredBy" TEXT NOT NULL,
    "confirmedBy" TEXT,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    CONSTRAINT "LandingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkipTurnEntry" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceDescription" TEXT NOT NULL,
    "originalCount" INTEGER NOT NULL,
    "remainingCount" INTEGER NOT NULL,
    "blocksTollCollection" BOOLEAN NOT NULL,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkipTurnEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SkipTurnEntry_counts_check" CHECK (
        "originalCount" >= 0 AND "remainingCount" >= 0 AND "remainingCount" <= "originalCount"
    )
);

-- CreateTable
CREATE TABLE "GameResult" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "victoryMode" "VictoryMode" NOT NULL,
    "endReason" TEXT NOT NULL,
    "rulesSnapshot" JSONB NOT NULL,
    "playerAssetBreakdown" JSONB NOT NULL,
    "winnerPlayerIds" JSONB NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebtRecord" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "debtorPlayerId" TEXT NOT NULL,
    "creditorType" "DebtCreditorType" NOT NULL,
    "creditorPlayerId" TEXT,
    "sourceRequestId" TEXT,
    "originalAmount" INTEGER NOT NULL,
    "paidAmount" INTEGER NOT NULL DEFAULT 0,
    "outstandingAmount" INTEGER NOT NULL,
    "status" "DebtStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "DebtRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DebtRecord_amounts_check" CHECK (
        "originalAmount" >= 0 AND "paidAmount" >= 0 AND "outstandingAmount" >= 0 AND
        "paidAmount" + "outstandingAmount" = "originalAmount"
    ),
    CONSTRAINT "DebtRecord_creditor_check" CHECK (
        ("creditorType" = 'PLAYER' AND "creditorPlayerId" IS NOT NULL) OR
        ("creditorType" = 'TREASURY' AND "creditorPlayerId" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "actorMemberId" TEXT,
    "actorRole" "Role" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "reason" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Room_code_key" ON "Room"("code");
CREATE INDEX "Room_status_expiresAt_idx" ON "Room"("status", "expiresAt");
CREATE UNIQUE INDEX "RoomMember_deviceTokenHash_key" ON "RoomMember"("deviceTokenHash");
CREATE INDEX "RoomMember_roomId_role_idx" ON "RoomMember"("roomId", "role");
CREATE UNIQUE INDEX "Player_memberId_key" ON "Player"("memberId");
CREATE UNIQUE INDEX "Player_roomId_characterId_key" ON "Player"("roomId", "characterId");
CREATE UNIQUE INDEX "Player_roomId_pawnColor_key" ON "Player"("roomId", "pawnColor");
CREATE UNIQUE INDEX "Player_roomId_turnOrder_key" ON "Player"("roomId", "turnOrder");
CREATE INDEX "Player_roomId_status_idx" ON "Player"("roomId", "status");
CREATE UNIQUE INDEX "PropertyDefinition_name_key" ON "PropertyDefinition"("name");
CREATE UNIQUE INDEX "PropertyDefinition_displayOrder_key" ON "PropertyDefinition"("displayOrder");
CREATE UNIQUE INDEX "Character_name_key" ON "Character"("name");
CREATE UNIQUE INDEX "Character_initialPropertyId_key" ON "Character"("initialPropertyId");
CREATE UNIQUE INDEX "Character_skillCode_key" ON "Character"("skillCode");
CREATE UNIQUE INDEX "RoomProperty_lockedByRequestId_key" ON "RoomProperty"("lockedByRequestId");
CREATE UNIQUE INDEX "RoomProperty_roomId_propertyDefinitionId_key" ON "RoomProperty"("roomId", "propertyDefinitionId");
CREATE INDEX "RoomProperty_roomId_ownerPlayerId_idx" ON "RoomProperty"("roomId", "ownerPlayerId");
CREATE UNIQUE INDEX "GameRequest_roomId_idempotencyKey_key" ON "GameRequest"("roomId", "idempotencyKey");
CREATE INDEX "GameRequest_roomId_status_createdAt_idx" ON "GameRequest"("roomId", "status", "createdAt");
CREATE INDEX "GameRequest_propertyId_status_idx" ON "GameRequest"("propertyId", "status");
CREATE UNIQUE INDEX "GameTransaction_requestId_key" ON "GameTransaction"("requestId");
CREATE UNIQUE INDEX "GameTransaction_reversedByTransactionId_key" ON "GameTransaction"("reversedByTransactionId");
CREATE INDEX "GameTransaction_roomId_createdAt_idx" ON "GameTransaction"("roomId", "createdAt");
CREATE INDEX "LedgerEntry_roomId_createdAt_idx" ON "LedgerEntry"("roomId", "createdAt");
CREATE INDEX "LedgerEntry_playerId_createdAt_idx" ON "LedgerEntry"("playerId", "createdAt");
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");
CREATE UNIQUE INDEX "Turn_roomId_turnNumber_key" ON "Turn"("roomId", "turnNumber");
CREATE INDEX "Turn_roomId_status_idx" ON "Turn"("roomId", "status");
CREATE INDEX "LandingEvent_roomId_playerId_declaredAt_idx" ON "LandingEvent"("roomId", "playerId", "declaredAt");
CREATE INDEX "LandingEvent_turnId_status_idx" ON "LandingEvent"("turnId", "status");
CREATE INDEX "SkipTurnEntry_roomId_playerId_createdAt_idx" ON "SkipTurnEntry"("roomId", "playerId", "createdAt");
CREATE UNIQUE INDEX "GameResult_roomId_key" ON "GameResult"("roomId");
CREATE INDEX "DebtRecord_roomId_status_idx" ON "DebtRecord"("roomId", "status");
CREATE INDEX "DebtRecord_debtorPlayerId_status_idx" ON "DebtRecord"("debtorPlayerId", "status");
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
CREATE INDEX "AuditLog_roomId_createdAt_idx" ON "AuditLog"("roomId", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- Business-level partial uniqueness
CREATE UNIQUE INDEX "active_property_request"
ON "GameRequest"("propertyId")
WHERE "status" IN ('PENDING', 'APPROVED') AND "propertyId" IS NOT NULL;

CREATE UNIQUE INDEX "active_room_turn"
ON "Turn"("roomId")
WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "active_turn_landing"
ON "LandingEvent"("turnId")
WHERE "turnId" IS NOT NULL AND "status" IN ('DECLARED', 'CONFIRMED');

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_currentTurnPlayerId_fkey" FOREIGN KEY ("currentTurnPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Player" ADD CONSTRAINT "Player_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Player" ADD CONSTRAINT "Player_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RoomMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Player" ADD CONSTRAINT "Player_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Character" ADD CONSTRAINT "Character_initialPropertyId_fkey" FOREIGN KEY ("initialPropertyId") REFERENCES "PropertyDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomProperty" ADD CONSTRAINT "RoomProperty_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomProperty" ADD CONSTRAINT "RoomProperty_propertyDefinitionId_fkey" FOREIGN KEY ("propertyDefinitionId") REFERENCES "PropertyDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomProperty" ADD CONSTRAINT "RoomProperty_ownerPlayerId_fkey" FOREIGN KEY ("ownerPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RoomProperty" ADD CONSTRAINT "RoomProperty_lockedByRequestId_fkey" FOREIGN KEY ("lockedByRequestId") REFERENCES "GameRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_actorPlayerId_fkey" FOREIGN KEY ("actorPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "RoomProperty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_landingEventId_fkey" FOREIGN KEY ("landingEventId") REFERENCES "LandingEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameRequest" ADD CONSTRAINT "GameRequest_approvedByMemberId_fkey" FOREIGN KEY ("approvedByMemberId") REFERENCES "RoomMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameTransaction" ADD CONSTRAINT "GameTransaction_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GameTransaction" ADD CONSTRAINT "GameTransaction_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "GameRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameTransaction" ADD CONSTRAINT "GameTransaction_reversedByTransactionId_fkey" FOREIGN KEY ("reversedByTransactionId") REFERENCES "GameTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "GameTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LandingEvent" ADD CONSTRAINT "LandingEvent_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LandingEvent" ADD CONSTRAINT "LandingEvent_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LandingEvent" ADD CONSTRAINT "LandingEvent_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LandingEvent" ADD CONSTRAINT "LandingEvent_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "RoomProperty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LandingEvent" ADD CONSTRAINT "LandingEvent_declaredBy_fkey" FOREIGN KEY ("declaredBy") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LandingEvent" ADD CONSTRAINT "LandingEvent_confirmedBy_fkey" FOREIGN KEY ("confirmedBy") REFERENCES "RoomMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SkipTurnEntry" ADD CONSTRAINT "SkipTurnEntry_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkipTurnEntry" ADD CONSTRAINT "SkipTurnEntry_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SkipTurnEntry" ADD CONSTRAINT "SkipTurnEntry_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SkipTurnEntry" ADD CONSTRAINT "SkipTurnEntry_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "RoomMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GameResult" ADD CONSTRAINT "GameResult_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameResult" ADD CONSTRAINT "GameResult_confirmedBy_fkey" FOREIGN KEY ("confirmedBy") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DebtRecord" ADD CONSTRAINT "DebtRecord_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebtRecord" ADD CONSTRAINT "DebtRecord_debtorPlayerId_fkey" FOREIGN KEY ("debtorPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DebtRecord" ADD CONSTRAINT "DebtRecord_creditorPlayerId_fkey" FOREIGN KEY ("creditorPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DebtRecord" ADD CONSTRAINT "DebtRecord_sourceRequestId_fkey" FOREIGN KEY ("sourceRequestId") REFERENCES "GameRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorMemberId_fkey" FOREIGN KEY ("actorMemberId") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only history protection
CREATE FUNCTION "reject_append_only_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% is append-only and cannot be %', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_append_only"
BEFORE UPDATE OR DELETE ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();

CREATE TRIGGER "AuditLog_append_only"
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
