import { expect, test, type Page, type Route } from '@playwright/test';
import type { BrowserRoomSummary, BrowserSeatSnapshot, BrowserSnapshot } from './browser-fixture-types';

test.describe.configure({ mode: 'serial' });

const account = { id: 'a1', username: 'zhenhuan', displayName: '甄嬛', isSuperAdmin: true, canCreateRoom: true, lastLoginAt: '2026-07-27T08:00:00.000Z' };
type RoomSummary = BrowserRoomSummary;
const room: RoomSummary = { id: 'r1', name: '碎玉轩夜局', status: 'LOBBY', creator: '甄嬛', memberCount: 1, playerCount: 1, playerLimit: 5, hasPassword: false, mine: true, characterId: null, myCharacter: null, isBank: false };
const snapshot: BrowserSnapshot = {
  id: 'r1', stateVersion: 1, code: 'SYX', name: room.name, status: 'PLAYING', diceMode: 'PHYSICAL', redemptionFee: 500, startReward: 1_000, currentPlayerId: 'p1', turn: null,
  players: [{ id: 'p1', name: '甄嬛', characterId: 'zhenhuan', balance: 5000, remainingSkipTurns: 0 }],
  properties: [], ledger: [], requests: [], landings: [], audit: [], reversalCandidate: null,
};
const seatFixture = <TRequest,>(fixture: Omit<BrowserSeatSnapshot<TRequest>, 'stateVersion'> & { stateVersion?: number }): BrowserSeatSnapshot<TRequest> => ({ stateVersion: 1, ...fixture });

async function body(route: Route) { return route.request().postDataJSON() as Record<string, unknown>; }

async function authenticated(page: Page, rooms: RoomSummary[] = [room]) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: rooms.filter((item) => item.mine && !['FINISHED', 'ENDED', 'CLOSED'].includes(item.status)) }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: rooms.filter((item) => item.mine && ['FINISHED', 'ENDED', 'CLOSED'].includes(item.status)) }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: rooms.filter((item) => !item.mine && !['FINISHED', 'ENDED', 'CLOSED'].includes(item.status)) }));
}

test('首页只显示海报和加入游戏组，不显示旧身份入口', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '甄嬛传', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '加入游戏组' })).toBeVisible();
  await expect(page.getByText('房间码', { exact: true })).toHaveCount(0);
  await expect(page.getByText('恢复上个身份', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '银行' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '超管' })).toHaveCount(0);
});

test('首页以宫廷纸本布局展示且加入游戏组仍进入登录页', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));
  await page.goto('/');

  await expect(page.getByTestId('landing-poster')).toBeVisible();
  await expect(page.getByRole('heading', { name: '甄嬛传', exact: true })).toBeVisible();
  await expect(page.getByText('大富翁', { exact: true })).toBeVisible();
  await expect(page.locator('.landing-lantern')).toHaveCount(2);
  await expect(page.locator('.landing-palace-mark')).toBeVisible();
  await expect(page.locator('.landing-dice')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);

  await page.getByRole('button', { name: '加入游戏组' }).click();
  await expect(page.getByLabel('用户名')).toBeVisible();

  for (const viewport of [{ width: 360, height: 800 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByTestId('landing-poster')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  }
});

test('账号登录后进入房间大厅，昵称来自账号', async ({ page }) => {
  let authenticated = false;
  await page.route('**/api/auth/me', (route) => route.fulfill(authenticated ? { json: { account, sessions: [] } } : { status: 401, json: { error: 'AUTH_REQUIRED' } }));
  let loginBody: Record<string, unknown> = {};
  await page.route('**/api/auth/login', async (route) => { loginBody = await body(route); authenticated = true; await route.fulfill({ json: { account } }); });
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [room] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  await page.getByRole('button', { name: '加入游戏组' }).click();
  await page.getByLabel('用户名').fill('zhenhuan');
  await page.getByLabel('密码').fill('StrongPassword42');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '甄嬛' })).toBeVisible();
  await expect(page.getByText('@zhenhuan')).toBeVisible();
  expect(loginBody).toEqual({ username: 'zhenhuan', password: 'StrongPassword42' });
});

test('退出账号需要确认后才结束当前会话', async ({ page }) => {
  await authenticated(page);
  let loggedOut = false;
  await page.route('**/api/auth/me', (route) => route.fulfill(loggedOut
    ? { status: 401, json: { error: 'AUTH_REQUIRED' } }
    : { json: { account, sessions: [] } }));
  let logoutRequests = 0;
  await page.route('**/api/auth/logout', async (route) => {
    logoutRequests += 1;
    loggedOut = true;
    await route.fulfill({ json: {} });
  });

  await page.goto('/rooms');
  await page.getByRole('button', { name: '退出', exact: true }).click();

  await expect(page.getByRole('dialog', { name: '确认退出账号' })).toBeVisible();
  expect(logoutRequests).toBe(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认退出账号' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '甄嬛' })).toBeVisible();
  expect(logoutRequests).toBe(0);

  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByRole('button', { name: '确认退出', exact: true }).click();
  await expect.poll(() => logoutRequests).toBe(1);
  await expect(page).toHaveURL('/login?next=%2Frooms');
});

test('登录页只有用户名、密码和登录操作', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));
  await page.goto('/');
  await page.getByRole('button', { name: '加入游戏组' }).click();
  const form = page.locator('form');
  await expect(form.getByLabel('用户名')).toBeVisible();
  await expect(form.getByLabel('密码')).toBeVisible();
  await expect(form.locator('input')).toHaveCount(2);
  await expect(form.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByLabel('设备名称')).toHaveCount(0);
});

test('第3台设备登录被阻止并显示替换最早设备', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));
  await page.route('**/api/auth/login', (route) => route.fulfill({ status: 409, json: { error: 'SESSION_LIMIT_REACHED', devices: [
    { id: 's1', deviceName: 'iPhone Chrome', browser: 'Chrome', operatingSystem: 'iOS', loginIp: '120.***.***.36', lastIp: '120.***.***.36', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), current: false },
    { id: 's2', deviceName: 'Mac Safari', browser: 'Safari', operatingSystem: 'macOS', loginIp: '10.***.***.8', lastIp: '10.***.***.8', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), current: false },
  ] } }));
  await page.goto('/'); await page.getByRole('button', { name: '加入游戏组' }).click();
  await page.getByLabel('用户名').fill('zhenhuan'); await page.getByLabel('密码').fill('StrongPassword42'); await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('当前账号已在2台设备登录。继续登录将退出最早登录的设备。')).toBeVisible();
  await expect(page.getByRole('button', { name: '退出最早登录设备并继续' })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消登录' })).toBeVisible();
});

test('已占用角色显示昵称且不可直接选择', async ({ page }) => {
  await authenticated(page);
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({ room: { id: 'r1', name: room.name, status: 'LOBBY', skillEnabled: true }, membership: { id: 'm1', characterId: null, playerId: null, isBank: false, activeHere: true }, characters: [
    { id: 'zhenhuan', name: '钮祜禄·甄嬛', skill: { companionCashReward: 777 }, initialProperty: '永寿宫', occupiedBy: '流朱', canSelect: false },
    { id: 'yixiu', name: '乌拉那拉·宜修', skill: { cashReward: 500 }, initialProperty: '景仁宫', occupiedBy: null, canSelect: true },
  ], bank: { occupiedBy: '苏培盛' }, roleSwapRequests: [] }) }));
  await page.goto('/'); await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  const occupied = page.getByRole('article').filter({ hasText: '钮祜禄·甄嬛' });
  await expect(occupied.getByText('已占用')).toBeVisible();
  await expect(occupied.getByText('伙伴卡 +777 两')).toBeVisible();
  await expect(occupied.getByText('当前玩家：流朱')).toBeVisible();
  await expect(occupied.getByRole('button', { name: '选择角色' })).toHaveCount(0);
  await expect(occupied.getByRole('button', { name: '申请交换' })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: '银行' }).getByText('当前银行：苏培盛')).toBeVisible();
});

test('人物席位以角色专属分隔线替代人物横幅', async ({ page }) => {
  await authenticated(page);
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({
    room: { id: 'r1', name: room.name, status: 'LOBBY', skillEnabled: true },
    membership: { id: 'm1', characterId: null, playerId: null, isBank: false, activeHere: true },
    characters: [
      { id: 'zhenhuan', name: '钮祜禄·甄嬛', skill: {}, initialProperty: '永寿宫', occupiedBy: null, canSelect: true },
      { id: 'yixiu', name: '乌拉那拉·宜修', skill: {}, initialProperty: '景仁宫', occupiedBy: null, canSelect: true },
      { id: 'huashifei', name: '年世兰', skill: {}, initialProperty: '翊坤宫', occupiedBy: null, canSelect: true },
      { id: 'meizhuang', name: '沈眉庄', skill: {}, initialProperty: '咸福宫', occupiedBy: null, canSelect: true },
      { id: 'anlingrong', name: '安陵容', skill: {}, initialProperty: '延禧宫', occupiedBy: null, canSelect: true },
    ],
    bank: { occupiedBy: null },
    roleSwapRequests: [],
  }) }));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '甄嬛' })).toBeVisible();
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();

  const cards = page.locator('.seat-card:not(.bank-seat)');
  await expect(cards.locator('.standee-crop')).toHaveCount(0);
  await expect(cards.locator('.character-divider')).toHaveCount(5);
  expect(await cards.locator('.character-divider').evaluateAll((dividers) => dividers.map((divider) => {
    const line = divider.getBoundingClientRect();
    const card = divider.parentElement!.getBoundingClientRect();
    return {
      color: getComputedStyle(divider).backgroundColor,
      height: line.height,
      leftInset: line.left - card.left,
      rightInset: card.right - line.right,
    };
  }))).toEqual([
    { color: 'rgb(231, 189, 63)', height: 8, leftInset: 1, rightInset: 1 },
    { color: 'rgb(111, 182, 220)', height: 8, leftInset: 1, rightInset: 1 },
    { color: 'rgb(180, 135, 212)', height: 8, leftInset: 1, rightInset: 1 },
    { color: 'rgb(217, 111, 147)', height: 8, leftInset: 1, rightInset: 1 },
    { color: 'rgb(113, 185, 121)', height: 8, leftInset: 1, rightInset: 1 },
  ]);
});

test('席位页使用真实 room.skillEnabled 停用人物技能', async ({ page }) => {
  await authenticated(page);
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({
    room: { id: 'r1', name: room.name, status: 'LOBBY', skillEnabled: false },
    membership: { id: 'm1', characterId: null, playerId: null, isBank: false, activeHere: true },
    characters: [{ id: 'zhenhuan', name: '钮祜禄·甄嬛', skill: { companionCashReward: 777 }, initialProperty: '永寿宫', occupiedBy: null, canSelect: true }],
    bank: { occupiedBy: null },
    roleSwapRequests: [],
  }) }));

  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();

  const character = page.getByRole('article').filter({ hasText: '钮祜禄·甄嬛' });
  await expect(character.getByText('人物技能已停用')).toBeVisible();
  await expect(character.getByText('伙伴卡 +777 两')).toHaveCount(0);
});

test('玩家端从快照展示并申请非默认 1,200 两起点奖励', async ({ page }) => {
  await authenticated(page, [{ ...room, status: 'PLAYING', characterId: 'zhenhuan', myCharacter: '钮祜禄·甄嬛' }]);
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({
    room: { id: 'r1', name: room.name, status: 'PLAYING', skillEnabled: true },
    membership: { id: 'm1', characterId: 'zhenhuan', playerId: 'p1', isBank: false, activeHere: true },
    characters: [], bank: { occupiedBy: null }, roleSwapRequests: [],
  }) }));
  let startLandingId = '';
  let rewardBody: Record<string, unknown> | null = null;
  await page.route('**/api/rooms/r1/snapshot*', (route) => route.fulfill({ json: {
    ...snapshot,
    startReward: 1_200,
    landings: startLandingId ? [{ id: startLandingId, playerId: 'p1', spaceType: 'START', status: 'CONFIRMED', plotResolved: true, propertyActionsCancelled: false }] : [],
  } }));
  await page.route('**/api/rooms/r1/landings/start', async (route) => {
    const request = await body(route);
    startLandingId = String(request.landingId);
    return route.fulfill({ json: { id: startLandingId } });
  });
  await page.route('**/api/rooms/r1/requests', async (route) => {
    rewardBody = await body(route);
    return route.fulfill({ json: { id: 'request-start-reward', amount: 1_200, status: 'PENDING' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '起点奖励' }).click();
  await expect(page.getByText('仅棋子精确停留起点可领取 1,200 两')).toBeVisible();
  await page.getByRole('button', { name: '声明停留起点' }).click();
  await page.getByRole('button', { name: '起点奖励' }).click();
  await page.getByRole('button', { name: '申请 1,200 两' }).click();

  await expect.poll(() => rewardBody).toEqual({ playerId: 'p1', type: 'START_REWARD', landingId: startLandingId });
  await expect(page.getByText('起点 1,200 两申请已提交银行审批')).toBeVisible();
});

test('人物持有者留在席位页并在同一成员关系上兼任银行', async ({ page }) => {
  await authenticated(page, [{ ...room, myCharacter: '钮祜禄·甄嬛' }]);
  let selectBankRequests = 0;
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({
    room: { id: 'r1', name: room.name, status: 'LOBBY', skillEnabled: true },
    membership: { id: 'm1', characterId: 'zhenhuan', playerId: 'p1', isBank: false, activeHere: true },
    characters: [{ id: 'zhenhuan', name: '钮祜禄·甄嬛', skill: { cashReward: 500 }, initialProperty: '永寿宫', occupiedBy: '甄嬛', canSelect: false }],
    bank: { occupiedBy: null },
    roleSwapRequests: [],
  }) }));
  await page.route('**/api/rooms/r1/select-bank', async (route) => {
    selectBankRequests += 1;
    expect(route.request().method()).toBe('POST');
    expect(await body(route)).toEqual({});
    await route.fulfill({ json: { membership: { id: 'm1', characterId: 'zhenhuan', playerId: 'p1', isBank: true, activeHere: true } } });
  });
  await page.route('**/api/rooms/r1/snapshot*', (route) => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '管理席位' }).click();
  const bank = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '银行', exact: true }) });
  const takeBank = bank.getByRole('button', { name: '兼任银行', exact: true });
  await expect(takeBank).toBeVisible();
  await takeBank.click();
  await expect.poll(() => selectBankRequests).toBe(1);
});

test('仅银行成员可选择首个人物且不丢失银行能力', async ({ page }) => {
  await authenticated(page, [{ ...room, playerCount: 0, isBank: true }]);
  let selectedCharacter: Record<string, unknown> = {};
  let hasCharacter = false;
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({
    room: { id: 'r1', name: room.name, status: 'LOBBY', skillEnabled: true },
    membership: { id: 'm1', characterId: hasCharacter ? 'yixiu' : null, playerId: hasCharacter ? 'p1' : null, isBank: true, activeHere: true },
    characters: [{ id: 'yixiu', name: '乌拉那拉·宜修', skill: { cashReward: 500 }, initialProperty: '景仁宫', occupiedBy: hasCharacter ? '甄嬛' : null, canSelect: !hasCharacter }],
    bank: { occupiedBy: '甄嬛' },
    roleSwapRequests: [],
  }) }));
  await page.route('**/api/rooms/r1/select-character', async (route) => {
    selectedCharacter = await body(route);
    hasCharacter = true;
    await route.fulfill({ json: { membership: { id: 'm1', characterId: 'yixiu', playerId: 'p1', isBank: true, activeHere: true } } });
  });
  await page.route('**/api/rooms/r1/snapshot*', (route) => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '管理席位' }).click();
  const character = page.getByRole('article').filter({ hasText: '乌拉那拉·宜修' });
  await character.getByRole('button', { name: '选择角色', exact: true }).click();
  await expect.poll(() => selectedCharacter).toEqual({ characterId: 'yixiu' });
  await expect(page.getByRole('heading', { name: '选择工作台' })).toBeVisible();
});

test('兼任成员可切换玩家端和银行端且快照请求显式携带视图', async ({ page }) => {
  await authenticated(page, [{ ...room, status: 'PLAYING', myCharacter: '钮祜禄·甄嬛', isBank: true }]);
  const snapshotViews: Array<string | null> = [];
  let releaseBankSnapshot!: () => void;
  const bankSnapshotPending = new Promise<void>((resolve) => { releaseBankSnapshot = resolve; });
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({
    room: { id: 'r1', name: room.name, status: 'PLAYING', skillEnabled: true },
    membership: { id: 'm1', characterId: 'zhenhuan', playerId: 'p1', isBank: true, activeHere: true },
    characters: [], bank: { occupiedBy: '甄嬛' }, roleSwapRequests: [],
  }) }));
  await page.route('**/api/rooms/r1/snapshot*', async (route) => {
    const view = new URL(route.request().url()).searchParams.get('view');
    snapshotViews.push(view);
    if (view === 'BANK') await bankSnapshotPending;
    return route.fulfill({ json: snapshot });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await expect(page.getByRole('heading', { name: '选择工作台' })).toBeVisible();
  await page.getByRole('button', { name: '玩家端', exact: true }).click();
  await expect.poll(() => snapshotViews).toEqual(['PLAYER']);
  const playerView = page.getByRole('button', { name: '玩家端', exact: true });
  const bankView = page.getByRole('button', { name: '银行端', exact: true });
  await expect(playerView).toBeVisible();
  await expect(bankView).toBeVisible();
  await bankView.click();
  await expect.poll(() => snapshotViews).toEqual(['PLAYER', 'BANK']);
  await expect(page).toHaveURL(/\/rooms\/r1\/bank$/);
  await expect(playerView).toHaveCount(0);
  await expect(bankView).toHaveCount(0);
  releaseBankSnapshot();
  await expect(page.getByRole('heading', { name: '银行端', exact: true })).toBeVisible();
  await expect(playerView).toBeEnabled();
  await expect(bankView).toBeEnabled();
  await playerView.click();
  await expect.poll(() => snapshotViews).toEqual(['PLAYER', 'BANK', 'PLAYER']);
});

for (const target of [
  { label: '玩家端', path: 'player' },
  { label: '银行端', path: 'bank' },
] as const) {
  test(`兼任成员选择${target.label}时遇到席位刷新仍进入所选端`, async ({ page }) => {
    await authenticated(page, [{ ...room, myCharacter: '安陵容', isBank: true }]);
    let seatReads = 0;
    let blockNextSeatRead = false;
    let navigationSeatReadBlocked = false;
    let releaseNavigationSeats!: () => void;
    const navigationSeatsPending = new Promise<void>((resolve) => { releaseNavigationSeats = resolve; });
    const dualLobbySeats = seatFixture({
      stateVersion: 4,
      room: { id: 'r1', name: room.name, status: 'LOBBY', skillEnabled: true },
      membership: { id: 'm1', characterId: 'anlingrong', playerId: 'p1', isBank: true, activeHere: true },
      characters: [], bank: { occupiedBy: '安陵容' }, roleSwapRequests: [],
    });
    await page.route('**/api/rooms/r1/seats', async (route) => {
      seatReads += 1;
      if (blockNextSeatRead) {
        blockNextSeatRead = false;
        navigationSeatReadBlocked = true;
        await navigationSeatsPending;
      }
      await route.fulfill({ json: dualLobbySeats });
    });
    await page.route('**/api/rooms/r1/snapshot*', (route) => route.fulfill({ json: {
      ...snapshot,
      stateVersion: 4,
      status: 'LOBBY',
      players: [{ ...snapshot.players[0], characterId: 'anlingrong', name: '安陵容' }],
    } }));

    await page.goto('/');
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect(page.getByRole('heading', { name: '选择工作台' })).toBeVisible();
    blockNextSeatRead = true;
    const readsBeforeNavigation = seatReads;
    await page.getByRole('button', { name: target.label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/rooms/r1/${target.path}$`));
    await expect.poll(() => navigationSeatReadBlocked).toBe(true);

    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => seatReads).toBeGreaterThanOrEqual(readsBeforeNavigation + 2);
    releaseNavigationSeats();

    await expect(page.getByRole('heading', { name: target.label, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/rooms/r1/${target.path}$`));
  });
}

test('stale PLAYER refresh cannot overwrite a later BANK snapshot', async ({ page }) => {
  await authenticated(page, [{ ...room, status: 'PLAYING', myCharacter: '钮祜禄·甄嬛', isBank: true }]);
  let playerReads = 0;
  let releaseStalePlayer!: () => void;
  const stalePlayerPending = new Promise<void>((resolve) => { releaseStalePlayer = resolve; });
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({
    room: { id: 'r1', name: room.name, status: 'PLAYING', skillEnabled: true },
    membership: { id: 'm1', characterId: 'zhenhuan', playerId: 'p1', isBank: true, activeHere: true },
    characters: [], bank: { occupiedBy: '甄嬛' }, roleSwapRequests: [],
  }) }));
  await page.route('**/api/rooms/r1/snapshot*', async (route) => {
    const view = new URL(route.request().url()).searchParams.get('view');
    if (view === 'PLAYER') {
      playerReads += 1;
      if (playerReads === 2) await stalePlayerPending;
      return route.fulfill({ json: { ...snapshot, name: playerReads === 1 ? '初始玩家快照' : '过期玩家快照' } });
    }
    return route.fulfill({ json: { ...snapshot, name: '最新银行快照' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '玩家端', exact: true }).click();
  await page.getByRole('button', { name: '刷新房间快照' }).click();
  await expect.poll(() => playerReads).toBe(2);
  await page.getByRole('button', { name: '银行端', exact: true }).click();
  await expect(page.getByText('最新银行快照', { exact: false })).toBeVisible();
  const staleResponse = page.waitForResponse((response) => response.url().includes('snapshot?view=PLAYER'));
  releaseStalePlayer();
  await staleResponse;
  await page.waitForTimeout(100);
  await expect(page.getByText('最新银行快照', { exact: false })).toBeVisible();
  await expect(page.getByText('过期玩家快照', { exact: false })).toHaveCount(0);
});

test('自己占用的人物不提供申请交换', async ({ page }) => {
  await authenticated(page, [{ ...room, myCharacter: '钮祜禄·甄嬛' }]);
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({
    room: { id: 'r1', name: room.name, status: 'LOBBY', skillEnabled: true },
    membership: { id: 'm1', characterId: 'zhenhuan', playerId: 'p1', isBank: false, activeHere: true },
    characters: [{ id: 'zhenhuan', name: '钮祜禄·甄嬛', skill: { cashReward: 500 }, initialProperty: '永寿宫', occupiedBy: '甄嬛', canSelect: false }],
    bank: { occupiedBy: null },
    roleSwapRequests: [],
  }) }));
  await page.route('**/api/rooms/r1/snapshot*', (route) => route.fulfill({ json: snapshot }));
  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '管理席位' }).click();
  const ownCharacter = page.getByRole('article').filter({ hasText: '钮祜禄·甄嬛' });
  await expect(ownCharacter.getByRole('button', { name: '申请交换', exact: true })).toHaveCount(0);
});

test('另一设备持有房间控制权时只显示接管页', async ({ page }) => {
  await authenticated(page, [{ ...room, status: 'PLAYING', myCharacter: '钮祜禄·甄嬛' }]);
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({ room: { id: 'r1', name: room.name, status: 'PLAYING', skillEnabled: true }, membership: { id: 'm1', characterId: 'zhenhuan', playerId: 'p1', isBank: false, activeHere: false }, characters: [], bank: { occupiedBy: '银行' }, roleSwapRequests: [] }) }));
  await page.goto('/'); await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();
  await expect(page.getByRole('button', { name: '接管本房间' })).toBeVisible();
  await expect(page.getByText('余额')).toHaveCount(0);
});

test('个人信息页显示设备和当前设备标记', async ({ page }) => {
  await authenticated(page);
  await page.route('**/api/auth/sessions', (route) => route.fulfill({ json: [{ id: 's1', deviceName: '小主的手机', browser: 'Safari', operatingSystem: 'iOS', loginIp: '120.***.***.36', lastIp: '120.***.***.36', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), current: true }] }));
  await page.goto('/'); await page.getByRole('button', { name: '个人信息' }).click();
  await expect(page.getByText('小主的手机')).toBeVisible();
  await expect(page.getByText('当前设备')).toBeVisible();
  await expect(page.getByText('120.***.***.36').first()).toBeVisible();
});

test('超管后台展示看板并创建账号', async ({ page }) => {
  await authenticated(page);
  await page.route('**/api/admin/accounts?*', (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route('**/api/admin/rooms?*', (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route('**/api/admin/security-logs?*', (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route('**/api/admin/dashboard', (route) => route.fulfill({ json: {
    accounts: { total: 1, active: 1 }, sessions: { valid: 1 }, rooms: { lobby: 0, playing: 0, finished: 0 },
    games: { settledTotal: 0, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [],
  } }));
  await page.goto('/'); await page.getByRole('button', { name: '超管后台' }).click();
  await expect(page.getByRole('heading', { name: '超级管理员' })).toBeVisible();
  await page.getByRole('tab', { name: '账号' }).click();
  await page.getByLabel('新用户名').fill('meizhuang'); await page.getByLabel('新用户昵称').fill('沈眉庄'); await page.getByLabel('初始密码').fill('StrongPassword42');
  await expect(page.getByRole('button', { name: '创建账号' })).toBeEnabled();
});

test('历史房间展示不可变结算明细', async ({ page }) => {
  const historyRoom: RoomSummary = { ...room, status: 'FINISHED', characterId: 'zhenhuan', myCharacter: '钮祜禄·甄嬛' };
  await authenticated(page, [historyRoom]);
  await page.route('**/api/rooms/r1/seats', (route) => route.fulfill({ json: seatFixture({ room: { id: 'r1', name: room.name, status: 'FINISHED', skillEnabled: true }, membership: { id: 'm1', characterId: 'zhenhuan', playerId: 'p1', isBank: false, activeHere: true }, characters: [], bank: { occupiedBy: '银行' }, roleSwapRequests: [] }) }));
  await page.route('**/api/rooms/r1/settlement', (route) => route.fulfill({ json: {
    id: 'st1', roomId: 'r1', endedByAccountId: 'a1', endedAt: '2026-07-27T08:00:00.000Z', totalTurns: 12, durationSeconds: 3600,
    forced: false, forceReason: null, winners: ['a1'], ranking: [{ accountId: 'a1', rank: 1 }], overriddenBlockers: [],
    players: [{ accountId: 'a1', displayNameSnapshot: '甄嬛', characterNameSnapshot: '钮祜禄·甄嬛', cash: 1000, unmortgagedPropertyValue: 3600, mortgagedPropertyNetValue: 1500, buildingSellValue: 1200, totalWealth: 7300, rank: 1, isWinner: true, propertyDetails: [] }],
  } }));
  await page.goto('/'); await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await expect(page.getByText('不可变结算快照')).toBeVisible();
  await expect(page.getByText('7,300 两')).toBeVisible();
  await expect(page.getByText('第 1 名 · 获胜')).toBeVisible();
});
