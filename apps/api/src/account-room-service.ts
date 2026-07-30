import { createHash, randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { RuleError } from './api-error.js';
import { accountSummary, hashPassword, maskIp, passwordSchema, sessionDurationMs, sessionSummary, verifyPassword } from './auth-domain.js';
import { buildPropertySettlementDetail, isPristineSettlementTurn, rankSettlementPlayers, type RankedSettlementPlayer, type SettlementCandidate } from './settlement.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const colors = ['胭脂红', '鎏金', '青玉', '黛蓝', '月白'];
const fail = (code: string): never => { throw new RuleError(code); };
function isSerializationConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  const sqlState = typeof error.meta?.code === 'string' ? error.meta.code : null;
  return error.code === 'P2010' && (sqlState === '40001' || sqlState === '40P01');
}
const required = <T>(value: T | null | undefined, code: string): T => value ?? fail(code);
const activeSessionWhere = (now = new Date()) => ({ revokedAt: null, expiresAt: { gt: now } });

type PasswordResetSource = 'OFFLINE_OPERATIONS_CLI';

export async function resetAccountPassword(
  tx: Prisma.TransactionClient,
  input: { accountId: string; password: string; actorAccountId?: string; source?: PasswordResetSource },
) {
  const at = new Date();
  const account = await tx.account.update({ where: { id: input.accountId }, data: { passwordHash: await hashPassword(input.password) } });
  const sessions = await tx.accountSession.findMany({ where: { accountId: input.accountId, ...activeSessionWhere(at) }, select: { id: true } });
  if (sessions.length) await tx.accountSession.updateMany({ where: { id: { in: sessions.map((session) => session.id) } }, data: { revokedAt: at, revokeReason: 'PASSWORD_RESET' } });
  await tx.securityLog.create({ data: {
    accountId: input.accountId,
    ...(input.actorAccountId ? { actorAccountId: input.actorAccountId } : {}),
    action: 'PASSWORD_RESET',
    detailsJson: { ...(input.source ? { source: input.source, targetAccountId: input.accountId } : {}), revokedSessions: sessions.length },
    createdAt: at,
  } });
  return { account, revokedSessions: sessions.length, revokedSessionIds: sessions.map((session) => session.id) };
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

const asObject = (value: Prisma.JsonValue) => value as Record<string, unknown>;

type PageCursor = { createdAt: string; id: string };

function encodeCursor(value: { createdAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id } satisfies PageCursor)).toString('base64url');
}

function decodeCursor(value?: string): { createdAt: Date; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as PageCursor;
    const createdAt = new Date(parsed.createdAt);
    if (!parsed.id || Number.isNaN(createdAt.getTime())) fail('INVALID_CURSOR');
    return { createdAt, id: parsed.id };
  } catch (error) {
    if (error instanceof RuleError) throw error;
    return fail('INVALID_CURSOR');
  }
}

const pageLimit = (value?: number) => Math.min(100, Math.max(1, value ?? 50));
const cursorWhere = (cursor?: { createdAt: Date; id: string }) => cursor ? {
  OR: [
    { createdAt: { lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
  ],
} : {};

function adminAccountDto(account: {
  id: string; username: string; displayName: string; note: string | null; status: string;
  canCreateRoom: boolean; lastLoginAt: Date | null; createdAt: Date; updatedAt: Date;
}, isSuperAdmin: boolean) {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    note: account.note,
    status: account.status,
    isSuperAdmin,
    canCreateRoom: account.canCreateRoom,
    lastLoginAt: account.lastLoginAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function adminSessionDto(session: {
  id: string; deviceName: string; browser: string; operatingSystem: string; loginIp: string; lastIp: string;
  createdAt: Date; lastActiveAt: Date; expiresAt: Date; revokedAt: Date | null; revokeReason: string | null;
}, now = new Date()) {
  return {
    id: session.id,
    deviceName: session.deviceName,
    browser: session.browser,
    operatingSystem: session.operatingSystem,
    loginIp: maskIp(session.loginIp),
    lastIp: maskIp(session.lastIp),
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    expiresAt: session.expiresAt,
    active: session.revokedAt === null && session.expiresAt > now,
    revokedAt: session.revokedAt,
    revokeReason: session.revokeReason,
  };
}

export type RequestContext = {
  ip: string;
  userAgent: string;
};

export type AuthenticatedSession = {
  account: { id: string; username: string; displayName: string; isSuperAdmin: boolean; canCreateRoom: boolean; lastLoginAt?: Date | null };
  session: { id: string; accountId: string };
};

type ControlledRoomTarget = { roomId: string } | { requestId: string };

const settlementBlockerSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('PENDING_GAME_REQUEST'), requestId: z.string(), requestType: z.string() }),
  z.object({ code: z.literal('INCOMPLETE_PROPERTY_TRADE'), requestId: z.string(), buyerConfirmed: z.boolean() }),
  z.object({ code: z.literal('PROPERTY_ACTION_LOCKED'), roomPropertyId: z.string(), requestId: z.string() }),
  z.object({ code: z.literal('PENDING_ROLE_SWAP'), roleSwapRequestId: z.string(), status: z.string() }),
  z.object({ code: z.literal('INVALID_PLAYER_BALANCE'), playerId: z.string(), balance: z.number().int() }),
  z.object({ code: z.literal('OPEN_DEBT'), debtId: z.string(), outstandingAmount: z.number().int() }),
  z.object({ code: z.literal('UNRESOLVED_LANDING'), landingEventId: z.string(), status: z.string() }),
  z.object({ code: z.literal('ACTIVE_TURN'), turnId: z.string(), playerId: z.string() }),
  z.object({ code: z.literal('SETTLEMENT_DATA_INVALID'), membershipId: z.string(), playerId: z.string().nullable() }),
]);
const settlementWinnersSchema = z.array(z.string());
const settlementRankingSchema = z.array(z.object({ accountId: z.string(), rank: z.number().int().positive() }));
const settlementBlockersSchema = z.array(settlementBlockerSchema);
const propertySettlementDetailsSchema = z.array(z.object({
  roomPropertyId: z.string(),
  nameSnapshot: z.string(),
  mortgaged: z.boolean(),
  mortgagePriceSnapshot: z.number().int(),
  landSaleValue: z.number().int(),
  landSettlementValue: z.number().int(),
  buildingLevel: z.number().int(),
  buildingSellPriceSnapshot: z.number().int(),
  buildingSellValue: z.number().int(),
}));

export type SettlementBlocker = z.infer<typeof settlementBlockerSchema>;

export type FinishSettlementInput =
  | { mode: 'NORMAL'; confirmation: string }
  | { mode: 'FORCED'; reason: string };

type SettlementAccess = 'MEMBER' | 'ADMIN';

function deviceDetails(context: RequestContext) {
  const userAgent = context.userAgent || 'Unknown';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : /Firefox\//.test(userAgent) ? 'Firefox' : 'Unknown';
  const operatingSystem = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Mac OS X/.test(userAgent) ? 'macOS' : /Windows/.test(userAgent) ? 'Windows' : 'Unknown';
  return { deviceName: `${operatingSystem} ${browser}`, browser, operatingSystem, userAgent };
}

function roomCreationSummary(room: {
  id: string;
  code: string;
  name: string;
  status: string;
  initialBalance: number;
  diceMode: string;
  skillEnabled: boolean;
  startReward: number;
  allowMidgameJoin: boolean;
  visibility: string;
  transferApprovalRequired: boolean;
  passwordHash: string | null;
  createdAt: Date;
  expiresAt: Date;
}) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    status: room.status,
    initialBalance: room.initialBalance,
    diceMode: room.diceMode,
    skillEnabled: room.skillEnabled,
    startReward: room.startReward,
    allowMidgameJoin: room.allowMidgameJoin,
    visibility: room.visibility,
    transferApprovalRequired: room.transferApprovalRequired,
    hasPassword: room.passwordHash !== null,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
  };
}

function membershipSummary(membership: {
  id: string;
  roomId: string;
  accountId: string;
  status: string;
  characterId: string | null;
  isBank: boolean;
  activeSessionId: string | null;
  controlClaimedAt: Date | null;
  displayNameSnapshot: string;
  joinedAt: Date;
  leftAt: Date | null;
}, currentSessionId: string) {
  return {
    id: membership.id,
    roomId: membership.roomId,
    accountId: membership.accountId,
    status: membership.status,
    characterId: membership.characterId,
    isBank: membership.isBank,
    activeHere: membership.activeSessionId === currentSessionId,
    controlClaimedAt: membership.controlClaimedAt,
    displayNameSnapshot: membership.displayNameSnapshot,
    joinedAt: membership.joinedAt,
    leftAt: membership.leftAt,
  };
}

function playerSummary(player: {
  id: string;
  roomId: string;
  memberId: string;
  characterId: string | null;
  pawnColor: string;
  balance: number;
  status: string;
  turnOrder: number | null;
}) {
  return {
    id: player.id,
    roomId: player.roomId,
    memberId: player.memberId,
    characterId: player.characterId,
    pawnColor: player.pawnColor,
    balance: player.balance,
    status: player.status,
    turnOrder: player.turnOrder,
  };
}

function roleSwapSummary(request: {
  id: string;
  roomId: string;
  requesterMembershipId: string;
  targetMembershipId: string;
  requesterCharacterId: string | null;
  targetCharacterId: string;
  status: string;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}) {
  return {
    id: request.id,
    roomId: request.roomId,
    requesterMembershipId: request.requesterMembershipId,
    targetMembershipId: request.targetMembershipId,
    requesterCharacterId: request.requesterCharacterId,
    targetCharacterId: request.targetCharacterId,
    status: request.status,
    rejectionReason: request.rejectionReason,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    resolvedAt: request.resolvedAt,
  };
}

export class AccountRoomService {
  constructor(private readonly db: PrismaClient, private readonly isConfiguredSuperAdmin: (username: string) => boolean = () => false) {}

  private async serializable<T>(task: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.db.$transaction(task, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempt === 2) throw error;
      }
    }
    return fail('TRANSACTION_RETRY_EXHAUSTED');
  }

  private async assertRequestHash(storedHash: string | null, canonicalRequest: string) {
    const matches = storedHash ? await verifyPassword(canonicalRequest, storedHash) : false;
    if (!matches) fail('IDEMPOTENCY_KEY_REUSED');
  }

  private async replayRecord<T extends Record<string, unknown>>(
    record: { requestHash: string | null; response: Prisma.JsonValue },
    canonicalRequest: string,
  ) {
    await this.assertRequestHash(record.requestHash, canonicalRequest);
    return asObject(record.response) as T;
  }

  private async lockAccount(tx: Prisma.TransactionClient, accountId: string, missingCode = 'ACCOUNT_NOT_FOUND') {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR UPDATE
    `;
    if (!rows.length) fail(missingCode);
  }

  private async lockAccountByUsername(tx: Prisma.TransactionClient, username: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Account" WHERE "username" = ${username} FOR UPDATE
    `;
    if (!rows.length) fail('ACCOUNT_NOT_FOUND');
    return rows[0]!.id;
  }

  private async ensureAdminActor(tx: Prisma.TransactionClient, auth: AuthenticatedSession) {
    const session = await tx.accountSession.findFirst({
      where: { id: auth.session.id, accountId: auth.account.id },
      include: { account: true },
    });
    const active = required(session, 'SESSION_INVALID');
    if (active.accountId !== auth.session.accountId || active.account.id !== auth.account.id
      || active.revokedAt || active.expiresAt <= new Date() || active.account.status !== 'ACTIVE') fail('SESSION_INVALID');
    if (!this.isConfiguredSuperAdmin(active.account.username)) fail('ADMIN_REQUIRED');
    return active.account;
  }

  private async requireCurrentAdmin(auth: AuthenticatedSession) {
    return this.db.$transaction((tx) => this.ensureAdminActor(tx, auth));
  }

  private async allowPhysicalHistoryDelete(tx: Prisma.TransactionClient) {
    await tx.$executeRawUnsafe(
      "SELECT set_config('zhenhuan.physical_delete_txid', pg_current_xact_id()::text, true)",
    );
  }

  private async replayAdminDelete<T extends Record<string, unknown>>(
    auth: AuthenticatedSession,
    operation: string,
    resourceId: string,
    key: string,
    input: unknown,
  ) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    await this.requireCurrentAdmin(auth);
    const record = await this.db.idempotencyRecord.findUnique({
      where: { scope_key: { scope: `account:${auth.account.id}:admin:${operation}:${resourceId}`, key } },
    });
    return record ? this.replayRecord<T>(record, JSON.stringify(canonicalValue(input))) : null;
  }

  private async executeAdminWrite<T extends Record<string, unknown>>(options: {
    auth: AuthenticatedSession;
    operation: string;
    resourceId: string;
    key: string;
    input: unknown;
    lock: (tx: Prisma.TransactionClient) => Promise<void>;
    authorize: (tx: Prisma.TransactionClient) => Promise<void>;
    mutate: (tx: Prisma.TransactionClient) => Promise<{ value: T; mutationCreated?: boolean }>;
    p2002Code?: string;
    retrySerialization?: boolean;
    roomId?: string;
  }): Promise<{ value: T; created: boolean }> {
    if (!options.key) fail('IDEMPOTENCY_KEY_REQUIRED');
    const scope = `account:${options.auth.account.id}:admin:${options.operation}:${options.resourceId}`;
    const canonicalRequest = JSON.stringify(canonicalValue(options.input));
    const retrySerialization = options.retrySerialization ?? true;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await this.db.$transaction(async (tx) => {
          await options.lock(tx);
          await this.ensureAdminActor(tx, options.auth);
          await options.authorize(tx);
          const previous = await tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key: options.key } } });
          if (previous) return { value: await this.replayRecord<T>(previous, canonicalRequest), created: false };
          const result = await options.mutate(tx);
          const stateVersion = options.roomId && result.mutationCreated !== false
            ? (await tx.room.update({ where: { id: options.roomId }, data: { stateVersion: { increment: 1 } }, select: { stateVersion: true } })).stateVersion
            : null;
          const value = canonicalValue({ ...result.value, ...(stateVersion === null ? {} : { stateVersion }) }) as T;
          await tx.idempotencyRecord.create({
            data: { scope, key: options.key, requestHash: await hashPassword(canonicalRequest), response: value as Prisma.InputJsonObject },
          });
          return { value, created: result.mutationCreated ?? true };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isSerializationConflict(error)) {
          if (retrySerialization && attempt < 5) continue;
          if (!retrySerialization) {
            try {
              const winner = await this.db.$transaction(async (tx) => {
                await options.lock(tx);
                await this.ensureAdminActor(tx, options.auth);
                await options.authorize(tx);
                return tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key: options.key } } });
              }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
              if (winner) return { value: await this.replayRecord<T>(winner, canonicalRequest), created: false };
            } catch (recoveryError) {
              if (!isSerializationConflict(recoveryError)) throw recoveryError;
            }
          }
          fail('TRANSACTION_CONFLICT');
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          try {
            const winner = await this.db.$transaction(async (tx) => {
              await options.lock(tx);
              await this.ensureAdminActor(tx, options.auth);
              await options.authorize(tx);
              return tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key: options.key } } });
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
            if (winner) return { value: await this.replayRecord<T>(winner, canonicalRequest), created: false };
          } catch (recoveryError) {
            if (!isSerializationConflict(recoveryError)) throw recoveryError;
          }
          if (options.p2002Code) fail(options.p2002Code);
          fail('TRANSACTION_CONFLICT');
        }
        throw error;
      }
    }
    return fail('TRANSACTION_CONFLICT');
  }

  private async executeIdempotent<T extends Record<string, unknown>>(
    scope: string,
    key: string,
    input: unknown,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    afterCreate?: () => void | Promise<void>,
    shouldIncrementRoomVersion: () => boolean = () => true,
  ): Promise<T> {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    const canonicalRequest = JSON.stringify(canonicalValue(input));
    const roomId = typeof input === 'object' && input !== null && typeof (input as { roomId?: unknown }).roomId === 'string'
      ? (input as { roomId: string }).roomId
      : null;
    const isolationLevel = roomId
      ? Prisma.TransactionIsolationLevel.ReadCommitted
      : Prisma.TransactionIsolationLevel.Serializable;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const result = await this.db.$transaction(async (tx) => {
          if (roomId) await this.lockRoom(tx, roomId);
          const previous = await tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
          if (previous) return { response: await this.replayRecord<T>(previous, canonicalRequest), created: false };
          const result = canonicalValue(await work(tx)) as T;
          const stateVersion = roomId && shouldIncrementRoomVersion()
            ? (await tx.room.update({ where: { id: roomId }, data: { stateVersion: { increment: 1 } }, select: { stateVersion: true } })).stateVersion
            : null;
          const response = { ...result, ...(stateVersion === null ? {} : { stateVersion }) } as T;
          await tx.idempotencyRecord.create({
            data: {
              scope,
              key,
              requestHash: await hashPassword(canonicalRequest),
              response: response as Prisma.InputJsonObject,
            },
          });
          return { response, created: true };
        }, { isolationLevel });
        if (result.created) await afterCreate?.();
        return result.response;
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 5) continue;
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          for (let replayAttempt = 0; replayAttempt < 5; replayAttempt += 1) {
            const previous = await this.db.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
            if (previous) return this.replayRecord<T>(previous, canonicalRequest);
            if (replayAttempt < 4) await new Promise((resolve) => setTimeout(resolve, 10 * (replayAttempt + 1)));
          }
        }
        throw error;
      }
    }
    return fail('TRANSACTION_RETRY_EXHAUSTED');
  }

  private async lockRoom(tx: Prisma.TransactionClient, roomId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Room" WHERE "id" = ${roomId} FOR UPDATE
    `;
    if (!rows.length) fail('ROOM_NOT_FOUND');
  }

  private async playablePlayers(tx: Prisma.TransactionClient, roomId: string) {
    const candidates = await tx.player.findMany({
      where: {
        roomId,
        status: 'ACTIVE',
        characterId: { not: null },
        member: { roomId, status: 'ACTIVE', characterId: { not: null } },
      },
      include: { member: true },
      orderBy: [{ turnOrder: 'asc' }, { id: 'asc' }],
    });
    return candidates.filter((player) => player.characterId === player.member.characterId);
  }

  private allocatePlayerSeat(
    playerLimit: number,
    players: Array<{ id: string; pawnColor: string; turnOrder: number | null }>,
    current?: { id: string; pawnColor: string; turnOrder: number | null },
  ) {
    const occupied = players.filter((player) => player.id !== current?.id);
    const usedColors = new Set(occupied.map((player) => player.pawnColor));
    const usedTurnOrders = new Set(occupied.flatMap((player) => player.turnOrder === null ? [] : [player.turnOrder]));
    if (current && current.turnOrder !== null && !usedColors.has(current.pawnColor) && !usedTurnOrders.has(current.turnOrder)) {
      return { pawnColor: current.pawnColor, turnOrder: current.turnOrder };
    }
    return {
      pawnColor: required(colors.find((color) => !usedColors.has(color)), 'PLAYER_LIMIT'),
      turnOrder: required(Array.from({ length: playerLimit }, (_, index) => index + 1).find((order) => !usedTurnOrders.has(order)), 'PLAYER_LIMIT'),
    };
  }

  private admissionError(room: { status: string; allowMidgameJoin: boolean }) {
    if (room.status === 'ENDED' || room.status === 'FINISHED' || room.status === 'CLOSED') return 'ROOM_FINISHED';
    if (room.status === 'PLAYING' && !room.allowMidgameJoin) return 'MIDGAME_JOIN_DISABLED';
    return null;
  }

  private requireSeatAcquisitionAllowed(
    membership: { room: { status: string; allowMidgameJoin: boolean } },
    alreadyHasCapability: boolean,
  ) {
    if (['ENDED', 'FINISHED', 'CLOSED'].includes(membership.room.status)) fail('ROOM_FINISHED');
    if (!alreadyHasCapability && membership.room.status === 'PLAYING' && !membership.room.allowMidgameJoin) {
      fail('MIDGAME_JOIN_DISABLED');
    }
  }

  private async createSession(tx: Prisma.TransactionClient, accountId: string, context: RequestContext) {
    const rawToken = token();
    const details = deviceDetails(context);
    const session = await tx.accountSession.create({ data: {
      accountId,
      sessionTokenHash: hash(rawToken),
      deviceId: randomBytes(16).toString('hex'),
      ...details,
      loginIp: context.ip,
      lastIp: context.ip,
      expiresAt: new Date(Date.now() + sessionDurationMs),
    } });
    return { rawToken, session: { id: session.id, accountId: session.accountId } };
  }

  async login(username: string, password: string, context: RequestContext) {
    const found = await this.db.account.findUnique({ where: { username } });
    if (!found || found.status !== 'ACTIVE' || !(await verifyPassword(password, found.passwordHash))) {
      await this.db.securityLog.create({ data: { accountId: found?.id, action: 'LOGIN_FAILED', ip: context.ip } });
      fail('INVALID_CREDENTIALS');
    }
    const account = required(found, 'INVALID_CREDENTIALS');
    const result = await this.serializable(async (tx) => {
      const currentAccount = required(await tx.account.findUnique({ where: { id: account.id } }), 'INVALID_CREDENTIALS');
      if (currentAccount.status !== 'ACTIVE' || currentAccount.passwordHash !== account.passwordHash) fail('INVALID_CREDENTIALS');
      const active = await tx.accountSession.findMany({
        where: { accountId: currentAccount.id, ...activeSessionWhere() },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (active.length >= 2) {
        await tx.securityLog.create({ data: { accountId: currentAccount.id, action: 'SESSION_LIMIT_REACHED', ip: context.ip } });
        return { status: 'LIMIT' as const, devices: active.map((session) => sessionSummary(session)) };
      }
      const next = await this.createSession(tx, currentAccount.id, context);
      const loggedInAccount = await tx.account.update({ where: { id: currentAccount.id }, data: { lastLoginAt: new Date() } });
      await tx.securityLog.create({ data: { accountId: currentAccount.id, action: 'LOGIN_SUCCEEDED', ip: context.ip } });
      return { status: 'OK' as const, ...next, account: accountSummary(loggedInAccount, this.isConfiguredSuperAdmin(loggedInAccount.username)) };
    });
    return result;
  }

  async replaceOldestSession(username: string, password: string, context: RequestContext) {
    const account = required(await this.db.account.findUnique({ where: { username } }), 'INVALID_CREDENTIALS');
    if (account.status !== 'ACTIVE' || !(await verifyPassword(password, account.passwordHash))) fail('INVALID_CREDENTIALS');
    const created = await this.serializable(async (tx) => {
      const currentAccount = required(await tx.account.findUnique({ where: { id: account.id } }), 'INVALID_CREDENTIALS');
      if (currentAccount.status !== 'ACTIVE' || currentAccount.passwordHash !== account.passwordHash) fail('INVALID_CREDENTIALS');
      const oldest = required(await tx.accountSession.findFirst({ where: { accountId: currentAccount.id, ...activeSessionWhere() }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }), 'SESSION_NOT_FOUND');
      await tx.accountSession.update({ where: { id: oldest.id }, data: { revokedAt: new Date(), revokeReason: 'REPLACED_BY_NEW_DEVICE' } });
      const next = await this.createSession(tx, currentAccount.id, context);
      const loggedInAccount = await tx.account.update({ where: { id: currentAccount.id }, data: { lastLoginAt: new Date() } });
      await tx.securityLog.create({ data: { accountId: currentAccount.id, action: 'REPLACED_OLDEST_SESSION', ip: context.ip } });
      return { ...next, account: accountSummary(loggedInAccount, this.isConfiguredSuperAdmin(loggedInAccount.username)), replacedSessionId: oldest.id };
    });
    return created;
  }

  async authenticate(rawToken: string, ip: string): Promise<AuthenticatedSession> {
    if (!rawToken) fail('AUTH_REQUIRED');
    const session = required(await this.db.accountSession.findUnique({
      where: { sessionTokenHash: hash(rawToken) },
      select: {
        id: true,
        accountId: true,
        revokedAt: true,
        expiresAt: true,
        lastActiveAt: true,
        lastIp: true,
        account: {
          select: {
            id: true,
            username: true,
            displayName: true,
            canCreateRoom: true,
            status: true,
          },
        },
      },
    }), 'SESSION_INVALID');
    if (session.revokedAt || session.expiresAt <= new Date() || session.account.status !== 'ACTIVE') fail('SESSION_INVALID');
    if (Date.now() - session.lastActiveAt.getTime() > 60_000 || session.lastIp !== ip) {
      await this.db.accountSession.update({ where: { id: session.id }, data: { lastActiveAt: new Date(), lastIp: ip } });
    }
    return {
      account: accountSummary(session.account, this.isConfiguredSuperAdmin(session.account.username)),
      session: { id: session.id, accountId: session.accountId },
    };
  }

  async listSessions(auth: AuthenticatedSession) {
    const sessions = await this.db.accountSession.findMany({ where: { accountId: auth.account.id, ...activeSessionWhere() }, orderBy: { createdAt: 'desc' } });
    return sessions.map((session) => sessionSummary(session, auth.session.id));
  }

  async revokeSession(auth: AuthenticatedSession, sessionId: string) {
    const session = required(await this.db.accountSession.findFirst({ where: { id: sessionId, accountId: auth.account.id, revokedAt: null } }), 'SESSION_NOT_FOUND');
    await this.db.$transaction([
      this.db.accountSession.update({ where: { id: session.id }, data: { revokedAt: new Date(), revokeReason: 'USER_REVOKED' } }),
      this.db.securityLog.create({ data: { accountId: auth.account.id, action: 'SESSION_REVOKED' } }),
    ]);
    return { sessionId: session.id };
  }

  async logoutOthers(auth: AuthenticatedSession) {
    return this.db.$transaction(async (tx) => {
      const sessions = await tx.accountSession.findMany({ where: { accountId: auth.account.id, id: { not: auth.session.id }, ...activeSessionWhere() }, select: { id: true } });
      if (sessions.length) await tx.accountSession.updateMany({ where: { id: { in: sessions.map((session) => session.id) } }, data: { revokedAt: new Date(), revokeReason: 'LOGOUT_OTHERS' } });
      await tx.securityLog.create({ data: { accountId: auth.account.id, action: 'LOGOUT_OTHERS', detailsJson: { count: sessions.length } } });
      return { revoked: sessions.length, revokedSessionIds: sessions.map((session) => session.id) };
    });
  }

  async createAccount(auth: AuthenticatedSession, input: { username: string; password: string; displayName: string; canCreateRoom?: boolean; note?: string }, key: string) {
    const result = await this.executeAdminWrite({
      auth,
      operation: 'account:create',
      resourceId: 'accounts',
      key,
      input,
      lock: (tx) => this.lockAccount(tx, auth.account.id, 'SESSION_INVALID'),
      authorize: async () => undefined,
      p2002Code: 'USERNAME_TAKEN',
      mutate: async (tx) => {
        const account = await tx.account.create({ data: {
          username: input.username,
          passwordHash: await hashPassword(input.password),
          displayName: input.displayName,
          canCreateRoom: input.canCreateRoom ?? false,
          note: input.note,
        } });
        await tx.securityLog.create({ data: { accountId: account.id, actorAccountId: auth.account.id, action: 'ACCOUNT_CREATED' } });
        return { value: adminAccountDto(account, this.isConfiguredSuperAdmin(account.username)) };
      },
    });
    return result.value;
  }

  async listAccounts(auth: AuthenticatedSession, input: { query?: string; status?: 'ACTIVE' | 'DISABLED'; permission?: 'isSuperAdmin' | 'canCreateRoom'; cursor?: string; limit?: number } = {}) {
    await this.requireCurrentAdmin(auth);
    const limit = pageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const filters: Prisma.AccountWhereInput[] = [];
    if (input.query) filters.push({ OR: [
      { username: { contains: input.query, mode: 'insensitive' } },
      { displayName: { contains: input.query, mode: 'insensitive' } },
      { note: { contains: input.query, mode: 'insensitive' } },
    ] });
    if (input.status) filters.push({ status: input.status });
    if (input.permission === 'canCreateRoom') filters.push({ canCreateRoom: true });
    if (cursor) filters.push(cursorWhere(cursor));
    const rows = await this.db.account.findMany({ where: { AND: filters }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit).filter((account) => input.permission !== 'isSuperAdmin' || this.isConfiguredSuperAdmin(account.username));
    return { items: items.map((account) => adminAccountDto(account, this.isConfiguredSuperAdmin(account.username))), nextCursor: hasNext ? encodeCursor(rows.slice(0, limit).at(-1)!) : null };
  }

  async updateAccount(auth: AuthenticatedSession, id: string, input: { displayName?: string; canCreateRoom?: boolean; note?: string | null }, key: string) {
    const result = await this.executeAdminWrite({
      auth,
      operation: 'account:update',
      resourceId: id,
      key,
      input,
      lock: (tx) => this.lockAccount(tx, id),
      authorize: async (tx) => { required(await tx.account.findUnique({ where: { id } }), 'ACCOUNT_NOT_FOUND'); },
      mutate: async (tx) => {
        const account = await tx.account.update({ where: { id }, data: input });
        await tx.securityLog.create({ data: {
          accountId: id,
          actorAccountId: auth.account.id,
          action: 'ACCOUNT_UPDATED',
          detailsJson: { changedFields: Object.keys(input).sort() },
        } });
        return { value: adminAccountDto(account, this.isConfiguredSuperAdmin(account.username)) };
      },
    });
    return result.value;
  }

  async resetPassword(auth: AuthenticatedSession, id: string, password: string, key: string) {
    const result = await this.executeAdminWrite({
      auth,
      operation: 'account:reset-password',
      resourceId: id,
      key,
      input: { password },
      lock: (tx) => this.lockAccount(tx, id),
      authorize: async (tx) => { required(await tx.account.findUnique({ where: { id } }), 'ACCOUNT_NOT_FOUND'); },
      mutate: async (tx) => {
        const reset = await resetAccountPassword(tx, { accountId: id, password, actorAccountId: auth.account.id });
        return { value: { account: adminAccountDto(reset.account, this.isConfiguredSuperAdmin(reset.account.username)), revokedSessions: reset.revokedSessions, revokedSessionIds: reset.revokedSessionIds } };
      },
    });
    return result.value;
  }

  async resetSuperAdminPassword(username: string, password: string) {
    passwordSchema.parse(password);
    return this.db.$transaction(async (tx) => {
      const accountId = await this.lockAccountByUsername(tx, username);
      const account = required(await tx.account.findUnique({ where: { id: accountId } }), 'ACCOUNT_NOT_FOUND');
      if (!this.isConfiguredSuperAdmin(account.username)) fail('SUPER_ADMIN_REQUIRED');
      if (account.status !== 'ACTIVE') fail('ACCOUNT_DISABLED');
      const reset = await resetAccountPassword(tx, { accountId: account.id, password, source: 'OFFLINE_OPERATIONS_CLI' });
      return { username: reset.account.username, revokedSessions: reset.revokedSessions };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async setAccountStatus(auth: AuthenticatedSession, id: string, enabled: boolean, key: string) {
    const result = await this.executeAdminWrite({
      auth,
      operation: enabled ? 'account:enable' : 'account:disable',
      resourceId: id,
      key,
      input: { enabled },
      lock: (tx) => this.lockAccount(tx, id),
      authorize: async (tx) => { required(await tx.account.findUnique({ where: { id } }), 'ACCOUNT_NOT_FOUND'); },
      mutate: async (tx) => {
        const current = required(await tx.account.findUnique({ where: { id } }), 'ACCOUNT_NOT_FOUND');
        if (!enabled && this.isConfiguredSuperAdmin(current.username)) fail('SUPER_ADMIN_CANNOT_BE_DISABLED');
        if (enabled && current.status === 'ACTIVE') fail('ACCOUNT_ALREADY_ENABLED');
        if (!enabled && current.status === 'DISABLED') fail('ACCOUNT_ALREADY_DISABLED');
        const at = new Date();
        const account = await tx.account.update({ where: { id }, data: { status: enabled ? 'ACTIVE' : 'DISABLED', deletedAt: enabled ? null : at } });
        const sessions = enabled ? [] : await tx.accountSession.findMany({ where: { accountId: id, revokedAt: null, expiresAt: { gt: at } }, select: { id: true } });
        if (sessions.length) await tx.accountSession.updateMany({ where: { id: { in: sessions.map((session) => session.id) } }, data: { revokedAt: at, revokeReason: 'ACCOUNT_DISABLED' } });
        await tx.securityLog.create({ data: { accountId: id, actorAccountId: auth.account.id, action: enabled ? 'ACCOUNT_ENABLED' : 'ACCOUNT_DISABLED', detailsJson: { revokedSessions: sessions.length }, createdAt: at } });
        return { value: { account: adminAccountDto(account, this.isConfiguredSuperAdmin(account.username)), revokedSessions: sessions.length, revokedSessionIds: sessions.map((session) => session.id) } };
      },
    });
    return result.value;
  }

  async deleteAccount(auth: AuthenticatedSession, id: string, key: string) {
    const replay = await this.replayAdminDelete<{ deleted: true; id: string; revokedSessionIds: string[] }>(auth, 'account:delete', id, key, { id });
    if (replay) return { ...replay, created: false };
    const result = await this.executeAdminWrite({
      auth,
      operation: 'account:delete',
      resourceId: id,
      key,
      input: { id },
      lock: (tx) => this.lockAccount(tx, id),
      authorize: async (tx) => {
        const target = required(await tx.account.findUnique({ where: { id } }), 'ACCOUNT_NOT_FOUND');
        if (id === auth.account.id) fail('CANNOT_DELETE_CURRENT_ACCOUNT');
        if (this.isConfiguredSuperAdmin(target.username)) fail('CANNOT_DELETE_SUPER_ADMIN');
        const [memberships, createdRooms, endedSettlements, settlementRows] = await Promise.all([
          tx.roomMembership.count({ where: { accountId: id } }),
          tx.room.count({ where: { createdByAccountId: id } }),
          tx.gameSettlement.count({ where: { endedByAccountId: id } }),
          tx.settlementPlayer.count({ where: { accountId: id } }),
        ]);
        if (memberships || createdRooms || endedSettlements || settlementRows) fail('ACCOUNT_DELETE_BLOCKED');
      },
      mutate: async (tx) => {
        const sessions = await tx.accountSession.findMany({ where: { accountId: id }, select: { id: true } });
        await this.allowPhysicalHistoryDelete(tx);
        await tx.securityLog.deleteMany({ where: { OR: [{ accountId: id }, { actorAccountId: id }] } });
        await tx.idempotencyRecord.deleteMany({ where: { scope: { startsWith: `account:${id}:` } } });
        await tx.account.delete({ where: { id } });
        return { value: { deleted: true as const, id, revokedSessionIds: sessions.map((session) => session.id) } };
      },
    });
    return { ...result.value, created: result.created };
  }

  async listAccountSessions(auth: AuthenticatedSession, accountId: string, input: { state?: 'active' | 'recent'; cursor?: string; limit?: number } = {}) {
    await this.requireCurrentAdmin(auth);
    required(await this.db.account.findUnique({ where: { id: accountId }, select: { id: true } }), 'ACCOUNT_NOT_FOUND');
    const now = new Date();
    const limit = pageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = await this.db.accountSession.findMany({
      where: {
        accountId,
        ...(input.state === 'active' ? activeSessionWhere(now) : {}),
        ...cursorWhere(cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items: items.map((session) => adminSessionDto(session, now)), nextCursor: hasNext ? encodeCursor(items.at(-1)!) : null };
  }

  async revokeAccountSession(auth: AuthenticatedSession, accountId: string, sessionId: string, reason: string, key: string) {
    return this.executeAdminWrite({
      auth,
      operation: 'account:session:revoke',
      resourceId: `${accountId}:${sessionId}`,
      key,
      input: { accountId, sessionId, reason },
      lock: (tx) => this.lockAccount(tx, accountId),
      authorize: async (tx) => {
        required(await tx.account.findUnique({ where: { id: accountId } }), 'ACCOUNT_NOT_FOUND');
        required(await tx.accountSession.findFirst({ where: { id: sessionId, accountId } }), 'SESSION_NOT_FOUND');
      },
      mutate: async (tx) => {
        const session = required(await tx.accountSession.findFirst({ where: { id: sessionId, accountId } }), 'SESSION_NOT_FOUND');
        if (session.revokedAt || session.expiresAt <= new Date()) fail('SESSION_ALREADY_REVOKED');
        const at = new Date();
        await tx.accountSession.update({ where: { id: sessionId }, data: { revokedAt: at, revokeReason: reason } });
        await tx.securityLog.create({ data: { accountId, actorAccountId: auth.account.id, action: 'ACCOUNT_SESSION_REVOKED', detailsJson: { reason }, createdAt: at } });
        return { value: { sessionId, revokedAt: at, reason } };
      },
    });
  }

  async listRooms(auth: AuthenticatedSession) {
    const rooms = await this.db.room.findMany({ where: { OR: [{ visibility: 'PUBLIC' }, { members: { some: { accountId: auth.account.id } } }] }, include: { createdByAccount: { select: { displayName: true } }, members: { where: { status: 'ACTIVE' }, select: { accountId: true, characterId: true, isBank: true, character: { select: { name: true } } } }, settlement: { select: { endedAt: true } } }, orderBy: { updatedAt: 'desc' } });
    return rooms.map((room) => {
      const mine = room.members.find((member) => member.accountId === auth.account.id);
      return {
        id: room.id,
        name: room.name,
        status: room.status,
        creator: room.createdByAccount.displayName,
        memberCount: new Set(room.members.map((member) => member.accountId)).size,
        playerCount: room.members.filter((member) => member.characterId !== null).length,
        playerLimit: room.playerLimit,
        hasPassword: room.passwordHash !== null,
        mine: Boolean(mine),
        characterId: mine?.characterId ?? null,
        myCharacter: mine?.character?.name ?? null,
        isBank: mine?.isBank ?? false,
        createdAt: room.createdAt,
        startedAt: room.startedAt,
        endedAt: room.settlement?.endedAt ?? null,
      };
    });
  }

  async deleteRoom(auth: AuthenticatedSession, roomId: string, key: string) {
    const replay = await this.replayAdminDelete<{ deleted: true; id: string; stateVersion: number }>(auth, 'room:delete', roomId, key, { roomId });
    if (replay) return { ...replay, created: false };
    const result = await this.executeAdminWrite({
      auth,
      operation: 'room:delete',
      resourceId: roomId,
      key,
      input: { roomId },
      lock: (tx) => this.lockRoom(tx, roomId),
      authorize: async () => undefined,
      mutate: async (tx) => {
        const room = required(await tx.room.findUnique({ where: { id: roomId }, select: { stateVersion: true } }), 'ROOM_NOT_FOUND');
        await this.allowPhysicalHistoryDelete(tx);
        await tx.securityLog.deleteMany({ where: { detailsJson: { path: ['roomId'], equals: roomId } } });
        await tx.settlementPlayer.deleteMany({ where: { settlement: { roomId } } });
        await tx.gameSettlement.deleteMany({ where: { roomId } });
        await tx.gameResult.deleteMany({ where: { roomId } });
        await tx.ledgerEntry.deleteMany({ where: { roomId } });
        await tx.gameTransaction.deleteMany({ where: { roomId } });
        await tx.debtRecord.deleteMany({ where: { roomId } });
        await tx.skipTurnEntry.deleteMany({ where: { roomId } });
        await tx.landingEvent.deleteMany({ where: { roomId } });
        await tx.gameRequest.deleteMany({ where: { roomId } });
        await tx.turn.deleteMany({ where: { roomId } });
        await tx.roleSwapRequest.deleteMany({ where: { roomId } });
        await tx.auditLog.deleteMany({ where: { roomId } });
        await tx.roomProperty.deleteMany({ where: { roomId } });
        await tx.player.deleteMany({ where: { roomId } });
        await tx.roomMembership.deleteMany({ where: { roomId } });
        await tx.idempotencyRecord.deleteMany({ where: { OR: [{ scope: { contains: `:room:${roomId}:` } }, { scope: { endsWith: `:${roomId}` } }] } });
        await tx.room.delete({ where: { id: roomId } });
        return { value: { deleted: true as const, id: roomId, stateVersion: room.stateVersion + 1 } };
      },
    });
    return { ...result.value, created: result.created };
  }

  async listAdminRooms(auth: AuthenticatedSession, input: { query?: string; status?: 'LOBBY' | 'PLAYING' | 'FINISHED'; cursor?: string; limit?: number } = {}) {
    await this.requireCurrentAdmin(auth);
    const limit = pageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const filters: Prisma.RoomWhereInput[] = [];
    if (input.query) filters.push({ OR: [
      { name: { contains: input.query, mode: 'insensitive' } },
      { code: { contains: input.query, mode: 'insensitive' } },
      { createdByAccount: { displayName: { contains: input.query, mode: 'insensitive' } } },
    ] });
    if (input.status) filters.push({ status: input.status });
    if (cursor) filters.push(cursorWhere(cursor));
    const rows = await this.db.room.findMany({
      where: { AND: filters },
      include: {
        createdByAccount: { select: { id: true, displayName: true } },
        members: { where: { status: 'ACTIVE' }, select: { accountId: true, characterId: true, isBank: true } },
        settlement: { select: { id: true, endedAt: true, forced: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items: items.map((room) => ({
        id: room.id,
        name: room.name,
        status: room.status,
        visibility: room.visibility,
        creator: room.createdByAccount,
        memberCount: new Set(room.members.map((member) => member.accountId)).size,
        playerCount: room.members.filter((member) => member.characterId !== null).length,
        hasBank: room.members.some((member) => member.isBank),
        hasPassword: room.passwordHash !== null,
        createdAt: room.createdAt,
        startedAt: room.startedAt,
        updatedAt: room.updatedAt,
        settlement: room.settlement,
      })),
      nextCursor: hasNext ? encodeCursor(items.at(-1)!) : null,
    };
  }

  async getAdminRoom(auth: AuthenticatedSession, roomId: string) {
    await this.requireCurrentAdmin(auth);
    const room = required(await this.db.room.findUnique({
      where: { id: roomId },
      include: {
        createdByAccount: { select: { id: true, displayName: true, username: true } },
        members: {
          where: { status: 'ACTIVE' },
          include: {
            character: { select: { id: true, name: true } },
            activeSession: { select: { revokedAt: true, expiresAt: true } },
            player: { select: { id: true, characterId: true, balance: true, status: true, turnOrder: true, _count: { select: { ownedProperties: true } } } },
          },
          orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        },
        settlement: { select: { id: true, endedAt: true, durationSeconds: true, forced: true, forceReason: true } },
      },
    }), 'ROOM_NOT_FOUND');
    const [pendingRequests, pendingSwaps, openDebts, activeTurns] = await Promise.all([
      this.db.gameRequest.count({ where: { roomId, status: 'PENDING' } }),
      this.db.roleSwapRequest.count({ where: { roomId, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } } }),
      this.db.debtRecord.count({ where: { roomId, status: { in: ['OPEN', 'PARTIALLY_PAID'] }, outstandingAmount: { gt: 0 } } }),
      this.db.turn.count({ where: { roomId, status: 'ACTIVE' } }),
    ]);
    const now = new Date();
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      status: room.status,
      creator: room.createdByAccount,
      configuration: {
        initialBalance: room.initialBalance,
        diceMode: room.diceMode,
        skillEnabled: room.skillEnabled,
        startReward: room.startReward,
        allowMidgameJoin: room.allowMidgameJoin,
        visibility: room.visibility,
        transferApprovalRequired: room.transferApprovalRequired,
        playerLimit: room.playerLimit,
        hasPassword: room.passwordHash !== null,
      },
      lifecycle: { createdAt: room.createdAt, startedAt: room.startedAt, updatedAt: room.updatedAt, expiresAt: room.expiresAt },
      members: room.members.map((member) => ({
        id: member.id,
        accountId: member.accountId,
        displayNameSnapshot: member.displayNameSnapshot,
        status: member.status,
        characterId: member.characterId,
        characterName: member.character?.name ?? null,
        isBank: member.isBank,
        controllerActive: Boolean(member.activeSession && !member.activeSession.revokedAt && member.activeSession.expiresAt > now),
        joinedAt: member.joinedAt,
        player: member.player ? {
          id: member.player.id,
          characterId: member.player.characterId,
          balance: member.player.balance,
          status: member.player.status,
          turnOrder: member.player.turnOrder,
          ownedPropertyCount: member.player._count.ownedProperties,
        } : null,
      })),
      blockers: { pendingRequests, pendingSwaps, openDebts, activeTurns },
      settlement: room.settlement,
    };
  }

  async updateAdminRoom(auth: AuthenticatedSession, roomId: string, input: {
    name?: string; visibility?: string; diceMode?: 'ELECTRONIC' | 'PHYSICAL'; skillEnabled?: boolean;
    startReward?: number; allowMidgameJoin?: boolean; transferApprovalRequired?: boolean; initialBalance?: number;
  }, key: string) {
    const result = await this.executeAdminWrite({
      auth,
      operation: 'room:update',
      resourceId: roomId,
      roomId,
      key,
      input,
      lock: (tx) => this.lockRoom(tx, roomId),
      authorize: async (tx) => {
        const room = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
        if (['ENDED', 'FINISHED', 'CLOSED'].includes(room.status)) fail('ROOM_TERMINAL');
      },
      mutate: async (tx) => {
        const room = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
        const keys = Object.keys(input);
        const lobbyOnly = ['diceMode', 'skillEnabled', 'startReward', 'initialBalance'];
        if (room.status !== 'LOBBY' && keys.some((field) => lobbyOnly.includes(field))) fail('ROOM_CONFIG_LIFECYCLE_CONFLICT');
        if (input.initialBalance !== undefined) {
          const [players, initialLedgers] = await Promise.all([
            tx.player.count({ where: { roomId } }),
            tx.ledgerEntry.count({ where: { roomId, type: 'INITIAL_BALANCE' } }),
          ]);
          if (players || initialLedgers) fail('INITIAL_BALANCE_LOCKED');
        }
        const before = Object.fromEntries(keys.map((field) => [field, room[field as keyof typeof room]]));
        const updated = await tx.room.update({ where: { id: roomId }, data: input });
        const after = Object.fromEntries(keys.map((field) => [field, updated[field as keyof typeof updated]]));
        await tx.auditLog.create({ data: { roomId, actorRole: 'ADMIN', action: 'ADMIN_ROOM_UPDATED', entityType: 'Room', entityId: roomId, beforeJson: canonicalValue(before) as Prisma.InputJsonObject, afterJson: canonicalValue(after) as Prisma.InputJsonObject } });
        await tx.securityLog.create({ data: { accountId: auth.account.id, actorAccountId: auth.account.id, action: 'ADMIN_ROOM_UPDATED', detailsJson: { roomId, changedFields: keys.sort() } } });
        return { value: { roomId, ...after, updatedAt: updated.updatedAt } };
      },
    });
    return result.value;
  }

  async updateAdminRoomPassword(auth: AuthenticatedSession, roomId: string, password: string | null, key: string) {
    const result = await this.executeAdminWrite({
      auth,
      operation: 'room:password',
      resourceId: roomId,
      roomId,
      key,
      input: { password },
      lock: (tx) => this.lockRoom(tx, roomId),
      authorize: async (tx) => {
        const room = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
        if (['ENDED', 'FINISHED', 'CLOSED'].includes(room.status)) fail('ROOM_TERMINAL');
      },
      mutate: async (tx) => {
        const current = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
        const updated = await tx.room.update({ where: { id: roomId }, data: { passwordHash: password === null ? null : await hashPassword(password) } });
        await tx.auditLog.create({ data: { roomId, actorRole: 'ADMIN', action: 'ADMIN_ROOM_PASSWORD_UPDATED', entityType: 'Room', entityId: roomId, beforeJson: { hasPassword: current.passwordHash !== null }, afterJson: { hasPassword: password !== null } } });
        await tx.securityLog.create({ data: { accountId: auth.account.id, actorAccountId: auth.account.id, action: 'ADMIN_ROOM_PASSWORD_UPDATED', detailsJson: { roomId, hasPassword: password !== null } } });
        return { value: { roomId, hasPassword: password !== null, updatedAt: updated.updatedAt } };
      },
    });
    return result.value;
  }

  async removeAdminRoomMember(
    auth: AuthenticatedSession,
    roomId: string,
    memberId: string,
    key: string,
    afterCommit?: (event: { removedSessionId: string }) => void,
  ) {
    let removedSessionId: string | null = null;
    const result = await this.executeAdminWrite({
      auth,
      operation: 'room:member:remove',
      resourceId: `${roomId}:${memberId}`,
      roomId,
      key,
      input: { roomId, memberId },
      lock: (tx) => this.lockRoom(tx, roomId),
      authorize: async (tx) => {
        const room = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
        if (['ENDED', 'FINISHED', 'CLOSED'].includes(room.status)) fail('ROOM_TERMINAL');
        required(await tx.roomMembership.findFirst({ where: { id: memberId, roomId } }), 'MEMBERSHIP_NOT_FOUND');
      },
      mutate: async (tx) => {
        const room = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
        const member = required(await tx.roomMembership.findFirst({ where: { id: memberId, roomId }, include: { player: true } }), 'MEMBERSHIP_NOT_FOUND');
        if (member.status !== 'ACTIVE') fail('MEMBERSHIP_NOT_ACTIVE');
        const playerId = member.player?.id;
        if (playerId) {
          const ownsCurrentTurn = room.currentTurnPlayerId === playerId || await tx.turn.count({ where: { roomId, playerId, status: 'ACTIVE' } }) > 0;
          if (ownsCurrentTurn) fail('MEMBER_HAS_ACTIVE_TURN');
        }
        const pendingRequests = playerId ? await tx.gameRequest.findMany({
          where: { roomId, status: 'PENDING', OR: [{ actorPlayerId: playerId }, { targetPlayerId: playerId }] },
          select: { id: true },
        }) : [];
        if (pendingRequests.length) fail('MEMBER_HAS_PENDING_REQUEST');
        if (room.status === 'PLAYING' && member.isBank) {
          const bankCount = await tx.roomMembership.count({ where: { roomId, status: 'ACTIVE', isBank: true } });
          if (bankCount === 1) fail('BANK_REPLACEMENT_REQUIRED');
        }
        const ownedProperties = playerId ? await tx.roomProperty.findMany({ where: { roomId, ownerPlayerId: playerId } }) : [];
        const openDebtCount = playerId ? await tx.debtRecord.count({ where: {
          roomId,
          status: { in: ['OPEN', 'PARTIALLY_PAID'] },
          outstandingAmount: { gt: 0 },
          OR: [{ debtorPlayerId: playerId }, { creditorPlayerId: playerId }],
        } }) : 0;
        if (openDebtCount) fail('MEMBER_HAS_OPEN_DEBT');
        if (room.status === 'PLAYING') {
          if (member.player?.status === 'ACTIVE' && member.characterId) fail('MEMBER_ACTIVE_IN_PLAY');
          if (ownedProperties.length) fail('MEMBER_HAS_ASSETS');
        } else if (ownedProperties.some((property) => property.buildingLevel !== 0 || property.mortgaged)) {
          fail('MEMBER_HAS_ASSETS');
        }
        const at = new Date();
        removedSessionId = member.activeSessionId;
        await tx.roleSwapRequest.updateMany({
          where: { roomId, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] }, OR: [{ requesterMembershipId: memberId }, { targetMembershipId: memberId }] },
          data: { status: 'CANCELLED', rejectionReason: 'ADMIN_MEMBER_REMOVED', resolvedAt: at },
        });
        if (room.status === 'LOBBY' && playerId && ownedProperties.length) {
          await tx.roomProperty.updateMany({ where: { roomId, ownerPlayerId: playerId }, data: { ownerPlayerId: null, version: { increment: 1 } } });
        }
        if (member.player) await tx.player.update({ where: { id: member.player.id }, data: { status: 'LEFT', characterId: null } });
        const updated = await tx.roomMembership.update({ where: { id: memberId }, data: { status: 'LEFT', characterId: null, isBank: false, activeSessionId: null, controlClaimedAt: null, leftAt: at } });
        await tx.auditLog.create({ data: { roomId, actorRole: 'ADMIN', action: 'ADMIN_MEMBER_REMOVED', entityType: 'RoomMembership', entityId: memberId, beforeJson: { status: member.status, characterId: member.characterId, isBank: member.isBank }, afterJson: { status: 'LEFT', characterId: null, isBank: false }, reason: 'ADMIN_MEMBER_REMOVED', createdAt: at } });
        await tx.securityLog.create({ data: { accountId: member.accountId, actorAccountId: auth.account.id, action: 'ADMIN_MEMBER_REMOVED', detailsJson: { roomId, membershipId: memberId }, createdAt: at } });
        return { value: { id: updated.id, roomId, accountId: updated.accountId, status: updated.status, characterId: null, isBank: false, controllerActive: false, leftAt: updated.leftAt } };
      },
    });
    if (result.created && removedSessionId) afterCommit?.({ removedSessionId });
    return result.value;
  }

  async reassignAdminRoomBank(
    auth: AuthenticatedSession,
    roomId: string,
    targetMembershipId: string,
    key: string,
    afterCommit?: (event: { removedSessionId: string }) => void,
  ) {
    let removedSessionId: string | null = null;
    const result = await this.executeAdminWrite({
      auth,
      operation: 'room:bank:reassign',
      resourceId: roomId,
      roomId,
      key,
      input: { targetMembershipId },
      retrySerialization: false,
      lock: (tx) => this.lockRoom(tx, roomId),
      authorize: async (tx) => {
        const room = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
        if (['ENDED', 'FINISHED', 'CLOSED'].includes(room.status)) fail('ROOM_TERMINAL');
        const target = required(await tx.roomMembership.findFirst({ where: { id: targetMembershipId, roomId } }), 'MEMBERSHIP_NOT_FOUND');
        if (target.status !== 'ACTIVE') fail('MEMBERSHIP_NOT_ACTIVE');
      },
      mutate: async (tx) => {
        const banks = await tx.roomMembership.findMany({ where: { roomId, status: 'ACTIVE', isBank: true }, orderBy: { id: 'asc' }, take: 2 });
        if (banks.length > 1) fail('BANK_STATE_INVALID');
        const current = banks[0] ?? null;
        const target = required(await tx.roomMembership.findFirst({ where: { id: targetMembershipId, roomId, status: 'ACTIVE' } }), 'MEMBERSHIP_NOT_FOUND');
        if (current?.id === target.id) {
          return { value: { roomId, previousBankMembershipId: current.id, bankMembershipId: target.id, changed: false }, mutationCreated: false };
        }
        removedSessionId = current?.activeSessionId ?? null;
        if (current) await tx.roomMembership.update({ where: { id: current.id }, data: { isBank: false } });
        await tx.roomMembership.update({ where: { id: target.id }, data: { isBank: true } });
        const at = new Date();
        await tx.auditLog.create({ data: { roomId, actorRole: 'ADMIN', action: 'ADMIN_BANK_REASSIGNED', entityType: 'RoomMembership', entityId: target.id, beforeJson: { bankMembershipId: current?.id ?? null }, afterJson: { bankMembershipId: target.id }, createdAt: at } });
        await tx.securityLog.create({ data: { accountId: target.accountId, actorAccountId: auth.account.id, action: 'ADMIN_BANK_REASSIGNED', detailsJson: { roomId, previousBankMembershipId: current?.id ?? null, bankMembershipId: target.id }, createdAt: at } });
        return { value: { roomId, previousBankMembershipId: current?.id ?? null, bankMembershipId: target.id, changed: true } };
      },
    });
    if (result.created && result.value.changed && removedSessionId) afterCommit?.({ removedSessionId });
    return result.value;
  }

  async createRoom(auth: AuthenticatedSession, input: { name: string; password?: string; initialBalance: number; diceMode: 'ELECTRONIC' | 'PHYSICAL'; skillEnabled: boolean; startReward: number; allowMidgameJoin: boolean; visibility: 'PUBLIC' | 'PRIVATE'; transferApprovalRequired: boolean }, key: string) {
    if (!auth.account.canCreateRoom) fail('ROOM_CREATE_FORBIDDEN');
    const passwordHash = input.password ? await hashPassword(input.password) : null;
    return this.executeIdempotent(`account:${auth.account.id}:rooms:create`, key, input, async (tx) => {
      const definitions = await tx.propertyDefinition.findMany({ where: { enabled: true } });
      if (definitions.length !== 26) fail('MASTER_DATA_NOT_SEEDED');
      const room = await tx.room.create({ data: {
        code: randomBytes(4).toString('hex').toUpperCase(), name: input.name, status: 'LOBBY', ruleProfile: 'CUSTOM', difficulty: 'CUSTOM', participantCount: 5, playerLimit: 5,
        bankMode: 'DEDICATED_MODERATOR', characterAssignmentMode: 'PLAYER_SELECT', initialBalance: input.initialBalance, diceMode: input.diceMode, skillEnabled: input.skillEnabled,
        storyMoneyCounterpartyMode: 'TREASURY', transferApprovalRequired: input.transferApprovalRequired, startReward: input.startReward,
        victoryMode: 'LAST_SOLVENT', createdBy: auth.account.username, createdByAccountId: auth.account.id, passwordHash, visibility: input.visibility,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), allowMidgameJoin: input.allowMidgameJoin,
      } });
      await tx.roomProperty.createMany({ data: definitions.map((definition) => ({ roomId: room.id, propertyDefinitionId: definition.id })) });
      await tx.securityLog.create({ data: { accountId: auth.account.id, actorAccountId: auth.account.id, action: 'ROOM_CREATED', detailsJson: { roomId: room.id } } });
      return roomCreationSummary(room);
    });
  }

  async joinRoom(auth: AuthenticatedSession, roomId: string, password: string | undefined, key: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    const scope = `account:${auth.account.id}:room:${roomId}:join`;
    const canonicalRequest = JSON.stringify(canonicalValue({ roomId, password }));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await this.db.$transaction(async (tx) => {
          await this.lockRoom(tx, roomId);
          const room = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
          const current = await tx.roomMembership.findUnique({ where: { roomId_accountId: { roomId, accountId: auth.account.id } } });
          const previous = await tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
          if (previous) {
            await this.assertRequestHash(previous.requestHash, canonicalRequest);
            return asObject(previous.response);
          }
          const persist = async (value: Record<string, unknown>) => {
            const stored = canonicalValue(value) as Record<string, unknown>;
            await tx.idempotencyRecord.create({ data: {
              scope,
              key,
              requestHash: await hashPassword(canonicalRequest),
              response: stored as Prisma.InputJsonObject,
            } });
            return stored;
          };
          if (current?.status === 'ACTIVE') return persist(membershipSummary(current, auth.session.id));

          const admissionError = this.admissionError(room);
          if (admissionError) return persist({ ok: false, error: admissionError });
          const recentFailures = await tx.securityLog.count({ where: {
            accountId: auth.account.id,
            action: 'ROOM_PASSWORD_FAILED',
            createdAt: { gt: new Date(Date.now() - 10 * 60 * 1000) },
            detailsJson: { path: ['roomId'], equals: roomId },
          } });
          if (recentFailures >= 5) return persist({ ok: false, error: 'RATE_LIMITED' });
          if (room.passwordHash && (!password || !(await verifyPassword(password, room.passwordHash)))) {
            await tx.securityLog.create({ data: { accountId: auth.account.id, action: 'ROOM_PASSWORD_FAILED', detailsJson: { roomId } } });
            return persist({ ok: false, error: 'ROOM_PASSWORD_INVALID' });
          }

          if (current?.isBank) {
            const activeBank = await tx.roomMembership.findFirst({ where: { roomId, status: 'ACTIVE', isBank: true, id: { not: current.id } }, select: { id: true } });
            if (activeBank) return persist({ ok: false, error: 'BANK_ALREADY_TAKEN' });
          }
          const membership = current
            ? await tx.roomMembership.update({ where: { id: current.id }, data: {
              status: 'ACTIVE',
              leftAt: null,
              displayNameSnapshot: auth.account.displayName,
              activeSessionId: auth.session.id,
              controlClaimedAt: new Date(),
            } })
            : await tx.roomMembership.create({ data: {
              roomId,
              accountId: auth.account.id,
              displayNameSnapshot: auth.account.displayName,
              activeSessionId: auth.session.id,
              controlClaimedAt: new Date(),
            } });
          await tx.securityLog.create({ data: { accountId: auth.account.id, action: 'ROOM_JOINED', detailsJson: { roomId } } });
          const state = await tx.room.update({ where: { id: roomId }, data: { stateVersion: { increment: 1 } }, select: { stateVersion: true } });
          return persist({ ...membershipSummary(membership, auth.session.id), stateVersion: state.stateVersion });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
        if (response.ok === false && typeof response.error === 'string') fail(response.error);
        return response;
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 5) continue;
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          for (let replayAttempt = 0; replayAttempt < 5; replayAttempt += 1) {
            const previous = await this.db.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
            if (previous) {
              await this.assertRequestHash(previous.requestHash, canonicalRequest);
              const replay = asObject(previous.response);
              if (replay.ok === false && typeof replay.error === 'string') fail(replay.error);
              return replay;
            }
            if (replayAttempt < 4) await new Promise((resolve) => setTimeout(resolve, 10 * (replayAttempt + 1)));
          }
          fail('TRANSACTION_CONFLICT');
        }
        throw error;
      }
    }
    return fail('TRANSACTION_RETRY_EXHAUSTED');
  }

  async seats(auth: AuthenticatedSession, roomId: string) {
    const room = required(await this.db.room.findUnique({ where: { id: roomId }, include: { members: { where: { status: 'ACTIVE' }, include: { player: true } } } }), 'ROOM_NOT_FOUND');
    const characters = await this.db.character.findMany({ where: { enabled: true }, include: { initialProperty: true }, orderBy: { name: 'asc' } });
    const memberships = new Map(room.members.filter((member) => member.characterId).map((member) => [member.characterId, member]));
    const mine = room.members.find((member) => member.accountId === auth.account.id);
    const relevantSwapWhere: Prisma.RoleSwapRequestWhereInput | undefined = mine
      ? mine.isBank
        ? { roomId }
        : { roomId, OR: [{ requesterMembershipId: mine.id }, { targetMembershipId: mine.id }] }
      : undefined;
    const roleSwapRequests = relevantSwapWhere ? (await Promise.all([
      this.db.roleSwapRequest.findMany({
        where: { ...relevantSwapWhere, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } },
        include: {
          requester: { select: { displayNameSnapshot: true } },
          target: { select: { displayNameSnapshot: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.db.roleSwapRequest.findMany({
        where: { ...relevantSwapWhere, status: { notIn: ['PENDING_TARGET', 'PENDING_BANK'] } },
        include: {
          requester: { select: { displayNameSnapshot: true } },
          target: { select: { displayNameSnapshot: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
    ])).flat().sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)) : [];
    const canMutate = mine?.activeSessionId === auth.session.id
      && !['ENDED', 'FINISHED', 'CLOSED'].includes(room.status);
    return {
      stateVersion: room.stateVersion,
      room: { id: room.id, name: room.name, status: room.status, skillEnabled: room.skillEnabled },
      membership: mine ? { id: mine.id, characterId: mine.characterId, isBank: mine.isBank, playerId: mine.player?.id ?? null, activeHere: mine.activeSessionId === auth.session.id } : null,
      characters: characters.map((character) => {
        const occupiedBy = memberships.get(character.id);
        return { id: character.id, name: character.name, skill: character.skillConfig, initialProperty: character.initialProperty.name, occupiedBy: occupiedBy?.displayNameSnapshot ?? null, canSelect: !occupiedBy };
      }),
      bank: { occupiedBy: room.members.find((member) => member.isBank)?.displayNameSnapshot ?? null },
      roleSwapRequests: roleSwapRequests.map((request) => ({
        ...roleSwapSummary(request),
        requesterDisplayName: request.requester.displayNameSnapshot,
        targetDisplayName: request.target.displayNameSnapshot,
        actions: {
          canAccept: canMutate && request.targetMembershipId === mine?.id && request.status === 'PENDING_TARGET',
          canReject: canMutate && request.targetMembershipId === mine?.id && request.status === 'PENDING_TARGET',
          canCancel: canMutate && request.requesterMembershipId === mine?.id && ['PENDING_TARGET', 'PENDING_BANK'].includes(request.status),
          canApproveBank: canMutate && Boolean(mine?.isBank) && request.status === 'PENDING_BANK',
        },
      })),
    };
  }

  private async ensureMembership(tx: Prisma.TransactionClient, auth: AuthenticatedSession, roomId: string, requireControl = false) {
    await this.ensureActiveSession(tx, auth);
    const membership = required(await tx.roomMembership.findUnique({ where: { roomId_accountId: { roomId, accountId: auth.account.id } }, include: { player: true, room: true } }), 'ROOM_MEMBERSHIP_REQUIRED');
    if (membership.status === 'LEFT') fail('ROOM_MEMBERSHIP_REMOVED');
    if (membership.status !== 'ACTIVE') fail('ROOM_MEMBERSHIP_REQUIRED');
    if (membership.room.status === 'ENDED' || membership.room.status === 'FINISHED' || membership.room.status === 'CLOSED') fail('ROOM_FINISHED');
    if (requireControl && membership.activeSessionId !== auth.session.id) fail('ROOM_CONTROL_LOST');
    return membership;
  }

  private async ensureActiveSession(tx: Prisma.TransactionClient, auth: AuthenticatedSession) {
    const session = await tx.accountSession.findFirst({ where: { id: auth.session.id, accountId: auth.account.id }, include: { account: { select: { status: true } } } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.account.status !== 'ACTIVE') fail('SESSION_INVALID');
  }

  async selectCharacter(auth: AuthenticatedSession, roomId: string, characterId: string, key: string) {
    let mutationCreated = false;
    try {
      return await this.executeIdempotent(`account:${auth.account.id}:room:${roomId}:select-character`, key, { roomId, characterId }, async (tx) => {
        mutationCreated = false;
        await this.lockRoom(tx, roomId);
        const membership = await this.ensureMembership(tx, auth, roomId, true);
        this.requireSeatAcquisitionAllowed(membership, membership.player !== null);
        const character = required(await tx.character.findUnique({ where: { id: characterId }, include: { initialProperty: true } }), 'UNKNOWN_CHARACTER');
        if (!character.enabled) fail('UNKNOWN_CHARACTER');
        if (membership.characterId === characterId && membership.player) return { ...membershipSummary(membership, auth.session.id), player: playerSummary(membership.player) };
        if (membership.characterId) fail('ACCOUNT_CHARACTER_LIMIT_REACHED');
        const occupied = await tx.roomMembership.findFirst({ where: { roomId, characterId, status: 'ACTIVE', id: { not: membership.id } }, select: { id: true } });
        if (occupied) fail('ROLE_ALREADY_TAKEN');
        const playablePlayers = await this.playablePlayers(tx, roomId);
        if (!membership.player && playablePlayers.length >= membership.room.playerLimit) fail('PLAYER_LIMIT');
        const allocation = this.allocatePlayerSeat(membership.room.playerLimit, playablePlayers, membership.player ?? undefined);
        const creatingPlayer = membership.player === null;
        const startsInLobby = membership.room.status === 'LOBBY';
        await tx.roomMembership.update({ where: { id: membership.id }, data: { characterId } });
        let player = membership.player;
        if (player) {
          player = await tx.player.update({ where: { id: player.id }, data: { characterId, ...allocation } });
        } else {
          player = await tx.player.create({ data: {
            roomId,
            memberId: membership.id,
            characterId,
            ...allocation,
            balance: startsInLobby ? membership.room.initialBalance : 0,
          } });
        }
        if (creatingPlayer && startsInLobby && membership.room.initialBalance > 0) {
          const effects = [{ playerId: player.id, amount: membership.room.initialBalance, before: 0, after: membership.room.initialBalance, type: 'INITIAL_BALANCE', description: '初始资金' }];
          const transaction = await tx.gameTransaction.create({ data: { roomId, type: 'INITIAL_BALANCE', reversible: false, metadata: { effects } } });
          await tx.ledgerEntry.create({ data: { roomId, transactionId: transaction.id, playerId: player.id, amount: membership.room.initialBalance, balanceBefore: 0, balanceAfter: membership.room.initialBalance, type: 'INITIAL_BALANCE', description: '初始资金', createdBy: membership.id } });
        }
        if (creatingPlayer && startsInLobby) await tx.roomProperty.updateMany({ where: { roomId, propertyDefinitionId: character.initialPropertyId, ownerPlayerId: null }, data: { ownerPlayerId: player.id, version: { increment: 1 } } });
        await tx.securityLog.create({ data: { accountId: auth.account.id, action: 'CHARACTER_SELECTED', detailsJson: { roomId, characterId, characterNameSnapshot: character.name } } });
        mutationCreated = true;
        return { ...membershipSummary(membership, auth.session.id), characterId, player: playerSummary(player) };
      }, undefined, () => mutationCreated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') fail('ROLE_ALREADY_TAKEN');
      throw error;
    }
  }

  async selectBank(auth: AuthenticatedSession, roomId: string, key: string) {
    let mutationCreated = false;
    await this.db.$transaction(async (tx) => {
      const membership = await this.ensureMembership(tx, auth, roomId, true);
      this.requireSeatAcquisitionAllowed(membership, membership.isBank);
    });
    try {
      return await this.executeIdempotent(`account:${auth.account.id}:room:${roomId}:select-bank`, key, { roomId }, async (tx) => {
        mutationCreated = false;
        await this.lockRoom(tx, roomId);
        const membership = await this.ensureMembership(tx, auth, roomId, true);
        this.requireSeatAcquisitionAllowed(membership, membership.isBank);
        if (membership.isBank) return membershipSummary(membership, auth.session.id);
        const occupied = await tx.roomMembership.findFirst({ where: { roomId, isBank: true, status: 'ACTIVE', id: { not: membership.id } }, select: { id: true } });
        if (occupied) fail('BANK_ALREADY_TAKEN');
        const updated = await tx.roomMembership.update({ where: { id: membership.id }, data: { isBank: true } });
        await tx.securityLog.create({ data: { accountId: auth.account.id, action: 'BANK_SELECTED', detailsJson: { roomId } } });
        mutationCreated = true;
        return membershipSummary(updated, auth.session.id);
      }, undefined, () => mutationCreated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') fail('BANK_ALREADY_TAKEN');
      throw error;
    }
  }

  async takeControl(
    auth: AuthenticatedSession,
    roomId: string,
    key: string,
    afterCommit?: (event: { displacedSessionId: string }) => void,
  ) {
    let displacedSessionId: string | null = null;
    let mutationCreated = false;
    return this.executeIdempotent(`account:${auth.account.id}:room:${roomId}:take-control`, key, { roomId, sessionId: auth.session.id }, async (tx) => {
      displacedSessionId = null;
      mutationCreated = false;
      await this.lockRoom(tx, roomId);
      const membership = await this.ensureMembership(tx, auth, roomId);
      const updated = membership.activeSessionId === auth.session.id
        ? membership
        : await tx.roomMembership.update({ where: { id: membership.id }, data: { activeSessionId: auth.session.id, controlClaimedAt: new Date() } });
      if (membership.activeSessionId !== auth.session.id) {
        displacedSessionId = membership.activeSessionId;
        mutationCreated = true;
        await tx.securityLog.create({ data: { accountId: auth.account.id, action: 'ROOM_CONTROL_TAKEN', detailsJson: { roomId } } });
      }
      return { membership: membershipSummary(updated, auth.session.id) };
    }, () => {
      if (displacedSessionId) afterCommit?.({ displacedSessionId });
    }, () => mutationCreated);
  }

  async authorizeRoomSession(auth: AuthenticatedSession, roomId: string, expectedRole?: 'PLAYER' | 'BANK') {
    const membership = required(await this.db.roomMembership.findUnique({ where: { roomId_accountId: { roomId, accountId: auth.account.id } }, include: { player: true, room: true } }), 'ROOM_MEMBERSHIP_REQUIRED');
    if (membership.status !== 'ACTIVE') fail('ROOM_MEMBERSHIP_REQUIRED');
    if (membership.activeSessionId !== auth.session.id) fail('ROOM_CONTROL_LOST');
    if (expectedRole === 'BANK' && !membership.isBank) fail('BANK_REQUIRED');
    if (expectedRole === 'PLAYER' && (!membership.characterId || !membership.player)) fail('PLAYER_IDENTITY_MISMATCH');
    if (membership.room.status === 'FINISHED' || membership.room.status === 'CLOSED') fail('ROOM_FINISHED');
    return membership;
  }

  private async executeControlledIdempotent<T extends Record<string, unknown>>(
    auth: AuthenticatedSession,
    target: ControlledRoomTarget,
    operation: string,
    key: string,
    input: unknown,
    capability: 'BANK' | undefined,
    work: (
      tx: Prisma.TransactionClient,
      membership: Awaited<ReturnType<AccountRoomService['ensureMembership']>>,
      roomId: string,
    ) => Promise<T>,
  ) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    const canonicalRequest = JSON.stringify(canonicalValue(input));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await this.db.$transaction(async (tx) => {
          await this.ensureActiveSession(tx, auth);
          const roomId = await this.controlledRoomId(tx, auth, target);
          await this.lockRoom(tx, roomId);
          const membership = await this.ensureMembership(tx, auth, roomId, true);
          if (capability === 'BANK' && !membership.isBank) fail('BANK_REQUIRED');
          const scope = `account:${auth.account.id}:room:${roomId}:role-swap:${operation}`;
          const previous = await tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
          if (previous) return this.replayRecord<T>(previous, canonicalRequest);
          const result = canonicalValue(await work(tx, membership, roomId)) as T;
          const room = await tx.room.update({ where: { id: roomId }, data: { stateVersion: { increment: 1 } }, select: { stateVersion: true } });
          const response = { ...result, stateVersion: room.stateVersion } as T;
          await tx.idempotencyRecord.create({ data: { scope, key, requestHash: await hashPassword(canonicalRequest), response: response as Prisma.InputJsonObject } });
          return response;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 5) continue;
        if (isSerializationConflict(error)) fail('TRANSACTION_RETRY_EXHAUSTED');
        return this.replayControlledConflict<T>(auth, target, operation, key, canonicalRequest, capability, error);
      }
    }
    return fail('TRANSACTION_RETRY_EXHAUSTED');
  }

  private async controlledRoomId(tx: Prisma.TransactionClient, auth: AuthenticatedSession, target: ControlledRoomTarget) {
    if ('roomId' in target) return target.roomId;
    const request = await tx.roleSwapRequest.findFirst({
      where: {
        id: target.requestId,
        room: { members: { some: { accountId: auth.account.id, status: 'ACTIVE' } } },
      },
      select: { roomId: true },
    });
    return required(request?.roomId, 'SWAP_REQUEST_NOT_FOUND');
  }

  private async replayControlledConflict<T extends Record<string, unknown>>(
    auth: AuthenticatedSession,
    target: ControlledRoomTarget,
    operation: string,
    key: string,
    canonicalRequest: string,
    capability: 'BANK' | undefined,
    error: unknown,
  ): Promise<T> {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const previous = await this.db.$transaction(async (tx) => {
            await this.ensureActiveSession(tx, auth);
            const roomId = await this.controlledRoomId(tx, auth, target);
            await this.lockRoom(tx, roomId);
            const membership = await this.ensureMembership(tx, auth, roomId, true);
            if (capability === 'BANK' && !membership.isBank) fail('BANK_REQUIRED');
            const scope = `account:${auth.account.id}:room:${roomId}:role-swap:${operation}`;
            return tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
          if (previous) return this.replayRecord<T>(previous, canonicalRequest);
          fail('TRANSACTION_CONFLICT');
        } catch (replayError) {
          if (isSerializationConflict(replayError) && attempt < 2) continue;
          if (replayError instanceof RuleError) throw replayError;
          if (replayError instanceof Prisma.PrismaClientKnownRequestError) fail('TRANSACTION_CONFLICT');
          throw replayError;
        }
      }
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) fail('TRANSACTION_CONFLICT');
    throw error;
  }

  async requestRoleSwap(auth: AuthenticatedSession, roomId: string, targetCharacterId: string, key: string) {
    return this.executeControlledIdempotent(auth, { roomId }, 'request', key, { roomId, targetCharacterId }, undefined, async (tx, requester) => {
      const target = required(await tx.roomMembership.findFirst({ where: { roomId, characterId: targetCharacterId, status: 'ACTIVE' } }), 'SWAP_TARGET_NOT_FOUND');
      if (target.id === requester.id) fail('SWAP_TARGET_NOT_FOUND');
      const open = await tx.roleSwapRequest.findFirst({ where: { roomId, requesterMembershipId: requester.id, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } } });
      if (open) fail('SWAP_REQUEST_PENDING');
      const created = await tx.roleSwapRequest.create({ data: { roomId, requesterMembershipId: requester.id, targetMembershipId: target.id, requesterCharacterId: requester.characterId, targetCharacterId } });
      await tx.auditLog.create({ data: { roomId, actorMemberId: requester.id, actorRole: 'PLAYER', action: 'ROLE_SWAP_REQUESTED', entityType: 'RoleSwapRequest', entityId: created.id, afterJson: { requesterCharacterId: requester.characterId, targetCharacterId } } });
      return roleSwapSummary(created);
    });
  }

  private async conflictRoleSwap(
    tx: Prisma.TransactionClient,
    request: Awaited<ReturnType<Prisma.TransactionClient['roleSwapRequest']['findUniqueOrThrow']>>,
    actorMemberId: string,
    actorRole: 'PLAYER' | 'BANK',
    reason: string,
  ) {
    if (request.status === 'CONFLICTED') return request;
    const updated = await tx.roleSwapRequest.update({ where: { id: request.id }, data: {
      status: 'CONFLICTED',
      rejectionReason: reason,
      resolvedAt: new Date(),
    } });
    await tx.auditLog.create({ data: {
      roomId: request.roomId,
      actorMemberId,
      actorRole,
      action: 'ROLE_SWAP_CONFLICTED',
      entityType: 'RoleSwapRequest',
      entityId: request.id,
      beforeJson: { status: request.status },
      afterJson: { status: 'CONFLICTED', reason },
    } });
    return updated;
  }

  private async executeSwap(tx: Prisma.TransactionClient, requestId: string, actorMemberId: string, actorRole: 'PLAYER' | 'BANK', bankApprovedById?: string) {
    const request = required(await tx.roleSwapRequest.findUnique({ where: { id: requestId }, include: { room: true } }), 'SWAP_REQUEST_NOT_FOUND');
    const requester = await tx.roomMembership.findUnique({ where: { id: request.requesterMembershipId }, include: { player: true } });
    const target = await tx.roomMembership.findUnique({ where: { id: request.targetMembershipId }, include: { player: true } });
    const characterDrift = !requester || !target
      || requester.status !== 'ACTIVE'
      || target.status !== 'ACTIVE'
      || requester.roomId !== request.roomId
      || target.roomId !== request.roomId
      || requester.characterId !== request.requesterCharacterId
      || target.characterId !== request.targetCharacterId
      || (requester.characterId !== null && requester.player?.characterId !== requester.characterId)
      || (requester.characterId === null && requester.player?.characterId !== null && requester.player !== null)
      || target.player?.characterId !== target.characterId;
    if (characterDrift || !requester || !target || !target.player) {
      return this.conflictRoleSwap(tx, request, actorMemberId, actorRole, 'CHARACTER_DRIFT');
    }
    if (request.room.status === 'PLAYING' && request.requesterCharacterId === null) {
      const targetActiveTurn = await tx.turn.findFirst({
        where: { roomId: request.roomId, playerId: target.player.id, status: 'ACTIVE' },
        select: { id: true },
      });
      if (request.room.currentTurnPlayerId === target.player.id || targetActiveTurn) {
        return this.conflictRoleSwap(tx, request, actorMemberId, actorRole, 'TARGET_HAS_ACTIVE_TURN');
      }
    }

    const before = { requesterCharacterId: requester.characterId, targetCharacterId: target.characterId };
    await tx.roomMembership.update({ where: { id: target.id }, data: { characterId: null } });
    if (target.player) await tx.player.update({ where: { id: target.player.id }, data: { characterId: null } });
    if (requester.characterId) {
      await tx.roomMembership.update({ where: { id: requester.id }, data: { characterId: null } });
      if (requester.player) await tx.player.update({ where: { id: requester.player.id }, data: { characterId: null } });
    }

    let requesterPlayer = requester.player;
    if (!requesterPlayer) {
      const initialBalance = request.room.status === 'LOBBY' ? request.room.initialBalance : 0;
      requesterPlayer = await tx.player.create({ data: {
        roomId: request.roomId,
        memberId: requester.id,
        characterId: null,
        pawnColor: target.player.pawnColor,
        turnOrder: target.player.turnOrder,
        balance: initialBalance,
      } });
      if (request.room.status === 'LOBBY' && initialBalance > 0) {
        const effects = [{ playerId: requesterPlayer.id, amount: initialBalance, before: 0, after: initialBalance, type: 'INITIAL_BALANCE', description: '初始资金' }];
        const transaction = await tx.gameTransaction.create({ data: { roomId: request.roomId, type: 'INITIAL_BALANCE', reversible: false, metadata: { effects } } });
        await tx.ledgerEntry.create({ data: { roomId: request.roomId, transactionId: transaction.id, playerId: requesterPlayer.id, amount: initialBalance, balanceBefore: 0, balanceAfter: initialBalance, type: 'INITIAL_BALANCE', description: '初始资金', createdBy: requester.id } });
      }
      if (request.room.status === 'LOBBY') {
        const character = required(await tx.character.findUnique({ where: { id: request.targetCharacterId } }), 'SWAP_CONFLICT');
        await tx.roomProperty.updateMany({ where: { roomId: request.roomId, propertyDefinitionId: character.initialPropertyId, ownerPlayerId: null }, data: { ownerPlayerId: requesterPlayer.id, version: { increment: 1 } } });
      }
    } else if (!request.requesterCharacterId) {
      const allocation = this.allocatePlayerSeat(
        request.room.playerLimit,
        await this.playablePlayers(tx, request.roomId),
        requesterPlayer,
      );
      requesterPlayer = await tx.player.update({ where: { id: requesterPlayer.id }, data: allocation });
    }

    await tx.roomMembership.update({ where: { id: requester.id }, data: { characterId: request.targetCharacterId } });
    await tx.player.update({ where: { id: requesterPlayer.id }, data: { characterId: request.targetCharacterId } });
    if (request.requesterCharacterId) {
      const targetPlayer = target.player ?? fail('SWAP_CONFLICT');
      await tx.roomMembership.update({ where: { id: target.id }, data: { characterId: request.requesterCharacterId } });
      await tx.player.update({ where: { id: targetPlayer.id }, data: { characterId: request.requesterCharacterId } });
    }
    const updated = await tx.roleSwapRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', bankApprovedById, resolvedAt: new Date() } });
    await tx.auditLog.create({ data: { roomId: request.roomId, actorMemberId, actorRole, action: 'ROLE_SWAP_EXECUTED', entityType: 'RoleSwapRequest', entityId: request.id, beforeJson: before, afterJson: { requesterCharacterId: request.targetCharacterId, targetCharacterId: request.requesterCharacterId } } });
    return updated;
  }

  async acceptRoleSwap(auth: AuthenticatedSession, requestId: string, key: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    return this.executeControlledIdempotent(auth, { requestId }, `accept:${requestId}`, key, { requestId, action: 'ACCEPT' }, undefined, async (tx, targetActor, roomId) => {
      const request = required(await tx.roleSwapRequest.findUnique({ where: { id: requestId }, include: { room: true } }), 'SWAP_REQUEST_NOT_FOUND');
      if (request.targetMembershipId !== targetActor.id || request.status !== 'PENDING_TARGET') fail('SWAP_REQUEST_NOT_PENDING');
      await tx.auditLog.create({ data: { roomId, actorMemberId: targetActor.id, actorRole: 'PLAYER', action: 'ROLE_SWAP_TARGET_ACCEPTED', entityType: 'RoleSwapRequest', entityId: request.id, beforeJson: { status: request.status }, afterJson: { status: request.room.status === 'PLAYING' ? 'PENDING_BANK' : 'APPROVED' } } });
      const updated = request.room.status === 'PLAYING'
        ? await tx.roleSwapRequest.update({ where: { id: request.id }, data: { status: 'PENDING_BANK' } })
        : await this.executeSwap(tx, request.id, targetActor.id, 'PLAYER');
      return roleSwapSummary(updated);
    });
  }

  async resolveRoleSwap(auth: AuthenticatedSession, requestId: string, action: 'REJECT' | 'CANCEL' | 'APPROVE_BANK', key: string, reason?: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    return this.executeControlledIdempotent(auth, { requestId }, `${action.toLowerCase()}:${requestId}`, key, { requestId, action, reason }, action === 'APPROVE_BANK' ? 'BANK' : undefined, async (tx, actor, roomId) => {
      const request = required(await tx.roleSwapRequest.findUnique({ where: { id: requestId } }), 'SWAP_REQUEST_NOT_FOUND');
      if (action === 'CANCEL') {
        if (request.requesterMembershipId !== actor.id || !['PENDING_TARGET', 'PENDING_BANK'].includes(request.status)) fail('SWAP_REQUEST_NOT_PENDING');
        const updated = await tx.roleSwapRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED', resolvedAt: new Date() } });
        await tx.auditLog.create({ data: { roomId, actorMemberId: actor.id, actorRole: 'PLAYER', action: 'ROLE_SWAP_CANCELLED', entityType: 'RoleSwapRequest', entityId: request.id, beforeJson: { status: request.status }, afterJson: { status: 'CANCELLED' } } });
        return roleSwapSummary(updated);
      }
      if (action === 'REJECT') {
        if (request.targetMembershipId !== actor.id || request.status !== 'PENDING_TARGET') fail('SWAP_REQUEST_NOT_PENDING');
        const updated = await tx.roleSwapRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', rejectionReason: reason, resolvedAt: new Date() } });
        await tx.auditLog.create({ data: { roomId, actorMemberId: actor.id, actorRole: 'PLAYER', action: 'ROLE_SWAP_TARGET_REJECTED', entityType: 'RoleSwapRequest', entityId: request.id, beforeJson: { status: request.status }, afterJson: { status: 'REJECTED' }, reason } });
        return roleSwapSummary(updated);
      }
      if (request.status !== 'PENDING_BANK') fail('SWAP_REQUEST_NOT_PENDING');
      await tx.auditLog.create({ data: { roomId, actorMemberId: actor.id, actorRole: 'BANK', action: 'ROLE_SWAP_BANK_CONFIRMED', entityType: 'RoleSwapRequest', entityId: request.id, beforeJson: { status: request.status }, afterJson: { status: 'APPROVED' } } });
      return roleSwapSummary(await this.executeSwap(tx, request.id, actor.id, 'BANK', actor.id));
    });
  }

  private async authorizeSettlement(
    tx: Prisma.TransactionClient,
    auth: AuthenticatedSession,
    roomId: string,
    access: SettlementAccess,
    requireBankControl: boolean,
  ) {
    await this.ensureActiveSession(tx, auth);
    const account = required(await tx.account.findUnique({ where: { id: auth.account.id } }), 'SESSION_INVALID');
    if (account.status !== 'ACTIVE') fail('SESSION_INVALID');
    if (access === 'ADMIN') {
      if (!this.isConfiguredSuperAdmin(account.username)) fail('ADMIN_REQUIRED');
      return null;
    }
    const membership = required(await tx.roomMembership.findUnique({
      where: { roomId_accountId: { roomId, accountId: auth.account.id } },
    }), 'ROOM_MEMBERSHIP_REQUIRED');
    if (requireBankControl) {
      if (membership.status !== 'ACTIVE') fail('ROOM_MEMBERSHIP_REQUIRED');
      if (membership.activeSessionId !== auth.session.id) fail('ROOM_CONTROL_LOST');
      if (!membership.isBank) fail('BANK_REQUIRED');
    }
    return membership;
  }

  private async settlementState(tx: Prisma.TransactionClient, roomId: string) {
    const room = required(await tx.room.findUnique({ where: { id: roomId } }), 'ROOM_NOT_FOUND');
    const settlement = await tx.gameSettlement.findUnique({ where: { roomId }, include: { players: { orderBy: [{ rank: 'asc' }, { accountId: 'asc' }] } } });
    return { room, settlement };
  }

  private assertPreviewLifecycle(status: string, hasSettlement: boolean, access: SettlementAccess) {
    if (status === 'FINISHED' && !hasSettlement) fail('SETTLEMENT_INCONSISTENT');
    if (status === 'FINISHED' || status === 'CLOSED') fail('ROOM_FINISHED');
    if (access === 'MEMBER' && status === 'LOBBY') fail('ROOM_NOT_PLAYING');
    if (access === 'MEMBER' && status === 'ENDED') fail('LEGACY_SETTLEMENT_UNAVAILABLE');
  }

  private settlementDto(settlement: {
    id: string;
    roomId: string;
    endedByAccountId: string;
    endedAt: Date;
    totalTurns: number;
    durationSeconds: number;
    forced: boolean;
    forceReason: string | null;
    winnersJson: Prisma.JsonValue;
    rankingJson: Prisma.JsonValue;
    overriddenBlockersJson: Prisma.JsonValue;
    players: Array<{
      accountId: string;
      displayNameSnapshot: string;
      characterNameSnapshot: string | null;
      cash: number;
      unmortgagedPropertyValue: number;
      mortgagedPropertyNetValue: number;
      buildingSellValue: number;
      totalWealth: number;
      rank: number;
      isWinner: boolean;
      propertyDetailsJson: Prisma.JsonValue;
    }>;
  }) {
    const winners = settlementWinnersSchema.safeParse(settlement.winnersJson);
    const ranking = settlementRankingSchema.safeParse(settlement.rankingJson);
    const overriddenBlockers = settlementBlockersSchema.safeParse(settlement.overriddenBlockersJson);
    if (!winners.success || !ranking.success || !overriddenBlockers.success) fail('SETTLEMENT_INCONSISTENT');
    return {
      id: settlement.id,
      roomId: settlement.roomId,
      endedByAccountId: settlement.endedByAccountId,
      endedAt: settlement.endedAt.toISOString(),
      totalTurns: settlement.totalTurns,
      durationSeconds: settlement.durationSeconds,
      forced: settlement.forced,
      forceReason: settlement.forceReason,
      winners: winners.data,
      ranking: ranking.data,
      overriddenBlockers: overriddenBlockers.data,
      players: settlement.players.map((player) => {
        const propertyDetails = propertySettlementDetailsSchema.safeParse(player.propertyDetailsJson);
        if (!propertyDetails.success) fail('SETTLEMENT_INCONSISTENT');
        return {
          accountId: player.accountId,
          displayNameSnapshot: player.displayNameSnapshot,
          characterNameSnapshot: player.characterNameSnapshot,
          cash: player.cash,
          unmortgagedPropertyValue: player.unmortgagedPropertyValue,
          mortgagedPropertyNetValue: player.mortgagedPropertyNetValue,
          buildingSellValue: player.buildingSellValue,
          totalWealth: player.totalWealth,
          rank: player.rank,
          isWinner: player.isWinner,
          propertyDetails: propertyDetails.data,
        };
      }),
    };
  }

  private async computeSettlement(tx: Prisma.TransactionClient, roomId: string) {
    const [members, requests, properties, swaps, debts, landings, turns] = await Promise.all([
      tx.roomMembership.findMany({
        where: { roomId, status: 'ACTIVE', characterId: { not: null } },
        include: { character: true, player: { include: { ownedProperties: { include: { definition: true }, orderBy: { id: 'asc' } } } } },
        orderBy: { accountId: 'asc' },
      }),
      tx.gameRequest.findMany({ where: { roomId, status: 'PENDING' }, select: { id: true, type: true, payload: true }, orderBy: { id: 'asc' } }),
      tx.roomProperty.findMany({ where: { roomId, lockedByRequestId: { not: null } }, select: { id: true, lockedByRequestId: true }, orderBy: { id: 'asc' } }),
      tx.roleSwapRequest.findMany({ where: { roomId, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } }, select: { id: true, status: true }, orderBy: { id: 'asc' } }),
      tx.debtRecord.findMany({ where: { roomId, status: { in: ['OPEN', 'PARTIALLY_PAID'] }, outstandingAmount: { gt: 0 } }, select: { id: true, outstandingAmount: true }, orderBy: { id: 'asc' } }),
      tx.landingEvent.findMany({ where: { roomId, status: { in: ['DECLARED', 'CONFIRMED'] }, plotResolved: false, propertyActionsCancelled: false }, select: { id: true, status: true }, orderBy: { id: 'asc' } }),
      tx.turn.findMany({ where: { roomId, status: 'ACTIVE' }, include: { landingEvents: { select: { id: true } }, requests: { where: { status: 'PENDING' }, select: { id: true } } }, orderBy: { id: 'asc' } }),
    ]);

    const blockers: SettlementBlocker[] = [];
    for (const request of requests) {
      blockers.push(request.type === 'TRADE_PROPERTY'
        ? { code: 'INCOMPLETE_PROPERTY_TRADE', requestId: request.id, buyerConfirmed: asObject(request.payload ?? {}).buyerConfirmed === true }
        : { code: 'PENDING_GAME_REQUEST', requestId: request.id, requestType: request.type });
    }
    blockers.push(...properties.map((property) => ({ code: 'PROPERTY_ACTION_LOCKED' as const, roomPropertyId: property.id, requestId: property.lockedByRequestId! })));
    blockers.push(...swaps.map((swap) => ({ code: 'PENDING_ROLE_SWAP' as const, roleSwapRequestId: swap.id, status: swap.status })));
    blockers.push(...debts.map((debt) => ({ code: 'OPEN_DEBT' as const, debtId: debt.id, outstandingAmount: debt.outstandingAmount })));
    blockers.push(...landings.map((landing) => ({ code: 'UNRESOLVED_LANDING' as const, landingEventId: landing.id, status: landing.status })));
    blockers.push(...turns.flatMap((turn) => isPristineSettlementTurn({
      die1: turn.die1,
      die2: turn.die2,
      diceValue: turn.diceValue,
      rolledAt: turn.rolledAt,
      landingCount: turn.landingEvents.length,
      pendingRequestCount: turn.requests.length,
    }) ? [] : [{ code: 'ACTIVE_TURN' as const, turnId: turn.id, playerId: turn.playerId }]));

    const candidates: SettlementCandidate[] = [];
    for (const member of members) {
      if (!member.characterId || !member.player || member.player.roomId !== roomId || member.player.status !== 'ACTIVE' || member.player.characterId !== member.characterId) {
        blockers.push({ code: 'SETTLEMENT_DATA_INVALID', membershipId: member.id, playerId: member.player?.id ?? null });
        continue;
      }
      if (member.player.balance < 0) {
        blockers.push({ code: 'INVALID_PLAYER_BALANCE', playerId: member.player.id, balance: member.player.balance });
      }
      const propertyDetails = member.player.ownedProperties.map((property) => buildPropertySettlementDetail({
        id: property.id,
        name: property.definition.name,
        mortgaged: property.mortgaged,
        mortgagePrice: property.definition.mortgagePrice,
        purchasePrice: property.definition.purchasePrice,
        buildingLevel: property.buildingLevel,
        buildingSellPrice: property.definition.buildingSellPrice,
      }));
      candidates.push({
        accountId: member.accountId,
        displayNameSnapshot: member.displayNameSnapshot,
        characterNameSnapshot: member.character?.name ?? null,
        cash: member.player.balance,
        unmortgagedPropertyValue: propertyDetails.filter((property) => !property.mortgaged).reduce((sum, property) => sum + property.landSettlementValue, 0),
        mortgagedPropertyNetValue: propertyDetails.filter((property) => property.mortgaged).reduce((sum, property) => sum + property.landSettlementValue, 0),
        buildingSellValue: propertyDetails.reduce((sum, property) => sum + property.buildingSellValue, 0),
        propertyDetails,
      });
    }
    return { blockers, players: rankSettlementPlayers(candidates) };
  }

  async previewSettlement(auth: AuthenticatedSession, roomId: string, access: SettlementAccess = 'MEMBER') {
    return this.serializable(async (tx) => {
      await this.lockRoom(tx, roomId);
      await this.authorizeSettlement(tx, auth, roomId, access, access === 'MEMBER');
      const state = await this.settlementState(tx, roomId);
      this.assertPreviewLifecycle(state.room.status, Boolean(state.settlement), access);
      return { ...(await this.computeSettlement(tx, roomId)), stateVersion: state.room.stateVersion };
    });
  }

  async finishRoom(auth: AuthenticatedSession, roomId: string, input: FinishSettlementInput, key: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    if (input.mode === 'NORMAL' && input.confirmation !== '确认结束游戏') fail('FINISH_CONFIRMATION_REQUIRED');
    const normalizedReason = input.mode === 'FORCED' ? input.reason.trim() : undefined;
    if (input.mode === 'FORCED' && !normalizedReason) fail('REASON_REQUIRED');
    const canonicalRequest = JSON.stringify(canonicalValue({
      roomId,
      mode: input.mode,
      ...(input.mode === 'NORMAL' ? { confirmation: input.confirmation } : { reason: normalizedReason }),
    }));
    const scope = `account:${auth.account.id}:room:${roomId}:settlement:finish`;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await this.db.$transaction(async (tx) => {
          await this.lockRoom(tx, roomId);
          const access: SettlementAccess = input.mode === 'FORCED' ? 'ADMIN' : 'MEMBER';
          const membership = await this.authorizeSettlement(tx, auth, roomId, access, input.mode === 'NORMAL');
          const state = await this.settlementState(tx, roomId);
          if (state.room.status === 'FINISHED' && !state.settlement) fail('SETTLEMENT_INCONSISTENT');
          if (state.room.status === 'CLOSED') fail('ROOM_FINISHED');
          if (input.mode === 'NORMAL' && state.room.status === 'LOBBY') fail('ROOM_NOT_PLAYING');
          if (input.mode === 'NORMAL' && state.room.status === 'ENDED') fail('LEGACY_SETTLEMENT_UNAVAILABLE');
          const previous = await tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
          if (previous) {
            await this.assertRequestHash(previous.requestHash, canonicalRequest);
            return { created: false, settlement: asObject(previous.response) };
          }
          if (state.room.status === 'FINISHED') fail('ROOM_FINISHED');
          if (!['LOBBY', 'PLAYING', 'ENDED'].includes(state.room.status)) fail('ROOM_FINISHED');

          const computed = await this.computeSettlement(tx, roomId);
          if (input.mode === 'NORMAL' && !computed.players.length) fail('SETTLEMENT_DATA_INVALID');
          if (input.mode === 'NORMAL' && computed.blockers.length) fail('SETTLEMENT_BLOCKED');
          const endedAt = new Date();
          if (input.mode === 'FORCED') {
            await tx.gameRequest.updateMany({ where: { roomId, status: 'PENDING' }, data: { status: 'CANCELLED', rejectionReason: 'FORCED_ROOM_FINISH', resolvedAt: endedAt } });
            await tx.roomProperty.updateMany({ where: { roomId, lockedByRequestId: { not: null } }, data: { lockedByRequestId: null, version: { increment: 1 } } });
            await tx.roleSwapRequest.updateMany({ where: { roomId, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } }, data: { status: 'CANCELLED', rejectionReason: 'FORCED_ROOM_FINISH', resolvedAt: endedAt } });
            await tx.landingEvent.updateMany({ where: { roomId, status: { in: ['DECLARED', 'CONFIRMED'] }, plotResolved: false, propertyActionsCancelled: false }, data: { status: 'INVALIDATED', invalidatedAt: endedAt, propertyActionsCancelled: true } });
          }
          await tx.turn.updateMany({ where: { roomId, status: 'ACTIVE' }, data: { status: 'ENDED', endedAt } });
          const aggregate = await tx.turn.aggregate({ where: { roomId }, _max: { turnNumber: true } });
          const overriddenBlockers = input.mode === 'FORCED' ? computed.blockers : [];
          const settlement = await tx.gameSettlement.create({ data: {
            roomId,
            endedByAccountId: auth.account.id,
            endedAt,
            totalTurns: aggregate._max.turnNumber ?? 0,
            durationSeconds: Math.max(0, Math.floor((endedAt.getTime() - (state.room.startedAt ?? state.room.createdAt).getTime()) / 1000)),
            forced: input.mode === 'FORCED',
            forceReason: normalizedReason,
            winnersJson: computed.players.filter((player) => player.isWinner).map((player) => player.accountId),
            rankingJson: computed.players.map((player) => ({ accountId: player.accountId, rank: player.rank })),
            overriddenBlockersJson: overriddenBlockers as Prisma.InputJsonValue,
            players: { create: computed.players.map((player: RankedSettlementPlayer) => ({
              accountId: player.accountId,
              displayNameSnapshot: player.displayNameSnapshot,
              characterNameSnapshot: player.characterNameSnapshot,
              cash: player.cash,
              unmortgagedPropertyValue: player.unmortgagedPropertyValue,
              mortgagedPropertyNetValue: player.mortgagedPropertyNetValue,
              buildingSellValue: player.buildingSellValue,
              totalWealth: player.totalWealth,
              rank: player.rank,
              isWinner: player.isWinner,
              propertyDetailsJson: player.propertyDetails as Prisma.InputJsonValue,
            })) },
          }, include: { players: { orderBy: [{ rank: 'asc' }, { accountId: 'asc' }] } } });
          const updatedRoom = await tx.room.update({ where: { id: roomId }, data: { status: 'FINISHED', currentTurnPlayerId: null, turnNumber: null, stateVersion: { increment: 1 } }, select: { stateVersion: true } });
          const action = input.mode === 'FORCED' ? 'ROOM_FORCE_FINISHED' : 'ROOM_FINISHED';
          await tx.auditLog.create({ data: {
            roomId,
            actorMemberId: input.mode === 'NORMAL' ? membership!.id : null,
            actorRole: input.mode === 'NORMAL' ? 'BANK' : 'ADMIN',
            action,
            entityType: 'GameSettlement',
            entityId: settlement.id,
            reason: normalizedReason,
            afterJson: { settlementId: settlement.id, forceReason: normalizedReason, overriddenBlockers },
            createdAt: endedAt,
          } });
          await tx.securityLog.create({ data: { accountId: auth.account.id, actorAccountId: auth.account.id, action, detailsJson: { roomId, settlementId: settlement.id, forceReason: normalizedReason, overriddenBlockers }, createdAt: endedAt } });
          const dto = { ...this.settlementDto(settlement), stateVersion: updatedRoom.stateVersion };
          await tx.idempotencyRecord.create({ data: { scope, key, requestHash: await hashPassword(canonicalRequest), response: dto as Prisma.InputJsonObject } });
          return { created: true, settlement: dto };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 5) continue;
        if (isSerializationConflict(error)) fail('TRANSACTION_RETRY_EXHAUSTED');
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return this.recoverSettlementConflict(auth, roomId, input, key, canonicalRequest, scope);
        }
        throw error;
      }
    }
    return fail('TRANSACTION_RETRY_EXHAUSTED');
  }

  private async recoverSettlementConflict(
    auth: AuthenticatedSession,
    roomId: string,
    input: FinishSettlementInput,
    key: string,
    canonicalRequest: string,
    scope: string,
  ) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.db.$transaction(async (tx) => {
          await this.lockRoom(tx, roomId);
          const access: SettlementAccess = input.mode === 'FORCED' ? 'ADMIN' : 'MEMBER';
          await this.authorizeSettlement(tx, auth, roomId, access, input.mode === 'NORMAL');
          const record = required(await tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } }), 'TRANSACTION_CONFLICT');
          await this.assertRequestHash(record.requestHash, canonicalRequest);
          return { created: false, settlement: asObject(record.response) };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (isSerializationConflict(error) && attempt < 4) continue;
        if (isSerializationConflict(error)) fail('TRANSACTION_RETRY_EXHAUSTED');
        throw error;
      }
    }
    return fail('TRANSACTION_RETRY_EXHAUSTED');
  }

  async getSettlement(auth: AuthenticatedSession, roomId: string, access: SettlementAccess = 'MEMBER') {
    return this.serializable(async (tx) => {
      await this.authorizeSettlement(tx, auth, roomId, access, false);
      const state = await this.settlementState(tx, roomId);
      if (state.settlement) return { ...this.settlementDto(state.settlement), stateVersion: state.room.stateVersion };
      if (state.room.status === 'ENDED') fail('LEGACY_SETTLEMENT_UNAVAILABLE');
      if (state.room.status === 'FINISHED') fail('SETTLEMENT_INCONSISTENT');
      fail('SETTLEMENT_NOT_FOUND');
    });
  }

  async listSecurityLogs(auth: AuthenticatedSession, input: { action?: string; actorAccountId?: string; accountId?: string; from?: Date; to?: Date; cursor?: string; limit?: number }) {
    await this.requireCurrentAdmin(auth);
    if (input.from && input.to && input.from > input.to) fail('INVALID_TIME_RANGE');
    const limit = pageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = await this.db.securityLog.findMany({
      where: {
        ...(input.action ? { action: input.action } : {}),
        ...(input.actorAccountId ? { actorAccountId: input.actorAccountId } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...((input.from || input.to) ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}),
        ...cursorWhere(cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit);
    const supportedDetails = (row: typeof rows[number]) => {
      const details = row.detailsJson && typeof row.detailsJson === 'object' && !Array.isArray(row.detailsJson)
        ? row.detailsJson as Record<string, unknown>
        : {};
      switch (row.action) {
        case 'ACCOUNT_UPDATED':
        case 'ADMIN_ROOM_UPDATED':
          return { changedFields: Array.isArray(details.changedFields) ? details.changedFields.filter((field): field is string => typeof field === 'string') : [] };
        case 'PASSWORD_RESET':
        case 'ACCOUNT_DISABLED':
        case 'ACCOUNT_ENABLED':
          return { revokedSessions: typeof details.revokedSessions === 'number' ? details.revokedSessions : 0 };
        case 'ACCOUNT_SESSION_REVOKED':
          return { reason: typeof details.reason === 'string' ? details.reason : null };
        case 'ADMIN_ROOM_PASSWORD_UPDATED':
          return { roomId: typeof details.roomId === 'string' ? details.roomId : null, hasPassword: details.hasPassword === true };
        case 'ADMIN_MEMBER_REMOVED':
          return { roomId: typeof details.roomId === 'string' ? details.roomId : null, membershipId: typeof details.membershipId === 'string' ? details.membershipId : null };
        case 'ADMIN_BANK_REASSIGNED':
          return {
            roomId: typeof details.roomId === 'string' ? details.roomId : null,
            previousBankMembershipId: typeof details.previousBankMembershipId === 'string' ? details.previousBankMembershipId : null,
            bankMembershipId: typeof details.bankMembershipId === 'string' ? details.bankMembershipId : null,
          };
        case 'CHARACTER_SELECTED':
          return {
            roomId: typeof details.roomId === 'string' ? details.roomId : null,
            characterId: typeof details.characterId === 'string' ? details.characterId : null,
            characterNameSnapshot: typeof details.characterNameSnapshot === 'string' ? details.characterNameSnapshot : null,
          };
        case 'ROOM_FORCE_FINISHED':
        case 'ROOM_FINISHED':
          return { roomId: typeof details.roomId === 'string' ? details.roomId : null, forceReason: typeof details.forceReason === 'string' ? details.forceReason : null };
        default:
          return undefined;
      }
    };
    return {
      items: items.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        actorAccountId: row.actorAccountId,
        action: row.action,
        ip: row.ip ? maskIp(row.ip) : null,
        createdAt: row.createdAt,
        details: supportedDetails(row),
      })),
      nextCursor: hasNext ? encodeCursor(items.at(-1)!) : null,
    };
  }

  async listRoomAuditLogs(auth: AuthenticatedSession, roomId: string, input: { action?: string; actorMemberId?: string; from?: Date; to?: Date; cursor?: string; limit?: number }) {
    await this.requireCurrentAdmin(auth);
    required(await this.db.room.findUnique({ where: { id: roomId }, select: { id: true } }), 'ROOM_NOT_FOUND');
    if (input.from && input.to && input.from > input.to) fail('INVALID_TIME_RANGE');
    const limit = pageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = await this.db.auditLog.findMany({
      where: {
        roomId,
        ...(input.action ? { action: input.action } : {}),
        ...(input.actorMemberId ? { actorMemberId: input.actorMemberId } : {}),
        ...((input.from || input.to) ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}),
        ...cursorWhere(cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit);
    const safeState = (value: Prisma.JsonValue | null) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const source = value as Record<string, unknown>;
      const allowed = ['status', 'characterId', 'isBank', 'bankMembershipId', 'hasPassword'];
      return Object.fromEntries(allowed.filter((key) => key in source).map((key) => [key, source[key]]));
    };
    const supported = new Set(['ADMIN_ROOM_UPDATED', 'ADMIN_ROOM_PASSWORD_UPDATED', 'ADMIN_MEMBER_REMOVED', 'ADMIN_BANK_REASSIGNED', 'ROOM_FORCE_FINISHED', 'ROOM_FINISHED']);
    return {
      items: items.map((row) => ({
        id: row.id,
        roomId: row.roomId,
        actorMemberId: row.actorMemberId,
        actorRole: row.actorRole,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        reason: row.reason,
        createdAt: row.createdAt,
        details: supported.has(row.action) ? { before: safeState(row.beforeJson), after: safeState(row.afterJson) } : undefined,
      })),
      nextCursor: hasNext ? encodeCursor(items.at(-1)!) : null,
    };
  }

  async dashboard(auth: AuthenticatedSession) {
    await this.requireCurrentAdmin(auth);
    const now = new Date();
    const [totalAccounts, activeAccounts, validSessions, lobbyRooms, playingRooms, finishedRooms, settlementAggregate, selections, wins, recent] = await Promise.all([
      this.db.account.count(),
      this.db.account.count({ where: { status: 'ACTIVE' } }),
      this.db.accountSession.count({ where: { ...activeSessionWhere(now), account: { status: 'ACTIVE' } } }),
      this.db.room.count({ where: { status: 'LOBBY' } }),
      this.db.room.count({ where: { status: 'PLAYING' } }),
      this.db.room.count({ where: { status: 'FINISHED' } }),
      this.db.gameSettlement.aggregate({ _count: { _all: true }, _avg: { durationSeconds: true } }),
      this.db.$queryRaw<Array<{ characterId: string; characterNameSnapshot: string; count: bigint }>>`
        SELECT
          log."detailsJson"->>'characterId' AS "characterId",
          COALESCE(NULLIF(log."detailsJson"->>'characterNameSnapshot', ''), character."name") AS "characterNameSnapshot",
          COUNT(*)::bigint AS "count"
        FROM "SecurityLog" AS log
        INNER JOIN "Room" AS room ON room."id" = log."detailsJson"->>'roomId'
        LEFT JOIN "Character" AS character ON character."id" = log."detailsJson"->>'characterId'
        WHERE log."action" = 'CHARACTER_SELECTED'
          AND log."detailsJson"->>'roomId' IS NOT NULL
          AND log."detailsJson"->>'characterId' IS NOT NULL
        GROUP BY log."detailsJson"->>'characterId', COALESCE(NULLIF(log."detailsJson"->>'characterNameSnapshot', ''), character."name")
        ORDER BY COUNT(*) DESC, log."detailsJson"->>'characterId' ASC
      `,
      this.db.settlementPlayer.groupBy({ by: ['characterNameSnapshot'], where: { isWinner: true, characterNameSnapshot: { not: null } }, _count: { _all: true }, orderBy: { characterNameSnapshot: 'asc' } }),
      this.db.gameSettlement.findMany({
        include: { room: { select: { name: true } }, players: { where: { isWinner: true }, select: { accountId: true, displayNameSnapshot: true, characterNameSnapshot: true }, orderBy: { accountId: 'asc' } } },
        orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
        take: 10,
      }),
    ]);
    return {
      accounts: { total: totalAccounts, active: activeAccounts },
      sessions: { valid: validSessions },
      rooms: { lobby: lobbyRooms, playing: playingRooms, finished: finishedRooms },
      games: { settledTotal: settlementAggregate._count._all, averageDurationSeconds: Math.round(settlementAggregate._avg.durationSeconds ?? 0) },
      characterSelections: selections.map((item) => ({ characterId: item.characterId, characterNameSnapshot: item.characterNameSnapshot, count: Number(item.count) })),
      characterWins: wins.map((item) => ({ characterNameSnapshot: item.characterNameSnapshot!, count: item._count._all })),
      recentGames: recent.map((settlement) => ({
        roomId: settlement.roomId,
        roomNameSnapshot: settlement.room.name,
        endedAt: settlement.endedAt,
        durationSeconds: settlement.durationSeconds,
        forced: settlement.forced,
        winners: settlement.players,
      })),
    };
  }
}
