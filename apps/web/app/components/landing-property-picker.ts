export type LandingProperty = {
  name: string;
  ownerId: string | null;
  level: number;
  mortgaged: boolean;
  mortgage: number;
  purchasePrice: number;
  build: number;
  buildingSell: number;
  tolls: number[];
};

export type LandingPlayer = { id: string; name: string };

export function filterLandingProperties<T extends LandingProperty>(properties: T[], query: string): T[] {
  const term = query.trim();
  return term ? properties.filter((property) => property.name.includes(term)) : properties;
}

export function landingOwnership(property: LandingProperty, players: LandingPlayer[]) {
  const ownerName = property.ownerId ? players.find((player) => player.id === property.ownerId)?.name ?? '未知玩家' : null;
  return { label: property.ownerId ? '已购' : '无主', ownerName } as const;
}
