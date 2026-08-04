import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApiApp } from './app.js';
import { hashPassword, sessionCookieName, verifyPassword } from './auth-domain.js';
import { AccountRoomService } from './account-room-service.js';

function configuredTestDatabaseUrl() {
  const rawUrl = process.env.TEST_DATABASE_URL;
  if (!rawUrl) return undefined;
  const parsed = new URL(rawUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol) || !databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must identify a PostgreSQL *_test database');
  }
  return rawUrl;
}

const testDatabaseUrl = configuredTestDatabaseUrl();
const integration = describe.skipIf(!testDatabaseUrl);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const migrationRoot = fileURLToPath(new URL('../../../packages/database/prisma/migrations/', import.meta.url));
const prismaCli = fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url));
const schemaName = `task6_admin_${process.pid}_${randomUUID().replaceAll('-', '')}`;
let isolatedUrl = '';
let db: PrismaClient;
let app: Awaited<ReturnType<typeof buildApiApp>>;
const configuredSuperAdmins = new Set<string>();

function executeSql(databaseUrl: string, sql: string) {
  execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--stdin', '--url', databaseUrl], {
    cwd: workspaceRoot,
    input: sql,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function executeMigration(databaseUrl: string, directory: string) {
  execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--file', `${migrationRoot}${directory}/migration.sql`, '--url', databaseUrl], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

beforeAll(async () => {
  if (!testDatabaseUrl) return;
  const url = new URL(testDatabaseUrl);
  url.searchParams.set('schema', schemaName);
  isolatedUrl = url.toString();
  executeSql(testDatabaseUrl, `CREATE SCHEMA "${schemaName}";`);
  for (const migration of readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    executeMigration(isolatedUrl, migration);
  }
  db = new PrismaClient({ datasources: { db: { url: isolatedUrl } } });
  app = await buildApiApp({
    database: db,
    logger: false,
    accounts: new AccountRoomService(db, (username) => configuredSuperAdmins.has(username)),
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  if (testDatabaseUrl && isolatedUrl) executeSql(testDatabaseUrl, `DROP SCHEMA "${schemaName}" CASCADE;`);
});

async function createAccount(options: { superAdmin?: boolean; canCreateRoom?: boolean; status?: 'ACTIVE' | 'DISABLED' } = {}) {
  const password = `Task6-${randomUUID()}`;
  const username = `${options.superAdmin ? 'task6-admin' : 'task6'}-${randomUUID()}`;
  if (options.superAdmin) configuredSuperAdmins.add(username);
  const account = await db.account.create({ data: {
    username,
    passwordHash: await hashPassword(password),
    displayName: `Task 6 ${randomUUID().slice(0, 8)}`,
    canCreateRoom: options.canCreateRoom ?? false,
    status: options.status ?? 'ACTIVE',
  } });
  return { account, password };
}

async function loginCookie(account: { username: string }, password: string, ip = '120.31.22.36') {
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: ip,
    headers: { 'user-agent': 'Mozilla/5.0 (Mac OS X) AppleWebKit/537.36 Chrome/140.0.0.0' },
    payload: { username: account.username, password },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((item) => item.name === sessionCookieName);
  expect(cookie?.value).toBeTruthy();
  return { header: `${sessionCookieName}=${cookie!.value}`, token: cookie!.value };
}

async function createRoom(creatorId: string, status: 'LOBBY' | 'PLAYING' | 'ENDED' | 'FINISHED' | 'CLOSED' = 'LOBBY') {
  return db.room.create({ data: {
    code: randomUUID().slice(0, 8).toUpperCase(),
    name: `Task 6 Room ${randomUUID().slice(0, 6)}`,
    status,
    ruleProfile: 'CUSTOM',
    difficulty: 'CUSTOM',
    participantCount: 5,
    playerLimit: 5,
    bankMode: 'DEDICATED_MODERATOR',
    characterAssignmentMode: 'PLAYER_SELECT',
    initialBalance: 6_000,
    diceMode: 'ELECTRONIC',
    skillEnabled: true,
    storyMoneyCounterpartyMode: 'TREASURY',
    transferApprovalRequired: false,
    startReward: 1_000,
    victoryMode: 'LAST_SOLVENT',
    createdBy: `creator-${creatorId}`,
    createdByAccountId: creatorId,
    visibility: 'PRIVATE',
    allowMidgameJoin: false,
    expiresAt: new Date(Date.now() + 86_400_000),
  } });
}

async function createPurgeFixture(creatorId: string, deletedByAccountId: string) {
  const shared = await createAccount();
  const peer = await createAccount();
  const latestDefinition = await db.propertyDefinition.findFirst({ orderBy: { displayOrder: 'desc' } });
  const definition = await db.propertyDefinition.create({ data: {
    name: `Purge Property ${randomUUID()}`,
    displayOrder: (latestDefinition?.displayOrder ?? 0) + 1,
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
  const character = await db.character.create({ data: {
    id: `purge-character-${randomUUID()}`,
    name: `Purge Character ${randomUUID()}`,
    skillCode: `purge-skill-${randomUUID()}`,
    skillConfig: {},
    initialPropertyId: definition.id,
  } });
  const room = await createRoom(creatorId, 'ENDED');
  const otherRoom = await createRoom(creatorId, 'ENDED');
  const member = await db.roomMembership.create({ data: {
    roomId: room.id,
    accountId: shared.account.id,
    characterId: character.id,
    displayNameSnapshot: shared.account.displayName,
  } });
  const peerMember = await db.roomMembership.create({ data: {
    roomId: room.id,
    accountId: peer.account.id,
    displayNameSnapshot: peer.account.displayName,
  } });
  const player = await db.player.create({ data: {
    roomId: room.id,
    memberId: member.id,
    characterId: character.id,
    pawnColor: `purge-${randomUUID()}`,
    balance: 90,
    turnOrder: 1,
  } });
  const peerPlayer = await db.player.create({ data: {
    roomId: room.id,
    memberId: peerMember.id,
    pawnColor: `purge-peer-${randomUUID()}`,
    balance: 100,
    turnOrder: 2,
  } });
  const property = await db.roomProperty.create({ data: {
    roomId: room.id,
    propertyDefinitionId: definition.id,
    ownerPlayerId: player.id,
  } });
  const turn = await db.turn.create({ data: {
    roomId: room.id,
    turnNumber: 1,
    playerId: player.id,
    status: 'ENDED',
  } });
  const landing = await db.landingEvent.create({ data: {
    roomId: room.id,
    turnId: turn.id,
    playerId: player.id,
    spaceType: 'PROPERTY',
    propertyId: property.id,
    status: 'CONFIRMED',
    plotResolved: true,
    declaredBy: member.id,
    confirmedBy: peerMember.id,
  } });
  const request = await db.gameRequest.create({ data: {
    roomId: room.id,
    type: 'TRADE_PROPERTY',
    status: 'EXECUTED',
    actorPlayerId: player.id,
    targetPlayerId: peerPlayer.id,
    propertyId: property.id,
    landingEventId: landing.id,
    turnId: turn.id,
    idempotencyKey: `purge-request-${randomUUID()}`,
    approvedByMemberId: peerMember.id,
  } });
  await db.roomProperty.update({ where: { id: property.id }, data: { lockedByRequestId: request.id } });
  const transaction = await db.gameTransaction.create({ data: {
    roomId: room.id,
    type: 'PURGE_FIXTURE',
    requestId: request.id,
    metadata: { roomId: room.id },
  } });
  await db.ledgerEntry.create({ data: {
    roomId: room.id,
    transactionId: transaction.id,
    playerId: player.id,
    amount: -10,
    balanceBefore: 100,
    balanceAfter: 90,
    type: 'PURGE_FIXTURE',
    description: 'purge fixture ledger',
    createdBy: member.id,
  } });
  await db.skipTurnEntry.create({ data: {
    roomId: room.id,
    playerId: player.id,
    sourceType: 'MANUAL',
    sourceDescription: 'purge fixture skip',
    originalCount: 1,
    remainingCount: 1,
    blocksTollCollection: true,
    createdBy: member.id,
    approvedBy: peerMember.id,
  } });
  await db.debtRecord.create({ data: {
    roomId: room.id,
    debtorPlayerId: player.id,
    creditorType: 'PLAYER',
    creditorPlayerId: peerPlayer.id,
    sourceRequestId: request.id,
    originalAmount: 10,
    outstandingAmount: 10,
  } });
  const roleSwap = await db.roleSwapRequest.create({ data: {
    roomId: room.id,
    requesterMembershipId: member.id,
    targetMembershipId: peerMember.id,
    kind: 'BANK',
    status: 'PENDING_BANK',
    bankApprovedById: peerMember.id,
  } });
  await db.gameResult.create({ data: {
    roomId: room.id,
    victoryMode: 'LAST_SOLVENT',
    endReason: 'purge fixture result',
    rulesSnapshot: {},
    playerAssetBreakdown: [],
    winnerPlayerIds: [player.id],
    confirmedBy: member.id,
  } });
  await db.auditLog.create({ data: {
    roomId: room.id,
    actorMemberId: member.id,
    actorRole: 'ADMIN',
    action: 'PURGE_FIXTURE',
    entityType: 'Room',
    entityId: room.id,
  } });
  await db.securityLog.create({ data: {
    actorAccountId: deletedByAccountId,
    action: 'PURGE_FIXTURE',
    detailsJson: { roomId: room.id },
  } });
  const settlement = await db.gameSettlement.create({ data: {
    roomId: room.id,
    endedByAccountId: deletedByAccountId,
    totalTurns: 1,
    durationSeconds: 60,
    winnersJson: [shared.account.id],
    rankingJson: [{ accountId: shared.account.id, rank: 1 }],
    overriddenBlockersJson: [],
  } });
  await db.settlementPlayer.create({ data: {
    settlementId: settlement.id,
    accountId: shared.account.id,
    displayNameSnapshot: shared.account.displayName,
    characterNameSnapshot: character.name,
    cash: 90,
    unmortgagedPropertyValue: 200,
    mortgagedPropertyNetValue: 0,
    buildingSellValue: 0,
    totalWealth: 290,
    rank: 1,
    isWinner: true,
    propertyDetailsJson: [],
  } });
  const otherMember = await db.roomMembership.create({ data: {
    roomId: otherRoom.id,
    accountId: shared.account.id,
    characterId: character.id,
    displayNameSnapshot: shared.account.displayName,
  } });
  const otherPlayer = await db.player.create({ data: {
    roomId: otherRoom.id,
    memberId: otherMember.id,
    characterId: character.id,
    pawnColor: `purge-other-${randomUUID()}`,
    balance: 100,
    turnOrder: 1,
  } });
  const otherProperty = await db.roomProperty.create({ data: {
    roomId: otherRoom.id,
    propertyDefinitionId: definition.id,
    ownerPlayerId: otherPlayer.id,
  } });
  const otherTurn = await db.turn.create({ data: {
    roomId: otherRoom.id,
    turnNumber: 1,
    playerId: otherPlayer.id,
    status: 'ENDED',
  } });
  const otherLanding = await db.landingEvent.create({ data: {
    roomId: otherRoom.id,
    turnId: otherTurn.id,
    playerId: otherPlayer.id,
    spaceType: 'PROPERTY',
    propertyId: otherProperty.id,
    status: 'CONFIRMED',
    plotResolved: true,
    declaredBy: otherMember.id,
    confirmedBy: otherMember.id,
  } });
  const otherRequest = await db.gameRequest.create({ data: {
    roomId: otherRoom.id,
    type: 'BUY_PROPERTY',
    status: 'EXECUTED',
    actorPlayerId: otherPlayer.id,
    propertyId: otherProperty.id,
    landingEventId: otherLanding.id,
    turnId: otherTurn.id,
    idempotencyKey: `purge-other-request-${randomUUID()}`,
    approvedByMemberId: otherMember.id,
  } });
  const otherTransaction = await db.gameTransaction.create({ data: {
    roomId: otherRoom.id,
    type: 'PURGE_OTHER_FIXTURE',
    requestId: otherRequest.id,
    metadata: { roomId: otherRoom.id },
  } });
  await db.securityLog.create({ data: {
    actorAccountId: deletedByAccountId,
    action: 'PURGE_OTHER_ROOM',
    detailsJson: { roomId: otherRoom.id },
  } });
  const tollKey = `purge-toll-${randomUUID()}`;
  const targetIdempotencyRecords = await Promise.all([
    db.idempotencyRecord.create({ data: {
      scope: `account:${shared.account.id}:room:${room.id}:request:${request.id}:approve`,
      key: `purge-request-${randomUUID()}`,
      response: { id: request.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `account:${shared.account.id}:room:${room.id}:role-swap:accept:${roleSwap.id}`,
      key: `purge-role-swap-${randomUUID()}`,
      response: { id: roleSwap.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `account:${shared.account.id}:room:${room.id}:toll`,
      key: tollKey,
      response: { id: transaction.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `landing:${landing.id}:toll`,
      key: 'settled',
      response: { requestKey: tollKey, transactionId: transaction.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `room:${room.id}:toll`,
      key: tollKey,
      response: { id: transaction.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `account:${deletedByAccountId}:admin:room:restore:${room.id}`,
      key: `purge-admin-room-${randomUUID()}`,
      response: { roomId: room.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `account:${deletedByAccountId}:admin:room:member:remove:${room.id}:${member.id}`,
      key: `purge-admin-member-${randomUUID()}`,
      response: { id: member.id, roomId: room.id },
    } }),
  ]);
  const otherTollKey = `purge-other-toll-${randomUUID()}`;
  const otherIdempotencyRecords = await Promise.all([
    db.idempotencyRecord.create({ data: {
      scope: `account:${shared.account.id}:room:${otherRoom.id}:request:${otherRequest.id}:approve`,
      key: `purge-other-request-${randomUUID()}`,
      response: { id: otherRequest.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `account:${shared.account.id}:room:${otherRoom.id}:role-swap:request`,
      key: `purge-other-role-swap-${randomUUID()}`,
      response: { roomId: otherRoom.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `landing:${otherLanding.id}:toll`,
      key: 'settled',
      response: { requestKey: otherTollKey, transactionId: otherTransaction.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `room:${otherRoom.id}:toll`,
      key: otherTollKey,
      response: { id: otherTransaction.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `account:${deletedByAccountId}:admin:room:member:remove:${otherRoom.id}:${otherMember.id}`,
      key: `purge-other-admin-member-${randomUUID()}`,
      response: { id: otherMember.id, roomId: otherRoom.id },
    } }),
    db.idempotencyRecord.create({ data: {
      scope: `account:${shared.account.id}:profile:note:${room.id}`,
      key: `purge-shared-account-${randomUUID()}`,
      response: { roomId: room.id, transactionId: transaction.id },
    } }),
  ]);
  await db.room.update({ where: { id: room.id }, data: {
    deletedAt: new Date('2026-08-04T00:00:00.000Z'),
    purgeAfter: new Date('2026-08-05T00:00:00.000Z'),
    deletedByAccountId,
  } });

  return {
    character,
    definition,
    otherIdempotencyRecords,
    otherRoom,
    room,
    settlement,
    shared,
    targetIdempotencyRecords,
  };
}

function expectNoSecrets(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/password|passwordHash|sessionTokenHash|activeSessionId|120\.31\.22\.36/);
}

function socketEvent<T>(socket: ClientSocket, name: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, listener);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 2_000);
    const listener = (payload: T) => {
      clearTimeout(timeout);
      socket.off(name, listener);
      resolve(payload);
    };
    socket.on(name, listener);
  });
}

integration('Task 6 real-Cookie admin routes', () => {
  it('moves ended rooms to trash without changing status, lists them, and restores them idempotently', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    await loginCookie(creator.account, creator.password);
    const creatorSession = await db.accountSession.findFirstOrThrow({
      where: { accountId: creator.account.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const adminHeaders = { cookie: cookie.header };
    const moveToTrash = (roomId: string, key: string) => app.inject({
      method: 'DELETE', url: `/api/admin/rooms/${roomId}`,
      headers: { ...adminHeaders, 'idempotency-key': key },
    });
    const playing = await createRoom(creator.account.id, 'PLAYING');
    const playingMember = await db.roomMembership.create({ data: {
      roomId: playing.id,
      accountId: creator.account.id,
      displayNameSnapshot: creator.account.displayName,
      activeSessionId: creatorSession.id,
      controlClaimedAt: new Date('2026-08-04T00:00:00.000Z'),
    } });
    const playingPlayer = await db.player.create({ data: {
      roomId: playing.id, memberId: playingMember.id, pawnColor: 'playing-trash-boundary', balance: 6_000, turnOrder: 1,
    } });
    const playingTurn = await db.turn.create({ data: {
      roomId: playing.id, turnNumber: 1, playerId: playingPlayer.id, status: 'ACTIVE',
    } });
    const playingRequest = await db.gameRequest.create({ data: {
      roomId: playing.id, type: 'TRASH_BOUNDARY', status: 'PENDING', actorPlayerId: playingPlayer.id, turnId: playingTurn.id,
      idempotencyKey: 'playing-trash-boundary-request',
    } });
    await db.room.update({ where: { id: playing.id }, data: { currentTurnPlayerId: playingPlayer.id, turnNumber: 1 } });
    const playingBefore = await db.room.findUniqueOrThrow({
      where: { id: playing.id },
      select: { status: true, currentTurnPlayerId: true, turnNumber: true, stateVersion: true, deletedAt: true, purgeAfter: true, deletedByAccountId: true },
    });
    const playingMemberBefore = await db.roomMembership.findUniqueOrThrow({ where: { id: playingMember.id } });
    const playingTurnBefore = await db.turn.findUniqueOrThrow({ where: { id: playingTurn.id } });
    const playingRequestBefore = await db.gameRequest.findUniqueOrThrow({ where: { id: playingRequest.id } });
    const playingTrashLogWhere = { action: 'ADMIN_ROOM_MOVED_TO_TRASH', detailsJson: { path: ['roomId'], equals: playing.id } };
    const playingIdempotencyWhere = { scope: `account:${admin.account.id}:admin:room:delete:${playing.id}`, key: 'playing-delete' };
    const [playingLogCountBefore, playingIdempotencyCountBefore] = await Promise.all([
      db.securityLog.count({ where: playingTrashLogWhere }),
      db.idempotencyRecord.count({ where: playingIdempotencyWhere }),
    ]);

    const playingDelete = await moveToTrash(playing.id, 'playing-delete');
    expect(playingDelete.statusCode).toBe(409);
    expect(playingDelete.json())
      .toEqual({ error: 'ROOM_MUST_END_BEFORE_DELETE' });
    expect(await db.room.findUniqueOrThrow({
      where: { id: playing.id },
      select: { status: true, currentTurnPlayerId: true, turnNumber: true, stateVersion: true, deletedAt: true, purgeAfter: true, deletedByAccountId: true },
    })).toEqual(playingBefore);
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: playingMember.id } })).toEqual(playingMemberBefore);
    expect(await db.turn.findUniqueOrThrow({ where: { id: playingTurn.id } })).toEqual(playingTurnBefore);
    expect(await db.gameRequest.findUniqueOrThrow({ where: { id: playingRequest.id } })).toEqual(playingRequestBefore);
    await expect(Promise.all([
      db.securityLog.count({ where: playingTrashLogWhere }),
      db.idempotencyRecord.count({ where: playingIdempotencyWhere }),
    ])).resolves.toEqual([playingLogCountBefore, playingIdempotencyCountBefore]);

    for (const status of ['LOBBY', 'ENDED', 'FINISHED', 'CLOSED'] as const) {
      const target = await createRoom(creator.account.id, status);
      const response = await moveToTrash(target.id, `trash-${status}`);
      expect(response.statusCode).toBe(200);
      const stored = await db.room.findUniqueOrThrow({ where: { id: target.id } });
      expect(stored.status).toBe(status);
      expect(stored.purgeAfter!.getTime() - stored.deletedAt!.getTime()).toBe(86_400_000);
    }

    const lobby = await createRoom(creator.account.id, 'LOBBY');
    const lobbyMember = await db.roomMembership.create({ data: {
      roomId: lobby.id,
      accountId: creator.account.id,
      displayNameSnapshot: creator.account.displayName,
      activeSessionId: creatorSession.id,
      controlClaimedAt: new Date('2026-08-04T00:00:00.000Z'),
    } });
    const lobbyPlayer = await db.player.create({ data: {
      roomId: lobby.id, memberId: lobbyMember.id, pawnColor: 'lobby-trash-boundary', balance: 6_000, turnOrder: 1,
    } });
    const lobbyTurn = await db.turn.create({ data: {
      roomId: lobby.id, turnNumber: 1, playerId: lobbyPlayer.id, status: 'ACTIVE',
    } });
    const lobbyRequest = await db.gameRequest.create({ data: {
      roomId: lobby.id, type: 'TRASH_BOUNDARY', status: 'PENDING', actorPlayerId: lobbyPlayer.id, turnId: lobbyTurn.id,
      idempotencyKey: 'lobby-trash-boundary-request',
    } });
    const lobbyTransaction = await db.gameTransaction.create({ data: {
      roomId: lobby.id, type: 'TRASH_BOUNDARY', metadata: {},
    } });
    const lobbyLedger = await db.ledgerEntry.create({ data: {
      roomId: lobby.id, transactionId: lobbyTransaction.id, playerId: lobbyPlayer.id,
      amount: 0, balanceBefore: 6_000, balanceAfter: 6_000, type: 'TRASH_BOUNDARY', description: 'trash boundary',
    } });
    const lobbyAudit = await db.auditLog.create({ data: {
      roomId: lobby.id, actorMemberId: lobbyMember.id, actorRole: 'ADMIN', action: 'TRASH_BOUNDARY', entityType: 'Room', entityId: lobby.id,
    } });
    await db.room.update({ where: { id: lobby.id }, data: { currentTurnPlayerId: lobbyPlayer.id, turnNumber: 1 } });
    const lobbyBefore = await db.room.findUniqueOrThrow({
      where: { id: lobby.id },
      select: { status: true, currentTurnPlayerId: true, turnNumber: true, stateVersion: true, deletedAt: true, purgeAfter: true, deletedByAccountId: true },
    });
    const [lobbyMemberBefore, lobbyTurnBefore, lobbyRequestBefore, lobbyTransactionBefore, lobbyLedgerBefore, lobbyAuditBefore] = await Promise.all([
      db.roomMembership.findUniqueOrThrow({ where: { id: lobbyMember.id } }),
      db.turn.findUniqueOrThrow({ where: { id: lobbyTurn.id } }),
      db.gameRequest.findUniqueOrThrow({ where: { id: lobbyRequest.id } }),
      db.gameTransaction.findUniqueOrThrow({ where: { id: lobbyTransaction.id } }),
      db.ledgerEntry.findUniqueOrThrow({ where: { id: lobbyLedger.id } }),
      db.auditLog.findUniqueOrThrow({ where: { id: lobbyAudit.id } }),
    ]);
    const first = await moveToTrash(lobby.id, 'trash-lobby');
    expect(first.statusCode).toBe(200);
    const firstStored = await db.room.findUniqueOrThrow({ where: { id: lobby.id } });
    expect(firstStored.stateVersion).toBe(lobbyBefore.stateVersion + 1);
    expect(first.json()).toMatchObject({ stateVersion: firstStored.stateVersion });
    expect(firstStored).toMatchObject({
      status: lobbyBefore.status,
      currentTurnPlayerId: lobbyBefore.currentTurnPlayerId,
      turnNumber: lobbyBefore.turnNumber,
      deletedByAccountId: admin.account.id,
    });
    await expect(Promise.all([
      db.roomMembership.findUniqueOrThrow({ where: { id: lobbyMember.id } }),
      db.turn.findUniqueOrThrow({ where: { id: lobbyTurn.id } }),
      db.gameRequest.findUniqueOrThrow({ where: { id: lobbyRequest.id } }),
      db.gameTransaction.findUniqueOrThrow({ where: { id: lobbyTransaction.id } }),
      db.ledgerEntry.findUniqueOrThrow({ where: { id: lobbyLedger.id } }),
      db.auditLog.findUniqueOrThrow({ where: { id: lobbyAudit.id } }),
    ])).resolves.toEqual([lobbyMemberBefore, lobbyTurnBefore, lobbyRequestBefore, lobbyTransactionBefore, lobbyLedgerBefore, lobbyAuditBefore]);
    await moveToTrash(lobby.id, 'trash-lobby');
    await moveToTrash(lobby.id, 'trash-lobby-new-key');
    const repeatedStored = await db.room.findUniqueOrThrow({ where: { id: lobby.id } });
    expect(repeatedStored.deletedAt).toEqual(firstStored.deletedAt);
    expect(repeatedStored.purgeAfter).toEqual(firstStored.purgeAfter);
    expect(repeatedStored.stateVersion).toBe(firstStored.stateVersion);

    const trash = await app.inject({ method: 'GET', url: '/api/admin/rooms/trash', headers: adminHeaders });
    expect(trash.statusCode).toBe(200);
    expect(trash.json().items.map((item: { purgeAfter: string }) => item.purgeAfter))
      .toEqual([...trash.json().items.map((item: { purgeAfter: string }) => item.purgeAfter)].sort());
    expect(trash.json().items.find((item: { id: string }) => item.id === lobby.id)).toMatchObject({
      deletedBy: { id: admin.account.id, displayName: admin.account.displayName },
    });

    const restored = await app.inject({
      method: 'POST', url: `/api/admin/rooms/${lobby.id}/restore`,
      headers: { ...adminHeaders, 'idempotency-key': 'restore-lobby' },
    });
    expect(restored.statusCode).toBe(200);
    const restoredRoom = await db.room.findUniqueOrThrow({ where: { id: lobby.id } });
    expect(restoredRoom).toMatchObject({ status: 'LOBBY', deletedAt: null, purgeAfter: null, deletedByAccountId: null });
    expect(restoredRoom.stateVersion).toBe(firstStored.stateVersion + 1);
    expect(restored.json()).toMatchObject({ stateVersion: restoredRoom.stateVersion });
    const restoreReplay = await app.inject({
      method: 'POST', url: `/api/admin/rooms/${lobby.id}/restore`,
      headers: { ...adminHeaders, 'idempotency-key': 'restore-lobby' },
    });
    expect(restoreReplay.statusCode).toBe(200);
    expect((await db.room.findUniqueOrThrow({ where: { id: lobby.id } })).stateVersion).toBe(restoredRoom.stateVersion);
    const restoredAgain = await app.inject({
      method: 'POST', url: `/api/admin/rooms/${lobby.id}/restore`,
      headers: { ...adminHeaders, 'idempotency-key': 'restore-lobby-new-key' },
    });
    expect(restoredAgain.statusCode).toBe(200);
    expect((await db.room.findUniqueOrThrow({ where: { id: lobby.id } })).stateVersion).toBe(restoredRoom.stateVersion);
  });

  it('isolates trashed rooms from listings, protected reads, and dashboard aggregates', async () => {
    const admin = await createAccount({ superAdmin: true });
    const player = await createAccount();
    const adminCookie = await loginCookie(admin.account, admin.password);
    const playerCookie = await loginCookie(player.account, player.password);
    const adminHeaders = { cookie: adminCookie.header };
    const playerHeaders = { cookie: playerCookie.header, 'idempotency-key': 'trash-isolation-read' };
    const before = (await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: adminHeaders })).json();
    const deletedAt = new Date('2026-08-04T00:00:00.000Z');
    const purgeAfter = new Date('2026-08-05T00:00:00.000Z');

    const trashedLobby = await createRoom(player.account.id, 'LOBBY');
    const trashedPlaying = await createRoom(player.account.id, 'PLAYING');
    await db.room.updateMany({
      where: { id: { in: [trashedLobby.id, trashedPlaying.id] } },
      data: { deletedAt, purgeAfter, deletedByAccountId: admin.account.id },
    });
    const trashed = await createRoom(player.account.id, 'PLAYING');
    const playerSession = await db.accountSession.findFirstOrThrow({ where: { accountId: player.account.id, revokedAt: null } });
    await db.roomMembership.create({ data: {
      roomId: trashed.id,
      accountId: player.account.id,
      displayNameSnapshot: player.account.displayName,
      activeSessionId: playerSession.id,
      controlClaimedAt: new Date(),
    } });
    await db.securityLog.create({ data: {
      accountId: player.account.id,
      action: 'CHARACTER_SELECTED',
      detailsJson: { roomId: trashed.id, characterId: `trashed-character-${randomUUID()}`, characterNameSnapshot: 'Trashed Character' },
    } });
    await db.gameSettlement.create({ data: {
      roomId: trashed.id,
      endedByAccountId: admin.account.id,
      endedAt: new Date('2026-08-04T01:00:00.000Z'),
      totalTurns: 1,
      durationSeconds: 60,
      forced: false,
      winnersJson: [player.account.id],
      rankingJson: [{ accountId: player.account.id, rank: 1 }],
      players: { create: [{
        accountId: player.account.id,
        displayNameSnapshot: player.account.displayName,
        characterNameSnapshot: 'Trashed Character',
        cash: 6_000,
        unmortgagedPropertyValue: 0,
        mortgagedPropertyNetValue: 0,
        buildingSellValue: 0,
        totalWealth: 6_000,
        rank: 1,
        isWinner: true,
        propertyDetailsJson: [],
      }] },
    } });
    await db.room.update({ where: { id: trashed.id }, data: { status: 'FINISHED' } });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/rooms/${trashed.id}`,
      headers: { ...adminHeaders, 'idempotency-key': 'trash-isolation' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ id: trashed.id, created: true });

    expect((await app.inject({ method: 'GET', url: '/api/rooms', headers: playerHeaders })).json())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: trashed.id })]));
    expect((await app.inject({ method: 'GET', url: '/api/admin/rooms', headers: adminHeaders })).json().items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: trashed.id })]));
    expect((await app.inject({ method: 'GET', url: `/api/admin/rooms/${trashed.id}`, headers: adminHeaders })).statusCode).toBe(404);

    for (const request of [
      { method: 'GET', url: `/api/rooms/${trashed.id}/seats` },
      { method: 'GET', url: `/api/rooms/${trashed.id}/snapshot?view=PLAYER` },
      { method: 'GET', url: `/api/rooms/${trashed.id}/settlement` },
      { method: 'POST', url: `/api/rooms/${trashed.id}/join`, payload: {} },
    ] as const) {
      const response = await app.inject({ ...request, headers: playerHeaders });
      expect([403, 404]).toContain(response.statusCode);
    }

    const dashboard = (await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: adminHeaders })).json();
    expect(dashboard.rooms).toEqual(before.rooms);
    expect(dashboard.games).toEqual(before.games);
    expect(dashboard.characterSelections).not.toContainEqual({
      characterId: expect.stringMatching(/^trashed-character-/), characterNameSnapshot: 'Trashed Character', count: 1,
    });
    expect(dashboard.characterWins).not.toContainEqual({ characterNameSnapshot: 'Trashed Character', count: 1 });
    expect(dashboard.recentGames).not.toEqual(expect.arrayContaining([expect.objectContaining({ roomId: trashed.id })]));
  });

  it('excludes character selections from deleted rooms', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const activeRoom = await createRoom(creator.account.id);
    const definition = await db.propertyDefinition.create({ data: {
      name: `Dashboard orphan property ${randomUUID()}`,
      displayOrder: Math.floor(Math.random() * 1_000_000),
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
    const characterId = `dashboard-orphan-${randomUUID()}`;
    await db.character.create({ data: {
      id: characterId,
      name: 'Existing room character',
      skillCode: `dashboard-orphan-skill-${randomUUID()}`,
      skillConfig: {},
      initialPropertyId: definition.id,
    } });
    await db.securityLog.createMany({ data: [
      { accountId: creator.account.id, action: 'CHARACTER_SELECTED', detailsJson: { roomId: activeRoom.id, characterId, characterNameSnapshot: 'Existing room character' } },
      { accountId: creator.account.id, action: 'CHARACTER_SELECTED', detailsJson: { roomId: `deleted-room-${randomUUID()}`, characterId, characterNameSnapshot: 'Existing room character' } },
    ] });

    const dashboard = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: cookie.header } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().characterSelections).toContainEqual({ characterId, characterNameSnapshot: 'Existing room character', count: 1 });
  });

  it('physically deletes an unreferenced ordinary account but never a current or super-admin account', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const otherAdmin = await createAccount({ superAdmin: true });
    const cookie = await loginCookie(admin.account, admin.password);
    await loginCookie(target.account, target.password);

    const deleted = await app.inject({
      method: 'DELETE', url: `/api/admin/accounts/${target.account.id}`,
      headers: { cookie: cookie.header, 'idempotency-key': 'account-delete' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await db.account.findUnique({ where: { id: target.account.id } })).toBeNull();
    expect(await db.accountSession.count({ where: { accountId: target.account.id } })).toBe(0);
    expect(await db.securityLog.count({ where: { OR: [{ accountId: target.account.id }, { actorAccountId: target.account.id }] } })).toBe(0);

    const current = await app.inject({
      method: 'DELETE', url: `/api/admin/accounts/${admin.account.id}`,
      headers: { cookie: cookie.header, 'idempotency-key': 'current-admin-delete' },
    });
    const protectedAdmin = await app.inject({
      method: 'DELETE', url: `/api/admin/accounts/${otherAdmin.account.id}`,
      headers: { cookie: cookie.header, 'idempotency-key': 'other-admin-delete' },
    });
    expect(current.json()).toEqual({ error: 'CANNOT_DELETE_CURRENT_ACCOUNT' });
    expect(protectedAdmin.json()).toEqual({ error: 'CANNOT_DELETE_SUPER_ADMIN' });
  });

  it('returns authoritative lastLoginAt in the authenticated login Account DTO', async () => {
    const account = await createAccount();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: account.account.username, password: account.password } });
    expect(login.statusCode).toBe(200);
    expect(login.json().account.lastLoginAt).toEqual(expect.any(String));
  });

  it('allows a current super-admin Session to read the bounded SecurityLog API', async () => {
    const admin = await createAccount({ superAdmin: true });
    const cookie = await loginCookie(admin.account, admin.password);
    const response = await app.inject({ method: 'GET', url: '/api/admin/security-logs?limit=10', headers: { cookie: cookie.header } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: expect.any(Array) });
    expectNoSecrets(response.json());
  });

  it('enforces real current admin authorization for account, room, log, and dashboard families', async () => {
    const ordinary = await createAccount();
    const ordinaryCookie = await loginCookie(ordinary.account, ordinary.password);
    for (const url of ['/api/admin/accounts', '/api/admin/rooms', '/api/admin/security-logs', '/api/admin/dashboard']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: ordinaryCookie.header } });
      expect(response.statusCode, url).toBe(403);
      expect(response.json(), url).toEqual({ error: 'ADMIN_REQUIRED' });
    }

    const admin = await createAccount({ superAdmin: true });
    const adminCookie = await loginCookie(admin.account, admin.password);
    configuredSuperAdmins.delete(admin.account.username);
    const privilegeRevoked = await app.inject({ method: 'GET', url: '/api/admin/security-logs', headers: { cookie: adminCookie.header } });
    expect(privilegeRevoked.statusCode).toBe(403);
    expect(privilegeRevoked.json()).toEqual({ error: 'ADMIN_REQUIRED' });

    await db.account.update({ where: { id: admin.account.id }, data: { status: 'DISABLED' } });
    const disabled = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: adminCookie.header } });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toEqual({ error: 'SESSION_INVALID' });
  });

  it('creates accounts transactionally with replay, payload conflict, actor isolation, and safe DTOs', async () => {
    const firstAdmin = await createAccount({ superAdmin: true });
    const secondAdmin = await createAccount({ superAdmin: true });
    const firstCookie = await loginCookie(firstAdmin.account, firstAdmin.password);
    const secondCookie = await loginCookie(secondAdmin.account, secondAdmin.password);
    const username = `created-${randomUUID()}`;
    const payload = { username, password: 'Created-password-1', displayName: 'Created Account', canCreateRoom: true, note: 'reviewed' };
    const headers = { cookie: firstCookie.header, 'idempotency-key': 'account-create-key' };

    const created = await app.inject({ method: 'POST', url: '/api/admin/accounts', headers, payload });
    const replay = await app.inject({ method: 'POST', url: '/api/admin/accounts', headers, payload });
    const changed = await app.inject({ method: 'POST', url: '/api/admin/accounts', headers, payload: { ...payload, displayName: 'Changed' } });
    const isolated = await app.inject({ method: 'POST', url: '/api/admin/accounts', headers: { cookie: secondCookie.header, 'idempotency-key': 'account-create-key' }, payload: { ...payload, username: `${username}-other` } });

    expect(created.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
    expect(isolated.statusCode).toBe(200);
    expect(Object.keys(created.json()).sort()).toEqual(['canCreateRoom', 'createdAt', 'displayName', 'id', 'isSuperAdmin', 'lastLoginAt', 'note', 'status', 'updatedAt', 'username']);
    expectNoSecrets([created.json(), replay.json()]);
    expect(await db.account.count({ where: { username } })).toBe(1);
    expect(await db.securityLog.count({ where: { accountId: created.json().id, action: 'ACCOUNT_CREATED' } })).toBe(1);

    const duplicate = await app.inject({ method: 'POST', url: '/api/admin/accounts', headers: { cookie: firstCookie.header, 'idempotency-key': 'duplicate-key' }, payload: { ...payload, password: 'Different-password-2' } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'USERNAME_TAKEN' });
  });

  it('serializes concurrent same-key account creation and persists no password-derived plaintext', async () => {
    const admin = await createAccount({ superAdmin: true });
    const cookie = await loginCookie(admin.account, admin.password);
    const username = `concurrent-${randomUUID()}`;
    const plaintext = `Concurrent-${randomUUID()}`;
    const request = {
      method: 'POST' as const,
      url: '/api/admin/accounts',
      headers: { cookie: cookie.header, 'idempotency-key': 'concurrent-account-create' },
      payload: { username, password: plaintext, displayName: 'Concurrent account' },
    };
    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect(await db.account.count({ where: { username } })).toBe(1);
    expect(await db.securityLog.count({ where: { accountId: responses[0]!.json().id, action: 'ACCOUNT_CREATED' } })).toBe(1);
    const [records, logs] = await Promise.all([
      db.idempotencyRecord.findMany({ where: { key: 'concurrent-account-create' } }),
      db.securityLog.findMany({ where: { accountId: responses[0]!.json().id } }),
    ]);
    expect(JSON.stringify([responses.map((response) => response.json()), records, logs])).not.toContain(plaintext);
  });

  it('rejects an account-create key reused with a different username', async () => {
    const admin = await createAccount({ superAdmin: true });
    const cookie = await loginCookie(admin.account, admin.password);
    const first = await app.inject({ method: 'POST', url: '/api/admin/accounts', headers: { cookie: cookie.header, 'idempotency-key': 'changed-create-username' }, payload: { username: `first-${randomUUID()}`, password: 'First-password-1', displayName: 'First' } });
    const changed = await app.inject({ method: 'POST', url: '/api/admin/accounts', headers: { cookie: cookie.header, 'idempotency-key': 'changed-create-username' }, payload: { username: `second-${randomUUID()}`, password: 'First-password-1', displayName: 'First' } });
    expect(first.statusCode).toBe(200);
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rolls an account mutation and idempotency record back when its SecurityLog insert fails', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const original = target.account.displayName;
    executeSql(isolatedUrl, `
      CREATE OR REPLACE FUNCTION "task6_reject_account_update_log"() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW."action" = 'ACCOUNT_UPDATED' THEN RAISE EXCEPTION 'task6 forced log failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "task6_reject_account_update_log"
      BEFORE INSERT ON "SecurityLog" FOR EACH ROW EXECUTE FUNCTION "task6_reject_account_update_log"();
    `);
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/admin/accounts/${target.account.id}`,
        headers: { cookie: cookie.header, 'idempotency-key': 'atomic-account-update' },
        payload: { displayName: 'Must roll back' },
      });
      expect(response.statusCode).toBe(500);
      expect((await db.account.findUniqueOrThrow({ where: { id: target.account.id } })).displayName).toBe(original);
      expect(await db.idempotencyRecord.count({ where: { key: 'atomic-account-update' } })).toBe(0);
    } finally {
      executeSql(isolatedUrl, 'DROP TRIGGER IF EXISTS "task6_reject_account_update_log" ON "SecurityLog"; DROP FUNCTION IF EXISTS "task6_reject_account_update_log"();');
    }
  });

  it('replays account update/reset/status writes and rejects changed password payloads without plaintext persistence', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const updateRequest = { method: 'PATCH' as const, url: `/api/admin/accounts/${target.account.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'account-update-replay' }, payload: { displayName: 'Updated exactly once' } };
    const update = await app.inject(updateRequest);
    const updateReplay = await app.inject(updateRequest);
    expect(updateReplay.json()).toEqual(update.json());
    expect(await db.securityLog.count({ where: { accountId: target.account.id, action: 'ACCOUNT_UPDATED' } })).toBe(1);

    const password = `Reset-${randomUUID()}`;
    const resetRequest = { method: 'POST' as const, url: `/api/admin/accounts/${target.account.id}/reset-password`, headers: { cookie: cookie.header, 'idempotency-key': 'account-reset-replay' }, payload: { password } };
    const reset = await app.inject(resetRequest);
    const resetReplay = await app.inject(resetRequest);
    const changed = await app.inject({ ...resetRequest, payload: { password: `${password}-changed` } });
    expect(reset.statusCode).toBe(200);
    expect(resetReplay.json()).toEqual(reset.json());
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });

    const disabled = await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/disable`, headers: { cookie: cookie.header, 'idempotency-key': 'account-disable-replay' } });
    const disabledReplay = await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/disable`, headers: { cookie: cookie.header, 'idempotency-key': 'account-disable-replay' } });
    expect(disabled.statusCode).toBe(200);
    expect(disabledReplay.json()).toEqual(disabled.json());
    const persisted = await db.idempotencyRecord.findMany({ where: { key: { in: ['account-reset-replay', 'account-disable-replay'] } } });
    expect(JSON.stringify([reset.json(), resetReplay.json(), persisted])).not.toContain(password);
  });

  it('serializes exact concurrent keys across update, reset, device, status, config, password, and removal writes', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const creator = await createAccount();
    const memberAccount = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id);
    const member = await db.roomMembership.create({ data: { roomId: room.id, accountId: memberAccount.account.id, displayNameSnapshot: memberAccount.account.displayName } });
    const exact = async (request: Parameters<typeof app.inject>[0]) => {
      const responses = await Promise.all([app.inject(request), app.inject(request)]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(responses[1]!.json()).toEqual(responses[0]!.json());
    };

    await exact({ method: 'PATCH', url: `/api/admin/accounts/${target.account.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'concurrent-update' }, payload: { note: 'one update' } });
    const resetPassword = `Concurrent-reset-${randomUUID()}`;
    await exact({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/reset-password`, headers: { cookie: cookie.header, 'idempotency-key': 'concurrent-reset' }, payload: { password: resetPassword } });
    const targetCookie = await loginCookie(target.account, resetPassword);
    const session = await db.accountSession.findFirstOrThrow({ where: { accountId: target.account.id, revokedAt: null } });
    await exact({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/sessions/${session.id}/revoke`, headers: { cookie: cookie.header, 'idempotency-key': 'concurrent-device' }, payload: { reason: 'concurrent review' } });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: targetCookie.header } })).statusCode).toBe(401);
    await exact({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/disable`, headers: { cookie: cookie.header, 'idempotency-key': 'concurrent-disable' } });
    await exact({ method: 'PATCH', url: `/api/admin/rooms/${room.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'concurrent-config' }, payload: { name: 'Concurrent room update' } });
    await exact({ method: 'POST', url: `/api/admin/rooms/${room.id}/password`, headers: { cookie: cookie.header, 'idempotency-key': 'concurrent-password' }, payload: { password: 'concurrent-room-secret' } });
    await exact({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'concurrent-remove' }, payload: {} });
    for (const [action, count] of [
      ['ACCOUNT_UPDATED', 1], ['PASSWORD_RESET', 1], ['ACCOUNT_SESSION_REVOKED', 1], ['ACCOUNT_DISABLED', 1],
      ['ADMIN_ROOM_UPDATED', 1], ['ADMIN_ROOM_PASSWORD_UPDATED', 1], ['ADMIN_MEMBER_REMOVED', 1],
    ] as const) expect(await db.securityLog.count({ where: { action } }), action).toBeGreaterThanOrEqual(count);
    for (const key of ['concurrent-update', 'concurrent-reset', 'concurrent-device', 'concurrent-disable', 'concurrent-config', 'concurrent-password', 'concurrent-remove']) {
      expect(await db.idempotencyRecord.count({ where: { key } }), key).toBe(1);
    }
  });

  it('rejects revoked and expired real admin actors before every privileged route family', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const creator = await createAccount();
    const room = await createRoom(creator.account.id);
    const member = await db.roomMembership.create({ data: { roomId: room.id, accountId: target.account.id, displayNameSnapshot: target.account.displayName } });
    const revokedCookie = await loginCookie(admin.account, admin.password);
    const revokedSession = await db.accountSession.findFirstOrThrow({ where: { accountId: admin.account.id, revokedAt: null } });
    await db.accountSession.update({ where: { id: revokedSession.id }, data: { revokedAt: new Date(), revokeReason: 'TEST_REVOKED' } });
    const routeCases = [
      { method: 'POST' as const, url: '/api/admin/accounts', payload: { username: `blocked-${randomUUID()}`, password: 'Blocked-password-1', displayName: 'Blocked' } },
      { method: 'GET' as const, url: `/api/admin/accounts/${target.account.id}/sessions` },
      { method: 'PATCH' as const, url: `/api/admin/rooms/${room.id}`, payload: { name: 'Blocked' } },
      { method: 'POST' as const, url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`, payload: {} },
      { method: 'GET' as const, url: '/api/admin/security-logs' },
      { method: 'GET' as const, url: `/api/admin/rooms/${room.id}/audit-logs` },
      { method: 'GET' as const, url: '/api/admin/dashboard' },
    ];
    for (const item of routeCases) {
      const response = await app.inject({ ...item, headers: { cookie: revokedCookie.header, 'idempotency-key': `revoked-${randomUUID()}` } });
      expect(response.statusCode, `${item.method} ${item.url}`).toBe(401);
      expect(response.json()).toEqual({ error: 'SESSION_INVALID' });
    }

    const expiredCookie = await loginCookie(admin.account, admin.password);
    await db.accountSession.updateMany({ where: { accountId: admin.account.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1) } });
    const expired = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/password`, headers: { cookie: expiredCookie.header, 'idempotency-key': 'expired-room-password' }, payload: { password: null } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ error: 'SESSION_INVALID' });
  });

  it('enforces ordinary, disabled, revoked, expired, and privilege-revoked actors across every admin family', async () => {
    const target = await createAccount();
    const creator = await createAccount();
    const room = await createRoom(creator.account.id);
    const cases = [
      { method: 'GET' as const, url: `/api/admin/accounts/${target.account.id}/sessions` },
      { method: 'GET' as const, url: `/api/admin/rooms/${room.id}` },
      { method: 'GET' as const, url: '/api/admin/security-logs' },
      { method: 'GET' as const, url: '/api/admin/dashboard' },
      { method: 'POST' as const, url: `/api/admin/rooms/${room.id}/finish`, payload: { reason: 'must not execute' } },
    ];
    const assertActor = async (cookie: string, status: number, code: string, label: string) => {
      for (const item of cases) {
        const response = await app.inject({ ...item, headers: { cookie, 'idempotency-key': `${label}-${randomUUID()}` } });
        expect(response.statusCode, `${label} ${item.method} ${item.url}`).toBe(status);
        expect(response.json()).toEqual({ error: code });
      }
    };

    const ordinary = await createAccount();
    await assertActor((await loginCookie(ordinary.account, ordinary.password)).header, 403, 'ADMIN_REQUIRED', 'ordinary');
    for (const state of ['disabled', 'revoked', 'expired', 'privilege'] as const) {
      const actor = await createAccount({ superAdmin: true });
      const cookie = await loginCookie(actor.account, actor.password);
      const session = await db.accountSession.findFirstOrThrow({ where: { accountId: actor.account.id, revokedAt: null } });
      if (state === 'disabled') await db.account.update({ where: { id: actor.account.id }, data: { status: 'DISABLED' } });
      if (state === 'revoked') await db.accountSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokeReason: 'TEST_REVOKED' } });
      if (state === 'expired') await db.accountSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1) } });
      if (state === 'privilege') configuredSuperAdmins.delete(actor.account.username);
      await assertActor(cookie.header, state === 'privilege' ? 403 : 401, state === 'privilege' ? 'ADMIN_REQUIRED' : 'SESSION_INVALID', state);
    }
    expect(await db.gameSettlement.count({ where: { roomId: room.id } })).toBe(0);
  });

  it('isolates the same key across admins for every write family and rejects changed payloads within one admin scope', async () => {
    const firstAdmin = await createAccount({ superAdmin: true });
    const secondAdmin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const creator = await createAccount();
    const firstCookie = await loginCookie(firstAdmin.account, firstAdmin.password);
    const secondCookie = await loginCookie(secondAdmin.account, secondAdmin.password);
    const accountKey = 'cross-admin-update';
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/accounts/${target.account.id}`, headers: { cookie: firstCookie.header, 'idempotency-key': accountKey }, payload: { displayName: 'First admin name' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/accounts/${target.account.id}`, headers: { cookie: secondCookie.header, 'idempotency-key': accountKey }, payload: { note: 'second admin note' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/accounts/${target.account.id}`, headers: { cookie: firstCookie.header, 'idempotency-key': accountKey }, payload: { displayName: 'Changed again' } })).json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });

    const resetKey = 'cross-admin-reset';
    expect((await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/reset-password`, headers: { cookie: firstCookie.header, 'idempotency-key': resetKey }, payload: { password: 'Cross-reset-password-1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/reset-password`, headers: { cookie: secondCookie.header, 'idempotency-key': resetKey }, payload: { password: 'Cross-reset-password-2' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/reset-password`, headers: { cookie: firstCookie.header, 'idempotency-key': resetKey }, payload: { password: 'Changed-reset-password' } })).json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });

    const deviceCookie = await loginCookie(target.account, 'Cross-reset-password-2');
    const session = await db.accountSession.findFirstOrThrow({ where: { accountId: target.account.id, revokedAt: null } });
    const deviceKey = 'cross-admin-device';
    expect((await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/sessions/${session.id}/revoke`, headers: { cookie: firstCookie.header, 'idempotency-key': deviceKey }, payload: { reason: 'first reason' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/sessions/${session.id}/revoke`, headers: { cookie: firstCookie.header, 'idempotency-key': deviceKey }, payload: { reason: 'changed reason' } })).json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/sessions/${session.id}/revoke`, headers: { cookie: secondCookie.header, 'idempotency-key': deviceKey }, payload: { reason: 'second actor reason' } })).json()).toEqual({ error: 'SESSION_ALREADY_REVOKED' });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: deviceCookie.header } })).statusCode).toBe(401);

    const statusKey = 'cross-admin-status';
    expect((await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/disable`, headers: { cookie: firstCookie.header, 'idempotency-key': statusKey } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/disable`, headers: { cookie: secondCookie.header, 'idempotency-key': statusKey } })).json()).toEqual({ error: 'ACCOUNT_ALREADY_DISABLED' });

    const room = await createRoom(creator.account.id);
    const configKey = 'cross-admin-config';
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${room.id}`, headers: { cookie: firstCookie.header, 'idempotency-key': configKey }, payload: { name: 'First room name' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${room.id}`, headers: { cookie: secondCookie.header, 'idempotency-key': configKey }, payload: { visibility: 'PUBLIC' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${room.id}`, headers: { cookie: firstCookie.header, 'idempotency-key': configKey }, payload: { name: 'Changed room name' } })).json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
    const passwordKey = 'cross-admin-room-password';
    expect((await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/password`, headers: { cookie: firstCookie.header, 'idempotency-key': passwordKey }, payload: { password: 'first-room-password' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/password`, headers: { cookie: secondCookie.header, 'idempotency-key': passwordKey }, payload: { password: 'second-room-password' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/password`, headers: { cookie: firstCookie.header, 'idempotency-key': passwordKey }, payload: { password: null } })).json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });

    const removableAccount = await createAccount();
    const removable = await db.roomMembership.create({ data: { roomId: room.id, accountId: removableAccount.account.id, displayNameSnapshot: removableAccount.account.displayName } });
    const removeKey = 'cross-admin-remove';
    expect((await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${removable.id}/remove`, headers: { cookie: firstCookie.header, 'idempotency-key': removeKey }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${removable.id}/remove`, headers: { cookie: secondCookie.header, 'idempotency-key': removeKey }, payload: {} })).json()).toEqual({ error: 'MEMBERSHIP_NOT_ACTIVE' });

    const bankAAccount = await createAccount();
    const bankBAccount = await createAccount();
    const bankA = await db.roomMembership.create({ data: { roomId: room.id, accountId: bankAAccount.account.id, displayNameSnapshot: bankAAccount.account.displayName } });
    const bankB = await db.roomMembership.create({ data: { roomId: room.id, accountId: bankBAccount.account.id, displayNameSnapshot: bankBAccount.account.displayName } });
    const bankKey = 'cross-admin-bank';
    expect((await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: firstCookie.header, 'idempotency-key': bankKey }, payload: { targetMembershipId: bankA.id } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: secondCookie.header, 'idempotency-key': bankKey }, payload: { targetMembershipId: bankB.id } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: firstCookie.header, 'idempotency-key': bankKey }, payload: { targetMembershipId: bankB.id } })).json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
    for (const key of [accountKey, resetKey, configKey, passwordKey, bankKey]) expect(await db.idempotencyRecord.count({ where: { key } }), key).toBe(2);
  });

  it('paginates accounts and independently updates permissions with idempotent writes', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const first = await app.inject({ method: 'PATCH', url: `/api/admin/accounts/${target.account.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'update-note' }, payload: { note: 'reviewed' } });
    const second = await app.inject({ method: 'PATCH', url: `/api/admin/accounts/${target.account.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'update-create-room' }, payload: { canCreateRoom: true } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ isSuperAdmin: false, canCreateRoom: true });

    const list = await app.inject({ method: 'GET', url: '/api/admin/accounts?status=ACTIVE&permission=canCreateRoom&limit=2&query=Task', headers: { cookie: cookie.header } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ items: expect.any(Array) });
    expect(list.json().items.length).toBeLessThanOrEqual(2);
    expectNoSecrets(list.json());
  });

  it('resets and disables accounts atomically, revokes devices, and never revives old Sessions', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const adminCookie = await loginCookie(admin.account, admin.password);
    const firstTargetCookie = await loginCookie(target.account, target.password, '10.24.18.99');
    await loginCookie(target.account, target.password, '172.20.8.44');

    const devices = await app.inject({ method: 'GET', url: `/api/admin/accounts/${target.account.id}/sessions?state=active&limit=10`, headers: { cookie: adminCookie.header } });
    expect(devices.statusCode).toBe(200);
    expect(devices.json().items).toHaveLength(2);
    expectNoSecrets(devices.json());

    const reset = await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/reset-password`, headers: { cookie: adminCookie.header, 'idempotency-key': 'reset-key' }, payload: { password: 'Reset-password-1' } });
    expect(reset.statusCode).toBe(200);
    expect(await db.accountSession.count({ where: { accountId: target.account.id, revokedAt: null } })).toBe(0);
    const invalidated = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: firstTargetCookie.header } });
    expect(invalidated.statusCode).toBe(401);

    const fresh = await loginCookie(target.account, 'Reset-password-1');
    const disabled = await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/disable`, headers: { cookie: adminCookie.header, 'idempotency-key': 'disable-key' } });
    expect(disabled.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: fresh.header } })).statusCode).toBe(401);
    const enabled = await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/enable`, headers: { cookie: adminCookie.header, 'idempotency-key': 'enable-key' } });
    expect(enabled.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: fresh.header } })).statusCode).toBe(401);
  });

  it('resets only a configured active super-admin offline, revokes active Sessions, and writes a secret-free operations log', async () => {
    const target = await createAccount({ superAdmin: true });
    const ordinary = await createAccount();
    const first = await loginCookie(target.account, target.password, '10.24.18.99');
    const active = await db.accountSession.findFirstOrThrow({ where: { accountId: target.account.id, sessionTokenHash: { not: '' } } });
    const alreadyRevoked = await db.accountSession.create({ data: {
      accountId: target.account.id, sessionTokenHash: `revoked-${randomUUID()}`, deviceId: randomUUID(), deviceName: 'Revoked', browser: 'Vitest', operatingSystem: 'Test', userAgent: 'test', loginIp: '127.0.0.1', lastIp: '127.0.0.1', expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(), revokeReason: 'TEST_REVOKED',
    } });
    const expired = await db.accountSession.create({ data: {
      accountId: target.account.id, sessionTokenHash: `expired-${randomUUID()}`, deviceId: randomUUID(), deviceName: 'Expired', browser: 'Vitest', operatingSystem: 'Test', userAgent: 'test', loginIp: '127.0.0.1', lastIp: '127.0.0.1', expiresAt: new Date(Date.now() - 1),
    } });
    const password = `Offline-reset-${randomUUID()}`;
    const service = new AccountRoomService(db, (username) => configuredSuperAdmins.has(username));

    const reset = await service.resetSuperAdminPassword(target.account.username, password);

    const updated = await db.account.findUniqueOrThrow({ where: { id: target.account.id } });
    expect(reset).toMatchObject({ username: target.account.username, revokedSessions: 1 });
    await expect(verifyPassword(password, updated.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword(target.password, updated.passwordHash)).resolves.toBe(false);
    await expect(app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.header } })).resolves.toMatchObject({ statusCode: 401 });
    expect(await db.accountSession.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({ revokeReason: 'PASSWORD_RESET', revokedAt: expect.any(Date) });
    expect(await db.accountSession.findUniqueOrThrow({ where: { id: alreadyRevoked.id } })).toMatchObject({ revokeReason: 'TEST_REVOKED', revokedAt: expect.any(Date) });
    expect(await db.accountSession.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ revokedAt: null, revokeReason: null });
    const log = await db.securityLog.findFirstOrThrow({ where: { accountId: target.account.id, action: 'PASSWORD_RESET' }, orderBy: { createdAt: 'desc' } });
    expect(log).toMatchObject({ actorAccountId: null, detailsJson: { source: 'OFFLINE_OPERATIONS_CLI', targetAccountId: target.account.id, revokedSessions: 1 } });
    expect(JSON.stringify([reset, log])).not.toContain(password);
    expect(JSON.stringify([reset, log])).not.toContain(updated.passwordHash);
    await expect(service.resetSuperAdminPassword(ordinary.account.username, password)).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' });
    await expect(service.resetSuperAdminPassword(`missing-${randomUUID()}`, password)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('rejects disabled super-admin offline resets and rolls every write back when its SecurityLog insert fails', async () => {
    const disabled = await createAccount({ superAdmin: true, status: 'DISABLED' });
    const target = await createAccount({ superAdmin: true });
    const originalHash = target.account.passwordHash;
    const service = new AccountRoomService(db, (username) => configuredSuperAdmins.has(username));
    await expect(service.resetSuperAdminPassword(disabled.account.username, 'Offline-reset-disabled-1')).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    executeSql(isolatedUrl, `
      CREATE OR REPLACE FUNCTION "task_offline_reset_reject_log"() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW."action" = 'PASSWORD_RESET' AND NEW."actorAccountId" IS NULL THEN RAISE EXCEPTION 'forced offline reset log failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "task_offline_reset_reject_log" BEFORE INSERT ON "SecurityLog" FOR EACH ROW EXECUTE FUNCTION "task_offline_reset_reject_log"();
    `);
    try {
      await expect(service.resetSuperAdminPassword(target.account.username, 'Offline-reset-rollback-1')).rejects.toThrow();
      expect((await db.account.findUniqueOrThrow({ where: { id: target.account.id } })).passwordHash).toBe(originalHash);
      expect(await db.accountSession.count({ where: { accountId: target.account.id, revokedAt: { not: null } } })).toBe(0);
      expect(await db.securityLog.count({ where: { accountId: target.account.id, action: 'PASSWORD_RESET' } })).toBe(0);
    } finally {
      executeSql(isolatedUrl, 'DROP TRIGGER IF EXISTS "task_offline_reset_reject_log" ON "SecurityLog"; DROP FUNCTION IF EXISTS "task_offline_reset_reject_log"();');
    }
  });

  it('never disables an account configured as a super-admin', async () => {
    const actor = await createAccount({ superAdmin: true });
    const target = await createAccount({ superAdmin: true });
    const actorCookie = await loginCookie(actor.account, actor.password);
    const response = await app.inject({ method: 'POST', url: `/api/admin/accounts/${target.account.id}/disable`, headers: { cookie: actorCookie.header, 'idempotency-key': `protect-super-admin-${randomUUID()}` } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'SUPER_ADMIN_CANNOT_BE_DISABLED' });
    expect((await db.account.findUniqueOrThrow({ where: { id: target.account.id } })).status).toBe('ACTIVE');
  });

  it('force revokes only one target device and emits one post-commit notification', async () => {
    const notifyingApp = await buildApiApp({ database: db, logger: false, accounts: new AccountRoomService(db, (username) => configuredSuperAdmins.has(username)) });
    let targetSocket: ClientSocket | undefined;
    try {
      const admin = await createAccount({ superAdmin: true });
      const target = await createAccount();
      const adminCookie = await loginCookie(admin.account, admin.password);
      const first = await loginCookie(target.account, target.password, '10.1.2.3');
      const second = await loginCookie(target.account, target.password, '10.1.2.4');
      const targetSession = await db.accountSession.findFirstOrThrow({ where: { accountId: target.account.id, sessionTokenHash: { not: '' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const address = await notifyingApp.listen({ host: '127.0.0.1', port: 0 });
      targetSocket = createSocketClient(address, {
        extraHeaders: { Cookie: first.header },
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
      });
      if (!targetSocket.connected) await socketEvent(targetSocket, 'connect');
      const revoked = socketEvent<{ reason: string }>(targetSocket, 'account.session.revoked');
      const disconnected = socketEvent(targetSocket, 'disconnect');
      const response = await notifyingApp.inject({
        method: 'POST',
        url: `/api/admin/accounts/${target.account.id}/sessions/${targetSession.id}/revoke`,
        headers: { cookie: adminCookie.header, 'idempotency-key': 'force-device-revoke' },
        payload: { reason: 'device review' },
      });
      const replay = await notifyingApp.inject({
        method: 'POST',
        url: `/api/admin/accounts/${target.account.id}/sessions/${targetSession.id}/revoke`,
        headers: { cookie: adminCookie.header, 'idempotency-key': 'force-device-revoke' },
        payload: { reason: 'device review' },
      });
      expect(response.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(await db.accountSession.count({ where: { accountId: target.account.id, revokedAt: null } })).toBe(1);
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.header } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.header } })).statusCode).toBe(200);
      await expect(revoked).resolves.toEqual({ reason: 'device review' });
      await disconnected;
      expect(await db.securityLog.count({ where: { accountId: target.account.id, actorAccountId: admin.account.id, action: 'ACCOUNT_SESSION_REVOKED' } })).toBe(1);
    } finally {
      targetSocket?.disconnect();
      await notifyingApp.close();
    }
  });

  it('lists private unjoined rooms safely and enforces configuration/password lifecycle writes', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const lobby = await createRoom(creator.account.id);
    const playing = await createRoom(creator.account.id, 'PLAYING');

    const list = await app.inject({ method: 'GET', url: '/api/admin/rooms?status=LOBBY&limit=10', headers: { cookie: cookie.header } });
    const detail = await app.inject({ method: 'GET', url: `/api/admin/rooms/${lobby.id}`, headers: { cookie: cookie.header } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((room: { id: string }) => room.id === lobby.id)).toBe(true);
    expect(list.json().items.find((room: { id: string }) => room.id === lobby.id)).toMatchObject({
      createdAt: expect.any(String),
      startedAt: null,
      settlement: null,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().configuration).toMatchObject({ redemptionFee: 200 });
    expectNoSecrets(detail.json());

    const updated = await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${lobby.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'room-config' }, payload: { name: 'Renamed lobby', initialBalance: 7_000 } });
    expect(updated.statusCode).toBe(200);
    const feeUpdated = await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${lobby.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'room-redemption-fee' }, payload: { redemptionFee: 0 } });
    expect(feeUpdated.statusCode).toBe(200);
    expect((await db.room.findUniqueOrThrow({ where: { id: lobby.id } })).redemptionFee).toBe(0);
    const password = await app.inject({ method: 'POST', url: `/api/admin/rooms/${lobby.id}/password`, headers: { cookie: cookie.header, 'idempotency-key': 'room-password' }, payload: { password: 'room-secret' } });
    expect(password.statusCode).toBe(200);
    expectNoSecrets(password.json());
    const runtime = await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${playing.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'playing-runtime' }, payload: { name: 'Running room', visibility: 'PRIVATE', allowMidgameJoin: true, transferApprovalRequired: true } });
    expect(runtime.statusCode).toBe(200);
    for (const [field, value] of [['diceMode', 'PHYSICAL'], ['initialBalance', 7_000], ['startReward', 2_000], ['redemptionFee', 300], ['skillEnabled', false]] as const) {
      const forbidden = await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${playing.id}`, headers: { cookie: cookie.header, 'idempotency-key': `playing-${field}` }, payload: { [field]: value } });
      expect(forbidden.statusCode).toBe(409);
      expect(forbidden.json()).toEqual({ error: 'ROOM_CONFIG_LIFECYCLE_CONFLICT' });
    }
  });

  it('replays room config and password writes, rejects changed payloads, and stores no password plaintext', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id);
    const configRequest = { method: 'PATCH' as const, url: `/api/admin/rooms/${room.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'room-config-replay' }, payload: { name: 'One room name' } };
    const config = await app.inject(configRequest);
    const configReplay = await app.inject(configRequest);
    const configChanged = await app.inject({ ...configRequest, payload: { name: 'Changed room name' } });
    expect(configReplay.json()).toEqual(config.json());
    expect(configChanged.json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await db.auditLog.count({ where: { roomId: room.id, action: 'ADMIN_ROOM_UPDATED' } })).toBe(1);

    const plaintext = `Room-${randomUUID()}`;
    const passwordRequest = { method: 'POST' as const, url: `/api/admin/rooms/${room.id}/password`, headers: { cookie: cookie.header, 'idempotency-key': 'room-password-replay' }, payload: { password: plaintext } };
    const password = await app.inject(passwordRequest);
    const passwordReplay = await app.inject(passwordRequest);
    const passwordChanged = await app.inject({ ...passwordRequest, payload: { password: `${plaintext}-changed` } });
    expect(passwordReplay.json()).toEqual(password.json());
    expect(passwordChanged.json()).toEqual({ error: 'IDEMPOTENCY_KEY_REUSED' });
    const records = await db.idempotencyRecord.findMany({ where: { key: { in: ['room-config-replay', 'room-password-replay'] } } });
    const logs = await db.securityLog.findMany({ where: { actorAccountId: admin.account.id, action: { in: ['ADMIN_ROOM_UPDATED', 'ADMIN_ROOM_PASSWORD_UPDATED'] } } });
    expect(JSON.stringify([password.json(), passwordReplay.json(), records, logs])).not.toContain(plaintext);
  });

  it('reassigns bank and removes a LOBBY member without duplicating or deleting retained assets', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const first = await createAccount();
    const second = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id);
    const initialProperty = await db.propertyDefinition.create({ data: { name: `Property ${randomUUID()}`, displayOrder: Math.floor(Math.random() * 1_000_000), mortgagePrice: 100, purchasePrice: 200, buildCost: 50, buildingSellPrice: 25, tollEmpty: 10, tollLevel1: 20, tollLevel2: 30, tollLevel3: 40, tollLevel4: 50, tollPalace: 60 } });
    const character = await db.character.create({ data: { id: `character-${randomUUID()}`, name: `Character ${randomUUID()}`, skillCode: `skill-${randomUUID()}`, skillConfig: {}, initialPropertyId: initialProperty.id } });
    const firstMember = await db.roomMembership.create({ data: { roomId: room.id, accountId: first.account.id, displayNameSnapshot: first.account.displayName, characterId: character.id, isBank: true } });
    const secondMember = await db.roomMembership.create({ data: { roomId: room.id, accountId: second.account.id, displayNameSnapshot: second.account.displayName } });
    const player = await db.player.create({ data: { roomId: room.id, memberId: firstMember.id, characterId: character.id, pawnColor: 'red', balance: 6_000, turnOrder: 1 } });
    await db.roomProperty.create({ data: { roomId: room.id, propertyDefinitionId: initialProperty.id, ownerPlayerId: player.id } });

    const reassigned = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: cookie.header, 'idempotency-key': 'bank-reassign' }, payload: { targetMembershipId: secondMember.id } });
    expect(reassigned.statusCode).toBe(200);
    expect(await db.roomMembership.count({ where: { roomId: room.id, status: 'ACTIVE', isBank: true } })).toBe(1);
    expect((await db.roomMembership.findUniqueOrThrow({ where: { id: firstMember.id } })).characterId).toBe(character.id);
    expect(await db.player.count({ where: { memberId: firstMember.id } })).toBe(1);

    const removed = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${firstMember.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'member-remove' }, payload: {} });
    const removedReplay = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${firstMember.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'member-remove' }, payload: {} });
    expect(removed.statusCode).toBe(200);
    expect(removedReplay.json()).toEqual(removed.json());
    expect(await db.player.count({ where: { id: player.id } })).toBe(1);
    expect(await db.roomProperty.count({ where: { roomId: room.id, ownerPlayerId: null } })).toBe(1);
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: firstMember.id } })).toMatchObject({ status: 'LEFT', characterId: null, isBank: false, activeSessionId: null });
  });

  it('restores an admin-removed membership when the account joins again', async () => {
    const account = await createAccount();
    const creator = await createAccount();
    const cookie = await loginCookie(account.account, account.password);
    const room = await createRoom(creator.account.id);
    const removed = await db.roomMembership.create({ data: { roomId: room.id, accountId: account.account.id, displayNameSnapshot: account.account.displayName, status: 'LEFT', leftAt: new Date() } });

    const joined = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: cookie.header, 'idempotency-key': 'removed-member-rejoin' }, payload: {} });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ id: removed.id, status: 'ACTIVE', characterId: null, isBank: false });
    expect(await db.roomMembership.count({ where: { roomId: room.id, accountId: account.account.id } })).toBe(1);
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: removed.id } })).toMatchObject({
      status: 'ACTIVE',
      characterId: null,
      isBank: false,
      leftAt: null,
    });
  });

  it('keeps midgame admission disabled for an admin-removed membership', async () => {
    const account = await createAccount();
    const creator = await createAccount();
    const cookie = await loginCookie(account.account, account.password);
    const room = await createRoom(creator.account.id, 'PLAYING');
    await db.roomMembership.create({ data: {
      roomId: room.id,
      accountId: account.account.id,
      displayNameSnapshot: account.account.displayName,
      status: 'LEFT',
      leftAt: new Date(),
    } });

    const joined = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: { cookie: cookie.header, 'idempotency-key': 'removed-member-midgame-rejoin' }, payload: {} });

    expect(joined.statusCode).toBe(409);
    expect(joined.json()).toEqual({ error: 'MIDGAME_JOIN_DISABLED' });
    expect(await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: account.account.id } } })).toMatchObject({ status: 'LEFT' });
  });

  it('rejects removal of a current-turn player and terminalizes pending swaps on allowed removal', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const first = await createAccount();
    const second = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id);
    const definition = await db.propertyDefinition.create({ data: { name: `Removal Property ${randomUUID()}`, displayOrder: Math.floor(Math.random() * 1_000_000), mortgagePrice: 100, purchasePrice: 200, buildCost: 50, buildingSellPrice: 25, tollEmpty: 10, tollLevel1: 20, tollLevel2: 30, tollLevel3: 40, tollLevel4: 50, tollPalace: 60 } });
    const character = await db.character.create({ data: { id: `removal-${randomUUID()}`, name: `Removal Character ${randomUUID()}`, skillCode: `removal-skill-${randomUUID()}`, skillConfig: {}, initialPropertyId: definition.id } });
    const member = await db.roomMembership.create({ data: { roomId: room.id, accountId: first.account.id, displayNameSnapshot: first.account.displayName, characterId: character.id } });
    const target = await db.roomMembership.create({ data: { roomId: room.id, accountId: second.account.id, displayNameSnapshot: second.account.displayName } });
    const player = await db.player.create({ data: { roomId: room.id, memberId: member.id, characterId: character.id, pawnColor: 'turn-red', balance: 6_000, turnOrder: 1 } });
    const turn = await db.turn.create({ data: { roomId: room.id, turnNumber: 1, playerId: player.id } });
    await db.room.update({ where: { id: room.id }, data: { currentTurnPlayerId: player.id, turnNumber: 1 } });
    const blocked = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'current-turn-remove' }, payload: {} });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: 'MEMBER_HAS_ACTIVE_TURN' });
    expect((await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).status).toBe('ACTIVE');

    await db.turn.update({ where: { id: turn.id }, data: { status: 'ENDED', endedAt: new Date() } });
    await db.room.update({ where: { id: room.id }, data: { currentTurnPlayerId: null, turnNumber: null } });
    const swap = await db.roleSwapRequest.create({ data: { roomId: room.id, requesterMembershipId: member.id, targetMembershipId: target.id, targetCharacterId: character.id } });
    const removed = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'pending-swap-remove' }, payload: {} });
    expect(removed.statusCode).toBe(200);
    expect(await db.roleSwapRequest.findUniqueOrThrow({ where: { id: swap.id } })).toMatchObject({ status: 'CANCELLED', rejectionReason: 'ADMIN_MEMBER_REMOVED' });
  });

  it('enforces PLAYING solvent/assets/debt/sole-bank blockers', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const memberAccount = await createAccount();
    const bankAccount = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id, 'PLAYING');
    const definition = await db.propertyDefinition.create({ data: { name: `Playing Removal ${randomUUID()}`, displayOrder: Math.floor(Math.random() * 1_000_000), mortgagePrice: 100, purchasePrice: 200, buildCost: 50, buildingSellPrice: 25, tollEmpty: 10, tollLevel1: 20, tollLevel2: 30, tollLevel3: 40, tollLevel4: 50, tollPalace: 60 } });
    const character = await db.character.create({ data: { id: `playing-removal-${randomUUID()}`, name: `Playing Removal ${randomUUID()}`, skillCode: `playing-removal-${randomUUID()}`, skillConfig: {}, initialPropertyId: definition.id } });
    const member = await db.roomMembership.create({ data: { roomId: room.id, accountId: memberAccount.account.id, displayNameSnapshot: memberAccount.account.displayName, characterId: character.id } });
    const bank = await db.roomMembership.create({ data: { roomId: room.id, accountId: bankAccount.account.id, displayNameSnapshot: bankAccount.account.displayName, isBank: true } });
    const player = await db.player.create({ data: { roomId: room.id, memberId: member.id, characterId: character.id, pawnColor: 'playing-red', balance: 5_000, turnOrder: 1 } });
    const active = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'playing-active-remove' }, payload: {} });
    expect(active.json()).toEqual({ error: 'MEMBER_ACTIVE_IN_PLAY' });

    await db.player.update({ where: { id: player.id }, data: { status: 'BANKRUPT', characterId: null } });
    await db.roomMembership.update({ where: { id: member.id }, data: { characterId: null } });
    const property = await db.roomProperty.create({ data: { roomId: room.id, propertyDefinitionId: definition.id, ownerPlayerId: player.id } });
    const assets = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'playing-assets-remove' }, payload: {} });
    expect(assets.json()).toEqual({ error: 'MEMBER_HAS_ASSETS' });
    await db.roomProperty.update({ where: { id: property.id }, data: { ownerPlayerId: null } });
    const debt = await db.debtRecord.create({ data: { roomId: room.id, debtorPlayerId: player.id, creditorType: 'TREASURY', originalAmount: 100, outstandingAmount: 100 } });
    const debtBlocked = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'playing-debt-remove' }, payload: {} });
    expect(debtBlocked.json()).toEqual({ error: 'MEMBER_HAS_OPEN_DEBT' });
    await db.debtRecord.update({ where: { id: debt.id }, data: { status: 'SETTLED', paidAmount: 100, outstandingAmount: 0, settledAt: new Date() } });
    const soleBank = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${bank.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'playing-bank-remove' }, payload: {} });
    expect(soleBank.json()).toEqual({ error: 'BANK_REPLACEMENT_REQUIRED' });
  });

  it.each(['LOBBY', 'PLAYING'] as const)('rejects %s removal with a pending game request without mutating membership, request, lock, or logs', async (status) => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const memberAccount = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    await loginCookie(memberAccount.account, memberAccount.password);
    const room = await createRoom(creator.account.id, status);
    const controller = await db.accountSession.findFirstOrThrow({ where: { accountId: memberAccount.account.id, revokedAt: null } });
    const member = await db.roomMembership.create({ data: {
      roomId: room.id,
      accountId: memberAccount.account.id,
      displayNameSnapshot: memberAccount.account.displayName,
      activeSessionId: controller.id,
      controlClaimedAt: new Date(),
    } });
    const player = await db.player.create({ data: {
      roomId: room.id,
      memberId: member.id,
      characterId: null,
      pawnColor: `pending-${status.toLowerCase()}`,
      balance: 0,
      status: status === 'PLAYING' ? 'BANKRUPT' : 'ACTIVE',
      turnOrder: 1,
    } });
    const definition = await db.propertyDefinition.create({ data: {
      name: `Pending removal ${status} ${randomUUID()}`,
      displayOrder: Math.floor(Math.random() * 1_000_000),
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
    const property = await db.roomProperty.create({ data: { roomId: room.id, propertyDefinitionId: definition.id } });
    const request = await db.gameRequest.create({ data: {
      roomId: room.id,
      type: 'BUY_PROPERTY',
      actorPlayerId: player.id,
      propertyId: property.id,
      idempotencyKey: randomUUID(),
    } });
    await db.roomProperty.update({ where: { id: property.id }, data: { lockedByRequestId: request.id } });

    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`,
      headers: { cookie: cookie.header, 'idempotency-key': `pending-request-remove-${status}` },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'MEMBER_HAS_PENDING_REQUEST' });
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({
      status: 'ACTIVE',
      activeSessionId: controller.id,
      controlClaimedAt: expect.any(Date),
      leftAt: null,
    });
    expect(await db.player.findUniqueOrThrow({ where: { id: player.id } })).toMatchObject({
      status: status === 'PLAYING' ? 'BANKRUPT' : 'ACTIVE',
      characterId: null,
    });
    expect(await db.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
      status: 'PENDING',
      rejectionReason: null,
      resolvedAt: null,
    });
    expect(await db.roomProperty.findUniqueOrThrow({ where: { id: property.id } })).toMatchObject({
      ownerPlayerId: null,
      lockedByRequestId: request.id,
      version: 0,
    });
    expect(await db.idempotencyRecord.count({ where: { key: `pending-request-remove-${status}` } })).toBe(0);
    expect(await db.auditLog.count({ where: { roomId: room.id, action: 'ADMIN_MEMBER_REMOVED' } })).toBe(0);
    expect(await db.securityLog.count({ where: { accountId: memberAccount.account.id, action: 'ADMIN_MEMBER_REMOVED' } })).toBe(0);
  });

  it('rejects every terminal room mutation without partial state', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const targetAccount = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id, 'FINISHED');
    const member = await db.roomMembership.create({ data: { roomId: room.id, accountId: targetAccount.account.id, displayNameSnapshot: targetAccount.account.displayName } });
    const writes = [
      app.inject({ method: 'PATCH', url: `/api/admin/rooms/${room.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'terminal-config' }, payload: { name: 'No change' } }),
      app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/password`, headers: { cookie: cookie.header, 'idempotency-key': 'terminal-password' }, payload: { password: null } }),
      app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/members/${member.id}/remove`, headers: { cookie: cookie.header, 'idempotency-key': 'terminal-remove' }, payload: {} }),
      app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: cookie.header, 'idempotency-key': 'terminal-bank' }, payload: { targetMembershipId: member.id } }),
    ];
    const responses = await Promise.all(writes);
    expect(responses.map((response) => response.statusCode)).toEqual([409, 409, 409, 409]);
    expect(responses.map((response) => response.json())).toEqual(Array(4).fill({ error: 'ROOM_TERMINAL' }));
    expect((await db.room.findUniqueOrThrow({ where: { id: room.id } })).name).toBe(room.name);
    expect(await db.idempotencyRecord.count({ where: { key: { startsWith: 'terminal-' } } })).toBe(0);
  });

  it('rolls a room mutation, AuditLog, and idempotency record back when SecurityLog insertion fails', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id);
    executeSql(isolatedUrl, `
      CREATE OR REPLACE FUNCTION "task6_reject_room_update_log"() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW."action" = 'ADMIN_ROOM_UPDATED' THEN RAISE EXCEPTION 'task6 forced room log failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER "task6_reject_room_update_log" BEFORE INSERT ON "SecurityLog"
      FOR EACH ROW EXECUTE FUNCTION "task6_reject_room_update_log"();
    `);
    try {
      const response = await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${room.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'atomic-room-update' }, payload: { name: 'Must roll back room' } });
      expect(response.statusCode).toBe(500);
      expect((await db.room.findUniqueOrThrow({ where: { id: room.id } })).name).toBe(room.name);
      expect(await db.auditLog.count({ where: { roomId: room.id, action: 'ADMIN_ROOM_UPDATED' } })).toBe(0);
      expect(await db.idempotencyRecord.count({ where: { key: 'atomic-room-update' } })).toBe(0);
    } finally {
      executeSql(isolatedUrl, 'DROP TRIGGER IF EXISTS "task6_reject_room_update_log" ON "SecurityLog"; DROP FUNCTION IF EXISTS "task6_reject_room_update_log"();');
    }
  });

  it('handles vacant, same-target, corrupt, and concurrent bank reassignment states', async () => {
    const firstAdmin = await createAccount({ superAdmin: true });
    const secondAdmin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const a = await createAccount();
    const b = await createAccount();
    const firstCookie = await loginCookie(firstAdmin.account, firstAdmin.password);
    const secondCookie = await loginCookie(secondAdmin.account, secondAdmin.password);
    const room = await createRoom(creator.account.id);
    const memberA = await db.roomMembership.create({ data: { roomId: room.id, accountId: a.account.id, displayNameSnapshot: a.account.displayName } });
    const memberB = await db.roomMembership.create({ data: { roomId: room.id, accountId: b.account.id, displayNameSnapshot: b.account.displayName } });
    const vacant = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: firstCookie.header, 'idempotency-key': 'vacant-bank' }, payload: { targetMembershipId: memberA.id } });
    expect(vacant.statusCode).toBe(200);
    const auditCount = await db.auditLog.count({ where: { roomId: room.id, action: 'ADMIN_BANK_REASSIGNED' } });
    const same = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: firstCookie.header, 'idempotency-key': 'same-bank' }, payload: { targetMembershipId: memberA.id } });
    expect(same.statusCode).toBe(200);
    expect(await db.auditLog.count({ where: { roomId: room.id, action: 'ADMIN_BANK_REASSIGNED' } })).toBe(auditCount);

    const currentBankAccount = await createAccount();
    await db.roomMembership.update({ where: { id: memberA.id }, data: { isBank: false } });
    await db.roomMembership.create({ data: { roomId: room.id, accountId: currentBankAccount.account.id, displayNameSnapshot: currentBankAccount.account.displayName, isBank: true } });

    const concurrent = await Promise.all([
      app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: firstCookie.header, 'idempotency-key': 'concurrent-bank-a' }, payload: { targetMembershipId: memberA.id } }),
      app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: secondCookie.header, 'idempotency-key': 'concurrent-bank-b' }, payload: { targetMembershipId: memberB.id } }),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await db.roomMembership.count({ where: { roomId: room.id, status: 'ACTIVE', isBank: true } })).toBe(1);

    await db.$executeRawUnsafe('DROP INDEX "RoomMember_one_active_bank_per_room";');
    try {
      await db.roomMembership.updateMany({ where: { id: { in: [memberA.id, memberB.id] } }, data: { isBank: true } });
      const corrupt = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: firstCookie.header, 'idempotency-key': 'corrupt-bank' }, payload: { targetMembershipId: memberA.id } });
      expect(corrupt.statusCode).toBe(409);
      expect(corrupt.json()).toEqual({ error: 'BANK_STATE_INVALID' });
    } finally {
      await db.$executeRawUnsafe('UPDATE "RoomMember" SET "isBank" = false WHERE "roomId" = $1 AND "id" <> $2', room.id, memberA.id);
      await db.$executeRawUnsafe('CREATE UNIQUE INDEX "RoomMember_one_active_bank_per_room" ON "RoomMember"("roomId") WHERE "isBank" = true AND "status" = \'ACTIVE\';');
    }
  });

  it('recovers one exact concurrent same-key bank reassignment winner', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const targetAccount = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id);
    const target = await db.roomMembership.create({ data: { roomId: room.id, accountId: targetAccount.account.id, displayNameSnapshot: targetAccount.account.displayName } });
    const request = { method: 'POST' as const, url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: cookie.header, 'idempotency-key': 'same-bank-concurrency' }, payload: { targetMembershipId: target.id } };
    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect(await db.auditLog.count({ where: { roomId: room.id, action: 'ADMIN_BANK_REASSIGNED' } })).toBe(1);
    expect(await db.idempotencyRecord.count({ where: { key: 'same-bank-concurrency' } })).toBe(1);
  });

  it('changes only isBank while preserving both character, Player, asset, and controller identities', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const first = await createAccount();
    const second = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const firstCookie = await loginCookie(first.account, first.password, '10.10.1.1');
    const secondCookie = await loginCookie(second.account, second.password, '10.10.1.2');
    const firstSession = await db.accountSession.findFirstOrThrow({ where: { accountId: first.account.id, revokedAt: null } });
    const secondSession = await db.accountSession.findFirstOrThrow({ where: { accountId: second.account.id, revokedAt: null } });
    expect(firstCookie.header).toBeTruthy();
    expect(secondCookie.header).toBeTruthy();
    const room = await createRoom(creator.account.id);
    const definitions = await Promise.all([0, 1].map((index) => db.propertyDefinition.create({ data: { name: `Bank Preserve ${index} ${randomUUID()}`, displayOrder: Math.floor(Math.random() * 1_000_000), mortgagePrice: 100, purchasePrice: 200, buildCost: 50, buildingSellPrice: 25, tollEmpty: 10, tollLevel1: 20, tollLevel2: 30, tollLevel3: 40, tollLevel4: 50, tollPalace: 60 } })));
    const characters = await Promise.all(definitions.map((definition, index) => db.character.create({ data: { id: `bank-preserve-${randomUUID()}`, name: `Bank Preserve Character ${index} ${randomUUID()}`, skillCode: `bank-preserve-skill-${randomUUID()}`, skillConfig: {}, initialPropertyId: definition.id } })));
    const firstMember = await db.roomMembership.create({ data: { roomId: room.id, accountId: first.account.id, displayNameSnapshot: first.account.displayName, characterId: characters[0]!.id, isBank: true, activeSessionId: firstSession.id, controlClaimedAt: new Date() } });
    const secondMember = await db.roomMembership.create({ data: { roomId: room.id, accountId: second.account.id, displayNameSnapshot: second.account.displayName, characterId: characters[1]!.id, activeSessionId: secondSession.id, controlClaimedAt: new Date() } });
    const firstPlayer = await db.player.create({ data: { roomId: room.id, memberId: firstMember.id, characterId: characters[0]!.id, pawnColor: 'preserve-a', balance: 6_000, turnOrder: 1 } });
    const secondPlayer = await db.player.create({ data: { roomId: room.id, memberId: secondMember.id, characterId: characters[1]!.id, pawnColor: 'preserve-b', balance: 5_000, turnOrder: 2 } });
    await db.roomProperty.createMany({ data: [
      { roomId: room.id, propertyDefinitionId: definitions[0]!.id, ownerPlayerId: firstPlayer.id },
      { roomId: room.id, propertyDefinitionId: definitions[1]!.id, ownerPlayerId: secondPlayer.id },
    ] });
    const beforePlayers = await db.player.findMany({ where: { id: { in: [firstPlayer.id, secondPlayer.id] } }, orderBy: { id: 'asc' } });
    const beforeProperties = await db.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } });

    const response = await app.inject({ method: 'POST', url: `/api/admin/rooms/${room.id}/bank/reassign`, headers: { cookie: cookie.header, 'idempotency-key': 'preserve-bank-identities' }, payload: { targetMembershipId: secondMember.id } });
    expect(response.statusCode).toBe(200);
    expect(await db.player.findMany({ where: { id: { in: [firstPlayer.id, secondPlayer.id] } }, orderBy: { id: 'asc' } })).toEqual(beforePlayers);
    expect(await db.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } })).toEqual(beforeProperties);
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: firstMember.id } })).toMatchObject({ characterId: characters[0]!.id, isBank: false, activeSessionId: firstSession.id });
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: secondMember.id } })).toMatchObject({ characterId: characters[1]!.id, isBank: true, activeSessionId: secondSession.id });
  });

  it('returns reviewed dashboard aggregates and rejects SecurityLog mutation at PostgreSQL', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    await createRoom(creator.account.id, 'LOBBY');
    await createRoom(creator.account.id, 'PLAYING');
    const response = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: cookie.header } });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(['accounts', 'characterSelections', 'characterWins', 'games', 'recentGames', 'rooms', 'sessions']);
    expect(response.json()).toMatchObject({
      accounts: { total: expect.any(Number), active: expect.any(Number) },
      sessions: { valid: expect.any(Number) },
      rooms: { lobby: expect.any(Number), playing: expect.any(Number), finished: expect.any(Number) },
      games: { settledTotal: expect.any(Number), averageDurationSeconds: expect.any(Number) },
      characterSelections: expect.any(Array),
      characterWins: expect.any(Array),
      recentGames: expect.any(Array),
    });

    const stored = await db.securityLog.create({ data: { accountId: admin.account.id, actorAccountId: admin.account.id, action: 'TASK6_APPEND_ONLY', detailsJson: { reviewed: true } } });
    await expect(db.securityLog.update({ where: { id: stored.id }, data: { action: 'MUTATED' } })).rejects.toThrow();
    await expect(db.securityLog.delete({ where: { id: stored.id } })).rejects.toThrow();
    expect(await db.securityLog.findUniqueOrThrow({ where: { id: stored.id } })).toMatchObject({ action: 'TASK6_APPEND_ONLY' });
  });

  it('aggregates durable character selections, tied historical winners, durations, and recent games', async () => {
    const admin = await createAccount({ superAdmin: true });
    const firstWinner = await createAccount();
    const secondWinner = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const definition = await db.propertyDefinition.create({ data: { name: `Dashboard Property ${randomUUID()}`, displayOrder: Math.floor(Math.random() * 1_000_000), mortgagePrice: 100, purchasePrice: 200, buildCost: 50, buildingSellPrice: 25, tollEmpty: 10, tollLevel1: 20, tollLevel2: 30, tollLevel3: 40, tollLevel4: 50, tollPalace: 60 } });
    const character = await db.character.create({ data: { id: `dashboard-${randomUUID()}`, name: 'Current Character Name', skillCode: `dashboard-skill-${randomUUID()}`, skillConfig: {}, initialPropertyId: definition.id } });
    const firstSelectionRoom = await createRoom(firstWinner.account.id);
    const secondSelectionRoom = await createRoom(secondWinner.account.id);
    await db.securityLog.createMany({ data: [
      { accountId: firstWinner.account.id, action: 'CHARACTER_SELECTED', detailsJson: { roomId: firstSelectionRoom.id, characterId: character.id, characterNameSnapshot: 'Historic Selection Name' } },
      { accountId: secondWinner.account.id, action: 'CHARACTER_SELECTED', detailsJson: { roomId: secondSelectionRoom.id, characterId: character.id, characterNameSnapshot: 'Historic Selection Name' } },
    ] });

    const older = await createRoom(admin.account.id, 'PLAYING');
    const newer = await createRoom(admin.account.id, 'PLAYING');
    await db.room.update({ where: { id: older.id }, data: { name: 'Older finished game' } });
    await db.room.update({ where: { id: newer.id }, data: { name: 'Newer finished game' } });
    const olderEndedAt = new Date('2026-07-25T10:00:00.000Z');
    const newerEndedAt = new Date('2026-07-26T10:00:00.000Z');
    for (const [room, endedAt, duration] of [[older, olderEndedAt, 120], [newer, newerEndedAt, 240]] as const) {
      await db.gameSettlement.create({ data: {
        roomId: room.id,
        endedByAccountId: admin.account.id,
        endedAt,
        totalTurns: 2,
        durationSeconds: duration,
        forced: false,
        winnersJson: [firstWinner.account.id, secondWinner.account.id],
        rankingJson: [{ accountId: firstWinner.account.id, rank: 1 }, { accountId: secondWinner.account.id, rank: 1 }],
        players: { create: [
          { accountId: firstWinner.account.id, displayNameSnapshot: 'Winner A', characterNameSnapshot: 'Historic Winner', cash: 100, unmortgagedPropertyValue: 0, mortgagedPropertyNetValue: 0, buildingSellValue: 0, totalWealth: 100, rank: 1, isWinner: true, propertyDetailsJson: [] },
          { accountId: secondWinner.account.id, displayNameSnapshot: 'Winner B', characterNameSnapshot: 'Historic Winner', cash: 100, unmortgagedPropertyValue: 0, mortgagedPropertyNetValue: 0, buildingSellValue: 0, totalWealth: 100, rank: 1, isWinner: true, propertyDetailsJson: [] },
        ] },
      } });
      await db.room.update({ where: { id: room.id }, data: { status: 'FINISHED' } });
    }
    await db.character.update({ where: { id: character.id }, data: { name: 'Renamed Current Character' } });

    const response = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: cookie.header } });
    expect(response.statusCode).toBe(200);
    expect(response.json().games).toMatchObject({ averageDurationSeconds: expect.any(Number) });
    expect(response.json().characterSelections).toContainEqual({ characterId: character.id, characterNameSnapshot: 'Historic Selection Name', count: 2 });
    expect(response.json().characterWins).toContainEqual({ characterNameSnapshot: 'Historic Winner', count: 4 });
    expect(response.json().recentGames.slice(0, 2).map((game: { roomNameSnapshot: string }) => game.roomNameSnapshot)).toEqual(['Newer finished game', 'Older finished game']);
    expect(response.json().recentGames[0].winners).toHaveLength(2);
  });

  it('filters and paginates logs while redacting unknown JSON, raw IPs, and Session secrets', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    await db.securityLog.create({ data: { accountId: target.account.id, actorAccountId: admin.account.id, action: 'ACCOUNT_UPDATED', ip: '120.31.22.36', detailsJson: { changedFields: ['displayName'], sessionId: 'must-not-leak', password: 'must-not-leak' } } });
    await db.securityLog.create({ data: { accountId: target.account.id, actorAccountId: admin.account.id, action: 'UNKNOWN_SECRET_ACTION', ip: '120.31.22.36', detailsJson: { token: 'must-not-leak', nested: { passwordHash: 'must-not-leak' } } } });
    const response = await app.inject({ method: 'GET', url: `/api/admin/security-logs?actorAccountId=${admin.account.id}&accountId=${target.account.id}&limit=1`, headers: { cookie: cookie.header } });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().nextCursor).toEqual(expect.any(String));
    expectNoSecrets(response.json());
    expect(JSON.stringify(response.json())).not.toContain('must-not-leak');
  });

  it('traverses deterministic SecurityLog date/cursor pages without gaps or duplicates', async () => {
    const admin = await createAccount({ superAdmin: true });
    const target = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const times = ['2026-07-20T10:00:00.000Z', '2026-07-21T10:00:00.000Z', '2026-07-22T10:00:00.000Z'];
    const rows = [];
    for (const createdAt of times) rows.push(await db.securityLog.create({ data: { accountId: target.account.id, actorAccountId: admin.account.id, action: 'ACCOUNT_UPDATED', detailsJson: { changedFields: ['displayName'] }, createdAt: new Date(createdAt) } }));
    const base = `/api/admin/security-logs?action=ACCOUNT_UPDATED&actorAccountId=${admin.account.id}&accountId=${target.account.id}&from=2026-07-20T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&limit=1`;
    const first = await app.inject({ method: 'GET', url: base, headers: { cookie: cookie.header } });
    const second = await app.inject({ method: 'GET', url: `${base}&cursor=${encodeURIComponent(first.json().nextCursor)}`, headers: { cookie: cookie.header } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect([first.json().items[0].id, second.json().items[0].id]).toEqual([rows[2]!.id, rows[1]!.id]);
    expect(new Set([first.json().items[0].id, second.json().items[0].id]).size).toBe(2);
  });

  it('filters and paginates room AuditLogs with reviewed details only', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const room = await createRoom(creator.account.id);
    const actor = await db.roomMembership.create({ data: { roomId: room.id, accountId: admin.account.id, displayNameSnapshot: admin.account.displayName } });
    const known = await db.auditLog.create({ data: { roomId: room.id, actorMemberId: actor.id, actorRole: 'ADMIN', action: 'ADMIN_MEMBER_REMOVED', entityType: 'RoomMembership', entityId: 'member-safe', beforeJson: { status: 'ACTIVE', activeSessionId: 'must-not-leak', passwordHash: 'must-not-leak' }, afterJson: { status: 'LEFT', isBank: false }, createdAt: new Date('2026-07-22T10:00:00.000Z') } });
    const older = await db.auditLog.create({ data: { roomId: room.id, actorMemberId: actor.id, actorRole: 'ADMIN', action: 'ADMIN_MEMBER_REMOVED', entityType: 'RoomMembership', entityId: 'member-older', beforeJson: { status: 'ACTIVE' }, afterJson: { status: 'LEFT' }, createdAt: new Date('2026-07-21T10:00:00.000Z') } });
    await db.auditLog.create({ data: { roomId: room.id, actorRole: 'ADMIN', action: 'UNKNOWN_AUDIT_ACTION', entityType: 'Secret', entityId: 'secret', afterJson: { token: 'must-not-leak' } } });
    const base = `/api/admin/rooms/${room.id}/audit-logs?action=ADMIN_MEMBER_REMOVED&actorMemberId=${actor.id}&from=2026-07-20T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&limit=1`;
    const filtered = await app.inject({ method: 'GET', url: base, headers: { cookie: cookie.header } });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0]).toMatchObject({ id: known.id, details: { before: { status: 'ACTIVE' }, after: { status: 'LEFT', isBank: false } } });
    expect(JSON.stringify(filtered.json())).not.toContain('must-not-leak');
    const page = await app.inject({ method: 'GET', url: `${base}&cursor=${encodeURIComponent(filtered.json().nextCursor)}`, headers: { cookie: cookie.header } });
    expect(page.json().items).toHaveLength(1);
    expect(page.json().items[0].id).toBe(older.id);
    expect(page.json().items[0].id).not.toBe(known.id);
    expect(JSON.stringify(page.json())).not.toContain('must-not-leak');
  });

  it('delegates forced finish to Task 5 and emits one create-only versioned invalidation with actor reason logging', async () => {
    const notifications: Array<{ roomId: string; event: string; payload?: Record<string, unknown> }> = [];
    const notifyingApp = await buildApiApp({ database: db, logger: false, accounts: new AccountRoomService(db, (username) => configuredSuperAdmins.has(username)), notifier: (roomId, event, payload) => notifications.push({ roomId, event, payload }) });
    try {
      const admin = await createAccount({ superAdmin: true });
      const creator = await createAccount();
      const cookie = await loginCookie(admin.account, admin.password);
      const room = await createRoom(creator.account.id);
      const request = { method: 'POST' as const, url: `/api/admin/rooms/${room.id}/finish`, headers: { cookie: cookie.header, 'idempotency-key': 'task6-forced-finish' }, payload: { reason: 'administrative closure' } };
      const created = await notifyingApp.inject(request);
      const replay = await notifyingApp.inject(request);
      expect(created.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ created: true, settlement: { forced: true, forceReason: 'administrative closure' } });
      expect(replay.json()).toMatchObject({ created: false });
      expect(await db.gameSettlement.count({ where: { roomId: room.id } })).toBe(1);
      expect(notifications.filter((item) => item.roomId === room.id)).toEqual([
        { roomId: room.id, event: 'room.updated', payload: { stateVersion: expect.any(Number) } },
      ]);
      expect(await db.securityLog.count({ where: { actorAccountId: admin.account.id, action: 'ROOM_FORCE_FINISHED', detailsJson: { path: ['forceReason'], equals: 'administrative closure' } } })).toBe(1);
    } finally {
      await notifyingApp.close();
    }
  });

  it('permanently deletes every target-room row while preserving shared and other-room data', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const fixture = await createPurgeFixture(creator.account.id, admin.account.id);
    const permanentDelete = (roomId: string, key: string) => app.inject({
      method: 'DELETE',
      url: `/api/admin/rooms/${roomId}/permanent`,
      headers: { cookie: cookie.header, 'idempotency-key': key },
    });

    const [first, second] = await Promise.all([
      permanentDelete(fixture.room.id, 'permanent-a'),
      permanentDelete(fixture.room.id, 'permanent-b'),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({ deleted: true, id: fixture.room.id });
    expect(second.json()).toEqual(first.json());
    expect(await db.settlementPlayer.count({ where: { settlementId: fixture.settlement.id } })).toBe(0);
    expect(await db.gameSettlement.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.securityLog.count({ where: { detailsJson: { path: ['roomId'], equals: fixture.room.id } } })).toBe(0);
    expect(await db.gameResult.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.roleSwapRequest.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.debtRecord.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.skipTurnEntry.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.landingEvent.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.gameRequest.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.gameTransaction.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.turn.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.roomProperty.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.player.count({ where: { roomId: fixture.room.id } })).toBe(0);
    expect(await db.roomMembership.count({ where: { roomId: fixture.room.id } })).toBe(0);
    for (const record of fixture.targetIdempotencyRecords) {
      expect(await db.idempotencyRecord.findUnique({ where: { id: record.id } }), record.scope).toBeNull();
    }
    expect(await db.room.count({ where: { id: fixture.room.id } })).toBe(0);

    expect(await db.account.findUnique({ where: { id: fixture.shared.account.id } })).not.toBeNull();
    expect(await db.propertyDefinition.findUnique({ where: { id: fixture.definition.id } })).not.toBeNull();
    expect(await db.character.findUnique({ where: { id: fixture.character.id } })).not.toBeNull();
    expect(await db.room.findUnique({ where: { id: fixture.otherRoom.id } })).not.toBeNull();
    expect(await db.roomMembership.count({ where: { roomId: fixture.otherRoom.id } })).toBe(1);
    expect(await db.player.count({ where: { roomId: fixture.otherRoom.id } })).toBe(1);
    expect(await db.roomProperty.count({ where: { roomId: fixture.otherRoom.id } })).toBe(1);
    expect(await db.securityLog.count({ where: { detailsJson: { path: ['roomId'], equals: fixture.otherRoom.id } } })).toBe(1);
    for (const record of fixture.otherIdempotencyRecords) {
      expect(await db.idempotencyRecord.findUnique({ where: { id: record.id } }), record.scope).not.toBeNull();
    }
  });

  it('rejects active rooms and converges every retry after a permanent delete', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const permanentDelete = (roomId: string, key: string) => app.inject({
      method: 'DELETE',
      url: `/api/admin/rooms/${roomId}/permanent`,
      headers: { cookie: cookie.header, 'idempotency-key': key },
    });
    const activeRoom = await createRoom(creator.account.id);
    const trashed = await createRoom(creator.account.id, 'ENDED');
    await db.room.update({ where: { id: trashed.id }, data: {
      deletedAt: new Date('2026-08-04T00:00:00.000Z'),
      purgeAfter: new Date('2026-08-05T00:00:00.000Z'),
      deletedByAccountId: admin.account.id,
    } });

    expect((await permanentDelete(activeRoom.id, 'not-trashed')).json())
      .toEqual({ error: 'ROOM_NOT_IN_TRASH' });
    expect((await permanentDelete(trashed.id, 'first-delete')).json())
      .toEqual({ deleted: true, id: trashed.id });
    expect((await permanentDelete(trashed.id, 'first-delete')).json())
      .toEqual({ deleted: true, id: trashed.id });
    expect((await permanentDelete(trashed.id, 'new-delete-key')).json())
      .toEqual({ deleted: true, id: trashed.id });
  });

  it('rolls a purge failure back atomically and logs only after a successful commit', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const fixture = await createPurgeFixture(creator.account.id, admin.account.id);
    const purgeLogs: Array<Record<string, unknown>> = [];
    const service = new AccountRoomService(
      db,
      (username) => configuredSuperAdmins.has(username),
      undefined,
      (details) => purgeLogs.push(details),
    );
    const suffix = randomUUID().replaceAll('-', '');
    const failureFunction = `purge_failure_function_${suffix}`;
    const failureTrigger = `purge_failure_trigger_${suffix}`;

    try {
      await db.$executeRawUnsafe(`
        CREATE FUNCTION "${failureFunction}"() RETURNS TRIGGER AS $$
        BEGIN RAISE EXCEPTION 'INJECTED_PURGE_FAILURE'; END;
        $$ LANGUAGE plpgsql
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER "${failureTrigger}"
        BEFORE DELETE ON "GameTransaction"
        FOR EACH ROW EXECUTE FUNCTION "${failureFunction}"()
      `);
      await expect(service.purgeRoom(fixture.room.id, { kind: 'AUTO' }))
        .rejects.toThrow('INJECTED_PURGE_FAILURE');
      expect(await db.room.findUnique({ where: { id: fixture.room.id } })).not.toBeNull();
      expect(await db.gameSettlement.findUnique({ where: { roomId: fixture.room.id } })).not.toBeNull();
      expect(await db.settlementPlayer.count({ where: { settlementId: fixture.settlement.id } })).toBe(1);
      expect(await db.ledgerEntry.count({ where: { roomId: fixture.room.id } })).toBe(1);
      expect(purgeLogs).toEqual([]);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failureTrigger}" ON "GameTransaction"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${failureFunction}"()`);
    }

    await expect(service.purgeRoom(fixture.room.id, { kind: 'AUTO' }))
      .resolves.toEqual({ deleted: true, id: fixture.room.id });
    expect(purgeLogs).toEqual([{
      roomId: fixture.room.id,
      roomName: fixture.room.name,
      source: 'AUTO',
      actorAccountId: null,
    }]);
    await expect(service.purgeRoom(fixture.room.id, { kind: 'AUTO' }))
      .resolves.toEqual({ deleted: false, id: fixture.room.id });
    expect(purgeLogs).toHaveLength(1);
  });

  it('serializes restore against permanent delete so exactly one outcome wins', async () => {
    const admin = await createAccount({ superAdmin: true });
    const creator = await createAccount();
    const cookie = await loginCookie(admin.account, admin.password);
    const service = new AccountRoomService(db, (username) => configuredSuperAdmins.has(username));
    const auth = await service.authenticate(cookie.token, '120.31.22.36');
    const trashedForRace = await createRoom(creator.account.id, 'ENDED');
    await db.room.update({ where: { id: trashedForRace.id }, data: {
      deletedAt: new Date('2026-08-04T00:00:00.000Z'),
      purgeAfter: new Date('2026-08-05T00:00:00.000Z'),
      deletedByAccountId: admin.account.id,
    } });
    const restore = (roomId: string, key: string) => service.restoreRoom(auth, roomId, key);
    const permanentDelete = (roomId: string, key: string) => service.permanentlyDeleteRoom(auth, roomId, key);

    const race = await Promise.allSettled([
      restore(trashedForRace.id, 'race-restore'),
      permanentDelete(trashedForRace.id, 'race-delete'),
    ]);

    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const roomAfterRace = await db.room.findUnique({ where: { id: trashedForRace.id } });
    if (roomAfterRace) expect(roomAfterRace.deletedAt).toBeNull();
  });

  it('rejects SecurityLog update, delete, and truncate while retaining every stored row', async () => {
    const account = await createAccount({ superAdmin: true });
    const rows = await Promise.all(['UPDATE_GUARD', 'DELETE_GUARD', 'TRUNCATE_GUARD'].map((action) => db.securityLog.create({ data: { accountId: account.account.id, action } })));
    const update = db.securityLog.update({ where: { id: rows[0]!.id }, data: { action: 'MUTATED' } });
    const remove = db.securityLog.delete({ where: { id: rows[1]!.id } });
    const truncate = db.$executeRawUnsafe('TRUNCATE TABLE "SecurityLog"');
    const outcomes = await Promise.allSettled([update, remove, truncate]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(await db.securityLog.count({ where: { id: { in: rows.map((row) => row.id) } } })).toBe(3);
  });
});
