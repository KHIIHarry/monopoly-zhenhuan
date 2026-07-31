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

export type LandingPlayer = {
  id: string;
  name: string;
  characterId?: string | null;
  tollBonus?: number;
  tollCollectionBlocked?: boolean;
};

export type PropertyOwnerFilter = 'all' | 'unowned' | string;

const propertyCharacters = {
  yixiu: { name: '乌拉那拉·宜修', filterLabel: '宜修', theme: 'yixiu' },
  zhenhuan: { name: '钮祜禄·甄嬛', filterLabel: '甄嬛', theme: 'zhenhuan' },
  huashifei: { name: '年世兰', filterLabel: '年世兰', theme: 'huashifei' },
  meizhuang: { name: '沈眉庄', filterLabel: '沈眉庄', theme: 'meizhuang' },
  anlingrong: { name: '安陵容', filterLabel: '安陵容', theme: 'anlingrong' },
} as const;

export function propertyCharacterMeta(characterId: string | null | undefined) {
  if (!characterId || !(characterId in propertyCharacters)) return null;
  return propertyCharacters[characterId as keyof typeof propertyCharacters];
}

export function visibleLandingPlayers(players: LandingPlayer[]) {
  return players.filter((player) => propertyCharacterMeta(player.characterId) !== null);
}

export function propertyOwner(
  property: LandingProperty,
  players: LandingPlayer[],
  viewerPlayerId?: string,
) {
  if (!property.ownerId) {
    return { label: '国库' as const, player: null, characterName: null, theme: 'treasury' };
  }

  const player = players.find((candidate) => candidate.id === property.ownerId) ?? null;
  const character = propertyCharacterMeta(player?.characterId);
  return {
    label: property.ownerId === viewerPlayerId ? '我的地产' as const : '已持有' as const,
    player,
    characterName: character?.name ?? null,
    theme: character?.theme ?? 'treasury',
  };
}

export function sortPropertiesByOwnership<T extends LandingProperty>(properties: T[]): T[] {
  return properties
    .map((property, index) => ({ property, index }))
    .sort(
      (left, right) =>
        Number(left.property.ownerId === null) - Number(right.property.ownerId === null) || left.index - right.index,
    )
    .map(({ property }) => property);
}

function normalizedLandingQuery(query: string) {
  return query.replaceAll(/\s/g, '').toLocaleLowerCase('en-US');
}

function matchesLandingText(value: string, query: string) {
  return !query || normalizedLandingQuery(value).includes(query) || Boolean(match(value, query));
}

export function filterLandingProperties<T extends LandingProperty>(
  properties: T[],
  players: LandingPlayer[],
  query: string,
  ownerFilter: PropertyOwnerFilter = 'all',
): T[] {
  const term = normalizedLandingQuery(query);
  return properties.filter((property) => {
    const owner = players.find((player) => player.id === property.ownerId);
    const character = propertyCharacterMeta(owner?.characterId);
    const ownerMatches = ownerFilter === 'all'
      || (ownerFilter === 'unowned'
        ? property.ownerId === null
        : property.ownerId === ownerFilter);

    return ownerMatches && [property.name, character?.name ?? '', owner?.name ?? '']
      .some((value) => matchesLandingText(value, term));
  });
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
