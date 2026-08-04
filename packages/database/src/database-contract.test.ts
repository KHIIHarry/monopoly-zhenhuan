import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const databaseRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function readDatabaseFile(path: string) {
  return readFile(`${databaseRoot}/${path}`, 'utf8');
}

describe('database delivery contract', () => {
  it('removes the persistent Account super-administrator field', async () => {
    const [schema, migration] = await Promise.all([
      readDatabaseFile('prisma/schema.prisma'),
      readDatabaseFile(
        'prisma/migrations/202607280014_configured_super_admins/migration.sql',
      ).catch(() => ''),
    ]);

    expect(schema).not.toMatch(/\bisSuperAdmin\b/);
    expect(migration).toContain('DROP COLUMN "isSuperAdmin"');
  });

  it('adds an aggregate room state version with an additive migration', async () => {
    const [schema, migration] = await Promise.all([
      readDatabaseFile('prisma/schema.prisma'),
      readDatabaseFile('prisma/migrations/202607280012_room_state_version/migration.sql'),
    ]);

    expect(schema).toMatch(/model Room \{[\s\S]*?stateVersion\s+Int\s+@default\(0\)/);
    expect(migration).toContain('ALTER TABLE "Room" ADD COLUMN "stateVersion" INTEGER NOT NULL DEFAULT 0');
  });

  it('defines every documented core model and optimistic lock', async () => {
    const schema = await readDatabaseFile('prisma/schema.prisma');
    const models = [
      'Room',
      'RoomMembership',
      'Player',
      'Character',
      'PropertyDefinition',
      'RoomProperty',
      'LedgerEntry',
      'GameTransaction',
      'GameRequest',
      'Turn',
      'LandingEvent',
      'SkipTurnEntry',
      'GameResult',
      'DebtRecord',
      'AuditLog',
    ];

    for (const model of models) {
      expect(schema).toMatch(new RegExp(`model ${model} \\{`));
    }

    expect(schema).toMatch(/model Player \{[\s\S]*?version\s+Int\s+@default\(0\)[\s\S]*?\n\}/);
    expect(schema).toMatch(/model RoomProperty \{[\s\S]*?version\s+Int\s+@default\(0\)[\s\S]*?\n\}/);
    expect(schema).toMatch(/model Turn \{[\s\S]*?die1\s+Int\?[\s\S]*?die2\s+Int\?[\s\S]*?diceValue\s+Int\?/);
  });

  it('models character and bank as independent room membership capabilities', async () => {
    const schema = await readDatabaseFile('prisma/schema.prisma');
    const membership = schema.match(/model RoomMembership \{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(membership).toMatch(/\n\s+characterId\s+String\?\n/);
    expect(membership).toMatch(/\n\s+isBank\s+Boolean\s+@default\(false\)\n/);
    expect(membership).toMatch(/\n\s+activeSessionId\s+String\?\n/);
    expect(membership).toMatch(/\n\s+joinedAt\s+DateTime\s+@default\(now\(\)\)\n/);
    expect(membership).toMatch(/\n\s+leftAt\s+DateTime\?\n/);
    expect(membership).toContain('@@unique([roomId, accountId])');
    expect(membership).toContain('@@unique([roomId, characterId])');

    for (const obsoleteField of [
      'role',
      'deviceTokenHash',
      'onlineStatus',
      'bankControlGrantedAt',
      'lastSeenAt',
    ]) {
      expect(membership).not.toMatch(new RegExp(`\\n\\s+${obsoleteField}\\s`));
    }

    expect(schema).toMatch(/enum Role \{[\s\S]*?\n\}/);
    expect(schema).toMatch(/model AuditLog \{[\s\S]*?actorRole\s+Role[\s\S]*?\n\}/);
  });

  it('migrates legacy bank roles to one active bank capability per room', async () => {
    const migration = await readDatabaseFile(
      'prisma/migrations/202607270007_dual_role_capabilities/migration.sql',
    ).catch(() => '');

    expect(migration).toContain(
      'ADD COLUMN "isBank" BOOLEAN NOT NULL DEFAULT false',
    );
    expect(migration).toContain(
      `UPDATE "RoomMember" SET "isBank" = true WHERE "role" = 'BANK';`,
    );
    expect(migration).toContain(
      'DROP INDEX IF EXISTS "RoomMember_one_active_bank_per_room";',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "RoomMember_one_active_bank_per_room" ON "RoomMember"("roomId") WHERE "isBank" = true AND "status" = \'ACTIVE\';',
    );

    for (const obsoleteColumn of [
      'role',
      'deviceTokenHash',
      'onlineStatus',
      'bankControlGrantedAt',
      'lastSeenAt',
    ]) {
      expect(migration).toContain(`DROP COLUMN "${obsoleteColumn}"`);
    }

    expect(migration).not.toContain('DROP COLUMN "characterId"');
    expect(migration).not.toContain('DROP COLUMN "activeSessionId"');
    expect(migration).not.toContain('DROP COLUMN "joinedAt"');
    expect(migration).not.toContain('DROP COLUMN "leftAt"');
    expect(migration).not.toContain('DROP TYPE "Role"');
  });

  it('scopes Player pawn and turn uniqueness to active character-bound seats', async () => {
    const schema = await readDatabaseFile('prisma/schema.prisma');
    const player = schema.match(/model Player \{[\s\S]*?\n\}/)?.[0] ?? '';
    const migration = await readDatabaseFile(
      'prisma/migrations/202607270008_playable_player_allocations/migration.sql',
    ).catch(() => '');
    const inactivePlayerMigration = await readDatabaseFile(
      'prisma/migrations/202607270009_inactive_player_allocations/migration.sql',
    ).catch(() => '');

    expect(player).not.toContain('@@unique([roomId, pawnColor])');
    expect(player).not.toContain('@@unique([roomId, turnOrder])');
    expect(player).toContain('@@unique([roomId, characterId])');
    expect(migration).toContain('DROP INDEX IF EXISTS "Player_roomId_pawnColor_key";');
    expect(migration).toContain('DROP INDEX IF EXISTS "Player_roomId_turnOrder_key";');
    expect(inactivePlayerMigration).toMatch(
      /UPDATE "Player" AS player[\s\S]*?SET "status" = 'LEFT'[\s\S]*?FROM "RoomMember" AS member[\s\S]*?player\."memberId" = member\."id"[\s\S]*?player\."status" = 'ACTIVE'[\s\S]*?member\."status" <> 'ACTIVE';/,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "Player_roomId_pawnColor_active_character_key"[\s\S]*?ON "Player"\("roomId", "pawnColor"\)[\s\S]*?WHERE "status" = 'ACTIVE' AND "characterId" IS NOT NULL;/,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "Player_roomId_turnOrder_active_character_key"[\s\S]*?ON "Player"\("roomId", "turnOrder"\)[\s\S]*?WHERE "status" = 'ACTIVE' AND "characterId" IS NOT NULL;/,
    );
  });

  it('uses the new FINISHED room status only after its enum migration commits', async () => {
    const accountMigration = await readDatabaseFile(
      'prisma/migrations/202607260006_account_room_v2/migration.sql',
    );
    const capabilityMigration = await readDatabaseFile(
      'prisma/migrations/202607270007_dual_role_capabilities/migration.sql',
    );

    expect(accountMigration).toContain(
      `ALTER TYPE "RoomStatus" ADD VALUE IF NOT EXISTS 'FINISHED';`,
    );
    expect(accountMigration).not.toContain(
      `UPDATE "Room" SET "status" = 'FINISHED'`,
    );
    expect(capabilityMigration).toContain(
      `UPDATE "Room" SET "status" = 'FINISHED', "currentTurnPlayerId" = NULL WHERE "status" IN ('LOBBY', 'PLAYING', 'ENDED');`,
    );
  });

  it('adds the immutable V2.1 settlement lifecycle in a forward migration', async () => {
    const schema = await readDatabaseFile('prisma/schema.prisma');
    const migration = await readDatabaseFile(
      'prisma/migrations/202607270010_transactional_settlement/migration.sql',
    ).catch(() => '');

    expect(schema).toMatch(/model Room \{[\s\S]*?startedAt\s+DateTime\?/);
    expect(schema).toMatch(/model GameSettlement \{[\s\S]*?overriddenBlockersJson\s+Json\s+@default\("\[\]"\)/);
    expect(migration).toContain('ADD COLUMN "startedAt" TIMESTAMP(3)');
    expect(migration).toContain('ADD COLUMN "overriddenBlockersJson" JSONB NOT NULL DEFAULT \'[]\'::jsonb');
    expect(migration).toMatch(/UPDATE "Room"[\s\S]*?SET "status" = 'ENDED'[\s\S]*?"status" = 'FINISHED'[\s\S]*?NOT EXISTS[\s\S]*?"GameSettlement"/);
    expect(migration).toMatch(/UPDATE "Room"[\s\S]*?SET "startedAt" = "createdAt"[\s\S]*?"status" = 'PLAYING'/);
    expect(migration).toContain('CREATE TRIGGER "SettlementPlayer_reject_post_finalization_insert"');
    expect(migration).toContain('CREATE TRIGGER "GameSettlement_reject_post_finalization_insert"');
    expect(migration).toContain('CREATE TRIGGER "Room_settlement_terminal_guard"');
    expect(migration).not.toContain('DROP TRIGGER "GameSettlement_immutable');
    expect(migration).not.toContain('DROP TRIGGER "SettlementPlayer_immutable');
  });

  it('relaxes legacy device token nullability before invalidating device control', async () => {
    const migration = await readDatabaseFile(
      'prisma/migrations/202607260006_account_room_v2/migration.sql',
    );
    const relaxNullability = migration.indexOf(
      'ALTER TABLE "RoomMember" ALTER COLUMN "deviceTokenHash" DROP NOT NULL;',
    );
    const invalidateLegacyToken = migration.indexOf('"deviceTokenHash" = NULL');

    expect(relaxNullability).toBeGreaterThan(-1);
    expect(invalidateLegacyToken).toBeGreaterThan(relaxNullability);
  });

  it('contains a deployable initial migration rather than a marker', async () => {
    const migration = await readDatabaseFile('prisma/migrations/202607260001_init/migration.sql');
    expect(migration).not.toContain('remaining tables are generated');
    expect(migration.match(/CREATE TABLE/g)).toHaveLength(16);
    expect(migration).toContain('CREATE TABLE "Player"');
    expect(migration).toContain('CREATE TABLE "RoomProperty"');
    expect(migration).toContain('ADD CONSTRAINT "RoomProperty_ownerPlayerId_fkey"');
    expect(migration).toContain('"diceValue" = "die1" + "die2"');
  });

  it('keeps ledger and audit history append-only at the database boundary', async () => {
    const schema = await readDatabaseFile('prisma/schema.prisma');
    const migration = await readDatabaseFile('prisma/migrations/202607260001_init/migration.sql');

    expect(schema).toMatch(
      /model LedgerEntry \{[\s\S]*?room\s+Room\s+@relation\(fields: \[roomId\], references: \[id\], onDelete: Restrict\)/,
    );
    expect(schema).toMatch(
      /model AuditLog \{[\s\S]*?room\s+Room\s+@relation\(fields: \[roomId\], references: \[id\], onDelete: Restrict\)/,
    );
    expect(migration).toContain(
      '"LedgerEntry_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT',
    );
    expect(migration).toContain(
      '"AuditLog_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT',
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "LedgerEntry_append_only"[\s\S]*?BEFORE UPDATE OR DELETE ON "LedgerEntry"/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "AuditLog_append_only"[\s\S]*?BEFORE UPDATE OR DELETE ON "AuditLog"/,
    );
  });

  it('enforces one new electronic start reward per turn without rewriting history', async () => {
    const migration = await readDatabaseFile(
      'prisma/migrations/202608010018_electronic_start_reward_turn_guard/migration.sql',
    ).catch(() => '');

    expect(migration).toContain(
      'CREATE FUNCTION reject_duplicate_start_reward_for_turn()',
    );
    expect(migration).toMatch(
      /CREATE TRIGGER "GameRequest_one_start_reward_per_turn"[\s\S]*?BEFORE INSERT OR UPDATE OF "turnId", "type", "status" ON "GameRequest"[\s\S]*?reject_duplicate_start_reward_for_turn\(\)/,
    );
    expect(migration).toContain(`NEW."type" <> 'START_REWARD'`);
    expect(migration).toContain(`existing."status" IN ('PENDING', 'APPROVED', 'EXECUTED', 'REVERSED')`);
    expect(migration).not.toContain('CREATE UNIQUE INDEX');
  });

  it('replaces an already-deployed start-reward unique index with the history-safe guard', async () => {
    const migration = await readDatabaseFile(
      'prisma/migrations/202608020020_electronic_start_reward_history_safe_guard/migration.sql',
    ).catch(() => '');

    expect(migration).toContain(
      'DROP INDEX IF EXISTS "GameRequest_one_electronic_start_reward_per_turn"',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION reject_duplicate_start_reward_for_turn()',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "GameRequest_one_start_reward_per_turn"',
    );
  });

  it('removes the physical-delete exception from immutable room history', async () => {
    const migration = await readDatabaseFile(
      'prisma/migrations/202608010019_restore_room_history_immutability/migration.sql',
    ).catch(() => '');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION reject_ledger_entry_mutation()');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION reject_audit_log_mutation()');
    expect(migration).not.toContain('physical_delete_txid');
  });

  it('defines the room trash lifecycle and transaction-bound physical deletion', async () => {
    const schema = await readDatabaseFile('prisma/schema.prisma');
    const migration = await readDatabaseFile(
      'prisma/migrations/202608040021_room_trash_lifecycle/migration.sql',
    ).catch(() => '');

    expect(schema).toMatch(/model Room \{[\s\S]*?deletedAt\s+DateTime\?[\s\S]*?purgeAfter\s+DateTime\?[\s\S]*?deletedByAccountId\s+String\?/);
    expect(schema).toContain('@@index([deletedAt, purgeAfter])');
    expect(schema).toMatch(/deletedByAccount\s+Account\?[\s\S]*?onDelete: SetNull/);
    expect(schema).toMatch(/model Account \{[\s\S]*?deletedRooms\s+Room\[\]/);
    for (const functionName of [
      'reject_ledger_entry_mutation',
      'reject_audit_log_mutation',
      'reject_security_log_mutation',
      'zhenhuan_reject_settlement_mutation',
    ]) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION ${functionName}`);
    }
    expect(migration).toContain("current_setting('zhenhuan.physical_delete_txid', true)");
    expect(migration).toContain('pg_current_xact_id()::text');
    expect(migration).toMatch(/IF TG_OP = 'DELETE'[\s\S]*?RETURN OLD/);
    expect(migration).not.toMatch(/TG_OP = 'UPDATE'[\s\S]*?RETURN OLD/);
    expect(migration).not.toMatch(/TG_OP = 'TRUNCATE'[\s\S]*?RETURN OLD/);
  });

  it('makes SecurityLog append-only and indexed for actor cursor queries in a forward migration', async () => {
    const schema = await readDatabaseFile('prisma/schema.prisma');
    const migration = await readDatabaseFile('prisma/migrations/202607270011_security_log_append_only/migration.sql');

    expect(schema).toMatch(/model SecurityLog \{[\s\S]*?@@index\(\[actorAccountId, createdAt, id\]\)/);
    expect(migration).toMatch(/CREATE TRIGGER "SecurityLog_append_only"[\s\S]*?BEFORE UPDATE OR DELETE ON "SecurityLog"/);
    expect(migration).toMatch(/CREATE TRIGGER "SecurityLog_reject_truncate"[\s\S]*?BEFORE TRUNCATE ON "SecurityLog"/);
    expect(migration).toContain('CREATE INDEX "SecurityLog_actorAccountId_createdAt_id_idx"');
  });

  it('rejects history truncation outside explicitly named test databases', async () => {
    const guardMigration = await readDatabaseFile(
      'prisma/migrations/202607260003_history_truncate_guard/migration.sql',
    );
    const capabilityMigration = await readDatabaseFile(
      'prisma/migrations/202607260004_explicit_history_truncate_capability/migration.sql',
    );
    const transactionCapabilityMigration = await readDatabaseFile(
      'prisma/migrations/202607260005_transaction_bound_history_capability/migration.sql',
    );

    expect(guardMigration).toMatch(/current_database\(\)[\s\S]*?_test/);
    expect(guardMigration).toMatch(
      /CREATE TRIGGER "LedgerEntry_reject_truncate"[\s\S]*?BEFORE TRUNCATE ON "LedgerEntry"/,
    );
    expect(guardMigration).toMatch(
      /CREATE TRIGGER "AuditLog_reject_truncate"[\s\S]*?BEFORE TRUNCATE ON "AuditLog"/,
    );
    expect(capabilityMigration).toMatch(/current_database\(\)[\s\S]*?_test/);
    expect(capabilityMigration).toContain("current_setting('zhenhuan.allow_history_truncate', true)");
    expect(capabilityMigration).toContain("IS DISTINCT FROM 'on'");
    expect(transactionCapabilityMigration).toContain("current_setting('zhenhuan.history_truncate_txid', true)");
    expect(transactionCapabilityMigration).toContain('pg_current_xact_id()::text');
  });

  it('rejects partially populated dice rows in PostgreSQL', async () => {
    const migration = await readDatabaseFile('prisma/migrations/202607260001_init/migration.sql');

    expect(migration).toMatch(
      /CONSTRAINT "Turn_dice_check" CHECK \([\s\S]*?"die1" IS NOT NULL AND\s+"die2" IS NOT NULL AND\s+"diceValue" IS NOT NULL AND[\s\S]*?"diceValue" = "die1" \+ "die2"/,
    );
  });

  it('uses a randomized migrated schema for integration test isolation', async () => {
    const integrationTest = await readFile(
      `${workspaceRoot}/apps/api/src/prisma-game-service.integration.test.ts`,
      'utf8',
    );

    expect(integrationTest).toContain('randomUUID().replaceAll');
    expect(integrationTest).toContain('for (const migration of migrations) executeMigration(url, migration)');
    expect(integrationTest).toContain('DROP SCHEMA "${isolatedSchemaName}" CASCADE');
    expect(integrationTest).not.toContain('TRUNCATE TABLE "Room", "IdempotencyRecord" CASCADE');
    expect(integrationTest).not.toContain('room.deleteMany()');
  });

  it('keeps all Master Data values available to the seed', async () => {
    const raw = JSON.parse(
      await readFile(`${workspaceRoot}/monopoly-zhenhuan_master-data.json`, 'utf8'),
    ) as {
      properties: Array<{
        name: string;
        mortgage: number;
        sale: number;
        build: number;
        building_sell: number;
        tolls: number[];
      }>;
      characters: unknown[];
    };

    expect(raw.properties).toHaveLength(26);
    expect(raw.characters).toHaveLength(5);
    expect(raw.properties.every((property) => property.tolls.length === 6)).toBe(true);

    const seed = await readDatabaseFile('src/seed.ts');
    for (const mapping of [
      'mortgagePrice: property.mortgage',
      'purchasePrice: property.purchasePrice',
      'buildCost: property.build',
      'buildingSellPrice: property.buildingSell',
      'tollEmpty: property.tolls[0]',
      'tollLevel1: property.tolls[1]',
      'tollLevel2: property.tolls[2]',
      'tollLevel3: property.tolls[3]',
      'tollLevel4: property.tolls[4]',
      'tollPalace: property.tolls[5]',
    ]) {
      expect(seed).toContain(mapping);
    }
    expect(seed).toContain('initialProperty: { connect: { name: character.initialProperty } }');
  });

  it('adds a non-destructive closed state for completed physical landing contexts', async () => {
    const [schema, migration] = await Promise.all([
      readDatabaseFile('prisma/schema.prisma'),
      readDatabaseFile(
        'prisma/migrations/202608010017_physical_landing_lifecycle/migration.sql',
      ),
    ]);

    expect(schema).toMatch(
      /enum LandingEventStatus \{[\s\S]*?DECLARED[\s\S]*?CONFIRMED[\s\S]*?CLOSED[\s\S]*?INVALIDATED[\s\S]*?\}/,
    );
    expect(migration).toContain(
      `ALTER TYPE "LandingEventStatus" ADD VALUE 'CLOSED' BEFORE 'INVALIDATED';`,
    );
  });
});
