import { afterEach, describe, expect, it, vi } from 'vitest';
import { Socket as ServerSocket } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AccountRoomService, AuthenticatedSession } from './account-room-service.js';
import { sessionCookieName } from './auth-domain.js';
import * as appModule from './app.js';
import type { PrismaGameService } from './prisma-game-service.js';
import type { RealtimeToastEvent } from '@zhenhuan/shared';

type SubscriptionSocket = {
  data: Record<string, unknown>;
  join: (roomId: string) => Promise<void>;
  leave: (roomId: string) => Promise<void>;
};

const auth: AuthenticatedSession = {
  account: {
    id: 'account-1',
    username: 'socket-user',
    displayName: 'Socket Player',
    isSuperAdmin: false,
    canCreateRoom: false,
  },
  session: { id: 'session-1', accountId: 'account-1' },
};

const openApps: Array<{ close: () => Promise<unknown> }> = [];
const openClients: ClientSocket[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) client.disconnect();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function event<T>(socket: ClientSocket, name: string, predicate: (payload: T) => boolean = () => true) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(name, listener);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 2_000);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(name, listener);
      resolve(payload);
    };
    socket.on(name, listener);
  });
}

async function socketHarness(
  authorizeRoomSession: (auth: AuthenticatedSession, roomId: string) => Promise<unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const accounts = {
    authenticate: vi.fn(async (token: string) => {
      if (token !== 'cookie-token') throw new Error('AUTH_REQUIRED');
      return auth;
    }),
    authorizeRoomSession: vi.fn(async (...args: [AuthenticatedSession, string]) => {
      const authorized = await authorizeRoomSession(...args);
      return { room: { stateVersion: 1 }, ...(authorized as Record<string, unknown>) };
    }),
  };
  const app = await appModule.buildApiApp({
    accounts: accounts as unknown as AccountRoomService,
    games: {} as PrismaGameService,
    logger: false,
  });
  openApps.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = createSocketClient(address, {
    extraHeaders: { Cookie: `${sessionCookieName}=cookie-token`, ...extraHeaders },
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });
  openClients.push(client);
  if (!client.connected) await event(client, 'connect');
  return { accounts, client };
}

describe('Socket.IO room subscription ownership', () => {
  it('uses only the nearest forwarded hop as the production Socket client IP', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAppOrigin = process.env.APP_ORIGIN;
    process.env.NODE_ENV = 'production';
    process.env.APP_ORIGIN = 'https://game.example.com';
    try {
      const { accounts, client } = await socketHarness(
        async () => ({ membership: { player: { id: 'player-1' }, isBank: false } }),
        { 'X-Forwarded-For': '198.51.100.44, 203.0.113.25' },
      );
      const subscribed = event<{ roomId: string }>(client, 'room.snapshot-required');
      client.emit('room.subscribe', { roomId: 'room-a' });
      await subscribed;

      expect(accounts.authenticate).toHaveBeenCalledTimes(2);
      expect(accounts.authenticate).toHaveBeenNthCalledWith(1, 'cookie-token', '203.0.113.25');
      expect(accounts.authenticate).toHaveBeenNthCalledWith(2, 'cookie-token', '203.0.113.25');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = previousAppOrigin;
    }
  });

  it('targets fund and rejection Toasts only to their delivery Session channels', async () => {
    const createNotifier = (appModule as typeof appModule & {
      createPostCommitToastNotifier?: (...args: never[]) => {
        fundsCommitted: (roomId: string, transactionId: string) => Promise<void>;
        requestRejected: (roomId: string, requestId: string) => Promise<void>;
        landingRejected: (roomId: string, landingId: string, reason: string) => Promise<void>;
      };
    }).createPostCommitToastNotifier;
    expect(createNotifier).toBeTypeOf('function');
    if (!createNotifier) return;

    const emitted: Array<{ channel: string; name: string; event: RealtimeToastEvent }> = [];
    const emitter = {
      to: (channel: string) => ({
        emit: (name: string, event: RealtimeToastEvent) => { emitted.push({ channel, name, event }); },
      }),
    };
    const fundEvents: RealtimeToastEvent[] = [
      { eventId: 'tx-1:PLAYER:payer', roomId: 'room-a', audience: 'PLAYER', kind: 'FUNDS', message: '你向李四支付 500 两' },
      { eventId: 'tx-1:PLAYER:receiver', roomId: 'room-a', audience: 'PLAYER', kind: 'FUNDS', message: '张三向你转入 500 两' },
      { eventId: 'tx-1:BANK', roomId: 'room-a', audience: 'BANK', kind: 'FUNDS', message: '张三向李四支付 500 两' },
    ];
    const rejectedEvent: RealtimeToastEvent = {
      eventId: 'request-1:rejected:PLAYER:payer', roomId: 'room-a', audience: 'PLAYER', kind: 'REQUEST_REJECTED', message: '你的转帐申请已被银行拒绝：金额有误',
    };
    const landingRejectedEvent: RealtimeToastEvent = {
      eventId: 'landing-1:rejected:PLAYER:player-1', roomId: 'room-a', audience: 'PLAYER', kind: 'REQUEST_REJECTED', message: '你的落点申请已被银行拒绝：现场落点有误',
    };
    const errors: unknown[] = [];
    const notifier = createNotifier(
      {} as never,
      emitter,
      (error: unknown) => { errors.push(error); },
      {
        funds: async () => [
          { sessionId: 'payer-session', event: fundEvents[0]! },
          { sessionId: 'receiver-session', event: fundEvents[1]! },
          { sessionId: 'bank-session', event: fundEvents[2]! },
        ],
        rejection: async () => ({ sessionId: 'payer-session', event: rejectedEvent }),
        landingRejection: async () => ({ sessionId: 'player-session', event: landingRejectedEvent }),
      },
    );

    await notifier.fundsCommitted('room-a', 'tx-1');
    await notifier.requestRejected('room-a', 'request-1');
    await notifier.landingRejected('room-a', 'landing-1', '现场落点有误');

    expect(emitted).toEqual([
      { channel: 'session:payer-session', name: 'room.toast', event: fundEvents[0] },
      { channel: 'session:receiver-session', name: 'room.toast', event: fundEvents[1] },
      { channel: 'session:bank-session', name: 'room.toast', event: fundEvents[2] },
      { channel: 'session:payer-session', name: 'room.toast', event: rejectedEvent },
      { channel: 'session:player-session', name: 'room.toast', event: landingRejectedEvent },
    ]);
    expect(emitted.some(({ channel }) => channel === 'session:unrelated-session' || channel === 'session:other-room-session')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('replaces the previous room and explicitly cleans the active room', async () => {
    const replaceRoomSubscription = (appModule as typeof appModule & {
      replaceRoomSubscription?: (socket: SubscriptionSocket, roomId: string | null) => Promise<void>;
    }).replaceRoomSubscription;
    expect(replaceRoomSubscription).toBeTypeOf('function');
    if (!replaceRoomSubscription) return;

    const joined = new Set<string>();
    const socket: SubscriptionSocket = {
      data: {},
      join: vi.fn(async (roomId) => { joined.add(roomId); }),
      leave: vi.fn(async (roomId) => { joined.delete(roomId); }),
    };

    await replaceRoomSubscription(socket, 'room-a');
    expect(joined).toEqual(new Set(['room:room-a']));
    await replaceRoomSubscription(socket, 'room-b');
    expect(joined).toEqual(new Set(['room:room-b']));
    expect(socket.leave).toHaveBeenCalledWith('room:room-a');
    await replaceRoomSubscription(socket, null);
    expect(joined).toEqual(new Set());
    expect(socket.leave).toHaveBeenCalledWith('room:room-b');
  });

  it('keeps the latest room when an older authorization completes last', async () => {
    const roomAStarted = deferred();
    const releaseRoomA = deferred();
    const { accounts, client } = await socketHarness(async (_auth, roomId) => {
      if (roomId === 'room-a') {
        roomAStarted.resolve();
        await releaseRoomA.promise;
      }
      return {};
    });
    const snapshots: Array<{ roomId: string }> = [];
    client.on('room.snapshot-required', (payload) => snapshots.push(payload));

    client.emit('room.subscribe', { roomId: 'room-a' });
    await roomAStarted.promise;
    const roomBSnapshot = event<{ roomId: string }>(client, 'room.snapshot-required', (payload) => payload.roomId === 'room-b');
    client.emit('room.subscribe', { roomId: 'room-b' });
    await expect(roomBSnapshot).resolves.toEqual({ roomId: 'room-b', stateVersion: 1 });

    const staleAuthorizationProcessed = event(client, 'room.subscription-rejected');
    releaseRoomA.resolve();
    client.emit('room.subscribe', {});
    await staleAuthorizationProcessed;

    expect(snapshots).toEqual([{ roomId: 'room-b', stateVersion: 1 }]);
    expect(accounts.authenticate).toHaveBeenCalledWith('cookie-token', expect.any(String));
  });

  it('does not subscribe after the pending room is unsubscribed', async () => {
    const roomAStarted = deferred();
    const releaseRoomA = deferred();
    const { client } = await socketHarness(async (_auth, roomId) => {
      if (roomId === 'room-a') {
        roomAStarted.resolve();
        await releaseRoomA.promise;
      }
      return {};
    });
    const snapshots: Array<{ roomId: string }> = [];
    client.on('room.snapshot-required', (payload) => snapshots.push(payload));

    client.emit('room.subscribe', { roomId: 'room-a' });
    await roomAStarted.promise;
    const unsubscribeProcessed = event(client, 'room.subscription-rejected');
    client.emit('room.unsubscribe', { roomId: 'room-a' });
    client.emit('room.subscribe', {});
    await unsubscribeProcessed;

    const staleAuthorizationProcessed = event(client, 'room.subscription-rejected');
    releaseRoomA.resolve();
    client.emit('room.subscribe', {});
    await staleAuthorizationProcessed;

    expect(snapshots).toEqual([]);
  });

  it('rolls back a join that becomes stale while the adapter is pending', async () => {
    const roomAJoinStarted = deferred();
    const releaseRoomAJoin = deferred();
    const roomBAuthorizationStarted = deferred();
    const releaseRoomBAuthorization = deferred();
    const originalJoin = ServerSocket.prototype.join;
    const serverSockets = new Set<ServerSocket>();
    vi.spyOn(ServerSocket.prototype, 'join').mockImplementation(function (this: ServerSocket, rooms) {
      if (rooms === 'room:room-a') {
        serverSockets.add(this);
        roomAJoinStarted.resolve();
        return releaseRoomAJoin.promise.then(() => originalJoin.call(this, rooms));
      }
      return originalJoin.call(this, rooms);
    });
    const { client } = await socketHarness(async (_auth, roomId) => {
      if (roomId === 'room-b') {
        roomBAuthorizationStarted.resolve();
        await releaseRoomBAuthorization.promise;
      }
      return {};
    });

    client.emit('room.subscribe', { roomId: 'room-a' });
    await roomAJoinStarted.promise;
    client.emit('room.subscribe', { roomId: 'room-b' });
    await roomBAuthorizationStarted.promise;

    const staleJoinProcessed = event(client, 'room.subscription-rejected');
    releaseRoomAJoin.resolve();
    client.emit('room.subscribe', {});
    await staleJoinProcessed;
    const serverSocket = serverSockets.values().next().value;
    const staleRoomWasJoined = serverSocket?.rooms.has('room:room-a');
    const staleRoomWasCommitted = serverSocket?.data.subscribedRoomId === 'room-a';

    const roomBSnapshot = event<{ roomId: string }>(client, 'room.snapshot-required', (payload) => payload.roomId === 'room-b');
    releaseRoomBAuthorization.resolve();
    await roomBSnapshot;

    expect(staleRoomWasJoined).toBe(false);
    expect(staleRoomWasCommitted).toBe(false);
    expect(serverSocket?.rooms.has('room:room-a')).toBe(false);
    expect(serverSocket?.rooms.has('room:room-b')).toBe(true);
    expect(serverSocket?.data.subscribedRoomId).toBe('room-b');
  });

  it('restores the previous room when a leave becomes stale while the adapter is pending', async () => {
    const roomALeaveStarted = deferred();
    const releaseRoomALeave = deferred();
    const roomCAuthorizationStarted = deferred();
    const releaseRoomCAuthorization = deferred();
    const originalLeave = ServerSocket.prototype.leave;
    const serverSockets = new Set<ServerSocket>();
    let delayedRoomALeave = false;
    vi.spyOn(ServerSocket.prototype, 'leave').mockImplementation(function (this: ServerSocket, room) {
      serverSockets.add(this);
      if (room === 'room:room-a' && !delayedRoomALeave) {
        delayedRoomALeave = true;
        roomALeaveStarted.resolve();
        return releaseRoomALeave.promise.then(() => originalLeave.call(this, room));
      }
      return originalLeave.call(this, room);
    });
    const { client } = await socketHarness(async (_auth, roomId) => {
      if (roomId === 'room-c') {
        roomCAuthorizationStarted.resolve();
        await releaseRoomCAuthorization.promise;
      }
      return {};
    });

    const roomASnapshot = event<{ roomId: string }>(client, 'room.snapshot-required', (payload) => payload.roomId === 'room-a');
    client.emit('room.subscribe', { roomId: 'room-a' });
    await roomASnapshot;
    client.emit('room.subscribe', { roomId: 'room-b' });
    await roomALeaveStarted.promise;
    client.emit('room.subscribe', { roomId: 'room-c' });
    await roomCAuthorizationStarted.promise;

    const staleLeaveProcessed = event(client, 'room.subscription-rejected');
    releaseRoomALeave.resolve();
    client.emit('room.subscribe', {});
    await staleLeaveProcessed;
    const serverSocket = serverSockets.values().next().value;
    const previousRoomWasRestored = serverSocket?.rooms.has('room:room-a');
    const staleRoomWasJoined = serverSocket?.rooms.has('room:room-b');
    const previousRoomWasCommitted = serverSocket?.data.subscribedRoomId === 'room-a';

    const roomCSnapshot = event<{ roomId: string }>(client, 'room.snapshot-required', (payload) => payload.roomId === 'room-c');
    releaseRoomCAuthorization.resolve();
    await roomCSnapshot;

    expect(previousRoomWasRestored).toBe(false);
    expect(staleRoomWasJoined).toBe(false);
    expect(previousRoomWasCommitted).toBe(false);
    expect(serverSocket?.rooms.has('room:room-a')).toBe(false);
    expect(serverSocket?.rooms.has('room:room-b')).toBe(false);
    expect(serverSocket?.rooms.has('room:room-c')).toBe(true);
    expect(serverSocket?.data.subscribedRoomId).toBe('room-c');
  });

  it('restores the active room when an unsubscribe becomes stale during leave', async () => {
    const roomALeaveStarted = deferred();
    const releaseRoomALeave = deferred();
    const roomBAuthorizationStarted = deferred();
    const releaseRoomBAuthorization = deferred();
    const originalLeave = ServerSocket.prototype.leave;
    const serverSockets = new Set<ServerSocket>();
    let delayedRoomALeave = false;
    vi.spyOn(ServerSocket.prototype, 'leave').mockImplementation(function (this: ServerSocket, room) {
      serverSockets.add(this);
      if (room === 'room:room-a' && !delayedRoomALeave) {
        delayedRoomALeave = true;
        roomALeaveStarted.resolve();
        return releaseRoomALeave.promise.then(() => originalLeave.call(this, room));
      }
      return originalLeave.call(this, room);
    });
    const { client } = await socketHarness(async (_auth, roomId) => {
      if (roomId === 'room-b') {
        roomBAuthorizationStarted.resolve();
        await releaseRoomBAuthorization.promise;
      }
      return {};
    });

    const roomASnapshot = event<{ roomId: string }>(client, 'room.snapshot-required', (payload) => payload.roomId === 'room-a');
    client.emit('room.subscribe', { roomId: 'room-a' });
    await roomASnapshot;
    client.emit('room.unsubscribe', { roomId: 'room-a' });
    await roomALeaveStarted.promise;
    client.emit('room.subscribe', { roomId: 'room-b' });
    await roomBAuthorizationStarted.promise;

    const staleUnsubscribeProcessed = event(client, 'room.subscription-rejected');
    releaseRoomALeave.resolve();
    client.emit('room.subscribe', {});
    await staleUnsubscribeProcessed;
    const serverSocket = serverSockets.values().next().value;
    const previousRoomWasRestored = serverSocket?.rooms.has('room:room-a');
    const previousRoomWasCommitted = serverSocket?.data.subscribedRoomId === 'room-a';

    const roomBSnapshot = event<{ roomId: string }>(client, 'room.snapshot-required', (payload) => payload.roomId === 'room-b');
    releaseRoomBAuthorization.resolve();
    await roomBSnapshot;

    expect(previousRoomWasRestored).toBe(false);
    expect(previousRoomWasCommitted).toBe(false);
    expect(serverSocket?.rooms.has('room:room-a')).toBe(false);
    expect(serverSocket?.rooms.has('room:room-b')).toBe(true);
    expect(serverSocket?.data.subscribedRoomId).toBe('room-b');
  });

  it('reconciles membership after a replacement adapter update rejects', async () => {
    const originalJoin = ServerSocket.prototype.join;
    const serverSockets = new Set<ServerSocket>();
    vi.spyOn(ServerSocket.prototype, 'join').mockImplementation(function (this: ServerSocket, rooms) {
      serverSockets.add(this);
      if (rooms === 'room:room-b') return Promise.reject(new Error('adapter join failed'));
      return originalJoin.call(this, rooms);
    });
    const { client } = await socketHarness(async () => ({}));

    const initialRoomASnapshot = event<{ roomId: string }>(client, 'room.snapshot-required', (payload) => payload.roomId === 'room-a');
    client.emit('room.subscribe', { roomId: 'room-a' });
    await initialRoomASnapshot;

    const roomBRejected = event<{ roomId: string }>(client, 'room.subscription-rejected', (payload) => payload.roomId === 'room-b');
    client.emit('room.subscribe', { roomId: 'room-b' });
    await expect(roomBRejected).resolves.toEqual({ roomId: 'room-b' });

    const serverSocket = serverSockets.values().next().value;
    expect(serverSocket?.rooms.has('room:room-a')).toBe(false);
    expect(serverSocket?.rooms.has('room:room-b')).toBe(false);
    expect(serverSocket?.data.subscribedRoomId).toBeUndefined();

    const restoredRoomASnapshot = event<{ roomId: string }>(client, 'room.snapshot-required', (payload) => payload.roomId === 'room-a');
    client.emit('room.subscribe', { roomId: 'room-a' });
    await expect(restoredRoomASnapshot).resolves.toEqual({ roomId: 'room-a', stateVersion: 1 });

    expect(serverSocket?.rooms.has('room:room-a')).toBe(true);
    expect(serverSocket?.rooms.has('room:room-b')).toBe(false);
    expect(serverSocket?.data.subscribedRoomId).toBe('room-a');
  });

  it('clears the previous business room when the latest subscription authorization fails', async () => {
    const serverSockets = new Set<ServerSocket>();
    const originalJoin = ServerSocket.prototype.join;
    vi.spyOn(ServerSocket.prototype, 'join').mockImplementation(function (this: ServerSocket, rooms) {
      serverSockets.add(this);
      return originalJoin.call(this, rooms);
    });
    const { client } = await socketHarness(async (_auth, roomId) => {
      if (roomId === 'room-b') throw new Error('ROOM_CONTROL_LOST');
      return {};
    });

    const roomASnapshot = event<{ roomId: string }>(client, 'room.snapshot-required');
    client.emit('room.subscribe', { roomId: 'room-a' });
    await roomASnapshot;
    const roomBRejected = event<{ roomId: string }>(client, 'room.subscription-rejected');
    client.emit('room.subscribe', { roomId: 'room-b' });
    await expect(roomBRejected).resolves.toEqual({ roomId: 'room-b' });

    const serverSocket = serverSockets.values().next().value;
    expect(serverSocket?.rooms.has('room:room-a')).toBe(false);
    expect(serverSocket?.data.subscribedRoomId).toBeUndefined();
  });

  it('keeps adapter membership and the subscription marker aligned across reverse control takeovers', async () => {
    const sessions = new Map([
      ['cookie-1', { ...auth, session: { id: 'session-1', accountId: auth.account.id } }],
      ['cookie-2', { ...auth, session: { id: 'session-2', accountId: auth.account.id } }],
    ]);
    let activeSessionId = 'session-1';
    let stateVersion = 1;
    const serverSockets = new Map<string, ServerSocket>();
    const originalJoin = ServerSocket.prototype.join;
    vi.spyOn(ServerSocket.prototype, 'join').mockImplementation(function (this: ServerSocket, rooms) {
      const sessionId = (this.data.auth as AuthenticatedSession | undefined)?.session.id;
      if (sessionId) serverSockets.set(sessionId, this);
      return originalJoin.call(this, rooms);
    });
    const accounts = {
      authenticate: vi.fn(async (token: string) => {
        const session = sessions.get(token);
        if (!session) throw new Error('AUTH_REQUIRED');
        return session;
      }),
      authorizeRoomSession: vi.fn(async (session: AuthenticatedSession) => {
        if (session.session.id !== activeSessionId) throw new Error('ROOM_CONTROL_LOST');
        return { room: { stateVersion }, isBank: true };
      }),
      takeControl: vi.fn(async (session: AuthenticatedSession, _roomId: string, _key: string, afterCommit: (event: { displacedSessionId: string }) => void) => {
        const displacedSessionId = activeSessionId;
        activeSessionId = session.session.id;
        stateVersion += 1;
        afterCommit({ displacedSessionId });
        return { stateVersion };
      }),
      selectCharacter: vi.fn(async () => ({ stateVersion: ++stateVersion })),
    };
    const app = await appModule.buildApiApp({ accounts: accounts as unknown as AccountRoomService, games: {} as PrismaGameService, logger: false });
    openApps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const [first, second] = ['cookie-1', 'cookie-2'].map((token) => createSocketClient(address, {
      extraHeaders: { Cookie: `${sessionCookieName}=${token}` }, forceNew: true, reconnection: false, transports: ['websocket'],
    }));
    openClients.push(first, second);
    await Promise.all([first, second].map((client) => client.connected ? Promise.resolve() : event(client, 'connect')));

    const firstSnapshot = event<{ roomId: string }>(first, 'room.snapshot-required');
    first.emit('room.subscribe', { roomId: 'room-a' });
    await firstSnapshot;
    const secondRejected = event(second, 'room.subscription-rejected');
    second.emit('room.subscribe', { roomId: 'room-a' });
    await secondRejected;

    await app.inject({ method: 'POST', url: '/api/rooms/room-a/take-control', headers: { cookie: `${sessionCookieName}=cookie-2`, 'idempotency-key': 'take-control-2' } });
    expect(serverSockets.get('session-1')?.rooms.has('room:room-a')).toBe(false);
    expect(serverSockets.get('session-1')?.data.subscribedRoomId).toBeUndefined();
    const secondSnapshot = event<{ roomId: string }>(second, 'room.snapshot-required');
    second.emit('room.subscribe', { roomId: 'room-a' });
    await secondSnapshot;
    const secondInvalidation = event<{ stateVersion: number }>(second, 'room.snapshot-required', (payload) => payload.stateVersion === 3);
    await app.inject({ method: 'POST', url: '/api/rooms/room-a/select-character', headers: { cookie: `${sessionCookieName}=cookie-2`, 'idempotency-key': 'select-2' }, payload: { characterId: 'zhenhuan' } });
    await secondInvalidation;

    await app.inject({ method: 'POST', url: '/api/rooms/room-a/take-control', headers: { cookie: `${sessionCookieName}=cookie-1`, 'idempotency-key': 'take-control-1' } });
    expect(serverSockets.get('session-2')?.rooms.has('room:room-a')).toBe(false);
    expect(serverSockets.get('session-2')?.data.subscribedRoomId).toBeUndefined();
    const restoredFirstSnapshot = event<{ roomId: string }>(first, 'room.snapshot-required');
    first.emit('room.subscribe', { roomId: 'room-a' });
    await restoredFirstSnapshot;
    const firstInvalidation = event<{ stateVersion: number }>(first, 'room.snapshot-required', (payload) => payload.stateVersion === 5);
    await app.inject({ method: 'POST', url: '/api/rooms/room-a/select-character', headers: { cookie: `${sessionCookieName}=cookie-1`, 'idempotency-key': 'select-1' }, payload: { characterId: 'zhenhuan' } });
    await firstInvalidation;
  });

  it('keeps an active former bank in the room notification channel after reassignment', async () => {
    const accounts = {
      authenticate: vi.fn(async () => auth),
      authorizeRoomSession: vi.fn(async () => ({ room: { stateVersion: 1 }, isBank: true })),
      reassignAdminRoomBank: vi.fn(async (_session: AuthenticatedSession, _roomId: string, _membershipId: string, _key: string, afterCommit?: (event: { removedSessionId: string }) => void) => {
        afterCommit?.({ removedSessionId: auth.session.id });
        return { roomId: 'room-a', changed: true, stateVersion: 2 };
      }),
    };
    const app = await appModule.buildApiApp({ accounts: accounts as unknown as AccountRoomService, games: {} as PrismaGameService, logger: false });
    openApps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = createSocketClient(address, { extraHeaders: { Cookie: `${sessionCookieName}=cookie-token` }, forceNew: true, reconnection: false, transports: ['websocket'] });
    openClients.push(client);
    if (!client.connected) await event(client, 'connect');
    const initialSnapshot = event(client, 'room.snapshot-required');
    client.emit('room.subscribe', { roomId: 'room-a' });
    await initialSnapshot;

    const invalidation = event<{ roomId: string; stateVersion: number }>(client, 'room.snapshot-required', (payload) => payload.stateVersion === 2);
    await app.inject({ method: 'POST', url: '/api/admin/rooms/room-a/bank/reassign', headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'reassign-bank' }, payload: { targetMembershipId: 'membership-2' } });
    await expect(invalidation).resolves.toEqual({ roomId: 'room-a', stateVersion: 2 });
  });

  it('removes a departed member from the adapter and clears its subscription marker', async () => {
    const serverSockets = new Set<ServerSocket>();
    const originalJoin = ServerSocket.prototype.join;
    vi.spyOn(ServerSocket.prototype, 'join').mockImplementation(function (this: ServerSocket, rooms) {
      serverSockets.add(this);
      return originalJoin.call(this, rooms);
    });
    const accounts = {
      authenticate: vi.fn(async () => auth),
      authorizeRoomSession: vi.fn(async () => ({ room: { stateVersion: 1 } })),
      removeAdminRoomMember: vi.fn(async (_session: AuthenticatedSession, _roomId: string, _membershipId: string, _key: string, afterCommit: (event: { removedSessionId: string }) => void) => {
        afterCommit({ removedSessionId: auth.session.id });
        return { roomId: 'room-a', stateVersion: 2 };
      }),
    };
    const app = await appModule.buildApiApp({ accounts: accounts as unknown as AccountRoomService, games: {} as PrismaGameService, logger: false });
    openApps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = createSocketClient(address, { extraHeaders: { Cookie: `${sessionCookieName}=cookie-token` }, forceNew: true, reconnection: false, transports: ['websocket'] });
    openClients.push(client);
    if (!client.connected) await event(client, 'connect');
    const initialSnapshot = event(client, 'room.snapshot-required');
    client.emit('room.subscribe', { roomId: 'room-a' });
    await initialSnapshot;

    const rejected = event<{ roomId: string }>(client, 'room.subscription-rejected');
    await app.inject({ method: 'POST', url: '/api/admin/rooms/room-a/members/membership-1/remove', headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'remove-member' }, payload: {} });

    await expect(rejected).resolves.toEqual({ roomId: 'room-a' });
    const serverSocket = serverSockets.values().next().value;
    expect(serverSocket?.rooms.has('room:room-a')).toBe(false);
    expect(serverSocket?.data.subscribedRoomId).toBeUndefined();
  });

  it('delivers one versioned invalidation only to authorized room sockets and disconnects a revoked Session', async () => {
    const sessions = new Map([
      ['cookie-1', { ...auth, session: { id: 'session-1', accountId: auth.account.id } }],
      ['cookie-2', { ...auth, session: { id: 'session-2', accountId: auth.account.id } }],
      ['cookie-3', { ...auth, session: { id: 'session-3', accountId: auth.account.id } }],
    ]);
    const accounts = {
      authenticate: vi.fn(async (token: string) => {
        const value = sessions.get(token);
        if (!value) throw new Error('AUTH_REQUIRED');
        return value;
      }),
      authorizeRoomSession: vi.fn(async () => ({ room: { stateVersion: 4 }, isBank: true })),
      revokeSession: vi.fn(async () => ({ sessionId: 'session-2' })),
    };
    const games = {
      start: vi.fn(async () => ({ stateVersion: 5 })),
      snapshot: vi.fn(async () => ({ stateVersion: 5 })),
    };
    const app = await appModule.buildApiApp({
      accounts: accounts as unknown as AccountRoomService,
      games: games as unknown as PrismaGameService,
      logger: false,
    });
    openApps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const clients = ['cookie-1', 'cookie-2', 'cookie-3'].map((token) => createSocketClient(address, {
      extraHeaders: { Cookie: `${sessionCookieName}=${token}` }, forceNew: true, reconnection: false, transports: ['websocket'],
    }));
    openClients.push(...clients);
    await Promise.all(clients.map((client) => client.connected ? Promise.resolve() : event(client, 'connect')));

    const [first, target, otherRoom] = clients;
    first.emit('room.subscribe', { roomId: 'room-a' });
    target.emit('room.subscribe', { roomId: 'room-a' });
    otherRoom.emit('room.subscribe', { roomId: 'room-b' });
    await Promise.all(clients.map((client) => event<{ roomId: string }>(client, 'room.snapshot-required')));

    const firstInvalidation = event<{ roomId: string; stateVersion: number }>(first, 'room.snapshot-required', (payload) => payload.stateVersion === 5);
    const targetInvalidation = event<{ roomId: string; stateVersion: number }>(target, 'room.snapshot-required', (payload) => payload.stateVersion === 5);
    let otherRoomInvalidated = false;
    otherRoom.once('room.snapshot-required', (payload: { stateVersion?: number }) => { if (payload.stateVersion === 5) otherRoomInvalidated = true; });
    await app.inject({ method: 'POST', url: '/api/rooms/room-a/start', headers: { cookie: `${sessionCookieName}=cookie-1`, 'idempotency-key': 'versioned-start' } });
    await expect(firstInvalidation).resolves.toEqual({ roomId: 'room-a', stateVersion: 5 });
    await expect(targetInvalidation).resolves.toEqual({ roomId: 'room-a', stateVersion: 5 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(otherRoomInvalidated).toBe(false);

    const revoked = event<{ reason: string }>(target, 'account.session.revoked');
    const disconnected = event(target, 'disconnect');
    await app.inject({ method: 'DELETE', url: '/api/auth/sessions/session-2', headers: { cookie: `${sessionCookieName}=cookie-1` } });
    await expect(revoked).resolves.toEqual({ reason: 'USER_REVOKED' });
    await disconnected;
  });

  it('passes custom request versions directly to the notifier', async () => {
    const notifier = vi.fn();
    const accounts = {
      authenticate: vi.fn(async () => auth),
      authorizeRoomSession: vi.fn(async () => ({ isBank: false, player: { id: 'player-1' } })),
    };
    const games = {
      createRequest: vi.fn(async () => ({ id: 'request-1', stateVersion: 8 })),
      requestBankPayment: vi.fn(async () => ({ id: 'request-2', stateVersion: 9 })),
      consumeSkip: vi.fn(async () => ({ remainingSkipTurns: 0, stateVersion: 10 })),
    };
    const app = await appModule.buildApiApp({
      accounts: accounts as unknown as AccountRoomService,
      games: games as unknown as PrismaGameService,
      notifier,
      logger: false,
    });
    openApps.push(app);

    await app.inject({
      method: 'POST',
      url: '/api/rooms/room-a/requests',
      headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'request-version' },
      payload: { playerId: 'player-1', type: 'COMPANION_EVENT' },
    });
    const returned = await app.inject({
      method: 'POST',
      url: '/api/rooms/room-a/requests',
      headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'return-companion-version' },
      payload: { playerId: 'player-1', type: 'RETURN_COMPANION_EVENT' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/rooms/room-a/requests/bank-payment',
      headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'payment-version' },
      payload: { playerId: 'player-1', amount: 100 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/rooms/room-a/requests',
      headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'plot-rest-version' },
      payload: { playerId: 'player-1', type: 'PLOT_REST_EVENT', count: 3, reason: '养病留宫' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/rooms/room-a/bank/consume-skip-turn',
      headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'consume-three-version' },
      payload: { playerId: 'player-1', count: 3, reason: '实体回合已跳过' },
    });

    expect(returned.statusCode).toBe(200);
    expect(notifier).toHaveBeenNthCalledWith(1, 'room-a', 'room.updated', { stateVersion: 8 });
    expect(games.createRequest).toHaveBeenCalledWith(expect.anything(), 'room-a', 'player-1', { type: 'RETURN_COMPANION_EVENT' }, 'return-companion-version');
    expect(notifier).toHaveBeenNthCalledWith(2, 'room-a', 'room.updated', { stateVersion: 8 });
    expect(games.createRequest).toHaveBeenCalledWith(expect.anything(), 'room-a', 'player-1', { type: 'PLOT_REST_EVENT', count: 3, reason: '养病留宫' }, 'plot-rest-version');
    expect(games.consumeSkip).toHaveBeenCalledWith(expect.anything(), 'room-a', 'player-1', 3, 'consume-three-version', '实体回合已跳过');
    expect(notifier).toHaveBeenNthCalledWith(3, 'room-a', 'room.updated', { stateVersion: 9 });
    expect(notifier).toHaveBeenNthCalledWith(4, 'room-a', 'room.updated', { stateVersion: 8 });
    expect(notifier).toHaveBeenNthCalledWith(5, 'room-a', 'room.updated', { stateVersion: 10 });
  });
});
