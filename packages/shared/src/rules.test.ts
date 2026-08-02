import { describe, expect, it } from 'vitest';
import masterData from '../../../甄嬛传大富翁_master-data.json';
import { applySkill, calculatePropertyBankSaleAmount, calculateToll, loadMasterData, realtimeToastEventSchema, roll2d6, transferFailureReason } from './index.js';

describe('master data', () => {
  it('loads exactly 26 properties without recalculating values', () => {
    const data = loadMasterData(masterData);
    expect(data.properties).toHaveLength(26);
    expect(data.properties[0]).toMatchObject({ name: '景仁宫', mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1200 });
    expect(data.properties[0].tolls).toEqual([800, 2000, 3900, 9000, 11000, 13000]);
  });
});

describe('2d6', () => {
  it('uses two independent six-sided dice', () => {
    const values = [0, 0.999999];
    expect(roll2d6(() => values.shift() ?? 0)).toEqual({ dice: [1, 6], total: 7 });
  });
});

describe('property bank sale amount', () => {
  it.each([
    [{ purchasePrice: 1000, mortgagePrice: 500, mortgaged: false, redemptionFee: 200 }, 1000],
    [{ purchasePrice: 1000, mortgagePrice: 500, mortgaged: true, redemptionFee: 200 }, 300],
    [{ purchasePrice: 1000, mortgagePrice: 500, mortgaged: true, redemptionFee: 0 }, 500],
    [{ purchasePrice: 1000, mortgagePrice: 500, mortgaged: true, redemptionFee: 800 }, 0],
  ])('calculates %#', (input, expected) => {
    expect(calculatePropertyBankSaleAmount(input)).toBe(expected);
  });
});

describe('configured skills', () => {
  it.each([
    ['COLD_PALACE_RELIEF', { skipTurns: 3, amount: 0 }, { skipTurns: 1, amount: 500 }],
    ['TOLL_BONUS', { skipTurns: 0, amount: 800 }, { skipTurns: 0, amount: 1100 }],
    ['PLOT_FINE_REDUCTION', { skipTurns: 0, amount: 500 }, { skipTurns: 0, amount: 300 }],
    ['BUILD_DISCOUNT', { skipTurns: 0, amount: 1500 }, { skipTurns: 0, amount: 1000 }],
    ['COMPANION_REWARD', { skipTurns: 0, amount: 0 }, { skipTurns: 0, amount: 500 }]
  ])('%s applies its configured value', (code, input, expected) => {
    expect(applySkill(code, input, masterData.characters)).toEqual(expected);
  });

  it('blocks toll on mortgaged property', () => {
    expect(() => calculateToll({ tolls: [200, 400, 900, 2700, 4000, 5500], level: 0, mortgaged: true })).toThrow('MORTGAGED_PROPERTY');
  });
});

describe('realtime toast event', () => {
  const validEvent = {
    eventId: 'transaction-1:PLAYER:player-1',
    roomId: 'room-1',
    audience: 'PLAYER',
    kind: 'FUNDS',
    message: '银行向你发放起点奖励 1000 两',
  };

  it('accepts the funds wire envelope', () => {
    expect(realtimeToastEventSchema.parse(validEvent)).toMatchObject({ audience: 'PLAYER', kind: 'FUNDS' });
  });

  it.each([
    ['TRANSFER_REQUESTED', 'BANK', '收到张三的转账申请：向李四支付 500 两'],
    ['TRANSFER_APPROVED', 'PLAYER', '银行审批通过，转账已成功，结果已同步至账本'],
    ['TRANSFER_FAILED', 'PLAYER', '银行审批执行失败：余额不足'],
  ] as const)('accepts the %s transfer lifecycle wire envelope', (kind, audience, message) => {
    expect(realtimeToastEventSchema.parse({
      eventId: `request-1:${kind}`,
      roomId: 'room-1',
      audience,
      kind,
      message,
    }).kind).toBe(kind);
  });

  it.each([
    ['INSUFFICIENT_BALANCE', '余额不足'],
    ['INVALID_TRANSFER', '收款对象或金额无效'],
    ['ROOM_NOT_PLAYING', '房间当前不在游戏中'],
    ['PLAYER_STATE_CHANGED', '玩家状态已变化，请刷新后重试'],
    ['REQUEST_ALREADY_RESOLVED', '转账申请已处理'],
    ['untrusted raw database text', '服务暂时不可用，请稍后重试'],
    ['toString', '服务暂时不可用，请稍后重试'],
    ['constructor', '服务暂时不可用，请稍后重试'],
  ])('maps %s to a safe transfer failure reason', (code, message) => {
    expect(transferFailureReason(code)).toBe(message);
  });

  it.each([
    ['an empty event ID', { ...validEvent, eventId: '' }],
    ['an empty room ID', { ...validEvent, roomId: '' }],
    ['an empty message', { ...validEvent, message: '   ' }],
    ['an unknown audience', { ...validEvent, audience: 'OTHER' }],
    ['an unknown event kind', { ...validEvent, kind: 'OTHER' }],
  ])('rejects %s', (_description, event) => {
    expect(() => realtimeToastEventSchema.parse(event)).toThrow();
  });
});
