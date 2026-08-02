import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { LandingProperty } from './landing-property-picker';
import {
  nextExpandedPlayerId,
  PlayerAssetAccordion,
  summarizePlayerAssets,
} from './player-asset-overview';

const property = (
  name: string,
  ownerId: string | null,
  level: number,
  mortgaged = false,
): LandingProperty => ({
  name,
  ownerId,
  level,
  mortgaged,
  mortgage: 1_000,
  purchasePrice: 2_000,
  build: 500,
  buildingSell: 300,
  tolls: [100, 200, 300, 400, 500, 600],
});

const players = [
  { id: 'p1', name: '甄嬛', characterId: 'zhenhuan', balance: 5_000 },
  { id: 'p2', name: '眉庄', characterId: 'meizhuang', balance: 3_200 },
];

const properties = [
  property('碎玉轩', 'p1', 1),
  property('永寿宫', 'p1', 4, true),
  property('寿康宫', 'p1', 5),
  property('咸福宫', 'p2', 2),
  property('甘露寺', null, 0),
];

describe('player asset overview model', () => {
  test('combines levels 1-4 and counts level 5 as a separate palace', () => {
    expect(summarizePlayerAssets('p1', properties)).toEqual({
      ownedProperties: properties.slice(0, 3),
      propertyCount: 3,
      regularBuildingCount: 5,
      palaceCount: 1,
    });
  });

  test('returns zero counts for a player without properties', () => {
    expect(summarizePlayerAssets('missing', properties)).toEqual({
      ownedProperties: [],
      propertyCount: 0,
      regularBuildingCount: 0,
      palaceCount: 0,
    });
  });
});

describe('PlayerAssetAccordion', () => {
  test('keeps at most one player open and collapses the active player', () => {
    expect(nextExpandedPlayerId(null, 'p1')).toBe('p1');
    expect(nextExpandedPlayerId('p1', 'p2')).toBe('p2');
    expect(nextExpandedPlayerId('p2', 'p2')).toBeNull();
  });

  test('renders every player as a collapsed, read-only asset trigger', () => {
    const html = renderToStaticMarkup(
      createElement(PlayerAssetAccordion, { players, properties }),
    );

    expect(html).toContain('甄嬛');
    expect(html).toContain('5,000 两');
    expect(html).toContain('3 块');
    expect(html).toContain('5 栋');
    expect(html).toContain('1 座');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });

  test('delegates expanded property rendering to the existing shared picker', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./player-asset-overview.tsx', import.meta.url)),
      'utf8',
    );

    expect(source).toMatch(
      /<LandingPropertyCardPicker\s+mode="browse"\s+properties=\{summary\.ownedProperties\}\s+players=\{\[player\]\}/,
    );
    expect(source).not.toContain('PropertyCardDetails');
    expect(source).not.toMatch(/function\s+PropertyCard/);
  });
});
