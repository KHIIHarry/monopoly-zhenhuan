import { match } from 'pinyin-pro';

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

export type LandingPlayer = { id: string; name: string; tollBonus?: number; tollCollectionBlocked?: boolean };

function normalizedLandingQuery(query: string) {
  return query.replaceAll(/\s/g, '').toLocaleLowerCase('en-US');
}

function matchesLandingName(name: string, query: string) {
  return !query || name.includes(query) || Boolean(match(name, query));
}

export function filterLandingProperties<T extends LandingProperty>(
  properties: T[],
  query: string,
  ownerId: string | null = null,
): T[] {
  const term = normalizedLandingQuery(query);
  return properties.filter(
    (property) =>
      (ownerId === null || property.ownerId === ownerId) &&
      matchesLandingName(property.name, term),
  );
}

export function landingOwnership(property: LandingProperty, players: LandingPlayer[]) {
  const ownerName = property.ownerId ? players.find((player) => player.id === property.ownerId)?.name ?? '未知玩家' : null;
  return { label: property.ownerId ? '已购' : '无主', ownerName } as const;
}

export function landingPropertyToll(property: LandingProperty, players: LandingPlayer[]) {
  if (property.mortgaged || !property.ownerId) return 0;
  const owner = players.find((player) => player.id === property.ownerId);
  if (owner?.tollCollectionBlocked) return 0;
  return (property.tolls[property.level] ?? 0) + (owner?.tollBonus ?? 0);
}
