import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const stylesheetUrl = new URL('./globals.css', import.meta.url);

describe('profile device controls', () => {
  test('separates the logout-others action from the device list', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.device-list\s*\+\s*button\s*\{[^}]*margin-top:\s*24px;/s);
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
