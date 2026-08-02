import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const stylesheetUrl = new URL('../globals.css', import.meta.url);

describe('player asset accordion styles', () => {
  test('uses stable rows and a four-column desktop asset grid', async () => {
    const stylesheet = await readFile(
      fileURLToPath(stylesheetUrl),
      'utf8',
    );

    expect(stylesheet).toMatch(
      /\.player-asset-accordion\s*\{[^}]*margin:\s*0 16px;[^}]*border:\s*1px solid var\(--line\);/s,
    );
    expect(stylesheet).toMatch(
      /\.player-asset-trigger\s*\{[^}]*grid-template-areas:\s*"avatar heading chevron" "metrics metrics metrics";/s,
    );
    expect(stylesheet).toMatch(
      /\.player-asset-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(stylesheet).toMatch(
      /\.player-asset-panel \.browse-property-picker\s*\{[^}]*margin-inline:\s*0;/s,
    );
  });

  test('uses a two-column asset grid on narrow phones', async () => {
    const stylesheet = await readFile(
      fileURLToPath(stylesheetUrl),
      'utf8',
    );

    expect(stylesheet).toMatch(
      /@media\s*\(max-width:\s*430px\)[\s\S]*?\.player-asset-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
  });
});
