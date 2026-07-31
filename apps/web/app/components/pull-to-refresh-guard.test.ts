import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const guardUrl = new URL('./pull-to-refresh-guard.tsx', import.meta.url);
const layoutUrl = new URL('../layout.tsx', import.meta.url);

describe('pull-to-refresh guard integration', () => {
  test('mounts once inside a real application root', async () => {
    const layout = await readFile(layoutUrl, 'utf8');

    expect(layout).toContain('id="root"');
    expect(layout).toContain('<PullToRefreshGuard />');
  });

  test('observes touch movement non-passively and cleans up listeners', async () => {
    const guard = await readFile(guardUrl, 'utf8');

    expect(guard).toMatch(
      /document\.addEventListener\(['"]touchmove['"], onTouchMove, \{ passive: false \}\)/,
    );
    expect(guard).toMatch(
      /document\.removeEventListener\(['"]touchmove['"], onTouchMove\)/,
    );
    expect(guard).toMatch(
      /document\.addEventListener\(['"]touchcancel['"], clearGesture\)/,
    );
    expect(guard).toMatch(
      /document\.addEventListener\(['"]touchend['"], clearGesture\)/,
    );
  });

  test('covers every page root, nested scroll, interactive exemptions, and route reset', async () => {
    const guard = await readFile(guardUrl, 'utf8');

    expect(guard).toContain(
      '.v2-page, .landing-page, .center, .workbench-scroll',
    );
    expect(guard).toContain('nestedScrollContainers');
    expect(guard).toContain('[role="slider"]');
    expect(guard).toContain('[draggable="true"]');
    expect(guard).toContain('usePathname()');
    expect(guard).toContain('scrollContainer.scrollTop = 0');
    expect(guard).not.toMatch(/userAgent|navigator\.platform/);
  });
});
