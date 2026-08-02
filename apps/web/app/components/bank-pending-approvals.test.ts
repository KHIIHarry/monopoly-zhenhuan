import { describe, expect, test } from 'vitest';
import {
  approvalAmountDelta,
  formatApprovalSubmittedAt,
  mergePendingApprovals,
} from './bank-pending-approvals';

describe('bank pending approvals', () => {
  test('merges request and landing items oldest-first with deterministic ties and invalid dates last', () => {
    const items = mergePendingApprovals(
      [
        { id: 'request-b', createdAt: '2026-08-01T02:00:00.000Z' },
        { id: 'request-invalid', createdAt: 'invalid' },
      ],
      [
        { id: 'landing-a', createdAt: '2026-08-01T01:00:00.000Z' },
        { id: 'landing-b', createdAt: '2026-08-01T02:00:00.000Z' },
      ],
    );

    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'LANDING:landing-a',
      'LANDING:landing-b',
      'REQUEST:request-b',
      'REQUEST:request-invalid',
    ]);
  });

  test('formats the browser-local submission time to Chinese seconds precision', () => {
    const localDate = new Date(2026, 7, 1, 9, 8, 7);
    expect(formatApprovalSubmittedAt(localDate.toISOString())).toBe(
      '提交时间：2026年08月01日 09:08:07',
    );
    expect(formatApprovalSubmittedAt('invalid')).toBe('提交时间未知');
  });

  test('shows approval amounts from the displayed player perspective', () => {
    for (const type of [
      'BUY_PROPERTY',
      'BUILD_PROPERTY',
      'REDEEM_PROPERTY',
    ]) {
      expect(approvalAmountDelta({ type, amount: 800 }), type).toBe(-800);
    }
    expect(
      approvalAmountDelta({
        type: 'PLAYER_TRANSFER',
        amount: 800,
        actualAmount: 600,
      }),
    ).toBe(-600);

    for (const type of [
      'BANK_PAYMENT',
      'START_REWARD',
      'SELL_BUILDING',
      'MORTGAGE_PROPERTY',
      'SELL_PROPERTY_TO_BANK',
      'TRADE_PROPERTY',
      'RETURN_COMPANION_EVENT',
    ]) {
      expect(approvalAmountDelta({ type, amount: 800 }), type).toBe(800);
    }
  });
});
