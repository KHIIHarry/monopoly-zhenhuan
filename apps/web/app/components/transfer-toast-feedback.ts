import { transferFailureReason, type RealtimeToastEvent } from '@zhenhuan/shared';
import type { ToastInput, ToastTone } from './toast-queue';

export type TransferResult = { id: string; status: 'EXECUTED' | 'PENDING' };

export function transferSuccessToast(result: TransferResult, playerId: string): ToastInput {
  return result.status === 'EXECUTED'
    ? {
        id: `${result.id}:transfer-result:PLAYER:${playerId}`,
        message: '转账已成功，结果已同步至账本',
        tone: 'SUCCESS',
      }
    : {
        id: `${result.id}:submitted:PLAYER:${playerId}`,
        message: '转账已提交，请等待银行审批',
        tone: 'SUCCESS',
      };
}

export function transferFailureToast(
  code: string,
  transferApprovalRequired: boolean | undefined,
): ToastInput {
  const prefix = transferApprovalRequired === true ? '转账申请提交失败' : '转账失败';
  return {
    message: `${prefix}：${transferFailureReason(code)}`,
    tone: 'REJECTED',
  };
}

export function bankApprovalFailureToast(code: string, requestId: string): ToastInput {
  return {
    id: `${requestId}:approval-failed:BANK`,
    message: `银行审批执行失败：${transferFailureReason(code)}`,
    tone: 'REJECTED',
  };
}

export function toastToneForRealtimeKind(kind: RealtimeToastEvent['kind']): ToastTone {
  return kind === 'REQUEST_REJECTED' || kind === 'TRANSFER_FAILED' ? 'REJECTED' : 'SUCCESS';
}
