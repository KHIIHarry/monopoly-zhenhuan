import { describe, expect, it } from 'vitest';
import { filterLandingProperties, landingOwnership } from './landing-property-picker';

const properties = [
  { name: '景仁宫', ownerId: 'p1', level: 2, mortgaged: false, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1200, tolls: [800, 2000] },
  { name: '碎玉轩', ownerId: null, level: 0, mortgaged: false, mortgage: 800, purchasePrice: 1600, build: 1000, buildingSell: 600, tolls: [300, 700] }
];

describe('landing property picker model', () => {
  it('filters property names after trimming whitespace', () => {
    expect(filterLandingProperties(properties, ' 玉轩 ')).toEqual([properties[1]]);
  });

  it('marks a property with an owner as purchased and resolves the owner name', () => {
    expect(landingOwnership(properties[0], [{ id: 'p1', name: '皇后' }])).toEqual({ label: '已购', ownerName: '皇后' });
  });

  it('marks a property without an owner as unowned', () => {
    expect(landingOwnership(properties[1], [{ id: 'p1', name: '皇后' }])).toEqual({ label: '无主', ownerName: null });
  });
});
