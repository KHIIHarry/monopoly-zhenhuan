import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const migrationRoot = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const prismaCli = fileURLToPath(
  new URL('../../../node_modules/prisma/build/index.js', import.meta.url),
);

const migrationsThroughV1Safety = [
  '202607260001_init',
  '202607260002_runtime_safety',
  '202607260003_history_truncate_guard',
  '202607260004_explicit_history_truncate_capability',
  '202607260005_transaction_bound_history_capability',
];

function configuredTestDatabaseUrl() {
  const rawUrl = process.env.TEST_DATABASE_URL;
  if (!rawUrl) return undefined;

  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL database name must end in _test');
  }
  return rawUrl;
}

const testDatabaseUrl = configuredTestDatabaseUrl();
const integration = describe.skipIf(!testDatabaseUrl);

function executeSql(databaseUrl: string, sql: string) {
  try {
    execFileSync(
      process.execPath,
      [prismaCli, 'db', 'execute', '--stdin', '--url', databaseUrl],
      { cwd: workspaceRoot, input: sql, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (error) {
    const execution = error as { stdout?: string; stderr?: string };
    throw new Error(
      [execution.stdout, execution.stderr].filter(Boolean).join('\n') || String(error),
      { cause: error },
    );
  }
}

function executeMigration(databaseUrl: string, directory: string) {
  try {
    execFileSync(
      process.execPath,
      [
        prismaCli,
        'db',
        'execute',
        '--file',
        `${migrationRoot}${directory}/migration.sql`,
        '--url',
        databaseUrl,
      ],
      { cwd: workspaceRoot, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (error) {
    const execution = error as { stdout?: string; stderr?: string };
    throw new Error(
      [execution.stdout, execution.stderr].filter(Boolean).join('\n') || String(error),
      { cause: error },
    );
  }
}

const legacyFixture = `
INSERT INTO "PropertyDefinition" (
  "id", "name", "displayOrder", "mortgagePrice", "purchasePrice", "buildCost",
  "buildingSellPrice", "tollEmpty", "tollLevel1", "tollLevel2", "tollLevel3",
  "tollLevel4", "tollPalace"
) VALUES ('legacy-property-definition', 'Legacy Palace', 1, 100, 200, 50, 25, 10, 20, 30, 40, 50, 60);

INSERT INTO "Character" (
  "id", "name", "initialPropertyId", "skillCode", "skillConfig"
) VALUES ('legacy-character', 'Legacy Character', 'legacy-property-definition', 'legacy-skill', '{"enabled":true}'::jsonb);

INSERT INTO "Room" (
  "id", "code", "name", "status", "participantCount", "initialBalance",
  "storyMoneyCounterpartyMode", "victoryMode", "createdBy", "updatedAt", "expiresAt"
) VALUES (
  'legacy-room', 'LEGACY01', 'Legacy Room', 'PLAYING', 2, 5000,
  'TREASURY', 'LAST_SOLVENT', 'legacy-device-admin', CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP + INTERVAL '1 day'
);

INSERT INTO "RoomMember" (
  "id", "roomId", "role", "displayName", "deviceTokenHash", "onlineStatus"
) VALUES
  ('legacy-player-member', 'legacy-room', 'PLAYER', 'Legacy Player', 'legacy-player-device', 'ONLINE'),
  ('legacy-bank-member', 'legacy-room', 'BANK', 'Legacy Bank', 'legacy-bank-device', 'ONLINE');

INSERT INTO "Player" (
  "id", "roomId", "memberId", "characterId", "pawnColor", "balance", "turnOrder"
) VALUES (
  'legacy-player', 'legacy-room', 'legacy-player-member', 'legacy-character', '#ffffff', 4800, 1
);

UPDATE "Room" SET "currentTurnPlayerId" = 'legacy-player' WHERE "id" = 'legacy-room';

INSERT INTO "RoomProperty" (
  "id", "roomId", "propertyDefinitionId", "ownerPlayerId", "buildingLevel"
) VALUES (
  'legacy-room-property', 'legacy-room', 'legacy-property-definition', 'legacy-player', 2
);

INSERT INTO "GameTransaction" (
  "id", "roomId", "type", "metadata"
) VALUES (
  'legacy-transaction', 'legacy-room', 'LEGACY_PURCHASE', '{"source":"v1"}'::jsonb
);

INSERT INTO "LedgerEntry" (
  "id", "roomId", "transactionId", "playerId", "amount", "balanceBefore",
  "balanceAfter", "type", "description", "createdBy"
) VALUES (
  'legacy-ledger', 'legacy-room', 'legacy-transaction', 'legacy-player', -200, 5000,
  4800, 'LEGACY_PURCHASE', 'Legacy property purchase', 'legacy-player-member'
);

INSERT INTO "AuditLog" (
  "id", "roomId", "actorMemberId", "actorRole", "action", "entityType", "entityId", "afterJson"
) VALUES (
  'legacy-audit', 'legacy-room', 'legacy-player-member', 'PLAYER', 'LEGACY_PURCHASE',
  'RoomProperty', 'legacy-room-property', '{"ownerPlayerId":"legacy-player"}'::jsonb
);
`;

integration('V2.1 populated legacy migration', () => {
  it('preserves legacy identities and history while replacing device role control', async () => {
    const schemaName = `v21_migration_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set('schema', schemaName);
    let schemaCreated = false;
    let db: PrismaClient | undefined;

    try {
      executeSql(testDatabaseUrl!, `CREATE SCHEMA "${schemaName}";`);
      schemaCreated = true;

      for (const migration of migrationsThroughV1Safety) {
        executeMigration(isolatedUrl.toString(), migration);
      }
      executeSql(isolatedUrl.toString(), legacyFixture);
      executeMigration(isolatedUrl.toString(), '202607260006_account_room_v2');
      executeMigration(isolatedUrl.toString(), '202607270007_dual_role_capabilities');
      executeMigration(isolatedUrl.toString(), '202607270008_playable_player_allocations');
      executeMigration(isolatedUrl.toString(), '202607270009_inactive_player_allocations');
      executeMigration(isolatedUrl.toString(), '202607270010_transactional_settlement');
      executeMigration(isolatedUrl.toString(), '202607270011_security_log_append_only');
      executeMigration(isolatedUrl.toString(), '202607280012_room_state_version');

      db = new PrismaClient({ datasources: { db: { url: isolatedUrl.toString() } } });

      const playerMembership = await db.roomMembership.findUniqueOrThrow({
        where: { id: 'legacy-player-member' },
        include: { player: true },
      });
      expect(playerMembership).toMatchObject({
        id: 'legacy-player-member',
        accountId: 'legacy-account-legacy-player-member',
        status: 'LEFT',
        characterId: 'legacy-character',
        isBank: false,
        activeSessionId: null,
        player: {
          id: 'legacy-player',
          memberId: 'legacy-player-member',
          characterId: 'legacy-character',
          status: 'LEFT',
        },
      });

      const bankMembership = await db.roomMembership.findUniqueOrThrow({
        where: { id: 'legacy-bank-member' },
      });
      expect(bankMembership).toMatchObject({
        id: 'legacy-bank-member',
        accountId: 'legacy-account-legacy-bank-member',
        status: 'LEFT',
        characterId: null,
        isBank: true,
        activeSessionId: null,
      });

      const ownedProperty = await db.roomProperty.findUniqueOrThrow({
        where: { id: 'legacy-room-property' },
        include: { owner: true },
      });
      expect(ownedProperty).toMatchObject({
        id: 'legacy-room-property',
        ownerPlayerId: 'legacy-player',
        owner: { id: 'legacy-player', memberId: 'legacy-player-member' },
      });

      const ledger = await db.ledgerEntry.findUniqueOrThrow({
        where: { id: 'legacy-ledger' },
        include: { transaction: true, player: true, creator: true },
      });
      expect(ledger).toMatchObject({
        id: 'legacy-ledger',
        transactionId: 'legacy-transaction',
        playerId: 'legacy-player',
        createdBy: 'legacy-player-member',
        transaction: { id: 'legacy-transaction', roomId: 'legacy-room' },
        player: { id: 'legacy-player', memberId: 'legacy-player-member' },
        creator: { id: 'legacy-player-member' },
      });

      const audit = await db.auditLog.findUniqueOrThrow({
        where: { id: 'legacy-audit' },
        include: { actor: true },
      });
      expect(audit).toMatchObject({
        id: 'legacy-audit',
        roomId: 'legacy-room',
        actorMemberId: 'legacy-player-member',
        actorRole: 'PLAYER',
        actor: { id: 'legacy-player-member' },
      });

      await expect(db.gameTransaction.findUniqueOrThrow({
        where: { id: 'legacy-transaction' },
      })).resolves.toMatchObject({ id: 'legacy-transaction', roomId: 'legacy-room' });
      await expect(db.room.findUniqueOrThrow({
        where: { id: 'legacy-room' },
      })).resolves.toMatchObject({ status: 'ENDED', currentTurnPlayerId: null, startedAt: null });

      const columns = await db.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = ${schemaName} AND table_name = 'RoomMember'
      `;
      const columnNames = columns.map(({ column_name }) => column_name);
      expect(columnNames).toEqual(expect.arrayContaining([
        'characterId',
        'isBank',
        'activeSessionId',
        'joinedAt',
        'leftAt',
      ]));
      expect(columnNames).not.toEqual(expect.arrayContaining([
        'role',
        'deviceTokenHash',
        'onlineStatus',
        'bankControlGrantedAt',
        'lastSeenAt',
      ]));

      const constraints = await db.$queryRaw<Array<{ constraint_name: string }>>`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_schema = ${schemaName}
      `;
      const constraintNames = constraints.map(({ constraint_name }) => constraint_name);
      expect(constraintNames).toEqual(expect.arrayContaining([
        'RoomMember_pkey',
        'Player_pkey',
        'RoomProperty_pkey',
        'GameTransaction_pkey',
        'LedgerEntry_pkey',
        'AuditLog_pkey',
        'Player_memberId_fkey',
        'RoomProperty_ownerPlayerId_fkey',
        'LedgerEntry_transactionId_fkey',
        'LedgerEntry_playerId_fkey',
        'LedgerEntry_createdBy_fkey',
        'AuditLog_actorMemberId_fkey',
      ]));

      const [bankIndex] = await db.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = ${schemaName}
          AND indexname = 'RoomMember_one_active_bank_per_room'
      `;
      expect(bankIndex?.indexdef).toContain(
        'UNIQUE INDEX "RoomMember_one_active_bank_per_room"',
      );
      expect(bankIndex?.indexdef).toContain('"isBank"');
      expect(bankIndex?.indexdef).toContain('status');
      expect(bankIndex?.indexdef).toContain("'ACTIVE'");

      const allocationIndexes = await db.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = ${schemaName}
          AND indexname IN (
            'Player_roomId_pawnColor_active_character_key',
            'Player_roomId_turnOrder_active_character_key'
          )
        ORDER BY indexname
      `;
      expect(allocationIndexes).toHaveLength(2);
      for (const index of allocationIndexes) {
        expect(index.indexdef).toContain('UNIQUE INDEX');
        expect(index.indexdef).toContain('"characterId" IS NOT NULL');
        expect(index.indexdef).toContain('status');
        expect(index.indexdef).toContain('ACTIVE');
      }

      const dormantAccount = await db.account.create({ data: {
        username: `migration-dormant-${randomUUID()}`,
        passwordHash: 'migration-test-password-hash',
        displayName: 'Dormant retained player',
      } });
      const dormantMembership = await db.roomMembership.create({ data: {
        roomId: 'legacy-room',
        accountId: dormantAccount.id,
        displayNameSnapshot: dormantAccount.displayName,
      } });
      await expect(db.player.create({ data: {
        roomId: 'legacy-room',
        memberId: dormantMembership.id,
        characterId: null,
        pawnColor: '#ffffff',
        turnOrder: 1,
        balance: 1234,
      } })).resolves.toMatchObject({ pawnColor: '#ffffff', turnOrder: 1 });

      const secondProperty = await db.propertyDefinition.create({ data: {
        name: `Migration palace ${randomUUID()}`,
        displayOrder: 2,
        mortgagePrice: 100,
        purchasePrice: 200,
        buildCost: 50,
        buildingSellPrice: 25,
        tollEmpty: 10,
        tollLevel1: 20,
        tollLevel2: 30,
        tollLevel3: 40,
        tollLevel4: 50,
        tollPalace: 60,
      } });
      const secondCharacter = await db.character.create({ data: {
        id: `migration-character-${randomUUID()}`,
        name: `Migration character ${randomUUID()}`,
        initialPropertyId: secondProperty.id,
        skillCode: `migration-skill-${randomUUID()}`,
        skillConfig: {},
      } });
      const activeAccount = await db.account.create({ data: {
        username: `migration-active-${randomUUID()}`,
        passwordHash: 'migration-test-password-hash',
        displayName: 'Active replacement player',
      } });
      const activeMembership = await db.roomMembership.create({ data: {
        roomId: 'legacy-room',
        accountId: activeAccount.id,
        characterId: secondCharacter.id,
        displayNameSnapshot: activeAccount.displayName,
      } });
      await expect(db.player.create({ data: {
        roomId: 'legacy-room',
        memberId: activeMembership.id,
        characterId: secondCharacter.id,
        pawnColor: '#ffffff',
        turnOrder: 1,
        balance: 0,
      } })).resolves.toMatchObject({ status: 'ACTIVE', characterId: secondCharacter.id });

      await db.roomMembership.update({
        where: { id: 'legacy-bank-member' },
        data: { status: 'ACTIVE' },
      });
      await db.roomMembership.update({
        where: { id: 'legacy-player-member' },
        data: { status: 'ACTIVE' },
      });
      await expect(db.roomMembership.update({
        where: { id: 'legacy-player-member' },
        data: { isBank: true },
      })).rejects.toMatchObject({ code: 'P2002' });
    } finally {
      await db?.$disconnect();
      if (schemaCreated) {
        executeSql(testDatabaseUrl!, `DROP SCHEMA "${schemaName}" CASCADE;`);
      }
    }
  }, 120_000);
});
