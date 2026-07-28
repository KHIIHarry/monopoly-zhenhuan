import { describe, expect, it } from 'vitest';
import {
  buildPropertySettlementDetail,
  isPristineSettlementTurn,
  rankSettlementPlayers,
  type SettlementCandidate,
} from './settlement.js';

const player = (overrides: Partial<SettlementCandidate>): SettlementCandidate => ({
  accountId: 'account',
  displayNameSnapshot: '小主',
  characterNameSnapshot: '钮祜禄·甄嬛',
  cash: 1000,
  unmortgagedPropertyValue: 0,
  mortgagedPropertyNetValue: 0,
  buildingSellValue: 0,
  propertyDetails: [],
  ...overrides,
});

describe('settlement ranking', () => {
  it('adds cash, property net values and building sell value', () => {
    const [result] = rankSettlementPlayers([player({ cash: 1000, unmortgagedPropertyValue: 3000, mortgagedPropertyNetValue: 1500, buildingSellValue: 1200 })]);
    expect(result).toMatchObject({ totalWealth: 6700, rank: 1, isWinner: true });
  });

  it('breaks ties by cash, then unmortgaged property value', () => {
    const ranked = rankSettlementPlayers([
      player({ accountId: 'a', cash: 1000, unmortgagedPropertyValue: 3000 }),
      player({ accountId: 'b', cash: 2000, mortgagedPropertyNetValue: 2000 }),
      player({ accountId: 'c', cash: 2000, unmortgagedPropertyValue: 1500, mortgagedPropertyNetValue: 500 }),
    ]);
    expect(ranked.map((item) => item.accountId)).toEqual(['c', 'b', 'a']);
    expect(ranked.map((item) => item.rank)).toEqual([1, 2, 3]);
  });

  it('keeps exact ties as joint winners', () => {
    const ranked = rankSettlementPlayers([
      player({ accountId: 'a', cash: 2000, unmortgagedPropertyValue: 1000 }),
      player({ accountId: 'b', cash: 2000, unmortgagedPropertyValue: 1000 }),
    ]);
    expect(ranked.map((item) => ({ rank: item.rank, winner: item.isWinner }))).toEqual([
      { rank: 1, winner: true },
      { rank: 1, winner: true },
    ]);
  });

  it('uses competition ranks after exact joint winners', () => {
    const ranked = rankSettlementPlayers([
      player({ accountId: 'b', cash: 3000 }),
      player({ accountId: 'a', cash: 3000 }),
      player({ accountId: 'c', cash: 2000 }),
    ]);
    expect(ranked.map(({ accountId, rank, isWinner }) => ({ accountId, rank, isWinner }))).toEqual([
      { accountId: 'a', rank: 1, isWinner: true },
      { accountId: 'b', rank: 1, isWinner: true },
      { accountId: 'c', rank: 3, isWinner: false },
    ]);
  });

  it('adds zero and large integer components without subtracting mortgaged value', () => {
    const ranked = rankSettlementPlayers([
      player({ accountId: 'zero', cash: 0 }),
      player({
        accountId: 'large',
        cash: 100_000_000,
        unmortgagedPropertyValue: 200_000_000,
        mortgagedPropertyNetValue: 300_000_000,
        buildingSellValue: 400_000_000,
      }),
    ]);
    expect(ranked.map(({ accountId, totalWealth }) => ({ accountId, totalWealth }))).toEqual([
      { accountId: 'large', totalWealth: 1_000_000_000 },
      { accountId: 'zero', totalWealth: 0 },
    ]);
  });
});

describe('settlement property valuation', () => {
  it('snapshots the exact allowlisted unmortgaged formula inputs', () => {
    expect(buildPropertySettlementDetail({
      id: 'room-property-1',
      name: '碎玉轩',
      mortgaged: false,
      mortgagePrice: 900,
      purchasePrice: 9_999,
      buildingLevel: 2,
      buildingSellPrice: 350,
    })).toEqual({
      roomPropertyId: 'room-property-1',
      nameSnapshot: '碎玉轩',
      mortgaged: false,
      mortgagePriceSnapshot: 900,
      landSaleValue: 1_800,
      landSettlementValue: 1_800,
      buildingLevel: 2,
      buildingSellPriceSnapshot: 350,
      buildingSellValue: 700,
    });
  });

  it('uses mortgage price rather than purchase price for mortgaged land value', () => {
    expect(buildPropertySettlementDetail({
      id: 'room-property-2',
      name: '翊坤宫',
      mortgaged: true,
      mortgagePrice: 800,
      purchasePrice: 123_456,
      buildingLevel: 5,
      buildingSellPrice: 400,
    })).toMatchObject({
      landSaleValue: 1_600,
      landSettlementValue: 800,
      buildingSellValue: 2_000,
    });
  });
});

describe('settlement active-turn boundary', () => {
  it('treats either persisted die as started even when aggregate dice fields drift null', () => {
    expect(isPristineSettlementTurn({ die1: 3, die2: null, diceValue: null, rolledAt: null, landingCount: 0, pendingRequestCount: 0 })).toBe(false);
    expect(isPristineSettlementTurn({ die1: null, die2: 4, diceValue: null, rolledAt: null, landingCount: 0, pendingRequestCount: 0 })).toBe(false);
    expect(isPristineSettlementTurn({ die1: null, die2: null, diceValue: null, rolledAt: null, landingCount: 0, pendingRequestCount: 0 })).toBe(true);
  });
});
