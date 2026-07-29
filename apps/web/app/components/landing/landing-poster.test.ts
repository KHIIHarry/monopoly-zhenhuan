import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const posterUrl = new URL('./landing-poster.tsx', import.meta.url);

describe('reference landing poster', () => {
  test('keeps the join callback in a semantic palace-page layout', async () => {
    const source = await readFile(fileURLToPath(posterUrl), 'utf8');

    expect(source).toContain('className="landing-lantern landing-lantern-left"');
    expect(source).toContain('className="landing-lantern landing-lantern-right"');
    expect(source).toContain('<h1>甄嬛传</h1>');
    expect(source).toContain('data-testid="landing-join-button"');
    expect(source).toContain('onClick={onJoin}');
    expect(source.indexOf('className="landing-dice"')).toBeLessThan(source.indexOf('className="landing-palace-mark"'));
  });

  test('does not retain the superseded illustration layers', async () => {
    const source = await readFile(fileURLToPath(posterUrl), 'utf8');

    expect(source).not.toContain("from './poster-background'");
    expect(source).not.toContain("from './poster-characters'");
    expect(source).not.toContain("from './poster-decorations'");
    expect(source).not.toContain("from './poster-frame'");
    expect(source).not.toContain("from './poster-join-button'");
    expect(source).not.toContain("from './poster-title'");
  });
});
