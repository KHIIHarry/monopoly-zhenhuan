import { describe, expect, it, vi } from 'vitest';
import { buildFundToastDeliveries, buildRejectionToastDelivery } from './realtime-toast-notifications.js';

function entry(playerId: string, name: string, activeSessionId: string | null, amount: number, description: string) {
  return {
    id: `entry-${playerId}`,
    playerId,
    amount,
    description,
    player: { member: { displayNameSnapshot: name, activeSessionId } },
  };
}

function databaseFor(transaction: Record<string, unknown> | null, bankSessionId: string | null = 'bank-session') {
  return {
    gameTransaction: { findUnique: vi.fn(async () => transaction) },
    roomMembership: { findFirst: vi.fn(async () => bankSessionId ? { activeSessionId: bankSessionId } : null) },
    gameRequest: { findUnique: vi.fn(async () => null) },
  };
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

    await expect(buildFundToastDeliveries(database as never, 'tx-transfer')).resolves.toEqual([
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

    const deliveries = await buildFundToastDeliveries(database as never, `tx-${type}`);

    expect(deliveries.map(({ event }) => event.message)).toEqual([playerMessage, bankMessage]);
  });

  it('does not leak to unrelated players and skips missing sessions and zero effects', async () => {
    const database = databaseFor({
      id: 'tx-zero', roomId: 'room-1', type: 'NO_CASH', metadata: {},
      ledgerEntries: [entry('payer', '钮祜禄·甄嬛', null, 0, '无资金变化')],
    }, null);

    await expect(buildFundToastDeliveries(database as never, 'tx-zero')).resolves.toEqual([]);
    expect(database.roomMembership.findFirst).not.toHaveBeenCalled();
  });
});

describe('request rejection Toast delivery', () => {
  it('targets only the applying player and includes the bank reason', async () => {
    const database = databaseFor(null);
    database.gameRequest.findUnique.mockResolvedValueOnce({
      id: 'request-1', roomId: 'room-1', type: 'PLAYER_TRANSFER', status: 'REJECTED', rejectionReason: '金额有误',
      actor: { id: 'payer', member: { activeSessionId: 'payer-session' } },
    } as never);

    await expect(buildRejectionToastDelivery(database as never, 'request-1')).resolves.toEqual({
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
    } as never);

    await expect(buildRejectionToastDelivery(database as never, 'request-2')).resolves.toBeNull();
  });
});
