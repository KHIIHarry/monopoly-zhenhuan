import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const stylesheetUrl = new URL('./globals.css', import.meta.url);

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
