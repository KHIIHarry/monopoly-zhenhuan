import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { roll2d6 } from '@zhenhuan/shared';
import { z } from 'zod';
import { RuleError } from './api-error.js';
import type { PostCommitToastNotifier } from './realtime-toast-notifications.js';

export type GameActor = { accountId: string; sessionId: string };
export type SnapshotView = 'PLAYER' | 'BANK';
export type TransferInput = {
  fromPlayerId: string;
  recipientType: 'PLAYER' | 'BANK';
  toPlayerId?: string;
  amount: number;
  isPlotFine: boolean;
};
type RequestAction = {
  type: 'BUY_PROPERTY' | 'BUILD_PROPERTY' | 'SELL_BUILDING' | 'MORTGAGE_PROPERTY' | 'REDEEM_PROPERTY' | 'SELL_PROPERTY_TO_BANK' | 'TRADE_PROPERTY' | 'START_REWARD' | 'COLD_PALACE_EVENT' | 'COMPANION_EVENT' | 'RETURN_COMPANION_EVENT' | 'PLOT_REST_EVENT' | 'CONSUME_SKIP_TURNS';
  propertyName?: string; targetPlayerId?: string; amount?: number; count?: number; landingId?: string; reason?: string;
};

const lockedPropertyTypes = new Set(['BUY_PROPERTY', 'BUILD_PROPERTY', 'SELL_BUILDING', 'MORTGAGE_PROPERTY', 'REDEEM_PROPERTY', 'SELL_PROPERTY_TO_BANK', 'TRADE_PROPERTY']);
const turnBoundPropertyTypes = new Set(['BUY_PROPERTY', 'BUILD_PROPERTY']);
const skipTurnSources = new Set(['PLOT_REST', 'COLD_PALACE', 'MANUAL']);
const RETURN_COMPANION_REWARD = 500;
const nonReversibleRequestTypes = new Set(['COMPANION_EVENT', 'COLD_PALACE_EVENT', 'RETURN_COMPANION_EVENT']);
function fail(code: string): never { throw new RuleError(code); }
function isSerializationConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  const sqlState = typeof error.meta?.code === 'string' ? error.meta.code : null;
  return error.code === 'P2010' && (sqlState === '40001' || sqlState === '40P01');
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const asObject = (value: Prisma.JsonValue | null | undefined) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const int = (value: unknown, fallback = 0) => Number.isInteger(value) ? value as number : fallback;
const roomSubscriptionSchema = z.object({ roomId: z.string().min(1) });

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

const requestFingerprint = (value: unknown) => hash(JSON.stringify(canonicalValue(value)));

export function parseRoomSubscriptionPayload(payload: unknown) {
  const parsed = roomSubscriptionSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export class PrismaGameService {
  constructor(
    private readonly db: PrismaClient,
    private readonly random: () => number = Math.random,
    private readonly toastNotifier?: PostCommitToastNotifier,
  ) {}

  private async playablePlayers(tx: Prisma.TransactionClient, roomId: string, playerIds?: string[]) {
    const candidates = await tx.player.findMany({
      where: {
        roomId,
        status: 'ACTIVE',
        characterId: { not: null },
        ...(playerIds ? { id: { in: playerIds } } : {}),
        member: { roomId, status: 'ACTIVE', characterId: { not: null } },
      },
      include: { member: true, character: true },
      orderBy: [{ turnOrder: 'asc' }, { id: 'asc' }],
    });
    return candidates.filter((player) => player.characterId === player.member.characterId);
  }

  private async requirePlayablePlayer(tx: Prisma.TransactionClient, roomId: string, playerId: string, code = 'PLAYER_NOT_FOUND') {
    const [player] = await this.playablePlayers(tx, roomId, [playerId]);
    return player ?? fail(code);
  }

  private async requirePlayablePlayers(tx: Prisma.TransactionClient, roomId: string, playerIds: string[]) {
    const uniqueIds = [...new Set(playerIds)];
    const players = await this.playablePlayers(tx, roomId, uniqueIds);
    if (players.length !== uniqueIds.length) fail('PLAYER_NOT_FOUND');
    return players;
  }

  private async requireRequestParticipants(tx: Prisma.TransactionClient, roomId: string, requestId: string) {
    const request = await tx.gameRequest.findFirst({
      where: { id: requestId, roomId },
      select: { actorPlayerId: true, targetPlayerId: true },
    });
    if (!request) fail('REQUEST_NOT_FOUND');
    const playerIds = [request.actorPlayerId, request.targetPlayerId].filter((id): id is string => id !== null);
    if (playerIds.length) await this.requirePlayablePlayers(tx, roomId, playerIds);
  }

  private async requirePlayableTollOwner(tx: Prisma.TransactionClient, roomId: string, payerId: string, propertyName: string) {
    const property = await tx.roomProperty.findFirst({
      where: { roomId, definition: { name: propertyName } },
      select: { ownerPlayerId: true },
    });
    if (property?.ownerPlayerId && property.ownerPlayerId !== payerId) {
      await this.requirePlayablePlayer(tx, roomId, property.ownerPlayerId, 'NO_TOLL_DUE');
    }
  }

  private async requirePlayableAdjustedPropertyOwner(
    tx: Prisma.TransactionClient,
    roomId: string,
    propertyName: string,
    requestedOwnerPlayerId: string | null | undefined,
  ) {
    const property = await tx.roomProperty.findFirst({
      where: { roomId, definition: { name: propertyName } },
      select: { ownerPlayerId: true },
    });
    const ownerPlayerIds = [property?.ownerPlayerId, requestedOwnerPlayerId]
      .filter((playerId): playerId is string => playerId !== null && playerId !== undefined);
    if (ownerPlayerIds.length) await this.requirePlayablePlayers(tx, roomId, ownerPlayerIds);
  }

  async snapshot(actor: GameActor, roomId: string, requestedView?: SnapshotView) {
    return this.db.$transaction(async (tx) => {
      await this.lockRoom(tx, roomId);
      const membership = await this.authorizeActor(tx, actor, roomId);
      const hasPlayableIdentity = membership.characterId !== null
        && membership.player?.status === 'ACTIVE'
        && membership.player.characterId === membership.characterId;
      const capabilities = [hasPlayableIdentity ? 'PLAYER' : null, membership.isBank ? 'BANK' : null].filter(Boolean) as SnapshotView[];
      const view = requestedView ?? (capabilities.length === 1 ? capabilities[0] : fail('SNAPSHOT_VIEW_REQUIRED'));
      if (!capabilities.includes(view)) fail(view === 'BANK' ? 'BANK_REQUIRED' : 'PLAYER_IDENTITY_MISMATCH');
      const viewer = view === 'BANK' ? { role: 'BANK' as const } : { role: 'PLAYER' as const, playerId: membership.player!.id };
      const room = await tx.room.findUnique({ where: { id: roomId }, include: {
      properties: { include: { definition: true } },
      turns: { where: { status: 'ACTIVE' }, orderBy: { turnNumber: 'desc' }, take: 1 },
      ledgerEntries: { where: viewer.role === 'PLAYER' ? { playerId: viewer.playerId } : undefined, orderBy: { createdAt: 'desc' }, take: 100 },
      requests: { where: viewer.role === 'PLAYER' ? { OR: [{ actorPlayerId: viewer.playerId }, { targetPlayerId: viewer.playerId }] } : { status: { not: 'PENDING' } }, orderBy: { createdAt: 'desc' }, take: 100, include: { property: { include: { definition: true } } } },
      landingEvents: { where: { status: { in: ['DECLARED', 'CONFIRMED'] } }, orderBy: { declaredAt: 'desc' }, take: 30, include: { property: { include: { definition: true } } } },
      skipTurnEntries: { where: { remainingCount: { gt: 0 }, blocksTollCollection: true }, select: { playerId: true } },
      auditLogs: { orderBy: { createdAt: 'desc' }, take: 100 }
    } });
    if (!room) fail('ROOM_NOT_FOUND');
    const players = await this.playablePlayers(tx, roomId);
    if (viewer.role === 'PLAYER' && !players.some((player) => player.id === viewer.playerId)) fail('UNAUTHORIZED');
    const playablePlayerIds = new Set(players.map((player) => player.id));
    const activeTurn = room.turns[0] && playablePlayerIds.has(room.turns[0].playerId) ? room.turns[0] : undefined;
    const pendingRequests = viewer.role === 'BANK'
      ? await tx.gameRequest.findMany({ where: { roomId, status: 'PENDING' }, orderBy: { createdAt: 'desc' }, include: { property: { include: { definition: true } } } })
      : [];
    const reversal = viewer.role === 'BANK'
      ? await this.findReversalCandidate(tx, roomId)
      : null;
    const visibleLedger = viewer.role === 'BANK' ? room.ledgerEntries : room.ledgerEntries.filter((entry) => entry.playerId === viewer.playerId);
    const visibleRequests = viewer.role === 'BANK' ? [...pendingRequests, ...room.requests] : room.requests.filter((request) => request.actorPlayerId === viewer.playerId || request.targetPlayerId === viewer.playerId);
    const tollBlockedPlayerIds = new Set(room.skipTurnEntries.map((entry) => entry.playerId));
    const tollSettlementStates = new Map(await Promise.all(room.landingEvents
      .filter((landing) => landing.status === 'CONFIRMED')
      .map(async (landing) => [landing.id, (await this.tollSettlementState(tx, roomId, landing.id)).status] as const)));
      return {
      id: room.id, code: room.code, name: room.name, status: room.status, stateVersion: room.stateVersion, diceMode: room.diceMode, redemptionFee: room.redemptionFee, startReward: room.startReward,
      currentPlayerId: room.currentTurnPlayerId && playablePlayerIds.has(room.currentTurnPlayerId) ? room.currentTurnPlayerId : null,
      players: players.map((player) => ({
        id: player.id, name: player.member.displayNameSnapshot, characterId: player.characterId, balance: player.balance,
        remainingSkipTurns: player.remainingSkipTurns, version: player.version,
        tollCollectionBlocked: tollBlockedPlayerIds.has(player.id),
        companionCashReward: room.skillEnabled && player.character?.skillCode === 'COMPANION_REWARD' ? int(asObject(player.character.skillConfig).cashReward) : 0,
        buildDiscount: room.skillEnabled && player.character?.skillCode === 'BUILD_DISCOUNT' ? int(asObject(player.character.skillConfig).discount) : 0,
        tollBonus: room.skillEnabled && player.character?.skillCode === 'TOLL_BONUS' ? int(asObject(player.character.skillConfig).bonus) : 0,
        plotFineReduction: room.skillEnabled && player.character?.skillCode === 'PLOT_FINE_REDUCTION' ? int(asObject(player.character.skillConfig).reduction) : 0,
        coldPalaceSkipReduction: room.skillEnabled && player.character?.skillCode === 'COLD_PALACE_RELIEF' ? int(asObject(player.character.skillConfig).skipTurnsReduction) : 0,
        coldPalaceCashReward: room.skillEnabled && player.character?.skillCode === 'COLD_PALACE_RELIEF' ? int(asObject(player.character.skillConfig).cashReward) : 0,
      })),
      properties: room.properties.sort((a, b) => a.definition.displayOrder - b.definition.displayOrder).map((property) => ({
        id: property.id, name: property.definition.name, ownerId: property.ownerPlayerId, level: property.buildingLevel, mortgaged: property.mortgaged, version: property.version,
        mortgage: property.definition.mortgagePrice, purchasePrice: property.definition.purchasePrice, build: property.definition.buildCost, buildingSell: property.definition.buildingSellPrice,
        tolls: [property.definition.tollEmpty, property.definition.tollLevel1, property.definition.tollLevel2, property.definition.tollLevel3, property.definition.tollLevel4, property.definition.tollPalace]
      })),
      turn: activeTurn ? { id: activeTurn.id, number: activeTurn.turnNumber, playerId: activeTurn.playerId, dice: activeTurn.die1 && activeTurn.die2 ? [activeTurn.die1, activeTurn.die2] : undefined, total: activeTurn.diceValue ?? undefined } : null,
      ledger: visibleLedger,
      requests: visibleRequests.map((request) => {
        const payload = asObject(request.payload);
        return {
          id: request.id, type: request.type, playerId: request.actorPlayerId, targetPlayerId: request.targetPlayerId, propertyName: request.property?.definition.name,
          amount: request.amount ?? 0, quantity: request.quantity, note: request.note, status: request.status, rejectionReason: request.rejectionReason,
          buyerConfirmed: request.type === 'TRADE_PROPERTY' && payload.buyerConfirmed === true,
          recipientType: request.type === 'PLAYER_TRANSFER' && (payload.recipientType === 'PLAYER' || payload.recipientType === 'BANK') ? payload.recipientType : undefined,
          originalAmount: request.type === 'PLAYER_TRANSFER' ? int(payload.originalAmount) : undefined,
          reduction: request.type === 'PLAYER_TRANSFER' ? int(payload.reduction) : undefined,
          actualAmount: request.type === 'PLAYER_TRANSFER' ? int(payload.actualAmount) : undefined,
          isPlotFine: request.type === 'PLAYER_TRANSFER' ? payload.isPlotFine === true : undefined,
          createdAt: request.createdAt,
        };
      }),
      landings: room.landingEvents.map((landing) => ({ id: landing.id, turnId: landing.turnId ?? undefined, playerId: landing.playerId, propertyName: landing.property?.definition.name, spaceType: landing.spaceType, status: landing.status, plotResolved: landing.plotResolved, propertyActionsCancelled: landing.propertyActionsCancelled, tollSettled: tollSettlementStates.get(landing.id) === 'COMMITTED' })),
      audit: viewer.role === 'BANK' ? room.auditLogs : [],
      reversalCandidate: reversal ? {
        id: reversal.id,
        type: reversal.type,
        createdAt: reversal.createdAt,
        effects: reversal.ledgerEntries.map((entry) => ({ playerId: entry.playerId, amount: entry.amount })),
      } : null
    };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async start(actor: GameActor, roomId: string, key: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, 'start', key, { roomId }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room) fail('ROOM_NOT_FOUND');
      const players = await this.playablePlayers(tx, roomId);
      if (room.status !== 'LOBBY') fail('ROOM_NOT_IN_LOBBY'); if (players.length < 2 || players.length > room.playerLimit) fail('PLAYER_COUNT_OUT_OF_RANGE');
      const claimed = await tx.room.updateMany({ where: { id: roomId, status: 'LOBBY' }, data: { status: 'PLAYING', startedAt: room.startedAt ?? new Date(), currentTurnPlayerId: null, turnNumber: null } });
      if (claimed.count !== 1) fail('ROOM_NOT_IN_LOBBY');
      if (room.diceMode === 'ELECTRONIC') await this.createNextActionableTurn(tx, roomId, players, 0, 1);
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'START_ROOM', entityType: 'Room', entityId: roomId, afterJson: { status: 'PLAYING' } } });
      return { id: roomId, status: 'PLAYING' };
    });
  }

  async roll(actor: GameActor, roomId: string, playerId: string, key: string) {
    return this.executeIdempotent(actor, roomId, 'PLAYER', playerId, 'roll', key, { roomId, playerId }, async (tx) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING'); if (room.diceMode !== 'ELECTRONIC') fail('PHYSICAL_DICE_MODE'); if (room.currentTurnPlayerId !== playerId) fail('NOT_CURRENT_PLAYER');
      const turn = await tx.turn.findFirst({ where: { roomId, status: 'ACTIVE' }, orderBy: { turnNumber: 'desc' }, include: { player: true } }); if (!turn) fail('TURN_NOT_FOUND'); if (turn.player.remainingSkipTurns > 0) fail('PLAYER_MUST_SKIP_TURN'); if (turn.diceValue !== null) fail('ALREADY_ROLLED');
      const result = roll2d6(this.random); await tx.turn.update({ where: { id: turn.id }, data: { die1: result.dice[0], die2: result.dice[1], diceValue: result.total, rolledAt: new Date() } });
      return result;
    });
  }

  async endTurn(actor: GameActor, roomId: string, playerId: string, key: string) {
    return this.executeIdempotent(actor, roomId, 'PLAYER', playerId, 'end-turn', key, { roomId, playerId }, async (tx) => {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING'); if (room.diceMode !== 'ELECTRONIC') fail('PHYSICAL_DICE_MODE'); if (room.currentTurnPlayerId !== playerId) fail('NOT_CURRENT_PLAYER');
      const players = await this.playablePlayers(tx, roomId); if (!players.length) fail('PLAYER_COUNT_OUT_OF_RANGE');
      const turn = await tx.turn.findFirst({ where: { roomId, status: 'ACTIVE' } }); if (!turn) fail('TURN_NOT_FOUND');
      const index = players.findIndex((player) => player.id === playerId); if (index < 0) fail('PLAYER_NOT_FOUND');
      if (turn.diceValue === null) fail('ROLL_REQUIRED');
      const tollLanding = await tx.landingEvent.findFirst({ where: { roomId, turnId: turn.id, playerId, spaceType: 'PROPERTY', status: 'CONFIRMED', plotResolved: true, propertyActionsCancelled: false }, include: { property: true } });
      const tollProperty = tollLanding?.property;
      const settlement = tollLanding ? await this.tollSettlementState(tx, roomId, tollLanding.id) : null;
      const tollOwner = tollProperty?.ownerPlayerId
        ? (await this.playablePlayers(tx, roomId, [tollProperty.ownerPlayerId]))[0]
        : null;
      if (tollLanding && tollOwner && tollOwner.id !== playerId && !tollProperty?.mortgaged) {
        const ownerBlocked = await tx.skipTurnEntry.findFirst({ where: { roomId, playerId: tollOwner.id, remainingCount: { gt: 0 }, blocksTollCollection: true } });
        if (!ownerBlocked && settlement?.status !== 'COMMITTED') fail('TOLL_REQUIRED');
      }
      if (settlement?.status === 'COMMITTED' && settlement.transactionId) {
        await tx.gameTransaction.updateMany({
          where: { id: settlement.transactionId, roomId, status: 'COMMITTED' },
          data: { reversible: false },
        });
      }
      await this.cancelPendingRequests(tx, roomId, { turnId: turn.id }, 'TURN_ENDED');
      await tx.turn.update({ where: { id: turn.id }, data: { status: 'ENDED', endedAt: new Date() } });
      const created = await this.createNextActionableTurn(tx, roomId, players, (index + 1) % players.length, turn.turnNumber + 1);
      return { id: created.id, number: created.turnNumber, playerId: created.playerId };
    });
  }

  async skipTurn(actor: GameActor, roomId: string, playerId: string, key: string) {
    return this.executeIdempotent(actor, roomId, 'PLAYER', playerId, 'skip-turn', key, { roomId, playerId }, async (tx, member) => {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      if (room.diceMode !== 'ELECTRONIC') fail('PHYSICAL_DICE_MODE');
      if (room.currentTurnPlayerId !== playerId) fail('NOT_CURRENT_PLAYER');
      const players = await this.playablePlayers(tx, roomId);
      const index = players.findIndex((player) => player.id === playerId);
      if (index < 0) fail('PLAYER_NOT_FOUND');
      const turn = await tx.turn.findFirst({ where: { roomId, playerId, status: 'ACTIVE' } });
      if (!turn) fail('TURN_NOT_FOUND');
      if (turn.diceValue !== null) fail('SKIP_TURN_NOT_ALLOWED');
      if (players[index].remainingSkipTurns <= 0) fail('SKIP_TURN_NOT_ALLOWED');
      const consumed = await this.consumeSkipTurns(tx, roomId, playerId, 1);
      await tx.turn.update({ where: { id: turn.id }, data: { status: 'ENDED', endedAt: new Date() } });
      const created = await this.createNextActionableTurn(tx, roomId, players, (index + 1) % players.length, turn.turnNumber + 1);
      await tx.auditLog.create({ data: {
        roomId,
        actorMemberId: member.id,
        actorRole: 'PLAYER',
        action: 'SKIP_TURN',
        entityType: 'Turn',
        entityId: turn.id,
        beforeJson: { remainingSkipTurns: consumed.before },
        afterJson: { remainingSkipTurns: consumed.after, nextTurnId: created.id },
      } });
      return { id: created.id, number: created.turnNumber, playerId: created.playerId };
    });
  }

  async declareLanding(actor: GameActor, roomId: string, playerId: string, propertyName: string, key: string) {
    return this.executeIdempotent(actor, roomId, 'PLAYER', playerId, 'declare-property-landing', key, { roomId, playerId, propertyName }, async (tx, member) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const property = await tx.roomProperty.findFirst({ where: { roomId, definition: { name: propertyName } } }); if (!property) fail('PROPERTY_NOT_FOUND');
      const turn = room.diceMode === 'ELECTRONIC' ? await tx.turn.findFirst({ where: { roomId, playerId, status: 'ACTIVE' } }) : null;
      if (room.diceMode === 'ELECTRONIC' && (!turn || turn.diceValue === null || room.currentTurnPlayerId !== playerId)) fail('ROLL_REQUIRED');
      if (turn) await this.replaceDeclaredElectronicLanding(tx, turn.id);
      if (room.diceMode === 'PHYSICAL') await this.invalidatePhysicalLandings(tx, roomId, playerId);
      return tx.landingEvent.create({ data: { roomId, turnId: turn?.id, playerId, spaceType: 'PROPERTY', propertyId: property.id, declaredBy: member.id } });
    });
  }

  async declareStartLanding(actor: GameActor, roomId: string, playerId: string, landingId: string, key: string) {
    return this.executeIdempotent(actor, roomId, 'PLAYER', playerId, 'declare-start-landing', key, { roomId, playerId, landingId }, async (tx, member) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const turn = room.diceMode === 'ELECTRONIC' ? await tx.turn.findFirst({ where: { roomId, playerId, status: 'ACTIVE' } }) : null;
      if (room.diceMode === 'ELECTRONIC' && (!turn || turn.diceValue === null || room.currentTurnPlayerId !== playerId)) fail('ROLL_REQUIRED');
      if (turn) await this.replaceDeclaredElectronicLanding(tx, turn.id);
      if (room.diceMode === 'PHYSICAL') await this.invalidatePhysicalLandings(tx, roomId, playerId);
      return tx.landingEvent.create({ data: { id: landingId, roomId, turnId: turn?.id, playerId, spaceType: 'START', declaredBy: member.id } });
    });
  }

  async confirmLanding(actor: GameActor, roomId: string, landingId: string, plotResolved = true, key: string) {
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, `landing:${landingId}:confirm`, key, { roomId, landingId, plotResolved }, async (tx, bank) => {
      const landing = await tx.landingEvent.findUnique({ where: { id: landingId }, include: { room: true, turn: true } });
      if (!landing || landing.roomId !== roomId || landing.status !== 'DECLARED') fail('LANDING_NOT_PENDING');
      if (landing.room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      if (landing.room.diceMode === 'ELECTRONIC' && (!landing.turn || landing.turn.status !== 'ACTIVE' || landing.turn.diceValue === null || landing.room.currentTurnPlayerId !== landing.playerId)) fail('LANDING_TURN_EXPIRED');
      const changed = await tx.landingEvent.updateMany({ where: { id: landingId, roomId, status: 'DECLARED' }, data: { status: 'CONFIRMED', confirmedBy: bank.id, confirmedAt: new Date(), plotResolved } });
      if (changed.count !== 1) fail('LANDING_NOT_PENDING'); return tx.landingEvent.findUniqueOrThrow({ where: { id: landingId } });
    }, async (tx) => {
      const landing = await tx.landingEvent.findFirst({ where: { id: landingId, roomId }, select: { playerId: true } });
      if (!landing) fail('LANDING_NOT_PENDING');
      await this.requirePlayablePlayer(tx, roomId, landing.playerId);
    });
  }

  async cancelLandingPropertyActions(actor: GameActor, roomId: string, landingId: string, reason: string, key: string) {
    if (!reason.trim()) fail('REASON_REQUIRED');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, `landing:${landingId}:cancel-property-actions`, key, { roomId, landingId, reason }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const before = await tx.landingEvent.findUnique({ where: { id: landingId } }); if (!before || before.roomId !== roomId) fail('LANDING_NOT_FOUND');
      await this.cancelPendingRequests(tx, roomId, { landingEventId: landingId }, 'LANDING_PROPERTY_ACTIONS_CANCELLED');
      const after = await tx.landingEvent.update({ where: { id: landingId }, data: { propertyActionsCancelled: true, plotResolved: true } });
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'CANCEL_LANDING_PROPERTY_ACTIONS', entityType: 'LandingEvent', entityId: landingId, beforeJson: before as unknown as Prisma.InputJsonValue, afterJson: after as unknown as Prisma.InputJsonValue, reason } }); return after;
    });
  }

  async createRequest(actor: GameActor, roomId: string, playerId: string, action: RequestAction, key: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    const storedKey = `${actor.accountId}:${key}`;
    const expectedHash = requestFingerprint({ roomId, playerId, action });
    const validateTradeBuyer = async (tx: Prisma.TransactionClient) => action.type === 'TRADE_PROPERTY' && action.targetPlayerId
      ? this.requirePlayablePlayer(tx, roomId, action.targetPlayerId)
      : null;
    try {
      return await this.db.$transaction(async (tx) => {
      await this.lockRoom(tx, roomId);
      await this.authorizeActor(tx, actor, roomId, 'PLAYER', playerId);
      const tradeBuyer = await validateTradeBuyer(tx);
      const existing = await tx.gameRequest.findUnique({ where: { roomId_idempotencyKey: { roomId, idempotencyKey: storedKey } } });
      if (existing) { this.assertRequestHash(existing.requestHash, expectedHash); return this.requestWithStateVersion(existing); }
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const player = await tx.player.findUnique({ where: { id: playerId }, include: { character: true } }); if (!player || player.roomId !== roomId) fail('PLAYER_NOT_FOUND');
      if (action.type === 'RETURN_COMPANION_EVENT' && (
        action.propertyName !== undefined || action.targetPlayerId !== undefined || action.amount !== undefined ||
        action.count !== undefined || action.landingId !== undefined || action.reason !== undefined
      )) fail('INVALID_RETURN_COMPANION_PAYLOAD');
      if (!lockedPropertyTypes.has(action.type) && action.propertyName) fail('PROPERTY_NOT_ALLOWED');
      if (lockedPropertyTypes.has(action.type) && room.diceMode === 'ELECTRONIC' && room.currentTurnPlayerId !== playerId) fail('NOT_CURRENT_PLAYER');
      const property = action.propertyName ? await tx.roomProperty.findFirst({ where: { roomId, definition: { name: action.propertyName } }, include: { definition: true } }) : null;
      if (lockedPropertyTypes.has(action.type) && !property) fail('PROPERTY_REQUIRED'); if (property?.lockedByRequestId) fail('PROPERTY_LOCKED');
      const needsTurn = turnBoundPropertyTypes.has(action.type) || action.type === 'START_REWARD';
      const turn = room.diceMode === 'ELECTRONIC' && needsTurn ? await tx.turn.findFirst({ where: { roomId, status: 'ACTIVE', playerId } }) : null;
      if (turnBoundPropertyTypes.has(action.type) && room.diceMode === 'ELECTRONIC' && !turn) fail('TURN_NOT_FOUND');
      let landing = null;
      if (action.type === 'BUY_PROPERTY' || action.type === 'BUILD_PROPERTY') {
        if (room.diceMode === 'ELECTRONIC' && (!turn || turn.diceValue === null)) fail('ROLL_REQUIRED');
        landing = await tx.landingEvent.findFirst({ where: { roomId, playerId, propertyId: property?.id, status: 'CONFIRMED', plotResolved: true, propertyActionsCancelled: false, ...(room.diceMode === 'ELECTRONIC' ? { turnId: turn?.id } : { turnId: null }) }, orderBy: { confirmedAt: 'desc' } });
        if (!landing) fail('CONFIRMED_LANDING_REQUIRED');
      }
      if (action.type === 'START_REWARD') {
        landing = await tx.landingEvent.findFirst({ where: { id: action.landingId, roomId, playerId, spaceType: 'START', status: 'CONFIRMED' } }); if (!landing) fail('START_LANDING_REQUIRED');
        if (room.diceMode === 'ELECTRONIC' && (!turn || turn.diceValue === null || room.currentTurnPlayerId !== playerId || landing.turnId !== turn.id)) fail('START_LANDING_TURN_EXPIRED');
      }
      if (action.type === 'COLD_PALACE_EVENT' && (!Number.isInteger(action.count) || (action.count ?? 0) <= 0)) fail('INVALID_SKIP_COUNT');
      const skipRequest = action.type === 'PLOT_REST_EVENT' || action.type === 'CONSUME_SKIP_TURNS';
      if (skipRequest && (action.propertyName || action.amount !== undefined || action.targetPlayerId || action.landingId)) fail('INVALID_SKIP_REQUEST_PAYLOAD');
      if (action.type === 'PLOT_REST_EVENT' && (!Number.isInteger(action.count) || (action.count ?? 0) <= 0 || !action.reason?.trim())) fail('INVALID_PLOT_REST');
      if (action.type === 'CONSUME_SKIP_TURNS') {
        if (action.reason !== undefined || !Number.isInteger(action.count) || (action.count ?? 0) <= 0 || (action.count ?? 0) > player.remainingSkipTurns) fail('INSUFFICIENT_SKIP_TURNS');
      }
      if (landing) {
        const priorLandingAction = await tx.gameRequest.findFirst({ where: {
          landingEventId: landing.id,
          type: { in: ['BUY_PROPERTY', 'BUILD_PROPERTY', 'START_REWARD'] },
          status: { in: ['PENDING', 'APPROVED', 'EXECUTED', 'REVERSED'] }
        } });
        if (priorLandingAction) fail('LANDING_ACTION_ALREADY_USED');
      }
      let computedAmount = action.type === 'RETURN_COMPANION_EVENT' ? RETURN_COMPANION_REWARD : action.amount ?? 0;
      if (action.type === 'START_REWARD') computedAmount = room.startReward;
      if (property) {
        if (action.type === 'BUY_PROPERTY') { if (property.ownerPlayerId) fail('PROPERTY_OWNED'); computedAmount = property.definition.purchasePrice; }
        if (action.type === 'BUILD_PROPERTY') {
          if (property.ownerPlayerId !== playerId) fail('NOT_PROPERTY_OWNER'); if (property.mortgaged) fail('MORTGAGED_PROPERTY'); if (property.buildingLevel >= 5) fail('MAX_BUILDING_LEVEL');
          const config = asObject(player.character?.skillConfig); computedAmount = Math.max(0, property.definition.buildCost - (room.skillEnabled && player.character?.skillCode === 'BUILD_DISCOUNT' ? int(config.discount) : 0));
        }
        if (action.type === 'SELL_BUILDING') {
          if (property.ownerPlayerId !== playerId) fail('NOT_PROPERTY_OWNER');
          if (property.buildingLevel === 0) fail('NO_BUILDINGS');
          const count = action.count ?? 1;
          if (!Number.isInteger(count) || count <= 0) fail('INVALID_BUILDING_COUNT');
          if (property.buildingLevel === 5 && count !== 5) fail('PALACE_SELLS_AS_FIVE');
          if (property.buildingLevel < 5 && count > property.buildingLevel) fail('TOO_MANY_BUILDINGS');
          computedAmount = (property.buildingLevel === 5 ? 5 : count) * property.definition.buildingSellPrice;
        }
        if (action.type === 'MORTGAGE_PROPERTY') { if (property.ownerPlayerId !== playerId) fail('NOT_PROPERTY_OWNER'); if (property.buildingLevel > 0) fail('BUILDINGS_MUST_BE_SOLD'); if (property.mortgaged) fail('ALREADY_MORTGAGED'); computedAmount = property.definition.mortgagePrice; }
        if (action.type === 'REDEEM_PROPERTY') { if (property.ownerPlayerId !== playerId) fail('NOT_PROPERTY_OWNER'); if (!property.mortgaged) fail('NOT_MORTGAGED'); computedAmount = property.definition.mortgagePrice + room.redemptionFee; }
        if (action.type === 'SELL_PROPERTY_TO_BANK') { if (property.ownerPlayerId !== playerId) fail('NOT_PROPERTY_OWNER'); if (property.buildingLevel > 0) fail('BUILDINGS_MUST_BE_SOLD'); if (property.mortgaged) fail('MORTGAGED_PROPERTY'); computedAmount = property.definition.purchasePrice; }
        if (action.type === 'TRADE_PROPERTY') { if (property.ownerPlayerId !== playerId) fail('NOT_PROPERTY_OWNER'); if (property.buildingLevel > 0) fail('BUILDINGS_MUST_BE_SOLD'); if (property.mortgaged) fail('MORTGAGED_PROPERTY'); if (!action.targetPlayerId || action.targetPlayerId === playerId || !Number.isInteger(action.amount) || (action.amount ?? -1) < 0) fail('INVALID_TRADE'); }
      }
      if (['BUY_PROPERTY', 'BUILD_PROPERTY', 'REDEEM_PROPERTY'].includes(action.type) && player.balance < computedAmount) fail('INSUFFICIENT_BALANCE');
      if (action.type === 'TRADE_PROPERTY') { const buyer = tradeBuyer ?? fail('PLAYER_NOT_FOUND'); if (buyer.balance < computedAmount) fail('INSUFFICIENT_BALANCE'); }
      const request = await tx.gameRequest.create({ data: { roomId, type: action.type, actorPlayerId: playerId, targetPlayerId: action.targetPlayerId, propertyId: property?.id, landingEventId: landing?.id, turnId: turn?.id, amount: computedAmount, quantity: action.type === 'RETURN_COMPANION_EVENT' ? 1 : action.count, note: action.type === 'PLOT_REST_EVENT' ? action.reason?.trim() : null, payload: { propertyVersion: property?.version ?? null, playerVersion: player.version, ...(action.type === 'TRADE_PROPERTY' ? { buyerConfirmed: false } : {}) }, idempotencyKey: storedKey, requestHash: expectedHash } });
      if (property) { const locked = await tx.roomProperty.updateMany({ where: { id: property.id, lockedByRequestId: null, version: property.version }, data: { lockedByRequestId: request.id } }); if (locked.count !== 1) fail('PROPERTY_LOCKED'); }
      const versionedRoom = await tx.room.update({ where: { id: roomId }, data: { stateVersion: { increment: 1 } }, select: { stateVersion: true } });
      const versioned = await tx.gameRequest.update({ where: { id: request.id }, data: { payload: { ...asObject(request.payload), stateVersion: versionedRoom.stateVersion } } });
      return this.requestWithStateVersion(versioned);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      return this.replayRequestConflict(actor, roomId, 'PLAYER', playerId, storedKey, expectedHash, error, lockedPropertyTypes.has(action.type) ? 'PROPERTY_LOCKED' : 'TRANSACTION_CONFLICT', validateTradeBuyer).then((request) => this.requestWithStateVersion(request));
    }
  }

  async requestBankPayment(actor: GameActor, roomId: string, playerId: string, amount: number, key: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED'); if (!Number.isInteger(amount) || amount <= 0) fail('INVALID_AMOUNT');
    const storedKey = `${actor.accountId}:${key}`;
    const expectedHash = requestFingerprint({ roomId, playerId, amount, type: 'BANK_PAYMENT' });
    try {
      return await this.db.$transaction(async (tx) => {
      await this.lockRoom(tx, roomId);
      await this.authorizeActor(tx, actor, roomId, 'PLAYER', playerId);
      const existing = await tx.gameRequest.findUnique({ where: { roomId_idempotencyKey: { roomId, idempotencyKey: storedKey } } });
      if (existing) { this.assertRequestHash(existing.requestHash, expectedHash); return this.requestWithStateVersion(existing); }
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const player = await tx.player.findFirst({ where: { id: playerId, roomId } }); if (!player) fail('PLAYER_NOT_FOUND');
      const request = await tx.gameRequest.create({ data: { roomId, type: 'BANK_PAYMENT', actorPlayerId: playerId, targetPlayerId: playerId, amount, idempotencyKey: storedKey, requestHash: expectedHash } });
      const versionedRoom = await tx.room.update({ where: { id: roomId }, data: { stateVersion: { increment: 1 } }, select: { stateVersion: true } });
      const versioned = await tx.gameRequest.update({ where: { id: request.id }, data: { payload: { stateVersion: versionedRoom.stateVersion } } });
      return this.requestWithStateVersion(versioned);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      return this.replayRequestConflict(actor, roomId, 'PLAYER', playerId, storedKey, expectedHash, error).then((request) => this.requestWithStateVersion(request));
    }
  }

  async confirmTrade(actor: GameActor, roomId: string, requestId: string, buyerPlayerId: string, key: string) {
    let mutationCreated = false;
    return this.executeIdempotent(actor, roomId, 'PLAYER', buyerPlayerId, `request:${requestId}:confirm-trade`, key, { roomId, requestId, buyerPlayerId }, async (tx) => {
        mutationCreated = false;
        const request = await tx.gameRequest.findUnique({ where: { id: requestId } });
        if (!request || request.roomId !== roomId) fail('REQUEST_NOT_FOUND');
        if (request.type !== 'TRADE_PROPERTY') fail('TRADE_REQUEST_REQUIRED');
        if (request.targetPlayerId !== buyerPlayerId) fail('TRADE_BUYER_MISMATCH');
        const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
        if (request.status !== 'PENDING') fail('REQUEST_NOT_PENDING');
        const payload = asObject(request.payload);
        if (payload.buyerConfirmed !== true) {
          const changed = await tx.gameRequest.updateMany({ where: { id: request.id, roomId, type: 'TRADE_PROPERTY', status: 'PENDING', targetPlayerId: buyerPlayerId }, data: { payload: { ...payload, buyerConfirmed: true } } });
          if (changed.count !== 1) fail('REQUEST_ALREADY_RESOLVED');
          mutationCreated = true;
        }
        return { id: request.id, buyerConfirmed: true };
    }, async (tx) => this.requireRequestParticipants(tx, roomId, requestId), () => mutationCreated);
  }

  async approve(actor: GameActor, roomId: string, requestId: string, key: string) {
    let mutationCreated = false;
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, `request:${requestId}:approve`, key, { roomId, requestId }, async (tx, bank) => {
      mutationCreated = false;
      const request = await tx.gameRequest.findUnique({ where: { id: requestId }, include: { property: { include: { definition: true } }, landingEvent: true, actor: { include: { character: true } }, target: true, transaction: true, room: true } });
      if (!request || request.roomId !== roomId) fail('REQUEST_NOT_FOUND');
      if (request.room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      if (request.status === 'EXECUTED') {
        return { id: request.id, status: request.status, transactionId: request.transaction?.id };
      }
      if (request.status !== 'PENDING') fail('REQUEST_NOT_PENDING');
      let activeTurn = null;
      if (turnBoundPropertyTypes.has(request.type) && request.room.diceMode === 'ELECTRONIC') {
        if (!request.turnId || !request.actorPlayerId) fail('REQUEST_TURN_EXPIRED');
        activeTurn = await tx.turn.findFirst({ where: { id: request.turnId, roomId, playerId: request.actorPlayerId, status: 'ACTIVE' } });
        if (!activeTurn || !request.actorPlayerId || request.room.currentTurnPlayerId !== request.actorPlayerId) fail('REQUEST_TURN_EXPIRED');
      }
      if (request.type === 'BUY_PROPERTY' || request.type === 'BUILD_PROPERTY') {
        if (request.room.diceMode === 'ELECTRONIC' && activeTurn?.diceValue === null) fail('ROLL_REQUIRED');
        const landing = request.landingEvent;
        if (!landing || landing.roomId !== roomId || landing.playerId !== request.actorPlayerId || landing.propertyId !== request.propertyId || landing.status !== 'CONFIRMED' || !landing.plotResolved || landing.propertyActionsCancelled || (request.room.diceMode === 'ELECTRONIC' ? landing.turnId !== activeTurn?.id : landing.turnId !== null)) fail('CONFIRMED_LANDING_REQUIRED');
      }
      if (request.type === 'START_REWARD' && request.room.diceMode === 'ELECTRONIC') {
        const landing = request.landingEvent;
        const rewardTurn = request.turnId && request.actorPlayerId ? await tx.turn.findFirst({ where: { id: request.turnId, roomId, playerId: request.actorPlayerId, status: 'ACTIVE' } }) : null;
        if (!landing || !rewardTurn || rewardTurn.diceValue === null || request.room.currentTurnPlayerId !== request.actorPlayerId || landing.turnId !== rewardTurn.id || landing.status !== 'CONFIRMED') fail('START_LANDING_TURN_EXPIRED');
      }
      if (request.type === 'TRADE_PROPERTY' && asObject(request.payload).buyerConfirmed !== true) fail('TRADE_BUYER_CONFIRMATION_REQUIRED');
      const claimed = await tx.gameRequest.updateMany({ where: { id: requestId, status: 'PENDING' }, data: { status: 'APPROVED', approvedByMemberId: bank.id, approvedAt: new Date() } }); if (claimed.count !== 1) fail('REQUEST_ALREADY_RESOLVED');
      const amount = request.amount ?? 0; const effects: Array<{ playerId: string; amount: number; before: number; after: number; type: string; description: string }> = [];
      const propertyBefore = request.property ? { ownerPlayerId: request.property.ownerPlayerId, buildingLevel: request.property.buildingLevel, mortgaged: request.property.mortgaged, version: request.property.version } : null;
      let propertyAfter: typeof propertyBefore = propertyBefore;
      let transactionType = request.type;
      let transactionMetadata: Prisma.InputJsonObject = {};
      let approvalAudit: { beforeJson: Prisma.InputJsonObject; afterJson: Prisma.InputJsonObject } | null = null;
      const actorId = request.actorPlayerId; const targetId = request.targetPlayerId;
      const addEffect = async (playerId: string, delta: number, type: string, description: string) => { const changed = await this.changeBalance(tx, playerId, delta); effects.push({ playerId, amount: delta, ...changed, type, description }); };
      switch (request.type) {
        case 'BUY_PROPERTY': {
          if (!actorId || !request.property || request.property.ownerPlayerId || request.property.lockedByRequestId !== request.id) fail('PROPERTY_STATE_CHANGED');
          await addEffect(actorId, -amount, 'BUY_PROPERTY', `购买${request.property.definition.name}`);
          const changed = await tx.roomProperty.updateMany({ where: { id: request.property.id, lockedByRequestId: request.id, ownerPlayerId: null, version: request.property.version }, data: { ownerPlayerId: actorId, lockedByRequestId: null, version: { increment: 1 } } }); if (changed.count !== 1) fail('PROPERTY_STATE_CHANGED');
          propertyAfter = { ownerPlayerId: actorId, buildingLevel: request.property.buildingLevel, mortgaged: false, version: request.property.version + 1 }; break;
        }
        case 'BUILD_PROPERTY': {
          if (!actorId || !request.property || request.property.ownerPlayerId !== actorId || request.property.mortgaged || request.property.lockedByRequestId !== request.id || request.property.buildingLevel >= 5) fail('PROPERTY_STATE_CHANGED');
          await addEffect(actorId, -amount, 'BUILD_PROPERTY', `升级${request.property.definition.name}`);
          const changed = await tx.roomProperty.updateMany({ where: { id: request.property.id, ownerPlayerId: actorId, lockedByRequestId: request.id, mortgaged: false, buildingLevel: request.property.buildingLevel, version: request.property.version }, data: { buildingLevel: { increment: 1 }, lockedByRequestId: null, version: { increment: 1 } } }); if (changed.count !== 1) fail('PROPERTY_STATE_CHANGED');
          propertyAfter = { ownerPlayerId: actorId, buildingLevel: request.property.buildingLevel + 1, mortgaged: false, version: request.property.version + 1 }; break;
        }
        case 'SELL_BUILDING': {
          if (!actorId || !request.property || request.property.ownerPlayerId !== actorId || request.property.lockedByRequestId !== request.id) fail('PROPERTY_STATE_CHANGED'); const count = request.property.buildingLevel === 5 ? 5 : request.quantity ?? 1; const nextLevel = request.property.buildingLevel === 5 ? 0 : request.property.buildingLevel - count; if (nextLevel < 0) fail('INVALID_BUILDING_COUNT');
          await addEffect(actorId, amount, 'SELL_BUILDING', `出售${request.property.definition.name}建筑`);
          const changed = await tx.roomProperty.updateMany({ where: { id: request.property.id, lockedByRequestId: request.id, buildingLevel: request.property.buildingLevel, version: request.property.version }, data: { buildingLevel: nextLevel, lockedByRequestId: null, version: { increment: 1 } } }); if (changed.count !== 1) fail('PROPERTY_STATE_CHANGED');
          propertyAfter = { ownerPlayerId: actorId, buildingLevel: nextLevel, mortgaged: request.property.mortgaged, version: request.property.version + 1 }; break;
        }
        case 'MORTGAGE_PROPERTY': {
          if (!actorId || !request.property || request.property.ownerPlayerId !== actorId || request.property.buildingLevel !== 0 || request.property.mortgaged || request.property.lockedByRequestId !== request.id) fail('PROPERTY_STATE_CHANGED'); await addEffect(actorId, amount, 'MORTGAGE_PROPERTY', `抵押${request.property.definition.name}`);
          const changed = await tx.roomProperty.updateMany({ where: { id: request.property.id, lockedByRequestId: request.id, ownerPlayerId: actorId, buildingLevel: 0, mortgaged: false, version: request.property.version }, data: { mortgaged: true, lockedByRequestId: null, version: { increment: 1 } } }); if (changed.count !== 1) fail('PROPERTY_STATE_CHANGED');
          propertyAfter = { ownerPlayerId: actorId, buildingLevel: 0, mortgaged: true, version: request.property.version + 1 }; break;
        }
        case 'REDEEM_PROPERTY': {
          if (!actorId || !request.property || request.property.ownerPlayerId !== actorId || !request.property.mortgaged || request.property.lockedByRequestId !== request.id) fail('PROPERTY_STATE_CHANGED'); await addEffect(actorId, -amount, 'REDEEM_PROPERTY', `赎回${request.property.definition.name}`);
          const changed = await tx.roomProperty.updateMany({ where: { id: request.property.id, lockedByRequestId: request.id, ownerPlayerId: actorId, mortgaged: true, version: request.property.version }, data: { mortgaged: false, lockedByRequestId: null, version: { increment: 1 } } }); if (changed.count !== 1) fail('PROPERTY_STATE_CHANGED');
          propertyAfter = { ownerPlayerId: actorId, buildingLevel: 0, mortgaged: false, version: request.property.version + 1 }; break;
        }
        case 'SELL_PROPERTY_TO_BANK': {
          if (!actorId || !request.property || request.property.ownerPlayerId !== actorId || request.property.buildingLevel !== 0 || request.property.mortgaged || request.property.lockedByRequestId !== request.id) fail('PROPERTY_STATE_CHANGED'); await addEffect(actorId, amount, 'SELL_PROPERTY_TO_BANK', `出售${request.property.definition.name}给银行`);
          const changed = await tx.roomProperty.updateMany({ where: { id: request.property.id, lockedByRequestId: request.id, ownerPlayerId: actorId, buildingLevel: 0, mortgaged: false, version: request.property.version }, data: { ownerPlayerId: null, lockedByRequestId: null, version: { increment: 1 } } }); if (changed.count !== 1) fail('PROPERTY_STATE_CHANGED');
          propertyAfter = { ownerPlayerId: null, buildingLevel: 0, mortgaged: false, version: request.property.version + 1 }; break;
        }
        case 'TRADE_PROPERTY': {
          if (!actorId || !targetId || !request.property || request.property.ownerPlayerId !== actorId || request.property.buildingLevel !== 0 || request.property.mortgaged || request.property.lockedByRequestId !== request.id) fail('PROPERTY_STATE_CHANGED');
          await addEffect(targetId, -amount, 'TRADE_PROPERTY', `购买${request.property.definition.name}`); await addEffect(actorId, amount, 'TRADE_PROPERTY', `出售${request.property.definition.name}`);
          const changed = await tx.roomProperty.updateMany({ where: { id: request.property.id, lockedByRequestId: request.id, ownerPlayerId: actorId, buildingLevel: 0, mortgaged: false, version: request.property.version }, data: { ownerPlayerId: targetId, lockedByRequestId: null, version: { increment: 1 } } }); if (changed.count !== 1) fail('PROPERTY_STATE_CHANGED');
          propertyAfter = { ownerPlayerId: targetId, buildingLevel: 0, mortgaged: false, version: request.property.version + 1 }; break;
        }
        case 'START_REWARD': if (!actorId) fail('PLAYER_NOT_FOUND'); await addEffect(actorId, amount, 'START_REWARD', '精确停留起点奖励'); break;
        case 'BANK_PAYMENT': if (!targetId && !actorId) fail('PLAYER_NOT_FOUND'); await addEffect(targetId ?? actorId ?? '', amount, 'BANK_PAYMENT', '银行付款'); break;
        case 'PLAYER_TRANSFER': {
          if (!actorId || !request.actor) fail('PLAYER_NOT_FOUND');
          const payload = asObject(request.payload);
          const recipientType = payload.recipientType;
          const originalAmount = int(payload.originalAmount);
          const isPlotFine = payload.isPlotFine === true;
          const playerRecipientValid = recipientType === 'PLAYER' && targetId !== null && targetId !== actorId;
          const bankRecipientValid = recipientType === 'BANK' && targetId === null;
          if (originalAmount <= 0 || (!playerRecipientValid && !bankRecipientValid)) fail('INVALID_TRANSFER');
          const amounts = this.transferAmounts(request.room, request.actor, originalAmount, isPlotFine);
          const ledgerType = isPlotFine ? 'PLOT_FINE' : recipientType === 'BANK' ? 'PLAYER_BANK_PAYMENT' : 'PLAYER_TRANSFER';
          transactionType = isPlotFine ? 'PLOT_FINE' : recipientType === 'BANK' ? 'PLAYER_BANK_PAYMENT' : 'PLAYER_TRANSFER';
          await addEffect(actorId, -amounts.actualAmount, ledgerType, isPlotFine ? '支付剧情罚款' : recipientType === 'BANK' ? '支付银行' : '玩家转出');
          if (recipientType === 'PLAYER') await addEffect(targetId!, amounts.actualAmount, ledgerType, isPlotFine ? '收到剧情款项' : '玩家转入');
          transactionMetadata = {
            recipientType,
            originalAmount: amounts.originalAmount,
            reduction: amounts.reduction,
            actualAmount: amounts.actualAmount,
            isPlotFine,
            ...(targetId ? { toPlayerId: targetId } : {}),
          };
          break;
        }
        case 'COMPANION_EVENT': {
          if (!actorId || !request.actor) fail('PLAYER_NOT_FOUND');
          const config = asObject(request.actor.character?.skillConfig);
          const reward = request.room.skillEnabled && request.actor.character?.skillCode === 'COMPANION_REWARD'
            ? int(config.cashReward)
            : 0;
          if (reward) await addEffect(actorId, reward, 'SKILL_REWARD', '甄嬛伙伴卡奖励');
          break;
        }
        case 'RETURN_COMPANION_EVENT': {
          if (!actorId || !request.actor || request.amount !== RETURN_COMPANION_REWARD || request.quantity !== 1) fail('INVALID_RETURN_COMPANION_REQUEST');
          await addEffect(actorId, RETURN_COMPANION_REWARD, 'RETURN_COMPANION_EVENT', '放回实体伙伴卡奖励');
          transactionMetadata = { returnedCount: 1, rewardAmount: RETURN_COMPANION_REWARD };
          approvalAudit = {
            beforeJson: { balance: request.actor.balance },
            afterJson: { balance: request.actor.balance + RETURN_COMPANION_REWARD, returnedCount: 1, rewardAmount: RETURN_COMPANION_REWARD },
          };
          break;
        }
        case 'COLD_PALACE_EVENT': {
          if (!actorId || !request.actor || !Number.isInteger(request.quantity) || (request.quantity ?? 0) <= 0) fail('INVALID_SKIP_COUNT');
          const config = asObject(request.actor.character?.skillConfig); const skilled = request.room.skillEnabled && request.actor.character?.skillCode === 'COLD_PALACE_RELIEF';
          const reward = skilled ? int(config.cashReward) : 0; const actual = Math.max(0, (request.quantity ?? 0) - (skilled ? int(config.skipTurnsReduction) : 0));
          if (reward) await addEffect(actorId, reward, 'SKILL_REWARD', '宜修冷宫补贴');
          const expectedVersion = request.actor.version + (reward ? 1 : 0);
          const changed = await tx.player.updateMany({ where: { id: actorId, roomId, version: expectedVersion }, data: { remainingSkipTurns: { increment: actual }, version: { increment: 1 } } }); if (changed.count !== 1) fail('PLAYER_STATE_CHANGED');
          if (actual) await tx.skipTurnEntry.create({ data: { roomId, playerId: actorId, sourceType: 'COLD_PALACE', sourceDescription: '冷宫', originalCount: actual, remainingCount: actual, blocksTollCollection: true, createdBy: request.actor.memberId, approvedBy: bank.id } });
          break;
        }
        case 'PLOT_REST_EVENT': {
          const count = request.quantity;
          if (!actorId || !request.actor || !Number.isInteger(count) || !count || !request.note?.trim()) fail('INVALID_PLOT_REST');
          const changed = await tx.player.updateMany({ where: { id: actorId, roomId, version: request.actor.version }, data: { remainingSkipTurns: { increment: count }, version: { increment: 1 } } }); if (changed.count !== 1) fail('PLAYER_STATE_CHANGED');
          await tx.skipTurnEntry.create({ data: { roomId, playerId: actorId, sourceType: 'PLOT_REST', sourceDescription: request.note.trim(), originalCount: count, remainingCount: count, blocksTollCollection: false, createdBy: request.actor.memberId, approvedBy: bank.id } });
          break;
        }
        case 'CONSUME_SKIP_TURNS': {
          const count = request.quantity;
          if (!actorId || !Number.isInteger(count) || !count) fail('INSUFFICIENT_SKIP_TURNS');
          await this.consumeSkipTurns(tx, roomId, actorId, count);
          break;
        }
        default: fail('UNSUPPORTED_REQUEST_TYPE');
      }
      const transaction = await tx.gameTransaction.create({ data: { roomId, type: transactionType, requestId: request.id, reversible: !nonReversibleRequestTypes.has(request.type), metadata: { effects, propertyId: request.propertyId, propertyBefore, propertyAfter, ...transactionMetadata } } });
      if (effects.length) await tx.ledgerEntry.createMany({ data: effects.map((effect) => ({ roomId, transactionId: transaction.id, playerId: effect.playerId, amount: effect.amount, balanceBefore: effect.before, balanceAfter: effect.after, type: effect.type, description: effect.description, createdBy: bank.id })) });
      if (approvalAudit) await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'RETURN_COMPANION_EVENT', entityType: 'Player', entityId: actorId ?? '', beforeJson: approvalAudit.beforeJson, afterJson: approvalAudit.afterJson } });
      const executed = await tx.gameRequest.update({ where: { id: request.id }, data: { status: 'EXECUTED', resolvedAt: new Date() } });
      mutationCreated = true;
      return { id: executed.id, status: executed.status, transactionId: transaction.id };
    }, async (tx) => this.requireRequestParticipants(tx, roomId, requestId), () => mutationCreated, async (result) => {
      if (mutationCreated && typeof result.transactionId === 'string') await this.toastNotifier?.fundsCommitted(roomId, result.transactionId);
    });
  }

  async reject(actor: GameActor, roomId: string, requestId: string, reason: string, key: string) {
    if (!reason.trim()) fail('REASON_REQUIRED');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, `request:${requestId}:reject`, key, { roomId, requestId, reason }, async (tx, bank) => {
        const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
        const request = await tx.gameRequest.findUnique({ where: { id: requestId } }); if (!request || request.roomId !== roomId) fail('REQUEST_NOT_FOUND');
        if (request.status !== 'PENDING') fail('REQUEST_ALREADY_RESOLVED');
        const claimed = await tx.gameRequest.updateMany({ where: { id: request.id, roomId, status: 'PENDING' }, data: { status: 'REJECTED', rejectionReason: reason, approvedByMemberId: bank.id, resolvedAt: new Date() } }); if (claimed.count !== 1) fail('REQUEST_ALREADY_RESOLVED');
        if (request.propertyId) await tx.roomProperty.updateMany({ where: { id: request.propertyId, lockedByRequestId: request.id }, data: { lockedByRequestId: null } });
        const rejected = await tx.gameRequest.findUniqueOrThrow({ where: { id: request.id } });
        return { id: rejected.id, status: rejected.status };
    }, undefined, undefined, async (result) => {
      if (typeof result.id === 'string') await this.toastNotifier?.requestRejected(roomId, result.id);
    });
  }

  async transfer(actor: GameActor, roomId: string, input: TransferInput, key: string) {
    if (!Number.isInteger(input.amount) || input.amount <= 0) fail('INVALID_AMOUNT');
    const playerRecipientValid = input.recipientType === 'PLAYER'
      && typeof input.toPlayerId === 'string'
      && input.toPlayerId.length > 0
      && input.toPlayerId !== input.fromPlayerId;
    const bankRecipientValid = input.recipientType === 'BANK' && input.toPlayerId === undefined;
    if (!input.fromPlayerId || (!playerRecipientValid && !bankRecipientValid)) fail('INVALID_TRANSFER');
    return this.executeIdempotent(actor, roomId, 'PLAYER', input.fromPlayerId, 'transfer', key, { roomId, ...input }, async (tx, member) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const payer = await tx.player.findUnique({ where: { id: input.fromPlayerId }, include: { character: true } });
      if (!payer || payer.roomId !== roomId) fail('PLAYER_NOT_FOUND');
      const amounts = this.transferAmounts(room, payer, input.amount, input.isPlotFine);
      if (room.transferApprovalRequired) {
        const payload: Prisma.InputJsonObject = {
          recipientType: input.recipientType,
          originalAmount: amounts.originalAmount,
          reduction: amounts.reduction,
          actualAmount: amounts.actualAmount,
          isPlotFine: input.isPlotFine,
        };
        const request = await tx.gameRequest.create({ data: {
          roomId,
          type: 'PLAYER_TRANSFER',
          actorPlayerId: input.fromPlayerId,
          targetPlayerId: input.toPlayerId,
          amount: amounts.actualAmount,
          payload,
          idempotencyKey: `${actor.accountId}:transfer:${key}`,
          requestHash: requestFingerprint({ roomId, ...input }),
        } });
        return {
          id: request.id,
          type: request.type,
          status: request.status,
          originalAmount: amounts.originalAmount,
          reduction: amounts.reduction,
          amount: amounts.actualAmount,
        };
      }
      const ledgerType = input.isPlotFine ? 'PLOT_FINE' : input.recipientType === 'BANK' ? 'PLAYER_BANK_PAYMENT' : 'PLAYER_TRANSFER';
      const transactionType = input.isPlotFine ? 'PLOT_FINE' : input.recipientType === 'BANK' ? 'PLAYER_BANK_PAYMENT' : 'PLAYER_TRANSFER';
      const effects: Array<{ playerId: string; amount: number; before: number; after: number; type: string; description: string }> = [];
      const paid = await this.changeBalance(tx, input.fromPlayerId, -amounts.actualAmount);
      effects.push({ playerId: input.fromPlayerId, amount: -amounts.actualAmount, ...paid, type: ledgerType, description: input.isPlotFine ? '支付剧情罚款' : input.recipientType === 'BANK' ? '支付银行' : '玩家转出' });
      if (input.recipientType === 'PLAYER') {
        const received = await this.changeBalance(tx, input.toPlayerId!, amounts.actualAmount);
        effects.push({ playerId: input.toPlayerId!, amount: amounts.actualAmount, ...received, type: ledgerType, description: input.isPlotFine ? '收到剧情款项' : '玩家转入' });
      }
      const metadata: Prisma.InputJsonObject = {
        recipientType: input.recipientType,
        originalAmount: amounts.originalAmount,
        reduction: amounts.reduction,
        actualAmount: amounts.actualAmount,
        isPlotFine: input.isPlotFine,
        ...(input.toPlayerId ? { toPlayerId: input.toPlayerId } : {}),
      };
      const transaction = await this.recordTransaction(tx, roomId, transactionType, effects, member.id, metadata);
      return { id: transaction.id, status: 'EXECUTED', originalAmount: amounts.originalAmount, reduction: amounts.reduction, amount: amounts.actualAmount };
    }, async (tx) => input.recipientType === 'PLAYER'
      ? this.requirePlayablePlayers(tx, roomId, [input.fromPlayerId, input.toPlayerId!])
      : this.requirePlayablePlayer(tx, roomId, input.fromPlayerId), undefined, async (result) => {
        if (result.status === 'EXECUTED' && typeof result.id === 'string') await this.toastNotifier?.fundsCommitted(roomId, result.id);
      });
  }

  async payToll(actor: GameActor, roomId: string, payerId: string, propertyName: string, key: string) {
    return this.executeIdempotent(actor, roomId, 'PLAYER', payerId, 'toll', key, { roomId, payerId, propertyName }, async (tx) => {
        const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING'); if (room.diceMode === 'ELECTRONIC' && room.currentTurnPlayerId !== payerId) fail('NOT_CURRENT_PLAYER');
        const property = await tx.roomProperty.findFirst({ where: { roomId, definition: { name: propertyName } }, include: { definition: true, owner: { include: { character: true } } } });
        if (!property) fail('PROPERTY_NOT_FOUND'); if (!property.ownerPlayerId || property.ownerPlayerId === payerId) fail('NO_TOLL_DUE'); if (property.mortgaged) fail('MORTGAGED_PROPERTY');
        const turn = room.diceMode === 'ELECTRONIC' ? await tx.turn.findFirst({ where: { roomId, playerId: payerId, status: 'ACTIVE' } }) : null;
        const landing = await tx.landingEvent.findFirst({ where: { roomId, playerId: payerId, propertyId: property.id, status: 'CONFIRMED', plotResolved: true, propertyActionsCancelled: false, ...(room.diceMode === 'ELECTRONIC' ? { turnId: turn?.id } : { turnId: null }) }, orderBy: { confirmedAt: 'desc' } }); if (!landing) fail('CONFIRMED_LANDING_REQUIRED');
        const settlementScope = `landing:${landing.id}:toll`;
        const settlement = await this.tollSettlementState(tx, roomId, landing.id);
        if (settlement.record && settlement.status !== 'REVERSED') fail('TOLL_ALREADY_SETTLED');
        const blocked = await tx.skipTurnEntry.findFirst({ where: { roomId, playerId: property.ownerPlayerId, remainingCount: { gt: 0 }, blocksTollCollection: true } }); if (blocked) fail('OWNER_CANNOT_COLLECT_TOLL');
        const tolls = [property.definition.tollEmpty, property.definition.tollLevel1, property.definition.tollLevel2, property.definition.tollLevel3, property.definition.tollLevel4, property.definition.tollPalace]; let amount = tolls[property.buildingLevel] ?? fail('INVALID_BUILDING_LEVEL');
        if (room.skillEnabled && property.owner?.character?.skillCode === 'TOLL_BONUS') amount += int(asObject(property.owner.character.skillConfig).bonus);
        const settlementData = { requestHash: requestFingerprint({ landingId: landing.id, payerId, propertyName }), response: { requestKey: key } };
        if (settlement.record) {
          await tx.idempotencyRecord.update({ where: { id: settlement.record.id }, data: settlementData });
        } else {
          await tx.idempotencyRecord.create({ data: { scope: settlementScope, key: 'settled', ...settlementData } });
        }
        const paid = await this.changeBalance(tx, payerId, -amount); const received = await this.changeBalance(tx, property.ownerPlayerId, amount);
        const effects = [{ playerId: payerId, amount: -amount, ...paid, type: 'TOLL_PAID', description: `支付${propertyName}过路费` }, { playerId: property.ownerPlayerId, amount, ...received, type: 'TOLL_RECEIVED', description: `收取${propertyName}过路费` }];
        const transaction = await this.recordTransaction(tx, roomId, 'TOLL', effects, null, { landingId: landing.id });
        await tx.idempotencyRecord.update({ where: { scope_key: { scope: settlementScope, key: 'settled' } }, data: { response: { requestKey: key, transactionId: transaction.id } } });
        return { id: transaction.id, amount };
    }, async (tx) => this.requirePlayableTollOwner(tx, roomId, payerId, propertyName), undefined, async (result) => {
      if (typeof result.id === 'string') await this.toastNotifier?.fundsCommitted(roomId, result.id);
    });
  }

  async adjustBalance(actor: GameActor, roomId: string, playerId: string, amount: number, reason: string, key: string) {
    if (!reason.trim()) fail('REASON_REQUIRED'); if (!Number.isInteger(amount) || amount === 0) fail('INVALID_AMOUNT');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, 'adjust-balance', key, { roomId, playerId, amount, reason }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const player = await tx.player.findFirst({ where: { id: playerId, roomId } }); if (!player) fail('PLAYER_NOT_FOUND');
      const changed = await this.changeBalance(tx, playerId, amount); const effects = [{ playerId, amount, ...changed, type: 'MANUAL_BALANCE_CHANGE', description: reason }];
      const transaction = await this.recordTransaction(tx, roomId, 'MANUAL_BALANCE_CHANGE', effects, bank.id);
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'MANUAL_BALANCE_CHANGE', entityType: 'Player', entityId: playerId, beforeJson: { balance: changed.before }, afterJson: { balance: changed.after }, reason } });
      return { id: transaction.id };
    }, async (tx) => this.requirePlayablePlayer(tx, roomId, playerId), undefined, async (result) => {
      if (typeof result.id === 'string') await this.toastNotifier?.fundsCommitted(roomId, result.id);
    });
  }

  async adjustProperty(actor: GameActor, roomId: string, propertyName: string, patch: { ownerPlayerId?: string | null; buildingLevel?: number; mortgaged?: boolean }, reason: string, key: string) {
    if (!reason.trim()) fail('REASON_REQUIRED');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, 'adjust-property', key, { roomId, propertyName, patch, reason }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const property = await tx.roomProperty.findFirst({ where: { roomId, definition: { name: propertyName } } }); if (!property) fail('PROPERTY_NOT_FOUND'); if (property.lockedByRequestId) fail('PROPERTY_LOCKED');
      if (patch.buildingLevel !== undefined && (!Number.isInteger(patch.buildingLevel) || patch.buildingLevel < 0 || patch.buildingLevel > 5)) fail('INVALID_BUILDING_LEVEL');
      const ownerPlayerId = patch.ownerPlayerId === undefined ? property.ownerPlayerId : patch.ownerPlayerId;
      const buildingLevel = patch.buildingLevel === undefined ? property.buildingLevel : patch.buildingLevel;
      const mortgaged = patch.mortgaged === undefined ? property.mortgaged : patch.mortgaged;
      if (ownerPlayerId === null && (buildingLevel !== 0 || mortgaged)) fail('UNOWNED_PROPERTY_MUST_BE_EMPTY');
      if (mortgaged && buildingLevel !== 0) fail('MORTGAGED_PROPERTY_MUST_BE_EMPTY');
      if (ownerPlayerId) { const owner = await tx.player.findUnique({ where: { id: ownerPlayerId } }); if (!owner || owner.roomId !== roomId) fail('PLAYER_NOT_FOUND'); }
      const after = await tx.roomProperty.update({ where: { id: property.id }, data: { ...patch, version: { increment: 1 } } });
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'MANUAL_PROPERTY_CHANGE', entityType: 'RoomProperty', entityId: property.id, beforeJson: property as unknown as Prisma.InputJsonValue, afterJson: after as unknown as Prisma.InputJsonValue, reason } });
      return { id: property.id, version: after.version };
    }, async (tx) => this.requirePlayableAdjustedPropertyOwner(tx, roomId, propertyName, patch.ownerPlayerId));
  }

  async addSkipTurns(actor: GameActor, roomId: string, playerId: string, count: number, source: string, key: string, reason: string) {
    if (!reason?.trim()) fail('REASON_REQUIRED'); if (!key) fail('IDEMPOTENCY_KEY_REQUIRED'); if (!Number.isInteger(count) || count <= 0 || !skipTurnSources.has(source)) fail('INVALID_SKIP_SOURCE');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, 'add-skip-turns', key, { roomId, playerId, count, source, reason }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const player = await tx.player.findFirst({ where: { id: playerId, roomId }, include: { character: true } }); if (!player) fail('PLAYER_NOT_FOUND');
      const config = asObject(player.character?.skillConfig);
      const skilled = source === 'COLD_PALACE' && room.skillEnabled && player.character?.skillCode === 'COLD_PALACE_RELIEF';
      const actualCount = Math.max(0, count - (skilled ? int(config.skipTurnsReduction) : 0));
      const reward = skilled ? int(config.cashReward) : 0;
      const effects: Array<{ playerId: string; amount: number; before: number; after: number; type: string; description: string }> = [];
      if (reward) {
        const balance = await this.changeBalance(tx, playerId, reward);
        effects.push({ playerId, amount: reward, ...balance, type: 'SKILL_REWARD', description: '宜修冷宫补贴' });
      }
      const changed = await tx.player.updateMany({ where: { id: playerId, roomId, version: player.version + (reward ? 1 : 0) }, data: { remainingSkipTurns: { increment: actualCount }, version: { increment: 1 } } }); if (changed.count !== 1) fail('PLAYER_STATE_CHANGED');
      const created = await tx.skipTurnEntry.create({ data: { roomId, playerId, sourceType: source, sourceDescription: reason, originalCount: actualCount, remainingCount: actualCount, blocksTollCollection: source === 'COLD_PALACE', createdBy: bank.id, approvedBy: bank.id } });
      const transaction = effects.length ? await this.recordTransaction(tx, roomId, 'COLD_PALACE_EVENT', effects, bank.id) : null;
      const after = { remainingSkipTurns: player.remainingSkipTurns + actualCount, balance: player.balance + reward };
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'MANUAL_SKIP_TURNS_CHANGE', entityType: 'Player', entityId: playerId, beforeJson: { remainingSkipTurns: player.remainingSkipTurns, balance: player.balance }, afterJson: after, reason } });
      return { id: created.id, playerId, remainingSkipTurns: after.remainingSkipTurns, transactionId: transaction?.id };
    }, async (tx) => this.requirePlayablePlayer(tx, roomId, playerId), undefined, async (result) => {
      if (typeof result.transactionId === 'string') await this.toastNotifier?.fundsCommitted(roomId, result.transactionId);
    });
  }

  async plotFine(actor: GameActor, roomId: string, playerId: string, amount: number, key: string) {
    if (!Number.isInteger(amount) || amount <= 0) fail('INVALID_AMOUNT');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, 'plot-fine', key, { roomId, playerId, amount }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const player = await tx.player.findUnique({ where: { id: playerId }, include: { character: true } }); if (!player || player.roomId !== roomId) fail('PLAYER_NOT_FOUND');
      const amounts = this.transferAmounts(room, player, amount, true);
      const changed = await this.changeBalance(tx, playerId, -amounts.actualAmount);
      const transaction = await this.recordTransaction(tx, roomId, 'PLOT_FINE', [{ playerId, amount: -amounts.actualAmount, ...changed, type: 'PLOT_FINE', description: '剧情罚款' }], bank.id, { recipientType: 'BANK', originalAmount: amounts.originalAmount, reduction: amounts.reduction, actualAmount: amounts.actualAmount, isPlotFine: true });
      return { id: transaction.id, originalAmount: amounts.originalAmount, reduction: amounts.reduction, amount: amounts.actualAmount };
    }, async (tx) => this.requirePlayablePlayer(tx, roomId, playerId), undefined, async (result) => {
      if (typeof result.id === 'string') await this.toastNotifier?.fundsCommitted(roomId, result.id);
    });
  }

  private async consumeSkipTurns(tx: Prisma.TransactionClient, roomId: string, playerId: string, count: number) {
    const player = await tx.player.findFirst({ where: { id: playerId, roomId } });
    if (!player || !Number.isInteger(count) || count <= 0 || player.remainingSkipTurns < count) fail('INSUFFICIENT_SKIP_TURNS');
    const entries = await tx.skipTurnEntry.findMany({ where: { roomId, playerId, remainingCount: { gt: 0 } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (entries.reduce((total, entry) => total + entry.remainingCount, 0) < count) fail('INSUFFICIENT_SKIP_TURNS');
    let remaining = count;
    for (const entry of entries) {
      if (!remaining) break;
      const consumed = Math.min(entry.remainingCount, remaining);
      const changed = await tx.skipTurnEntry.updateMany({ where: { id: entry.id, remainingCount: entry.remainingCount }, data: { remainingCount: { decrement: consumed } } });
      if (changed.count !== 1) fail('SKIP_STATE_CHANGED');
      remaining -= consumed;
    }
    const changed = await tx.player.updateMany({ where: { id: playerId, roomId, version: player.version, remainingSkipTurns: player.remainingSkipTurns }, data: { remainingSkipTurns: { decrement: count }, version: { increment: 1 } } });
    if (changed.count !== 1) fail('SKIP_STATE_CHANGED');
    return { before: player.remainingSkipTurns, after: player.remainingSkipTurns - count };
  }

  async consumeSkip(actor: GameActor, roomId: string, playerId: string, count: number, key: string, reason: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED'); if (!reason?.trim()) fail('REASON_REQUIRED'); if (!Number.isInteger(count) || count <= 0) fail('INSUFFICIENT_SKIP_TURNS');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, 'consume-skip-turn', key, { roomId, playerId, count, reason }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const consumed = await this.consumeSkipTurns(tx, roomId, playerId, count); const response = { remainingSkipTurns: consumed.after };
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'MANUAL_SKIP_TURNS_CHANGE', entityType: 'Player', entityId: playerId, beforeJson: { remainingSkipTurns: consumed.before }, afterJson: response, reason } });
      return response;
    }, async (tx) => this.requirePlayablePlayer(tx, roomId, playerId));
  }

  async invalidateRoll(actor: GameActor, roomId: string, reason: string, key: string) {
    if (!reason.trim()) fail('REASON_REQUIRED');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, 'invalidate-roll', key, { roomId, reason }, async (tx, bank) => {
      const turn = await tx.turn.findFirst({ where: { roomId, status: 'ACTIVE' } }); if (!turn || turn.diceValue === null) fail('ROLL_NOT_FOUND');
      await this.assertRollHasNoSettledActions(tx, roomId, turn.id);
      await this.cancelPendingRequests(tx, roomId, { turnId: turn.id }, 'ROLL_INVALIDATED');
      await tx.landingEvent.updateMany({ where: { roomId, turnId: turn.id, status: { in: ['DECLARED', 'CONFIRMED'] } }, data: { status: 'INVALIDATED', invalidatedAt: new Date() } });
      const updated = await tx.turn.update({ where: { id: turn.id }, data: { die1: null, die2: null, diceValue: null, rolledAt: null, invalidatedAt: new Date() } });
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'INVALIDATE_ROLL', entityType: 'Turn', entityId: turn.id, beforeJson: { die1: turn.die1, die2: turn.die2, total: turn.diceValue }, reason } }); return updated;
    });
  }

  async forceNext(actor: GameActor, roomId: string, reason: string, key: string) {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED'); if (!reason.trim()) fail('REASON_REQUIRED');
    return this.executeIdempotent(actor, roomId, 'BANK', undefined, 'force-next-turn', key, { roomId, reason }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING' || room.diceMode !== 'ELECTRONIC') fail('ELECTRONIC_TURN_REQUIRED');
      const players = await this.playablePlayers(tx, roomId); if (!players.length) fail('PLAYER_COUNT_OUT_OF_RANGE');
      const turn = await tx.turn.findFirst({ where: { roomId, status: 'ACTIVE' } }); if (!turn) fail('TURN_NOT_FOUND'); const index = players.findIndex((player) => player.id === turn.playerId); if (index < 0) fail('PLAYER_NOT_FOUND');
      await this.cancelPendingRequests(tx, roomId, { turnId: turn.id }, 'TURN_FORCED_FORWARD');
      await tx.turn.update({ where: { id: turn.id }, data: { status: 'ENDED', endedAt: new Date() } }); const created = await this.createNextActionableTurn(tx, roomId, players, (index + 1) % players.length, turn.turnNumber + 1);
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'FORCE_NEXT_TURN', entityType: 'Turn', entityId: turn.id, reason } });
      return { id: created.id, number: created.turnNumber, playerId: created.playerId };
    });
  }

  async reverseLatest(actor: GameActor, roomId: string, transactionId: string, reason: string, key: string) {
    if (!reason.trim()) fail('REASON_REQUIRED');
    try {
      return await this.executeIdempotent(actor, roomId, 'BANK', undefined, 'reverse-latest', key, { roomId, transactionId, reason }, async (tx, bank) => {
      const room = await tx.room.findUnique({ where: { id: roomId } }); if (!room || room.status !== 'PLAYING') fail('ROOM_NOT_PLAYING');
      const original = await this.findReversalCandidate(tx, roomId); if (!original) fail('NO_REVERSIBLE_TRANSACTION');
      if (original.id !== transactionId) fail('REVERSAL_TARGET_STALE');
      const metadata = asObject(original.metadata); const propertyId = typeof metadata.propertyId === 'string' ? metadata.propertyId : null; const propertyBefore = asObject(metadata.propertyBefore as Prisma.JsonValue); const propertyAfter = asObject(metadata.propertyAfter as Prisma.JsonValue);
      if (propertyId && Object.keys(propertyBefore).length) {
        const current = await tx.roomProperty.findUnique({ where: { id: propertyId } }); if (!current) fail('PROPERTY_NOT_FOUND');
        if (current.lockedByRequestId !== null || current.version !== propertyAfter.version || current.ownerPlayerId !== (propertyAfter.ownerPlayerId ?? null) || current.buildingLevel !== propertyAfter.buildingLevel || current.mortgaged !== propertyAfter.mortgaged) fail('TRANSACTION_HAS_DEPENDENCIES');
      }
      const reverseEffects: Array<{ playerId: string; amount: number; before: number; after: number; type: string; description: string }> = [];
      for (const entry of [...original.ledgerEntries].reverse()) { const changed = await this.changeBalance(tx, entry.playerId, -entry.amount); reverseEffects.push({ playerId: entry.playerId, amount: -entry.amount, ...changed, type: 'REVERSAL', description: reason }); }
      if (propertyId && Object.keys(propertyBefore).length) {
        const restored = await tx.roomProperty.updateMany({ where: { id: propertyId, lockedByRequestId: null, version: int(propertyAfter.version), ownerPlayerId: propertyAfter.ownerPlayerId as string | null, buildingLevel: int(propertyAfter.buildingLevel), mortgaged: Boolean(propertyAfter.mortgaged) }, data: { ownerPlayerId: propertyBefore.ownerPlayerId as string | null, buildingLevel: int(propertyBefore.buildingLevel), mortgaged: Boolean(propertyBefore.mortgaged), version: { increment: 1 } } });
        if (restored.count !== 1) fail('TRANSACTION_HAS_DEPENDENCIES');
      }
      const reversal = await this.recordTransaction(tx, roomId, 'REVERSAL', reverseEffects, bank.id, { reversesTransactionId: original.id, reason });
      await tx.gameTransaction.update({ where: { id: reversal.id }, data: { reversible: false } });
      await tx.gameTransaction.update({ where: { id: original.id }, data: { status: 'REVERSED', reversedByTransactionId: reversal.id } }); if (original.requestId) await tx.gameRequest.update({ where: { id: original.requestId }, data: { status: 'REVERSED' } });
      const response = { id: original.id, reversed: true, reversalTransactionId: reversal.id };
      await tx.auditLog.create({ data: { roomId, actorMemberId: bank.id, actorRole: 'BANK', action: 'REVERSE_TRANSACTION', entityType: 'GameTransaction', entityId: original.id, reason, afterJson: { reversalTransactionId: reversal.id } } }); return response;
      }, undefined, undefined, async (result) => {
        if (typeof result.reversalTransactionId === 'string') await this.toastNotifier?.fundsCommitted(roomId, result.reversalTransactionId);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') fail('REVERSAL_TARGET_STALE');
      throw error;
    }
  }

  private async findReversalCandidate(tx: Prisma.TransactionClient, roomId: string) {
    const candidates = await tx.gameTransaction.findMany({
      where: { roomId, status: 'COMMITTED', reversible: true, reversedByTransactionId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { ledgerEntries: true, request: true },
    });
    if (!candidates.length) return null;

    const playerIds = [...new Set(candidates.flatMap((candidate) => candidate.ledgerEntries.map((entry) => entry.playerId)))];
    const balances = new Map((await tx.player.findMany({ where: { roomId, id: { in: playerIds } }, select: { id: true, balance: true } })).map((player) => [player.id, player.balance]));
    const propertyIds = [...new Set(candidates.map((candidate) => asObject(candidate.metadata).propertyId).filter((value): value is string => typeof value === 'string'))];
    const properties = new Map((await tx.roomProperty.findMany({ where: { roomId, id: { in: propertyIds } } })).map((property) => [property.id, property]));

    for (const candidate of candidates) {
      const simulatedBalances = new Map(balances);
      let balancesAllowReversal = true;
      for (const entry of candidate.ledgerEntries) {
        const current = simulatedBalances.get(entry.playerId);
        if (current === undefined || current - entry.amount < 0) { balancesAllowReversal = false; break; }
        simulatedBalances.set(entry.playerId, current - entry.amount);
      }
      if (!balancesAllowReversal) continue;

      const metadata = asObject(candidate.metadata);
      const propertyId = typeof metadata.propertyId === 'string' ? metadata.propertyId : null;
      const propertyBefore = asObject(metadata.propertyBefore as Prisma.JsonValue);
      if (candidate.type === 'TOLL') {
        const landingId = typeof metadata.landingId === 'string' ? metadata.landingId : null;
        if (!landingId) continue;
        const landing = await tx.landingEvent.findFirst({
          where: { id: landingId, roomId },
          include: { turn: { select: { status: true } } },
        });
        if (!landing || landing.status !== 'CONFIRMED' || landing.propertyActionsCancelled || (landing.turnId && landing.turn?.status !== 'ACTIVE')) continue;
      }
      if (propertyId && Object.keys(propertyBefore).length) {
        const propertyAfter = asObject(metadata.propertyAfter as Prisma.JsonValue);
        const current = properties.get(propertyId);
        if (!current || current.lockedByRequestId !== null || current.version !== int(propertyAfter.version) || current.ownerPlayerId !== (propertyAfter.ownerPlayerId ?? null) || current.buildingLevel !== int(propertyAfter.buildingLevel) || current.mortgaged !== Boolean(propertyAfter.mortgaged)) continue;
      }
      return candidate;
    }
    return null;
  }

  private async createNextActionableTurn(tx: Prisma.TransactionClient, roomId: string, players: Array<{ id: string }>, startIndex: number, startTurnNumber: number) {
    if (!players.length) fail('PLAYER_COUNT_OUT_OF_RANGE');
    let index = startIndex;
    let turnNumber = startTurnNumber;
    while (true) {
      const candidate = (await this.playablePlayers(tx, roomId, [players[index].id]))[0];
      if (!candidate) fail('PLAYER_NOT_FOUND');
      if (candidate.remainingSkipTurns > 0) {
        const entry = await tx.skipTurnEntry.findFirst({ where: { roomId, playerId: candidate.id, remainingCount: { gt: 0 } }, orderBy: { createdAt: 'asc' } });
        if (!entry) fail('SKIP_ENTRY_MISSING');
        const entryChanged = await tx.skipTurnEntry.updateMany({ where: { id: entry.id, remainingCount: { gt: 0 } }, data: { remainingCount: { decrement: 1 } } });
        const playerChanged = await tx.player.updateMany({ where: { id: candidate.id, roomId, remainingSkipTurns: { gt: 0 } }, data: { remainingSkipTurns: { decrement: 1 }, version: { increment: 1 } } });
        if (entryChanged.count !== 1 || playerChanged.count !== 1) fail('SKIP_STATE_CHANGED');
        await tx.turn.create({ data: { roomId, playerId: candidate.id, turnNumber, status: 'ENDED', endedAt: new Date() } });
        index = (index + 1) % players.length;
        turnNumber += 1;
        continue;
      }
      const created = await tx.turn.create({ data: { roomId, playerId: candidate.id, turnNumber } });
      await tx.room.update({ where: { id: roomId }, data: { currentTurnPlayerId: candidate.id, turnNumber } });
      return created;
    }
  }

  private async cancelPendingRequests(tx: Prisma.TransactionClient, roomId: string, requestFilter: { turnId?: string; landingEventId?: string } | undefined, reason: string) {
    const pending = await tx.gameRequest.findMany({ where: { roomId, status: 'PENDING', ...requestFilter }, select: { id: true } });
    if (!pending.length) return;
    const ids = pending.map((request) => request.id);
    await tx.roomProperty.updateMany({ where: { roomId, lockedByRequestId: { in: ids } }, data: { lockedByRequestId: null } });
    await tx.gameRequest.updateMany({ where: { id: { in: ids }, status: 'PENDING' }, data: { status: 'CANCELLED', resolvedAt: new Date(), rejectionReason: reason } });
  }

  private async invalidatePhysicalLandings(tx: Prisma.TransactionClient, roomId: string, playerId: string) {
    const active = await tx.landingEvent.findMany({ where: { roomId, playerId, turnId: null, status: { in: ['DECLARED', 'CONFIRMED'] } }, select: { id: true } });
    if (!active.length) return;
    for (const landing of active) await this.cancelPendingRequests(tx, roomId, { landingEventId: landing.id }, 'PHYSICAL_LANDING_REPLACED');
    await tx.landingEvent.updateMany({ where: { id: { in: active.map((landing) => landing.id) }, status: { in: ['DECLARED', 'CONFIRMED'] } }, data: { status: 'INVALIDATED', invalidatedAt: new Date() } });
  }

  private async replaceDeclaredElectronicLanding(tx: Prisma.TransactionClient, turnId: string) {
    const confirmed = await tx.landingEvent.findFirst({ where: { turnId, status: 'CONFIRMED' } });
    if (confirmed) fail('LANDING_ALREADY_DECLARED');
    await tx.landingEvent.updateMany({
      where: { turnId, status: 'DECLARED' },
      data: { status: 'INVALIDATED', invalidatedAt: new Date() },
    });
  }

  private async changeBalance(tx: Prisma.TransactionClient, playerId: string, amount: number) {
    if (!Number.isInteger(amount)) fail('INVALID_AMOUNT'); const beforePlayer = await tx.player.findUnique({ where: { id: playerId }, select: { balance: true, version: true } }); if (!beforePlayer) fail('PLAYER_NOT_FOUND');
    if (amount < 0 && beforePlayer.balance < -amount) fail('INSUFFICIENT_BALANCE');
    const changed = await tx.player.updateMany({ where: { id: playerId, version: beforePlayer.version, ...(amount < 0 ? { balance: { gte: -amount } } : {}) }, data: { balance: { increment: amount }, version: { increment: 1 } } }); if (changed.count !== 1) fail('BALANCE_STATE_CHANGED'); return { before: beforePlayer.balance, after: beforePlayer.balance + amount };
  }

  private transferAmounts(
    room: { skillEnabled: boolean },
    player: { character: { skillCode: string; skillConfig: Prisma.JsonValue } | null },
    originalAmount: number,
    isPlotFine: boolean,
  ) {
    const config = asObject(player.character?.skillConfig);
    const reduction = isPlotFine && room.skillEnabled && player.character?.skillCode === 'PLOT_FINE_REDUCTION'
      ? int(config.reduction)
      : 0;
    return { originalAmount, reduction, actualAmount: Math.max(0, originalAmount - reduction) };
  }

  private async recordTransaction(
    tx: Prisma.TransactionClient, roomId: string, type: string,
    effects: Array<{ playerId: string; amount: number; before: number; after: number; type: string; description: string }>,
    createdBy: string | null, metadata: Prisma.InputJsonObject = {}
  ) {
    const transaction = await tx.gameTransaction.create({ data: { roomId, type, metadata: { ...metadata, effects } } });
    if (effects.length) await tx.ledgerEntry.createMany({ data: effects.map((effect) => ({ roomId, transactionId: transaction.id, playerId: effect.playerId, amount: effect.amount, balanceBefore: effect.before, balanceAfter: effect.after, type: effect.type, description: effect.description, createdBy })) }); return transaction;
  }

  private async assertRollHasNoSettledActions(tx: Prisma.TransactionClient, roomId: string, turnId: string) {
    const executedRequest = await tx.gameRequest.findFirst({ where: { roomId, turnId, status: 'EXECUTED' }, select: { id: true } });
    if (executedRequest) fail('ROLL_HAS_SETTLED_ACTIONS');

    const landings = await tx.landingEvent.findMany({ where: { roomId, turnId }, select: { id: true } });
    if (!landings.length) return;
    const settlements = await tx.idempotencyRecord.findMany({
      where: { scope: { in: landings.map((landing) => `landing:${landing.id}:toll`) }, key: 'settled' },
      select: { response: true },
    });
    if (!settlements.length) return;

    const requestKeys = settlements
      .map((settlement) => asObject(settlement.response).requestKey)
      .filter((value): value is string => typeof value === 'string');
    const requestRecords = requestKeys.length ? await tx.idempotencyRecord.findMany({
      where: { scope: `room:${roomId}:toll`, key: { in: requestKeys } },
      select: { key: true, response: true },
    }) : [];
    const transactionByRequestKey = new Map(requestRecords.map((record) => [record.key, asObject(record.response).id]));
    const transactionIds = settlements.map((settlement) => {
      const response = asObject(settlement.response);
      const directId = response.transactionId;
      const fallbackId = typeof response.requestKey === 'string' ? transactionByRequestKey.get(response.requestKey) : undefined;
      return typeof directId === 'string' ? directId : typeof fallbackId === 'string' ? fallbackId : null;
    });
    if (transactionIds.some((transactionId) => transactionId === null)) fail('ROLL_HAS_SETTLED_ACTIONS');
    const committed = await tx.gameTransaction.count({ where: { roomId, id: { in: transactionIds as string[] }, status: 'COMMITTED' } });
    if (committed > 0) fail('ROLL_HAS_SETTLED_ACTIONS');
  }

  private async tollSettlementState(
    tx: Prisma.TransactionClient,
    roomId: string,
    landingId: string,
  ): Promise<{ record: { id: string } | null; status: 'COMMITTED' | 'REVERSED' | 'UNKNOWN' | null; transactionId: string | null }> {
    const record = await tx.idempotencyRecord.findUnique({
      where: { scope_key: { scope: `landing:${landingId}:toll`, key: 'settled' } },
    });
    if (!record) return { record: null, status: null, transactionId: null };

    const response = asObject(record.response);
    let transactionId = typeof response.transactionId === 'string' ? response.transactionId : null;
    if (!transactionId && typeof response.requestKey === 'string') {
      const requestRecord = await tx.idempotencyRecord.findUnique({
        where: { scope_key: { scope: `room:${roomId}:toll`, key: response.requestKey } },
      });
      const requestResponse = asObject(requestRecord?.response);
      transactionId = typeof requestResponse.id === 'string' ? requestResponse.id : null;
    }
    if (!transactionId) return { record: { id: record.id }, status: 'UNKNOWN', transactionId: null };

    const transaction = await tx.gameTransaction.findFirst({
      where: { id: transactionId, roomId },
      select: { status: true },
    });
    return { record: { id: record.id }, status: transaction?.status ?? 'UNKNOWN', transactionId };
  }

  private assertRequestHash(storedHash: string | null, expectedHash: string) {
    if (storedHash !== expectedHash) fail('IDEMPOTENCY_KEY_REUSED');
  }

  private requestWithStateVersion<T extends { payload: Prisma.JsonValue }>(request: T): T & { stateVersion: number } {
    const stateVersion = asObject(request.payload).stateVersion;
    return { ...request, stateVersion: typeof stateVersion === 'number' ? stateVersion : 0 };
  }

  private replayRecord<T extends Record<string, unknown>>(
    record: { requestHash: string | null; response: Prisma.JsonValue },
    expectedHash: string,
  ) {
    this.assertRequestHash(record.requestHash, expectedHash);
    return asObject(record.response) as T;
  }

  private async executeIdempotent<T extends Record<string, unknown>>(
    actor: GameActor,
    roomId: string,
    capability: SnapshotView,
    playerId: string | undefined,
    operation: string,
    key: string,
    input: unknown,
    work: (tx: Prisma.TransactionClient, membership: { id: string }) => Promise<T>,
    validateCurrentParticipants?: (tx: Prisma.TransactionClient) => Promise<unknown>,
    shouldIncrementRoomVersion: () => boolean = () => true,
    afterCommit?: (value: T & { stateVersion: number }) => void | Promise<void>,
  ): Promise<T & { stateVersion: number }> {
    if (!key) fail('IDEMPOTENCY_KEY_REQUIRED');
    const scope = `account:${actor.accountId}:room:${roomId}:${operation}`;
    const expectedHash = requestFingerprint(input);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const execution = await this.db.$transaction(async (tx) => {
          await this.lockRoom(tx, roomId);
          const membership = await this.authorizeActor(tx, actor, roomId, capability, playerId);
          await validateCurrentParticipants?.(tx);
          const previous = await tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
          if (previous) return { response: this.replayRecord<T>(previous, expectedHash) as T & { stateVersion: number }, created: false };
          const value = await work(tx, membership);
          const room = shouldIncrementRoomVersion()
            ? await tx.room.update({ where: { id: roomId }, data: { stateVersion: { increment: 1 } }, select: { stateVersion: true } })
            : await tx.room.findUniqueOrThrow({ where: { id: roomId }, select: { stateVersion: true } });
          const response = { ...value, stateVersion: room.stateVersion };
          await tx.idempotencyRecord.create({
            data: {
              scope,
              key,
              requestHash: expectedHash,
              response: canonicalValue(response) as Prisma.InputJsonObject,
            },
          });
          return { response, created: true };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (execution.created && afterCommit) {
          try {
            await afterCommit(execution.response);
          } catch {
            // Notification delivery is best-effort after the money mutation commits.
          }
        }
        return execution.response;
      } catch (error) {
        const retryableConflict = (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || isSerializationConflict(error);
        if (retryableConflict && attempt < 5) {
          continue;
        }
        return this.replayIdempotencyConflict<T>(actor, roomId, capability, playerId, scope, key, expectedHash, error, validateCurrentParticipants) as Promise<T & { stateVersion: number }>;
      }
    }
    fail('TRANSACTION_RETRY_EXHAUSTED');
  }

  private async replayIdempotencyConflict<T extends Record<string, unknown>>(
    actor: GameActor,
    roomId: string,
    capability: SnapshotView,
    playerId: string | undefined,
    scope: string,
    key: string,
    expectedHash: string,
    error: unknown,
    validateCurrentParticipants?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<T> {
    if ((error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || isSerializationConflict(error)) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const previous = await this.db.$transaction(async (tx) => {
          await this.lockRoom(tx, roomId);
          await this.authorizeActor(tx, actor, roomId, capability, playerId);
          await validateCurrentParticipants?.(tx);
          return tx.idempotencyRecord.findUnique({ where: { scope_key: { scope, key } } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (previous) return this.replayRecord<T>(previous, expectedHash);
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
      fail('TRANSACTION_CONFLICT');
    }
    throw error;
  }

  private async lockRoom(tx: Prisma.TransactionClient, roomId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Room" WHERE "id" = ${roomId} FOR UPDATE
    `;
    if (!rows.length) fail('ROOM_NOT_FOUND');
  }

  private async authorizeActor(
    tx: Prisma.TransactionClient,
    actor: GameActor,
    roomId: string,
    capability?: SnapshotView,
    playerId?: string,
  ) {
    const session = await tx.accountSession.findFirst({
      where: { id: actor.sessionId, accountId: actor.accountId },
      include: { account: { select: { status: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.account.status !== 'ACTIVE') fail('SESSION_INVALID');
    const membership = await tx.roomMembership.findUnique({
      where: { roomId_accountId: { roomId, accountId: actor.accountId } },
      include: { player: true, room: true },
    });
    if (!membership || membership.status !== 'ACTIVE') fail('ROOM_MEMBERSHIP_REQUIRED');
    if (membership.activeSessionId !== actor.sessionId) fail('ROOM_CONTROL_LOST');
    if (['ENDED', 'FINISHED', 'CLOSED'].includes(membership.room.status)) fail('ROOM_FINISHED');
    if (capability === 'BANK' && !membership.isBank) fail('BANK_REQUIRED');
    if (capability === 'PLAYER') {
      if (!membership.characterId || !membership.player || membership.player.status !== 'ACTIVE' || membership.player.characterId !== membership.characterId) fail('PLAYER_IDENTITY_MISMATCH');
      if (playerId && membership.player.id !== playerId) fail('PLAYER_IDENTITY_MISMATCH');
    }
    return membership;
  }

  private async replayRequestConflict(
    actor: GameActor,
    roomId: string,
    capability: SnapshotView,
    playerId: string | undefined,
    key: string,
    expectedHash: string,
    error: unknown,
    fallbackCode = 'TRANSACTION_CONFLICT',
    validateCurrentParticipants?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    if ((error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || isSerializationConflict(error)) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await this.db.$transaction(async (tx) => {
          await this.lockRoom(tx, roomId);
          await this.authorizeActor(tx, actor, roomId, capability, playerId);
          await validateCurrentParticipants?.(tx);
          return tx.gameRequest.findUnique({ where: { roomId_idempotencyKey: { roomId, idempotencyKey: key } } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (existing) {
          this.assertRequestHash(existing.requestHash, expectedHash);
          return existing;
        }
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
      fail(fallbackCode);
    }
    throw error;
  }

}
