import { describe, expect, it } from 'vitest';
import {
  filterLandingProperties,
  landingOwnership,
  landingPropertyToll,
  propertyOwner,
  propertyCharacterMeta,
  sortPropertiesByOwnership,
  visibleLandingPlayers,
} from './landing-property-picker';

const properties = [
  { name: '景仁宫', ownerId: 'p1', level: 2, mortgaged: false, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1200, tolls: [800, 2000, 3900] },
  { name: '碎玉轩', ownerId: null, level: 0, mortgaged: false, mortgage: 800, purchasePrice: 1600, build: 1000, buildingSell: 600, tolls: [300, 700] }
];

const players = [
  { id: 'p1', name: '小行老师', characterId: 'yixiu' },
  { id: 'bank', name: '银行', characterId: null },
];

describe('landing property picker model', () => {
  it('filters property names after trimming whitespace', () => {
    expect(filterLandingProperties(properties, players, ' 玉轩 ')).toEqual([properties[1]]);
  });

  it('matches Chinese, a full-pinyin substring, initials, and mixed text', () => {
    expect(filterLandingProperties(properties, players, '仁')).toEqual([properties[0]]);
    expect(filterLandingProperties(properties, players, 'ren')).toEqual([properties[0]]);
    expect(filterLandingProperties(properties, players, 'jrg')).toEqual([properties[0]]);
    expect(filterLandingProperties(properties, players, '景ren')).toEqual([properties[0]]);
  });

  it('ignores query case and whitespace', () => {
    expect(filterLandingProperties(properties, players, ' Jing Ren ')).toEqual([properties[0]]);
  });

  it('matches owner character names and player nicknames with pinyin', () => {
    expect(filterLandingProperties(properties, players, 'yixiu')).toEqual([properties[0]]);
    expect(filterLandingProperties(properties, players, 'laoshi')).toEqual([properties[0]]);
  });

  it('distinguishes all, unowned, and player filters and intersects them with the query', () => {
    expect(filterLandingProperties(properties, players, '', 'p1')).toEqual([properties[0]]);
    expect(filterLandingProperties(properties, players, 'ren', 'p1')).toEqual([properties[0]]);
    expect(filterLandingProperties(properties, players, 'yu', 'p1')).toEqual([]);
    expect(filterLandingProperties(properties, players, '', 'unowned')).toEqual([properties[1]]);
    expect(filterLandingProperties(properties, players, '', 'all')).toEqual(properties);
  });

  it('marks a property with an owner as purchased and resolves the owner name', () => {
    expect(landingOwnership(properties[0], [{ id: 'p1', name: '皇后' }])).toEqual({ label: '已购', ownerName: '皇后' });
  });

  it('marks a property without an owner as unowned', () => {
    expect(landingOwnership(properties[1], [{ id: 'p1', name: '皇后' }])).toEqual({ label: '无主', ownerName: null });
  });

  it('shows no toll for an unowned or mortgaged property', () => {
    expect(landingPropertyToll(properties[1], [])).toBe(0);
    expect(landingPropertyToll({ ...properties[0], mortgaged: true }, [{ id: 'p1', name: '皇后' }])).toBe(0);
  });

  it('shows the current toll for an owned property', () => {
    expect(landingPropertyToll(properties[0], [{ id: 'p1', name: '皇后' }])).toBe(3900);
  });

  it('formats an owned property with its character theme and player name', () => {
    expect(propertyOwner(properties[0], players)).toMatchObject({
      label: '已持有',
      characterName: '乌拉那拉·宜修',
      theme: 'yixiu',
      player: { name: '小行老师' },
    });
  });

  it('marks a property owned by the current viewer as mine', () => {
    expect(propertyOwner(properties[0], players, 'p1').label).toBe('我的地产');
    expect(propertyOwner(properties[0], players, 'someone-else').label).toBe('已持有');
  });

  it('provides short role labels for owner filters', () => {
    expect(propertyCharacterMeta('yixiu')).toMatchObject({
      name: '乌拉那拉·宜修',
      filterLabel: '宜修',
    });
  });

  it('keeps only seated characters in the filter list', () => {
    expect(visibleLandingPlayers(players).map((player) => player.id)).toEqual(['p1']);
  });

  it('places owned properties before treasury properties without changing group order', () => {
    expect(sortPropertiesByOwnership([properties[1], properties[0]])).toEqual([
      properties[0],
      properties[1],
    ]);
  });
});
