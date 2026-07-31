import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  LandingPropertyCardPicker,
  PropertyCardDetails,
} from './landing-property-card-picker';

const ownedProperty = {
  name: '景仁宫',
  ownerId: 'p1',
  level: 2,
  mortgaged: false,
  mortgage: 1500,
  purchasePrice: 3000,
  build: 2000,
  buildingSell: 1200,
  tolls: [800, 2000, 3900, 9000, 11000, 13000],
};

const unownedProperty = {
  ...ownedProperty,
  name: '甘露寺',
  ownerId: null,
  level: 0,
  mortgage: 1200,
  purchasePrice: 2400,
  tolls: [400, 760, 1500, 2600, 3600, 4800],
};

const players = [
  { id: 'p1', name: '小行老师', characterId: 'yixiu' },
  { id: 'p2', name: '未选角色玩家', characterId: null },
];

function renderPicker(
  props: Partial<Parameters<typeof LandingPropertyCardPicker>[0]> = {},
) {
  return renderToStaticMarkup(createElement(LandingPropertyCardPicker, {
    properties: [unownedProperty, ownedProperty],
    players,
    mode: 'browse',
    ...props,
  }));
}

describe('LandingPropertyCardPicker', () => {
  it('renders all, unowned, and only currently selected character filters', () => {
    const html = renderPicker();

    expect(html).toContain('>全部</button>');
    expect(html).toContain('>无主</button>');
    expect(html).toContain('>宜修</button>');
    expect(html).not.toContain('>小行老师</button>');
    expect(html).not.toContain('>未选角色玩家</button>');
    expect(html).toContain('aria-pressed="true">全部</button>');
  });

  it('renders themed ownership and the nickname on a grey second line', () => {
    const html = renderPicker({ viewerPlayerId: 'p1' });

    expect(html).toContain('property-theme-yixiu');
    expect(html).toContain('>我的地产</span>');
    expect(html).toContain('<strong>乌拉那拉·宜修</strong>');
    expect(html).toContain('<small class="property-owner-nickname">「小行老师」</small>');
    expect(html).toContain('<strong>无主</strong>');
    expect(html).toContain('<small class="property-owner-nickname">「银行」</small>');
  });

  it('renders browse cards collapsed without the old details button', () => {
    const html = renderPicker();

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('点击地产卡展开详情，再次点击即可收起');
    expect(html).not.toContain('查看完整价格与租金');
    expect(html).not.toContain('property-details-panel');
  });

  it('renders landing cards as selection controls without browse details', () => {
    const html = renderPicker({
      mode: 'landing',
      value: '景仁宫',
      onChange: () => undefined,
    });

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('property-selected-mark');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('property-details-panel');
    expect(html).not.toContain('点击地产卡展开详情');
  });

  it('renders mortgage and cold-palace states together without changing card content', () => {
    const html = renderPicker({
      properties: [{ ...ownedProperty, level: 0, mortgaged: true }],
      players: [{ ...players[0], tollCollectionBlocked: true }],
    });

    expect(html).toContain('mortgaged');
    expect(html).toContain('property-mortgage-stamp');
    expect(html).toContain('>已抵押</span>');
    expect(html).toContain('冷宫 · 免过路费');
    expect(html).toContain('当前过路费<strong>0 两</strong>');
  });

  it('shows owned properties before treasury properties without changing group order', () => {
    const html = renderPicker();

    expect(html.indexOf('景仁宫')).toBeLessThan(html.indexOf('甘露寺'));
  });
});

describe('PropertyCardDetails', () => {
  it('groups prices and rents as 0, 1-4, and palace level 5 modules', () => {
    const html = renderToStaticMarkup(
      createElement(PropertyCardDetails, { property: unownedProperty }),
    );

    expect(html).toContain('价格信息');
    expect(html).toContain('property-detail-grid property-price-grid');
    expect(html).toContain('property-empty-land-tier');
    expect(html).toContain('空地（0级）');
    expect(html).toContain('property-detail-grid property-level-rent-grid');
    expect(html).toContain('1 级');
    expect(html).toContain('4 级');
    expect(html).toContain('property-palace-tier');
    expect(html).toContain('大宫殿（5级）');
  });
});
