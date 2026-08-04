import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
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

const migrationsBeforeBankRoleSwaps = [
  ...migrationsThroughV1Safety,
  '202607260006_account_room_v2',
  '202607270007_dual_role_capabilities',
  '202607270008_playable_player_allocations',
  '202607270009_inactive_player_allocations',
  '202607270010_transactional_settlement',
  '202607270011_security_log_append_only',
  '202607280012_room_state_version',
  '202607280013_physical_delete_history_capability',
  '202607280014_configured_super_admins',
  '202607280014_physical_delete_ledger_capability',
  '202607290015_remove_auto_skip_turn',
];

const migrationsBeforeElectronicStartRewardGuard = [
  ...migrationsBeforeBankRoleSwaps,
  '202608010016_bank_role_swaps',
  '202608010017_physical_landing_lifecycle',
];

const migrationsThroughRoomTrashLifecycle = [
  ...migrationsBeforeElectronicStartRewardGuard,
  '202608010018_electronic_start_reward_turn_guard',
  '202608010019_restore_room_history_immutability',
  '202608020020_electronic_start_reward_history_safe_guard',
  '202608040021_room_trash_lifecycle',
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

function legacyMigrationClient(databaseUrl: string) {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    omit: {
      room: {
        deletedAt: true,
        purgeAfter: true,
        deletedByAccountId: true,
      },
    },
  });
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

      db = legacyMigrationClient(isolatedUrl.toString());

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

  it('cancels legacy in-game pending bank swaps during migration 016', async () => {
    const schemaName = `bank_swap_migration_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set('schema', schemaName);
    let schemaCreated = false;
    let db: PrismaClient | undefined;

    try {
      executeSql(testDatabaseUrl!, `CREATE SCHEMA "${schemaName}";`);
      schemaCreated = true;
      for (const migration of migrationsBeforeBankRoleSwaps) {
        executeMigration(isolatedUrl.toString(), migration);
      }
      db = legacyMigrationClient(isolatedUrl.toString());
      const creator = await db.account.create({ data: {
        username: `bank-swap-creator-${randomUUID()}`,
        passwordHash: 'migration-test-password-hash',
        displayName: 'Bank swap migration creator',
      } });
      const requesterAccount = await db.account.create({ data: {
        username: `bank-swap-requester-${randomUUID()}`,
        passwordHash: 'migration-test-password-hash',
        displayName: 'Bank swap migration requester',
      } });
      const targetAccount = await db.account.create({ data: {
        username: `bank-swap-target-${randomUUID()}`,
        passwordHash: 'migration-test-password-hash',
        displayName: 'Bank swap migration target',
      } });
      const room = await db.room.create({ data: {
        code: randomUUID().slice(0, 8).toUpperCase(),
        name: 'Legacy pending bank swap',
        status: 'PLAYING',
        ruleProfile: 'CUSTOM',
        difficulty: 'CUSTOM',
        participantCount: 5,
        playerLimit: 5,
        bankMode: 'DEDICATED_MODERATOR',
        characterAssignmentMode: 'PLAYER_SELECT',
        initialBalance: 5_000,
        diceMode: 'ELECTRONIC',
        skillEnabled: true,
        storyMoneyCounterpartyMode: 'TREASURY',
        transferApprovalRequired: false,
        startReward: 1_000,
        victoryMode: 'LAST_SOLVENT',
        createdBy: creator.username,
        createdByAccountId: creator.id,
        visibility: 'PRIVATE',
        allowMidgameJoin: false,
        expiresAt: new Date(Date.now() + 86_400_000),
      } });
      const requester = await db.roomMembership.create({ data: {
        roomId: room.id,
        accountId: requesterAccount.id,
        displayNameSnapshot: requesterAccount.displayName,
      } });
      const target = await db.roomMembership.create({ data: {
        roomId: room.id,
        accountId: targetAccount.id,
        displayNameSnapshot: targetAccount.displayName,
        isBank: true,
      } });
      executeSql(isolatedUrl.toString(), `
        INSERT INTO "RoleSwapRequest" (
          "id", "roomId", "requesterMembershipId", "targetMembershipId",
          "targetCharacterId", "status", "updatedAt"
        ) VALUES (
          'legacy-pending-bank-swap', '${room.id}', '${requester.id}', '${target.id}',
          'legacy-target-character', 'PENDING_BANK', CURRENT_TIMESTAMP
        );
      `);
      await db.$disconnect();
      db = undefined;

      executeMigration(isolatedUrl.toString(), '202608010016_bank_role_swaps');
      db = legacyMigrationClient(isolatedUrl.toString());

      await expect(db.roleSwapRequest.findUniqueOrThrow({
        where: { id: 'legacy-pending-bank-swap' },
      })).resolves.toMatchObject({
        kind: 'CHARACTER',
        status: 'CANCELLED',
        rejectionReason: 'ROLE_SWAP_LOBBY_ONLY',
        resolvedAt: expect.any(Date),
      });
      expect(await db.roleSwapRequest.count({
        where: { roomId: room.id, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } },
      })).toBe(0);
    } finally {
      await db?.$disconnect();
      if (schemaCreated) {
        executeSql(testDatabaseUrl!, `DROP SCHEMA "${schemaName}" CASCADE;`);
      }
    }
  }, 120_000);

  it('installs the electronic start-reward guard without rewriting duplicate history', async () => {
    const schemaName = `start_reward_guard_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set('schema', schemaName);
    let schemaCreated = false;
    let db: PrismaClient | undefined;

    try {
      executeSql(testDatabaseUrl!, `CREATE SCHEMA "${schemaName}";`);
      schemaCreated = true;
      for (const migration of migrationsBeforeElectronicStartRewardGuard) {
        executeMigration(isolatedUrl.toString(), migration);
      }

      db = legacyMigrationClient(isolatedUrl.toString());
      const creator = await db.account.create({ data: {
        username: `start-reward-creator-${randomUUID()}`,
        passwordHash: 'migration-test-password-hash',
        displayName: 'Start reward migration creator',
      } });
      const room = await db.room.create({ data: {
        code: randomUUID().slice(0, 8).toUpperCase(),
        name: 'Legacy duplicate start rewards',
        status: 'PLAYING',
        ruleProfile: 'CUSTOM',
        difficulty: 'CUSTOM',
        participantCount: 2,
        playerLimit: 5,
        bankMode: 'DEDICATED_MODERATOR',
        characterAssignmentMode: 'PLAYER_SELECT',
        initialBalance: 5_000,
        diceMode: 'ELECTRONIC',
        skillEnabled: true,
        storyMoneyCounterpartyMode: 'TREASURY',
        transferApprovalRequired: false,
        startReward: 1_000,
        victoryMode: 'LAST_SOLVENT',
        createdBy: creator.username,
        createdByAccountId: creator.id,
        visibility: 'PRIVATE',
        allowMidgameJoin: false,
        expiresAt: new Date(Date.now() + 86_400_000),
      } });
      const membership = await db.roomMembership.create({ data: {
        roomId: room.id,
        accountId: creator.id,
        displayNameSnapshot: creator.displayName,
      } });
      const player = await db.player.create({ data: {
        roomId: room.id,
        memberId: membership.id,
        pawnColor: '#ffffff',
        balance: 5_000,
      } });
      const turn = await db.turn.create({ data: {
        roomId: room.id,
        turnNumber: 1,
        playerId: player.id,
        status: 'ENDED',
      } });
      await db.gameRequest.createMany({ data: [
        {
          id: 'legacy-start-reward-one',
          roomId: room.id,
          type: 'START_REWARD',
          status: 'EXECUTED',
          actorPlayerId: player.id,
          turnId: turn.id,
          amount: 1_000,
          idempotencyKey: 'legacy-start-reward-one',
        },
        {
          id: 'legacy-start-reward-two',
          roomId: room.id,
          type: 'START_REWARD',
          status: 'REVERSED',
          actorPlayerId: player.id,
          turnId: turn.id,
          amount: 1_000,
          idempotencyKey: 'legacy-start-reward-two',
        },
      ] });
      await db.$disconnect();
      db = undefined;

      executeMigration(isolatedUrl.toString(), '202608010018_electronic_start_reward_turn_guard');
      db = legacyMigrationClient(isolatedUrl.toString());

      expect(await db.gameRequest.count({ where: { turnId: turn.id, type: 'START_REWARD' } })).toBe(2);
      await expect(db.gameRequest.create({ data: {
        roomId: room.id,
        type: 'START_REWARD',
        status: 'PENDING',
        actorPlayerId: player.id,
        turnId: turn.id,
        amount: 1_000,
        idempotencyKey: 'new-duplicate-start-reward',
      } })).rejects.toThrow(/one electronic START_REWARD per turn/);
    } finally {
      await db?.$disconnect();
      if (schemaCreated) {
        executeSql(testDatabaseUrl!, `DROP SCHEMA "${schemaName}" CASCADE;`);
      }
    }
  }, 120_000);

  it('upgrades an already-deployed start-reward unique index to the history-safe trigger', async () => {
    const schemaName = `start_reward_upgrade_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set('schema', schemaName);
    let schemaCreated = false;
    let db: PrismaClient | undefined;

    try {
      executeSql(testDatabaseUrl!, `CREATE SCHEMA "${schemaName}";`);
      schemaCreated = true;
      for (const migration of migrationsBeforeElectronicStartRewardGuard) {
        executeMigration(isolatedUrl.toString(), migration);
      }
      executeSql(isolatedUrl.toString(), `
        CREATE UNIQUE INDEX "GameRequest_one_electronic_start_reward_per_turn"
          ON "GameRequest"("turnId")
          WHERE "turnId" IS NOT NULL
            AND "type" = 'START_REWARD'
            AND "status" IN ('PENDING', 'APPROVED', 'EXECUTED', 'REVERSED');
      `);

      executeMigration(
        isolatedUrl.toString(),
        '202608020020_electronic_start_reward_history_safe_guard',
      );
      db = legacyMigrationClient(isolatedUrl.toString());

      const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = ${schemaName}
          AND indexname = 'GameRequest_one_electronic_start_reward_per_turn'
      `;
      const triggers = await db.$queryRaw<Array<{ trigger_name: string }>>`
        SELECT trigger.tgname AS trigger_name
        FROM pg_trigger AS trigger
        JOIN pg_class AS target ON target.oid = trigger.tgrelid
        JOIN pg_namespace AS namespace ON namespace.oid = target.relnamespace
        WHERE namespace.nspname = ${schemaName}
          AND target.relname = 'GameRequest'
          AND trigger.tgname = 'GameRequest_one_start_reward_per_turn'
          AND NOT trigger.tgisinternal
      `;
      expect(indexes).toEqual([]);
      expect(triggers).toEqual([{ trigger_name: 'GameRequest_one_start_reward_per_turn' }]);
    } finally {
      await db?.$disconnect();
      if (schemaCreated) {
        executeSql(testDatabaseUrl!, `DROP SCHEMA "${schemaName}" CASCADE;`);
      }
    }
  }, 120_000);

  it('limits physical deletion of immutable history to its configuring transaction', async () => {
    const schemaName = `room_trash_lifecycle_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const isolatedUrl = new URL(testDatabaseUrl);
    isolatedUrl.searchParams.set('schema', schemaName);
    isolatedUrl.searchParams.set('connection_limit', '1');
    let schemaCreated = false;
    let db: PrismaClient | undefined;

    try {
      executeSql(testDatabaseUrl!, `CREATE SCHEMA "${schemaName}";`);
      schemaCreated = true;
      for (const migration of migrationsThroughRoomTrashLifecycle) {
        executeMigration(isolatedUrl.toString(), migration);
      }

      db = new PrismaClient({ datasources: { db: { url: isolatedUrl.toString() } } });
      const account = await db.account.create({ data: {
        username: `room-trash-${randomUUID()}`,
        passwordHash: 'migration-test-password-hash',
        displayName: 'Room trash lifecycle actor',
      } });
      const room = await db.room.create({ data: {
        code: randomUUID().slice(0, 8).toUpperCase(),
        name: 'Room trash immutable history',
        status: 'ENDED',
        ruleProfile: 'CUSTOM',
        difficulty: 'CUSTOM',
        participantCount: 2,
        playerLimit: 5,
        bankMode: 'DEDICATED_MODERATOR',
        characterAssignmentMode: 'PLAYER_SELECT',
        initialBalance: 5_000,
        diceMode: 'ELECTRONIC',
        skillEnabled: true,
        storyMoneyCounterpartyMode: 'TREASURY',
        transferApprovalRequired: false,
        startReward: 1_000,
        victoryMode: 'LAST_SOLVENT',
        createdBy: account.username,
        createdByAccountId: account.id,
        visibility: 'PRIVATE',
        allowMidgameJoin: false,
        expiresAt: new Date(Date.now() + 86_400_000),
      } });
      const membership = await db.roomMembership.create({ data: {
        roomId: room.id,
        accountId: account.id,
        displayNameSnapshot: account.displayName,
      } });
      const player = await db.player.create({ data: {
        roomId: room.id,
        memberId: membership.id,
        pawnColor: '#ffffff',
        balance: 5_000,
      } });
      const transaction = await db.gameTransaction.create({ data: {
        roomId: room.id,
        type: 'ROOM_TRASH_TEST',
        metadata: {},
      } });
      const ledger = await db.ledgerEntry.create({ data: {
        roomId: room.id,
        transactionId: transaction.id,
        playerId: player.id,
        amount: 0,
        balanceBefore: 5_000,
        balanceAfter: 5_000,
        type: 'ROOM_TRASH_TEST',
        description: 'Room trash lifecycle test',
      } });
      const audit = await db.auditLog.create({ data: {
        roomId: room.id,
        actorMemberId: membership.id,
        actorRole: 'ADMIN',
        action: 'ROOM_TRASH_TEST',
        entityType: 'Room',
        entityId: room.id,
      } });
      const settlement = await db.gameSettlement.create({ data: {
        roomId: room.id,
        endedByAccountId: account.id,
        totalTurns: 1,
        durationSeconds: 1,
        winnersJson: [account.id],
        rankingJson: [{ accountId: account.id, rank: 1 }],
      } });
      const settlementPlayer = await db.settlementPlayer.create({ data: {
        settlementId: settlement.id,
        accountId: account.id,
        displayNameSnapshot: account.displayName,
        cash: 5_000,
        unmortgagedPropertyValue: 0,
        mortgagedPropertyNetValue: 0,
        buildingSellValue: 0,
        totalWealth: 5_000,
        rank: 1,
        isWinner: true,
        propertyDetailsJson: [],
      } });
      const security = await db.securityLog.create({ data: {
        accountId: account.id,
        actorAccountId: account.id,
        action: 'ROOM_TRASH_TEST',
      } });

      const expectAuthorizedMutationRejected = async (
        operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        await expect(db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "SELECT set_config('zhenhuan.physical_delete_txid', pg_current_xact_id()::text, true)",
          );
          await operation(tx);
        })).rejects.toThrow(/append-only|immutable/);
      };

      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`
        UPDATE "LedgerEntry" SET "description" = "description" WHERE "id" = ${ledger.id}
      `);
      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`
        UPDATE "AuditLog" SET "action" = "action" WHERE "id" = ${audit.id}
      `);
      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`
        UPDATE "SecurityLog" SET "action" = "action" WHERE "id" = ${security.id}
      `);
      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`
        UPDATE "GameSettlement" SET "durationSeconds" = "durationSeconds" WHERE "id" = ${settlement.id}
      `);
      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`
        UPDATE "SettlementPlayer" SET "cash" = "cash" WHERE "id" = ${settlementPlayer.id}
      `);

      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`TRUNCATE "LedgerEntry"`);
      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`TRUNCATE "AuditLog"`);
      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`TRUNCATE "SecurityLog"`);
      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`TRUNCATE "SettlementPlayer"`);
      await expectAuthorizedMutationRejected((tx) => tx.$executeRaw`TRUNCATE "GameSettlement" CASCADE`);

      await expect(db.ledgerEntry.delete({ where: { id: ledger.id } })).rejects.toThrow(/LedgerEntry is append-only/);
      await expect(db.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow(/AuditLog is append-only/);
      await expect(db.gameSettlement.delete({ where: { id: settlement.id } })).rejects.toThrow(/settlement history is immutable/);
      await expect(db.settlementPlayer.delete({ where: { id: settlementPlayer.id } })).rejects.toThrow(/settlement history is immutable/);
      await expect(db.securityLog.delete({ where: { id: security.id } })).rejects.toThrow(/SecurityLog is append-only/);

      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SELECT set_config('zhenhuan.physical_delete_txid', pg_current_xact_id()::text, true)",
        );
        expect(await tx.$executeRaw`DELETE FROM "LedgerEntry" WHERE "id" = ${ledger.id}`).toBe(1);
        expect(await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ${audit.id}`).toBe(1);
        expect(await tx.$executeRaw`DELETE FROM "SecurityLog" WHERE "id" = ${security.id}`).toBe(1);
        expect(await tx.$executeRaw`DELETE FROM "SettlementPlayer" WHERE "id" = ${settlementPlayer.id}`).toBe(1);
        expect(await tx.$executeRaw`DELETE FROM "GameSettlement" WHERE "id" = ${settlement.id}`).toBe(1);
      });

      const laterSecurity = await db.securityLog.create({ data: {
        accountId: account.id,
        actorAccountId: account.id,
        action: 'ROOM_TRASH_TEST_LATER',
      } });
      await expect(db.$transaction((tx) => tx.securityLog.delete({
        where: { id: laterSecurity.id },
      }))).rejects.toThrow(/SecurityLog is append-only/);
    } finally {
      await db?.$disconnect();
      if (schemaCreated) {
        executeSql(testDatabaseUrl!, `DROP SCHEMA "${schemaName}" CASCADE;`);
      }
    }
  }, 120_000);

});
