import { mkdir } from 'node:fs/promises';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { BrowserRoomSummary, BrowserSeatSnapshot, BrowserSnapshot } from './browser-fixture-types';

const now = '2026-07-27T08:00:00.000Z';
const longRoomName = '翼坤宫夏日特别长名称跨宫联动宴饮对局';
const longDisplayName = '钮祜禄甄嬛并临时代理六宫事务超长昵称';
const account = { id: 'account-1', username: 'zhenhuan', displayName: longDisplayName, isSuperAdmin: true, canCreateRoom: true, lastLoginAt: now };
const room = (overrides: Partial<BrowserRoomSummary> = {}): BrowserRoomSummary => ({
  id: 'room-1', name: longRoomName, status: 'PLAYING', creator: '甄嬛', memberCount: 5, playerCount: 5, playerLimit: 5,
  hasPassword: true, mine: true, canJoin: true, joinBlockedReason: null, availableCharacters: [], characterId: 'zhenhuan', myCharacter: '钮祜禄·甄嬛', isBank: true,
  createdAt: '2026-07-29T00:05:00', startedAt: null, endedAt: null, ...overrides,
});
const dual = { characterId: 'zhenhuan', playerId: 'player-1', isBank: true, activeHere: true };
const characters = [
  { id: 'zhenhuan', name: '钮祜禄·甄嬛', skill: { companionCashReward: 500 }, initialProperty: '永寿宫', occupiedBy: longDisplayName, canSelect: false },
  { id: 'yixiu', name: '乌拉那拉·宜修', skill: { coldPalaceSkipReduction: 2 }, initialProperty: '景仁宫', occupiedBy: '安陵容', canSelect: false },
  { id: 'huashifei', name: '年世兰', skill: { tollBonus: 300 }, initialProperty: '翊坤宫', occupiedBy: null, canSelect: false },
];
const pendingSwap = {
  id: 'swap-1', roomId: 'room-1', requesterMembershipId: 'membership-2', targetMembershipId: 'membership-1', requesterCharacterId: 'yixiu', targetCharacterId: 'zhenhuan',
  requesterDisplayName: '一个非常非常长的角色交换申请人名称', targetDisplayName: longDisplayName, status: 'PENDING_TARGET', rejectionReason: null,
  createdAt: now, updatedAt: now, resolvedAt: null, actions: { canAccept: true, canReject: true, canCancel: false, canApproveBank: false },
};
const snapshot: BrowserSnapshot = {
  id: 'room-1', stateVersion: 1, code: 'YKGSUMMER', name: longRoomName, status: 'PLAYING', diceMode: 'PHYSICAL', redemptionFee: 500, startReward: 1_000, currentPlayerId: 'player-1', turn: null,
  players: [
    { id: 'player-1', name: longDisplayName, characterId: 'zhenhuan', balance: 5_000, remainingSkipTurns: 0 },
    { id: 'player-2', name: '沈眉庄', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0 },
  ],
  properties: [{ name: '一个特别长的宫殿地产名称用于验证换行', ownerId: 'player-1', level: 2, mortgaged: false, mortgage: 1_800, purchasePrice: 3_600, build: 600, buildingSell: 300, tolls: [100, 300, 800, 1_400, 2_100, 3_000] }],
  ledger: [], requests: [], landings: [], audit: [], reversalCandidate: null,
};
const ranked = [{
  accountId: 'account-1', displayNameSnapshot: longDisplayName, characterNameSnapshot: '钮祜禄·甄嬛', cash: 1_000,
  unmortgagedPropertyValue: 3_600, mortgagedPropertyNetValue: 1_500, buildingSellValue: 1_200, totalWealth: 7_300, rank: 1, isWinner: true,
  propertyDetails: [{ roomPropertyId: 'property-1', nameSnapshot: '一个特别长的宫殿地产名称用于验证换行', mortgaged: false, mortgagePriceSnapshot: 1_800, landSaleValue: 3_600, landSettlementValue: 3_600, buildingLevel: 2, buildingSellPriceSnapshot: 300, buildingSellValue: 600 }],
}];
const settlement = {
  id: 'settlement-1', roomId: 'room-1', endedByAccountId: 'account-1', endedAt: now, totalTurns: 12, durationSeconds: 3600, forced: false, forceReason: null,
  winners: ['account-1'], ranking: [{ accountId: 'account-1', rank: 1 }], overriddenBlockers: [], players: ranked,
};
const devices = [
  { id: 'session-current', deviceName: '当前 iPhone', browser: 'Safari', operatingSystem: 'iOS', loginIp: '120.***.***.36', lastIp: '120.***.***.36', createdAt: now, lastActiveAt: now, current: true },
  { id: 'session-other', deviceName: '另一台设备名称非常非常长且需要自动换行', browser: 'Chrome', operatingSystem: 'macOS', loginIp: '10.***.***.8', lastIp: '10.***.***.9', createdAt: now, lastActiveAt: now, current: false },
];

async function mockLobby(page: Page, rooms: BrowserRoomSummary[] = [room()]) {
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: rooms }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: rooms }));
}

async function mockAuthenticated(page: Page, rooms: BrowserRoomSummary[] = [room()]) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: devices } }));
  await mockLobby(page, rooms);
}

async function mockRoom(page: Page, capability = dual, activeHere = true, swaps = [pendingSwap]) {
  const seatSnapshot: BrowserSeatSnapshot<typeof pendingSwap> = {
    stateVersion: 1,
    room: { id: 'room-1', name: longRoomName, status: 'PLAYING', skillEnabled: true }, membership: { id: 'membership-1', ...capability, activeHere },
    characters, bank: { occupiedBy: capability.isBank ? longDisplayName : null }, roleSwapRequests: swaps,
  };
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatSnapshot }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: snapshot }));
}

async function assertSurface(page: Page) {
  await expect(page.locator('h1').first()).toBeVisible();
  const devIndicatorVisible = await page.locator('nextjs-portal').evaluateAll((portals) => portals.some((portal) => {
    const indicator = portal.shadowRoot?.getElementById('data-devtools-indicator');
    if (!indicator) return false;
    const style = getComputedStyle(indicator); const rect = indicator.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }));
  expect(devIndicatorVisible, 'Next.js development indicator must not cover app controls').toBe(false);
  const metrics = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const undersized = [...document.querySelectorAll('button, input:not([type="checkbox"]):not([type="radio"]), select, textarea, summary')]
      .filter(visible).map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30) ?? element.tagName, width: rect.width, height: rect.height };
      }).filter((item) => item.height < 43.5 || item.width < 43.5);
    const fixed = [...document.querySelectorAll('nav, .floating-create')].filter((element) => visible(element) && getComputedStyle(element).position === 'fixed').map((element) => {
      const rect = element.getBoundingClientRect(); const main = element.closest('main');
      return { height: rect.height, paddingBottom: main ? Number.parseFloat(getComputedStyle(main).paddingBottom) : 0 };
    });
    const nav = document.querySelector('nav'); const scroll = document.querySelector('.workbench-scroll');
    const navGeometry = nav && scroll && visible(nav) && visible(scroll) ? {
      navTop: nav.getBoundingClientRect().top,
      navRight: nav.getBoundingClientRect().right,
      scrollBottom: scroll.getBoundingClientRect().bottom,
      scrollLeft: scroll.getBoundingClientRect().left,
      intersection: Math.max(0, Math.min(nav.getBoundingClientRect().bottom, scroll.getBoundingClientRect().bottom) - Math.max(nav.getBoundingClientRect().top, scroll.getBoundingClientRect().top)),
    } : null;
    const distortedTools = [...document.querySelectorAll('.workbench-tools > button:not(.icon)')].filter(visible).filter((element) => {
      const label = element.querySelector('span');
      return !element.classList.contains('workbench-tool-seat') || !label || visible(label);
    }).map((element) => {
      const rect = element.getBoundingClientRect(); return { text: element.textContent?.trim(), width: rect.width, height: rect.height };
    }).filter((item) => item.width < 75.5 || item.height > 64);
    const navGridAutoFlow = nav && visible(nav) ? getComputedStyle(nav).gridAutoFlow : null;
    return { scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth, undersized, fixed, navGeometry, navGridAutoFlow, distortedTools };
  });
  expect(metrics.scrollWidth, `horizontal overflow: ${metrics.scrollWidth}px > ${metrics.viewportWidth}px`).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.undersized, `undersized controls: ${JSON.stringify(metrics.undersized)}`).toEqual([]);
  expect(metrics.distortedTools, `distorted workbench tools: ${JSON.stringify(metrics.distortedTools)}`).toEqual([]);
  for (const item of metrics.fixed) expect(item.paddingBottom, `fixed control ${item.height}px needs reserved bottom space`).toBeGreaterThanOrEqual(item.height + 8);
  if (metrics.navGeometry) {
    if (metrics.viewportWidth >= 900) {
      expect(metrics.navGeometry.navRight, `desktop workbench navigation/content overlap: ${JSON.stringify(metrics.navGeometry)}`).toBeLessThanOrEqual(metrics.navGeometry.scrollLeft + 1);
    } else {
      expect(metrics.navGeometry.intersection, `workbench content/nav overlap: ${JSON.stringify(metrics.navGeometry)}`).toBe(0);
      expect(metrics.navGeometry.scrollBottom).toBeLessThanOrEqual(metrics.navGeometry.navTop + 1);
      expect(metrics.navGridAutoFlow, 'mobile navigation remains horizontal').toBe('column');
    }
  }
}

async function assertDesktopWorkbenchSidebar(page: Page) {
  const metrics = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="工作台导航"]');
    const scroll = document.querySelector<HTMLElement>('.workbench-scroll');
    if (!nav || !scroll) return null;
    const navRect = nav.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const content = scroll.querySelector<HTMLElement>('header');
    const contentRect = content?.getBoundingClientRect();
    const label = nav.querySelector<HTMLElement>('button span');
    return {
      navWidth: navRect.width,
      navHeight: navRect.height,
      navRight: navRect.right,
      scrollLeft: scrollRect.left,
      scrollWidth: scrollRect.width,
      shellWidth: document.querySelector<HTMLElement>('.app-shell')?.getBoundingClientRect().width ?? 0,
      viewportHeight: window.innerHeight,
      navDisplay: getComputedStyle(nav).display,
      navLabelSize: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0,
      contentLeftGap: contentRect ? contentRect.left - scrollRect.left : Infinity,
      contentRightGap: contentRect ? scrollRect.right - contentRect.right : Infinity,
    };
  });

  expect(metrics, 'workbench desktop shell is present').not.toBeNull();
  expect(metrics!.navWidth).toBeGreaterThanOrEqual(280);
  expect(metrics!.navHeight).toBeGreaterThanOrEqual(metrics!.viewportHeight - 1);
  expect(metrics!.navRight).toBeLessThanOrEqual(metrics!.scrollLeft + 1);
  expect(metrics!.scrollWidth).toBeGreaterThan(900);
  expect(metrics!.shellWidth).toBeGreaterThan(1_000);
  expect(metrics!.navDisplay).toBe('flex');
  expect(metrics!.navLabelSize).toBeGreaterThanOrEqual(14);
  expect(metrics!.contentLeftGap).toBeLessThanOrEqual(32);
  expect(metrics!.contentRightGap).toBeLessThanOrEqual(32);
}

async function assertPlayerWorkbenchHeader(page: Page, playerName: string) {
  await expect(page.locator('.workbench-room-meta')).toBeVisible();
  const metrics = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.workbench-scroll');
    const header = scroll?.querySelector<HTMLElement>('header');
    const identity = scroll?.querySelector<HTMLElement>('.identity-band');
    const turn = scroll?.querySelector<HTMLElement>('.turn-strip');
    if (!scroll || !header || !identity || !turn) return null;
    const scrollRect = scroll.getBoundingClientRect();
    const bandEdges = [header, identity, turn].map((element) => {
      const rect = element.getBoundingClientRect();
      return { leftGap: rect.left - scrollRect.left, rightGap: scrollRect.right - rect.right };
    });
    return {
      heading: header.querySelector('h1')?.textContent?.trim() ?? '',
      roomMeta: header.querySelector<HTMLElement>('.workbench-room-meta')?.textContent?.trim() ?? '',
      bandEdges,
    };
  });

  expect(metrics, 'player workbench header and status bands are present').not.toBeNull();
  expect(metrics!.heading).toBe(playerName);
  expect(metrics!.roomMeta).toBe(`${longRoomName} • YKGSUMMER`);
  for (const edge of metrics!.bandEdges) {
    expect(edge.leftGap).toBeLessThanOrEqual(1);
    expect(edge.rightGap).toBeLessThanOrEqual(1);
  }
}

async function assertWraps(page: Page, text: string) {
  const locator = page.getByText(text, { exact: false }).first();
  await expect(locator).toBeVisible();
  expect(await locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function tabTo(page: Page, target: Locator, options: { restart?: boolean; limit?: number } = {}) {
  await expect(target).toBeVisible();
  if (options.restart !== false) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < (options.limit ?? 120); index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  const active = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent?.trim().slice(0, 80),
    ariaLabel: document.activeElement?.getAttribute('aria-label'),
  }));
  expect(await target.evaluate((element) => element === document.activeElement), `Tab did not reach target; active=${JSON.stringify(active)}`).toBe(true);
}

async function assertIconControl(page: Page, name: string, verifyKeyboard: boolean) {
  const control = page.getByRole('button', { name, exact: true });
  const contrast = await control.evaluate((element) => {
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgba => {
      const values = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return { r: values[0] ?? 0, g: values[1] ?? 0, b: values[2] ?? 0, a: values[3] ?? 1 };
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const layers: Rgba[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const layer = parse(getComputedStyle(current).backgroundColor);
      layers.push(layer);
      if (layer.a >= 0.999) break;
    }
    let background = layers.pop() ?? { r: 255, g: 255, b: 255, a: 1 };
    while (layers.length) background = over(layers.pop()!, background);
    const luminance = ({ r, g, b }: Rgba) => {
      const linear = [r, g, b].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const foreground = luminance(parse(getComputedStyle(element).color));
    const surface = luminance(background);
    return (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05);
  });
  expect(contrast, `${name} icon contrast`).toBeGreaterThanOrEqual(3);
  if (!verifyKeyboard) return;
  await tabTo(page, control);
  expect(await control.evaluate((element) => element === document.activeElement), `${name} accepts keyboard focus`).toBe(true);
  const focus = await control.evaluate((element) => {
    const style = getComputedStyle(element);
    return { alpha: Number(style.outlineColor.match(/[\d.]+/g)?.[3] ?? 1), style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(focus, `${name} focus indicator`).toMatchObject({ alpha: 1, style: 'solid', width: 3 });
}

async function assertDialogKeyboard(page: Page, triggerName: string, dialogName: string) {
  const trigger = page.getByRole('button', { name: triggerName, exact: true });
  await tabTo(page, trigger);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element === document.activeElement || element.contains(document.activeElement))).toBe(true);
  await assertSurface(page);
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const focusState = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent?.trim().slice(0, 80),
    ariaLabel: document.activeElement?.getAttribute('aria-label'),
  }));
  expect(await trigger.evaluate((element) => element === document.activeElement), `focus after close: ${JSON.stringify(focusState)}`).toBe(true);
}

async function assertDialogPointer(page: Page, triggerName: string, dialogName: string) {
  await page.getByRole('button', { name: triggerName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await assertSurface(page);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function capture(page: Page, testInfo: TestInfo, label: string) {
  if (!['desktop-chromium', 'android-chromium'].includes(testInfo.project.name)) return;
  const directory = 'test-results/task7-screenshots';
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${testInfo.project.name}-${label}.png`, fullPage: true });
}

test('landing, login, long lobby, profile dialog, and admin remain accessible', async ({ page }, testInfo) => {
  let authenticated = false;
  await page.route('**/api/auth/me', (route) => authenticated
    ? route.fulfill({ json: { account, sessions: devices } })
    : route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));
  await page.route('**/api/auth/login', (route) => {
    authenticated = true;
    return route.fulfill({ json: { account } });
  });
  await mockLobby(page);
  await page.route('**/api/auth/sessions', (route) => route.fulfill({ json: devices }));
  await page.route('**/api/admin/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/accounts') return route.fulfill({ json: { items: [{ id: 'account-2', username: 'very-long-admin-account-name', displayName: longDisplayName, note: null, status: 'ACTIVE', isSuperAdmin: false, canCreateRoom: true, lastLoginAt: now, createdAt: now, updatedAt: now }], nextCursor: null } });
    if (path === '/api/admin/rooms') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/security-logs') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/dashboard') return route.fulfill({ json: { accounts: { total: 2, active: 2 }, sessions: { valid: 2 }, rooms: { lobby: 1, playing: 1, finished: 0 }, games: { settledTotal: 0, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [] } });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await assertSurface(page);
  const keyboardOnly = testInfo.project.name === 'desktop-chromium';
  const zoomDesktop = testInfo.project.name.startsWith('desktop-');
  const joinButton = page.getByRole('button', { name: '加入游戏组' });
  if (keyboardOnly) {
    await tabTo(page, joinButton);
    await page.keyboard.press('Enter');
  } else await joinButton.click();
  await assertSurface(page);
  const username = page.getByLabel('用户名');
  const password = page.getByLabel('密码');
  const login = page.getByRole('button', { name: '登录', exact: true });
  if (keyboardOnly) {
    await tabTo(page, username);
    await page.keyboard.type('zhenhuan');
    await tabTo(page, password, { restart: false });
    await page.keyboard.type('StrongPassword42');
    await tabTo(page, login, { restart: false });
    await page.keyboard.press('Enter');
  } else {
    await username.fill('zhenhuan');
    await password.fill('StrongPassword42');
    await login.click();
  }
  await expect(page).toHaveURL(/\/rooms$/);
  await assertSurface(page);
  await assertWraps(page, longRoomName);
  await assertIconControl(page, '个人信息', keyboardOnly);
  await assertIconControl(page, '超管后台', keyboardOnly);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await capture(page, testInfo, 'lobby');

  if (zoomDesktop) {
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await assertSurface(page);
    await assertWraps(page, longRoomName);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  }

  const profileButton = page.getByRole('button', { name: '个人信息' });
  if (keyboardOnly) {
    await tabTo(page, profileButton);
    await page.keyboard.press('Enter');
  } else await profileButton.click();
  await assertSurface(page);
  await assertWraps(page, devices[1].deviceName);
  if (keyboardOnly) await assertDialogKeyboard(page, '退出设备', '退出指定设备');
  else await assertDialogPointer(page, '退出设备', '退出指定设备');
  const roomListButton = page.getByRole('button', { name: '房间列表' });
  if (keyboardOnly) {
    await tabTo(page, roomListButton);
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('button', { name: '超管后台' }));
    await page.keyboard.press('Enter');
  } else {
    await roomListButton.click();
    await page.getByRole('button', { name: '超管后台' }).click();
  }
  await assertSurface(page);
  const dashboardTab = page.getByRole('tab', { name: '数据看板' });
  const accountTab = page.getByRole('tab', { name: '账号' });
  if (keyboardOnly) {
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await assertSurface(page);
    await tabTo(page, dashboardTab);
    await page.keyboard.press('Home');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(dashboardTab).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/\/admin\/accounts$/);
    await expect(accountTab).toHaveAttribute('aria-selected', 'true');
    await expect(accountTab).toBeFocused();
    await assertSurface(page);
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(dashboardTab).toBeFocused();
    await assertSurface(page);
    await page.keyboard.press('End');
    await expect(page).toHaveURL(/\/admin\/logs$/);
    const logsTab = page.getByRole('tab', { name: '安全日志' });
    await expect(logsTab).toBeFocused();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(/\/admin\/logs$/);
    await expect(logsTab).toBeFocused();
    await assertSurface(page);
    await page.keyboard.press('Home');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(dashboardTab).toBeFocused();
    await assertSurface(page);
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/\/admin\/accounts$/);
    await expect(accountTab).toBeFocused();
    await assertSurface(page);
    await assertWraps(page, longDisplayName);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  } else {
    if (zoomDesktop) {
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await assertSurface(page);
    }
    await accountTab.click();
    if (zoomDesktop) {
      await assertSurface(page);
      await assertWraps(page, longDisplayName);
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    }
  }
  await assertSurface(page);
  await assertWraps(page, longDisplayName);
});

test('lobby and room management show room lifecycle times', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await mockLobby(page);
  await page.route('**/api/admin/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/accounts' || path === '/api/admin/security-logs') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/rooms') return route.fulfill({ json: { items: [{
      id: 'admin-room-1', name: '寿康宫晨局', status: 'FINISHED', visibility: 'PUBLIC', creator: { id: 'account-2', displayName: '太后' }, memberCount: 3, playerCount: 3, hasBank: true, hasPassword: false,
      createdAt: '2026-07-28T00:00:00', startedAt: '2026-07-28T01:30:00', updatedAt: '2026-07-28T02:00:00', settlement: { id: 'settlement-1', endedAt: '2026-07-28T03:45:00', forced: false },
    }], nextCursor: null } });
    if (path === '/api/admin/dashboard') return route.fulfill({ json: { accounts: { total: 1, active: 1 }, sessions: { valid: 1 }, rooms: { lobby: 0, playing: 0, finished: 1 }, games: { settledTotal: 1, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [] } });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/rooms');
  await expect(page.getByText('钮祜禄·甄嬛兼银行', { exact: true })).toBeVisible();
  await expect(page.getByText('人物兼银行', { exact: true })).toHaveCount(0);
  await expect(page.getByText('创建时间：2026年07月29日 星期三 0:05')).toBeVisible();
  await expect(page.getByText('开始时间：未开始')).toBeVisible();
  await expect(page.getByText('结束时间：未结束')).toBeVisible();
  await expect(page.locator('.room-row .room-lifecycle')).toHaveCount(1);
  await expect(page.locator('.room-row .room-lifecycle > span')).toHaveCount(3);
  await page.getByRole('button', { name: '超管后台' }).click();
  await page.getByRole('tab', { name: '房间' }).click();
  await expect(page.getByText('创建时间：2026年07月28日 星期二 0:00')).toBeVisible();
  await expect(page.getByText('开始时间：2026年07月28日 星期二 1:30')).toBeVisible();
  await expect(page.getByText('结束时间：2026年07月28日 星期二 3:45')).toBeVisible();
  await expect(page.locator('.admin-row .room-lifecycle')).toHaveCount(1);
  await expect(page.locator('.admin-row .room-lifecycle > span')).toHaveCount(3);
  if (test.info().project.name === 'desktop-chromium') {
    await expect(page.locator('.admin-page > .v2-header .room-list-back')).toHaveCount(1);
  }
});

test('room admission badges render membership and lifecycle status independently', async ({ page }) => {
  const joinedLobby = room({ id: 'joined-lobby', name: '已加入的准备房间', status: 'LOBBY', mine: true });
  const joinedPlaying = room({ id: 'joined-playing', name: '已加入的对局', status: 'PLAYING', mine: true });
  const joinableLobby = room({ id: 'joinable-lobby', name: '可加入的准备房间', status: 'LOBBY', mine: false, characterId: null, myCharacter: null, isBank: false });
  const joinablePlaying = room({ id: 'joinable-playing', name: '可加入的对局', status: 'PLAYING', mine: false, characterId: null, myCharacter: null, isBank: false });
  const blockedDisabled = room({ id: 'blocked-disabled', name: '禁止中途加入房间', status: 'PLAYING', mine: false, canJoin: false, joinBlockedReason: 'MIDGAME_JOIN_DISABLED', characterId: null, myCharacter: null, isBank: false });
  const blockedFull = room({ id: 'blocked-full', name: '人数已满房间', status: 'PLAYING', mine: false, canJoin: false, joinBlockedReason: 'PLAYER_LIMIT', characterId: null, myCharacter: null, isBank: false });
  const finished = room({ id: 'finished', name: '已结束的对局', status: 'FINISHED', mine: true });

  await mockAuthenticated(page, [joinedLobby, joinedPlaying, joinableLobby, joinablePlaying, blockedDisabled, blockedFull, finished]);
  await page.goto('/rooms');

  for (const [name, badges] of [
    ['已加入的准备房间', ['已加入', '准备中']],
    ['已加入的对局', ['已加入', '游戏中']],
    ['可加入的准备房间', ['可加入', '准备中']],
    ['可加入的对局', ['可加入', '游戏中']],
    ['禁止中途加入房间', ['不可加入', '游戏中']],
    ['人数已满房间', ['不可加入', '游戏中']],
    ['已结束的对局', ['已结束']],
  ] as const) {
    const item = page.getByRole('button', { name: new RegExp(name) });
    await expect(item.locator('.room-status-badge')).toHaveText(badges);
  }

  await expect(page.locator('.room-status-joined').first()).toHaveCSS('background-color', 'rgb(36, 104, 72)');
  await expect(page.locator('.room-status-joinable').first()).toHaveCSS('background-color', 'rgb(54, 95, 113)');
  await expect(page.locator('.room-status-unavailable').first()).toHaveCSS('background-color', 'rgb(98, 105, 99)');
  await expect(page.locator('.room-status-unavailable').first()).toHaveCSS('border-radius', '6px');
  await expect(page.locator('.room-status-lobby').first()).toHaveCSS('background-color', 'rgb(184, 137, 47)');
  await expect(page.locator('.room-status-playing').first()).toHaveCSS('background-color', 'rgb(116, 31, 40)');
  await expect(page.locator('.room-status-ended')).toHaveCSS('background-color', 'rgb(98, 105, 99)');
  await assertSurface(page);
});

test('transaction starts with plot fine and retains its confirmation flow', async ({ page }) => {
  const requests: Array<{ method: string; body: unknown }> = [];
  await mockAuthenticated(page);
  await mockRoom(page);
  await page.route('**/api/rooms/room-1/events/plot-fine', async (route) => {
    requests.push({ method: route.request().method(), body: route.request().postDataJSON() });
    await route.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(longRoomName) }).click();
  await page.getByRole('button', { name: '银行端', exact: true }).click();
  await page.getByRole('button', { name: '事务', exact: true }).click();

  const transaction = page.locator('.transaction-page');
  await expect(transaction.locator('.section-title').first()).toHaveText(/剧情罚款/);
  await transaction.getByLabel('剧情罚款金额').fill('100');
  await transaction.getByRole('button', { name: '执行剧情罚款', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认剧情罚款' })).toBeVisible();
  await page.getByRole('dialog', { name: '确认剧情罚款' }).getByRole('button', { name: '确认罚款', exact: true }).click();
  await expect.poll(() => requests).toEqual([{ method: 'POST', body: { playerId: snapshot.players[0].id, amount: 100 } }]);
});

test('bank plot fine confirmation uses the selected player configured reduction', async ({ page }) => {
  const configuredSnapshot: BrowserSnapshot = {
    ...snapshot,
    players: snapshot.players.map((player) => player.id === 'player-2'
      ? { ...player, plotFineReduction: 275 }
      : player),
  };

  await mockAuthenticated(page);
  await mockRoom(page);
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: configuredSnapshot }));

  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(longRoomName) }).click();
  await page.getByRole('button', { name: '银行端', exact: true }).click();
  await page.getByRole('button', { name: '事务', exact: true }).click();
  await page.getByLabel('罚款玩家').selectOption('player-2');
  await page.getByLabel('剧情罚款金额').fill('500');
  await page.getByRole('button', { name: '执行剧情罚款', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '确认剧情罚款' });
  await expect(dialog.getByText('原始金额 500 两')).toBeVisible();
  await expect(dialog.getByText('沈眉庄减免 275 两')).toBeVisible();
  await expect(dialog.getByText('实际扣款 225 两')).toBeVisible();
});

test('seats, swap decision dialog, and displaced takeover remain contained', async ({ page }, testInfo) => {
  await mockAuthenticated(page);
  await mockRoom(page);
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(longRoomName) }).click();
  await page.getByRole('button', { name: '管理席位' }).click();
  await assertSurface(page);
  await assertWraps(page, pendingSwap.requesterDisplayName);
  if (testInfo.project.name.startsWith('desktop-')) {
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await assertSurface(page);
    await assertWraps(page, pendingSwap.requesterDisplayName);
  }
  if (testInfo.project.name === 'desktop-chromium') await assertDialogKeyboard(page, '拒绝交换', '拒绝角色交换');
  else await assertDialogPointer(page, '拒绝交换', '拒绝角色交换');
  if (testInfo.project.name.startsWith('desktop-')) await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

  await page.getByRole('button', { name: '房间列表' }).click();
  await page.unroute('**/api/rooms/room-1/seats');
  await mockRoom(page, dual, false, []);
  await page.getByRole('button', { name: new RegExp(longRoomName) }).click();
  await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();
  await assertSurface(page);
  await expect(page.getByText('余额')).toHaveCount(0);
});

test('workbench navigation uses a persistent left sidebar only on desktop', async ({ page }, testInfo) => {
  const desktop = testInfo.project.name.startsWith('desktop-');
  await mockAuthenticated(page);
  await mockRoom(page);

  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(longRoomName) }).click();
  const playerView = page.getByRole('button', { name: '玩家端', exact: true });
  await expect(playerView).toBeVisible();
  expect(await playerView.count()).toBe(1);
  await playerView.click();
  await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
  await assertSurface(page);
  if (desktop) {
    await assertDesktopWorkbenchSidebar(page);
    await assertPlayerWorkbenchHeader(page, longDisplayName);
  }
  await capture(page, testInfo, `${desktop ? 'desktop' : 'mobile'}-player-sidebar`);

  const bankView = page.getByRole('button', { name: '银行端', exact: true });
  await expect(bankView).toBeVisible();
  expect(await bankView.count()).toBe(1);
  await bankView.click();
  await expect(page.getByRole('heading', { name: '银行端', exact: true })).toBeVisible();
  await assertSurface(page);
  if (desktop) await assertDesktopWorkbenchSidebar(page);
  await capture(page, testInfo, `${desktop ? 'desktop' : 'mobile'}-bank-sidebar`);
});

test('player, bank, finish preview, and settlement survive zoom and orientation', async ({ page }, testInfo) => {
  await mockAuthenticated(page);
  await mockRoom(page);
  await page.route('**/api/rooms/room-1/settlement/preview', (route) => route.fulfill({ json: { blockers: [], players: ranked } }));
  const finishSequence: string[] = [];
  await page.route('**/api/rooms/room-1/finish', (route) => {
    finishSequence.push(`${route.request().method()} /finish`);
    return route.fulfill({ json: { created: true } });
  });
  await page.route('**/api/rooms/room-1/settlement', (route) => {
    finishSequence.push(`${route.request().method()} /settlement`);
    return route.fulfill({ json: settlement });
  });

  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(longRoomName) }).click();
  await page.getByRole('button', { name: '玩家端', exact: true }).click();
  await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
  await assertSurface(page);
  if (testInfo.project.name.startsWith('desktop-')) await assertDesktopWorkbenchSidebar(page);
  await capture(page, testInfo, 'player-workbench');
  const keyboardOnly = testInfo.project.name === 'desktop-chromium';
  const zoomDesktop = testInfo.project.name.startsWith('desktop-');
  const bankView = page.getByRole('button', { name: '银行端', exact: true });
  if (keyboardOnly) {
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await assertSurface(page);
    await assertDialogKeyboard(page, '声明落点', '声明实体落点');
    await tabTo(page, bankView);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '银行端', exact: true })).toBeVisible();
    await assertSurface(page);
    await tabTo(page, page.getByRole('button', { name: '玩家端', exact: true }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
    await assertSurface(page);
    await tabTo(page, page.getByRole('button', { name: '银行端', exact: true }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '银行端', exact: true })).toBeVisible();
    await assertSurface(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  } else {
    if (zoomDesktop) {
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await assertSurface(page);
    }
    await bankView.click();
    await assertSurface(page);
    if (zoomDesktop) await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  }
  if (testInfo.project.name.startsWith('desktop-')) await assertDesktopWorkbenchSidebar(page);
  await capture(page, testInfo, 'bank-workbench');

  if (['android-chromium', 'iphone-webkit', 'short-mobile-webkit'].includes(testInfo.project.name)) {
    const current = page.viewportSize()!;
    await page.setViewportSize({ width: current.height, height: current.width });
    await assertSurface(page);
  }

  const transactionTab = page.getByRole('button', { name: '事务', exact: true });
  if (keyboardOnly) {
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await tabTo(page, transactionTab);
    await page.keyboard.press('Enter');
    await assertSurface(page);
    await tabTo(page, page.getByRole('button', { name: '结束游戏', exact: true }));
    await page.keyboard.press('Enter');
  } else {
    if (zoomDesktop) await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await transactionTab.click();
    await page.getByRole('button', { name: '结束游戏', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '结束游戏' })).toBeVisible();
  await assertSurface(page);
  const confirmation = page.getByLabel('输入“确认结束游戏”');
  const confirmFinish = page.getByRole('button', { name: '确认结束游戏' });
  if (keyboardOnly) {
    await tabTo(page, confirmation);
    await page.keyboard.type('确认结束游戏');
    await tabTo(page, confirmFinish, { restart: false });
    await page.keyboard.press('Enter');
  } else {
    await confirmation.fill('确认结束游戏');
    await confirmFinish.click();
  }
  await expect(page.getByText('不可变结算快照')).toBeVisible();
  expect(finishSequence).toEqual([
    'POST /finish',
    'GET /settlement',
    'GET /settlement',
  ]);
  await assertSurface(page);
  const propertyDetails = page.getByText('地产结算明细（1）');
  if (keyboardOnly) {
    await tabTo(page, propertyDetails);
    await page.keyboard.press('Enter');
  } else await propertyDetails.click();
  await assertWraps(page, ranked[0].propertyDetails[0].nameSnapshot);
  if (zoomDesktop) {
    await assertSurface(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await assertSurface(page);
  }
  await capture(page, testInfo, 'settlement');
});
