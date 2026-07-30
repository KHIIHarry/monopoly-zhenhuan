import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingPropertyCardPicker } from './landing-property-card-picker';

describe('LandingPropertyCardPicker', () => {
  it('renders an active all-properties tag and a tag for each player', () => {
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
          { id: 'p1', name: '皇后' },
          { id: 'p2', name: '甄嬛' },
        ],
        value: '',
        onChange: () => undefined,
      }),
    );

    expect(html).toContain('全部');
    expect(html).toContain('皇后');
    expect(html).toContain('甄嬛');
    expect(html).toContain('aria-pressed="true"');
  });
});
