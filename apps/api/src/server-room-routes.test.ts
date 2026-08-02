import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRoomService, AuthenticatedSession } from './account-room-service.js';
import { RuleError } from './api-error.js';
import { sessionCookieName } from './auth-domain.js';
import { buildApiApp } from './app.js';
import type { PrismaGameService } from './prisma-game-service.js';

const auth: AuthenticatedSession = {
  account: {
    id: 'account-1',
    username: 'bank-user',
    displayName: '结算银行',
    isSuperAdmin: true,
    canCreateRoom: false,
  },
  session: { id: 'session-1', accountId: 'account-1' },
};

const settlement = {
  id: 'settlement-1',
  roomId: 'room-1',
  endedByAccountId: 'account-1',
  endedAt: '2026-07-27T00:00:00.000Z',
  totalTurns: 3,
  durationSeconds: 120,
  forced: false,
  forceReason: null,
  winners: ['player-account'],
  ranking: [{ accountId: 'player-account', rank: 1 }],
  overriddenBlockers: [],
  players: [{
    accountId: 'player-account',
    displayNameSnapshot: '玩家',
    characterNameSnapshot: '钮祜禄·甄嬛',
    cash: 6_000,
    unmortgagedPropertyValue: 1_800,
    mortgagedPropertyNetValue: 0,
    buildingSellValue: 0,
    totalWealth: 7_800,
    rank: 1,
    isWinner: true,
    propertyDetails: [],
  }],
};

const openApps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  delete process.env.APP_ORIGIN;
  delete process.env.NODE_ENV;
});

async function routeHarness() {
  const notifications: Array<{ roomId: string; event: string; payload: Record<string, unknown> }> = [];
  const accounts = {
    authenticate: vi.fn(async (token: string) => {
      if (token !== 'cookie-token') throw new RuleError('AUTH_REQUIRED');
      return auth;
    }),
    joinRoom: vi.fn(async (_auth: AuthenticatedSession, roomId: string, input: { password?: string; characterId?: string }, key: string) => ({
      id: 'membership-1', roomId, status: 'ACTIVE', characterId: input.characterId ?? null, isBank: false, stateVersion: key.length,
    })),
    previewSettlement: vi.fn(async (_auth: AuthenticatedSession, _roomId: string, access?: 'ADMIN') => ({
      blockers: [],
      players: access === 'ADMIN' ? [{ accountId: 'admin-preview' }] : [{ accountId: 'member-preview' }],
    })),
    finishRoom: vi.fn(async (_auth: AuthenticatedSession, roomId: string, input: { mode: 'NORMAL'; confirmation: string } | { mode: 'FORCED'; reason: string }, key: string) => {
      if ((input.mode === 'NORMAL' && input.confirmation === 'blocked') || (input.mode === 'FORCED' && input.reason === 'blocked')) {
        throw new RuleError('SETTLEMENT_BLOCKED');
      }
      return { created: key !== 'replay-key', settlement: { ...settlement, roomId, forced: input.mode === 'FORCED', stateVersion: input.mode === 'FORCED' ? 12 : 11 } };
    }),
    deleteAccount: vi.fn(async (_auth: AuthenticatedSession, id: string) => ({ deleted: true as const, id, created: true, revokedSessionIds: ['target-session'] })),
    deleteRoom: vi.fn(async (_auth: AuthenticatedSession, id: string) => ({ deleted: true as const, id, created: true, stateVersion: 13 })),
    authorizeRoomSession: vi.fn(async () => ({ player: { id: 'player-1' } })),
    getSettlement: vi.fn(async (_auth: AuthenticatedSession, _roomId: string, access?: 'ADMIN') => ({
      ...settlement,
      forced: access === 'ADMIN',
    })),
  };
  const games = {
    start: vi.fn(async (
      _actor: unknown,
      _roomId: string,
      _key: string,
      afterCommit?: (event: { removedSessionIds: string[] }) => void,
    ) => {
      afterCommit?.({ removedSessionIds: ['private-session-id'] });
      return { stateVersion: 24 };
    }),
    snapshot: vi.fn(async () => ({ id: 'room-1', stateVersion: 24, status: 'PLAYING' })),
    transfer: vi.fn(async () => ({ id: 'transfer-1', status: 'EXECUTED', stateVersion: 22 })),
  };
  const app = await buildApiApp({
    accounts: accounts as unknown as AccountRoomService,
    games: games as unknown as PrismaGameService,
    logger: false,
    notifier: (roomId, event, payload = {}) => notifications.push({ roomId, event, payload }),
  });
  openApps.push(app);
  const headers = { cookie: `${sessionCookieName}=cookie-token` };
  return { accounts, app, games, headers, notifications };
}

describe('room write route idempotency contract', () => {
  it('forwards the required Idempotency-Key to every critical room service operation', async () => {
    const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
    const expectedCalls = [
      /accounts\.createRoom\(auth, body, idempotencyKey\(request\.headers\['idempotency-key'\]\)\)/,
      /accounts\.joinRoom\(auth, id, body, idempotencyKey\(request\.headers\['idempotency-key'\]\)\)/,
      /accounts\.selectCharacter\(auth, id, characterId, idempotencyKey\(request\.headers\['idempotency-key'\]\)\)/,
      /accounts\.selectBank\(auth, id, idempotencyKey\(request\.headers\['idempotency-key'\]\)\)/,
      /accounts\.takeControl\(auth, id, idempotencyKey\(request\.headers\['idempotency-key'\]\),/,
    ];

    for (const expectedCall of expectedCalls) expect(source).toMatch(expectedCall);
  });

  it('returns only the safe takeover response and routes the displaced Session through a one-shot callback', async () => {
    const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/accounts\.takeControl\([\s\S]*?displacedSessionId[\s\S]*?sessionChannel\(displacedSessionId\)[\s\S]*?return result;/);
    expect(source).not.toMatch(/result\.previousSessionId|previousSessionId:/);
  });

  it('forwards the required Idempotency-Key to every role-swap mutation', async () => {
    const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
    const expectedCalls = [
      /accounts\.requestRoleSwap\(auth, id, targetCharacterId, idempotencyKey\(request\.headers\['idempotency-key'\]\)\)/,
      /accounts\.acceptRoleSwap\(auth, id, idempotencyKey\(request\.headers\['idempotency-key'\]\)\)/,
      /accounts\.resolveRoleSwap\(auth, id, 'REJECT', idempotencyKey\(request\.headers\['idempotency-key'\]\), reason\)/,
      /accounts\.resolveRoleSwap\(auth, id, 'APPROVE_BANK', idempotencyKey\(request\.headers\['idempotency-key'\]\)\)/,
      /accounts\.resolveRoleSwap\(auth, id, 'CANCEL', idempotencyKey\(request\.headers\['idempotency-key'\]\)\)/,
    ];

    for (const expectedCall of expectedCalls) expect(source).toMatch(expectedCall);
  });

  it('passes authenticated actors rather than raw Cookie tokens to game-domain methods', async () => {
    const source = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/games\.[A-Za-z]+\([^;\n]*auth\.rawToken/);
    expect(source).not.toMatch(/rawToken:\s*string/);
  });
});

describe('room join route contract', () => {
  it('forwards password and character selection unchanged', async () => {
    const { accounts, app, headers } = await routeHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room-1/join',
      headers: { ...headers, 'idempotency-key': 'join-key' },
      payload: { password: 'secret', characterId: 'meizhuang' },
    });

    expect(response.statusCode).toBe(200);
    expect(accounts.joinRoom).toHaveBeenCalledWith(auth, 'room-1', { password: 'secret', characterId: 'meizhuang' }, 'join-key');
  });

  it('rejects a non-string character before invoking the service', async () => {
    const { accounts, app, headers } = await routeHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room-1/join',
      headers: { ...headers, 'idempotency-key': 'invalid-character-key' },
      payload: { characterId: 42 },
    });

    expect(response.statusCode).toBe(400);
    expect(accounts.joinRoom).not.toHaveBeenCalled();
  });
});

describe('room start route contract', () => {
  it('passes the post-commit callback and keeps removed Session identifiers out of HTTP responses', async () => {
    const { app, games, headers } = await routeHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/room-1/start',
      headers: { ...headers, 'idempotency-key': 'start-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(games.start).toHaveBeenCalledWith(
      expect.any(Object),
      'room-1',
      'start-key',
      expect.any(Function),
    );
    expect(response.json()).toEqual({ id: 'room-1', stateVersion: 24, status: 'PLAYING' });
    expect(response.body).not.toContain('private-session-id');
  });
});

describe('unified transfer route contract', () => {
  it('accepts player and bank recipient discriminants and forwards the unified command', async () => {
    const { accounts, app, games, headers, notifications } = await routeHarness();
    const playerTransfer = { fromPlayerId: 'player-1', recipientType: 'PLAYER', toPlayerId: 'player-2', amount: 400, isPlotFine: false } as const;
    const bankTransfer = { fromPlayerId: 'player-1', recipientType: 'BANK', amount: 500, isPlotFine: true } as const;
    games.transfer
      .mockResolvedValueOnce({ id: 'transfer-1', status: 'EXECUTED', stateVersion: 22 })
      .mockResolvedValueOnce({ id: 'request-1', status: 'PENDING', stateVersion: 23 });

    const playerResponse = await app.inject({
      method: 'POST',
      url: '/api/rooms/room-1/transfers',
      headers: { ...headers, 'idempotency-key': 'player-transfer-key' },
      payload: playerTransfer,
    });
    const bankResponse = await app.inject({
      method: 'POST',
      url: '/api/rooms/room-1/transfers',
      headers: { ...headers, 'idempotency-key': 'bank-transfer-key' },
      payload: bankTransfer,
    });

    expect(playerResponse.statusCode).toBe(200);
    expect(bankResponse.statusCode).toBe(200);
    expect(playerResponse.json()).toMatchObject({ status: 'EXECUTED' });
    expect(bankResponse.json()).toMatchObject({ status: 'PENDING' });
    expect(accounts.authorizeRoomSession).toHaveBeenCalledTimes(2);
    expect(games.transfer).toHaveBeenNthCalledWith(1, { accountId: 'account-1', sessionId: 'session-1' }, 'room-1', playerTransfer, 'player-transfer-key');
    expect(games.transfer).toHaveBeenNthCalledWith(2, { accountId: 'account-1', sessionId: 'session-1' }, 'room-1', bankTransfer, 'bank-transfer-key');
    expect(notifications).toEqual([
      { roomId: 'room-1', event: 'room.updated', payload: { stateVersion: 22 } },
      { roomId: 'room-1', event: 'room.updated', payload: { stateVersion: 23 } },
    ]);
  });

  it('rejects inconsistent unified transfer recipient fields before calling the service', async () => {
    const { app, games, headers } = await routeHarness();
    const invalidBank = await app.inject({
      method: 'POST',
      url: '/api/rooms/room-1/transfers',
      headers: { ...headers, 'idempotency-key': 'invalid-bank' },
      payload: { fromPlayerId: 'player-1', recipientType: 'BANK', toPlayerId: 'player-2', amount: 100, isPlotFine: false },
    });
    const invalidPlayer = await app.inject({
      method: 'POST',
      url: '/api/rooms/room-1/transfers',
      headers: { ...headers, 'idempotency-key': 'invalid-player' },
      payload: { fromPlayerId: 'player-1', recipientType: 'PLAYER', amount: 100, isPlotFine: false },
    });

    expect(invalidBank.statusCode).toBe(400);
    expect(invalidPlayer.statusCode).toBe(400);
    expect(games.transfer).not.toHaveBeenCalled();
  });
});

describe('admin deletion routes', () => {
  it('forwards idempotency keys and emits post-commit account and room invalidations', async () => {
    const { accounts, app, headers, notifications } = await routeHarness();

    const accountResponse = await app.inject({
      method: 'DELETE',
      url: '/api/admin/accounts/account-target',
      headers: { ...headers, 'idempotency-key': 'delete-account-key' },
    });
    const roomResponse = await app.inject({
      method: 'DELETE',
      url: '/api/admin/rooms/room-1',
      headers: { ...headers, 'idempotency-key': 'delete-room-key' },
    });

    expect(accountResponse.json()).toEqual({ deleted: true, id: 'account-target' });
    expect(roomResponse.json()).toEqual({ deleted: true, id: 'room-1' });
    expect(accounts.deleteAccount).toHaveBeenCalledWith(auth, 'account-target', 'delete-account-key');
    expect(accounts.deleteRoom).toHaveBeenCalledWith(auth, 'room-1', 'delete-room-key');
    expect(notifications).toContainEqual({ roomId: 'room-1', event: 'room.updated', payload: { stateVersion: 13 } });
  });
});

describe('production origin policy', () => {
  it('accepts only the configured HTTPS APP_ORIGIN and rejects a foreign preflight', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_ORIGIN = 'https://game.example.com';
    const { app } = await routeHarness();

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/me',
      headers: { origin: 'https://game.example.com', 'access-control-request-method': 'GET' },
    });
    const rejected = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/me',
      headers: { origin: 'https://foreign.example', 'access-control-request-method': 'GET' },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://game.example.com');
    expect(rejected.statusCode).toBe(403);
  });
});

describe('settlement routes through Fastify injection', () => {
  it('authenticates Cookie requests and keeps member/admin previews and reads distinct', async () => {
    const { accounts, app, headers } = await routeHarness();

    const memberPreview = await app.inject({ method: 'POST', url: '/api/rooms/room-1/settlement/preview', headers });
    const adminPreview = await app.inject({ method: 'POST', url: '/api/admin/rooms/room-1/settlement/preview', headers });
    const memberRead = await app.inject({ method: 'GET', url: '/api/rooms/room-1/settlement', headers });
    const adminRead = await app.inject({ method: 'GET', url: '/api/admin/rooms/room-1/settlement', headers });

    expect(memberPreview).toMatchObject({ statusCode: 200 });
    expect(memberPreview.json()).toEqual({ blockers: [], players: [{ accountId: 'member-preview' }] });
    expect(adminPreview.json()).toEqual({ blockers: [], players: [{ accountId: 'admin-preview' }] });
    expect(memberRead.json()).toEqual(settlement);
    expect(adminRead.json()).toEqual({ ...settlement, forced: true });
    expect(accounts.authenticate).toHaveBeenCalledTimes(4);
    expect(accounts.previewSettlement).toHaveBeenNthCalledWith(1, auth, 'room-1');
    expect(accounts.previewSettlement).toHaveBeenNthCalledWith(2, auth, 'room-1', 'ADMIN');
    expect(accounts.getSettlement).toHaveBeenNthCalledWith(1, auth, 'room-1');
    expect(accounts.getSettlement).toHaveBeenNthCalledWith(2, auth, 'room-1', 'ADMIN');
    expect(JSON.stringify([memberPreview.json(), adminPreview.json(), memberRead.json(), adminRead.json()])).not.toMatch(/passwordHash|sessionTokenHash|cookie-token/);
  });

  it('forwards actual normal/admin keys and emits one versioned finish invalidation per creating commit', async () => {
    const { accounts, app, headers, notifications } = await routeHarness();
    const normal = await app.inject({
      method: 'POST', url: '/api/rooms/room-1/finish', headers: { ...headers, 'idempotency-key': 'normal-key' },
      payload: { confirmation: '确认结束游戏' },
    });
    const replay = await app.inject({
      method: 'POST', url: '/api/rooms/room-1/finish', headers: { ...headers, 'idempotency-key': 'replay-key' },
      payload: { confirmation: '确认结束游戏' },
    });
    const forced = await app.inject({
      method: 'POST', url: '/api/admin/rooms/room-1/finish', headers: { ...headers, 'idempotency-key': 'forced-key' },
      payload: { reason: 'operational close' },
    });

    expect(normal.statusCode).toBe(200);
    expect(normal.json()).toMatchObject({ created: true, settlement: { id: 'settlement-1', forced: false } });
    expect(replay.json()).toMatchObject({ created: false });
    expect(forced.json()).toMatchObject({ created: true, settlement: { forced: true } });
    expect(accounts.finishRoom).toHaveBeenNthCalledWith(1, auth, 'room-1', { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'normal-key');
    expect(accounts.finishRoom).toHaveBeenNthCalledWith(2, auth, 'room-1', { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'replay-key');
    expect(accounts.finishRoom).toHaveBeenNthCalledWith(3, auth, 'room-1', { mode: 'FORCED', reason: 'operational close' }, 'forced-key');
    expect(notifications).toEqual([
      { roomId: 'room-1', event: 'room.updated', payload: { stateVersion: 11 } },
      { roomId: 'room-1', event: 'room.updated', payload: { stateVersion: 12 } },
    ]);
  });

  it('maps finish failures publicly and emits nothing for missing keys or service conflicts', async () => {
    const { app, headers, notifications } = await routeHarness();
    const missingKey = await app.inject({
      method: 'POST', url: '/api/rooms/room-1/finish', headers,
      payload: { confirmation: '确认结束游戏' },
    });
    const blocked = await app.inject({
      method: 'POST', url: '/api/rooms/room-1/finish', headers: { ...headers, 'idempotency-key': 'blocked-key' },
      payload: { confirmation: 'blocked' },
    });

    expect(missingKey.statusCode).toBe(409);
    expect(missingKey.json()).toEqual({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: 'SETTLEMENT_BLOCKED' });
    expect(notifications).toEqual([]);
  });
});
