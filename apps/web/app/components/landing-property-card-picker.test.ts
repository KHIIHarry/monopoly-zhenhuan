import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingPropertyCardPicker } from './landing-property-card-picker';

describe('LandingPropertyCardPicker', () => {
  it('renders an active all-properties tag and a tag for each seated character', () => {
    const html = renderToStaticMarkup(
      createElement(LandingPropertyCardPicker, {
        properties: [
          {
            name: '景仁宫',
            ownerId: 'p1',
            level: 0,
            mortgaged: false,
            mortgage: 0,
            purchasePrice: 3000,
            build: 2000,
            buildingSell: 1200,
            tolls: [800],
          },
        ],
        players: [
          { id: 'p1', name: '皇后', characterId: 'yixiu' },
          { id: 'p2', name: '甄嬛', characterId: 'zhenhuan' },
          { id: 'bank', name: '银行', characterId: null },
        ],
        value: '',
        onChange: () => undefined,
      }),
    );

    expect(html).toContain('全部');
    expect(html).toContain('乌拉那拉·宜修');
    expect(html).toContain('钮祜禄·甄嬛');
    expect(html).not.toContain('>皇后</button>');
    expect(html).not.toContain('>银行</button>');
    expect(html).toContain('landing-owner-filter property-owner-filter property-theme-treasury selected');
    expect(html).toContain('aria-pressed="true"');
  });

  it('renders character-only filters and a themed owner label in browse mode', () => {
    const ownedProperty = {
      name: '景仁宫', ownerId: 'p1', level: 0, mortgaged: true,
      mortgage: 1500, purchasePrice: 3000, build: 2000,
      buildingSell: 1200, tolls: [800],
    };
    const html = renderToStaticMarkup(createElement(LandingPropertyCardPicker, {
      mode: 'browse',
      properties: [ownedProperty],
      players: [{ id: 'p1', name: '小行老师', characterId: 'yixiu' }],
    }));

    expect(html).toContain('乌拉那拉·宜修');
    expect(html).not.toContain('小行老师</button>');
    expect(html).toContain('乌拉那拉·宜修（<span class="property-owner-nickname">小行老师</span>）');
    expect(html).toContain('property-theme-yixiu');
    expect(html).toContain('已抵押');
    expect(html).toContain('下级费用<strong>2,000 两</strong>');
    expect(html).toContain('<article');
  });

  it('shows owned properties before treasury properties in browse mode', () => {
    const ownedProperty = {
      name: '景仁宫', ownerId: 'p1', level: 0, mortgaged: false,
      mortgage: 1500, purchasePrice: 3000, build: 2000,
      buildingSell: 1200, tolls: [800],
    };
    const html = renderToStaticMarkup(createElement(LandingPropertyCardPicker, {
      mode: 'browse',
      properties: [
        { ...ownedProperty, name: '甘露寺', ownerId: null },
        ownedProperty,
      ],
      players: [{ id: 'p1', name: '小行老师', characterId: 'yixiu' }],
    }));

    expect(html.indexOf('景仁宫')).toBeLessThan(html.indexOf('甘露寺'));
  });
});
