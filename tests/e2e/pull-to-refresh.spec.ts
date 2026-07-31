import { expect, test } from '@playwright/test';

test('document is locked while the active page container scrolls', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }),
  );
  await page.goto('/');

  const rootMetrics = await page.evaluate(() => {
    const root = document.getElementById('root');
    const pageScroller = document.querySelector<HTMLElement>('.landing-page');
    if (!root || !pageScroller) return null;

    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      rootOverflow: getComputedStyle(root).overflow,
      rootHeight: root.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      pageOverflowY: getComputedStyle(pageScroller).overflowY,
      overscrollY: getComputedStyle(pageScroller).overscrollBehaviorY,
    };
  });

  expect(rootMetrics).not.toBeNull();
  expect(rootMetrics!.bodyOverflow).toBe('hidden');
  expect(rootMetrics!.rootOverflow).toBe('hidden');
  expect(rootMetrics!.rootHeight).toBeCloseTo(rootMetrics!.viewportHeight, 0);
  expect(rootMetrics!.pageOverflowY).toBe('auto');
  expect(rootMetrics!.overscrollY).toBe('contain');
});

test('long route content scrolls inside the page container', async ({ page }) => {
  const account = {
    id: 'a1',
    username: 'zhenhuan',
    displayName: '甄嬛',
    isSuperAdmin: false,
    canCreateRoom: true,
    lastLoginAt: '2026-07-31T08:00:00.000Z',
  };
  const rooms = Array.from({ length: 24 }, (_, index) => ({
    id: `room-${index}`,
    name: `测试房间 ${index + 1}`,
    status: 'LOBBY',
    creator: '甄嬛',
    memberCount: 1,
    playerCount: 1,
    playerLimit: 5,
    hasPassword: false,
    mine: true,
    characterId: null,
    myCharacter: null,
    isBank: false,
  }));

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { account, sessions: [] } }),
  );
  await page.route('**/api/rooms/mine', (route) =>
    route.fulfill({ json: rooms }),
  );
  await page.route('**/api/rooms/history', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [] }));
  await page.goto('/rooms');
  await expect(page.getByRole('heading', { name: '甄嬛' })).toBeVisible();

  const metrics = await page
    .locator('.v2-page')
    .evaluate((scrollContainer) => {
      scrollContainer.scrollTop = 160;
      return {
        clientHeight: scrollContainer.clientHeight,
        scrollHeight: scrollContainer.scrollHeight,
        scrollTop: scrollContainer.scrollTop,
        windowScrollY: window.scrollY,
        bodyScrollTop: document.body.scrollTop,
        documentScrollTop: document.documentElement.scrollTop,
      };
    });

  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.scrollTop).toBeGreaterThan(0);
  expect(metrics.windowScrollY).toBe(0);
  expect(metrics.bodyScrollTop).toBe(0);
  expect(metrics.documentScrollTop).toBe(0);
});

test('legacy touch guard only cancels an unhandled downward edge pull', async ({
  page,
}) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }),
  );
  const authRequest = page.waitForRequest('**/api/auth/me');
  await page.goto('/');
  await authRequest;
  await page.evaluate(() => new Promise(requestAnimationFrame));

  const results = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.landing-page');
    if (!main) return null;

    const dispatchTouch = (
      target: Element,
      start: { x: number; y: number },
      current: { x: number; y: number },
    ) => {
      const createEvent = (
        type: 'touchstart' | 'touchmove',
        points: Array<{ clientX: number; clientY: number }>,
      ) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: points });
        return event;
      };

      target.dispatchEvent(
        createEvent('touchstart', [{ clientX: start.x, clientY: start.y }]),
      );
      const move = createEvent('touchmove', [
        { clientX: current.x, clientY: current.y },
      ]);
      target.dispatchEvent(move);
      return move.defaultPrevented;
    };

    const outer = document.createElement('div');
    outer.style.cssText =
      'display:block;width:120px;height:80px;overflow-y:auto';
    const outerContent = document.createElement('div');
    outerContent.style.cssText =
      'display:block;width:120px;height:240px;min-height:240px';
    const inner = document.createElement('div');
    inner.style.cssText =
      'display:block;width:100px;height:40px;overflow-y:auto';
    const touchTarget = document.createElement('div');
    touchTarget.style.cssText =
      'display:block;width:100px;height:120px;min-height:120px';
    inner.append(touchTarget);
    outerContent.append(inner);
    outer.append(outerContent);
    main.prepend(outer);

    main.scrollTop = 0;
    inner.scrollTop = 0;
    outer.scrollTop = 20;
    const outerCanScroll = dispatchTouch(
      touchTarget,
      { x: 20, y: 100 },
      { x: 21, y: 120 },
    );

    outer.scrollTop = 0;
    const allAtTop = dispatchTouch(
      touchTarget,
      { x: 20, y: 100 },
      { x: 21, y: 120 },
    );

    const input = document.createElement('input');
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    const draggable = document.createElement('div');
    draggable.setAttribute('draggable', 'true');
    main.append(input, slider, draggable);

    return {
      outerCanScroll,
      allAtTop,
      input: dispatchTouch(input, { x: 20, y: 100 }, { x: 21, y: 120 }),
      slider: dispatchTouch(slider, { x: 20, y: 100 }, { x: 21, y: 120 }),
      draggable: dispatchTouch(
        draggable,
        { x: 20, y: 100 },
        { x: 21, y: 120 },
      ),
      horizontal: dispatchTouch(
        touchTarget,
        { x: 20, y: 100 },
        { x: 60, y: 110 },
      ),
    };
  });

  expect(results).toEqual({
    outerCanScroll: false,
    allAtTop: true,
    input: false,
    slider: false,
    draggable: false,
    horizontal: false,
  });
});
