import type { PrismaClient } from '@prisma/client';
import type { RealtimeToastEvent } from '@zhenhuan/shared';

export type ToastDelivery = { sessionId: string; event: RealtimeToastEvent };

export type PostCommitToastNotifier = {
  fundsCommitted: (roomId: string, transactionId: string) => void | Promise<void>;
  requestRejected: (roomId: string, requestId: string) => void | Promise<void>;
};

type FundEntry = {
  id: string;
  playerId: string;
  amount: number;
  description: string;
  player: { member: { displayNameSnapshot: string; activeSessionId: string | null } };
};
type FundTransaction = {
  id: string;
  roomId: string;
  type: string;
  metadata: unknown;
  ledgerEntries: FundEntry[];
};

const requestLabels: Record<string, string> = {
  PLAYER_TRANSFER: '转帐',
  BANK_PAYMENT: '银行付款',
  BUY_PROPERTY: '购买地产',
  BUILD_PROPERTY: '升级地产',
  SELL_BUILDING: '出售建筑',
  MORTGAGE_PROPERTY: '抵押地产',
  REDEEM_PROPERTY: '赎回地产',
  SELL_PROPERTY_TO_BANK: '出售地产',
  TRADE_PROPERTY: '地产交易',
  START_REWARD: '起点奖励',
  COLD_PALACE_EVENT: '冷宫事件',
  COMPANION_EVENT: '伙伴事件',
  RETURN_COMPANION_EVENT: '放回伙伴卡',
  PLOT_REST_EVENT: '地块停轮',
  CONSUME_SKIP_TURNS: '减除停轮',
};

const money = (amount: number) => String(Math.abs(amount));
const suffix = (reason: string | null) => reason ? `（${reason}）` : '';
const wireMessage = (message: string) => message.length <= 240 ? message : `${message.slice(0, 237)}...`;

function normalizedReason(type: string, description: string) {
  if (type === 'START_REWARD') return '起点奖励';
  if (type === 'INITIAL_BALANCE') return '初始资金';
  if (type === 'REVERSAL') return description.includes('撤销') ? description : `撤销：${description}`;
  if (type === 'PLAYER_BANK_PAYMENT' && description === '支付银行') return null;
  if (type === 'PLAYER_TRANSFER' && (description === '玩家转出' || description === '玩家转入')) return null;
  return description.trim() || null;
}

function playerBankMessage(transaction: FundTransaction, entry: FundEntry) {
  const amount = money(entry.amount);
  const reason = normalizedReason(transaction.type, entry.description);
  if (entry.amount < 0) {
    if (transaction.type === 'PLAYER_BANK_PAYMENT' || entry.description === '支付银行') {
      return `你向银行支付 ${amount} 两${suffix(reason)}`;
    }
    return `银行扣除你 ${amount} 两${suffix(reason)}`;
  }
  if (transaction.type === 'BANK_PAYMENT') return `银行向你支付 ${amount} 两${suffix(reason)}`;
  return `银行向你发放${reason ?? '奖励'} ${amount} 两`;
}

function bankPlayerMessage(transaction: FundTransaction, entry: FundEntry) {
  const amount = money(entry.amount);
  const reason = normalizedReason(transaction.type, entry.description);
  return entry.amount < 0
    ? `银行收到${entry.player.member.displayNameSnapshot}支付 ${amount} 两${suffix(reason)}`
    : `银行向${entry.player.member.displayNameSnapshot}支付 ${amount} 两${suffix(reason)}`;
}

function pairReason(transaction: FundTransaction, paid: FundEntry) {
  if (transaction.type === 'PLAYER_TRANSFER') return null;
  const reason = normalizedReason(transaction.type, paid.description);
  if (transaction.type === 'TOLL' && reason?.startsWith('支付')) return reason.slice(2);
  return reason;
}

export async function buildFundToastDeliveries(
  database: Pick<PrismaClient, 'gameTransaction' | 'roomMembership'>,
  transactionId: string,
): Promise<ToastDelivery[]> {
  const transaction = await database.gameTransaction.findUnique({
    where: { id: transactionId },
    include: {
      ledgerEntries: {
        include: { player: { include: { member: { select: { displayNameSnapshot: true, activeSessionId: true } } } } },
        orderBy: { id: 'asc' },
      },
    },
  }) as FundTransaction | null;
  if (!transaction) return [];

  const entries = transaction.ledgerEntries.filter((entry) => entry.amount !== 0);
  if (!entries.length) return [];
  const paid = entries.find((entry) => entry.amount < 0);
  const received = entries.find((entry) => entry.amount > 0);
  const paired = entries.length === 2 && paid && received && -paid.amount === received.amount;
  const playerEntryCounts = new Map<string, number>();
  for (const entry of entries) {
    playerEntryCounts.set(entry.playerId, (playerEntryCounts.get(entry.playerId) ?? 0) + 1);
  }
  const deliveries: ToastDelivery[] = [];

  for (const entry of entries) {
    const sessionId = entry.player.member.activeSessionId;
    if (!sessionId) continue;
    let message = playerBankMessage(transaction, entry);
    if (paired) {
      const other = entry === paid ? received : paid;
      const reason = pairReason(transaction, paid);
      message = entry.amount < 0
        ? `你向${other.player.member.displayNameSnapshot}支付 ${money(entry.amount)} 两${suffix(reason)}`
        : `${other.player.member.displayNameSnapshot}向你转入 ${money(entry.amount)} 两${suffix(reason)}`;
    }
    deliveries.push({
      sessionId,
      event: {
        eventId: `${transaction.id}:PLAYER:${entry.playerId}${playerEntryCounts.get(entry.playerId)! > 1 ? `:${entry.id}` : ''}`,
        roomId: transaction.roomId,
        audience: 'PLAYER',
        kind: 'FUNDS',
        message: wireMessage(message),
      },
    });
  }

  const bank = await database.roomMembership.findFirst({
    where: { roomId: transaction.roomId, status: 'ACTIVE', isBank: true },
    select: { activeSessionId: true },
  });
  if (bank?.activeSessionId && paired) {
    const reason = paired ? pairReason(transaction, paid) : null;
    deliveries.push({
      sessionId: bank.activeSessionId,
      event: {
        eventId: `${transaction.id}:BANK`,
        roomId: transaction.roomId,
        audience: 'BANK',
        kind: 'FUNDS',
        message: wireMessage(`${paid.player.member.displayNameSnapshot}向${received.player.member.displayNameSnapshot}支付 ${money(paid.amount)} 两${suffix(reason)}`),
      },
    });
  }
  if (bank?.activeSessionId && !paired) {
    for (const entry of entries) {
      deliveries.push({
        sessionId: bank.activeSessionId,
        event: {
          eventId: entries.length === 1 ? `${transaction.id}:BANK` : `${transaction.id}:BANK:${entry.id}`,
          roomId: transaction.roomId,
          audience: 'BANK',
          kind: 'FUNDS',
          message: wireMessage(bankPlayerMessage(transaction, entry)),
        },
      });
    }
  }

  return deliveries;
}

export async function buildRejectionToastDelivery(
  database: Pick<PrismaClient, 'gameRequest'>,
  requestId: string,
): Promise<ToastDelivery | null> {
  const request = await database.gameRequest.findUnique({
    where: { id: requestId },
    include: { actor: { include: { member: { select: { activeSessionId: true } } } } },
  }) as {
    id: string;
    roomId: string;
    type: string;
    status: string;
    rejectionReason: string | null;
    actor: { id: string; member: { activeSessionId: string | null } } | null;
  } | null;
  const sessionId = request?.actor?.member.activeSessionId;
  if (!request || request.status !== 'REJECTED' || !request.actor || !sessionId) return null;
  const reason = request.rejectionReason?.trim();
  return {
    sessionId,
    event: {
      eventId: `${request.id}:rejected:PLAYER:${request.actor.id}`,
      roomId: request.roomId,
      audience: 'PLAYER',
      kind: 'REQUEST_REJECTED',
      message: wireMessage(`你的${requestLabels[request.type] ?? '操作'}申请已被银行拒绝${reason ? `：${reason}` : ''}`),
    },
  };
}
