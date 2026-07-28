export type SettlementCandidate = {
  accountId: string;
  displayNameSnapshot: string;
  characterNameSnapshot: string | null;
  cash: number;
  unmortgagedPropertyValue: number;
  mortgagedPropertyNetValue: number;
  buildingSellValue: number;
  propertyDetails: PropertySettlementDetail[];
};

export type PropertySettlementDetail = {
  roomPropertyId: string;
  nameSnapshot: string;
  mortgaged: boolean;
  mortgagePriceSnapshot: number;
  landSaleValue: number;
  landSettlementValue: number;
  buildingLevel: number;
  buildingSellPriceSnapshot: number;
  buildingSellValue: number;
};

export function buildPropertySettlementDetail(property: {
  id: string;
  name: string;
  mortgaged: boolean;
  mortgagePrice: number;
  purchasePrice: number;
  buildingLevel: number;
  buildingSellPrice: number;
}): PropertySettlementDetail {
  const landSaleValue = property.mortgagePrice * 2;
  return {
    roomPropertyId: property.id,
    nameSnapshot: property.name,
    mortgaged: property.mortgaged,
    mortgagePriceSnapshot: property.mortgagePrice,
    landSaleValue,
    landSettlementValue: property.mortgaged ? landSaleValue - property.mortgagePrice : landSaleValue,
    buildingLevel: property.buildingLevel,
    buildingSellPriceSnapshot: property.buildingSellPrice,
    buildingSellValue: property.buildingLevel * property.buildingSellPrice,
  };
}

export type RankedSettlementPlayer = SettlementCandidate & {
  totalWealth: number;
  rank: number;
  isWinner: boolean;
};

export function isPristineSettlementTurn(turn: {
  die1: number | null;
  die2: number | null;
  diceValue: number | null;
  rolledAt: Date | null;
  landingCount: number;
  pendingRequestCount: number;
}) {
  return turn.die1 === null
    && turn.die2 === null
    && turn.diceValue === null
    && turn.rolledAt === null
    && turn.landingCount === 0
    && turn.pendingRequestCount === 0;
}

const comparisonKey = (player: RankedSettlementPlayer) => [
  player.totalWealth,
  player.cash,
  player.unmortgagedPropertyValue,
] as const;

export function rankSettlementPlayers(players: SettlementCandidate[]): RankedSettlementPlayer[] {
  const ranked = players
    .map((player) => ({
      ...player,
      totalWealth: player.cash + player.unmortgagedPropertyValue + player.mortgagedPropertyNetValue + player.buildingSellValue,
      rank: 0,
      isWinner: false,
    }))
    .sort((left, right) => {
      const a = comparisonKey(left);
      const b = comparisonKey(right);
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || left.accountId.localeCompare(right.accountId);
    });

  for (let index = 0; index < ranked.length; index += 1) {
    const previous = ranked[index - 1];
    ranked[index].rank = previous && comparisonKey(previous).every((value, keyIndex) => value === comparisonKey(ranked[index])[keyIndex])
      ? previous.rank
      : index + 1;
    ranked[index].isWinner = ranked[index].rank === 1;
  }
  return ranked;
}
