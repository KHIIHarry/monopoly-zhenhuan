import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { isIP } from 'node:net';
import { Server } from 'socket.io';
import { z } from 'zod';
import { prisma } from '@zhenhuan/database';
import { AccountRoomService, type AuthenticatedSession } from './account-room-service.js';
import { authMeResponse, clearSessionCookie, loginBodySchema, passwordSchema, sessionCookie, sessionCookieName } from './auth-domain.js';
import { mapApiError, RuleError } from './api-error.js';
import { loadOriginPolicy } from './origin-policy.js';
import { parseRoomSubscriptionPayload, PrismaGameService } from './prisma-game-service.js';
import {
  buildFundToastDeliveries,
  buildLandingRejectionToastDelivery,
  buildRejectionToastDelivery,
  buildTransferApprovedToastDelivery,
  buildTransferFailureToastDelivery,
  buildTransferRequestedToastDelivery,
  type PostCommitToastNotifier,
  type ToastDelivery,
  type TransferFailureNotice,
} from './realtime-toast-notifications.js';
import { loadSecurityConfig } from './security-config.js';

type ApiDatabase = ConstructorParameters<typeof AccountRoomService>[0];
export type ApiNotifier = (roomId: string, event: string, payload?: Record<string, unknown>) => void;
type RoomSubscriptionSocket = {
  data: Record<string, unknown>;
  join: (roomId: string) => Promise<void> | void;
  leave: (roomId: string) => Promise<void> | void;
};
type SessionToastEmitter = {
  to: (channel: string) => { emit: (name: string, event: ToastDelivery['event']) => unknown };
};
type ToastBuilders = {
  funds: (database: ApiDatabase, transactionId: string) => Promise<ToastDelivery[]>;
  rejection: (database: ApiDatabase, requestId: string) => Promise<ToastDelivery | null>;
  landingRejection: (database: ApiDatabase, landingId: string, reason: string) => Promise<ToastDelivery | null>;
  transferRequested: (database: ApiDatabase, requestId: string) => Promise<ToastDelivery | null>;
  transferApproved: (database: ApiDatabase, requestId: string) => Promise<ToastDelivery | null>;
  transferFailed: (database: ApiDatabase, notice: TransferFailureNotice) => Promise<ToastDelivery | null>;
};

export const roomChannel = (roomId: string) => `room:${roomId}`;
export const sessionChannel = (sessionId: string) => `session:${sessionId}`;

export function createPostCommitToastNotifier(
  database: ApiDatabase,
  emitter: SessionToastEmitter,
  onError: (error: unknown, context: { roomId: string; sourceId: string; kind: 'FUNDS' | 'REQUEST_REJECTED' | 'TRANSFER_REQUESTED' | 'TRANSFER_APPROVED' | 'TRANSFER_FAILED' }) => void = () => undefined,
  builders: ToastBuilders = {
    funds: buildFundToastDeliveries,
    rejection: buildRejectionToastDelivery,
    landingRejection: buildLandingRejectionToastDelivery,
    transferRequested: buildTransferRequestedToastDelivery,
    transferApproved: buildTransferApprovedToastDelivery,
    transferFailed: buildTransferFailureToastDelivery,
  },
): PostCommitToastNotifier {
  const emit = (delivery: ToastDelivery) => {
    emitter.to(sessionChannel(delivery.sessionId)).emit('room.toast', delivery.event);
  };
  return {
    fundsCommitted: async (roomId, transactionId) => {
      try {
        for (const delivery of await builders.funds(database, transactionId)) emit(delivery);
      } catch (error) {
        onError(error, { roomId, sourceId: transactionId, kind: 'FUNDS' });
      }
    },
    requestRejected: async (roomId, requestId) => {
      try {
        const delivery = await builders.rejection(database, requestId);
        if (delivery) emit(delivery);
      } catch (error) {
        onError(error, { roomId, sourceId: requestId, kind: 'REQUEST_REJECTED' });
      }
    },
    landingRejected: async (roomId, landingId, reason) => {
      try {
        const delivery = await builders.landingRejection(database, landingId, reason);
        if (delivery) emit(delivery);
      } catch (error) {
        onError(error, { roomId, sourceId: landingId, kind: 'REQUEST_REJECTED' });
      }
    },
    transferRequested: async (roomId, requestId) => {
      try {
        const delivery = await builders.transferRequested(database, requestId);
        if (delivery) emit(delivery);
      } catch (error) {
        onError(error, { roomId, sourceId: requestId, kind: 'TRANSFER_REQUESTED' });
      }
    },
    transferApproved: async (roomId, requestId) => {
      try {
        const delivery = await builders.transferApproved(database, requestId);
        if (delivery) emit(delivery);
      } catch (error) {
        onError(error, { roomId, sourceId: requestId, kind: 'TRANSFER_APPROVED' });
      }
    },
    transferFailed: async (notice) => {
      try {
        const delivery = await builders.transferFailed(database, notice);
        if (delivery) emit(delivery);
      } catch (error) {
        const sourceId = notice.phase === 'SUBMISSION' ? notice.attemptId : notice.requestId;
        onError(error, { roomId: notice.roomId, sourceId, kind: 'TRANSFER_FAILED' });
      }
    },
  };
}

export async function replaceRoomSubscription(socket: RoomSubscriptionSocket, roomId: string | null) {
  const previousRoomId = typeof socket.data.subscribedRoomId === 'string' ? socket.data.subscribedRoomId : null;
  if (previousRoomId === roomId) {
    if (!roomId) delete socket.data.subscribedRoomId;
    return;
  }
  if (previousRoomId) await socket.leave(roomChannel(previousRoomId));
  delete socket.data.subscribedRoomId;
  if (!roomId) return;
  await socket.join(roomChannel(roomId));
  socket.data.subscribedRoomId = roomId;
}

export type BuildApiAppOptions = {
  accounts?: AccountRoomService;
  games?: PrismaGameService;
  database?: ApiDatabase;
  logger?: boolean;
  notifier?: ApiNotifier;
};

function socketClientIp(
  remoteAddress: string,
  forwardedFor: string | string[] | undefined,
  trustOneProxy: boolean,
) {
  if (!trustOneProxy) return remoteAddress;
  const value = Array.isArray(forwardedFor) ? forwardedFor.at(-1) : forwardedFor;
  const candidate = value?.split(',').at(-1)?.trim();
  return candidate && isIP(candidate) ? candidate : remoteAddress;
}

export async function buildApiApp(options: BuildApiAppOptions = {}) {
const database = options.database ?? prisma;
const trustOneProxy = process.env.NODE_ENV === 'production';
const app = Fastify({ logger: options.logger ?? true, trustProxy: trustOneProxy ? 1 : false });
const { originAllowed, secureCookie } = loadOriginPolicy(process.env);
app.addHook('onRequest', async (request, reply) => {
  if (request.headers.origin && !originAllowed(request.headers.origin)) return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
});
await app.register(cors, { origin: (origin, done) => done(null, originAllowed(origin)), credentials: true, methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'] });
const io = new Server(app.server, {
  cors: { origin: (origin, done) => done(null, originAllowed(origin)), credentials: true },
  allowRequest: (request, done) => done(null, originAllowed(request.headers.origin)),
});
const toastNotifier = createPostCommitToastNotifier(database, io, (error, context) => {
  app.log.error({ err: error, ...context }, 'Realtime Toast delivery failed');
});
const accounts = options.accounts ?? (() => {
  const security = loadSecurityConfig();
  return new AccountRoomService(database, (username) => security.superAdminUsernames.has(username), toastNotifier);
})();
const games = options.games ?? new PrismaGameService(database, Math.random, toastNotifier);

function cookieToken(header?: string) {
  const cookie = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`));
  return cookie ? decodeURIComponent(cookie.slice(sessionCookieName.length + 1)) : '';
}

function idempotencyKey(header?: string | string[]) {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new RuleError('IDEMPOTENCY_KEY_REQUIRED');
  return value;
}

const context = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] ?? 'Unknown' });
const authenticate = (request: FastifyRequest) => accounts.authenticate(cookieToken(request.headers.cookie), request.ip);
const emitInvalidation = (roomId: string, stateVersion: number) => io.to(roomChannel(roomId)).emit('room.snapshot-required', { roomId, stateVersion });
const notify: ApiNotifier = options.notifier ?? ((roomId, _event, payload = {}) => {
  if (typeof payload.stateVersion === 'number') {
    emitInvalidation(roomId, payload.stateVersion);
    return;
  }
  void database.room.findUnique({ where: { id: roomId }, select: { stateVersion: true } })
    .then((room) => { if (room) emitInvalidation(roomId, room.stateVersion); })
    .catch(() => undefined);
});
const notifyVersion = (roomId: string, result: object) => {
  const stateVersion = (result as { stateVersion?: unknown }).stateVersion;
  if (typeof stateVersion === 'number') notify(roomId, 'room.updated', { stateVersion });
};
const revokeSocketSession = (sessionId: string, reason: string) => {
  const channel = sessionChannel(sessionId);
  io.to(channel).emit('account.session.revoked', { reason });
  io.in(channel).disconnectSockets(true);
};
const removeSessionFromRoom = (sessionId: string, roomId: string, reason?: string) => {
  const sessionRoom = sessionChannel(sessionId);
  io.to(sessionRoom).emit('room.subscription-rejected', {
    roomId,
    ...(reason ? { reason } : {}),
  });
  io.in(sessionRoom).socketsLeave(roomChannel(roomId));
  for (const socket of io.sockets.sockets.values()) {
    if (socket.rooms.has(sessionRoom) && socket.data.subscribedRoomId === roomId) delete socket.data.subscribedRoomId;
  }
};

io.use((socket, next) => {
  const rawToken = cookieToken(socket.handshake.headers.cookie);
  const clientIp = socketClientIp(
    socket.handshake.address,
    socket.handshake.headers['x-forwarded-for'],
    trustOneProxy,
  );
  socket.data.clientIp = clientIp;
  void accounts.authenticate(rawToken, clientIp)
    .then((authenticated) => {
      socket.data.auth = authenticated;
      next();
    })
    .catch(() => next(new Error('SESSION_INVALID')));
});

async function player(auth: AuthenticatedSession, roomId: string, playerId: string) {
  const membership = await accounts.authorizeRoomSession(auth, roomId, 'PLAYER');
  if (membership.player?.id !== playerId) throw new RuleError('PLAYER_IDENTITY_MISMATCH');
  return membership;
}

async function bank(auth: AuthenticatedSession, roomId: string) { return accounts.authorizeRoomSession(auth, roomId, 'BANK'); }
const gameActor = (auth: AuthenticatedSession) => ({ accountId: auth.account.id, sessionId: auth.session.id });

app.setErrorHandler((error, request, reply) => {
  const mapped = mapApiError(error);
  if (!mapped.expose) request.log.error({ err: error }, 'Unhandled request error');
  reply.status(mapped.status).send(mapped.body);
});

app.get('/health', async () => ({ ok: true }));

app.post('/api/auth/login', async (request, reply) => {
  const body = loginBodySchema.parse(request.body);
  const result = await accounts.login(body.username, body.password, context(request));
  if (result.status === 'LIMIT') return reply.status(409).send({ error: 'SESSION_LIMIT_REACHED', devices: result.devices });
  reply.header('Set-Cookie', sessionCookie(result.rawToken, secureCookie));
  return { account: { id: result.account.id, username: result.account.username, displayName: result.account.displayName, isSuperAdmin: result.account.isSuperAdmin, canCreateRoom: result.account.canCreateRoom, lastLoginAt: result.account.lastLoginAt } };
});

app.post('/api/auth/login/replace-oldest-session', async (request, reply) => {
  const body = loginBodySchema.parse(request.body);
  const result = await accounts.replaceOldestSession(body.username, body.password, context(request));
  if (result.replacedSessionId) revokeSocketSession(result.replacedSessionId, 'REPLACED_BY_NEW_DEVICE');
  reply.header('Set-Cookie', sessionCookie(result.rawToken, secureCookie));
  return { account: { id: result.account.id, username: result.account.username, displayName: result.account.displayName, isSuperAdmin: result.account.isSuperAdmin, canCreateRoom: result.account.canCreateRoom, lastLoginAt: result.account.lastLoginAt } };
});

app.post('/api/auth/logout', async (request, reply) => {
  const auth = await authenticate(request);
  await accounts.revokeSession(auth, auth.session.id);
  revokeSocketSession(auth.session.id, 'LOGOUT');
  reply.header('Set-Cookie', clearSessionCookie(secureCookie));
  return { ok: true };
});

app.get('/api/auth/me', async (request) => {
  const auth = await authenticate(request);
  return authMeResponse(auth.account, await accounts.listSessions(auth), auth.session.id, auth.account.isSuperAdmin);
});
app.get('/api/auth/sessions', async (request) => accounts.listSessions(await authenticate(request)));
app.delete('/api/auth/sessions/:id', async (request) => {
  const auth = await authenticate(request);
  const { id } = z.object({ id: z.string() }).parse(request.params);
  await accounts.revokeSession(auth, id);
  revokeSocketSession(id, 'USER_REVOKED');
  return { ok: true };
});
app.post('/api/auth/sessions/logout-others', async (request) => {
  const result = await accounts.logoutOthers(await authenticate(request));
  for (const sessionId of result.revokedSessionIds) revokeSocketSession(sessionId, 'LOGOUT_OTHERS');
  return { revoked: result.revoked };
});

app.get('/api/admin/accounts', async (request) => {
  const auth = await authenticate(request);
  const query = z.object({ query: z.string().trim().min(1).max(100).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), permission: z.enum(['isSuperAdmin', 'canCreateRoom']).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
  return accounts.listAccounts(auth, query);
});
app.post('/api/admin/accounts', async (request) => {
  const auth = await authenticate(request);
  const body = z.object({ username: z.string().trim().min(3).max(80), password: z.string().min(8).max(200), displayName: z.string().trim().min(1).max(40), canCreateRoom: z.boolean().optional(), note: z.string().max(300).optional() }).strict().parse(request.body);
  return accounts.createAccount(auth, body, idempotencyKey(request.headers['idempotency-key']));
});
app.patch('/api/admin/accounts/:id', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ displayName: z.string().trim().min(1).max(40).optional(), canCreateRoom: z.boolean().optional(), note: z.string().max(300).nullable().optional() }).strict().parse(request.body);
  return accounts.updateAccount(auth, id, body, idempotencyKey(request.headers['idempotency-key']));
});
app.post('/api/admin/accounts/:id/reset-password', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const { password } = z.object({ password: passwordSchema }).parse(request.body);
  const result = await accounts.resetPassword(auth, id, password, idempotencyKey(request.headers['idempotency-key']));
  for (const sessionId of result.revokedSessionIds ?? []) revokeSocketSession(sessionId, 'PASSWORD_RESET');
  return result;
});
app.post('/api/admin/accounts/:id/disable', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const result = await accounts.setAccountStatus(auth, id, false, idempotencyKey(request.headers['idempotency-key']));
  for (const sessionId of result.revokedSessionIds ?? []) revokeSocketSession(sessionId, 'ACCOUNT_DISABLED');
  return result;
});
app.post('/api/admin/accounts/:id/enable', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); return accounts.setAccountStatus(auth, id, true, idempotencyKey(request.headers['idempotency-key'])); });
app.delete('/api/admin/accounts/:id', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const result = await accounts.deleteAccount(auth, id, idempotencyKey(request.headers['idempotency-key']));
  if (result.created) for (const sessionId of result.revokedSessionIds) revokeSocketSession(sessionId, 'ACCOUNT_DELETED');
  return { deleted: true, id: result.id };
});
app.get('/api/admin/accounts/:accountId/sessions', async (request) => {
  const auth = await authenticate(request); const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
  const query = z.object({ state: z.enum(['active', 'recent']).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
  return accounts.listAccountSessions(auth, accountId, query);
});
app.post('/api/admin/accounts/:accountId/sessions/:sessionId/revoke', async (request) => {
  const auth = await authenticate(request); const { accountId, sessionId } = z.object({ accountId: z.string(), sessionId: z.string() }).parse(request.params);
  const { reason } = z.object({ reason: z.string().trim().min(1).max(300) }).parse(request.body);
  const result = await accounts.revokeAccountSession(auth, accountId, sessionId, reason, idempotencyKey(request.headers['idempotency-key']));
  if (result.created) revokeSocketSession(sessionId, reason);
  return result.value;
});
app.get('/api/admin/dashboard', async (request) => accounts.dashboard(await authenticate(request)));
app.get('/api/admin/security-logs', async (request) => {
  const auth = await authenticate(request);
  const query = z.object({ action: z.string().trim().min(1).max(100).optional(), actorAccountId: z.string().optional(), accountId: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
  return accounts.listSecurityLogs(auth, query);
});

app.get('/api/admin/rooms', async (request) => {
  const auth = await authenticate(request);
  const query = z.object({ query: z.string().trim().min(1).max(100).optional(), status: z.enum(['LOBBY', 'PLAYING', 'FINISHED']).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
  return accounts.listAdminRooms(auth, query);
});
app.get('/api/admin/rooms/:id', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); return accounts.getAdminRoom(auth, id); });
app.patch('/api/admin/rooms/:id', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ name: z.string().trim().min(1).max(40).optional(), visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(), diceMode: z.enum(['ELECTRONIC', 'PHYSICAL']).optional(), skillEnabled: z.boolean().optional(), startReward: z.number().int().nonnegative().optional(), redemptionFee: z.number().int().nonnegative().optional(), allowMidgameJoin: z.boolean().optional(), transferApprovalRequired: z.boolean().optional(), initialBalance: z.number().int().nonnegative().optional() }).strict().refine((value) => Object.keys(value).length > 0).parse(request.body);
  const result = await accounts.updateAdminRoom(auth, id, body, idempotencyKey(request.headers['idempotency-key']));
  notifyVersion(id, result);
  return result;
});
app.post('/api/admin/rooms/:id/password', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const { password } = z.object({ password: z.string().trim().min(1).max(100).nullable() }).strict().parse(request.body);
  const result = await accounts.updateAdminRoomPassword(auth, id, password, idempotencyKey(request.headers['idempotency-key']));
  notifyVersion(id, result);
  return result;
});
app.post('/api/admin/rooms/:id/members/:memberId/remove', async (request) => {
  const auth = await authenticate(request); const { id, memberId } = z.object({ id: z.string(), memberId: z.string() }).parse(request.params); z.object({}).strict().parse(request.body ?? {});
  const result = await accounts.removeAdminRoomMember(auth, id, memberId, idempotencyKey(request.headers['idempotency-key']), ({ removedSessionId }) => removeSessionFromRoom(removedSessionId, id));
  notifyVersion(id, result);
  return result;
});
app.post('/api/admin/rooms/:id/bank/reassign', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { targetMembershipId } = z.object({ targetMembershipId: z.string() }).strict().parse(request.body);
  const result = await accounts.reassignAdminRoomBank(auth, id, targetMembershipId, idempotencyKey(request.headers['idempotency-key']));
  notifyVersion(id, result);
  return result;
});
app.get('/api/admin/rooms/:id/audit-logs', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const query = z.object({ action: z.string().trim().min(1).max(100).optional(), actorMemberId: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
  return accounts.listRoomAuditLogs(auth, id, query);
});

app.get('/api/rooms', async (request) => accounts.listRooms(await authenticate(request)));
app.get('/api/rooms/mine', async (request) => (await accounts.listRooms(await authenticate(request))).filter((room) => room.mine && !['ENDED', 'FINISHED', 'CLOSED'].includes(room.status)));
app.get('/api/rooms/history', async (request) => (await accounts.listRooms(await authenticate(request))).filter((room) => room.mine && ['ENDED', 'FINISHED', 'CLOSED'].includes(room.status)));
app.post('/api/rooms', async (request) => {
  const auth = await authenticate(request);
  const body = z.object({ name: z.string().trim().min(1).max(40), password: z.string().max(100).optional(), initialBalance: z.number().int().nonnegative(), diceMode: z.enum(['ELECTRONIC', 'PHYSICAL']), skillEnabled: z.boolean().default(true), startReward: z.number().int().nonnegative().default(1000), redemptionFee: z.number().int().nonnegative().default(200), allowMidgameJoin: z.boolean().default(false), visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'), transferApprovalRequired: z.boolean().default(false) }).parse(request.body);
  return accounts.createRoom(auth, body, idempotencyKey(request.headers['idempotency-key']));
});
app.post('/api/rooms/:id/join', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ password: z.string().max(100).optional(), characterId: z.string().optional() }).strict().parse(request.body ?? {});
  const result = await accounts.joinRoom(auth, id, body, idempotencyKey(request.headers['idempotency-key']));
  notifyVersion(id, result);
  return result;
});
app.get('/api/rooms/:id/seats', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); return accounts.seats(auth, id); });
app.post('/api/rooms/:id/select-character', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { characterId } = z.object({ characterId: z.string() }).parse(request.body);
  const result = await accounts.selectCharacter(auth, id, characterId, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result;
});
app.post('/api/rooms/:id/select-bank', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const result = await accounts.selectBank(auth, id, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result;
});
app.post('/api/rooms/:id/take-control', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const result = await accounts.takeControl(auth, id, idempotencyKey(request.headers['idempotency-key']), ({ displacedSessionId }) => {
    io.to(sessionChannel(displacedSessionId)).emit('room.control.changed', { roomId: id });
    removeSessionFromRoom(displacedSessionId, id);
  });
  notifyVersion(id, result);
  return result;
});

app.post('/api/rooms/:id/role-swap-requests', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.union([z.object({ targetCharacterId: z.string() }).strict(), z.object({ targetRole: z.literal('BANK') }).strict()]).parse(request.body); const result = 'targetRole' in body ? await accounts.requestBankSwap(auth, id, idempotencyKey(request.headers['idempotency-key'])) : await accounts.requestRoleSwap(auth, id, body.targetCharacterId, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/role-swap-requests/:id/accept', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const result = await accounts.acceptRoleSwap(auth, id, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(result.roomId, result); return result; });
app.post('/api/role-swap-requests/:id/reject', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { reason } = z.object({ reason: z.string().trim().min(1) }).parse(request.body); const result = await accounts.resolveRoleSwap(auth, id, 'REJECT', idempotencyKey(request.headers['idempotency-key']), reason); notifyVersion(result.roomId, result); return result; });
app.post('/api/role-swap-requests/:id/approve-bank', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const result = await accounts.resolveRoleSwap(auth, id, 'APPROVE_BANK', idempotencyKey(request.headers['idempotency-key'])); notifyVersion(result.roomId, result); return result; });
app.post('/api/role-swap-requests/:id/cancel', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const result = await accounts.resolveRoleSwap(auth, id, 'CANCEL', idempotencyKey(request.headers['idempotency-key'])); notifyVersion(result.roomId, result); return result; });

app.post('/api/rooms/:id/settlement/preview', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); return accounts.previewSettlement(auth, id); });
app.post('/api/rooms/:id/finish', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { confirmation } = z.object({ confirmation: z.string() }).parse(request.body); const result = await accounts.finishRoom(auth, id, { mode: 'NORMAL', confirmation }, idempotencyKey(request.headers['idempotency-key'])); if (result.created) notifyVersion(id, result.settlement); return result; });
app.get('/api/rooms/:id/settlement', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); return accounts.getSettlement(auth, id); });
app.post('/api/admin/rooms/:id/settlement/preview', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); return accounts.previewSettlement(auth, id, 'ADMIN'); });
app.get('/api/admin/rooms/:id/settlement', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); return accounts.getSettlement(auth, id, 'ADMIN'); });
app.post('/api/admin/rooms/:id/finish', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { reason } = z.object({ reason: z.string().trim().min(1) }).parse(request.body); const result = await accounts.finishRoom(auth, id, { mode: 'FORCED', reason }, idempotencyKey(request.headers['idempotency-key'])); if (result.created) notifyVersion(id, result.settlement); return result; });
app.delete('/api/admin/rooms/:id', async (request) => {
  const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params);
  const result = await accounts.deleteRoom(auth, id, idempotencyKey(request.headers['idempotency-key']));
  if (result.created) notifyVersion(id, result);
  return { deleted: true, id: result.id };
});

app.get('/api/rooms/:id/snapshot', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { view } = z.object({ view: z.enum(['PLAYER', 'BANK']).optional() }).parse(request.query); await accounts.authorizeRoomSession(auth, id); return games.snapshot(gameActor(auth), id, view); });
app.post('/api/rooms/:id/start', async (request) => {
  const auth = await authenticate(request);
  const { id } = z.object({ id: z.string() }).parse(request.params);
  await bank(auth, id);
  const result = await games.start(
    gameActor(auth),
    id,
    idempotencyKey(request.headers['idempotency-key']),
    ({ removedSessionIds }) => {
      for (const sessionId of removedSessionIds) {
        removeSessionFromRoom(sessionId, id, 'ROOM_STARTED_WITHOUT_CAPABILITY');
      }
    },
  );
  notifyVersion(id, result);
  return games.snapshot(gameActor(auth), id, 'BANK');
});
app.post('/api/rooms/:id/landings', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ playerId: z.string(), propertyName: z.string() }).parse(request.body); await player(auth, id, body.playerId); const result = await games.declareLanding(gameActor(auth), id, body.playerId, body.propertyName, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/landings/start', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ playerId: z.string(), landingId: z.string() }).parse(request.body); await player(auth, id, body.playerId); const result = await games.declareStartLanding(gameActor(auth), id, body.playerId, body.landingId, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/landings/:landingId/confirm', async (request) => { const auth = await authenticate(request); const params = z.object({ id: z.string(), landingId: z.string() }).parse(request.params); await bank(auth, params.id); const body = z.object({ plotResolved: z.boolean().default(true) }).parse(request.body ?? {}); const result = await games.confirmLanding(gameActor(auth), params.id, params.landingId, body.plotResolved, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(params.id, result); return result; });
app.post('/api/rooms/:id/landings/:landingId/cancel-property-actions', async (request) => { const auth = await authenticate(request); const params = z.object({ id: z.string(), landingId: z.string() }).parse(request.params); await bank(auth, params.id); const { reason } = z.object({ reason: z.string().min(1) }).parse(request.body); const result = await games.cancelLandingPropertyActions(gameActor(auth), params.id, params.landingId, reason, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(params.id, result); return result; });
app.post('/api/rooms/:id/requests', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ playerId: z.string(), type: z.enum(['BUY_PROPERTY','BUILD_PROPERTY','SELL_BUILDING','MORTGAGE_PROPERTY','REDEEM_PROPERTY','SELL_PROPERTY_TO_BANK','TRADE_PROPERTY','START_REWARD','COLD_PALACE_EVENT','COMPANION_EVENT','RETURN_COMPANION_EVENT','PLOT_REST_EVENT','CONSUME_SKIP_TURNS']), propertyName: z.string().optional(), targetPlayerId: z.string().optional(), amount: z.number().int().nonnegative().optional(), count: z.number().int().positive().optional(), landingId: z.string().optional(), reason: z.string().trim().min(1).optional() }).parse(request.body); await player(auth, id, body.playerId); const { playerId, ...action } = body; const result = await games.createRequest(gameActor(auth), id, playerId, action, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/transfers', async (request) => {
  const auth = await authenticate(request);
  const { id } = z.object({ id: z.string() }).parse(request.params);
  const body = z.discriminatedUnion('recipientType', [
    z.object({ fromPlayerId: z.string(), recipientType: z.literal('PLAYER'), toPlayerId: z.string(), amount: z.number().int().positive(), isPlotFine: z.boolean().default(false) }).strict(),
    z.object({ fromPlayerId: z.string(), recipientType: z.literal('BANK'), amount: z.number().int().positive(), isPlotFine: z.boolean().default(false) }).strict(),
  ]).parse(request.body);
  await player(auth, id, body.fromPlayerId);
  const result = await games.transfer(gameActor(auth), id, body, idempotencyKey(request.headers['idempotency-key']));
  notifyVersion(id, result);
  return result;
});
app.post('/api/rooms/:id/properties/:name/buy', async (request) => { const auth = await authenticate(request); const params = z.object({ id: z.string(), name: z.string() }).parse(request.params); const { playerId } = z.object({ playerId: z.string() }).parse(request.body); await player(auth, params.id, playerId); const result = await games.createRequest(gameActor(auth), params.id, playerId, { type: 'BUY_PROPERTY', propertyName: decodeURIComponent(params.name) }, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(params.id, result); return result; });
app.post('/api/rooms/:id/properties/:name/build', async (request) => { const auth = await authenticate(request); const params = z.object({ id: z.string(), name: z.string() }).parse(request.params); const { playerId } = z.object({ playerId: z.string() }).parse(request.body); await player(auth, params.id, playerId); const result = await games.createRequest(gameActor(auth), params.id, playerId, { type: 'BUILD_PROPERTY', propertyName: decodeURIComponent(params.name) }, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(params.id, result); return result; });
app.post('/api/rooms/:id/properties/:name/toll', async (request) => { const auth = await authenticate(request); const params = z.object({ id: z.string(), name: z.string() }).parse(request.params); const { playerId } = z.object({ playerId: z.string() }).parse(request.body); await player(auth, params.id, playerId); const result = await games.payToll(gameActor(auth), params.id, playerId, decodeURIComponent(params.name), idempotencyKey(request.headers['idempotency-key'])); notifyVersion(params.id, result); return result; });
app.post('/api/rooms/:id/turn/roll', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { playerId } = z.object({ playerId: z.string() }).parse(request.body); await player(auth, id, playerId); const result = await games.roll(gameActor(auth), id, playerId, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/turn/end', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { playerId } = z.object({ playerId: z.string() }).parse(request.body); await player(auth, id, playerId); const result = await games.endTurn(gameActor(auth), id, playerId, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/turn/skip', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { playerId } = z.object({ playerId: z.string() }).parse(request.body); await player(auth, id, playerId); const result = await games.skipTurn(gameActor(auth), id, playerId, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/requests/bank-payment', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ playerId: z.string(), amount: z.number().int().positive() }).parse(request.body); await player(auth, id, body.playerId); const result = await games.requestBankPayment(gameActor(auth), id, body.playerId, body.amount, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/requests/:requestId/approve', async (request) => { const auth = await authenticate(request); const params = z.object({ id: z.string(), requestId: z.string() }).parse(request.params); await bank(auth, params.id); const result = await games.approve(gameActor(auth), params.id, params.requestId, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(params.id, result); return result; });
app.post('/api/rooms/:id/requests/:requestId/confirm-trade', async (request) => { const auth = await authenticate(request); const params = z.object({ id: z.string(), requestId: z.string() }).parse(request.params); const { playerId } = z.object({ playerId: z.string() }).parse(request.body); await player(auth, params.id, playerId); const result = await games.confirmTrade(gameActor(auth), params.id, params.requestId, playerId, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(params.id, result); return result; });
app.post('/api/rooms/:id/requests/:requestId/reject', async (request) => { const auth = await authenticate(request); const params = z.object({ id: z.string(), requestId: z.string() }).parse(request.params); await bank(auth, params.id); const { reason } = z.object({ reason: z.string().min(1) }).parse(request.body); const result = await games.reject(gameActor(auth), params.id, params.requestId, reason, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(params.id, result); return result; });
app.post('/api/rooms/:id/bank/adjust-balance', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); await bank(auth, id); const body = z.object({ playerId: z.string(), amount: z.number().int().refine((value) => value !== 0), reason: z.string().min(1) }).parse(request.body); const result = await games.adjustBalance(gameActor(auth), id, body.playerId, body.amount, body.reason, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/bank/adjust-property', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); await bank(auth, id); const body = z.object({ propertyName: z.string(), ownerPlayerId: z.string().nullable().optional(), buildingLevel: z.number().int().min(0).max(5).optional(), mortgaged: z.boolean().optional(), reason: z.string().min(1) }).parse(request.body); const { propertyName, reason, ...change } = body; const result = await games.adjustProperty(gameActor(auth), id, propertyName, change, reason, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/bank/add-skip-turns', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); await bank(auth, id); const body = z.object({ playerId: z.string(), count: z.number().int().positive(), source: z.enum(['PLOT_REST','COLD_PALACE','MANUAL']), reason: z.string().trim().min(1) }).parse(request.body); const result = await games.addSkipTurns(gameActor(auth), id, body.playerId, body.count, body.source, idempotencyKey(request.headers['idempotency-key']), body.reason); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/bank/consume-skip-turn', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); await bank(auth, id); const body = z.object({ playerId: z.string(), count: z.number().int().positive(), reason: z.string().trim().min(1) }).parse(request.body); const result = await games.consumeSkip(gameActor(auth), id, body.playerId, body.count, idempotencyKey(request.headers['idempotency-key']), body.reason); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/turn/invalidate-roll', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); await bank(auth, id); const { reason } = z.object({ reason: z.string().min(1) }).parse(request.body); const result = await games.invalidateRoll(gameActor(auth), id, reason, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/turn/force-next', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); await bank(auth, id); const { reason } = z.object({ reason: z.string().min(1) }).parse(request.body); const result = await games.forceNext(gameActor(auth), id, reason, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/events/cold-palace', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ playerId: z.string(), count: z.number().int().positive() }).parse(request.body); await player(auth, id, body.playerId); const result = await games.createRequest(gameActor(auth), id, body.playerId, { type: 'COLD_PALACE_EVENT', count: body.count }, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/events/plot-fine', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); await bank(auth, id); const body = z.object({ playerId: z.string(), amount: z.number().int().positive() }).parse(request.body); const result = await games.plotFine(gameActor(auth), id, body.playerId, body.amount, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/events/companion-acquired', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); const { playerId } = z.object({ playerId: z.string() }).parse(request.body); await player(auth, id, playerId); const result = await games.createRequest(gameActor(auth), id, playerId, { type: 'COMPANION_EVENT' }, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });
app.post('/api/rooms/:id/transactions/reverse-latest', async (request) => { const auth = await authenticate(request); const { id } = z.object({ id: z.string() }).parse(request.params); await bank(auth, id); const body = z.object({ transactionId: z.string().min(1), reason: z.string().min(1) }).parse(request.body); const result = await games.reverseLatest(gameActor(auth), id, body.transactionId, body.reason, idempotencyKey(request.headers['idempotency-key'])); notifyVersion(id, result); return result; });

io.on('connection', (socket) => {
  const rawToken = cookieToken(socket.handshake.headers.cookie);
  const clientIp = typeof socket.data.clientIp === 'string' ? socket.data.clientIp : socket.handshake.address;
  const connectedAuth = socket.data.auth as AuthenticatedSession;
  let roomSubscriptionIntent = 0;
  let roomSubscriptionCommit: Promise<void> = Promise.resolve();
  const commitRoomSubscription = (commit: () => Promise<void>) => {
    const result = roomSubscriptionCommit.then(commit);
    roomSubscriptionCommit = result.catch(() => undefined);
    return result;
  };
  const subscribedRoomId = () => typeof socket.data.subscribedRoomId === 'string' ? socket.data.subscribedRoomId : null;
  const applyRoomSubscriptionIntent = async (intent: number, roomId: string | null) => {
    if (intent !== roomSubscriptionIntent) return false;
    await replaceRoomSubscription(socket, roomId);
    if (intent === roomSubscriptionIntent) return true;
    await replaceRoomSubscription(socket, null);
    return false;
  };
  void socket.join(sessionChannel(connectedAuth.session.id));
  socket.on('room.subscribe', (payload: unknown) => {
    const subscription = parseRoomSubscriptionPayload(payload);
    if (!subscription) { socket.emit('room.subscription-rejected', {}); return; }
    const intent = ++roomSubscriptionIntent;
    void accounts.authenticate(rawToken, clientIp)
      .then((auth) => accounts.authorizeRoomSession(auth, subscription.roomId))
      .then((membership) => commitRoomSubscription(async () => {
        if (await applyRoomSubscriptionIntent(intent, subscription.roomId)) {
          socket.emit('room.snapshot-required', { roomId: subscription.roomId, stateVersion: membership.room.stateVersion });
        }
      }))
      .catch(() => {
        if (intent !== roomSubscriptionIntent) return;
        void commitRoomSubscription(async () => {
          if (intent !== roomSubscriptionIntent) return;
          await replaceRoomSubscription(socket, null);
          if (intent === roomSubscriptionIntent) socket.emit('room.subscription-rejected', { roomId: subscription.roomId });
        }).catch(() => {
          if (intent === roomSubscriptionIntent) socket.emit('room.subscription-rejected', { roomId: subscription.roomId });
        });
      });
  });
  socket.on('room.unsubscribe', (payload: unknown) => {
    const subscription = parseRoomSubscriptionPayload(payload);
    if (!subscription) { socket.emit('room.subscription-rejected', {}); return; }
    const intent = ++roomSubscriptionIntent;
    void commitRoomSubscription(async () => {
      if (intent !== roomSubscriptionIntent || subscribedRoomId() !== subscription.roomId) return;
      await applyRoomSubscriptionIntent(intent, null);
    }).catch(() => undefined);
  });
});

return app;
}
