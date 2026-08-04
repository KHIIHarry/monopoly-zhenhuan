import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const stylesheetUrl = new URL('./globals.css', import.meta.url);

function extractMediaBlock(stylesheet: string, header: string, occurrence: 'first' | 'last' = 'last') {
  const start = occurrence === 'first' ? stylesheet.indexOf(header) : stylesheet.lastIndexOf(header);
  if (start < 0) throw new Error(`Missing CSS media block: ${header}`);
  const openingBrace = stylesheet.indexOf('{', start + header.length);
  if (openingBrace < 0) throw new Error(`Missing opening brace for CSS media block: ${header}`);

  let depth = 0;
  for (let index = openingBrace; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === '{') depth += 1;
    if (stylesheet[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return stylesheet.slice(start, index + 1);
  }

  throw new Error(`Missing closing brace for CSS media block: ${header}`);
}

describe('profile device controls', () => {
  test('separates the logout-others action from the device list', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.device-list\s*\+\s*button\s*\{[^}]*margin-top:\s*24px;/s);
  });

  test('stacks the device logout control without wrapping on narrow screens', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*560px\)[\s\S]*?\.device-list article\s*\{[^}]*flex-direction:\s*column;/);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*560px\)[\s\S]*?\.device-list article\s*>\s*button\s*\{[^}]*width:\s*100%;[^}]*white-space:\s*nowrap;/);
  });
});

describe('lobby account header', () => {
  test('keeps the account tools vertically centered in the palace-red banner', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.v2-header\.lobby-hero\s*\{[^}]*align-items:\s*center;/s);
  });
});

describe('reference landing page', () => {
  test('defines responsive palace-page styles without legacy image assets', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.landing-lantern\s*\{/);
    expect(stylesheet).toMatch(/\.landing-join-button\s*\{[^}]*min-height:\s*68px;/s);
    expect(stylesheet).toMatch(/\.landing-dice\s*\{[^}]*top:\s*-80px;/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*600px\)/);
    expect(stylesheet).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(stylesheet).not.toContain('/assets/landing/');
  });
});

describe('mobile editable controls', () => {
  test('keeps editable control text at the iOS zoom threshold', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*600px\)[\s\S]*?input,\s*select,\s*textarea\s*\{[^}]*font-size:\s*16px;/);
  });

  test('overrides the login form inherited control font size', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*600px\)[\s\S]*?\.v2-form input,\s*\.v2-form select,\s*\.v2-panel input\s*\{[^}]*font-size:\s*16px;/);
  });
});

describe('character seat titles', () => {
  test('reserve the occupied marker space only on occupied cards', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.seat-card h2\s*\{(?![^}]*padding-right)[^}]*\}/s);
    expect(stylesheet).toMatch(/\.seat-card\.occupied h2\s*\{[^}]*padding-right:\s*58px;/s);
  });
});

describe('seat swap action', () => {
  test('uses the blue seat-selection hover treatment for exchange requests', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.seat-card \.swap-request\s*\{[^}]*border:\s*1px solid #174a7c;[^}]*background:\s*#e7f3ff;[^}]*color:\s*#174a7c;/s);
    expect(stylesheet).toMatch(/\.seat-card \.swap-request:hover:not\(:disabled\)\s*\{[^}]*background:\s*#d7eaff;/s);
  });

  test('keeps both decision buttons touchable on narrow screens', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');
    const mediaStart = stylesheet.indexOf('@media (max-width: 560px)');
    const mediaEnd = stylesheet.indexOf('@media ', mediaStart + 1);
    const narrowStyles = stylesheet.slice(mediaStart, mediaEnd);

    expect(mediaStart).toBeGreaterThanOrEqual(0);
    expect(narrowStyles).toMatch(
      /\.swap-list \.request-actions\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*grid-template-columns:\s*1fr 1fr;/,
    );
  });
});

describe('approval submission time', () => {
  test('allows the seconds-precision timestamp to wrap inside narrow cards', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(
      /\.approval-submitted-at\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    );
  });
});

describe('long approval names', () => {
  test('wraps payment details and landing nicknames inside their grid columns', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(
      /\.payment-approval-details\s*>\s*:is\(strong, small\)\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(stylesheet).toMatch(
      /\.landing-location-meta \.landing-player-nickname\s*\{[^}]*width:\s*100%;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;[^}]*text-align:\s*center;/s,
    );
  });
});

describe('landing confirmation status', () => {
  test('uses a green presentation only after the landing has been confirmed', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.landing-status-confirmed\s*\{[^}]*color:\s*#174d34;[^}]*background:\s*#e4f2e8;/s);
  });
});

describe('settlement header return action', () => {
  test('keeps the room-list action on one line when the header is narrow', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.v2-header\s*>\s*button\s*\{[^}]*flex:\s*0\s+0\s+auto;[^}]*white-space:\s*nowrap;/s);
  });
});

describe('admin room configuration controls', () => {
  test('aligns select controls with text inputs', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.admin-detail \.form-grid :is\(input, select\)\s*\{[^}]*height:\s*48px;[^}]*min-height:\s*48px;[^}]*box-sizing:\s*border-box;/s);
  });
});

describe('room admission badges', () => {
  test('uses the unavailable tone without changing the badge radius', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.room-row \.room-status-badge\s*\{[^}]*border-radius:\s*6px;/s);
    expect(stylesheet).toMatch(/\.room-status-unavailable\s*\{\s*background:\s*#626963;\s*\}/);
  });
});

describe('H5 scroll ownership', () => {
  test('locks the document roots', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(
      /html,\s*body,\s*#root\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;[^}]*overscroll-behavior:\s*none;/s,
    );
  });

  test('moves vertical scrolling to every page container', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(
      /\.v2-page,\s*\.landing-page,\s*\.center,\s*\.workbench-scroll\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;[^}]*-webkit-overflow-scrolling:\s*touch;/s,
    );
    expect(stylesheet).toMatch(
      /\.app-shell\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s,
    );
  });
});

describe('manual refresh feedback', () => {
  test('animates the refresh icon through exactly two rotations', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(
      /\.refresh-two-turns\s*\{[^}]*animation:\s*refresh-two-turns\s+800ms\s+linear\s+both;/s,
    );
    expect(stylesheet).toMatch(
      /@keyframes\s+refresh-two-turns\s*\{\s*to\s*\{[^}]*transform:\s*rotate\(720deg\);/s,
    );
  });
});

describe('mobile landing selection sheet', () => {
  test('uses full-bleed solid dividers without changing the property-card gap', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');
    const mobileStyles = extractMediaBlock(
      stylesheet,
      '@media (max-width: 899px)',
    );
    const gridRule = mobileStyles.match(
      /\.modal-backdrop \.landing-action-sheet \.landing-property-grid\s*\{([^}]*)\}/,
    )?.[1];

    expect(gridRule).toMatch(/width:\s*calc\(100% \+ 32px\);/);
    expect(gridRule).toMatch(/margin:\s*0 -16px 24px;/);
    expect(gridRule).toMatch(/padding:\s*16px 22px;/);
    expect(gridRule).toMatch(/border-block:\s*2px solid #24211f;/);
    expect(mobileStyles).toMatch(
      /\.modal-backdrop \.landing-action-sheet > \.action-sheet-content,\s*\.modal-backdrop \.landing-action-sheet \.landing-property-picker\s*\{\s*overflow:\s*visible;\s*\}/,
    );
    expect(gridRule).not.toMatch(/gap:\s*\d+px;/);
    expect(mobileStyles).not.toMatch(
      /\.modal-backdrop \.landing-action-sheet \.landing-property-grid\s*\{[^}]*gap:\s*\d+px;[^}]*\}/s,
    );
  });

  test('keeps portrait controls above the real navigation and leaves tablet cards content-sized', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');
    const mobileStyles = extractMediaBlock(
      stylesheet,
      '@media (max-width: 899px)',
    );

    expect(mobileStyles).toMatch(
      /:root\s*\{\s*--mobile-function-bottom-space:\s*calc\(66px \+ env\(safe-area-inset-bottom\)\);\s*\}/,
    );
    expect(mobileStyles).not.toMatch(
      /\.modal-backdrop \.landing-action-sheet \.landing-property-card(?:\s*,|\s*\{)[^}]*height:\s*174px;/s,
    );
    expect(mobileStyles).not.toMatch(
      /\.landing-location-meta \.landing-player-nickname\s*\{[^}]*white-space:\s*nowrap;/,
    );
  });

  test('places the selected property mark in the lower-right corner on every viewport', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');
    const compactStyles = extractMediaBlock(stylesheet, '@media (max-width: 430px)', 'first');

    expect(stylesheet).toMatch(
      /\.property-selected-mark\s*\{[^}]*top:\s*auto;[^}]*right:\s*12px;[^}]*bottom:\s*12px;/s,
    );
    expect(compactStyles).toMatch(
      /\.landing-action-sheet \.property-selected-mark\s*\{[^}]*top:\s*auto;[^}]*right:\s*9px;[^}]*bottom:\s*9px;/,
    );
  });

  test('keeps short landscape filters on one scrollable row above a full-bleed property grid', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');
    const landscapeStyles = extractMediaBlock(
      stylesheet,
      '@media (orientation: landscape) and (max-height: 560px) and (max-width: 899px)',
    );
    const pickerRule = landscapeStyles.match(
      /\.modal-backdrop \.landing-action-sheet \.landing-property-picker\s*\{([^}]*)\}/,
    )?.[1];
    const filterRule = landscapeStyles.match(
      /\.modal-backdrop \.landing-action-sheet \.landing-property-owner-filters\s*\{([^}]*)\}/,
    )?.[1];
    const ownerFilterRule = landscapeStyles.match(
      /\.modal-backdrop \.landing-action-sheet \.landing-owner-filter\s*\{([^}]*)\}/,
    )?.[1];
    const gridRule = landscapeStyles.match(
      /\.modal-backdrop \.landing-action-sheet \.landing-property-grid\s*\{([^}]*)\}/,
    )?.[1];

    expect(landscapeStyles).toMatch(
      /--mobile-function-bottom-space:\s*calc\(58px \+ env\(safe-area-inset-bottom\)\);/,
    );
    expect(landscapeStyles).toMatch(
      /\.modal-backdrop \.landing-action-sheet > \.action-sheet-content\s*\{\s*overflow:\s*visible;\s*\}/,
    );
    expect(pickerRule).toMatch(/width:\s*calc\(100% \+ 32px\);/);
    expect(pickerRule).toMatch(/margin-inline:\s*-16px;/);
    expect(pickerRule).toMatch(/padding-inline:\s*16px;/);
    expect(pickerRule).toMatch(/overflow:\s*hidden;/);
    expect(pickerRule).toMatch(/gap:\s*6px;/);
    expect(filterRule).toMatch(/flex-wrap:\s*nowrap;/);
    expect(filterRule).toMatch(/overflow-x:\s*auto;/);
    expect(filterRule).toMatch(/overflow-y:\s*hidden;/);
    expect(ownerFilterRule).toMatch(/flex:\s*0 0 auto;/);
    expect(gridRule).toMatch(/width:\s*calc\(100% \+ 32px\);/);
    expect(gridRule).toMatch(/margin:\s*0 -16px 6px;/);
    expect(gridRule).toMatch(/padding:\s*6px 22px;/);
    expect(gridRule).toMatch(/border-block:\s*2px solid #24211f;/);
  });
});
