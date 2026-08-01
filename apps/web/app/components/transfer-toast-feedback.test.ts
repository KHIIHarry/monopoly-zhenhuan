import { describe, expect, it } from 'vitest';
import {
  bankApprovalFailureToast,
  toastToneForRealtimeKind,
  transferFailureToast,
  transferSuccessToast,
} from './transfer-toast-feedback';

describe('transfer Toast feedback', () => {
  it('uses the authoritative committed transfer status', () => {
    expect(transferSuccessToast({ id: 'tx-1', status: 'EXECUTED' }, 'payer')).toEqual({
      id: 'tx-1:transfer-result:PLAYER:payer',
      message: '转账已成功，结果已同步至账本',
      tone: 'SUCCESS',
    });
    expect(transferSuccessToast({ id: 'request-1', status: 'PENDING' }, 'payer')).toEqual({
      id: 'request-1:submitted:PLAYER:payer',
      message: '转账已提交，请等待银行审批',
      tone: 'SUCCESS',
    });
  });

  it('uses bounded reasons and the authoritative approval mode for failures', () => {
    expect(transferFailureToast('INSUFFICIENT_BALANCE', false)).toMatchObject({
      message: '转账失败：余额不足', tone: 'REJECTED',
    });
    expect(transferFailureToast('INSUFFICIENT_BALANCE', true)).toMatchObject({
      message: '转账申请提交失败：余额不足', tone: 'REJECTED',
    });
    expect(transferFailureToast('INTERNAL_ERROR', undefined)).toMatchObject({
      message: '转账失败：服务暂时不可用，请稍后重试', tone: 'REJECTED',
    });
    expect(bankApprovalFailureToast('INSUFFICIENT_BALANCE', 'request-1')).toMatchObject({
      message: '银行审批执行失败：余额不足', tone: 'REJECTED',
    });
  });

  it('maps rejection and failure events to the red Toast tone', () => {
    expect(toastToneForRealtimeKind('TRANSFER_FAILED')).toBe('REJECTED');
    expect(toastToneForRealtimeKind('REQUEST_REJECTED')).toBe('REJECTED');
    expect(toastToneForRealtimeKind('TRANSFER_APPROVED')).toBe('SUCCESS');
  });
});
