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

  it('keeps the landing selection outline inside a wider two-column desktop sheet', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/\.landing-action-sheet\s*\{[^}]*width:\s*min\(840px,\s*calc\(100% - 40px\)\)/s);
    expect(stylesheet).toMatch(/\.landing-action-sheet \.landing-property-grid\s*\{[^}]*padding:\s*6px/s);
    expect(stylesheet).toMatch(/@media\s*\(min-width:\s*700px\)[\s\S]*?\.landing-action-sheet \.landing-property-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  });

  it('uses compact edge-safe declaration cards through the 430px mobile range', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet\s*\{[^}]*width:\s*calc\(100% - 16px\)[^}]*padding:\s*10px 12px 0/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet \.landing-property-card\.collapsed\s*\{[^}]*height:\s*174px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet \.landing-property-empty\s*\{[^}]*height:\s*174px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet \.landing-property-search input\s*\{[^}]*min-height:\s*40px[^}]*font-size:\s*16px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet \.landing-owner-filter\s*\{[^}]*min-height:\s*40px/s);
  });

  it('keeps all mobile browse property surfaces inset and compact', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker\s*\{[^}]*margin-inline:\s*16px[^}]*gap:\s*8px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-search input\s*\{[^}]*min-height:\s*40px[^}]*font-size:\s*16px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-owner-filter\s*\{[^}]*min-height:\s*40px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-grid\s*\{[^}]*gap:\s*10px[^}]*padding:\s*0/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-card\.collapsed\s*\{[^}]*height:\s*184px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-empty\s*\{[^}]*height:\s*184px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-card-title\s*\{[^}]*font-size:\s*19px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.property-mortgage-stamp\s*\{[^}]*width:\s*94px[^}]*height:\s*32px/s);
  });
});
