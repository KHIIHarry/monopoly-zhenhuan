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

describe('admin room configuration controls', () => {
  test('aligns select controls with text inputs', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/\.admin-detail \.form-grid :is\(input, select\)\s*\{[^}]*height:\s*48px;[^}]*min-height:\s*48px;[^}]*box-sizing:\s*border-box;/s);
  });
});
