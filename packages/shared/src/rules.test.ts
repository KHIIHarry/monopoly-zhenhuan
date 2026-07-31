import { describe, expect, it } from 'vitest';
import masterData from '../../../甄嬛传大富翁_master-data.json';
import { applySkill, calculateToll, loadMasterData, realtimeToastEventSchema, roll2d6 } from './index.js';

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
    ['an empty event ID', { ...validEvent, eventId: '' }],
    ['an empty room ID', { ...validEvent, roomId: '' }],
    ['an empty message', { ...validEvent, message: '   ' }],
    ['an unknown audience', { ...validEvent, audience: 'OTHER' }],
    ['an unknown event kind', { ...validEvent, kind: 'OTHER' }],
  ])('rejects %s', (_description, event) => {
    expect(() => realtimeToastEventSchema.parse(event)).toThrow();
  });
});
