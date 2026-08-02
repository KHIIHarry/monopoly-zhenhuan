type TimestampedApprovalSource = { id: string; createdAt?: string };

const playerDebitRequestTypes = new Set([
  'BUY_PROPERTY',
  'BUILD_PROPERTY',
  'REDEEM_PROPERTY',
  'PLAYER_TRANSFER',
]);

export function approvalAmountDelta(request: {
  type: string;
  amount: number;
  actualAmount?: number;
}): number {
  const amount = Math.abs(request.actualAmount ?? request.amount);
  return playerDebitRequestTypes.has(request.type) ? -amount : amount;
}

export type PendingApprovalItem<
  R extends TimestampedApprovalSource,
  L extends TimestampedApprovalSource,
> =
  | { kind: 'REQUEST'; id: string; createdAt?: string; request: R }
  | { kind: 'LANDING'; id: string; createdAt?: string; landing: L };

function timestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function mergePendingApprovals<
  R extends TimestampedApprovalSource,
  L extends TimestampedApprovalSource,
>(requests: R[], landings: L[]): PendingApprovalItem<R, L>[] {
  return [
    ...requests.map((request) => ({
      kind: 'REQUEST' as const,
      id: request.id,
      createdAt: request.createdAt,
      request,
    })),
    ...landings.map((landing) => ({
      kind: 'LANDING' as const,
      id: landing.id,
      createdAt: landing.createdAt,
      landing,
    })),
  ].sort((left, right) => {
    const leftTime = timestamp(left.createdAt);
    const rightTime = timestamp(right.createdAt);
    if (leftTime === null || rightTime === null) {
      if (leftTime === rightTime) return compareIds(left.id, right.id);
      return leftTime === null ? 1 : -1;
    }
    if (leftTime !== rightTime) return leftTime - rightTime;
    return compareIds(left.id, right.id);
  });
}

export function formatApprovalSubmittedAt(createdAt?: string): string {
  if (!createdAt) return '提交时间未知';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '提交时间未知';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `提交时间：${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
