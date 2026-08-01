import type { PrismaClient } from '@prisma/client';
import { transferFailureReason, type RealtimeToastEvent } from '@zhenhuan/shared';

export type ToastDelivery = { sessionId: string; event: RealtimeToastEvent };

export type TransferFailureNotice =
  | { phase: 'SUBMISSION'; roomId: string; playerId: string; attemptId: string; reasonCode: string }
  | { phase: 'APPROVAL'; roomId: string; requestId: string; attemptId: string; reasonCode: string };

export type PostCommitToastNotifier = {
  fundsCommitted: (roomId: string, transactionId: string) => void | Promise<void>;
  requestRejected: (roomId: string, requestId: string) => void | Promise<void>;
  landingRejected: (roomId: string, landingId: string, reason: string) => void | Promise<void>;
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

type TransferMember = { displayNameSnapshot: string; activeSessionId: string | null };
type PersistedTransferRequest = {
  id: string;
  roomId: string;
  type: string;
  status: string;
  amount: number | null;
  payload: unknown;
  actor: { id: string; member: TransferMember } | null;
  target: { id: string; member: TransferMember } | null;
};

function recipientType(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>).recipientType;
  return value === 'PLAYER' || value === 'BANK' ? value : null;
}

function isLifecycleTransfer(transaction: FundTransaction, paid: FundEntry | undefined) {
  const recipient = recipientType(transaction.metadata);
  if (transaction.type === 'PLOT_FINE' && paid?.description !== '支付剧情罚款') return false;
  return ((transaction.type === 'PLAYER_TRANSFER' || transaction.type === 'PLOT_FINE') && recipient === 'PLAYER')
    || ((transaction.type === 'PLAYER_BANK_PAYMENT' || transaction.type === 'PLOT_FINE') && recipient === 'BANK');
}

async function findTransferRequest(
  database: Pick<PrismaClient, 'gameRequest'>,
  requestId: string,
): Promise<PersistedTransferRequest | null> {
  return await database.gameRequest.findUnique({
    where: { id: requestId },
    include: {
      actor: { include: { member: { select: { displayNameSnapshot: true, activeSessionId: true } } } },
      target: { include: { member: { select: { displayNameSnapshot: true, activeSessionId: true } } } },
    },
  }) as PersistedTransferRequest | null;
}

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
  const suppressLifecyclePayer = isLifecycleTransfer(transaction, paid);

  for (const entry of entries) {
    if (suppressLifecyclePayer && entry === paid) continue;
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
      message: wireMessage(`${request.type === 'PLAYER_TRANSFER' ? '转账' : `你的${requestLabels[request.type] ?? '操作'}`}申请已被银行拒绝${reason ? `：${reason}` : ''}`),
    },
  };
}

export async function buildTransferRequestedToastDelivery(
  database: Pick<PrismaClient, 'gameRequest' | 'roomMembership'>,
  requestId: string,
): Promise<ToastDelivery | null> {
  const request = await findTransferRequest(database, requestId);
  const recipient = request && recipientType(request.payload);
  const amount = request?.amount;
  if (!request || request.type !== 'PLAYER_TRANSFER' || request.status !== 'PENDING' || !request.actor || !recipient || typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return null;
  const recipientName = recipient === 'BANK' ? '银行' : request.target?.member.displayNameSnapshot;
  if (!recipientName) return null;
  const bank = await database.roomMembership.findFirst({
    where: { roomId: request.roomId, status: 'ACTIVE', isBank: true },
    select: { activeSessionId: true },
  });
  if (!bank?.activeSessionId) return null;
  return {
    sessionId: bank.activeSessionId,
    event: {
      eventId: `${request.id}:requested:BANK`,
      roomId: request.roomId,
      audience: 'BANK',
      kind: 'TRANSFER_REQUESTED',
      message: wireMessage(`收到${request.actor.member.displayNameSnapshot}的转账申请：向${recipientName}支付 ${amount} 两`),
    },
  };
}

export async function buildTransferApprovedToastDelivery(
  database: Pick<PrismaClient, 'gameRequest'>,
  requestId: string,
): Promise<ToastDelivery | null> {
  const request = await findTransferRequest(database, requestId);
  const sessionId = request?.actor?.member.activeSessionId;
  if (!request || request.type !== 'PLAYER_TRANSFER' || request.status !== 'EXECUTED' || !request.actor || !sessionId) return null;
  return {
    sessionId,
    event: {
      eventId: `${request.id}:approved:PLAYER:${request.actor.id}`,
      roomId: request.roomId,
      audience: 'PLAYER',
      kind: 'TRANSFER_APPROVED',
      message: '银行审批通过，转账已成功，结果已同步至账本',
    },
  };
}

export async function buildTransferFailureToastDelivery(
  database: Pick<PrismaClient, 'gameRequest' | 'player' | 'roomMembership'>,
  notice: TransferFailureNotice,
): Promise<ToastDelivery | null> {
  const reason = transferFailureReason(notice.reasonCode);
  if (notice.phase === 'SUBMISSION') {
    const payer = await database.player.findFirst({
      where: { id: notice.playerId, roomId: notice.roomId },
      include: { member: { select: { displayNameSnapshot: true } } },
    }) as { member: { displayNameSnapshot: string } } | null;
    if (!payer) return null;
    const bank = await database.roomMembership.findFirst({
      where: { roomId: notice.roomId, status: 'ACTIVE', isBank: true },
      select: { activeSessionId: true },
    });
    if (!bank?.activeSessionId) return null;
    return {
      sessionId: bank.activeSessionId,
      event: {
        eventId: `${notice.attemptId}:submission-failed:BANK`,
        roomId: notice.roomId,
        audience: 'BANK',
        kind: 'TRANSFER_FAILED',
        message: wireMessage(`${payer.member.displayNameSnapshot}的转账申请提交失败：${reason}`),
      },
    };
  }

  const request = await findTransferRequest(database, notice.requestId);
  const sessionId = request?.actor?.member.activeSessionId;
  if (!request || request.roomId !== notice.roomId || request.type !== 'PLAYER_TRANSFER' || request.status !== 'PENDING' || !request.actor || !sessionId) return null;
  return {
    sessionId,
    event: {
      eventId: `${request.id}:approval-failed:${notice.attemptId}`,
      roomId: request.roomId,
      audience: 'PLAYER',
      kind: 'TRANSFER_FAILED',
      message: wireMessage(`银行审批执行失败：${reason}`),
    },
  };
}

export async function buildLandingRejectionToastDelivery(
  database: Pick<PrismaClient, 'landingEvent'>,
  landingId: string,
  reason: string,
): Promise<ToastDelivery | null> {
  const landing = await database.landingEvent.findUnique({
    where: { id: landingId },
    include: { player: { include: { member: { select: { activeSessionId: true } } } } },
  }) as {
    id: string;
    roomId: string;
    propertyActionsCancelled: boolean;
    player: { id: string; member: { activeSessionId: string | null } };
  } | null;
  const sessionId = landing?.player.member.activeSessionId;
  if (!landing || !landing.propertyActionsCancelled || !sessionId) return null;
  const trimmedReason = reason.trim();
  return {
    sessionId,
    event: {
      eventId: `${landing.id}:rejected:PLAYER:${landing.player.id}`,
      roomId: landing.roomId,
      audience: 'PLAYER',
      kind: 'REQUEST_REJECTED',
      message: wireMessage(`你的落点申请已被银行拒绝${trimmedReason ? `：${trimmedReason}` : ''}`),
    },
  };
}
