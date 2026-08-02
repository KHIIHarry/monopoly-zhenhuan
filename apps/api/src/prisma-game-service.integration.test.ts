import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { loadMasterData } from '@zhenhuan/shared';
import { AccountRoomService, type AuthenticatedSession } from './account-room-service.js';
import { RuleError, TransferRuleError } from './api-error.js';
import { hashPassword } from './auth-domain.js';
import { PrismaGameService, type GameActor, type SnapshotView } from './prisma-game-service.js';
import * as prismaGameServiceModule from './prisma-game-service.js';
import { buildFundToastDeliveries } from './realtime-toast-notifications.js';

const unsafeResetConfirmation = 'I_UNDERSTAND_THIS_WILL_DELETE_ALL_DATA';

function parseDatabaseTarget(rawUrl: string, variableName: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`${variableName} must be a PostgreSQL URL`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!databaseName || databaseName.includes('/')) {
    throw new Error(`${variableName} must identify exactly one database`);
  }
  return {
    databaseName,
    identity: `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}/${databaseName}`,
  };
}

export function validateTestDatabaseEnvironment(environment: Record<string, string | undefined>) {
  const testUrl = environment.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL is required');
  const testTarget = parseDatabaseTarget(testUrl, 'TEST_DATABASE_URL');
  const unsafeResetConfirmed = environment.CONFIRM_UNSAFE_TEST_DATABASE_RESET === unsafeResetConfirmation;

  if (!unsafeResetConfirmed && environment.DATABASE_URL) {
    const applicationTarget = parseDatabaseTarget(environment.DATABASE_URL, 'DATABASE_URL');
    if (testTarget.identity === applicationTarget.identity) {
      throw new Error('TEST_DATABASE_URL must not resolve to the same database as DATABASE_URL');
    }
  }
  if (!unsafeResetConfirmed && !testTarget.databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL database name must end in _test');
  }
  return testUrl;
}

describe('integration database safety gate', () => {
  it('rejects the production database even when credentials or query options differ', () => {
    expect(() => validateTestDatabaseEnvironment({
      TEST_DATABASE_URL: 'postgresql://test-user:test-pass@db.example.com:5432/zhenhuan?schema=test',
      DATABASE_URL: 'postgresql://prod-user:prod-pass@db.example.com/zhenhuan?schema=public',
    })).toThrow(/DATABASE_URL/);
  });

  it('rejects a database whose name does not end in _test', () => {
    expect(() => validateTestDatabaseEnvironment({
      TEST_DATABASE_URL: 'postgresql://localhost:5432/zhenhuan_staging',
    })).toThrow(/_test/);
  });

  it('accepts a distinct database whose name ends in _test', () => {
    const testUrl = 'postgresql://localhost:5432/zhenhuan_test?schema=public';
    expect(validateTestDatabaseEnvironment({
      TEST_DATABASE_URL: testUrl,
      DATABASE_URL: 'postgresql://localhost:5432/zhenhuan',
    })).toBe(testUrl);
  });

  it('requires an exact destructive-reset confirmation to override the naming rules', () => {
    const testUrl = 'postgresql://localhost:5432/zhenhuan_staging';
    expect(() => validateTestDatabaseEnvironment({
      TEST_DATABASE_URL: testUrl,
      CONFIRM_UNSAFE_TEST_DATABASE_RESET: 'yes',
    })).toThrow(/_test/);
    expect(validateTestDatabaseEnvironment({
      TEST_DATABASE_URL: testUrl,
      CONFIRM_UNSAFE_TEST_DATABASE_RESET: unsafeResetConfirmation,
    })).toBe(testUrl);
  });
});

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseUrl = configuredTestDatabaseUrl
  ? validateTestDatabaseEnvironment(process.env)
  : undefined;
const integration = describe.skipIf(!baseUrl);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const migrationRoot = fileURLToPath(new URL('../../../packages/database/prisma/migrations/', import.meta.url));
const prismaCli = fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url));
const masterDataSource = new URL('../../../甄嬛传大富翁_master-data.json', import.meta.url);
const isolatedSchemaName = `game_service_${process.pid}_${randomUUID().replaceAll('-', '')}`;
let url: string | undefined;
let isolatedSchemaCreated = false;

function executeSql(databaseUrl: string, sql: string) {
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--stdin', '--url', databaseUrl], { cwd: workspaceRoot, input: sql, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const execution = error as { stdout?: string; stderr?: string };
    throw new Error([execution.stdout, execution.stderr].filter(Boolean).join('\n') || String(error), { cause: error });
  }
}

function executeMigration(databaseUrl: string, directory: string) {
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--file', `${migrationRoot}${directory}/migration.sql`, '--url', databaseUrl], { cwd: workspaceRoot, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const execution = error as { stdout?: string; stderr?: string };
    throw new Error([execution.stdout, execution.stderr].filter(Boolean).join('\n') || String(error), { cause: error });
  }
}

async function seedMasterData(databaseUrl: string) {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const data = loadMasterData(JSON.parse(await readFile(masterDataSource, 'utf8')) as unknown);
  try {
    await db.$transaction(async (tx) => {
      for (const [index, property] of data.properties.entries()) {
        await tx.propertyDefinition.create({ data: {
          name: property.name, displayOrder: index + 1, mortgagePrice: property.mortgage, purchasePrice: property.purchasePrice,
          buildCost: property.build, buildingSellPrice: property.buildingSell, tollEmpty: property.tolls[0]!, tollLevel1: property.tolls[1]!,
          tollLevel2: property.tolls[2]!, tollLevel3: property.tolls[3]!, tollLevel4: property.tolls[4]!, tollPalace: property.tolls[5]!,
        } });
      }
      for (const character of data.characters) {
        await tx.character.create({ data: { id: character.id, name: character.name, skillCode: character.skill.code, skillConfig: character.skill.config, initialProperty: { connect: { name: character.initialProperty } } } });
      }
    });
  } finally {
    await db.$disconnect();
  }
}

beforeAll(async () => {
  if (!baseUrl) return;
  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.searchParams.set('schema', isolatedSchemaName);
  url = isolatedUrl.toString();
  executeSql(baseUrl, `CREATE SCHEMA "${isolatedSchemaName}";`);
  isolatedSchemaCreated = true;
  const migrations = readdirSync(migrationRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const migration of migrations) executeMigration(url, migration);
  await seedMasterData(url);
}, 120_000);

afterAll(() => {
  if (baseUrl && isolatedSchemaCreated) executeSql(baseUrl, `DROP SCHEMA "${isolatedSchemaName}" CASCADE;`);
});

type FixtureIdentity = { auth: AuthenticatedSession; actor: GameActor; playerId?: string; role: 'PLAYER' | 'BANK'; roomId: string; intent: string };
type UnifiedTransferInput = {
  fromPlayerId: string;
  recipientType: 'PLAYER' | 'BANK';
  toPlayerId?: string;
  amount: number;
  isPlotFine: boolean;
};
type FixtureState = {
  creator: AuthenticatedSession;
  identities: Map<string, Promise<FixtureIdentity>>;
  players: Map<string, GameActor>;
  banks: Map<string, GameActor>;
  roomBanks: Map<string, GameActor>;
};

class V2GameFixtureFacade {
  private readonly accounts: AccountRoomService;

  constructor(private readonly db: PrismaClient, private readonly games: PrismaGameService, private readonly state: FixtureState) {
    this.accounts = new AccountRoomService(db);
  }

  private async createAuth(displayName: string) {
    const suffix = randomUUID();
    const account = await this.db.account.create({ data: {
      username: `game-fixture-${suffix}`,
      passwordHash: await hashPassword(`Password-${suffix}`),
      displayName,
    } });
    const session = await this.db.accountSession.create({ data: {
      accountId: account.id,
      sessionTokenHash: randomUUID().replaceAll('-', ''),
      deviceId: randomUUID(),
      deviceName: 'Game fixture',
      browser: 'Vitest',
      operatingSystem: 'Test',
      userAgent: 'Task 4 game integration fixture',
      loginIp: '127.0.0.1',
      lastIp: '127.0.0.1',
      expiresAt: new Date(Date.now() + 60_000),
    } });
    return {
      account,
      auth: {
        account: { id: account.id, username: account.username, displayName, isSuperAdmin: false, canCreateRoom: false },
        session: { id: session.id, accountId: account.id },
      } satisfies AuthenticatedSession,
    };
  }

  private actor(token: string) {
    const actor = this.state.banks.get(token);
    if (!actor) throw new RuleError('BANK_REQUIRED');
    return actor;
  }

  private playerActor(playerId: string) {
    const actor = this.state.players.get(playerId);
    if (!actor) throw new RuleError('PLAYER_IDENTITY_MISMATCH');
    return actor;
  }

  async createRoom(input: { name: string; initialBalance: number; diceMode: 'ELECTRONIC' | 'PHYSICAL' }, key = randomUUID()) {
    return this.accounts.createRoom(this.state.creator, {
      ...input,
      skillEnabled: true,
      startReward: 1_000,
      allowMidgameJoin: false,
      visibility: 'PUBLIC',
      transferApprovalRequired: false,
    }, key);
  }

  async joinPlayer(code: string, name: string, characterId: string | null, fixtureKey = randomUUID(), joinKey = fixtureKey) {
    if (!characterId) throw new RuleError('CHARACTER_REQUIRED');
    const room = await this.db.room.findUniqueOrThrow({ where: { code } });
    const intent = JSON.stringify({ code, name, characterId, role: 'PLAYER' });
    const existing = this.state.identities.get(fixtureKey);
    if (existing) {
      const identity = await existing;
      if (identity.intent !== intent) throw new RuleError('JOIN_INTENT_CONFLICT');
      return { token: fixtureKey, roomId: identity.roomId, playerId: identity.playerId!, role: 'PLAYER' as const };
    }
    const created = (async (): Promise<FixtureIdentity> => {
      const member = await this.createAuth(name);
      await this.accounts.joinRoom(member.auth, room.id, {}, `join:${joinKey}`);
      const selected = await this.accounts.selectCharacter(member.auth, room.id, characterId, `character:${joinKey}`);
      const playerId = selected.player.id;
      const actor = { accountId: member.account.id, sessionId: member.auth.session.id };
      this.state.players.set(playerId, actor);
      return { auth: member.auth, actor, playerId, role: 'PLAYER', roomId: room.id, intent };
    })();
    this.state.identities.set(fixtureKey, created);
    const identity = await created;
    return { token: fixtureKey, roomId: identity.roomId, playerId: identity.playerId!, role: 'PLAYER' as const };
  }

  async joinBank(code: string, name: string, fixtureKey = randomUUID(), joinKey = fixtureKey) {
    const room = await this.db.room.findUniqueOrThrow({ where: { code } });
    const intent = JSON.stringify({ code, name, role: 'BANK' });
    const existing = this.state.identities.get(fixtureKey);
    if (existing) {
      const identity = await existing;
      if (identity.intent !== intent) throw new RuleError('JOIN_INTENT_CONFLICT');
      return { token: fixtureKey, roomId: identity.roomId, role: 'BANK' as const };
    }
    const created = (async (): Promise<FixtureIdentity> => {
      const member = await this.createAuth(name);
      await this.accounts.joinRoom(member.auth, room.id, {}, `join:${joinKey}`);
      await this.accounts.selectBank(member.auth, room.id, `bank:${joinKey}`);
      const actor = { accountId: member.account.id, sessionId: member.auth.session.id };
      this.state.banks.set(fixtureKey, actor);
      this.state.roomBanks.set(room.id, actor);
      return { auth: member.auth, actor, role: 'BANK', roomId: room.id, intent };
    })();
    this.state.identities.set(fixtureKey, created);
    const identity = await created;
    return { token: fixtureKey, roomId: identity.roomId, role: 'BANK' as const };
  }

  async reconnect(code: string, fixtureKey: string) {
    const identity = await (this.state.identities.get(fixtureKey) ?? Promise.reject(new RuleError('SESSION_INVALID')));
    const room = await this.db.room.findUniqueOrThrow({ where: { code } });
    const membership = await this.db.roomMembership.findUnique({ where: { roomId_accountId: { roomId: room.id, accountId: identity.actor.accountId } }, include: { player: true } });
    if (!membership || membership.activeSessionId !== identity.actor.sessionId) throw new RuleError('ROOM_CONTROL_LOST');
    return { role: identity.role, playerId: membership.player?.id, roomId: room.id };
  }

  async authorizeBank(roomId: string, fixtureKey: string) { await this.games.snapshot(this.actor(fixtureKey), roomId, 'BANK'); return { role: 'BANK' as const }; }
  snapshot(roomId: string, viewer?: { role: SnapshotView; playerId?: string }) {
    if (viewer?.role === 'PLAYER' && viewer.playerId) return this.games.snapshot(this.playerActor(viewer.playerId), roomId, 'PLAYER');
    const actor = this.state.roomBanks.get(roomId);
    if (!actor) throw new RuleError('BANK_REQUIRED');
    return this.games.snapshot(actor, roomId, 'BANK');
  }
  start(roomId: string, fixtureKey: string, key: string) { return this.games.start(this.actor(fixtureKey), roomId, key); }
  roll(roomId: string, playerId: string, key: string) { return this.games.roll(this.playerActor(playerId), roomId, playerId, key); }
  endTurn(roomId: string, playerId: string, key: string) { return this.games.endTurn(this.playerActor(playerId), roomId, playerId, key); }
  skipTurn(roomId: string, playerId: string, key: string) { return this.games.skipTurn(this.playerActor(playerId), roomId, playerId, key); }
  declareLanding(roomId: string, playerId: string, propertyName: string, _fixtureKey: string, key: string) { return this.games.declareLanding(this.playerActor(playerId), roomId, playerId, propertyName, key); }
  declareStartLanding(roomId: string, playerId: string, landingId: string, _fixtureKey: string, key: string) { return this.games.declareStartLanding(this.playerActor(playerId), roomId, playerId, landingId, key); }
  confirmLanding(roomId: string, landingId: string, fixtureKey: string, plotResolved = true, key = randomUUID()) { return this.games.confirmLanding(this.actor(fixtureKey), roomId, landingId, plotResolved, key); }
  cancelLandingPropertyActions(roomId: string, landingId: string, fixtureKey: string, reason: string, key = randomUUID()) { return this.games.cancelLandingPropertyActions(this.actor(fixtureKey), roomId, landingId, reason, key); }
  createRequest(roomId: string, playerId: string, action: Parameters<PrismaGameService['createRequest']>[3], key: string) { return this.games.createRequest(this.playerActor(playerId), roomId, playerId, action, key); }
  requestBankPayment(roomId: string, playerId: string, amount: number, key: string) { return this.games.requestBankPayment(this.playerActor(playerId), roomId, playerId, amount, key); }
  confirmTrade(roomId: string, requestId: string, playerId: string, key: string) { return this.games.confirmTrade(this.playerActor(playerId), roomId, requestId, playerId, key); }
  approve(roomId: string, requestId: string, fixtureKey: string, key: string) { return this.games.approve(this.actor(fixtureKey), roomId, requestId, key); }
  reject(roomId: string, requestId: string, fixtureKey: string, reason: string, key: string) { return this.games.reject(this.actor(fixtureKey), roomId, requestId, reason, key); }
  transfer(roomId: string, input: UnifiedTransferInput, key: string) {
    const transfer = this.games.transfer as unknown as (
      actor: GameActor,
      targetRoomId: string,
      transferInput: UnifiedTransferInput,
      idempotencyKey: string,
    ) => ReturnType<PrismaGameService['transfer']>;
    return transfer.call(this.games, this.playerActor(input.fromPlayerId), roomId, input, key);
  }
  payToll(roomId: string, payer: string, property: string, key: string) { return this.games.payToll(this.playerActor(payer), roomId, payer, property, key); }
  adjustBalance(roomId: string, playerId: string, amount: number, fixtureKey: string, reason: string, key: string) { return this.games.adjustBalance(this.actor(fixtureKey), roomId, playerId, amount, reason, key); }
  adjustProperty(roomId: string, property: string, change: Parameters<PrismaGameService['adjustProperty']>[3], fixtureKey: string, reason: string, key: string) { return this.games.adjustProperty(this.actor(fixtureKey), roomId, property, change, reason, key); }
  addSkipTurns(roomId: string, playerId: string, count: number, source: string, fixtureKey: string, key: string, reason: string) { return this.games.addSkipTurns(this.actor(fixtureKey), roomId, playerId, count, source, key, reason); }
  plotFine(roomId: string, playerId: string, amount: number, key: string, fixtureKey: string) { return this.games.plotFine(this.actor(fixtureKey), roomId, playerId, amount, key); }
  consumeSkip(roomId: string, playerId: string, count: number, fixtureKey: string, key: string, reason: string) { return this.games.consumeSkip(this.actor(fixtureKey), roomId, playerId, count, key, reason); }
  invalidateRoll(roomId: string, fixtureKey: string, reason: string, key = randomUUID()) { return this.games.invalidateRoll(this.actor(fixtureKey), roomId, reason, key); }
  forceNext(roomId: string, fixtureKey: string, reason: string, key: string) { return this.games.forceNext(this.actor(fixtureKey), roomId, reason, key); }
  reverseLatest(roomId: string, transactionId: string, fixtureKey: string, reason: string, key: string) { return this.games.reverseLatest(this.actor(fixtureKey), roomId, transactionId, reason, key); }
}

integration('PrismaGameService PostgreSQL transactions', () => {
  let firstDb: PrismaClient;
  let secondDb: PrismaClient;
  let first: V2GameFixtureFacade;
  let second: V2GameFixtureFacade;
  let state: FixtureState;

  beforeAll(async () => {
    firstDb = new PrismaClient({ datasources: { db: { url: url! } } });
    secondDb = new PrismaClient({ datasources: { db: { url: url! } } });
    const creatorAccount = await firstDb.account.create({ data: { username: `game-creator-${randomUUID()}`, passwordHash: await hashPassword('Game-fixture-password'), displayName: 'Game fixture creator', canCreateRoom: true } });
    const creatorSession = await firstDb.accountSession.create({ data: { accountId: creatorAccount.id, sessionTokenHash: randomUUID().replaceAll('-', ''), deviceId: randomUUID(), deviceName: 'Creator', browser: 'Vitest', operatingSystem: 'Test', userAgent: 'Task 4 creator', loginIp: '127.0.0.1', lastIp: '127.0.0.1', expiresAt: new Date(Date.now() + 60_000) } });
    const creator: AuthenticatedSession = { account: { id: creatorAccount.id, username: creatorAccount.username, displayName: creatorAccount.displayName, isSuperAdmin: false, canCreateRoom: true }, session: { id: creatorSession.id, accountId: creatorAccount.id } };
    state = { creator, identities: new Map(), players: new Map(), banks: new Map(), roomBanks: new Map() };
    first = new V2GameFixtureFacade(firstDb, new PrismaGameService(firstDb, () => 0), state);
    second = new V2GameFixtureFacade(secondDb, new PrismaGameService(secondDb, () => 0.999999), state);
    expect(await firstDb.propertyDefinition.count()).toBe(26);
    expect(await firstDb.character.count()).toBe(5);
  });

  beforeEach(async () => {
    validateTestDatabaseEnvironment({
      TEST_DATABASE_URL: url,
      DATABASE_URL: process.env.DATABASE_URL,
      CONFIRM_UNSAFE_TEST_DATABASE_RESET: process.env.CONFIRM_UNSAFE_TEST_DATABASE_RESET,
    });
    state.identities.clear();
    state.players.clear();
    state.banks.clear();
    state.roomBanks.clear();
  });

  afterAll(async () => { await firstDb.$disconnect(); await secondDb.$disconnect(); });

  async function physicalRoom() {
    const room = await first.createRoom({ name: '并发测试', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    const b = await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    const landingA = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'physical-room-a-landing');
    const landingB = await first.declareLanding(room.id, b.playerId, '甘露寺', b.token, 'physical-room-b-landing');
    await first.confirmLanding(room.id, landingA.id, bank.token, true);
    await first.confirmLanding(room.id, landingB.id, bank.token, true);
    return { room, a, b, bank };
  }

  async function createLobbyMember(
    roomId: string,
    displayName: string,
    input: { membershipCharacterId?: string; playerCharacterId?: string | null; playerStatus?: 'ACTIVE' | 'LEFT' } = {},
  ) {
    const suffix = randomUUID();
    const account = await firstDb.account.create({ data: {
      username: `start-member-${suffix}`,
      passwordHash: await hashPassword(`Password-${suffix}`),
      displayName,
    } });
    const session = await firstDb.accountSession.create({ data: {
      accountId: account.id,
      sessionTokenHash: randomUUID().replaceAll('-', ''),
      deviceId: randomUUID(),
      deviceName: 'Start cleanup fixture',
      browser: 'Vitest',
      operatingSystem: 'Test',
      userAgent: 'Task 3 start cleanup fixture',
      loginIp: '127.0.0.1',
      lastIp: '127.0.0.1',
      expiresAt: new Date(Date.now() + 60_000),
    } });
    const membership = await firstDb.roomMembership.create({ data: {
      roomId,
      accountId: account.id,
      displayNameSnapshot: displayName,
      characterId: input.membershipCharacterId,
      activeSessionId: session.id,
      controlClaimedAt: new Date(),
    } });
    const player = input.playerCharacterId !== undefined
      ? await firstDb.player.create({ data: {
        roomId,
        memberId: membership.id,
        characterId: input.playerCharacterId,
        pawnColor: `fixture-${suffix}`,
        balance: 5_000,
        status: input.playerStatus ?? 'ACTIVE',
      } })
      : null;
    return { account, session, membership, player };
  }

  async function startMutationSnapshot(roomId: string) {
    return {
      room: await firstDb.room.findUniqueOrThrow({
        where: { id: roomId },
        select: { status: true, stateVersion: true, startedAt: true, currentTurnPlayerId: true, turnNumber: true },
      }),
      memberships: await firstDb.roomMembership.findMany({
        where: { roomId },
        select: { id: true, status: true, characterId: true, isBank: true, activeSessionId: true, controlClaimedAt: true, leftAt: true },
        orderBy: { id: 'asc' },
      }),
      players: await firstDb.player.findMany({
        where: { roomId },
        select: { id: true, status: true, characterId: true },
        orderBy: { id: 'asc' },
      }),
      swaps: await firstDb.roleSwapRequest.findMany({ where: { roomId }, orderBy: { id: 'asc' } }),
      startAudits: await firstDb.auditLog.count({
        where: { roomId, action: { in: ['START_ROOM', 'ROOM_START_MEMBER_REMOVED'] } },
      }),
      removalSecurityLogs: await firstDb.securityLog.count({ where: { action: 'ROOM_START_MEMBER_REMOVED' } }),
      turns: await firstDb.turn.findMany({ where: { roomId }, orderBy: { id: 'asc' } }),
    };
  }

  async function unifiedTransferRoom(name = '统一转帐即时结算') {
    const room = await first.createRoom({ name, initialBalance: 5000, diceMode: 'PHYSICAL' });
    const meizhuang = await first.joinPlayer(room.code, '沈眉庄玩家', 'meizhuang');
    const zhenhuan = await first.joinPlayer(room.code, '甄嬛玩家', 'zhenhuan');
    const huashifei = await first.joinPlayer(room.code, '年世兰玩家', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, `start:${name}`);
    return { room, meizhuang, zhenhuan, huashifei, bank };
  }

  it('revalidates player, capability, Session, and controller before mutation or replay', async () => {
    const { room, a, b, bank } = await physicalRoom();
    const game = new PrismaGameService(firstDb, () => 0);
    const transfer = game.transfer as unknown as (actor: GameActor, targetRoomId: string, input: UnifiedTransferInput, key: string) => Promise<unknown>;
    const playerActor = state.players.get(a.playerId)!;
    const bankActor = state.banks.get(bank.token)!;
    const balanceBefore = (await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).balance;

    await expect(transfer.call(game, playerActor, room.id, { fromPlayerId: b.playerId, recipientType: 'PLAYER', toPlayerId: a.playerId, amount: 10, isPlotFine: false }, 'wrong-player')).rejects.toThrow('PLAYER_IDENTITY_MISMATCH');
    await expect(game.adjustBalance(playerActor, room.id, a.playerId, 10, 'wrong capability', 'wrong-capability')).rejects.toThrow('BANK_REQUIRED');
    await expect(transfer.call(game, bankActor, room.id, { fromPlayerId: a.playerId, recipientType: 'PLAYER', toPlayerId: b.playerId, amount: 10, isPlotFine: false }, 'bank-as-player')).rejects.toThrow('PLAYER_IDENTITY_MISMATCH');
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).balance).toBe(balanceBefore);

    await firstDb.accountSession.update({ where: { id: playerActor.sessionId }, data: { revokedAt: new Date() } });
    await expect(game.requestBankPayment(playerActor, room.id, a.playerId, 100, 'revoked-session')).rejects.toThrow('SESSION_INVALID');
    await firstDb.accountSession.update({ where: { id: playerActor.sessionId }, data: { revokedAt: null } });

    const committed = await game.requestBankPayment(playerActor, room.id, a.playerId, 100, 'control-replay');
    const replacement = await firstDb.accountSession.create({ data: {
      accountId: playerActor.accountId, sessionTokenHash: randomUUID().replaceAll('-', ''), deviceId: randomUUID(), deviceName: 'Takeover', browser: 'Vitest', operatingSystem: 'Test', userAgent: 'Task 4 takeover', loginIp: '127.0.0.2', lastIp: '127.0.0.2', expiresAt: new Date(Date.now() + 60_000),
    } });
    await firstDb.roomMembership.update({ where: { roomId_accountId: { roomId: room.id, accountId: playerActor.accountId } }, data: { activeSessionId: replacement.id, controlClaimedAt: new Date() } });
    await expect(game.requestBankPayment(playerActor, room.id, a.playerId, 100, 'control-replay')).rejects.toThrow('ROOM_CONTROL_LOST');
    expect(await firstDb.gameRequest.count({ where: { id: committed.id } })).toBe(1);
  });

  it('lets a dual member use one actor and Player for explicit player and bank views and writes', async () => {
    const room = await first.createRoom({ name: '兼任单会员', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const dual = await first.joinPlayer(room.code, '兼任者', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const identity = await state.identities.get(dual.token)!;
    const accounts = new AccountRoomService(firstDb);
    await accounts.selectBank(identity.auth, room.id, 'dual-select-bank');
    state.banks.set(dual.token, identity.actor);
    state.roomBanks.set(room.id, identity.actor);
    const game = new PrismaGameService(firstDb, () => 0);

    await expect(game.snapshot(identity.actor, room.id)).rejects.toThrow('SNAPSHOT_VIEW_REQUIRED');
    const playerView = await game.snapshot(identity.actor, room.id, 'PLAYER');
    const bankView = await game.snapshot(identity.actor, room.id, 'BANK');
    expect(playerView.players.find((player) => player.id === dual.playerId)).toMatchObject({ balance: 5000 });
    expect(bankView.audit).toEqual(expect.any(Array));

    await game.start(identity.actor, room.id, 'dual-start');
    await game.roll(identity.actor, room.id, dual.playerId, 'dual-roll');
    await game.adjustBalance(identity.actor, room.id, dual.playerId, 100, '兼任银行修正', 'dual-adjust');
    expect(await firstDb.roomMembership.count({ where: { roomId: room.id, accountId: identity.actor.accountId } })).toBe(1);
    expect(await firstDb.player.count({ where: { roomId: room.id, member: { accountId: identity.actor.accountId } } })).toBe(1);
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: dual.playerId } })).balance).toBe(5100);
  });

  it('rejects history truncation without an explicit test-session capability', async () => {
    await expect(
      firstDb.$executeRawUnsafe('TRUNCATE TABLE "LedgerEntry", "AuditLog"'),
    ).rejects.toThrow(/append-only/i);
  });

  it('does not let a session-level history capability leak into later transactions', async () => {
    const isolatedUrl = new URL(url!);
    isolatedUrl.searchParams.set('connection_limit', '1');
    const isolatedDb = new PrismaClient({ datasources: { db: { url: isolatedUrl.toString() } } });
    try {
      await isolatedDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "SELECT set_config('zhenhuan.history_truncate_txid', pg_current_xact_id()::text, false)",
        );
        await tx.$executeRawUnsafe('TRUNCATE TABLE "LedgerEntry", "AuditLog"');
      });
      await expect(
        isolatedDb.$executeRawUnsafe('TRUNCATE TABLE "LedgerEntry", "AuditLog"'),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await isolatedDb.$disconnect();
    }
  });

  it('creates one room for a repeated admin idempotency key', async () => {
    const input = { name: '幂等建房', initialBalance: 5000, diceMode: 'PHYSICAL' as const };
    const [created, replayed] = await Promise.all([
      first.createRoom(input, 'admin-create-room-key'),
      second.createRoom(input, 'admin-create-room-key'),
    ]);

    expect(replayed).toEqual(created);
    expect(await firstDb.room.count({ where: { name: input.name } })).toBe(1);
    await expect(
      first.createRoom({ ...input, name: '不同建房意图' }, 'admin-create-room-key'),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });

  it('deduplicates bank landing confirmation and cancellation controls', async () => {
    const room = await first.createRoom({ name: '落点控制幂等', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-landing-control-room');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'controlled-landing');

    const confirmed = await first.confirmLanding(room.id, landing.id, bank.token, true, 'confirm-landing-once');
    const replayedConfirmation = await second.confirmLanding(room.id, landing.id, bank.token, true, 'confirm-landing-once');
    expect(replayedConfirmation).toMatchObject({ id: confirmed.id, status: 'CONFIRMED', plotResolved: true });

    const cancelled = await first.cancelLandingPropertyActions(room.id, landing.id, bank.token, '现场取消', 'cancel-landing-once');
    const replayedCancellation = await second.cancelLandingPropertyActions(room.id, landing.id, bank.token, '现场取消', 'cancel-landing-once');
    expect(replayedCancellation).toMatchObject({ id: cancelled.id, propertyActionsCancelled: true, plotResolved: true });
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'CANCEL_LANDING_PROPERTY_ACTIONS' } })).toBe(1);
  });

  it('deduplicates bank roll invalidation controls', async () => {
    const room = await first.createRoom({ name: '轮次控制幂等', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-turn-control-room');
    await first.roll(room.id, a.playerId, 'roll-before-idempotent-invalidation');

    const invalidated = await first.invalidateRoll(room.id, bank.token, '骰点录入错误', 'invalidate-roll-once');
    const replayedInvalidation = await second.invalidateRoll(room.id, bank.token, '骰点录入错误', 'invalidate-roll-once');
    expect(replayedInvalidation).toMatchObject({ id: invalidated.id, die1: null, die2: null, diceValue: null });
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'INVALIDATE_ROLL' } })).toBe(1);

  });

  it('replays property and start landing declarations without invalidating the original landing', async () => {
    const { room, a } = await physicalRoom();

    const property = await first.declareLanding(room.id, a.playerId, '景仁宫', a.token, 'property-landing-key');
    const propertyReplay = await second.declareLanding(room.id, a.playerId, '景仁宫', a.token, 'property-landing-key');
    expect(propertyReplay).toMatchObject({ id: property.id, declaredAt: property.declaredAt.toISOString() });
    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: property.id } })).toMatchObject({ status: 'DECLARED' });
    await expect(first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'property-landing-key')).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');

    const start = await first.declareStartLanding(room.id, a.playerId, 'start-landing-keyed', a.token, 'start-landing-key');
    const startReplay = await second.declareStartLanding(room.id, a.playerId, 'start-landing-keyed', a.token, 'start-landing-key');
    expect(startReplay).toMatchObject({ id: start.id, declaredAt: start.declaredAt.toISOString() });
    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: start.id } })).toMatchObject({ status: 'DECLARED' });
    await expect(first.declareStartLanding(room.id, a.playerId, 'different-start-landing', a.token, 'start-landing-key')).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires and replays start idempotency keys while serializing concurrent joins', async () => {
    const missingKeyRoom = await first.createRoom({ name: '缺启动键', initialBalance: 5000, diceMode: 'PHYSICAL' });
    await first.joinPlayer(missingKeyRoom.code, '甲', 'zhenhuan');
    await first.joinPlayer(missingKeyRoom.code, '乙', 'huashifei');
    const missingKeyBank = await first.joinBank(missingKeyRoom.code, '国库');
    await expect(first.start(missingKeyRoom.id, missingKeyBank.token, '')).rejects.toThrow('IDEMPOTENCY_KEY_REQUIRED');

    const room = await first.createRoom({ name: '并发启动', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    const [left, right] = await Promise.all([
      first.start(room.id, bank.token, 'concurrent-start-key'),
      second.start(room.id, bank.token, 'concurrent-start-key'),
    ]);
    expect(right).toEqual(left);
    expect(await firstDb.turn.count({ where: { roomId: room.id, status: 'ACTIVE' } })).toBe(1);

    const joinAttempt = second.joinPlayer(room.code, '迟到玩家', 'meizhuang', 'late-join-device-token-0000000000000000000', 'concurrent-join-key');
    await expect(joinAttempt).rejects.toThrow('MIDGAME_JOIN_DISABLED');
    expect(await firstDb.player.count({ where: { roomId: room.id } })).toBe(2);

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const racingRoom = await first.createRoom({ name: `启动加入竞争${iteration}`, initialBalance: 5000, diceMode: 'ELECTRONIC' });
      await first.joinPlayer(racingRoom.code, '甲', 'zhenhuan');
      await first.joinPlayer(racingRoom.code, '乙', 'huashifei');
      const racingBank = await first.joinBank(racingRoom.code, '国库');
      const [startResult, joinResult] = await Promise.allSettled([
        first.start(racingRoom.id, racingBank.token, `start-join-race-${iteration}`),
        second.joinPlayer(
          racingRoom.code,
          '并发加入者',
          'meizhuang',
          `concurrent-join-device-token-${iteration}-000000000000000000`,
          `start-join-race-${iteration}`,
        ),
      ]);

      expect(startResult.status).toBe('fulfilled');
      if (joinResult.status === 'rejected') {
        expect(joinResult.reason).toMatchObject({ code: 'MIDGAME_JOIN_DISABLED' });
      }
      const playerCount = await firstDb.player.count({ where: { roomId: racingRoom.id } });
      expect(playerCount).toBe(joinResult.status === 'fulfilled' ? 3 : 2);
      expect(await firstDb.room.findUniqueOrThrow({ where: { id: racingRoom.id } })).toMatchObject({ status: 'PLAYING' });
      expect(await firstDb.turn.count({ where: { roomId: racingRoom.id, status: 'ACTIVE' } })).toBe(1);
    }
  });

  it('removes capability-less lobby members when starting', async () => {
    const room = await first.createRoom({ name: '开局清退空席', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '有效玩家甲', 'zhenhuan');
    const b = await first.joinPlayer(room.code, '有效玩家乙', 'huashifei');
    const bank = await first.joinBank(room.code, '独立银行');
    const empty = await createLobbyMember(room.id, '空席成员');
    const retained = await createLobbyMember(room.id, '留存空席', { playerCharacterId: null });
    const [aPlayer, bPlayer] = await Promise.all([
      firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } }),
      firstDb.player.findUniqueOrThrow({ where: { id: b.playerId } }),
    ]);
    await firstDb.roleSwapRequest.createMany({ data: [
      {
        roomId: room.id,
        requesterMembershipId: empty.membership.id,
        targetMembershipId: aPlayer.memberId,
        targetCharacterId: aPlayer.characterId!,
        status: 'PENDING_TARGET',
      },
      {
        roomId: room.id,
        requesterMembershipId: retained.membership.id,
        targetMembershipId: bPlayer.memberId,
        targetCharacterId: bPlayer.characterId!,
        status: 'PENDING_BANK',
      },
    ] });
    const bankActor = state.banks.get(bank.token)!;
    const bankMembership = await firstDb.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: bankActor.accountId } },
    });
    const beforeVersion = (await firstDb.room.findUniqueOrThrow({ where: { id: room.id } })).stateVersion;
    const afterCommit = vi.fn();

    const started = await new PrismaGameService(firstDb, () => 0).start(bankActor, room.id, 'cleanup-start', afterCommit);

    expect(started).not.toHaveProperty('removedSessionIds');
    expect(await firstDb.room.findUniqueOrThrow({ where: { id: room.id } })).toMatchObject({
      status: 'PLAYING',
      stateVersion: beforeVersion + 1,
    });
    expect(await firstDb.roomMembership.findUniqueOrThrow({ where: { id: bankMembership.id } }))
      .toMatchObject({ status: 'ACTIVE', characterId: null, isBank: true });
    for (const membershipId of [empty.membership.id, retained.membership.id]) {
      expect(await firstDb.roomMembership.findUniqueOrThrow({ where: { id: membershipId } }))
        .toMatchObject({ status: 'LEFT', characterId: null, isBank: false, activeSessionId: null });
    }
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: retained.player!.id } }))
      .toMatchObject({ status: 'LEFT', characterId: null });
    expect(await firstDb.roleSwapRequest.findMany({
      where: { roomId: room.id, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } },
    })).toEqual([]);
    expect(await firstDb.roleSwapRequest.findMany({ where: { roomId: room.id } }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'CANCELLED', rejectionReason: 'ROOM_STARTED' }),
      ]));
    expect(afterCommit).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledWith({
      removedSessionIds: expect.arrayContaining([empty.session.id, retained.session.id]),
    });
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'START_ROOM' } })).toBe(1);
    const removalAudits = await firstDb.auditLog.findMany({
      where: { roomId: room.id, action: 'ROOM_START_MEMBER_REMOVED' },
      orderBy: { entityId: 'asc' },
    });
    expect(removalAudits).toHaveLength(2);
    expect(removalAudits.map((audit) => audit.entityId).sort()).toEqual([empty.membership.id, retained.membership.id].sort());
    expect(removalAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorMemberId: bankMembership.id,
        actorRole: 'BANK',
        reason: 'ROOM_STARTED_WITHOUT_CAPABILITY',
      }),
    ]));
    const removalSecurityLogs = await firstDb.securityLog.findMany({
      where: { accountId: { in: [empty.account.id, retained.account.id] }, action: 'ROOM_START_MEMBER_REMOVED' },
    });
    expect(removalSecurityLogs).toHaveLength(2);
    expect(removalSecurityLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorAccountId: bankActor.accountId }),
    ]));
    const activeTurns = await firstDb.turn.findMany({ where: { roomId: room.id, status: 'ACTIVE' } });
    expect(activeTurns).toHaveLength(1);
    expect([a.playerId, b.playerId]).toContain(activeTurns[0]!.playerId);
  });

  it('rejects player identity drift at start', async () => {
    const variants = [
      { name: 'missing Player', member: { membershipCharacterId: 'meizhuang' } },
      { name: 'inactive Player', member: { membershipCharacterId: 'meizhuang', playerCharacterId: 'meizhuang', playerStatus: 'LEFT' as const } },
      { name: 'different character', member: { membershipCharacterId: 'meizhuang', playerCharacterId: 'anlingrong' } },
    ];

    for (const [index, variant] of variants.entries()) {
      const room = await first.createRoom({ name: `开局身份漂移-${variant.name}`, initialBalance: 5000, diceMode: 'ELECTRONIC' });
      const a = await first.joinPlayer(room.code, '有效玩家甲', 'zhenhuan');
      await first.joinPlayer(room.code, '有效玩家乙', 'huashifei');
      const bank = await first.joinBank(room.code, '独立银行');
      await createLobbyMember(room.id, `漂移成员-${index}`, variant.member);
      const empty = await createLobbyMember(room.id, `待清退成员-${index}`);
      const aPlayer = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
      await firstDb.roleSwapRequest.create({ data: {
        roomId: room.id,
        requesterMembershipId: empty.membership.id,
        targetMembershipId: aPlayer.memberId,
        targetCharacterId: aPlayer.characterId!,
      } });
      const before = await startMutationSnapshot(room.id);
      const afterCommit = vi.fn();

      await expect(new PrismaGameService(firstDb, () => 0).start(
        state.banks.get(bank.token)!,
        room.id,
        `identity-drift-${index}`,
        afterCommit,
      )).rejects.toMatchObject({ code: 'PLAYER_IDENTITY_MISMATCH' });

      expect(await startMutationSnapshot(room.id)).toEqual(before);
      expect(afterCommit).not.toHaveBeenCalled();
    }
  });

  it('rolls start cleanup back when the playable player count is invalid', async () => {
    const room = await first.createRoom({ name: '开局人数回滚', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const onlyPlayer = await first.joinPlayer(room.code, '唯一有效玩家', 'zhenhuan');
    const bank = await first.joinBank(room.code, '独立银行');
    const empty = await createLobbyMember(room.id, '待清退空席');
    await createLobbyMember(room.id, '待清退留存空席', { playerCharacterId: null });
    const player = await firstDb.player.findUniqueOrThrow({ where: { id: onlyPlayer.playerId } });
    await firstDb.roleSwapRequest.create({ data: {
      roomId: room.id,
      requesterMembershipId: empty.membership.id,
      targetMembershipId: player.memberId,
      targetCharacterId: player.characterId!,
      status: 'PENDING_TARGET',
    } });
    const before = await startMutationSnapshot(room.id);
    const afterCommit = vi.fn();

    await expect(new PrismaGameService(firstDb, () => 0).start(
      state.banks.get(bank.token)!,
      room.id,
      'invalid-player-count-start',
      afterCommit,
    )).rejects.toMatchObject({ code: 'PLAYER_COUNT_OUT_OF_RANGE' });

    expect(await startMutationSnapshot(room.id)).toEqual(before);
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('replays start cleanup once', async () => {
    const room = await first.createRoom({ name: '开局清退重放', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '有效玩家甲', 'zhenhuan');
    await first.joinPlayer(room.code, '有效玩家乙', 'huashifei');
    const bank = await first.joinBank(room.code, '独立银行');
    const empty = await createLobbyMember(room.id, '待清退成员');
    const player = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    await firstDb.roleSwapRequest.create({ data: {
      roomId: room.id,
      requesterMembershipId: empty.membership.id,
      targetMembershipId: player.memberId,
      targetCharacterId: player.characterId!,
    } });
    const actor = state.banks.get(bank.token)!;
    const afterCommit = vi.fn();
    const game = new PrismaGameService(firstDb, () => 0);

    const committed = await game.start(actor, room.id, 'start-cleanup-once', afterCommit);
    const replayed = await game.start(actor, room.id, 'start-cleanup-once', afterCommit);

    expect(replayed).toEqual(committed);
    expect(afterCommit).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledWith({ removedSessionIds: [empty.session.id] });
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'START_ROOM' } })).toBe(1);
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'ROOM_START_MEMBER_REMOVED' } })).toBe(1);
    expect(await firstDb.roleSwapRequest.count({ where: { roomId: room.id, status: 'CANCELLED', rejectionReason: 'ROOM_STARTED' } })).toBe(1);
    expect(await firstDb.turn.count({ where: { roomId: room.id, status: 'ACTIVE' } })).toBe(1);
    const record = await firstDb.idempotencyRecord.findUniqueOrThrow({
      where: { scope_key: { scope: `account:${actor.accountId}:room:${room.id}:start`, key: 'start-cleanup-once' } },
    });
    expect(JSON.stringify(record.response)).not.toContain(empty.session.id);
  });

  it('serializes concurrent starts with different keys', async () => {
    const room = await first.createRoom({ name: '异键并发开局', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    await first.joinPlayer(room.code, '有效玩家甲', 'zhenhuan');
    await first.joinPlayer(room.code, '有效玩家乙', 'huashifei');
    const bank = await first.joinBank(room.code, '独立银行');
    const empty = await createLobbyMember(room.id, '并发待清退成员');
    const actor = state.banks.get(bank.token)!;
    const afterCommit = vi.fn();
    const attempts = await Promise.allSettled([
      new PrismaGameService(firstDb, () => 0).start(actor, room.id, 'concurrent-start-left', afterCommit),
      new PrismaGameService(secondDb, () => 0).start(actor, room.id, 'concurrent-start-right', afterCommit),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatchObject({ code: 'ROOM_NOT_IN_LOBBY' });
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'START_ROOM' } })).toBe(1);
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'ROOM_START_MEMBER_REMOVED' } })).toBe(1);
    expect(await firstDb.roomMembership.findUniqueOrThrow({ where: { id: empty.membership.id } })).toMatchObject({ status: 'LEFT' });
    expect(afterCommit).toHaveBeenCalledOnce();
    expect(await firstDb.turn.count({ where: { roomId: room.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('lets only one transaction lock and buy the same property', async () => {
    const { room, a, b, bank } = await physicalRoom();
    const attempts = await Promise.allSettled([
      first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'buy-a'),
      second.createRequest(room.id, b.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'buy-b')
    ]);
    const successes = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof first.createRequest>>> => attempt.status === 'fulfilled');
    const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ code: 'PROPERTY_LOCKED' });
    await first.approve(room.id, successes[0].value.id, bank.token, 'approve-winner');
    const property = await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } });
    expect([a.playerId, b.playerId]).toContain(property.ownerPlayerId);
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'BUY_PROPERTY' } })).toBe(1);
  });

  it('serializes distinct player joins into unique room slots', async () => {
    const room = await first.createRoom({ name: '并发加入席位', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const characterIds = ['yixiu', 'huashifei', 'meizhuang', 'anlingrong', 'zhenhuan'];

    const joined = await Promise.all(characterIds.map((characterId, index) => {
      const service = index % 2 === 0 ? first : second;
      return service.joinPlayer(
        room.code,
        `并发玩家${index + 1}`,
        characterId,
        `distinct-join-device-${index}-0000000000000000000000`,
        `distinct-join-key-${index}`,
      );
    }));

    expect(joined).toHaveLength(5);
    const players = await firstDb.player.findMany({ where: { roomId: room.id }, orderBy: { turnOrder: 'asc' } });
    expect(players.map((player) => player.turnOrder)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(players.map((player) => player.pawnColor)).size).toBe(5);
  });

  it('executes a repeated approval once and rolls back insufficient operations', async () => {
    const { room, a, bank } = await physicalRoom();
    const payment = await first.requestBankPayment(room.id, a.playerId, 500, 'payment-request');
    const approved = await first.approve(room.id, payment.id, bank.token, 'approve-payment');
    const repeated = await second.approve(room.id, payment.id, bank.token, 'approve-payment-again');
    expect(repeated).toMatchObject({ transactionId: approved.transactionId });
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).balance).toBe(5500);
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'BANK_PAYMENT' } })).toBe(1);

    await first.adjustBalance(room.id, a.playerId, -5400, bank.token, '并发测试准备', 'drain-balance');
    const poorLanding = await first.declareLanding(room.id, a.playerId, '景仁宫', a.token, 'poor-landing');
    await first.confirmLanding(room.id, poorLanding.id, bank.token, true);
    await expect(first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '景仁宫' }, 'poor-buy')).rejects.toThrow('INSUFFICIENT_BALANCE');
    const property = await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '景仁宫' } } });
    expect(property.ownerPlayerId).toBeNull();
    expect(property.lockedByRequestId).toBeNull();
  });

  it('versions custom request creation once and preserves that version on replay', async () => {
    const { room, a } = await physicalRoom();
    const before = await firstDb.room.findUniqueOrThrow({ where: { id: room.id }, select: { stateVersion: true } });

    const request = await first.requestBankPayment(room.id, a.playerId, 500, 'versioned-bank-payment');
    const replay = await second.requestBankPayment(room.id, a.playerId, 500, 'versioned-bank-payment');

    expect(request.stateVersion).toBe(before.stateVersion + 1);
    expect(replay.stateVersion).toBe(request.stateVersion);
    expect((await firstDb.room.findUniqueOrThrow({ where: { id: room.id }, select: { stateVersion: true } })).stateVersion).toBe(request.stateVersion);
  });

  it('rejects approval replay after the room ends even with a committed key', async () => {
    const { room, a, bank } = await physicalRoom();
    const payment = await first.requestBankPayment(room.id, a.playerId, 500, 'same-key-approval-request');

    const [firstResult, secondResult] = await Promise.all([
      first.approve(room.id, payment.id, bank.token, 'same-approval-key'),
      second.approve(room.id, payment.id, bank.token, 'same-approval-key')
    ]);

    expect(secondResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({ id: payment.id, status: 'EXECUTED', transactionId: expect.any(String) });
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'BANK_PAYMENT' } })).toBe(1);
    const terminalResult = await first.approve(room.id, payment.id, bank.token, 'terminal-approval-key');
    expect(terminalResult).toEqual(firstResult);
    await firstDb.room.update({ where: { id: room.id }, data: { status: 'ENDED', currentTurnPlayerId: null } });
    await expect(second.approve(room.id, payment.id, bank.token, 'same-approval-key')).rejects.toThrow('ROOM_FINISHED');
    await expect(second.approve(room.id, payment.id, bank.token, 'terminal-approval-key')).rejects.toThrow('ROOM_FINISHED');
  });

  it('replays concurrent same-key rejection exactly once', async () => {
    const { room, a, bank } = await physicalRoom();
    const payment = await first.requestBankPayment(room.id, a.playerId, 500, 'same-key-rejection-request');

    const [firstResult, secondResult] = await Promise.all([
      first.reject(room.id, payment.id, bank.token, '不予支付', 'same-rejection-key'),
      second.reject(room.id, payment.id, bank.token, '不予支付', 'same-rejection-key')
    ]);

    expect(secondResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({ id: payment.id, status: 'REJECTED', stateVersion: expect.any(Number) });
    await expect(second.reject(room.id, payment.id, bank.token, '不予支付', 'same-rejection-key')).resolves.toEqual(firstResult);
    await expect(first.reject(room.id, payment.id, bank.token, '不予支付', 'terminal-rejection-key')).rejects.toThrow('REQUEST_ALREADY_RESOLVED');
    expect(await firstDb.idempotencyRecord.findUnique({ where: { scope_key: { scope: `request:${payment.id}:reject`, key: 'terminal-rejection-key' } } })).toBeNull();
    await expect(second.reject(room.id, payment.id, bank.token, '不同理由', 'same-rejection-key')).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });

  it('keeps request status consistent when approval and rejection race', async () => {
    const { room, a, bank } = await physicalRoom();
    const payment = await first.requestBankPayment(room.id, a.playerId, 500, 'approval-rejection-race');

    await Promise.allSettled([
      first.approve(room.id, payment.id, bank.token, 'approve-racing-payment'),
      second.reject(room.id, payment.id, bank.token, '不予支付', 'reject-racing-payment')
    ]);

    const request = await firstDb.gameRequest.findUniqueOrThrow({ where: { id: payment.id } });
    const ledgerCount = await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'BANK_PAYMENT' } });
    expect([{ status: 'EXECUTED', ledgerCount: 1 }, { status: 'REJECTED', ledgerCount: 0 }]).toContainEqual({ status: request.status, ledgerCount });
  });

  it('does not report executed, cancelled, or reversed requests as rejected', async () => {
    const room = await first.createRoom({ name: '拒绝终态请求', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');

    const executed = await first.requestBankPayment(room.id, a.playerId, 100, 'reject-executed-request');
    await first.approve(room.id, executed.id, bank.token, 'approve-before-reject');
    await expect(first.reject(room.id, executed.id, bank.token, '不能拒绝已执行', 'reject-executed-request')).rejects.toThrow('REQUEST_ALREADY_RESOLVED');

    const reversed = await first.requestBankPayment(room.id, a.playerId, 100, 'reject-reversed-request');
    const approved = await first.approve(room.id, reversed.id, bank.token, 'approve-before-reversal');
    await first.reverseLatest(room.id, approved.transactionId!, bank.token, '撤销付款', 'reverse-before-reject');
    await expect(first.reject(room.id, reversed.id, bank.token, '不能拒绝已冲正', 'reject-reversed-request')).rejects.toThrow('REQUEST_ALREADY_RESOLVED');

    await first.roll(room.id, a.playerId, 'roll-before-cancelled-reject');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'landing-before-cancelled-reject');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const cancelled = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'cancelled-before-reject');
    await first.endTurn(room.id, a.playerId, 'end-before-cancelled-reject');
    await expect(first.reject(room.id, cancelled.id, bank.token, '不能拒绝已取消', 'reject-cancelled-request')).rejects.toThrow('REQUEST_ALREADY_RESOLVED');
  });

  it('persists both dice, snapshot and device identity across clients', async () => {
    const room = await first.createRoom({ name: '持久化测试', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库'); await first.start(room.id, bank.token, 'start-room');
    expect(await first.roll(room.id, a.playerId, 'roll-once')).toMatchObject({ dice: [1, 1], total: 2, stateVersion: expect.any(Number) });
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'persisted-landing');
    const restored = await second.snapshot(room.id);
    expect(restored.turn).toMatchObject({ dice: [1, 1], total: 2 });
    expect(restored.landings).toContainEqual(expect.objectContaining({ id: landing.id, turnId: restored.turn?.id }));
    expect(await second.reconnect(room.code, a.token)).toMatchObject({ role: 'PLAYER', playerId: a.playerId });
    expect(await second.reconnect(room.code, bank.token)).toMatchObject({ role: 'BANK' });
  });

  it('replays a player join intent without creating a ghost identity', async () => {
    const room = await first.createRoom({ name: '玩家加入重试', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const deviceToken = 'player-device-token-0123456789abcdef';
    const joinKey = 'player-join-intent-0123456789abcdef';
    const joinWithIntent = (service: PrismaGameService) => (
      service.joinPlayer.bind(service) as unknown as (
        code: string,
        name: string,
        characterId: string,
        token: string,
        key: string,
      ) => ReturnType<PrismaGameService['joinPlayer']>
    )(room.code, '甲', 'zhenhuan', deviceToken, joinKey);

    const [joined, replayed] = await Promise.all([joinWithIntent(first), joinWithIntent(second)]);

    expect(replayed).toEqual(joined);
    expect(joined.token).toBe(deviceToken);
    expect(await firstDb.player.count({ where: { roomId: room.id } })).toBe(1);
    expect(await firstDb.roomMembership.count({ where: { roomId: room.id, characterId: { not: null } } })).toBe(1);
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'INITIAL_BALANCE' } })).toBe(1);
  });

  it('replays a bank join intent without stranding room control', async () => {
    const room = await first.createRoom({ name: '银行加入重试', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const deviceToken = 'bank-device-token-0123456789abcdef12';
    const joinKey = 'bank-join-intent-0123456789abcdef12';
    const joinWithIntent = (service: PrismaGameService) => (
      service.joinBank.bind(service) as unknown as (
        code: string,
        name: string,
        token: string,
        key: string,
      ) => ReturnType<PrismaGameService['joinBank']>
    )(room.code, '国库', deviceToken, joinKey);

    const [joined, replayed] = await Promise.all([joinWithIntent(first), joinWithIntent(second)]);

    expect(replayed).toEqual(joined);
    expect(joined.token).toBe(deviceToken);
    expect(await firstDb.roomMembership.count({ where: { roomId: room.id, isBank: true } })).toBe(1);
    expect(await second.reconnect(room.code, deviceToken)).toMatchObject({ role: 'BANK', roomId: room.id });
  });

  it('does not reuse one confirmed landing for repeated building actions', async () => {
    const { room, a, bank } = await physicalRoom();
    const purchase = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'buy-before-build');
    await first.approve(room.id, purchase.id, bank.token, 'approve-buy-before-build');

    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'first-build-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const build = await first.createRequest(room.id, a.playerId, { type: 'BUILD_PROPERTY', propertyName: '甘露寺' }, 'first-build-on-landing');
    await first.approve(room.id, build.id, bank.token, 'approve-first-build');

    await expect(
      first.createRequest(room.id, a.playerId, { type: 'BUILD_PROPERTY', propertyName: '甘露寺' }, 'second-build-on-landing'),
    ).rejects.toThrow('LANDING_ACTION_ALREADY_USED');
  });

  it('charges the full build cost when skills are disabled', async () => {
    const room = await first.createRoom({ name: '技能关闭测试', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const player = await first.joinPlayer(room.code, '陵容', 'anlingrong');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: false } });
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: player.playerId } });

    const landing = await first.declareLanding(room.id, player.playerId, '甘露寺', player.token, 'skills-disabled-build-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const request = await first.createRequest(room.id, player.playerId, { type: 'BUILD_PROPERTY', propertyName: '甘露寺' }, 'build-with-skills-disabled');

    expect(request.amount).toBe(500);
  });

  it('restores bank control with the original token and rejects a stranger', async () => {
    const room = await first.createRoom({ name: '银行重连测试', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const bank = await first.joinBank(room.code, '原银行');

    await expect(second.joinBank(room.code, '陌生银行')).rejects.toThrow('BANK_ALREADY_TAKEN');
    expect(await second.reconnect(room.code, bank.token)).toMatchObject({ role: 'BANK', roomId: room.id });
    await expect(second.authorizeBank(room.id, bank.token)).resolves.toEqual({ role: 'BANK' });
  });

  it('deduplicates repeated bank skip controls', async () => {
    const { room, a, bank } = await physicalRoom();

    const firstAdd = await first.addSkipTurns(room.id, a.playerId, 2, 'PLOT_REST', bank.token, 'add-skip-once', '剧情停轮');
    const repeatedAdd = await second.addSkipTurns(room.id, a.playerId, 2, 'PLOT_REST', bank.token, 'add-skip-once', '剧情停轮');
    expect(repeatedAdd.id).toBe(firstAdd.id);
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).remainingSkipTurns).toBe(2);
    expect(await firstDb.skipTurnEntry.count({ where: { roomId: room.id, playerId: a.playerId } })).toBe(1);

    const firstConsume = await first.consumeSkip(room.id, a.playerId, 1, bank.token, 'consume-skip-once', '实体骰子停轮确认');
    const repeatedConsume = await second.consumeSkip(room.id, a.playerId, 1, bank.token, 'consume-skip-once', '实体骰子停轮确认');
    expect(repeatedConsume).toEqual(firstConsume);
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).remainingSkipTurns).toBe(1);
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'MANUAL_SKIP_TURNS_CHANGE' } })).toBe(2);
    expect(await firstDb.auditLog.findFirstOrThrow({ where: { roomId: room.id, reason: '实体骰子停轮确认' } })).toMatchObject({ entityId: a.playerId });
  });

  it('requires a reason when consuming skip turns and includes it in idempotency', async () => {
    const { room, a, bank } = await physicalRoom();
    await first.addSkipTurns(room.id, a.playerId, 1, 'PLOT_REST', bank.token, 'consume-reason-setup', '剧情停轮');

    await expect(first.consumeSkip(room.id, a.playerId, 1, bank.token, 'consume-without-reason', undefined as unknown as string)).rejects.toThrow('REASON_REQUIRED');
    const consumed = await first.consumeSkip(room.id, a.playerId, 1, bank.token, 'consume-reason-key', '原因甲');
    await expect(second.consumeSkip(room.id, a.playerId, 1, bank.token, 'consume-reason-key', '原因乙')).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    expect(consumed).toMatchObject({ remainingSkipTurns: 0, stateVersion: expect.any(Number) });
  });

  it('approves plot rest without blocking tolls or applying Yixiu cold-palace skill', async () => {
    const room = await first.createRoom({ name: '剧情停留', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const yixiu = await first.joinPlayer(room.code, '宜修', 'yixiu');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-plot-rest');
    const request = await first.createRequest(room.id, yixiu.playerId, { type: 'PLOT_REST_EVENT', count: 3, reason: '养病留宫' }, 'plot-rest-request');

    await first.approve(room.id, request.id, bank.token, 'approve-plot-rest');

    expect(await firstDb.player.findUniqueOrThrow({ where: { id: yixiu.playerId } })).toMatchObject({ remainingSkipTurns: 3, balance: 5000 });
    expect(await firstDb.skipTurnEntry.findFirstOrThrow({ where: { roomId: room.id, playerId: yixiu.playerId } })).toMatchObject({
      sourceType: 'PLOT_REST', sourceDescription: '养病留宫', originalCount: 3, remainingCount: 3, blocksTollCollection: false,
    });
    expect((await first.snapshot(room.id)).players.find((player) => player.id === yixiu.playerId)).toMatchObject({ tollCollectionBlocked: false });
  });

  it('consumes the requested number across oldest skip entries atomically', async () => {
    const { room, a, bank } = await physicalRoom();
    const firstEntry = await first.addSkipTurns(room.id, a.playerId, 2, 'PLOT_REST', bank.token, 'first-entry', '剧情停留');
    const secondEntry = await first.addSkipTurns(room.id, a.playerId, 3, 'MANUAL', bank.token, 'second-entry', '现场裁定');

    await first.consumeSkip(room.id, a.playerId, 4, bank.token, 'consume-four', '已跳过四回合');

    expect(await firstDb.skipTurnEntry.findUniqueOrThrow({ where: { id: firstEntry.id } })).toMatchObject({ remainingCount: 0 });
    expect(await firstDb.skipTurnEntry.findUniqueOrThrow({ where: { id: secondEntry.id } })).toMatchObject({ remainingCount: 1 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ remainingSkipTurns: 1 });
    await expect(first.consumeSkip(room.id, a.playerId, 2, bank.token, 'consume-too-many', '不可部分扣除')).rejects.toThrow('INSUFFICIENT_SKIP_TURNS');
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ remainingSkipTurns: 1 });
  });

  it('requires bank approval before a player skip-consumption request changes state', async () => {
    const { room, a, bank } = await physicalRoom();
    await first.addSkipTurns(room.id, a.playerId, 2, 'PLOT_REST', bank.token, 'setup-consume-request', '剧情停留');
    const request = await first.createRequest(room.id, a.playerId, { type: 'CONSUME_SKIP_TURNS', count: 2 }, 'player-consume-request');

    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).remainingSkipTurns).toBe(2);
    await first.approve(room.id, request.id, bank.token, 'approve-player-consume');
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).remainingSkipTurns).toBe(0);
  });

  it('accepts only supported skip sources and always blocks toll collection for cold palace', async () => {
    const { room, a, b, bank } = await physicalRoom();
    await expect(first.addSkipTurns(room.id, a.playerId, 1, 'UNKNOWN', bank.token, 'unsupported-skip-source', '错误来源')).rejects.toThrow('INVALID_SKIP_SOURCE');
    const cold = await first.addSkipTurns(room.id, a.playerId, 1, 'COLD_PALACE', bank.token, 'cold-palace-skip-source', '冷宫停轮');
    await first.addSkipTurns(room.id, b.playerId, 1, 'PLOT_REST', bank.token, 'plot-rest-skip-source', '剧情停轮');
    expect(await firstDb.skipTurnEntry.findUniqueOrThrow({ where: { id: cold.id } })).toMatchObject({ sourceType: 'COLD_PALACE', blocksTollCollection: true });
    const snapshot = await first.snapshot(room.id);
    expect(snapshot.players.find((player) => player.id === a.playerId)).toMatchObject({ tollCollectionBlocked: true });
    expect(snapshot.players.find((player) => player.id === b.playerId)).toMatchObject({ tollCollectionBlocked: false });
  });

  it('exposes the configured redemption fee in the authoritative snapshot', async () => {
    const { room } = await physicalRoom();
    await firstDb.room.update({ where: { id: room.id }, data: { redemptionFee: 350 } });

    await expect(first.snapshot(room.id)).resolves.toMatchObject({ redemptionFee: 350 });
  });

  it('applies Yixiu cold-palace relief atomically through bank skip controls', async () => {
    const room = await first.createRoom({ name: '银行冷宫技能', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const yixiu = await first.joinPlayer(room.code, '宜修', 'yixiu');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');

    const enabledSnapshot = await first.snapshot(room.id);
    expect(enabledSnapshot.players.find((player) => player.id === yixiu.playerId)).toMatchObject({ coldPalaceSkipReduction: 2, coldPalaceCashReward: 500 });
    expect(enabledSnapshot.players.find((player) => player.characterId === 'huashifei')).toMatchObject({ coldPalaceSkipReduction: 0, coldPalaceCashReward: 0 });
    const result = await first.addSkipTurns(room.id, yixiu.playerId, 3, 'COLD_PALACE', bank.token, 'bank-yixiu-cold-palace', '银行登记冷宫');

    expect(result).toMatchObject({ playerId: yixiu.playerId, remainingSkipTurns: 1 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: yixiu.playerId } })).toMatchObject({ remainingSkipTurns: 1, balance: 5500 });
    expect(await firstDb.skipTurnEntry.findUniqueOrThrow({ where: { id: result.id } })).toMatchObject({ originalCount: 1, remainingCount: 1, sourceType: 'COLD_PALACE', blocksTollCollection: true });
    expect(await firstDb.ledgerEntry.findFirstOrThrow({ where: { roomId: room.id, playerId: yixiu.playerId, type: 'SKILL_REWARD' } })).toMatchObject({ amount: 500, balanceBefore: 5000, balanceAfter: 5500, createdBy: expect.any(String) });
    expect(await firstDb.auditLog.findFirstOrThrow({ where: { roomId: room.id, action: 'MANUAL_SKIP_TURNS_CHANGE', reason: '银行登记冷宫' } })).toMatchObject({
      beforeJson: { remainingSkipTurns: 0, balance: 5000 },
      afterJson: { remainingSkipTurns: 1, balance: 5500 },
    });
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: false } });
    expect((await first.snapshot(room.id)).players.find((player) => player.id === yixiu.playerId)).toMatchObject({ coldPalaceSkipReduction: 0, coldPalaceCashReward: 0 });
  });

  it('requires an operator reason before adding manual skip turns', async () => {
    const { room, a, bank } = await physicalRoom();

    await expect(
      first.addSkipTurns(room.id, a.playerId, 1, 'PLOT_REST', bank.token, 'missing-skip-reason', undefined as unknown as string),
    ).rejects.toThrow('REASON_REQUIRED');
    await expect(
      first.addSkipTurns(room.id, a.playerId, 1, 'PLOT_REST', bank.token, 'blank-skip-reason', '   '),
    ).rejects.toThrow('REASON_REQUIRED');

    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ remainingSkipTurns: 0 });
    expect(await firstDb.skipTurnEntry.count({ where: { roomId: room.id, playerId: a.playerId } })).toBe(0);
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'MANUAL_SKIP_TURNS_CHANGE' } })).toBe(0);
    expect(await firstDb.idempotencyRecord.count({ where: { scope: `room:${room.id}:add-skip-turns` } })).toBe(0);
  });

  it('allows bank skip consumption in electronic mode', async () => {
    const room = await first.createRoom({ name: '电子停轮人工扣减', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    const entry = await first.addSkipTurns(room.id, a.playerId, 1, 'PLOT_REST', bank.token, 'electronic-skip-entry', '测试电子模式人工停轮');

    const consumed = await first.consumeSkip(room.id, a.playerId, 1, bank.token, 'manual-electronic-consume', '电子模式银行人工扣减');

    expect(consumed).toMatchObject({ remainingSkipTurns: 0, stateVersion: expect.any(Number) });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ remainingSkipTurns: 0 });
    expect(await firstDb.skipTurnEntry.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ remainingCount: 0 });
    expect(await firstDb.auditLog.findFirstOrThrow({ where: { roomId: room.id, action: 'MANUAL_SKIP_TURNS_CHANGE', reason: '电子模式银行人工扣减' } })).toMatchObject({
      beforeJson: { remainingSkipTurns: 1 },
      afterJson: { remainingSkipTurns: 0 },
    });
  });

  it('replays concurrent same-key transfers and rejects a changed payload', async () => {
    const { room, a, b } = await physicalRoom();
    const [left, right] = await Promise.all([
      first.transfer(room.id, { fromPlayerId: a.playerId, recipientType: 'PLAYER', toPlayerId: b.playerId, amount: 300, isPlotFine: false }, 'concurrent-transfer-key'),
      second.transfer(room.id, { fromPlayerId: a.playerId, recipientType: 'PLAYER', toPlayerId: b.playerId, amount: 300, isPlotFine: false }, 'concurrent-transfer-key'),
    ]);

    expect(right).toEqual(left);
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: 4700 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: b.playerId } })).toMatchObject({ balance: 5300 });
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'PLAYER_TRANSFER' } })).toBe(2);
    await expect(
      second.transfer(room.id, { fromPlayerId: a.playerId, recipientType: 'PLAYER', toPlayerId: b.playerId, amount: 301, isPlotFine: false }, 'concurrent-transfer-key'),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });

  it('emits a committed funds callback once for an immediate transfer and never for its replay', async () => {
    const { room, a, b } = await physicalRoom();
    const committed: Array<{ roomId: string; transactionId: string }> = [];
    const game = new PrismaGameService(firstDb, () => 0, {
      fundsCommitted: (roomId, transactionId) => { committed.push({ roomId, transactionId }); },
      requestRejected: () => undefined,
    });
    const actor = state.players.get(a.playerId)!;
    const input = { fromPlayerId: a.playerId, recipientType: 'PLAYER' as const, toPlayerId: b.playerId, amount: 250, isPlotFine: false };

    const result = await game.transfer(actor, room.id, input, 'fund-callback-transfer');
    const replay = await game.transfer(actor, room.id, input, 'fund-callback-transfer');

    expect(replay).toEqual(result);
    expect(committed).toEqual([{ roomId: room.id, transactionId: result.id }]);
  });

  it('transfer lifecycle Toasts follow fresh commits, replay suppression, and safe failure phases', async () => {
    const { room, zhenhuan, huashifei, bank } = await unifiedTransferRoom('转账生命周期通知');
    const committed: Array<{ roomId: string; transactionId: string }> = [];
    const requested: Array<{ roomId: string; requestId: string }> = [];
    const approved: Array<{ roomId: string; requestId: string }> = [];
    const failed: Array<Parameters<NonNullable<import('./realtime-toast-notifications.js').PostCommitToastNotifier['transferFailed']>>[0]> = [];
    let fundsDeliveryFails = false;
    let approvalDeliveryFails = false;
    const game = new PrismaGameService(firstDb, () => 0, {
      fundsCommitted: (roomId, transactionId) => {
        committed.push({ roomId, transactionId });
        if (fundsDeliveryFails) throw new Error('fund delivery unavailable');
      },
      requestRejected: () => undefined,
      landingRejected: () => undefined,
      transferRequested: (roomId, requestId) => { requested.push({ roomId, requestId }); },
      transferApproved: (roomId, requestId) => {
        approved.push({ roomId, requestId });
        if (approvalDeliveryFails) throw new Error('approval delivery unavailable');
      },
      transferFailed: (notice) => { failed.push(notice); },
    });
    const playerActor = state.players.get(zhenhuan.playerId)!;
    const bankActor = state.banks.get(bank.token)!;
    const input = { fromPlayerId: zhenhuan.playerId, recipientType: 'PLAYER' as const, toPlayerId: huashifei.playerId, amount: 200, isPlotFine: false };

    const immediate = await game.transfer(playerActor, room.id, input, 'lifecycle-immediate');
    await game.transfer(playerActor, room.id, input, 'lifecycle-immediate');
    expect(immediate).toMatchObject({ status: 'EXECUTED' });
    expect(committed).toEqual([{ roomId: room.id, transactionId: immediate.id }]);
    expect(requested).toEqual([]);

    await firstDb.room.update({ where: { id: room.id }, data: { transferApprovalRequired: true } });
    const pending = await game.transfer(playerActor, room.id, input, 'lifecycle-pending');
    await game.transfer(playerActor, room.id, input, 'lifecycle-pending');
    expect(pending).toMatchObject({ status: 'PENDING' });
    expect(requested).toEqual([{ roomId: room.id, requestId: pending.id }]);

    fundsDeliveryFails = true;
    approvalDeliveryFails = true;
    const approval = await game.approve(bankActor, room.id, pending.id, 'lifecycle-approve');
    await game.approve(bankActor, room.id, pending.id, 'lifecycle-approve');
    fundsDeliveryFails = false;
    approvalDeliveryFails = false;
    expect(committed.at(-1)).toEqual({ roomId: room.id, transactionId: approval.transactionId });
    expect(approved).toEqual([{ roomId: room.id, requestId: pending.id }]);

    const insufficient = await game.transfer(playerActor, room.id, input, 'lifecycle-insufficient-request');
    await firstDb.player.update({ where: { id: zhenhuan.playerId }, data: { balance: 100 } });
    await expect(game.approve(bankActor, room.id, insufficient.id, 'lifecycle-insufficient-approval')).rejects.toThrow('INSUFFICIENT_BALANCE');
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: insufficient.id } })).toMatchObject({ status: 'PENDING' });
    expect(failed.at(-1)).toEqual({
      phase: 'APPROVAL',
      roomId: room.id,
      requestId: insufficient.id,
      attemptId: expect.stringMatching(/^[a-f0-9]{24}$/),
      reasonCode: 'INSUFFICIENT_BALANCE',
    });

    await firstDb.player.update({ where: { id: zhenhuan.playerId }, data: { balance: 5_000 } });
    await firstDb.player.update({ where: { id: huashifei.playerId }, data: { status: 'LEFT' } });
    const approvalModeFailure = await game.transfer(playerActor, room.id, input, 'lifecycle-submission-failure').catch((error: unknown) => error);
    expect(approvalModeFailure).toBeInstanceOf(TransferRuleError);
    expect(approvalModeFailure).toMatchObject({ code: 'PLAYER_NOT_FOUND', transferApprovalRequired: true });
    expect(failed.at(-1)).toEqual({
      phase: 'SUBMISSION',
      roomId: room.id,
      playerId: zhenhuan.playerId,
      attemptId: expect.stringMatching(/^[a-f0-9]{24}$/),
      reasonCode: 'PLAYER_NOT_FOUND',
    });

    const failureCount = failed.length;
    await firstDb.room.update({ where: { id: room.id }, data: { transferApprovalRequired: false } });
    const immediateModeFailure = await game.transfer(playerActor, room.id, input, 'lifecycle-immediate-failure').catch((error: unknown) => error);
    expect(immediateModeFailure).toBeInstanceOf(TransferRuleError);
    expect(immediateModeFailure).toMatchObject({ code: 'PLAYER_NOT_FOUND', transferApprovalRequired: false });
    expect(failed).toHaveLength(failureCount);
  });

  it('uses live transfer approval mode in one playing room after admin false true false updates', async () => {
    const { room, zhenhuan, huashifei } = await unifiedTransferRoom('运行中实时审批模式');
    const game = new PrismaGameService(firstDb, () => 0);
    const accounts = new AccountRoomService(firstDb, () => true);
    const playerActor = state.players.get(zhenhuan.playerId)!;
    const input = { fromPlayerId: zhenhuan.playerId, recipientType: 'PLAYER' as const, toPlayerId: huashifei.playerId, amount: 100, isPlotFine: false };

    const firstResult = await game.transfer(playerActor, room.id, input, 'live-mode-off-1');
    await accounts.updateAdminRoom(state.creator, room.id, { transferApprovalRequired: true }, 'live-mode-on');
    const secondResult = await game.transfer(playerActor, room.id, input, 'live-mode-on-1');
    await accounts.updateAdminRoom(state.creator, room.id, { transferApprovalRequired: false }, 'live-mode-off');
    const thirdResult = await game.transfer(playerActor, room.id, input, 'live-mode-off-2');

    expect(firstResult.status).toBe('EXECUTED');
    expect(secondResult.status).toBe('PENDING');
    expect(thirdResult.status).toBe('EXECUTED');
    expect(await firstDb.room.findUniqueOrThrow({ where: { id: room.id } })).toMatchObject({
      status: 'PLAYING',
      transferApprovalRequired: false,
    });
  });

  it('emits a committed funds callback once for START_REWARD approval and never for its replay', async () => {
    const { room, a, bank } = await physicalRoom();
    const committed: Array<{ roomId: string; transactionId: string }> = [];
    const game = new PrismaGameService(firstDb, () => 0, {
      fundsCommitted: (roomId, transactionId) => { committed.push({ roomId, transactionId }); },
      requestRejected: () => undefined,
    });
    const landing = await first.declareStartLanding(room.id, a.playerId, 'notify-start-reward-landing', a.token, 'notify-start-reward-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const request = await first.createRequest(room.id, a.playerId, { type: 'START_REWARD', landingId: landing.id }, 'notify-start-reward-request');
    const bankActor = state.banks.get(bank.token)!;

    const approved = await game.approve(bankActor, room.id, request.id, 'notify-start-reward-approval');
    const replay = await game.approve(bankActor, room.id, request.id, 'notify-start-reward-approval');

    expect(replay).toEqual(approved);
    expect(committed).toEqual([{ roomId: room.id, transactionId: approved.transactionId }]);
  });

  it('notifies the player once when landing property actions are cancelled', async () => {
    const { room, a, bank } = await physicalRoom();
    const rejected: Array<{ roomId: string; landingId: string; reason: string }> = [];
    const game = new PrismaGameService(firstDb, () => 0, {
      fundsCommitted: () => undefined,
      requestRejected: () => undefined,
      landingRejected: (roomId, landingId, reason) => { rejected.push({ roomId, landingId, reason }); },
    });
    const landing = await firstDb.landingEvent.findFirstOrThrow({
      where: { roomId: room.id, playerId: a.playerId, property: { definition: { name: '甘露寺' } } },
      orderBy: { confirmedAt: 'desc' },
    });
    const bankActor = state.banks.get(bank.token)!;

    await game.cancelLandingPropertyActions(bankActor, room.id, landing.id, '现场落点有误', 'notify-cancelled-landing');
    await game.cancelLandingPropertyActions(bankActor, room.id, landing.id, '现场落点有误', 'notify-cancelled-landing');

    expect(rejected).toEqual([{ roomId: room.id, landingId: landing.id, reason: '现场落点有误' }]);
  });

  it('emits post-commit callbacks once for every money command and for a rejection', async () => {
    const { room, a, b, bank } = await physicalRoom();
    const committed: Array<{ roomId: string; transactionId: string }> = [];
    const rejected: Array<{ roomId: string; requestId: string }> = [];
    const game = new PrismaGameService(firstDb, () => 0, {
      fundsCommitted: (roomId, transactionId) => { committed.push({ roomId, transactionId }); },
      requestRejected: (roomId, requestId) => { rejected.push({ roomId, requestId }); },
    });
    const bankActor = state.banks.get(bank.token)!;
    const playerActor = state.players.get(a.playerId)!;

    const adjustment = await game.adjustBalance(bankActor, room.id, a.playerId, 100, '通知测试', 'notify-adjust');
    await game.adjustBalance(bankActor, room.id, a.playerId, 100, '通知测试', 'notify-adjust');
    expect(committed.at(-1)).toEqual({ roomId: room.id, transactionId: adjustment.id });

    const reversal = await game.reverseLatest(bankActor, room.id, adjustment.id, '通知撤销测试', 'notify-reversal');
    await game.reverseLatest(bankActor, room.id, adjustment.id, '通知撤销测试', 'notify-reversal');
    expect(committed.at(-1)).toEqual({ roomId: room.id, transactionId: reversal.reversalTransactionId });

    await firstDb.roomProperty.updateMany({
      where: { roomId: room.id, definition: { name: '甘露寺' } },
      data: { ownerPlayerId: b.playerId },
    });
    const toll = await game.payToll(playerActor, room.id, a.playerId, '甘露寺', 'notify-toll');
    await game.payToll(playerActor, room.id, a.playerId, '甘露寺', 'notify-toll');
    expect(committed.at(-1)).toEqual({ roomId: room.id, transactionId: toll.id });

    const fine = await game.plotFine(bankActor, room.id, a.playerId, 100, 'notify-fine');
    await game.plotFine(bankActor, room.id, a.playerId, 100, 'notify-fine');
    expect(committed.at(-1)).toEqual({ roomId: room.id, transactionId: fine.id });

    const paymentRequest = await game.requestBankPayment(playerActor, room.id, a.playerId, 200, 'notify-approval-request');
    const approval = await game.approve(bankActor, room.id, paymentRequest.id, 'notify-approval');
    await game.approve(bankActor, room.id, paymentRequest.id, 'notify-approval');
    expect(committed.at(-1)).toEqual({ roomId: room.id, transactionId: approval.transactionId });

    const rejectedRequest = await game.requestBankPayment(playerActor, room.id, a.playerId, 200, 'notify-rejection-request');
    await game.reject(bankActor, room.id, rejectedRequest.id, '金额有误', 'notify-rejection');
    await game.reject(bankActor, room.id, rejectedRequest.id, '金额有误', 'notify-rejection');
    expect(rejected).toEqual([{ roomId: room.id, requestId: rejectedRequest.id }]);

    const restRequest = await game.createRequest(playerActor, room.id, a.playerId, { type: 'PLOT_REST_EVENT', count: 1, reason: '通知零分录测试' }, 'notify-zero-request');
    const restApproval = await game.approve(bankActor, room.id, restRequest.id, 'notify-zero-approval');
    await game.approve(bankActor, room.id, restRequest.id, 'notify-zero-approval');
    expect(committed.at(-1)).toEqual({ roomId: room.id, transactionId: restApproval.transactionId });
    await expect(buildFundToastDeliveries(firstDb, restApproval.transactionId)).resolves.toEqual([]);

    const skillRoom = await first.createRoom({ name: '现金技能通知', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const yixiu = await first.joinPlayer(skillRoom.code, '宜修', 'yixiu');
    await first.joinPlayer(skillRoom.code, '甄嬛', 'zhenhuan');
    const skillBank = await first.joinBank(skillRoom.code, '技能银行');
    await first.start(skillRoom.id, skillBank.token, 'notify-skill-start');
    const skillGame = new PrismaGameService(firstDb, () => 0, {
      fundsCommitted: (roomId, transactionId) => { committed.push({ roomId, transactionId }); },
      requestRejected: () => undefined,
    });
    const skillResult = await skillGame.addSkipTurns(state.banks.get(skillBank.token)!, skillRoom.id, yixiu.playerId, 2, 'COLD_PALACE', 'notify-skill', '现金技能通知');
    await skillGame.addSkipTurns(state.banks.get(skillBank.token)!, skillRoom.id, yixiu.playerId, 2, 'COLD_PALACE', 'notify-skill', '现金技能通知');
    expect(committed.at(-1)).toEqual({ roomId: skillRoom.id, transactionId: skillResult.transactionId });

    expect(committed).toHaveLength(7);
  });

  it('keeps a committed transfer successful when toast delivery fails', async () => {
    const { room, a, b } = await physicalRoom();
    const game = new PrismaGameService(firstDb, () => 0, {
      fundsCommitted: () => { throw new Error('delivery unavailable'); },
      requestRejected: () => undefined,
    });
    const input = { fromPlayerId: a.playerId, recipientType: 'PLAYER' as const, toPlayerId: b.playerId, amount: 250, isPlotFine: false };

    const result = await game.transfer(state.players.get(a.playerId)!, room.id, input, 'notify-failure-transfer');
    await expect(game.transfer(state.players.get(a.playerId)!, room.id, input, 'notify-failure-transfer')).resolves.toEqual(result);
    expect(await firstDb.gameTransaction.count({ where: { id: result.id } })).toBe(1);
  });

  it('unified transfer immediately settles player and bank recipients when approval is disabled', async () => {
    const { room, zhenhuan, huashifei } = await unifiedTransferRoom();

    const playerTransfer = await first.transfer(room.id, {
      fromPlayerId: zhenhuan.playerId,
      recipientType: 'PLAYER',
      toPlayerId: huashifei.playerId,
      amount: 400,
      isPlotFine: false,
    }, 'unified-player-immediate');
    const bankTransfer = await first.transfer(room.id, {
      fromPlayerId: huashifei.playerId,
      recipientType: 'BANK',
      amount: 250,
      isPlotFine: false,
    }, 'unified-bank-immediate');

    expect(playerTransfer).toMatchObject({ amount: 400, status: 'EXECUTED' });
    expect(bankTransfer).toMatchObject({ amount: 250, status: 'EXECUTED' });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).toMatchObject({ balance: 4600 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: huashifei.playerId } })).toMatchObject({ balance: 5150 });
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, transactionId: playerTransfer.id, type: 'PLAYER_TRANSFER' } })).toBe(2);
    expect(await firstDb.ledgerEntry.findFirstOrThrow({ where: { roomId: room.id, transactionId: bankTransfer.id } })).toMatchObject({
      playerId: huashifei.playerId,
      amount: -250,
      type: 'PLAYER_BANK_PAYMENT',
    });
  });

  it('unified transfer applies the configured Meizhuang plot-fine reduction to player and bank recipients', async () => {
    const { room, meizhuang, zhenhuan } = await unifiedTransferRoom('统一转帐沈眉庄减免');

    const playerTransfer = await first.transfer(room.id, {
      fromPlayerId: meizhuang.playerId,
      recipientType: 'PLAYER',
      toPlayerId: zhenhuan.playerId,
      amount: 500,
      isPlotFine: true,
    }, 'unified-meizhuang-player-fine');
    const bankTransfer = await first.transfer(room.id, {
      fromPlayerId: meizhuang.playerId,
      recipientType: 'BANK',
      amount: 500,
      isPlotFine: true,
    }, 'unified-meizhuang-bank-fine');

    expect(playerTransfer).toMatchObject({ originalAmount: 500, reduction: 200, amount: 300, status: 'EXECUTED' });
    expect(bankTransfer).toMatchObject({ originalAmount: 500, reduction: 200, amount: 300, status: 'EXECUTED' });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: meizhuang.playerId } })).toMatchObject({ balance: 4400 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).toMatchObject({ balance: 5300 });
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'PLOT_FINE' } })).toBe(3);
    expect(await firstDb.gameTransaction.findUniqueOrThrow({ where: { id: bankTransfer.id } })).toMatchObject({
      type: 'PLOT_FINE',
      metadata: expect.objectContaining({ recipientType: 'BANK', originalAmount: 500, reduction: 200, actualAmount: 300, isPlotFine: true }),
    });
  });

  it('unified transfer does not reduce plot fines when skills are disabled or the payer is not Meizhuang', async () => {
    const { room, meizhuang, zhenhuan } = await unifiedTransferRoom('统一转帐技能边界');
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: false } });

    const disabledSkill = await first.transfer(room.id, {
      fromPlayerId: meizhuang.playerId,
      recipientType: 'BANK',
      amount: 500,
      isPlotFine: true,
    }, 'unified-disabled-skill-fine');
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: true } });
    const otherCharacter = await first.transfer(room.id, {
      fromPlayerId: zhenhuan.playerId,
      recipientType: 'BANK',
      amount: 500,
      isPlotFine: true,
    }, 'unified-non-meizhuang-fine');

    expect(disabledSkill).toMatchObject({ originalAmount: 500, reduction: 0, amount: 500 });
    expect(otherCharacter).toMatchObject({ originalAmount: 500, reduction: 0, amount: 500 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: meizhuang.playerId } })).toMatchObject({ balance: 4500 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).toMatchObject({ balance: 4500 });
  });

  it('unified transfer rejects inconsistent recipient inputs without creating a transaction', async () => {
    const { room, zhenhuan, huashifei } = await unifiedTransferRoom('统一转帐收款参数校验');
    const before = await firstDb.gameTransaction.count({ where: { roomId: room.id } });

    await expect(first.transfer(room.id, {
      fromPlayerId: zhenhuan.playerId,
      recipientType: 'BANK',
      toPlayerId: huashifei.playerId,
      amount: 100,
      isPlotFine: false,
    }, 'unified-bank-with-player')).rejects.toThrow('INVALID_TRANSFER');
    await expect(first.transfer(room.id, {
      fromPlayerId: zhenhuan.playerId,
      recipientType: 'PLAYER',
      amount: 100,
      isPlotFine: false,
    }, 'unified-player-without-target')).rejects.toThrow('INVALID_TRANSFER');
    await expect(first.transfer(room.id, {
      fromPlayerId: zhenhuan.playerId,
      recipientType: 'PLAYER',
      toPlayerId: zhenhuan.playerId,
      amount: 100,
      isPlotFine: false,
    }, 'unified-self-transfer')).rejects.toThrow('INVALID_TRANSFER');

    expect(await firstDb.gameTransaction.count({ where: { roomId: room.id } })).toBe(before);
  });

  it('unified transfer rolls back the recipient and ledger when the payer balance is insufficient', async () => {
    const { room, zhenhuan, huashifei } = await unifiedTransferRoom('统一转帐余额不足');
    await firstDb.player.update({ where: { id: zhenhuan.playerId }, data: { balance: 100 } });

    await expect(first.transfer(room.id, {
      fromPlayerId: zhenhuan.playerId,
      recipientType: 'PLAYER',
      toPlayerId: huashifei.playerId,
      amount: 500,
      isPlotFine: false,
    }, 'unified-insufficient-player')).rejects.toThrow('INSUFFICIENT_BALANCE');

    expect(await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).toMatchObject({ balance: 100 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: huashifei.playerId } })).toMatchObject({ balance: 5000 });
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'PLAYER_TRANSFER' } })).toBe(0);
  });

  it('unified transfer and bank plot fine use the same configured authoritative amount', async () => {
    const { room, meizhuang, bank } = await unifiedTransferRoom('统一转帐与银行剧情罚款一致');
    const unified = await first.transfer(room.id, {
      fromPlayerId: meizhuang.playerId,
      recipientType: 'BANK',
      amount: 500,
      isPlotFine: true,
    }, 'unified-authoritative-fine');
    const bankEntered = await first.plotFine(room.id, meizhuang.playerId, 500, 'bank-authoritative-fine', bank.token);

    expect(unified).toMatchObject({ originalAmount: 500, reduction: 200, amount: 300 });
    expect(bankEntered).toMatchObject({ originalAmount: 500, reduction: 200, amount: 300 });
  });

  it('transfer approval creates pending player and bank requests without changing balances', async () => {
    const { room, meizhuang, zhenhuan, huashifei } = await unifiedTransferRoom('统一转帐审批请求');
    await firstDb.room.update({ where: { id: room.id }, data: { transferApprovalRequired: true } });

    const playerRequest = await first.transfer(room.id, {
      fromPlayerId: meizhuang.playerId,
      recipientType: 'PLAYER',
      toPlayerId: zhenhuan.playerId,
      amount: 500,
      isPlotFine: true,
    }, 'approval-player-request');
    const bankRequest = await first.transfer(room.id, {
      fromPlayerId: huashifei.playerId,
      recipientType: 'BANK',
      amount: 250,
      isPlotFine: false,
    }, 'approval-bank-request');

    expect(playerRequest).toMatchObject({ type: 'PLAYER_TRANSFER', status: 'PENDING', originalAmount: 500, reduction: 200, amount: 300 });
    expect(bankRequest).toMatchObject({ type: 'PLAYER_TRANSFER', status: 'PENDING', originalAmount: 250, reduction: 0, amount: 250 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: meizhuang.playerId } })).toMatchObject({ balance: 5000 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).toMatchObject({ balance: 5000 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: huashifei.playerId } })).toMatchObject({ balance: 5000 });
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: playerRequest.id } })).toMatchObject({
      type: 'PLAYER_TRANSFER',
      actorPlayerId: meizhuang.playerId,
      targetPlayerId: zhenhuan.playerId,
      amount: 300,
      payload: expect.objectContaining({ recipientType: 'PLAYER', originalAmount: 500, reduction: 200, actualAmount: 300, isPlotFine: true }),
    });
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: bankRequest.id } })).toMatchObject({
      type: 'PLAYER_TRANSFER',
      actorPlayerId: huashifei.playerId,
      targetPlayerId: null,
      amount: 250,
      payload: expect.objectContaining({ recipientType: 'BANK', originalAmount: 250, reduction: 0, actualAmount: 250, isPlotFine: false }),
    });
  });

  it('transfer approval settles both recipient types once and replays repeated approval', async () => {
    const { room, meizhuang, zhenhuan, huashifei, bank } = await unifiedTransferRoom('统一转帐批准结算');
    await firstDb.room.update({ where: { id: room.id }, data: { transferApprovalRequired: true } });
    const playerRequest = await first.transfer(room.id, {
      fromPlayerId: meizhuang.playerId,
      recipientType: 'PLAYER',
      toPlayerId: zhenhuan.playerId,
      amount: 500,
      isPlotFine: true,
    }, 'approval-settle-player');
    const bankRequest = await first.transfer(room.id, {
      fromPlayerId: huashifei.playerId,
      recipientType: 'BANK',
      amount: 250,
      isPlotFine: false,
    }, 'approval-settle-bank');

    const playerApproval = await first.approve(room.id, playerRequest.id, bank.token, 'approve-player-transfer');
    const replay = await second.approve(room.id, playerRequest.id, bank.token, 'approve-player-transfer-again');
    const bankApproval = await first.approve(room.id, bankRequest.id, bank.token, 'approve-bank-transfer');

    expect(replay).toMatchObject({ id: playerRequest.id, status: 'EXECUTED', transactionId: playerApproval.transactionId });
    expect(bankApproval).toMatchObject({ id: bankRequest.id, status: 'EXECUTED' });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: meizhuang.playerId } })).toMatchObject({ balance: 4700 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).toMatchObject({ balance: 5300 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: huashifei.playerId } })).toMatchObject({ balance: 4750 });
    expect(await firstDb.gameTransaction.count({ where: { roomId: room.id, requestId: playerRequest.id } })).toBe(1);
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, transactionId: playerApproval.transactionId } })).toBe(2);
    expect(await firstDb.ledgerEntry.findFirstOrThrow({ where: { roomId: room.id, transactionId: bankApproval.transactionId } })).toMatchObject({ type: 'PLAYER_BANK_PAYMENT', amount: -250 });
  });

  it('transfer approval deduplicates repeated submission and rejects a changed payload', async () => {
    const { room, meizhuang } = await unifiedTransferRoom('统一转帐提交幂等');
    await firstDb.room.update({ where: { id: room.id }, data: { transferApprovalRequired: true } });
    const input = { fromPlayerId: meizhuang.playerId, recipientType: 'BANK' as const, amount: 500, isPlotFine: true };

    const [left, right] = await Promise.all([
      first.transfer(room.id, input, 'approval-submit-key'),
      second.transfer(room.id, input, 'approval-submit-key'),
    ]);

    expect(right).toEqual(left);
    expect(await firstDb.gameRequest.count({ where: { roomId: room.id, type: 'PLAYER_TRANSFER' } })).toBe(1);
    await expect(second.transfer(room.id, { ...input, amount: 501 }, 'approval-submit-key')).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  });

  it('transfer approval rejection leaves balances unchanged', async () => {
    const { room, zhenhuan, bank } = await unifiedTransferRoom('统一转帐拒绝');
    await firstDb.room.update({ where: { id: room.id }, data: { transferApprovalRequired: true } });
    const request = await first.transfer(room.id, {
      fromPlayerId: zhenhuan.playerId,
      recipientType: 'BANK',
      amount: 400,
      isPlotFine: false,
    }, 'approval-reject-request');

    await first.reject(room.id, request.id, bank.token, '银行拒绝转帐', 'approval-reject');

    expect(await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).toMatchObject({ balance: 5000 });
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'REJECTED', rejectionReason: '银行拒绝转帐' });
    expect(await firstDb.gameTransaction.count({ where: { requestId: request.id } })).toBe(0);
  });

  it('transfer approval rolls back its claim when the payer becomes insufficient before approval', async () => {
    const { room, zhenhuan, huashifei, bank } = await unifiedTransferRoom('统一转帐批准时余额不足');
    await firstDb.room.update({ where: { id: room.id }, data: { transferApprovalRequired: true } });
    const request = await first.transfer(room.id, {
      fromPlayerId: zhenhuan.playerId,
      recipientType: 'PLAYER',
      toPlayerId: huashifei.playerId,
      amount: 500,
      isPlotFine: false,
    }, 'approval-insufficient-request');
    await firstDb.player.update({ where: { id: zhenhuan.playerId }, data: { balance: 100 } });

    await expect(first.approve(room.id, request.id, bank.token, 'approval-insufficient')).rejects.toThrow('INSUFFICIENT_BALANCE');

    expect(await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).toMatchObject({ balance: 100 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: huashifei.playerId } })).toMatchObject({ balance: 5000 });
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'PENDING', approvedByMemberId: null, approvedAt: null, resolvedAt: null });
    expect(await firstDb.gameTransaction.count({ where: { requestId: request.id } })).toBe(0);
  });

  it('transfer approval snapshot exposes authoritative transfer details after bank reconnect', async () => {
    const { room, meizhuang } = await unifiedTransferRoom('统一转帐审批快照');
    await firstDb.room.update({ where: { id: room.id }, data: { transferApprovalRequired: true } });
    const request = await first.transfer(room.id, {
      fromPlayerId: meizhuang.playerId,
      recipientType: 'BANK',
      amount: 500,
      isPlotFine: true,
    }, 'approval-snapshot-request');

    const snapshot = await second.snapshot(room.id);
    expect(snapshot.requests.find((item) => item.id === request.id)).toMatchObject({
      type: 'PLAYER_TRANSFER',
      playerId: meizhuang.playerId,
      targetPlayerId: null,
      recipientType: 'BANK',
      originalAmount: 500,
      reduction: 200,
      actualAmount: 300,
      amount: 300,
      isPlotFine: true,
      status: 'PENDING',
    });
  });

  it('rejects a request idempotency key reused with a different payload', async () => {
    const { room, a } = await physicalRoom();
    const original = await first.requestBankPayment(room.id, a.playerId, 100, 'bank-payment-payload-key');

    await expect(
      second.requestBankPayment(room.id, a.playerId, 200, 'bank-payment-payload-key'),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    expect(await firstDb.gameRequest.findMany({ where: { roomId: room.id, idempotencyKey: { endsWith: ':bank-payment-payload-key' } } })).toEqual([
      expect.objectContaining({ id: original.id, amount: 100 }),
    ]);
  });

  it('deduplicates a repeated forced turn advance', async () => {
    const room = await first.createRoom({ name: '强制换轮幂等', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');

    const firstAdvance = await first.forceNext(room.id, bank.token, '现场修正', 'force-next-once');
    const repeatedAdvance = await second.forceNext(room.id, bank.token, '现场修正', 'force-next-once');
    expect(repeatedAdvance.id).toBe(firstAdvance.id);
    expect((await firstDb.room.findUniqueOrThrow({ where: { id: room.id } })).turnNumber).toBe(2);
    expect(await firstDb.turn.count({ where: { roomId: room.id } })).toBe(2);
  });

  it('cancels and unlocks the old turn request when forcing the next turn', async () => {
    const room = await first.createRoom({ name: '强制换轮取消请求', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'roll-before-force-next');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'one-landing-electronic');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const request = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'buy-before-force-next');

    await first.forceNext(room.id, bank.token, '现场强制换轮', 'force-next-with-request');

    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).lockedByRequestId).toBeNull();
  });

  it('skips an electronic turn through the dedicated command', async () => {
    const room = await first.createRoom({ name: '电子停轮测试', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    const b = await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.addSkipTurns(room.id, b.playerId, 1, 'PLOT_REST', bank.token, 'skip-b-once', '测试停轮');

    await first.roll(room.id, a.playerId, 'roll-before-skipped-player');
    const advanced = await first.endTurn(room.id, a.playerId, 'advance-over-skipped-player');
    expect(advanced).toMatchObject({ number: 3, playerId: a.playerId });
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: b.playerId } })).remainingSkipTurns).toBe(0);
    expect(await firstDb.turn.findFirst({ where: { roomId: room.id, turnNumber: 2 } })).toMatchObject({ playerId: b.playerId, status: 'ENDED', diceValue: null });

    await first.addSkipTurns(room.id, a.playerId, 1, 'PLOT_REST', bank.token, 'block-current-player', '测试当前玩家停轮');
    await expect(first.roll(room.id, a.playerId, 'blocked-roll')).rejects.toThrow('PLAYER_MUST_SKIP_TURN');
    await expect(first.endTurn(room.id, a.playerId, 'end-blocked-current-player')).rejects.toThrow('ROLL_REQUIRED');
    const skipped = await first.skipTurn(room.id, a.playerId, 'skip-blocked-current-player');
    expect(skipped).toMatchObject({ number: 4, playerId: b.playerId });
    expect(await firstDb.turn.findFirst({ where: { roomId: room.id, turnNumber: 3 } })).toMatchObject({ playerId: a.playerId, status: 'ENDED', diceValue: null });
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).remainingSkipTurns).toBe(0);
  });

  it('allows a stopwheel deduction request in an electronic game', async () => {
    const room = await first.createRoom({ name: '电子扣减停轮测试', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.addSkipTurns(room.id, a.playerId, 1, 'PLOT_REST', bank.token, 'add-skip', '剧情停留');

    const request = await first.createRequest(room.id, a.playerId, { type: 'CONSUME_SKIP_TURNS', count: 1 }, 'electronic-consume-request');
    expect(request).toMatchObject({
      type: 'CONSUME_SKIP_TURNS',
      status: 'PENDING',
    });
    await expect(first.approve(room.id, request.id, bank.token, 'approve-electronic-consume')).resolves.toMatchObject({ status: 'EXECUTED' });
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).remainingSkipTurns).toBe(0);
  });

  it('requires settling an actual toll before ending the electronic turn', async () => {
    const room = await first.createRoom({ name: '电子过路费结算', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const payer = await first.joinPlayer(room.code, '过路玩家', 'zhenhuan');
    const owner = await first.joinPlayer(room.code, '地产主人', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: owner.playerId } });
    await first.roll(room.id, payer.playerId, 'toll-required-roll');
    const landing = await first.declareLanding(room.id, payer.playerId, '甘露寺', payer.token, 'toll-required-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);

    await expect(first.endTurn(room.id, payer.playerId, 'end-with-unpaid-toll')).rejects.toThrow('TOLL_REQUIRED');
    expect(await firstDb.turn.findFirstOrThrow({ where: { roomId: room.id, status: 'ACTIVE' } })).toMatchObject({ playerId: payer.playerId });
  });

  it('requires a reversed toll to be paid again before ending the electronic turn', async () => {
    const room = await first.createRoom({ name: '过路费冲正重付', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const payer = await first.joinPlayer(room.code, '过路玩家', 'zhenhuan');
    const owner = await first.joinPlayer(room.code, '地产主人', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-reversed-toll-room');
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: owner.playerId } });
    await first.roll(room.id, payer.playerId, 'reversed-toll-roll');
    const landing = await first.declareLanding(room.id, payer.playerId, '甘露寺', payer.token, 'reversed-toll-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);

    const original = await first.payToll(room.id, payer.playerId, '甘露寺', 'original-toll-payment');
    await first.reverseLatest(room.id, original.id, bank.token, '过路费录入错误', 'reverse-toll-payment');

    await expect(first.endTurn(room.id, payer.playerId, 'end-after-reversed-toll')).rejects.toThrow('TOLL_REQUIRED');
    const repaid = await first.payToll(room.id, payer.playerId, '甘露寺', 'replacement-toll-payment');
    expect(repaid).toMatchObject({ amount: original.amount });
    expect(repaid.id).not.toBe(original.id);
    await expect(first.endTurn(room.id, payer.playerId, 'end-after-repaid-toll')).resolves.toMatchObject({ number: 2 });
    expect(await firstDb.gameTransaction.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ status: 'REVERSED' });
    expect(await firstDb.gameTransaction.findUniqueOrThrow({ where: { id: repaid.id } })).toMatchObject({ status: 'COMMITTED' });
  });

  it('does not reverse a toll after its electronic turn has ended', async () => {
    const room = await first.createRoom({ name: '过路费回合依赖', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const payer = await first.joinPlayer(room.code, '过路玩家', 'zhenhuan');
    const owner = await first.joinPlayer(room.code, '地产主人', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-toll-dependency-room');
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: owner.playerId } });
    await first.roll(room.id, payer.playerId, 'toll-dependency-roll');
    const landing = await first.declareLanding(room.id, payer.playerId, '甘露寺', payer.token, 'toll-dependency-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const toll = await first.payToll(room.id, payer.playerId, '甘露寺', 'toll-before-ended-turn');

    await first.endTurn(room.id, payer.playerId, 'end-after-committed-toll');

    await expect(
      first.reverseLatest(room.id, toll.id, bank.token, '回合结束后不应冲正', 'reverse-ended-turn-toll'),
    ).rejects.toThrow('NO_REVERSIBLE_TRANSACTION');
    expect(await firstDb.gameTransaction.findUniqueOrThrow({ where: { id: toll.id } })).toMatchObject({ status: 'COMMITTED', reversible: false });
  });

  it('serializes toll reversal against ending the associated turn', async () => {
    const room = await first.createRoom({ name: '过路费结束冲正竞争', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const payer = await first.joinPlayer(room.code, '过路玩家', 'zhenhuan');
    const owner = await first.joinPlayer(room.code, '地产主人', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-toll-race-room');
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: owner.playerId } });
    await first.roll(room.id, payer.playerId, 'toll-race-roll');
    const landing = await first.declareLanding(room.id, payer.playerId, '甘露寺', payer.token, 'toll-race-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const toll = await first.payToll(room.id, payer.playerId, '甘露寺', 'toll-before-end-reverse-race');

    const attempts = await Promise.allSettled([
      first.endTurn(room.id, payer.playerId, 'end-turn-toll-race'),
      second.reverseLatest(room.id, toll.id, bank.token, '并发冲正', 'reverse-toll-race'),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const storedToll = await firstDb.gameTransaction.findUniqueOrThrow({ where: { id: toll.id } });
    const originalTurn = await firstDb.turn.findFirstOrThrow({ where: { roomId: room.id, turnNumber: 1 } });
    if (storedToll.status === 'COMMITTED') {
      expect(storedToll.reversible).toBe(false);
      expect(originalTurn.status).toBe('ENDED');
    } else {
      expect(storedToll.status).toBe('REVERSED');
      expect(originalTurn.status).toBe('ACTIVE');
    }
  });

  it('requires every player to select one of the five characters', async () => {
    const room = await first.createRoom({ name: '五人房', initialBalance: 5000, diceMode: 'PHYSICAL' });
    await expect(first.joinPlayer(room.code, '空角色', null)).rejects.toThrow('CHARACTER_REQUIRED');
    for (const [index, characterId] of ['yixiu', 'huashifei', 'meizhuang', 'anlingrong', 'zhenhuan'].entries()) {
      await first.joinPlayer(room.code, `玩家${index + 1}`, characterId);
    }
    await expect(first.joinPlayer(room.code, '第六人', 'zhenhuan')).rejects.toThrow('ROLE_ALREADY_TAKEN');
  });

  it('rejects balance operations with a player from another room', async () => {
    const { room, a, bank } = await physicalRoom();
    const otherRoom = await first.createRoom({ name: '其他房间', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const outsider = await first.joinPlayer(otherRoom.code, '外部玩家', 'meizhuang');

    await expect(first.transfer(room.id, { fromPlayerId: a.playerId, recipientType: 'PLAYER', toPlayerId: outsider.playerId, amount: 100, isPlotFine: false }, 'cross-room-transfer')).rejects.toThrow('PLAYER_NOT_FOUND');
    await expect(first.adjustBalance(room.id, outsider.playerId, 100, bank.token, '跨房间修正', 'cross-room-adjust')).rejects.toThrow('PLAYER_NOT_FOUND');
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: outsider.playerId } })).balance).toBe(5000);
  });

  it('replaces an unconfirmed electronic landing when the player corrects it', async () => {
    const room = await first.createRoom({ name: '单落点测试', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'roll-for-one-landing');
    const firstLanding = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'first-electronic-landing');
    const correctedLanding = await first.declareLanding(room.id, a.playerId, '景仁宫', a.token, 'corrected-electronic-landing');

    expect(correctedLanding).toMatchObject({ status: 'DECLARED' });
    expect(correctedLanding.id).not.toBe(firstLanding.id);
    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: firstLanding.id } })).toMatchObject({ status: 'INVALIDATED' });
    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: correctedLanding.id }, include: { property: { include: { definition: true } } } })).toMatchObject({
      status: 'DECLARED',
      property: { definition: { name: '景仁宫' } },
    });
  });

  it('refuses to confirm an electronic landing after its roll is no longer valid', async () => {
    const room = await first.createRoom({ name: '失效落点确认', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'roll-before-stale-confirm');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'stale-confirm-landing');
    await firstDb.turn.updateMany({ where: { roomId: room.id, status: 'ACTIVE' }, data: { die1: null, die2: null, diceValue: null, rolledAt: null } });

    await expect(first.confirmLanding(room.id, landing.id, bank.token, true)).rejects.toThrow('LANDING_TURN_EXPIRED');
  });

  it('leaves no active landing when declaration races roll invalidation', async () => {
    const room = await first.createRoom({ name: '落点并发失效', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'roll-before-declare-invalidate-race');

    const attempts = await Promise.allSettled([
      first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'declare-invalidate-race'),
      second.invalidateRoll(room.id, bank.token, '并发作废骰子')
    ]);
    if (attempts[1].status === 'rejected') await second.invalidateRoll(room.id, bank.token, '并发作废骰子重试');

    expect(await firstDb.turn.findFirstOrThrow({ where: { roomId: room.id, status: 'ACTIVE' } })).toMatchObject({ diceValue: null });
    expect(await firstDb.landingEvent.count({ where: { roomId: room.id, status: { in: ['DECLARED', 'CONFIRMED'] } } })).toBe(0);
    const landings = await firstDb.landingEvent.findMany({ where: { roomId: room.id } });
    expect(landings.every((landing) => landing.status === 'INVALIDATED')).toBe(true);
  });

  it('reverses with a separate compensation transaction and ledger', async () => {
    const { room, a, bank } = await physicalRoom();
    const adjustment = await first.adjustBalance(room.id, a.playerId, 300, bank.token, '补录奖励', 'adjust-for-reverse');
    const reversal = await first.reverseLatest(room.id, adjustment.id, bank.token, '录入错误', 'reverse-once');
    const repeated = await second.reverseLatest(room.id, adjustment.id, bank.token, '录入错误', 'reverse-once');
    expect(repeated).toEqual(reversal);
    expect(reversal.reversalTransactionId).not.toBe(reversal.id);
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).balance).toBe(5000);
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'REVERSAL' } })).toBe(1);
    if (typeof reversal.reversalTransactionId !== 'string') throw new Error('REVERSAL_TRANSACTION_ID_MISSING');
    expect((await firstDb.gameTransaction.findUniqueOrThrow({ where: { id: reversal.reversalTransactionId } })).reversible).toBe(false);
    await expect(first.reverseLatest(room.id, reversal.reversalTransactionId, bank.token, '不应撤销补偿事务', 'reverse-compensation')).rejects.toThrow('NO_REVERSIBLE_TRANSACTION');
  });

  it('settles toll only once for one confirmed landing even with different keys', async () => {
    const { room, a, b } = await physicalRoom();
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: b.playerId } });

    await first.payToll(room.id, a.playerId, '甘露寺', 'toll-first-key');
    await expect(second.payToll(room.id, a.playerId, '甘露寺', 'toll-second-key')).rejects.toThrow('TOLL_ALREADY_SETTLED');
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'TOLL_PAID' } })).toBe(1);
  });

  it('serializes concurrent toll attempts for the same landing', async () => {
    const { room, a, b } = await physicalRoom();
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: b.playerId } });

    const attempts = await Promise.allSettled([
      first.payToll(room.id, a.playerId, '甘露寺', 'concurrent-toll-a'),
      second.payToll(room.id, a.playerId, '甘露寺', 'concurrent-toll-b')
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: 'TOLL_ALREADY_SETTLED' }) });
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'TOLL_PAID' } })).toBe(1);
  });

  it('cancels and unlocks a pending electronic property request when its turn ends', async () => {
    const room = await first.createRoom({ name: '旧轮请求测试', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'stale-roll');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'stale-roll-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const request = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'stale-buy');

    await first.endTurn(room.id, a.playerId, 'end-stale-turn');
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).lockedByRequestId).toBeNull();
    await expect(first.approve(room.id, request.id, bank.token, 'approve-stale')).rejects.toThrow('REQUEST_NOT_PENDING');
  });

  it('invalidates the old landing and allows a corrected landing after reroll', async () => {
    const room = await first.createRoom({ name: '重掷落点测试', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'roll-before-invalidation');
    const oldLanding = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'old-invalidated-landing');
    await first.confirmLanding(room.id, oldLanding.id, bank.token, true);
    const request = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'buy-before-invalidation');

    await first.invalidateRoll(room.id, bank.token, '骰子录错');
    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: oldLanding.id } })).toMatchObject({ status: 'INVALIDATED' });
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'CANCELLED' });
    await first.roll(room.id, a.playerId, 'corrected-roll');
    await expect(first.declareLanding(room.id, a.playerId, '景仁宫', a.token, 'corrected-landing')).resolves.toMatchObject({ status: 'DECLARED' });
  });

  it('refuses to invalidate a roll after a turn-bound request has executed', async () => {
    const room = await first.createRoom({ name: '已执行操作禁止重掷', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'roll-before-executed-buy');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'executed-buy-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const request = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'executed-buy-before-invalidation');
    await first.approve(room.id, request.id, bank.token, 'approve-buy-before-invalidation');
    const turnBefore = await firstDb.turn.findFirstOrThrow({ where: { roomId: room.id, status: 'ACTIVE' } });
    const playerBefore = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });

    await expect(first.invalidateRoll(room.id, bank.token, '不应抹除已结算购买')).rejects.toThrow('ROLL_HAS_SETTLED_ACTIONS');

    expect(await firstDb.turn.findUniqueOrThrow({ where: { id: turnBefore.id } })).toMatchObject({
      die1: turnBefore.die1,
      die2: turnBefore.die2,
      diceValue: turnBefore.diceValue,
      invalidatedAt: null,
    });
    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: landing.id } })).toMatchObject({ status: 'CONFIRMED' });
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'EXECUTED' });
    expect(await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).toMatchObject({ ownerPlayerId: a.playerId });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: playerBefore.balance });
  });

  it('refuses to invalidate a roll after toll has settled for its landing', async () => {
    const room = await first.createRoom({ name: '已付过路费禁止重掷', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const payer = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    const owner = await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: owner.playerId } });
    await first.roll(room.id, payer.playerId, 'roll-before-settled-toll');
    const landing = await first.declareLanding(room.id, payer.playerId, '甘露寺', payer.token, 'settled-toll-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    await first.payToll(room.id, payer.playerId, '甘露寺', 'settled-toll-before-invalidation');
    const turnBefore = await firstDb.turn.findFirstOrThrow({ where: { roomId: room.id, status: 'ACTIVE' } });
    const payerBefore = await firstDb.player.findUniqueOrThrow({ where: { id: payer.playerId } });
    const ownerBefore = await firstDb.player.findUniqueOrThrow({ where: { id: owner.playerId } });

    await expect(first.invalidateRoll(room.id, bank.token, '不应抹除已结算过路费')).rejects.toThrow('ROLL_HAS_SETTLED_ACTIONS');

    expect(await firstDb.turn.findUniqueOrThrow({ where: { id: turnBefore.id } })).toMatchObject({
      die1: turnBefore.die1,
      die2: turnBefore.die2,
      diceValue: turnBefore.diceValue,
      invalidatedAt: null,
    });
    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: landing.id } })).toMatchObject({ status: 'CONFIRMED' });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: payer.playerId } })).toMatchObject({ balance: payerBefore.balance });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: owner.playerId } })).toMatchObject({ balance: ownerBefore.balance });
  });

  it('cancels and unlocks requests when landing property actions are cancelled', async () => {
    const { room, a, bank } = await physicalRoom();
    const landing = await firstDb.landingEvent.findFirstOrThrow({ where: { roomId: room.id, playerId: a.playerId, property: { definition: { name: '甘露寺' } } }, orderBy: { confirmedAt: 'desc' } });
    const request = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'buy-before-landing-cancel');

    await first.cancelLandingPropertyActions(room.id, landing.id, bank.token, '剧情取消地产操作');

    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).lockedByRequestId).toBeNull();
  });

  it('rejects an electronic property request when its active turn is missing', async () => {
    const room = await first.createRoom({ name: '缺失回合测试', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'orphaned-roll');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'turn-end-cancel-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    await firstDb.turn.updateMany({ where: { roomId: room.id, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt: new Date() } });

    await expect(first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'request-without-turn')).rejects.toThrow('TURN_NOT_FOUND');
  });

  it('awards Zhenhuan 500 taels for an approved companion event without tracking the card', async () => {
    const { room, a, bank } = await physicalRoom();
    const before = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    const companion = await first.createRequest(room.id, a.playerId, { type: 'COMPANION_EVENT' }, 'companion-event');
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: before.balance, partnerCardCount: 0 });
    await first.approve(room.id, companion.id, bank.token, 'approve-companion-event');
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: before.balance + 500, partnerCardCount: 0 });
    const companionTransaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: companion.id } });
    expect(await firstDb.ledgerEntry.findMany({ where: { transactionId: companionTransaction.id, type: 'SKILL_REWARD' } })).toMatchObject([
      { amount: 500, description: '甄嬛伙伴卡奖励' },
    ]);
    expect((await first.snapshot(room.id)).players.find((player) => player.id === a.playerId)).not.toHaveProperty('partnerCardCount');
  });

  it('settles physical companion returns exactly once without reading or changing legacy card counts', async () => {
    const { room, a, bank } = await physicalRoom();
    await firstDb.player.update({ where: { id: a.playerId }, data: { partnerCardCount: 2 } });
    const before = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });

    const forbiddenReturnPayloads = [
      { field: 'amount', action: { type: 'RETURN_COMPANION_EVENT' as const, amount: 1 } },
      { field: 'count', action: { type: 'RETURN_COMPANION_EVENT' as const, count: 1 } },
      { field: 'propertyName', action: { type: 'RETURN_COMPANION_EVENT' as const, propertyName: '甘露寺' } },
      { field: 'targetPlayerId', action: { type: 'RETURN_COMPANION_EVENT' as const, targetPlayerId: a.playerId } },
      { field: 'landingId', action: { type: 'RETURN_COMPANION_EVENT' as const, landingId: 'not-a-landing' } },
      { field: 'reason', action: { type: 'RETURN_COMPANION_EVENT' as const, reason: '客户端不可指定返还原因' } },
    ] satisfies Array<{ field: string; action: Parameters<PrismaGameService['createRequest']>[3] }>;
    for (const { field, action } of forbiddenReturnPayloads) {
      await expect(first.createRequest(room.id, a.playerId, action, `return-client-${field}`)).rejects.toThrow('INVALID_RETURN_COMPANION_PAYLOAD');
    }

    const returned = await first.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'return-companion');
    const returnReplay = await second.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'return-companion');
    expect(returned).toMatchObject({ type: 'RETURN_COMPANION_EVENT', amount: 500, quantity: 1, landingEventId: null, turnId: null, status: 'PENDING' });
    expect(returnReplay).toEqual(returned);
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: before.balance, partnerCardCount: 2 });
    expect((await firstDb.room.findUniqueOrThrow({ where: { id: room.id }, select: { stateVersion: true } })).stateVersion).toBe(returned.stateVersion);
    expect(await firstDb.gameRequest.count({ where: { roomId: room.id, idempotencyKey: `${state.players.get(a.playerId)!.accountId}:return-companion` } })).toBe(1);

    const [approval, replay] = await Promise.all([
      first.approve(room.id, returned.id, bank.token, 'approve-return-companion'),
      second.approve(room.id, returned.id, bank.token, 'approve-return-companion'),
    ]);
    expect(replay).toEqual(approval);

    const afterReturn = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    const returnTransaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: returned.id } });
    expect(afterReturn).toMatchObject({ balance: before.balance + 500, partnerCardCount: 2 });
    expect(returnTransaction).toMatchObject({ type: 'RETURN_COMPANION_EVENT', reversible: false });
    expect(returnTransaction.metadata).toMatchObject({ returnedCount: 1, rewardAmount: 500 });
    expect(returnTransaction.metadata).not.toHaveProperty('companionCardCountBefore');
    expect(await firstDb.gameTransaction.count({ where: { requestId: returned.id } })).toBe(1);
    expect(await firstDb.ledgerEntry.count({ where: { transactionId: returnTransaction.id, type: 'RETURN_COMPANION_EVENT' } })).toBe(1);
    expect(await firstDb.auditLog.findFirstOrThrow({ where: { roomId: room.id, action: 'RETURN_COMPANION_EVENT', entityId: a.playerId } })).toMatchObject({
      actorRole: 'BANK',
      beforeJson: { balance: before.balance },
      afterJson: { balance: before.balance + 500, returnedCount: 1, rewardAmount: 500 },
    });
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'RETURN_COMPANION_EVENT', entityId: a.playerId } })).toBe(1);
    expect(await firstDb.idempotencyRecord.count({ where: {
      scope: `account:${state.banks.get(bank.token)!.accountId}:room:${room.id}:request:${returned.id}:approve`,
      key: 'approve-return-companion',
    } })).toBe(1);

    const secondReturn = await first.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'return-companion-second');
    await first.approve(room.id, secondReturn.id, bank.token, 'approve-return-companion-second');
    const afterSecondReturn = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    const secondReturnTransaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: secondReturn.id } });
    expect(afterSecondReturn).toMatchObject({ balance: before.balance + 1000, partnerCardCount: 2 });
    expect(secondReturnTransaction.metadata).toMatchObject({ returnedCount: 1, rewardAmount: 500 });
    expect(await firstDb.gameTransaction.count({ where: { requestId: returned.id } })).toBe(1);
    const reconnectedSnapshot = await second.snapshot(room.id);
    expect(reconnectedSnapshot.players.find((player) => player.id === a.playerId)).toMatchObject({ balance: before.balance + 1000 });
    expect(reconnectedSnapshot.players.find((player) => player.id === a.playerId)).not.toHaveProperty('partnerCardCount');
    expect(reconnectedSnapshot.requests.find((item) => item.id === secondReturn.id)).toMatchObject({ type: 'RETURN_COMPANION_EVENT', quantity: 1, amount: 500, status: 'EXECUTED' });
    expect(reconnectedSnapshot.ledger.filter((entry) => entry.transactionId === secondReturnTransaction.id)).toHaveLength(1);
    expect(reconnectedSnapshot.audit.some((entry) => entry.action === 'RETURN_COMPANION_EVENT' && entry.entityId === a.playerId)).toBe(true);

    const queuedFirst = await first.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'queued-companion-return-first');
    const queuedSecond = await first.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'queued-companion-return-second');
    expect(await firstDb.gameRequest.count({ where: { id: { in: [queuedFirst.id, queuedSecond.id] }, status: 'PENDING' } })).toBe(2);
    await first.approve(room.id, queuedFirst.id, bank.token, 'approve-queued-companion-return-first');
    await first.approve(room.id, queuedSecond.id, bank.token, 'approve-queued-companion-return-second');
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: before.balance + 2000, partnerCardCount: 2 });
    expect((await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: queuedSecond.id } })).metadata).toMatchObject({ returnedCount: 1, rewardAmount: 500 });
  });

  it('rolls back a companion return when its audit entry cannot be written', async () => {
    const { room, a, bank } = await physicalRoom();
    const request = await first.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'return-with-audit-failure');
    const before = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    const roomBefore = await firstDb.room.findUniqueOrThrow({ where: { id: room.id }, select: { stateVersion: true } });
    await firstDb.$executeRawUnsafe(`
      CREATE FUNCTION "fail_return_companion_audit"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected return companion audit failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await firstDb.$executeRawUnsafe(`
      CREATE TRIGGER "fail_return_companion_audit_trigger"
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW WHEN (NEW."action" = 'RETURN_COMPANION_EVENT')
      EXECUTE FUNCTION "fail_return_companion_audit"()
    `);
    try {
      await expect(first.approve(room.id, request.id, bank.token, 'approve-return-with-audit-failure')).rejects.toThrow(/injected return companion audit failure/);
    } finally {
      await firstDb.$executeRawUnsafe('DROP TRIGGER IF EXISTS "fail_return_companion_audit_trigger" ON "AuditLog"');
      await firstDb.$executeRawUnsafe('DROP FUNCTION IF EXISTS "fail_return_companion_audit"()');
    }
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: before.balance });
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'PENDING', approvedAt: null, approvedByMemberId: null });
    expect(await firstDb.gameTransaction.count({ where: { requestId: request.id } })).toBe(0);
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, playerId: a.playerId, type: 'RETURN_COMPANION_EVENT' } })).toBe(0);
    expect(await firstDb.auditLog.count({ where: { roomId: room.id, action: 'RETURN_COMPANION_EVENT' } })).toBe(0);
    expect((await firstDb.room.findUniqueOrThrow({ where: { id: room.id }, select: { stateVersion: true } })).stateVersion).toBe(roomBefore.stateVersion);
    expect(await firstDb.idempotencyRecord.count({ where: {
      scope: `account:${state.banks.get(bank.token)!.accountId}:room:${room.id}:request:${request.id}:approve`,
      key: 'approve-return-with-audit-failure',
    } })).toBe(0);
  });

  it('keeps a valid balance ledger chain under concurrent credits', async () => {
    const { room, a, bank } = await physicalRoom();
    const amounts = [100, 200];
    const attempts = await Promise.allSettled([
      first.adjustBalance(room.id, a.playerId, 100, bank.token, '并发入账一', 'concurrent-credit-a'),
      second.adjustBalance(room.id, a.playerId, 200, bank.token, '并发入账二', 'concurrent-credit-b')
    ]);
    const entries = await firstDb.ledgerEntry.findMany({ where: { roomId: room.id, playerId: a.playerId, type: 'MANUAL_BALANCE_CHANGE' } });
    const committedTotal = attempts.reduce((total, attempt, index) => total + (attempt.status === 'fulfilled' ? amounts[index] : 0), 0);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled').length).toBeGreaterThan(0);
    expect(entries).toHaveLength(attempts.filter((attempt) => attempt.status === 'fulfilled').length);
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).balance).toBe(5000 + committedTotal);
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') expect([attempt.reason?.code, attempt.reason?.message]).toEqual(expect.arrayContaining([expect.stringMatching(/P2034|TRANSACTION_CONFLICT|BALANCE_STATE_CHANGED|write conflict|deadlock/i)]));
    }
    const remaining = [...entries];
    let balance = 5000;
    while (remaining.length) {
      const index = remaining.findIndex((entry) => entry.balanceBefore === balance);
      expect(index).toBeGreaterThanOrEqual(0);
      const [entry] = remaining.splice(index, 1);
      balance = entry.balanceAfter;
    }
  });

  it('rejects committed replays and every new bank mutation after the room ends', async () => {
    const { room, a, bank } = await physicalRoom();
    const landing = await firstDb.landingEvent.findFirstOrThrow({ where: { roomId: room.id, playerId: a.playerId, status: 'CONFIRMED' } });
    const pending = await first.requestBankPayment(room.id, a.playerId, 100, 'pending-before-terminal-guard');
    const adjustment = await first.adjustBalance(room.id, a.playerId, 300, bank.token, '结束前修正', 'pre-end-adjustment');
    await first.addSkipTurns(room.id, a.playerId, 2, 'PLOT_REST', bank.token, 'pre-end-skip', '结束前停轮');
    await firstDb.room.update({ where: { id: room.id }, data: { allowMidgameJoin: true } });
    await firstDb.room.update({ where: { id: room.id }, data: { status: 'ENDED', currentTurnPlayerId: null } });
    const playerBefore = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    const propertyBefore = await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } });
    const ledgerCountBefore = await firstDb.ledgerEntry.count({ where: { roomId: room.id } });
    const auditCountBefore = await firstDb.auditLog.count({ where: { roomId: room.id } });
    const idempotencyCountBefore = await firstDb.idempotencyRecord.count();

    await expect(first.adjustBalance(room.id, a.playerId, 300, bank.token, '结束前修正', 'pre-end-adjustment')).rejects.toThrow('ROOM_FINISHED');
    await expect(first.adjustBalance(room.id, a.playerId, 100, bank.token, '结束后新修正', 'post-end-adjustment')).rejects.toThrow('ROOM_FINISHED');
    await expect(first.adjustProperty(room.id, '甘露寺', { ownerPlayerId: a.playerId }, bank.token, '结束后改产权', 'post-end-property')).rejects.toThrow('ROOM_FINISHED');
    await expect(first.addSkipTurns(room.id, a.playerId, 1, 'PLOT_REST', bank.token, 'post-end-skip', '结束后加停轮')).rejects.toThrow('ROOM_FINISHED');
    await expect(first.consumeSkip(room.id, a.playerId, 1, bank.token, 'post-end-consume', '结束后不能消费')).rejects.toThrow('ROOM_FINISHED');
    await expect(first.reverseLatest(room.id, adjustment.id, bank.token, '结束后撤销', 'post-end-reversal')).rejects.toThrow('ROOM_FINISHED');
    await expect(first.reject(room.id, pending.id, bank.token, '结束后拒绝', 'post-end-reject')).rejects.toThrow('ROOM_FINISHED');
    await expect(first.cancelLandingPropertyActions(room.id, landing.id, bank.token, '结束后取消落点')).rejects.toThrow('ROOM_FINISHED');

    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({
      balance: playerBefore.balance,
      remainingSkipTurns: playerBefore.remainingSkipTurns,
      version: playerBefore.version,
    });
    expect(await firstDb.roomProperty.findUniqueOrThrow({ where: { id: propertyBefore.id } })).toMatchObject({
      ownerPlayerId: propertyBefore.ownerPlayerId,
      buildingLevel: propertyBefore.buildingLevel,
      mortgaged: propertyBefore.mortgaged,
      version: propertyBefore.version,
    });
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id } })).toBe(ledgerCountBefore);
    expect(await firstDb.auditLog.count({ where: { roomId: room.id } })).toBe(auditCountBefore);
    expect(await firstDb.idempotencyRecord.count()).toBe(idempotencyCountBefore);
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'PENDING' });
    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: landing.id } })).toMatchObject({
      propertyActionsCancelled: landing.propertyActionsCancelled,
      plotResolved: landing.plotResolved,
      status: landing.status,
    });
  });

  it('rejects every game-write family without mutation in ENDED, FINISHED, and CLOSED rooms', async () => {
    for (const status of ['ENDED', 'FINISHED', 'CLOSED'] as const) {
      const { room, a, b, bank } = await physicalRoom();
      const pending = await first.requestBankPayment(room.id, a.playerId, 100, `terminal-family-pending-${status}`);
      const adjustment = await first.adjustBalance(room.id, a.playerId, 50, bank.token, `terminal family setup ${status}`, `terminal-family-adjust-${status}`);
      const landing = await firstDb.landingEvent.findFirstOrThrow({ where: { roomId: room.id } });
      await firstDb.room.update({ where: { id: room.id }, data: { status, currentTurnPlayerId: null } });
      const before = JSON.stringify(await Promise.all([
        firstDb.player.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.gameRequest.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.gameTransaction.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.ledgerEntry.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.turn.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.landingEvent.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.auditLog.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.idempotencyRecord.count(),
      ]));
      const calls = [
        () => first.start(room.id, bank.token, `terminal-family-start-${status}`),
        () => first.declareLanding(room.id, a.playerId, '景仁宫', a.token, `terminal-family-landing-${status}`),
        () => first.declareStartLanding(room.id, a.playerId, `terminal-start-${status}`, a.token, `terminal-family-start-landing-${status}`),
        () => first.confirmLanding(room.id, landing.id, bank.token, true, `terminal-family-confirm-${status}`),
        () => first.cancelLandingPropertyActions(room.id, landing.id, bank.token, 'terminal', `terminal-family-cancel-landing-${status}`),
        () => first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '景仁宫' }, `terminal-family-buy-${status}`),
        () => first.createRequest(room.id, a.playerId, { type: 'COMPANION_EVENT' }, `terminal-family-companion-${status}`),
        () => first.createRequest(room.id, a.playerId, { type: 'COLD_PALACE_EVENT', count: 1 }, `terminal-family-cold-${status}`),
        () => first.requestBankPayment(room.id, a.playerId, 100, `terminal-family-payment-${status}`),
        () => first.transfer(room.id, { fromPlayerId: a.playerId, recipientType: 'PLAYER', toPlayerId: b.playerId, amount: 1, isPlotFine: false }, `terminal-family-transfer-${status}`),
        () => first.payToll(room.id, a.playerId, '甘露寺', `terminal-family-toll-${status}`),
        () => first.roll(room.id, a.playerId, `terminal-family-roll-${status}`),
        () => first.endTurn(room.id, a.playerId, `terminal-family-end-turn-${status}`),
        () => first.confirmTrade(room.id, pending.id, a.playerId, `terminal-family-trade-${status}`),
        () => first.approve(room.id, pending.id, bank.token, `terminal-family-approve-${status}`),
        () => first.reject(room.id, pending.id, bank.token, 'terminal', `terminal-family-reject-${status}`),
        () => first.adjustBalance(room.id, a.playerId, 1, bank.token, 'terminal', `terminal-family-balance-${status}`),
        () => first.adjustProperty(room.id, '甘露寺', { ownerPlayerId: a.playerId }, bank.token, 'terminal', `terminal-family-property-${status}`),
        () => first.addSkipTurns(room.id, a.playerId, 1, 'PLOT_REST', bank.token, `terminal-family-add-skip-${status}`, 'terminal'),
        () => first.consumeSkip(room.id, a.playerId, 1, bank.token, `terminal-family-consume-${status}`, 'terminal'),
        () => first.invalidateRoll(room.id, bank.token, 'terminal', `terminal-family-invalidate-${status}`),
        () => first.forceNext(room.id, bank.token, 'terminal', `terminal-family-force-${status}`),
        () => first.plotFine(room.id, a.playerId, 1, `terminal-family-fine-${status}`, bank.token),
        () => first.reverseLatest(room.id, adjustment.id, bank.token, 'terminal', `terminal-family-reverse-${status}`),
      ];
      for (const call of calls) await expect(call()).rejects.toThrow('ROOM_FINISHED');
      const after = JSON.stringify(await Promise.all([
        firstDb.player.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.gameRequest.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.gameTransaction.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.ledgerEntry.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.turn.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.landingEvent.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.auditLog.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        firstDb.idempotencyRecord.count(),
      ]));
      expect(after).toBe(before);
    }
  });

  it('invalidates a player physical landing and its pending request when a new landing is declared', async () => {
    const { room, a, b, bank } = await physicalRoom();
    const oldLanding = await firstDb.landingEvent.findFirstOrThrow({ where: { roomId: room.id, playerId: a.playerId, property: { definition: { name: '甘露寺' } } } });
    const staleRequest = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'stale-physical-purchase');

    const newLanding = await first.declareLanding(room.id, a.playerId, '景仁宫', a.token, 'new-physical-landing');
    await first.confirmLanding(room.id, newLanding.id, bank.token, true);

    expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: oldLanding.id } })).toMatchObject({ status: 'INVALIDATED' });
    expect(await firstDb.gameRequest.findUniqueOrThrow({ where: { id: staleRequest.id } })).toMatchObject({ status: 'CANCELLED' });
    expect(await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).toMatchObject({ lockedByRequestId: null });
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: b.playerId } });
    await expect(first.payToll(room.id, a.playerId, '甘露寺', 'stale-physical-toll')).rejects.toThrow('CONFIRMED_LANDING_REQUIRED');
    await expect(first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '景仁宫' }, 'current-physical-purchase')).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('derives the active build discount in snapshots', async () => {
    const room = await first.createRoom({ name: '建筑折扣快照', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const anlingrong = await first.joinPlayer(room.code, '陵容', 'anlingrong');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');

    expect((await first.snapshot(room.id)).players.find((player) => player.id === anlingrong.playerId)?.buildDiscount).toBe(500);
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: false } });
    expect((await first.snapshot(room.id)).players.find((player) => player.id === anlingrong.playerId)?.buildDiscount).toBe(0);
  });

  it('derives committed toll settlement state for each visible landing', async () => {
    const { room, a, b, bank } = await physicalRoom();
    await firstDb.roomProperty.updateMany({
      where: { roomId: room.id, definition: { name: '甘露寺' } },
      data: { ownerPlayerId: b.playerId },
    });
    const landing = await firstDb.landingEvent.findFirstOrThrow({
      where: { roomId: room.id, playerId: a.playerId, property: { definition: { name: '甘露寺' } } },
    });

    expect((await first.snapshot(room.id)).landings.find((item) => item.id === landing.id)).toMatchObject({ tollSettled: false });
    const payment = await first.payToll(room.id, a.playerId, '甘露寺', 'snapshot-toll-payment');
    await firstDb.idempotencyRecord.update({
      where: { scope_key: { scope: `landing:${landing.id}:toll`, key: 'settled' } },
      data: { response: { transactionId: '', requestKey: 'snapshot-toll-payment' } },
    });
    expect((await first.snapshot(room.id)).landings.find((item) => item.id === landing.id)).toMatchObject({ tollSettled: true });
    await first.reverseLatest(room.id, payment.id, bank.token, '测试冲正', 'reverse-snapshot-toll');
    expect((await first.snapshot(room.id)).landings.find((item) => item.id === landing.id)).toMatchObject({ tollSettled: false });
  });

  it('keeps fallback toll request keys isolated by payer account', async () => {
    const { room, a, b } = await physicalRoom();
    const [landingA, landingB, playerA, playerB] = await Promise.all([
      firstDb.landingEvent.findFirstOrThrow({ where: { roomId: room.id, playerId: a.playerId, status: 'CONFIRMED' } }),
      firstDb.landingEvent.findFirstOrThrow({ where: { roomId: room.id, playerId: b.playerId, status: 'CONFIRMED' } }),
      firstDb.player.findUniqueOrThrow({ where: { id: a.playerId }, include: { member: { select: { accountId: true } } } }),
      firstDb.player.findUniqueOrThrow({ where: { id: b.playerId }, include: { member: { select: { accountId: true } } } }),
    ]);
    const sharedRequestKey = `shared-toll-request-${randomUUID()}`;
    const committedTransactionId = `committed-toll-${randomUUID()}`;
    const reversedTransactionId = `reversed-toll-${randomUUID()}`;

    await firstDb.gameTransaction.createMany({ data: [
      {
        id: committedTransactionId,
        roomId: room.id,
        type: 'TOLL',
        status: 'COMMITTED',
        metadata: { landingId: landingA.id },
      },
      {
        id: reversedTransactionId,
        roomId: room.id,
        type: 'TOLL',
        status: 'REVERSED',
        metadata: { landingId: landingB.id },
      },
    ] });
    await firstDb.idempotencyRecord.createMany({ data: [
      {
        scope: `landing:${landingA.id}:toll`,
        key: 'settled',
        response: { requestKey: sharedRequestKey },
      },
      {
        scope: `landing:${landingB.id}:toll`,
        key: 'settled',
        response: { requestKey: sharedRequestKey },
      },
      {
        scope: `account:${playerA.member.accountId}:room:${room.id}:toll`,
        key: sharedRequestKey,
        response: { id: committedTransactionId },
      },
      {
        scope: `account:${playerB.member.accountId}:room:${room.id}:toll`,
        key: sharedRequestKey,
        response: { id: reversedTransactionId },
      },
    ] });

    const snapshot = await first.snapshot(room.id);
    expect(snapshot.landings.find((landing) => landing.id === landingA.id)).toMatchObject({ tollSettled: true });
    expect(snapshot.landings.find((landing) => landing.id === landingB.id)).toMatchObject({ tollSettled: false });
  });

  it('does not attach a legacy toll transaction that explicitly belongs to another landing', async () => {
    const { room, a, b } = await physicalRoom();
    const [landingA, landingB] = await Promise.all([
      firstDb.landingEvent.findFirstOrThrow({ where: { roomId: room.id, playerId: a.playerId, status: 'CONFIRMED' } }),
      firstDb.landingEvent.findFirstOrThrow({ where: { roomId: room.id, playerId: b.playerId, status: 'CONFIRMED' } }),
    ]);
    const requestKey = `legacy-colliding-toll-${randomUUID()}`;
    const transactionId = `legacy-colliding-transaction-${randomUUID()}`;

    await firstDb.gameTransaction.create({
      data: {
        id: transactionId,
        roomId: room.id,
        type: 'TOLL',
        status: 'COMMITTED',
        metadata: { landingId: landingB.id },
      },
    });
    await firstDb.idempotencyRecord.createMany({ data: [
      {
        scope: `landing:${landingA.id}:toll`,
        key: 'settled',
        response: { requestKey },
      },
      {
        scope: `room:${room.id}:toll`,
        key: requestKey,
        response: { id: transactionId },
      },
    ] });

    const snapshot = await first.snapshot(room.id);
    expect(snapshot.landings.find((landing) => landing.id === landingA.id)).toMatchObject({ tollSettled: false });
  });

  it('loads visible toll settlement states with a constant number of idempotency queries', async () => {
    const { room, a } = await physicalRoom();
    const player = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId }, select: { memberId: true } });
    const bankActor = state.roomBanks.get(room.id);
    if (!bankActor) throw new Error('Missing bank actor for snapshot query test');
    const bankMember = await firstDb.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: bankActor.accountId } },
      select: { id: true },
    });
    const settlements = Array.from({ length: 10 }, (_, index) => ({
      landingId: `snapshot-query-landing-${randomUUID()}`,
      transactionId: `snapshot-query-transaction-${randomUUID()}`,
      requestKey: `snapshot-query-request-${randomUUID()}`,
      usesFallbackRecord: index % 2 === 1,
    }));
    await firstDb.landingEvent.createMany({
      data: settlements.map(({ landingId }) => ({
        id: landingId,
        roomId: room.id,
        playerId: a.playerId,
        spaceType: 'OTHER',
        status: 'CONFIRMED',
        plotResolved: true,
        declaredBy: player.memberId,
        confirmedBy: bankMember.id,
        confirmedAt: new Date(),
      })),
    });
    await firstDb.gameTransaction.createMany({
      data: settlements.map(({ landingId, transactionId }) => ({
        id: transactionId,
        roomId: room.id,
        type: 'TOLL',
        metadata: { landingId },
      })),
    });
    await firstDb.idempotencyRecord.createMany({
      data: settlements.flatMap(({ landingId, transactionId, requestKey, usesFallbackRecord }) => [
        {
          scope: `landing:${landingId}:toll`,
          key: 'settled',
          response: usesFallbackRecord ? { requestKey } : { transactionId },
        },
        ...(usesFallbackRecord ? [{
          scope: `room:${room.id}:toll`,
          key: requestKey,
          response: { id: transactionId },
        }] : []),
      ]),
    });

    const observedQueries: string[] = [];
    const observedDb = new PrismaClient({
      datasources: { db: { url: url! } },
      log: [{ emit: 'event', level: 'query' }],
    });
    observedDb.$on('query', ({ query }) => observedQueries.push(query));
    try {
      const snapshot = await new PrismaGameService(observedDb).snapshot(bankActor, room.id, 'BANK');
      expect(snapshot.landings.filter((landing) => settlements.some(({ landingId }) => landingId === landing.id)))
        .toHaveLength(settlements.length);
      expect(snapshot.landings
        .filter((landing) => settlements.some(({ landingId }) => landingId === landing.id))
        .every((landing) => landing.tollSettled)).toBe(true);
    } finally {
      await observedDb.$disconnect();
    }

    const idempotencyReads = observedQueries.filter((query) =>
      query.startsWith('SELECT') && query.includes('"IdempotencyRecord"'));
    expect(idempotencyReads).toHaveLength(2);
  });

  it('records nonzero initial balances in the immutable ledger', async () => {
    const room = await first.createRoom({ name: '初始账本', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const player = await first.joinPlayer(room.code, '甲', 'zhenhuan');

    const transaction = await firstDb.gameTransaction.findFirstOrThrow({ where: { roomId: room.id, type: 'INITIAL_BALANCE' } });
    expect(transaction.reversible).toBe(false);
    expect(await firstDb.ledgerEntry.findFirstOrThrow({ where: { transactionId: transaction.id, playerId: player.playerId } })).toMatchObject({
      amount: 5000, balanceBefore: 0, balanceAfter: 5000, type: 'INITIAL_BALANCE'
    });
  });

  it('stores the configured start reward amount on its pending request', async () => {
    const { room, a, bank } = await physicalRoom();
    await firstDb.room.update({ where: { id: room.id }, data: { startReward: 1_200 } });
    const landing = await first.declareStartLanding(room.id, a.playerId, 'start-reward-landing', a.token, 'start-reward-landing-key');
    await first.confirmLanding(room.id, landing.id, bank.token, true);

    const request = await first.createRequest(room.id, a.playerId, { type: 'START_REWARD', landingId: landing.id }, 'start-reward-request');

    expect(request.amount).toBe(1_200);
    const snapshot = await first.snapshot(room.id);
    expect(snapshot).toMatchObject({ startReward: 1_200 });
    expect(snapshot.requests.find((item) => item.id === request.id)).toMatchObject({ amount: 1_200 });
  });

  it('rejects an electronic start reward after its confirmed landing turn expires', async () => {
    const room = await first.createRoom({ name: '过期起点奖励', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    await first.roll(room.id, a.playerId, 'roll-before-start-landing');
    const landing = await first.declareStartLanding(room.id, a.playerId, 'stale-start-landing', a.token, 'stale-start-landing-key');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    await first.endTurn(room.id, a.playerId, 'end-start-landing-turn');

    await expect(
      first.createRequest(room.id, a.playerId, { type: 'START_REWARD', landingId: landing.id }, 'stale-start-reward'),
    ).rejects.toThrow('START_LANDING_TURN_EXPIRED');
  });

  it('rejects every player-initiated property request outside the current electronic turn', async () => {
    const cases = [
      { type: 'BUY_PROPERTY', propertyName: '景仁宫', setup: { ownerPlayerId: null, buildingLevel: 0, mortgaged: false } },
      { type: 'BUILD_PROPERTY', propertyName: '端妃宫', setup: { buildingLevel: 0, mortgaged: false } },
      { type: 'SELL_BUILDING', propertyName: '景仁宫', count: 1, setup: { buildingLevel: 2, mortgaged: false } },
      { type: 'MORTGAGE_PROPERTY', propertyName: '甘露寺', setup: { buildingLevel: 0, mortgaged: false } },
      { type: 'REDEEM_PROPERTY', propertyName: '咸福宫', setup: { buildingLevel: 0, mortgaged: true } },
      { type: 'SELL_PROPERTY_TO_BANK', propertyName: '寿康宫', setup: { buildingLevel: 0, mortgaged: false } },
      { type: 'TRADE_PROPERTY', propertyName: '永寿宫', amount: 200, setup: { buildingLevel: 0, mortgaged: false } },
    ] as const;

    for (const [index, scenario] of cases.entries()) {
      const room = await first.createRoom({ name: `回合外处置${index}`, initialBalance: 10000, diceMode: 'ELECTRONIC' });
      const current = await first.joinPlayer(room.code, `当前${index}`, 'zhenhuan');
      const owner = await first.joinPlayer(room.code, `处置${index}`, 'huashifei');
      const bank = await first.joinBank(room.code, `国库${index}`);
      await first.start(room.id, bank.token, 'start-room');
      expect((await first.snapshot(room.id)).currentPlayerId).toBe(current.playerId);
      await firstDb.roomProperty.updateMany({
        where: { roomId: room.id, definition: { name: scenario.propertyName } },
        data: { ownerPlayerId: 'ownerPlayerId' in scenario.setup ? scenario.setup.ownerPlayerId : owner.playerId, ...scenario.setup },
      });

      await expect(first.createRequest(room.id, owner.playerId, {
        type: scenario.type,
        propertyName: scenario.propertyName,
        targetPlayerId: scenario.type === 'TRADE_PROPERTY' ? current.playerId : undefined,
        amount: 'amount' in scenario ? scenario.amount : undefined,
        count: 'count' in scenario ? scenario.count : undefined,
      }, `off-turn-property-request-${index}`)).rejects.toThrow('NOT_CURRENT_PLAYER');
      expect(await firstDb.gameRequest.count({ where: { roomId: room.id, idempotencyKey: `off-turn-property-request-${index}` } })).toBe(0);
    }
  });

  it('rejects a property name on non-property events without locking the property', async () => {
    const { room, a } = await physicalRoom();

    await expect(first.createRequest(room.id, a.playerId, {
      type: 'COLD_PALACE_EVENT',
      propertyName: '甘露寺',
      count: 1,
    }, 'event-with-property')).rejects.toThrow('PROPERTY_NOT_ALLOWED');

    expect(await firstDb.gameRequest.count({ where: { roomId: room.id, idempotencyKey: 'event-with-property' } })).toBe(0);
    expect(await firstDb.roomProperty.findFirstOrThrow({
      where: { roomId: room.id, definition: { name: '甘露寺' } },
    })).toMatchObject({ lockedByRequestId: null });
  });

  it('does not charge a mortgaged property toll or change either balance', async () => {
    const { room, a, b } = await physicalRoom();
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: b.playerId, mortgaged: true } });
    const before = await firstDb.player.findMany({ where: { id: { in: [a.playerId, b.playerId] } }, orderBy: { id: 'asc' }, select: { id: true, balance: true } });

    await expect(first.payToll(room.id, a.playerId, '甘露寺', 'mortgaged-toll')).rejects.toThrow('MORTGAGED_PROPERTY');
    expect(await firstDb.player.findMany({ where: { id: { in: [a.playerId, b.playerId] } }, orderBy: { id: 'asc' }, select: { id: true, balance: true } })).toEqual(before);
  });

  it('rejects selling a property to the bank while it has buildings', async () => {
    const { room, a } = await physicalRoom();
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: a.playerId, buildingLevel: 1 } });

    await expect(first.createRequest(room.id, a.playerId, { type: 'SELL_PROPERTY_TO_BANK', propertyName: '甘露寺' }, 'bank-sale-with-building')).rejects.toThrow('BUILDINGS_MUST_BE_SOLD');
    expect(await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).toMatchObject({ ownerPlayerId: a.playerId, buildingLevel: 1, lockedByRequestId: null });
  });

  it('keeps the original dice when a turn is rolled twice with different keys', async () => {
    const room = await first.createRoom({ name: '重复掷骰', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');

    const firstRoll = await first.roll(room.id, a.playerId, 'first-roll');
    await expect(second.roll(room.id, a.playerId, 'second-roll')).rejects.toThrow('ALREADY_ROLLED');
    expect((await first.snapshot(room.id)).turn).toMatchObject({ dice: firstRoll.dice, total: firstRoll.total });
  });

  it('exposes the configured toll bonus in snapshots only while skills are enabled', async () => {
    const room = await first.createRoom({ name: '过路费技能快照', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const huashifei = await first.joinPlayer(room.code, '华妃', 'huashifei');
    await first.joinPlayer(room.code, '乙', 'zhenhuan');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');

    expect((await first.snapshot(room.id)).players.find((player) => player.id === huashifei.playerId)?.tollBonus).toBe(300);
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: false } });
    expect((await first.snapshot(room.id)).players.find((player) => player.id === huashifei.playerId)?.tollBonus).toBe(0);
  });

  it('exposes the configured companion reward in snapshots only while skills are enabled', async () => {
    const room = await first.createRoom({ name: '伙伴卡技能快照', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const zhenhuan = await first.joinPlayer(room.code, '甄嬛', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-companion-snapshot-room');

    expect((await first.snapshot(room.id)).players.find((player) => player.id === zhenhuan.playerId)?.companionCashReward).toBe(500);
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: false } });
    expect((await first.snapshot(room.id)).players.find((player) => player.id === zhenhuan.playerId)?.companionCashReward).toBe(0);
  });

  it('exposes the configured plot-fine reduction in snapshots only while skills are enabled', async () => {
    const room = await first.createRoom({ name: '剧情罚款技能快照', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const meizhuang = await first.joinPlayer(room.code, '眉庄', 'meizhuang');
    await first.joinPlayer(room.code, '乙', 'zhenhuan');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-plot-fine-snapshot-room');

    expect((await first.snapshot(room.id)).players.find((player) => player.id === meizhuang.playerId)?.plotFineReduction).toBe(200);
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: false } });
    expect((await first.snapshot(room.id)).players.find((player) => player.id === meizhuang.playerId)?.plotFineReduction).toBe(0);
  });

  it('applies online character skills and companion-card rewards only while skills are enabled', async () => {
    const room = await first.createRoom({ name: '人物技能生产路径', initialBalance: 10000, diceMode: 'PHYSICAL' });
    const yixiu = await first.joinPlayer(room.code, '宜修', 'yixiu');
    const huashifei = await first.joinPlayer(room.code, '年世兰', 'huashifei');
    const meizhuang = await first.joinPlayer(room.code, '眉庄', 'meizhuang');
    const anlingrong = await first.joinPlayer(room.code, '安陵容', 'anlingrong');
    const zhenhuan = await first.joinPlayer(room.code, '甄嬛', 'zhenhuan');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');

    const cold = await first.createRequest(room.id, yixiu.playerId, { type: 'COLD_PALACE_EVENT', count: 3 }, 'yixiu-cold-palace');
    await first.approve(room.id, cold.id, bank.token, 'approve-yixiu-cold-palace');
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: yixiu.playerId } })).toMatchObject({ balance: 10500, remainingSkipTurns: 1 });

    const fine = await first.plotFine(room.id, meizhuang.playerId, 500, 'meizhuang-plot-fine', bank.token);
    expect(fine.amount).toBe(300);
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: meizhuang.playerId } })).balance).toBe(9700);

    const companion = await first.createRequest(room.id, zhenhuan.playerId, { type: 'COMPANION_EVENT' }, 'zhenhuan-companion');
    await first.approve(room.id, companion.id, bank.token, 'approve-zhenhuan-companion');
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).balance).toBe(10500);
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: false } });
    const disabledCompanion = await first.createRequest(room.id, zhenhuan.playerId, { type: 'COMPANION_EVENT' }, 'zhenhuan-companion-skills-disabled');
    await first.approve(room.id, disabledCompanion.id, bank.token, 'approve-zhenhuan-companion-skills-disabled');
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: zhenhuan.playerId } })).balance).toBe(10500);
    await firstDb.room.update({ where: { id: room.id }, data: { skillEnabled: true } });

    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: huashifei.playerId } });
    const tollLanding = await first.declareLanding(room.id, zhenhuan.playerId, '甘露寺', zhenhuan.token, 'zhenhuan-toll-landing');
    await first.confirmLanding(room.id, tollLanding.id, bank.token, true);
    const toll = await first.payToll(room.id, zhenhuan.playerId, '甘露寺', 'huashifei-toll');
    const tollEmpty = (await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } }, include: { definition: true } })).definition.tollEmpty;
    expect(toll.amount - tollEmpty).toBe(300);
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: huashifei.playerId } })).balance).toBe(10000 + tollEmpty + 300);

    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '延禧宫' } }, data: { ownerPlayerId: anlingrong.playerId } });
    const buildLanding = await first.declareLanding(room.id, anlingrong.playerId, '延禧宫', anlingrong.token, 'anlingrong-build-landing');
    await first.confirmLanding(room.id, buildLanding.id, bank.token, true);
    const build = await first.createRequest(room.id, anlingrong.playerId, { type: 'BUILD_PROPERTY', propertyName: '延禧宫' }, 'anlingrong-build');
    const buildCost = (await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '延禧宫' } }, include: { definition: true } })).definition.buildCost;
    expect(build.amount).toBe(buildCost - 500);
  });

  it('validates the merged manual property state before persisting it', async () => {
    const { room, a, bank } = await physicalRoom();
    await expect(first.adjustProperty(room.id, '甘露寺', { ownerPlayerId: null, buildingLevel: 1 }, bank.token, '无主建筑', 'unowned-building')).rejects.toThrow('UNOWNED_PROPERTY_MUST_BE_EMPTY');
    await expect(first.adjustProperty(room.id, '甘露寺', { ownerPlayerId: a.playerId, buildingLevel: 1, mortgaged: true }, bank.token, '抵押建筑', 'mortgaged-building')).rejects.toThrow('MORTGAGED_PROPERTY_MUST_BE_EMPTY');
    await expect(first.adjustProperty(room.id, '甘露寺', { ownerPlayerId: null, mortgaged: true }, bank.token, '无主抵押', 'unowned-mortgaged')).rejects.toThrow('UNOWNED_PROPERTY_MUST_BE_EMPTY');
  });

  it('rejects an oversized building sale before creating a request or property lock', async () => {
    const { room, a } = await physicalRoom();
    await firstDb.roomProperty.updateMany({
      where: { roomId: room.id, definition: { name: '甘露寺' } },
      data: { ownerPlayerId: a.playerId, buildingLevel: 2 },
    });

    await expect(first.createRequest(
      room.id,
      a.playerId,
      { type: 'SELL_BUILDING', propertyName: '甘露寺', count: 3 },
      'oversized-building-sale',
    )).rejects.toThrow('TOO_MANY_BUILDINGS');
    expect(await firstDb.gameRequest.count({ where: { roomId: room.id, idempotencyKey: 'oversized-building-sale' } })).toBe(0);
    expect(await firstDb.roomProperty.findFirstOrThrow({
      where: { roomId: room.id, definition: { name: '甘露寺' } },
    })).toMatchObject({ lockedByRequestId: null, buildingLevel: 2 });
  });

  it('requires the target buyer to confirm a trade exactly once before approval', async () => {
    const { room, a, b, bank } = await physicalRoom();
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: a.playerId } });
    const request = await first.createRequest(room.id, a.playerId, { type: 'TRADE_PROPERTY', propertyName: '甘露寺', targetPlayerId: b.playerId, amount: 300 }, 'trade-awaiting-buyer');
    expect((request.payload as Record<string, unknown>).buyerConfirmed).toBe(false);
    await expect(first.approve(room.id, request.id, bank.token, 'approve-unconfirmed-trade')).rejects.toThrow('TRADE_BUYER_CONFIRMATION_REQUIRED');

    const confirmTrade = (service: PrismaGameService, buyerPlayerId: string, key: string) => (service as unknown as {
      confirmTrade: (roomId: string, requestId: string, buyerPlayerId: string, key: string) => Promise<{ id: string; buyerConfirmed: boolean; stateVersion: number }>
    }).confirmTrade(room.id, request.id, buyerPlayerId, key);
    await expect(confirmTrade(first, a.playerId, 'wrong-trade-buyer')).rejects.toThrow('TRADE_BUYER_MISMATCH');
    const [confirmed, repeated] = await Promise.all([
      confirmTrade(first, b.playerId, 'confirm-trade-once'),
      confirmTrade(second, b.playerId, 'confirm-trade-once')
    ]);
    expect(repeated).toEqual(confirmed);
    expect(confirmed).toMatchObject({ id: request.id, buyerConfirmed: true, stateVersion: expect.any(Number) });
    await expect(confirmTrade(second, a.playerId, 'confirm-trade-once')).rejects.toThrow('TRADE_BUYER_MISMATCH');
    expect((await firstDb.gameRequest.findUniqueOrThrow({ where: { id: request.id } }).then((item) => item.payload) as Record<string, unknown>).buyerConfirmed).toBe(true);

    const confirmedAgain = await confirmTrade(second, b.playerId, 'confirm-trade-fresh-key');
    expect(confirmedAgain.stateVersion).toBe(confirmed.stateVersion);
    expect((await firstDb.room.findUniqueOrThrow({ where: { id: room.id }, select: { stateVersion: true } })).stateVersion).toBe(confirmed.stateVersion);

    await first.approve(room.id, request.id, bank.token, 'approve-confirmed-trade');
    expect(await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).toMatchObject({ ownerPlayerId: b.playerId, lockedByRequestId: null });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: 5300 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: b.playerId } })).toMatchObject({ balance: 4700 });
    await firstDb.room.update({ where: { id: room.id }, data: { status: 'ENDED', currentTurnPlayerId: null } });
    await expect(confirmTrade(second, b.playerId, 'confirm-trade-once')).rejects.toThrow('ROOM_FINISHED');
  });

  it('marks companion, companion return, and cold-palace transactions non-reversible', async () => {
    const { room, a, bank } = await physicalRoom();
    const companion = await first.createRequest(room.id, a.playerId, { type: 'COMPANION_EVENT' }, 'non-reversible-companion');
    await first.approve(room.id, companion.id, bank.token, 'approve-non-reversible-companion');
    const returned = await first.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'non-reversible-companion-return');
    await first.approve(room.id, returned.id, bank.token, 'approve-non-reversible-companion-return');
    const cold = await first.createRequest(room.id, a.playerId, { type: 'COLD_PALACE_EVENT', count: 2 }, 'non-reversible-cold');
    await first.approve(room.id, cold.id, bank.token, 'approve-non-reversible-cold');

    const transactions = await firstDb.gameTransaction.findMany({ where: { requestId: { in: [companion.id, returned.id, cold.id] } } });
    expect(transactions).toHaveLength(3);
    expect(transactions.every((transaction) => !transaction.reversible)).toBe(true);
    await expect(first.reverseLatest(room.id, transactions[0]!.id, bank.token, '事件不可撤销', 'reverse-event')).rejects.toThrow('NO_REVERSIBLE_TRANSACTION');
  });

  it('does not reverse a property transaction while a newer request holds its lock', async () => {
    const { room, a, bank } = await physicalRoom();
    const purchase = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'buy-before-locked-reversal');
    await first.approve(room.id, purchase.id, bank.token, 'approve-buy-before-locked-reversal');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'oldest-locked-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const build = await first.createRequest(room.id, a.playerId, { type: 'BUILD_PROPERTY', propertyName: '甘露寺' }, 'lock-before-reversal');
    const purchaseTransaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: purchase.id } });

    await expect(first.reverseLatest(room.id, purchaseTransaction.id, bank.token, '不应清除新锁', 'reverse-locked-property')).rejects.toThrow('NO_REVERSIBLE_TRANSACTION');
    expect(await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).toMatchObject({ ownerPlayerId: a.playerId, lockedByRequestId: build.id });
  });

  it('does not reverse a property transaction after any property version change', async () => {
    const { room, a, bank } = await physicalRoom();
    const purchase = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'buy-before-versioned-reversal');
    await first.approve(room.id, purchase.id, bank.token, 'approve-buy-before-versioned-reversal');
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { version: { increment: 1 } } });
    const purchaseTransaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: purchase.id } });

    await expect(first.reverseLatest(room.id, purchaseTransaction.id, bank.token, '版本已变化', 'reverse-versioned-property')).rejects.toThrow('NO_REVERSIBLE_TRANSACTION');
    expect(await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, definition: { name: '甘露寺' } } })).toMatchObject({ ownerPlayerId: a.playerId, version: 2 });
  });

  it('filters player snapshots while preserving requests where the player is the trade target', async () => {
    const { room, a, b } = await physicalRoom();
    const own = await first.requestBankPayment(room.id, a.playerId, 100, 'snapshot-own-payment');
    const hidden = await first.requestBankPayment(room.id, b.playerId, 200, 'snapshot-other-payment');
    await firstDb.roomProperty.updateMany({ where: { roomId: room.id, definition: { name: '甘露寺' } }, data: { ownerPlayerId: b.playerId } });
    const targeted = await first.createRequest(room.id, b.playerId, { type: 'TRADE_PROPERTY', propertyName: '甘露寺', targetPlayerId: a.playerId, amount: 300 }, 'snapshot-targeted-trade');

    const playerSnapshot = await (first.snapshot as unknown as (roomId: string, viewer: { role: 'PLAYER'; playerId: string }) => ReturnType<PrismaGameService['snapshot']>)(room.id, { role: 'PLAYER', playerId: a.playerId });
    expect(playerSnapshot.ledger.length).toBeGreaterThan(0);
    expect(playerSnapshot.ledger.every((entry) => entry.playerId === a.playerId)).toBe(true);
    expect(playerSnapshot.requests.map((request) => request.id)).toEqual(expect.arrayContaining([own.id, targeted.id]));
    expect(playerSnapshot.requests.map((request) => request.id)).not.toContain(hidden.id);
    expect(playerSnapshot.requests.find((request) => request.id === targeted.id)).toMatchObject({ targetPlayerId: a.playerId, buyerConfirmed: false });
    expect(playerSnapshot.requests.every((request) => typeof request.buyerConfirmed === 'boolean')).toBe(true);
    expect(playerSnapshot.audit).toEqual([]);

    const bankSnapshot = await (first.snapshot as unknown as (roomId: string, viewer: { role: 'BANK' }) => ReturnType<PrismaGameService['snapshot']>)(room.id, { role: 'BANK' });
    expect(bankSnapshot.requests.map((request) => request.id)).toEqual(expect.arrayContaining([own.id, hidden.id, targeted.id]));
    expect(bankSnapshot.audit.length).toBeGreaterThan(0);
  });

  it('applies player snapshot filters before the 100-entry limits', async () => {
    const { room, a, b } = await physicalRoom();
    const ownRequest = await first.requestBankPayment(room.id, a.playerId, 100, 'snapshot-limit-own-request');
    const newerAt = new Date(Date.now() + 60_000);
    const noiseTransaction = await firstDb.gameTransaction.create({
      data: { roomId: room.id, type: 'SNAPSHOT_LIMIT_NOISE', reversible: false, metadata: {}, createdAt: newerAt }
    });
    await firstDb.ledgerEntry.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        roomId: room.id,
        transactionId: noiseTransaction.id,
        playerId: b.playerId,
        amount: 0,
        balanceBefore: 5000,
        balanceAfter: 5000,
        type: 'SNAPSHOT_LIMIT_NOISE',
        description: `noise-${index}`,
        createdAt: newerAt
      }))
    });
    await firstDb.gameRequest.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        roomId: room.id,
        type: 'BANK_PAYMENT',
        actorPlayerId: b.playerId,
        targetPlayerId: b.playerId,
        amount: 1,
        idempotencyKey: `snapshot-limit-noise-${index}`,
        createdAt: newerAt
      }))
    });

    const playerSnapshot = await first.snapshot(room.id, { role: 'PLAYER', playerId: a.playerId });

    expect(playerSnapshot.ledger.some((entry) => entry.playerId === a.playerId)).toBe(true);
    expect(playerSnapshot.requests.map((request) => request.id)).toContain(ownRequest.id);
  });

  it('keeps every pending request visible to the bank while bounding resolved history', async () => {
    const room = await first.createRoom({ name: '待审批快照上限', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-room');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'newer-property-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const lockedRequest = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'oldest-locked-request');
    await firstDb.gameRequest.update({ where: { id: lockedRequest.id }, data: { createdAt: new Date('2020-01-01T00:00:00.000Z') } });
    await firstDb.gameRequest.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
      roomId: room.id,
      type: 'COMPANION_EVENT',
      status: 'PENDING' as const,
      actorPlayerId: a.playerId,
      idempotencyKey: `pending-noise-${index}`,
      createdAt: new Date(Date.UTC(2021, 0, 1) + index * 1000),
    })) });
    await firstDb.gameRequest.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
      roomId: room.id,
      type: 'COMPANION_EVENT',
      status: 'REJECTED' as const,
      actorPlayerId: a.playerId,
      idempotencyKey: `resolved-noise-${index}`,
      rejectionReason: '测试已决历史',
      resolvedAt: new Date('2022-01-01T00:00:00.000Z'),
      createdAt: new Date(Date.UTC(2022, 0, 1) + index * 1000),
    })) });
    const newestResolved = await firstDb.gameRequest.findUniqueOrThrow({
      where: { roomId_idempotencyKey: { roomId: room.id, idempotencyKey: 'resolved-noise-100' } },
    });

    const snapshot = await first.snapshot(room.id);

    expect(snapshot.requests.filter((request) => request.status === 'PENDING')).toHaveLength(102);
    expect(snapshot.requests.filter((request) => request.status !== 'PENDING')).toHaveLength(100);
    expect(snapshot.requests.find((request) => request.id === lockedRequest.id)).toMatchObject({
      id: lockedRequest.id,
      propertyName: '甘露寺',
      status: 'PENDING',
    });
    expect(snapshot.requests.find((request) => request.id === newestResolved.id)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: '测试已决历史',
    });
  });

  it('exposes a fixed reversal candidate, skips blocked newer transactions, and rejects target drift', async () => {
    const { room, a, bank } = await physicalRoom();
    const olderAdjustment = await first.adjustBalance(room.id, a.playerId, 300, bank.token, '较早可撤销修正', 'older-reversal-candidate');
    const purchase = await first.createRequest(room.id, a.playerId, { type: 'BUY_PROPERTY', propertyName: '甘露寺' }, 'newer-property-purchase');
    await first.approve(room.id, purchase.id, bank.token, 'approve-newer-property-purchase');
    const landing = await first.declareLanding(room.id, a.playerId, '甘露寺', a.token, 'latest-reversal-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true);
    const lock = await first.createRequest(room.id, a.playerId, { type: 'BUILD_PROPERTY', propertyName: '甘露寺' }, 'block-newer-property-reversal');

    const bankSnapshot = await first.snapshot(room.id) as Awaited<ReturnType<PrismaGameService['snapshot']>> & {
      reversalCandidate: null | { id: string; type: string; createdAt: Date | string };
    };
    expect(bankSnapshot.reversalCandidate).toMatchObject({ id: olderAdjustment.id, type: 'MANUAL_BALANCE_CHANGE' });

    const purchaseTransaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: purchase.id } });
    await expect(first.reverseLatest(room.id, purchaseTransaction.id, bank.token, '目标已漂移', 'stale-reversal-target')).rejects.toThrow('REVERSAL_TARGET_STALE');

    const reversed = await first.reverseLatest(room.id, olderAdjustment.id, bank.token, '撤销较早修正', 'reverse-fixed-candidate');
    expect(reversed).toMatchObject({ id: olderAdjustment.id, reversed: true });
    expect(await firstDb.roomProperty.findFirstOrThrow({
      where: { roomId: room.id, definition: { name: '甘露寺' } },
    })).toMatchObject({ ownerPlayerId: a.playerId, lockedByRequestId: lock.id });
  });

  it('does not reverse a candidate that stopped being latest while confirmation was open', async () => {
    const { room, a, bank } = await physicalRoom();
    const firstAdjustment = await first.adjustBalance(room.id, a.playerId, 100, bank.token, '第一笔修正', 'first-moving-reversal');
    const before = await first.snapshot(room.id) as Awaited<ReturnType<PrismaGameService['snapshot']>> & {
      reversalCandidate: null | { id: string };
    };
    expect(before.reversalCandidate?.id).toBe(firstAdjustment.id);
    const secondAdjustment = await first.adjustBalance(room.id, a.playerId, 200, bank.token, '第二笔修正', 'second-moving-reversal');

    await expect(first.reverseLatest(room.id, firstAdjustment.id, bank.token, '确认期间目标变化', 'moving-reversal-key')).rejects.toThrow('REVERSAL_TARGET_STALE');
    const after = await first.snapshot(room.id) as Awaited<ReturnType<PrismaGameService['snapshot']>> & {
      reversalCandidate: null | { id: string };
    };
    expect(after.reversalCandidate?.id).toBe(secondAdjustment.id);
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'REVERSAL' } })).toBe(0);
  });

  it('allows plot fines only for positive integer amounts in a playing room', async () => {
    const room = await first.createRoom({ name: '剧情罚款状态', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');

    await expect(first.plotFine(room.id, a.playerId, 100, 'plot-fine-in-lobby', bank.token)).rejects.toThrow('ROOM_NOT_PLAYING');
    await first.start(room.id, bank.token, 'start-room');
    await expect(first.plotFine(room.id, a.playerId, 0, 'zero-plot-fine', bank.token)).rejects.toThrow('INVALID_AMOUNT');
    await expect(first.plotFine(room.id, a.playerId, 1.5, 'fractional-plot-fine', bank.token)).rejects.toThrow('INVALID_AMOUNT');
    await firstDb.room.update({ where: { id: room.id }, data: { status: 'ENDED', currentTurnPlayerId: null } });
    await expect(first.plotFine(room.id, a.playerId, 100, 'plot-fine-after-end', bank.token)).rejects.toThrow('ROOM_FINISHED');
  });

  it('rejects committed plot-fine replay after the room ends', async () => {
    const { room, a, bank } = await physicalRoom();
    const result = await first.plotFine(room.id, a.playerId, 400, 'replay-plot-fine', bank.token);
    await firstDb.room.update({ where: { id: room.id }, data: { status: 'ENDED', currentTurnPlayerId: null } });

    expect(result).toMatchObject({ id: expect.any(String) });
    await expect(second.plotFine(room.id, a.playerId, 400, 'replay-plot-fine', bank.token)).rejects.toThrow('ROOM_FINISHED');
    await expect(second.plotFine(room.id, a.playerId, 500, 'replay-plot-fine', bank.token)).rejects.toThrow('ROOM_FINISHED');
    expect(await firstDb.ledgerEntry.count({ where: { roomId: room.id, type: 'PLOT_FINE' } })).toBe(1);
  });

  it('starts, snapshots, and rotates electronic turns using only playable Players', async () => {
    const room = await first.createRoom({ name: 'Playable roster rotation', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    const b = await first.joinPlayer(room.code, '乙', 'huashifei');
    const dormant = await first.joinPlayer(room.code, '休眠玩家', 'meizhuang');
    const bank = await first.joinBank(room.code, '国库');
    const dormantMembership = await firstDb.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: state.players.get(dormant.playerId)!.accountId } },
    });
    await firstDb.roomMembership.update({ where: { id: dormantMembership.id }, data: { characterId: null } });
    await firstDb.player.update({ where: { id: dormant.playerId }, data: { characterId: null } });

    await first.start(room.id, bank.token, 'playable-roster-start');
    const initial = await first.snapshot(room.id);
    expect(initial.players.map((player) => player.id)).toEqual([a.playerId, b.playerId]);
    expect(initial.currentPlayerId).toBe(a.playerId);
    expect(initial.turn).toMatchObject({ playerId: a.playerId });

    await first.roll(room.id, a.playerId, 'playable-roster-roll');
    const ended = await first.endTurn(room.id, a.playerId, 'playable-roster-end-turn');
    expect(ended.playerId).toBe(b.playerId);
    const forced = await first.forceNext(room.id, bank.token, '跳过休眠身份', 'playable-roster-force-next');
    expect(forced.playerId).toBe(a.playerId);
    expect(forced.playerId).not.toBe(dormant.playerId);
    const after = await first.snapshot(room.id);
    expect(after.players.map((player) => player.id)).toEqual([a.playerId, b.playerId]);
    expect(after.currentPlayerId).toBe(a.playerId);
  });

  it('does not count a dormant retained Player toward the minimum start roster', async () => {
    const room = await first.createRoom({ name: 'Playable start count', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    await first.joinPlayer(room.code, '唯一玩家', 'zhenhuan');
    const dormant = await first.joinPlayer(room.code, '休眠身份', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    const dormantMembership = await firstDb.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: state.players.get(dormant.playerId)!.accountId } },
    });
    await firstDb.roomMembership.update({ where: { id: dormantMembership.id }, data: { characterId: null } });
    await firstDb.player.update({ where: { id: dormant.playerId }, data: { characterId: null } });

    await expect(first.start(room.id, bank.token, 'dormant-does-not-count'))
      .rejects.toThrow('PLAYER_COUNT_OUT_OF_RANGE');
    expect(await firstDb.room.findUniqueOrThrow({ where: { id: room.id } })).toMatchObject({
      status: 'LOBBY',
      currentTurnPlayerId: null,
      turnNumber: null,
    });
    expect(await firstDb.turn.count({ where: { roomId: room.id } })).toBe(0);
  });

  it('rejects an empty next-turn roster without ending the active turn', async () => {
    const room = await first.createRoom({ name: 'Empty next roster', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const a = await first.joinPlayer(room.code, '甲', 'zhenhuan');
    const b = await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'empty-next-start');
    const activeTurn = await firstDb.turn.findFirstOrThrow({ where: { roomId: room.id, status: 'ACTIVE' } });
    for (const playerId of [a.playerId, b.playerId]) {
      const player = await firstDb.player.findUniqueOrThrow({ where: { id: playerId } });
      await firstDb.roomMembership.update({ where: { id: player.memberId }, data: { characterId: null } });
      await firstDb.player.update({ where: { id: player.id }, data: { characterId: null } });
    }

    await expect(first.forceNext(room.id, bank.token, '没有可行动玩家', 'empty-next-force'))
      .rejects.toThrow('PLAYER_COUNT_OUT_OF_RANGE');
    expect(await firstDb.turn.findUniqueOrThrow({ where: { id: activeTurn.id } })).toMatchObject({ status: 'ACTIVE' });
    expect(await firstDb.room.findUniqueOrThrow({ where: { id: room.id } })).toMatchObject({
      currentTurnPlayerId: activeTurn.playerId,
      turnNumber: activeTurn.turnNumber,
    });
  });

  it('executes a non-current PLAYING replacement and rotates to the replacement instead of the dormant target', async () => {
    const room = await first.createRoom({ name: 'Non-current playing replacement', initialBalance: 5000, diceMode: 'ELECTRONIC' });
    const current = await first.joinPlayer(room.code, '当前玩家', 'zhenhuan');
    const target = await first.joinPlayer(room.code, '非当前目标', 'huashifei');
    await first.joinPlayer(room.code, '后续玩家', 'meizhuang');
    const bank = await first.joinBank(room.code, '申请人兼银行');
    await first.start(room.id, bank.token, 'non-current-replacement-start');
    const bankIdentity = await state.identities.get(bank.token)!;
    const targetIdentity = await state.identities.get(target.token)!;
    const accounts = new AccountRoomService(firstDb);

    const requested = await accounts.requestRoleSwap(bankIdentity.auth, room.id, 'huashifei', 'non-current-replacement-request');
    await accounts.acceptRoleSwap(targetIdentity.auth, requested.id, 'non-current-replacement-accept');
    const approved = await accounts.resolveRoleSwap(bankIdentity.auth, requested.id, 'APPROVE_BANK', 'non-current-replacement-bank');

    expect(approved.status).toBe('APPROVED');
    const requesterMembership = await firstDb.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: bankIdentity.actor.accountId } },
      include: { player: true },
    });
    const targetMembership = await firstDb.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: targetIdentity.actor.accountId } },
      include: { player: true },
    });
    expect(requesterMembership.player).toMatchObject({
      characterId: 'huashifei',
      pawnColor: targetMembership.player!.pawnColor,
      turnOrder: targetMembership.player!.turnOrder,
    });
    expect(targetMembership).toMatchObject({ characterId: null, player: { id: target.playerId, characterId: null } });

    const next = await first.forceNext(room.id, bank.token, '推进到接替者', 'non-current-replacement-force');
    expect(next.playerId).toBe(requesterMembership.player!.id);
    expect(next.playerId).not.toBe(target.playerId);
    const retainedProperty = await firstDb.roomProperty.findFirstOrThrow({
      where: { roomId: room.id, ownerPlayerId: target.playerId },
      include: { definition: true },
    });
    const game = new PrismaGameService(firstDb, () => 0);
    await game.roll(bankIdentity.actor, room.id, requesterMembership.player!.id, 'retained-owner-roll');
    const landing = await game.declareLanding(bankIdentity.actor, room.id, requesterMembership.player!.id, retainedProperty.definition.name, 'retained-owner-landing');
    await game.confirmLanding(bankIdentity.actor, room.id, landing.id, true, 'retained-owner-confirm');
    const balancesBeforeToll = await firstDb.player.findMany({
      where: { id: { in: [requesterMembership.player!.id, target.playerId] } },
      select: { id: true, balance: true, version: true },
      orderBy: { id: 'asc' },
    });
    await expect(game.payToll(bankIdentity.actor, room.id, requesterMembership.player!.id, retainedProperty.definition.name, 'retained-owner-toll'))
      .rejects.toThrow('NO_TOLL_DUE');
    expect(await firstDb.player.findMany({
      where: { id: { in: [requesterMembership.player!.id, target.playerId] } },
      select: { id: true, balance: true, version: true },
      orderBy: { id: 'asc' },
    })).toEqual(balancesBeforeToll);
    expect(await firstDb.idempotencyRecord.count({ where: { scope: `account:${bankIdentity.actor.accountId}:room:${room.id}:toll`, key: 'retained-owner-toll' } })).toBe(0);
    expect(await firstDb.idempotencyRecord.count({ where: { scope: `landing:${landing.id}:toll`, key: 'settled' } })).toBe(0);
    await expect(game.endTurn(bankIdentity.actor, room.id, requesterMembership.player!.id, 'retained-owner-end-turn'))
      .resolves.toMatchObject({ playerId: expect.not.stringMatching(new RegExp(`^${target.playerId}$`)) });
    expect((await first.snapshot(room.id)).players.map((player) => player.id)).not.toContain(target.playerId);
    expect((await firstDb.turn.findFirstOrThrow({ where: { roomId: room.id, status: 'ACTIVE' } })).playerId).not.toBe(target.playerId);
    expect(current.playerId).not.toBe(target.playerId);
  });

  it('rejects every gameplay target mutation for a public-replacement retained Player without mutation', async () => {
    const room = await first.createRoom({ name: 'Retained target rejection', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const seller = await first.joinPlayer(room.code, '卖方', 'zhenhuan');
    const target = await first.joinPlayer(room.code, '留存目标', 'huashifei');
    const bank = await first.joinBank(room.code, '接替者兼银行');
    await first.start(room.id, bank.token, 'retained-target-start');
    const bankIdentity = await state.identities.get(bank.token)!;
    const targetIdentity = await state.identities.get(target.token)!;
    const accounts = new AccountRoomService(firstDb);
    const sellerProperty = await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: seller.playerId }, include: { definition: true } });
    const targetProperty = await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: target.playerId }, include: { definition: true } });
    const extraSellerProperty = await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: null }, include: { definition: true } });
    const manualProperty = await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: null, id: { not: extraSellerProperty.id } }, include: { definition: true } });
    const dormantOwnerProperty = await firstDb.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: null, id: { notIn: [extraSellerProperty.id, manualProperty.id] } }, include: { definition: true } });
    await first.adjustProperty(room.id, extraSellerProperty.definition.name, { ownerPlayerId: seller.playerId }, bank.token, '交易测试准备', 'retained-target-extra-property');
    await first.adjustProperty(room.id, dormantOwnerProperty.definition.name, { ownerPlayerId: target.playerId }, bank.token, '留存产权测试准备', 'retained-owner-extra-property');
    await first.addSkipTurns(room.id, target.playerId, 2, 'MANUAL', bank.token, 'retained-target-pre-skip', '接替前停轮');
    const pendingTrade = await first.createRequest(room.id, seller.playerId, {
      type: 'TRADE_PROPERTY',
      propertyName: sellerProperty.definition.name,
      targetPlayerId: target.playerId,
      amount: 100,
    }, 'retained-target-pending-trade');
    await first.confirmTrade(room.id, pendingTrade.id, target.playerId, 'retained-target-confirm-before-swap');
    const dormantActorTrade = await first.createRequest(room.id, target.playerId, {
      type: 'TRADE_PROPERTY',
      propertyName: targetProperty.definition.name,
      targetPlayerId: seller.playerId,
      amount: 100,
    }, 'retained-actor-pending-trade');
    await first.confirmTrade(room.id, dormantActorTrade.id, seller.playerId, 'retained-actor-confirm-before-swap');
    const targetLanding = await first.declareLanding(room.id, target.playerId, targetProperty.definition.name, target.token, 'retained-target-unconfirmed-landing');

    const swap = await accounts.requestRoleSwap(bankIdentity.auth, room.id, 'huashifei', 'retained-target-swap-request');
    await accounts.acceptRoleSwap(targetIdentity.auth, swap.id, 'retained-target-swap-accept');
    await accounts.resolveRoleSwap(bankIdentity.auth, swap.id, 'APPROVE_BANK', 'retained-target-swap-approve');
    const retainedMembership = await firstDb.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: targetIdentity.actor.accountId } },
      include: { player: true },
    });
    expect(retainedMembership).toMatchObject({ characterId: null, player: { id: target.playerId, characterId: null } });

    const landing = await first.declareLanding(room.id, seller.playerId, targetProperty.definition.name, seller.token, 'retained-target-landing');
    await first.confirmLanding(room.id, landing.id, bank.token, true, 'retained-target-landing-confirm');
    const before = {
      player: await firstDb.player.findUniqueOrThrow({ where: { id: target.playerId } }),
      properties: await firstDb.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
      trade: await firstDb.gameRequest.findUniqueOrThrow({ where: { id: pendingTrade.id } }),
      actorTrade: await firstDb.gameRequest.findUniqueOrThrow({ where: { id: dormantActorTrade.id } }),
      targetLanding: await firstDb.landingEvent.findUniqueOrThrow({ where: { id: targetLanding.id } }),
      skips: await firstDb.skipTurnEntry.findMany({ where: { roomId: room.id, playerId: target.playerId }, orderBy: { id: 'asc' } }),
      transactionCount: await firstDb.gameTransaction.count({ where: { roomId: room.id } }),
      ledgerCount: await firstDb.ledgerEntry.count({ where: { roomId: room.id } }),
      auditCount: await firstDb.auditLog.count({ where: { roomId: room.id } }),
      requestCount: await firstDb.gameRequest.count({ where: { roomId: room.id } }),
      idempotencyCount: await firstDb.idempotencyRecord.count(),
    };

    const attempts = await Promise.allSettled([
      first.transfer(room.id, { fromPlayerId: seller.playerId, recipientType: 'PLAYER', toPlayerId: target.playerId, amount: 10, isPlotFine: false }, 'retained-target-transfer'),
      first.payToll(room.id, seller.playerId, targetProperty.definition.name, 'retained-target-toll'),
      first.confirmLanding(room.id, targetLanding.id, bank.token, true, 'retained-target-confirm-after-swap'),
      first.adjustBalance(room.id, target.playerId, 10, bank.token, '不应修正', 'retained-target-balance'),
      first.adjustProperty(room.id, manualProperty.definition.name, { ownerPlayerId: target.playerId }, bank.token, '不应分配', 'retained-target-property'),
      first.adjustProperty(room.id, targetProperty.definition.name, { buildingLevel: targetProperty.buildingLevel }, bank.token, '不应修改留存产权', 'retained-owner-omitted-property'),
      first.adjustProperty(room.id, dormantOwnerProperty.definition.name, { ownerPlayerId: null }, bank.token, '不应清空留存产权', 'retained-owner-clear-property'),
      first.adjustProperty(room.id, dormantOwnerProperty.definition.name, { ownerPlayerId: seller.playerId }, bank.token, '不应转移留存产权', 'retained-owner-reassign-property'),
      first.addSkipTurns(room.id, target.playerId, 1, 'MANUAL', bank.token, 'retained-target-add-skip', '不应停轮'),
      first.consumeSkip(room.id, target.playerId, 1, bank.token, 'retained-target-consume-skip', '不应消耗'),
      first.plotFine(room.id, target.playerId, 10, 'retained-target-fine', bank.token),
      first.createRequest(room.id, seller.playerId, {
        type: 'TRADE_PROPERTY',
        propertyName: extraSellerProperty.definition.name,
        targetPlayerId: target.playerId,
        amount: 10,
      }, 'retained-target-new-trade'),
      first.approve(room.id, pendingTrade.id, bank.token, 'retained-target-approve'),
      first.approve(room.id, dormantActorTrade.id, bank.token, 'retained-actor-approve'),
      first.confirmTrade(room.id, pendingTrade.id, target.playerId, 'retained-target-confirm-after-swap'),
      first.confirmTrade(room.id, dormantActorTrade.id, seller.playerId, 'retained-actor-confirm-before-swap'),
    ]);
    const codes = attempts.map((result) => result.status === 'rejected' ? (result.reason as Error).message : 'FULFILLED');
    expect(codes).toEqual([
      'PLAYER_NOT_FOUND',
      'NO_TOLL_DUE',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_IDENTITY_MISMATCH',
      'PLAYER_NOT_FOUND',
    ]);
    expect({
      player: await firstDb.player.findUniqueOrThrow({ where: { id: target.playerId } }),
      properties: await firstDb.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
      trade: await firstDb.gameRequest.findUniqueOrThrow({ where: { id: pendingTrade.id } }),
      actorTrade: await firstDb.gameRequest.findUniqueOrThrow({ where: { id: dormantActorTrade.id } }),
      targetLanding: await firstDb.landingEvent.findUniqueOrThrow({ where: { id: targetLanding.id } }),
      skips: await firstDb.skipTurnEntry.findMany({ where: { roomId: room.id, playerId: target.playerId }, orderBy: { id: 'asc' } }),
      transactionCount: await firstDb.gameTransaction.count({ where: { roomId: room.id } }),
      ledgerCount: await firstDb.ledgerEntry.count({ where: { roomId: room.id } }),
      auditCount: await firstDb.auditLog.count({ where: { roomId: room.id } }),
      requestCount: await firstDb.gameRequest.count({ where: { roomId: room.id } }),
      idempotencyCount: await firstDb.idempotencyRecord.count(),
    }).toEqual(before);
  });

  it('safely parses room-only socket subscriptions without bearer secrets', () => {
    const boundary = prismaGameServiceModule as unknown as {
      parseRoomSubscriptionPayload?: (payload: unknown) => { roomId: string } | null;
      matchesBearerToken?: unknown;
    };
    expect(boundary.parseRoomSubscriptionPayload).toBeTypeOf('function');
    expect(boundary.matchesBearerToken).toBeUndefined();
    if (!boundary.parseRoomSubscriptionPayload) return;
    expect(boundary.parseRoomSubscriptionPayload(null)).toBeNull();
    expect(boundary.parseRoomSubscriptionPayload({})).toBeNull();
    expect(boundary.parseRoomSubscriptionPayload({ roomId: 'room' })).toEqual({ roomId: 'room' });
    expect(boundary.parseRoomSubscriptionPayload({ roomId: 'room', token: 'ignored' })).toEqual({ roomId: 'room' });
  });
});
