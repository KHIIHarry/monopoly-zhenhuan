import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { buildFundToastDeliveries, buildRejectionToastDelivery } from './realtime-toast-notifications.js';

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
  return database;
}

describe('fund Toast deliveries', () => {
  it('targets payer, receiver, and bank with their own player-transfer wording', async () => {
    const database = databaseFor({
      id: 'tx-transfer',
      roomId: 'room-1',
      type: 'PLAYER_TRANSFER',
      metadata: {},
      ledgerEntries: [
        entry('payer', '钮祜禄·甄嬛', 'payer-session', -500, '玩家转出'),
        entry('receiver', '沈眉庄', 'receiver-session', 500, '玩家转入'),
      ],
    });

    await expect(buildFundToastDeliveries(database, 'tx-transfer')).resolves.toEqual([
      {
        sessionId: 'payer-session',
        event: {
          eventId: 'tx-transfer:PLAYER:payer', roomId: 'room-1', audience: 'PLAYER', kind: 'FUNDS',
          message: '你向沈眉庄支付 500 两',
        },
      },
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
      id: 'tx-inactive', roomId: 'room-1', type: 'PLAYER_TRANSFER', metadata: {},
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
        message: '你的转帐申请已被银行拒绝：金额有误',
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
});
