import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const stylesheetUrl = new URL('../globals.css', import.meta.url);

describe('property explorer visual contract', () => {
  it('keeps collapsed and empty cards at the approved fixed size without stretching one result', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/\.landing-property-grid\s*\{[^}]*repeat\(auto-fill,[^}]*360px[^}]*justify-content:\s*start/s);
    expect(stylesheet).toMatch(/\.landing-property-card\.collapsed\s*\{[^}]*height:\s*220px/s);
    expect(stylesheet).toMatch(/\.landing-property-empty\s*\{[^}]*max-width:\s*360px[^}]*height:\s*220px/s);
  });

  it('uses pale owner filters and preserves the themed card divider', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/\.property-owner-filter\s*\{[^}]*color-mix\([^}]*var\(--property-theme\)[^}]*20%/s);
    expect(stylesheet).toMatch(/\.property-theme-unowned\s*\{[^}]*--property-filter-fill:\s*0%/s);
    expect(stylesheet).toMatch(/\.landing-property-card\s*\{[^}]*border-left:\s*5px solid var\(--property-theme\)[^}]*border-radius:\s*6px/s);
  });

  it('renders the mortgage stamp, cold-palace hint, and compact detail modules', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/\.landing-property-card\.mortgaged\s*\{[^}]*opacity:\s*\.62/s);
    expect(stylesheet).toMatch(/\.property-mortgage-stamp\s*\{[^}]*width:\s*106px[^}]*height:\s*36px[^}]*rotate\(-45deg\)/s);
    expect(stylesheet).toMatch(/\.property-cold-palace-hint\s*\{[^}]*white-space:\s*nowrap/s);
    expect(stylesheet).toMatch(/\.property-detail-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    expect(stylesheet).toMatch(/\.property-palace-tier\s*\{[^}]*border:\s*3px double/s);
  });

  it('falls back to one fluid card column on narrow screens', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*420px\)[\s\S]*?\.landing-property-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  });
});
