import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  buildFundToastDeliveries,
  buildLandingRejectionToastDelivery,
  buildRejectionToastDelivery,
  buildTransferApprovedToastDelivery,
  buildTransferFailureToastDelivery,
  buildTransferRequestedToastDelivery,
} from './realtime-toast-notifications.js';

function entry(playerId: string, name: string, activeSessionId: string | null, amount: number, description: string, id = `entry-${playerId}`) {
  return {
    id,
    playerId,
    amount,
    description,
    player: { member: { displayNameSnapshot: name, activeSessionId } },
  };
}

function databaseFor(transaction: Record<string, unknown> | null, bankSessionId: string | null = 'bank-session') {
  const database = new PrismaClient();
  vi.spyOn(database.gameTransaction, 'findUnique').mockImplementation(async () => transaction);
  vi.spyOn(database.roomMembership, 'findFirst').mockImplementation(async () => bankSessionId ? { activeSessionId: bankSessionId } : null);
  vi.spyOn(database.gameRequest, 'findUnique').mockImplementation(async () => null);
  vi.spyOn(database.landingEvent, 'findUnique').mockImplementation(async () => null);
  vi.spyOn(database.player, 'findFirst').mockImplementation(async () => null);
  return database;
}

describe('fund Toast deliveries', () => {
  it('suppresses the lifecycle transfer payer while retaining receiver and bank deliveries', async () => {
    const database = databaseFor({
      id: 'tx-transfer',
      roomId: 'room-1',
      type: 'PLAYER_TRANSFER',
      metadata: { recipientType: 'PLAYER' },
      ledgerEntries: [
        entry('payer', '钮祜禄·甄嬛', 'payer-session', -500, '玩家转出'),
        entry('receiver', '沈眉庄', 'receiver-session', 500, '玩家转入'),
      ],
    });

    await expect(buildFundToastDeliveries(database, 'tx-transfer')).resolves.toEqual([
      {
        sessionId: 'receiver-session',
        event: {
          eventId: 'tx-transfer:PLAYER:receiver', roomId: 'room-1', audience: 'PLAYER', kind: 'FUNDS',
          message: '钮祜禄·甄嬛向你转入 500 两',
        },
      },
      {
        sessionId: 'bank-session',
        event: {
          eventId: 'tx-transfer:BANK', roomId: 'room-1', audience: 'BANK', kind: 'FUNDS',
          message: '钮祜禄·甄嬛向沈眉庄支付 500 两',
        },
      },
    ]);
  });

  it.each([
    ['START_REWARD', 1_000, '精确停留起点奖励', '银行向你发放起点奖励 1000 两', '银行向钮祜禄·甄嬛支付 1000 两（起点奖励）'],
    ['MANUAL_BALANCE_CHANGE', -300, '剧情罚款', '银行扣除你 300 两（剧情罚款）', '银行收到钮祜禄·甄嬛支付 300 两（剧情罚款）'],
    ['PLAYER_BANK_PAYMENT', -1_200, '支付银行', '你向银行支付 1200 两', '银行收到钮祜禄·甄嬛支付 1200 两'],
    ['REVERSAL', 500, '撤销付款', '银行向你发放撤销付款 500 两', '银行向钮祜禄·甄嬛支付 500 两（撤销付款）'],
  ])('formats one-sided %s effects for player and bank', async (type, amount, description, playerMessage, bankMessage) => {
    const database = databaseFor({
      id: `tx-${type}`,
      roomId: 'room-1',
      type,
      metadata: type === 'REVERSAL' ? { reversesTransactionId: 'original' } : {},
      ledgerEntries: [entry('payer', '钮祜禄·甄嬛', 'payer-session', amount, description)],
    });

    const deliveries = await buildFundToastDeliveries(database, `tx-${type}`);

    expect(deliveries.map(({ event }) => event.message)).toEqual([playerMessage, bankMessage]);
  });

  it('ignores zero-effect transactions without looking up the bank', async () => {
    const database = databaseFor({
      id: 'tx-zero', roomId: 'room-1', type: 'NO_CASH', metadata: {},
      ledgerEntries: [entry('payer', '钮祜禄·甄嬛', null, 0, '无资金变化')],
    }, null);

    await expect(buildFundToastDeliveries(database, 'tx-zero')).resolves.toEqual([]);
    expect(database.roomMembership.findFirst).not.toHaveBeenCalled();
  });

  it('represents every non-zero entry to the bank when a transaction is not an exact pair', async () => {
    const database = databaseFor({
      id: 'tx-multi', roomId: 'room-1', type: 'MANUAL_BALANCE_CHANGE', metadata: {},
      ledgerEntries: [
        entry('payer', '钮祜禄·甄嬛', 'payer-session', -500, '剧情罚款'),
        entry('receiver', '沈眉庄', 'receiver-session', 300, '补偿'),
        entry('other', '安陵容', 'other-session', 200, '补偿'),
      ],
    });

    const deliveries = await buildFundToastDeliveries(database, 'tx-multi');
    const bankDeliveries = deliveries.filter(({ event }) => event.audience === 'BANK');

    expect(bankDeliveries).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ eventId: 'tx-multi:BANK:entry-payer', message: '银行收到钮祜禄·甄嬛支付 500 两（剧情罚款）' }) }),
      expect.objectContaining({ event: expect.objectContaining({ eventId: 'tx-multi:BANK:entry-receiver', message: '银行向沈眉庄支付 300 两（补偿）' }) }),
      expect.objectContaining({ event: expect.objectContaining({ eventId: 'tx-multi:BANK:entry-other', message: '银行向安陵容支付 200 两（补偿）' }) }),
    ]);
    expect(new Set(bankDeliveries.map(({ event }) => event.eventId)).size).toBe(3);
    expect(deliveries.every(({ event }) => event.message.length <= 240)).toBe(true);
  });

  it('gives repeated player effects stable, distinct event IDs', async () => {
    const database = databaseFor({
      id: 'tx-repeat-player', roomId: 'room-1', type: 'MANUAL_BALANCE_CHANGE', metadata: {},
      ledgerEntries: [
        entry('payer', '钮祜禄·甄嬛', 'payer-session', 100, '剧情补偿', 'entry-first'),
        entry('payer', '钮祜禄·甄嬛', 'payer-session', 200, '银行奖励', 'entry-second'),
      ],
    });

    const playerDeliveries = (await buildFundToastDeliveries(database, 'tx-repeat-player'))
      .filter(({ event }) => event.audience === 'PLAYER');

    expect(playerDeliveries).toHaveLength(2);
    expect(playerDeliveries.map(({ event }) => event.eventId)).toEqual([
      'tx-repeat-player:PLAYER:payer:entry-first',
      'tx-repeat-player:PLAYER:payer:entry-second',
    ]);
  });

  it('skips inactive participants while delivering non-zero effects to active participants and the bank', async () => {
    const database = databaseFor({
      id: 'tx-inactive', roomId: 'room-1', type: 'PLAYER_TRANSFER', metadata: { recipientType: 'PLAYER' },
      ledgerEntries: [
        entry('payer', '钮祜禄·甄嬛', null, -500, '玩家转出'),
        entry('receiver', '沈眉庄', 'receiver-session', 500, '玩家转入'),
      ],
    });

    const deliveries = await buildFundToastDeliveries(database, 'tx-inactive');

    expect(deliveries.map(({ sessionId }) => sessionId)).toEqual(['receiver-session', 'bank-session']);
    expect(deliveries[0]?.event.message).toBe('钮祜禄·甄嬛向你转入 500 两');
  });

  it('never targets an unrelated active member', async () => {
    const database = databaseFor({
      id: 'tx-private', roomId: 'room-1', type: 'MANUAL_BALANCE_CHANGE', metadata: {},
      ledgerEntries: [entry('payer', '钮祜禄·甄嬛', 'payer-session', -300, '剧情罚款')],
    });
    const unrelatedActiveSessionId = 'unrelated-session';

    const deliveries = await buildFundToastDeliveries(database, 'tx-private');

    expect(deliveries.map(({ sessionId }) => sessionId)).toEqual(['payer-session', 'bank-session']);
    expect(deliveries.map(({ sessionId }) => sessionId)).not.toContain(unrelatedActiveSessionId);
    expect(database.roomMembership.findFirst).toHaveBeenCalledWith({
      where: { roomId: 'room-1', status: 'ACTIVE', isBank: true },
      select: { activeSessionId: true },
    });
  });

  it('keeps every fund payload within the realtime wire limit', async () => {
    const database = databaseFor({
      id: 'tx-long-reason', roomId: 'room-1', type: 'MANUAL_BALANCE_CHANGE', metadata: {},
      ledgerEntries: [entry('payer', '钮祜禄·甄嬛', 'payer-session', -300, '剧情'.repeat(200))],
    });

    const deliveries = await buildFundToastDeliveries(database, 'tx-long-reason');

    expect(deliveries).toHaveLength(2);
    expect(deliveries.every(({ event }) => event.message.length <= 240)).toBe(true);
  });

  it.each([
    ['PLAYER_BANK_PAYMENT', { recipientType: 'BANK' }, '支付银行'],
    ['PLOT_FINE', { recipientType: 'BANK', isPlotFine: true }, '支付剧情罚款'],
  ])('suppresses only the payer for unified %s transfers while retaining the bank delivery', async (type, metadata, description) => {
    const database = databaseFor({
      id: `tx-${type}`, roomId: 'room-1', type, metadata,
      ledgerEntries: [entry('payer', '钮祜禄·甄嬛', 'payer-session', -500, description)],
    });

    await expect(buildFundToastDeliveries(database, `tx-${type}`)).resolves.toEqual([
      expect.objectContaining({ sessionId: 'bank-session', event: expect.objectContaining({ audience: 'BANK' }) }),
    ]);
  });

  it('suppresses only the payer for a unified plot-fine transfer to another player', async () => {
    const database = databaseFor({
      id: 'tx-plot-fine-player', roomId: 'room-1', type: 'PLOT_FINE', metadata: { recipientType: 'PLAYER' },
      ledgerEntries: [
        entry('payer', '钮祜禄·甄嬛', 'payer-session', -500, '支付剧情罚款'),
        entry('receiver', '沈眉庄', 'receiver-session', 500, '收到剧情罚款'),
      ],
    });

    const deliveries = await buildFundToastDeliveries(database, 'tx-plot-fine-player');

    expect(deliveries.map(({ sessionId }) => sessionId)).toEqual(['receiver-session', 'bank-session']);
    expect(deliveries[0]?.event.audience).toBe('PLAYER');
    expect(deliveries[1]?.event.audience).toBe('BANK');
  });

  it('keeps ordinary player-bank payments visible to both payer and bank', async () => {
    const database = databaseFor({
      id: 'tx-ordinary-bank-payment', roomId: 'room-1', type: 'PLAYER_BANK_PAYMENT', metadata: {},
      ledgerEntries: [entry('payer', '钮祜禄·甄嬛', 'payer-session', -500, '支付银行')],
    });

    await expect(buildFundToastDeliveries(database, 'tx-ordinary-bank-payment')).resolves.toHaveLength(2);
  });

  it('keeps bank-imposed plot fines visible to both player and bank', async () => {
    const database = databaseFor({
      id: 'tx-bank-plot-fine', roomId: 'room-1', type: 'PLOT_FINE',
      metadata: { recipientType: 'BANK', isPlotFine: true },
      ledgerEntries: [entry('payer', '钮祜禄·甄嬛', 'payer-session', -500, '剧情罚款')],
    });

    const deliveries = await buildFundToastDeliveries(database, 'tx-bank-plot-fine');

    expect(deliveries.map(({ sessionId }) => sessionId)).toEqual(['payer-session', 'bank-session']);
    expect(deliveries[0]?.event.message).toBe('银行扣除你 500 两（剧情罚款）');
  });
});

describe('request rejection Toast delivery', () => {
  it('targets only the applying player and includes the bank reason', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce({
      id: 'request-1', roomId: 'room-1', type: 'PLAYER_TRANSFER', status: 'REJECTED', rejectionReason: '金额有误',
      actor: { id: 'payer', member: { activeSessionId: 'payer-session' } },
    });

    await expect(buildRejectionToastDelivery(database, 'request-1')).resolves.toEqual({
      sessionId: 'payer-session',
      event: {
        eventId: 'request-1:rejected:PLAYER:payer', roomId: 'room-1', audience: 'PLAYER', kind: 'REQUEST_REJECTED',
        message: '转账申请已被银行拒绝：金额有误',
      },
    });
  });

  it('ignores unresolved requests and applicants without an active Session', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce({
      id: 'request-2', roomId: 'room-1', type: 'BANK_PAYMENT', status: 'PENDING', rejectionReason: null,
      actor: { id: 'payer', member: { activeSessionId: null } },
    });

    await expect(buildRejectionToastDelivery(database, 'request-2')).resolves.toBeNull();
  });

  it('keeps rejection messages within the realtime wire limit', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce({
      id: 'request-long', roomId: 'room-1', type: 'BANK_PAYMENT', status: 'REJECTED', rejectionReason: '原因'.repeat(200),
      actor: { id: 'payer', member: { activeSessionId: 'payer-session' } },
    });

    const delivery = await buildRejectionToastDelivery(database, 'request-long');

    expect(delivery?.event.message.length).toBeLessThanOrEqual(240);
  });

  it('retains existing rejection wording for non-transfer requests', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce({
      id: 'request-payment', roomId: 'room-1', type: 'BANK_PAYMENT', status: 'REJECTED', rejectionReason: '金额有误',
      actor: { id: 'payer', member: { activeSessionId: 'payer-session' } },
    });

    await expect(buildRejectionToastDelivery(database, 'request-payment')).resolves.toMatchObject({
      event: { message: '你的银行付款申请已被银行拒绝：金额有误' },
    });
  });
});

function transferRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-player', roomId: 'room-1', type: 'PLAYER_TRANSFER', status: 'PENDING', amount: 500,
    payload: { recipientType: 'PLAYER' },
    actor: { id: 'payer', member: { displayNameSnapshot: '张三', activeSessionId: 'payer-session' } },
    target: { id: 'receiver', member: { displayNameSnapshot: '李四', activeSessionId: 'receiver-session' } },
    ...overrides,
  };
}

describe('transfer lifecycle Toast deliveries', () => {
  it('delivers a persisted player-recipient transfer request only to the active bank Session', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce(transferRequest());

    await expect(buildTransferRequestedToastDelivery(database, 'request-player')).resolves.toEqual({
      sessionId: 'bank-session',
      event: {
        eventId: 'request-player:requested:BANK',
        roomId: 'room-1',
        audience: 'BANK',
        kind: 'TRANSFER_REQUESTED',
        message: '收到张三的转账申请：向李四支付 500 两',
      },
    });
  });

  it('uses the bank recipient name for persisted bank transfer requests', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce(transferRequest({
      id: 'request-bank', payload: { recipientType: 'BANK' }, target: null,
    }));

    await expect(buildTransferRequestedToastDelivery(database, 'request-bank')).resolves.toMatchObject({
      event: { message: '收到张三的转账申请：向银行支付 500 两' },
    });
  });

  it('delivers an executed transfer approval only to the persisted payer Session', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce(transferRequest({ status: 'EXECUTED' }));

    await expect(buildTransferApprovedToastDelivery(database, 'request-player')).resolves.toEqual({
      sessionId: 'payer-session',
      event: {
        eventId: 'request-player:approved:PLAYER:payer',
        roomId: 'room-1',
        audience: 'PLAYER',
        kind: 'TRANSFER_APPROVED',
        message: '银行审批通过，转账已成功，结果已同步至账本',
      },
    });
  });

  it('delivers a server-observed submission failure only to the active bank Session', async () => {
    const database = databaseFor(null);
    database.player.findFirst.mockResolvedValueOnce({ member: { displayNameSnapshot: '张三' } });

    await expect(buildTransferFailureToastDelivery(database, {
      phase: 'SUBMISSION', roomId: 'room-1', playerId: 'payer',
      attemptId: 'attempt-submit-1', reasonCode: 'INSUFFICIENT_BALANCE',
    })).resolves.toMatchObject({
      sessionId: 'bank-session',
      event: {
        eventId: 'attempt-submit-1:submission-failed:BANK',
        audience: 'BANK',
        kind: 'TRANSFER_FAILED',
        message: '张三的转账申请提交失败：余额不足',
      },
    });
  });

  it('delivers a pending transfer approval failure only to the persisted payer Session', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce(transferRequest());

    await expect(buildTransferFailureToastDelivery(database, {
      phase: 'APPROVAL', roomId: 'room-1', requestId: 'request-player',
      attemptId: 'attempt-approve-1', reasonCode: 'INSUFFICIENT_BALANCE',
    })).resolves.toMatchObject({
      sessionId: 'payer-session',
      event: {
        eventId: 'request-player:approval-failed:attempt-approve-1',
        audience: 'PLAYER',
        kind: 'TRANSFER_FAILED',
        message: '银行审批执行失败：余额不足',
      },
    });
  });

  it('returns no lifecycle delivery for missing or inactive persisted recipients', async () => {
    const noBank = databaseFor(null, null);
    noBank.gameRequest.findUnique.mockResolvedValueOnce(transferRequest());
    await expect(buildTransferRequestedToastDelivery(noBank, 'request-player')).resolves.toBeNull();

    const noPayerSession = databaseFor(null);
    noPayerSession.gameRequest.findUnique.mockResolvedValueOnce(transferRequest({ status: 'EXECUTED', actor: { id: 'payer', member: { displayNameSnapshot: '张三', activeSessionId: null } } }));
    await expect(buildTransferApprovedToastDelivery(noPayerSession, 'request-player')).resolves.toBeNull();

    const missingPayer = databaseFor(null);
    await expect(buildTransferFailureToastDelivery(missingPayer, {
      phase: 'SUBMISSION', roomId: 'room-1', playerId: 'payer', attemptId: 'attempt', reasonCode: 'INTERNAL_ERROR',
    })).resolves.toBeNull();
  });

  it('rejects lifecycle deliveries for unrelated request types and non-pending approval failures', async () => {
    const requested = databaseFor(null);
    requested.gameRequest.findUnique.mockResolvedValueOnce(transferRequest({ type: 'BANK_PAYMENT' }));
    await expect(buildTransferRequestedToastDelivery(requested, 'request-player')).resolves.toBeNull();

    const approved = databaseFor(null);
    approved.gameRequest.findUnique.mockResolvedValueOnce(transferRequest({ type: 'BANK_PAYMENT', status: 'EXECUTED' }));
    await expect(buildTransferApprovedToastDelivery(approved, 'request-player')).resolves.toBeNull();

    const resolved = databaseFor(null);
    resolved.gameRequest.findUnique.mockResolvedValueOnce(transferRequest({ status: 'EXECUTED' }));
    await expect(buildTransferFailureToastDelivery(resolved, {
      phase: 'APPROVAL', roomId: 'room-1', requestId: 'request-player', attemptId: 'attempt', reasonCode: 'INTERNAL_ERROR',
    })).resolves.toBeNull();
  });

  it('does not deliver an approval failure when its observed room differs from the persisted request room', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce(transferRequest());

    await expect(buildTransferFailureToastDelivery(database, {
      phase: 'APPROVAL', roomId: 'room-other', requestId: 'request-player', attemptId: 'attempt', reasonCode: 'INTERNAL_ERROR',
    })).resolves.toBeNull();
  });

  it('bounds lifecycle messages to the realtime wire length', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce(transferRequest({
      actor: { id: 'payer', member: { displayNameSnapshot: '张三'.repeat(100), activeSessionId: 'payer-session' } },
      target: { id: 'receiver', member: { displayNameSnapshot: '李四'.repeat(100), activeSessionId: 'receiver-session' } },
    }));

    const delivery = await buildTransferRequestedToastDelivery(database, 'request-player');

    expect(delivery?.event.message.length).toBeLessThanOrEqual(240);
    expect(delivery?.sessionId).toBe('bank-session');
  });
});

describe('landing rejection Toast delivery', () => {
  it('targets the landing player with the bank cancellation reason', async () => {
    const database = databaseFor(null);
    database.landingEvent.findUnique.mockResolvedValueOnce({
      id: 'landing-1', roomId: 'room-1', propertyActionsCancelled: true,
      player: { id: 'player-1', member: { activeSessionId: 'player-session' } },
    });

    await expect(buildLandingRejectionToastDelivery(database, 'landing-1', '  现场落点有误  ')).resolves.toEqual({
      sessionId: 'player-session',
      event: {
        eventId: 'landing-1:rejected:PLAYER:player-1',
        roomId: 'room-1',
        audience: 'PLAYER',
        kind: 'REQUEST_REJECTED',
        message: '你的落点申请已被银行拒绝：现场落点有误',
      },
    });
  });

  it('returns null for a missing landing', async () => {
    await expect(buildLandingRejectionToastDelivery(databaseFor(null), 'missing', '现场落点有误')).resolves.toBeNull();
  });

  it('returns null when property actions were not cancelled', async () => {
    const database = databaseFor(null);
    database.landingEvent.findUnique.mockResolvedValueOnce({
      id: 'landing-1', roomId: 'room-1', propertyActionsCancelled: false,
      player: { id: 'player-1', member: { activeSessionId: 'player-session' } },
    });

    await expect(buildLandingRejectionToastDelivery(database, 'landing-1', '现场落点有误')).resolves.toBeNull();
  });

  it('returns null when the landing player has no active Session', async () => {
    const database = databaseFor(null);
    database.landingEvent.findUnique.mockResolvedValueOnce({
      id: 'landing-1', roomId: 'room-1', propertyActionsCancelled: true,
      player: { id: 'player-1', member: { activeSessionId: null } },
    });

    await expect(buildLandingRejectionToastDelivery(database, 'landing-1', '现场落点有误')).resolves.toBeNull();
  });
});
