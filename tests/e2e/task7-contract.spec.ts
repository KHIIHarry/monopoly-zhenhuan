import { expect, test, type Page, type Route } from '@playwright/test';
import type { BrowserRoomStatus, BrowserRoomSummary, BrowserSeatSnapshot, BrowserSnapshot } from './browser-fixture-types';

const now = '2026-07-27T08:00:00.000Z';
const account = {
  id: 'account-1',
  username: 'zhenhuan',
  displayName: '甄嬛',
  isSuperAdmin: true,
  canCreateRoom: true,
  lastLoginAt: now,
};

type Capability = {
  characterId: string | null;
  playerId: string | null;
  isBank: boolean;
  activeHere: boolean;
};

const room = (overrides: Partial<BrowserRoomSummary> = {}): BrowserRoomSummary => ({
  id: 'room-1',
  name: '碎玉轩夜局',
  status: 'PLAYING',
  creator: '甄嬛',
  memberCount: 1,
  playerCount: 1,
  playerLimit: 5,
  hasPassword: false,
  mine: true,
  characterId: 'zhenhuan',
  myCharacter: '钮祜禄·甄嬛',
  isBank: false,
  ...overrides,
});

const gameSnapshot: BrowserSnapshot = {
  id: 'room-1',
  stateVersion: 1,
  code: 'SYX',
  name: '碎玉轩夜局',
  status: 'PLAYING',
  diceMode: 'PHYSICAL',
  redemptionFee: 500,
  startReward: 1_000,
  currentPlayerId: 'player-1',
  turn: null,
  players: [{ id: 'player-1', name: '甄嬛', characterId: 'zhenhuan', balance: 5_000, remainingSkipTurns: 0 }],
  properties: [],
  ledger: [],
  requests: [],
  landings: [],
  audit: [],
  reversalCandidate: null,
};

const seatResponse = (capability: Capability, status: BrowserRoomStatus = 'PLAYING'): BrowserSeatSnapshot => ({
  stateVersion: 1,
  room: { id: 'room-1', name: '碎玉轩夜局', status, skillEnabled: true },
  membership: { id: 'membership-1', ...capability },
  characters: [{
    id: 'zhenhuan',
    name: '钮祜禄·甄嬛',
    skill: { companionCashReward: 500 },
    initialProperty: '永寿宫',
    occupiedBy: capability.characterId ? '甄嬛' : null,
    canSelect: capability.characterId === null,
  }],
  bank: { occupiedBy: capability.isBank ? '甄嬛' : null },
  roleSwapRequests: [],
});

async function postBody(route: Route) {
  return route.request().postDataJSON() as Record<string, unknown>;
}

async function mockAccount(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
}

async function mockLobby(page: Page, mine = [room()], joinable: unknown[] = [], history: unknown[] = []) {
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: mine }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: history }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [...mine, ...joinable, ...history] }));
}

async function openRoom(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
}

test('login and replacement use the exact Cookie-only two-field contract', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));
  const loginBodies: Record<string, unknown>[] = [];
  const authHeaders: Array<string | undefined> = [];
  await page.route('**/api/auth/login', async (route) => {
    loginBodies.push(await postBody(route));
    authHeaders.push(route.request().headers().authorization);
    await route.fulfill({ status: 409, json: { error: 'SESSION_LIMIT_REACHED', devices: [
      { id: 'session-1', deviceName: 'iPhone Safari', browser: 'Safari', operatingSystem: 'iOS', loginIp: '120.***.***.36', lastIp: '120.***.***.36', createdAt: now, lastActiveAt: now, current: false },
      { id: 'session-2', deviceName: 'Mac Chrome', browser: 'Chrome', operatingSystem: 'macOS', loginIp: '10.***.***.8', lastIp: '10.***.***.8', createdAt: now, lastActiveAt: now, current: false },
    ] } });
  });
  await page.route('**/api/auth/login/replace-oldest-session', async (route) => {
    loginBodies.push(await postBody(route));
    authHeaders.push(route.request().headers().authorization);
    await route.fulfill({ json: { account } });
  });
  await page.route('**/api/auth/logout', (route) => route.fulfill({ json: { ok: true } }));
  await mockLobby(page, []);

  await page.goto('/');
  await page.getByRole('button', { name: '加入游戏组' }).click();
  await page.getByLabel('用户名').fill('zhenhuan');
  await page.getByLabel('密码').fill('StrongPassword42');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '退出最早登录设备并继续' }).click();

  expect(loginBodies).toEqual([
    { username: 'zhenhuan', password: 'StrongPassword42' },
    { username: 'zhenhuan', password: 'StrongPassword42' },
  ]);
  expect(authHeaders).toEqual([undefined, undefined]);
  expect(await page.evaluate(() => [...Object.entries(localStorage), ...Object.entries(sessionStorage)].filter(([key, value]) => /auth|token|identity|membership|playerId|roomId/i.test(`${key}:${value}`)))).toEqual([]);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByRole('button', { name: '加入游戏组' }).click();
  await expect(page.getByLabel('密码')).toHaveValue('');
});

test('password join errors are announced', async ({ page }) => {
  const joinable = room({ mine: false, hasPassword: true, characterId: null, myCharacter: null, isBank: false });
  await mockAccount(page);
  await mockLobby(page, [], [joinable]);
  await page.route('**/api/rooms/room-1/join', (route) => route.fulfill({ status: 403, json: { error: 'ROOM_PASSWORD_INVALID' } }));
  await openRoom(page);
  await page.getByLabel('房间密码').fill('wrong-password');
  await page.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect(page.locator('p[role="alert"]')).toContainText('房间密码');
});

for (const scenario of [
  { name: 'player-only', capability: { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }, expectedView: 'PLAYER', heading: '玩家端' },
  { name: 'bank-only', capability: { characterId: null, playerId: null, isBank: true, activeHere: true }, expectedView: 'BANK', heading: '银行端' },
] as const) {
  test(`${scenario.name} recovery routes from fresh seats to its only workbench`, async ({ page }) => {
    await mockAccount(page);
    await mockLobby(page, [room({ characterId: scenario.capability.characterId, myCharacter: scenario.capability.characterId ? '钮祜禄·甄嬛' : null, isBank: scenario.capability.isBank })]);
    await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(scenario.capability) }));
    const views: Array<string | null> = [];
    await page.route('**/api/rooms/room-1/snapshot*', (route) => {
      views.push(new URL(route.request().url()).searchParams.get('view'));
      return route.fulfill({ json: gameSnapshot });
    });

    await openRoom(page);
    await expect(page.getByRole('heading', { name: scenario.heading, exact: true })).toBeVisible();
    expect(views).toEqual([scenario.expectedView]);
  });
}

test('dual recovery requires explicit selection and switching is view-only', async ({ page }) => {
  await mockAccount(page);
  await mockLobby(page, [room({ isBank: true })]);
  const dual = { characterId: 'zhenhuan', playerId: 'player-1', isBank: true, activeHere: true };
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(dual) }));
  const snapshotViews: Array<string | null> = [];
  const mutations: string[] = [];
  await page.route('**/api/rooms/room-1/snapshot*', (route) => {
    snapshotViews.push(new URL(route.request().url()).searchParams.get('view'));
    return route.fulfill({ json: gameSnapshot });
  });
  for (const endpoint of ['join', 'select-character', 'select-bank', 'take-control']) {
    await page.route(`**/api/rooms/room-1/${endpoint}`, (route) => {
      mutations.push(endpoint);
      return route.fulfill({ json: {} });
    });
  }

  await openRoom(page);
  await expect(page.getByRole('heading', { name: '选择工作台' })).toBeVisible();
  await page.getByRole('button', { name: '玩家端', exact: true }).click();
  await page.getByRole('button', { name: '银行端', exact: true }).click();
  await page.getByRole('button', { name: '玩家端', exact: true }).click();

  expect(snapshotViews).toEqual(['PLAYER', 'BANK', 'PLAYER']);
  expect(mutations).toEqual([]);
});

test('unseated and displaced memberships route before any snapshot read', async ({ page }) => {
  await mockAccount(page);
  await mockLobby(page);
  let activeHere = false;
  let snapshots = 0;
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse({ characterId: null, playerId: null, isBank: false, activeHere }) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => { snapshots += 1; return route.fulfill({ json: gameSnapshot }); });
  await page.route('**/api/rooms/room-1/take-control', async (route) => {
    expect(route.request().postData()).toBeNull();
    activeHere = true;
    return route.fulfill({ json: { membership: { id: 'membership-1', characterId: null, playerId: null, isBank: false, activeHere: true } } });
  });

  await openRoom(page);
  await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();
  await expect(page.getByText('余额')).toHaveCount(0);
  await page.getByRole('button', { name: '接管本房间' }).click();
  await expect(page.getByRole('heading', { name: '选择席位' })).toBeVisible();
  expect(snapshots).toBe(0);
});

test('capability acquisition in either order preserves membership and Player identity', async ({ page }) => {
  await mockAccount(page);
  await mockLobby(page, [room({ status: 'LOBBY' })]);
  let capability: Capability = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(capability, 'LOBBY') }));
  await page.route('**/api/rooms/room-1/select-bank', async (route) => {
    expect(await postBody(route)).toEqual({});
    capability = { ...capability, isBank: true };
    return route.fulfill({ json: { membership: { id: 'membership-1', ...capability } } });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: gameSnapshot }));

  await openRoom(page);
  await page.getByRole('button', { name: '管理席位' }).click();
  await page.getByRole('button', { name: '兼任银行' }).click();
  await expect(page.getByRole('heading', { name: '选择工作台' })).toBeVisible();
  expect(capability).toEqual({ characterId: 'zhenhuan', playerId: 'player-1', isBank: true, activeHere: true });
});

test('ENDED and CLOSED rooms are history and finished recovery reads settlement directly', async ({ page }) => {
  await mockAccount(page);
  const history = [room({ id: 'ended', name: '旧版结局', status: 'ENDED' }), room({ id: 'closed', name: '封存对局', status: 'CLOSED' }), room({ status: 'FINISHED' })];
  await mockLobby(page, [], [], history);
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }, 'FINISHED') }));
  await page.route('**/api/rooms/room-1/settlement', (route) => route.fulfill({ json: {
    id: 'settlement-1', roomId: 'room-1', endedByAccountId: 'account-1', endedAt: now, totalTurns: 8, durationSeconds: 3600, forced: false, forceReason: null,
    winners: ['account-1'], ranking: [{ accountId: 'account-1', rank: 1 }], overriddenBlockers: [],
    players: [{ accountId: 'account-1', displayNameSnapshot: '甄嬛', characterNameSnapshot: '钮祜禄·甄嬛', cash: 1_000, unmortgagedPropertyValue: 3_600, mortgagedPropertyNetValue: 1_500, buildingSellValue: 1_200, totalWealth: 7_300, rank: 1, isWinner: true, propertyDetails: [] }],
  } }));

  await page.goto('/');
  const historySection = page.getByRole('region', { name: '历史对局' });
  await expect(historySection.getByText('旧版结局')).toBeVisible();
  await expect(historySection.getByText('封存对局')).toBeVisible();
  await historySection.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await expect(page.getByText('不可变结算快照')).toBeVisible();
});

test('a delayed seats response from room A cannot replace a later room B selection', async ({ page }) => {
  const roomA = room({ id: 'room-a', name: '延迟的碎玉轩', status: 'LOBBY', characterId: null, myCharacter: null });
  const roomB = room({ id: 'room-b', name: '最新的翊坤宫', status: 'LOBBY', characterId: null, myCharacter: null });
  await mockAccount(page);
  await mockLobby(page, [roomA, roomB]);

  let releaseRoomA!: () => void;
  const roomAWait = new Promise<void>((resolve) => { releaseRoomA = resolve; });
  let roomAReads = 0;
  let roomBReads = 0;
  await page.route('**/api/rooms/room-a/seats', async (route) => {
    roomAReads += 1;
    await roomAWait;
    return route.fulfill({ json: {
      ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
      room: { id: 'room-a', name: roomA.name, status: 'LOBBY', skillEnabled: true },
    } });
  });
  await page.route('**/api/rooms/room-b/seats', (route) => {
    roomBReads += 1;
    return route.fulfill({ json: {
      ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
      room: { id: 'room-b', name: roomB.name, status: 'LOBBY', skillEnabled: true },
    } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /延迟的碎玉轩/ }).click();
  await expect.poll(() => roomAReads).toBe(1);
  await page.getByRole('button', { name: /最新的翊坤宫/ }).click();
  releaseRoomA();

  await expect(page.getByRole('heading', { name: '选择席位' })).toBeVisible();
  await expect(page.getByText('最新的翊坤宫', { exact: true })).toBeVisible();
  expect(roomBReads).toBe(1);
});

test('a stale room transition still applies global session invalidation', async ({ page }) => {
  const roomA = room({ id: 'room-a', name: '会话过期的碎玉轩', status: 'LOBBY', characterId: null, myCharacter: null });
  const roomB = room({ id: 'room-b', name: '稍后打开的翊坤宫', status: 'LOBBY', characterId: null, myCharacter: null });
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [roomA, roomB]);

  let releaseRoomA!: () => void;
  const roomAWait = new Promise<void>((resolve) => { releaseRoomA = resolve; });
  let roomAReads = 0;
  await page.route('**/api/rooms/room-a/seats', async (route) => {
    roomAReads += 1;
    await roomAWait;
    return route.fulfill({ status: 401, json: { error: 'SESSION_INVALID' } });
  });
  await page.route('**/api/rooms/room-b/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
    room: { id: roomB.id, name: roomB.name, status: 'LOBBY', skillEnabled: true },
  } }));

  await page.goto('/');
  await page.getByRole('button', { name: /会话过期的碎玉轩/ }).click();
  await expect.poll(() => roomAReads).toBe(1);
  await page.getByRole('button', { name: /稍后打开的翊坤宫/ }).click();
  await expect(page.getByText('稍后打开的翊坤宫', { exact: true })).toBeVisible();

  releaseRoomA();

  await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
  await expect(page.getByText('登录已失效，请重新登录')).toBeVisible();
});

test('a delayed settlement response cannot replace a later room selection', async ({ page }) => {
  const finished = room({ id: 'room-finished', name: '已结束的圆明园', status: 'FINISHED' });
  const current = room({ id: 'room-current', name: '当前的碎玉轩', status: 'LOBBY', characterId: null, myCharacter: null });
  await mockAccount(page);
  await mockLobby(page, [current], [], [finished]);
  await page.route('**/api/rooms/room-finished/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }, 'FINISHED'),
    room: { id: 'room-finished', name: finished.name, status: 'FINISHED', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-current/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
    room: { id: 'room-current', name: current.name, status: 'LOBBY', skillEnabled: true },
  } }));

  let settlementReads = 0;
  let releaseSettlement!: () => void;
  const settlementWait = new Promise<void>((resolve) => { releaseSettlement = resolve; });
  await page.route('**/api/rooms/room-finished/settlement', async (route) => {
    settlementReads += 1;
    await settlementWait;
    return route.fulfill({ json: {
      id: 'settlement-old', roomId: 'room-finished', endedByAccountId: 'account-1', endedAt: now, totalTurns: 8, durationSeconds: 3600, forced: false, forceReason: null,
      winners: ['account-1'], ranking: [{ accountId: 'account-1', rank: 1 }], overriddenBlockers: [],
      players: [{ accountId: 'account-1', displayNameSnapshot: '甄嬛', characterNameSnapshot: '钮祜禄·甄嬛', cash: 1_000, unmortgagedPropertyValue: 0, mortgagedPropertyNetValue: 0, buildingSellValue: 0, totalWealth: 1_000, rank: 1, isWinner: true, propertyDetails: [] }],
    } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /已结束的圆明园/ }).click();
  await expect.poll(() => settlementReads).toBe(1);
  await page.getByRole('button', { name: /当前的碎玉轩/ }).click();
  releaseSettlement();

  await expect(page.getByRole('heading', { name: '选择席位' })).toBeVisible();
  await expect(page.getByText('当前的碎玉轩', { exact: true })).toBeVisible();
  await expect(page.getByText('不可变结算快照')).toHaveCount(0);
});

test('manual seats refresh routes displaced control through the authoritative router', async ({ page }) => {
  await mockAccount(page);
  await mockLobby(page, [room({ status: 'LOBBY', characterId: null, myCharacter: null })]);
  let activeHere = true;
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse({ characterId: null, playerId: null, isBank: false, activeHere }, 'LOBBY') }));

  await openRoom(page);
  await expect(page.getByRole('heading', { name: '选择席位' })).toBeVisible();
  activeHere = false;
  await page.getByRole('button', { name: '刷新页面' }).first().click();

  await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();
});

test('manage seats refresh routes a newly finished room to settlement', async ({ page }) => {
  await mockAccount(page);
  await mockLobby(page);
  let status: 'PLAYING' | 'FINISHED' = 'PLAYING';
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }, status) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: gameSnapshot }));
  await page.route('**/api/rooms/room-1/settlement', (route) => route.fulfill({ json: {
    id: 'settlement-new', roomId: 'room-1', endedByAccountId: 'account-1', endedAt: now, totalTurns: 8, durationSeconds: 3600, forced: false, forceReason: null,
    winners: ['account-1'], ranking: [{ accountId: 'account-1', rank: 1 }], overriddenBlockers: [],
    players: [{ accountId: 'account-1', displayNameSnapshot: '甄嬛', characterNameSnapshot: '钮祜禄·甄嬛', cash: 1_000, unmortgagedPropertyValue: 0, mortgagedPropertyNetValue: 0, buildingSellValue: 0, totalWealth: 1_000, rank: 1, isWinner: true, propertyDetails: [] }],
  } }));

  await openRoom(page);
  await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
  status = 'FINISHED';
  await page.getByRole('button', { name: '管理席位' }).click();

  await expect(page.getByText('不可变结算快照')).toBeVisible();
});

test('a delayed room A seat mutation cannot supersede later room B navigation', async ({ page }) => {
  const roomA = room({ id: 'room-a', name: '延迟选席的碎玉轩', status: 'LOBBY', characterId: null, myCharacter: null, playerCount: 0 });
  const roomB = room({ id: 'room-b', name: '后来打开的翊坤宫', status: 'LOBBY', characterId: null, myCharacter: null, playerCount: 0 });
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [roomA, roomB]);

  let releaseSelection!: () => void;
  const selectionWait = new Promise<void>((resolve) => { releaseSelection = resolve; });
  let selectionWrites = 0;
  let roomASeatReads = 0;
  const selectionKeys: Array<string | undefined> = [];
  await page.route('**/api/rooms/room-a/seats', (route) => {
    roomASeatReads += 1;
    return route.fulfill({ json: {
      ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
      room: { id: 'room-a', name: roomA.name, status: 'LOBBY', skillEnabled: true },
    } });
  });
  await page.route('**/api/rooms/room-b/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
    room: { id: 'room-b', name: roomB.name, status: 'LOBBY', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-a/select-character', async (route) => {
    selectionWrites += 1;
    selectionKeys.push(route.request().headers()['idempotency-key']);
    await selectionWait;
    return route.fulfill({ json: { membership: { id: 'membership-1', characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }, player: { id: 'player-1' } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /延迟选席的碎玉轩/ }).click();
  await page.getByRole('button', { name: '选择角色' }).click();
  await expect.poll(() => selectionWrites).toBe(1);
  await page.getByRole('button', { name: '房间列表' }).click();
  await page.getByRole('button', { name: /后来打开的翊坤宫/ }).click();
  await expect(page.getByText('后来打开的翊坤宫', { exact: true })).toBeVisible();

  releaseSelection();
  await page.waitForLoadState('networkidle');

  expect(roomASeatReads).toBe(1);
  await expect(page.getByText('后来打开的翊坤宫', { exact: true })).toBeVisible();
  await expect(page.getByText('延迟选席的碎玉轩', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '房间列表' }).click();
  await page.getByRole('button', { name: /延迟选席的碎玉轩/ }).click();
  await page.getByRole('button', { name: '选择角色' }).click();
  await expect.poll(() => selectionWrites).toBe(2);
  expect(selectionKeys[0]).toBeTruthy();
  expect(selectionKeys[1]).toBe(selectionKeys[0]);
});

test('stale room A control loss cannot recover or report inside room B', async ({ page }) => {
  const roomA = room({ id: 'room-a', name: '失去控制的碎玉轩', status: 'LOBBY', characterId: null, myCharacter: null, playerCount: 0 });
  const roomB = room({ id: 'room-b', name: '当前控制的翊坤宫', status: 'LOBBY', characterId: null, myCharacter: null, playerCount: 0 });
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [roomA, roomB]);

  let releaseSelection!: () => void;
  const selectionWait = new Promise<void>((resolve) => { releaseSelection = resolve; });
  let selectionWrites = 0;
  let roomBSeatReads = 0;
  await page.route('**/api/rooms/room-a/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
    room: { id: roomA.id, name: roomA.name, status: 'LOBBY', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-b/seats', (route) => {
    roomBSeatReads += 1;
    return route.fulfill({ json: {
      ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
      room: { id: roomB.id, name: roomB.name, status: 'LOBBY', skillEnabled: true },
    } });
  });
  await page.route('**/api/rooms/room-a/select-character', async (route) => {
    selectionWrites += 1;
    await selectionWait;
    return route.fulfill({ status: 409, json: { error: 'ROOM_CONTROL_LOST' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /失去控制的碎玉轩/ }).click();
  await page.getByRole('button', { name: '选择角色' }).click();
  await expect.poll(() => selectionWrites).toBe(1);
  await page.getByRole('button', { name: '房间列表' }).click();
  await page.getByRole('button', { name: /当前控制的翊坤宫/ }).click();
  await expect(page.getByText('当前控制的翊坤宫', { exact: true })).toBeVisible();

  releaseSelection();
  await page.waitForLoadState('networkidle');

  await expect(page.getByText('当前控制的翊坤宫', { exact: true })).toBeVisible();
  await expect(page.getByText('该房间已在另一台设备打开')).toHaveCount(0);
  expect(roomBSeatReads).toBe(1);
});

test('a delayed finish preview cannot reopen after confirmed room exit', async ({ page }) => {
  const bankRoom = room({ id: 'room-bank', name: '延迟结算的景仁宫', status: 'PLAYING', characterId: null, myCharacter: null, isBank: true, playerCount: 0 });
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [bankRoom]);
  await page.route('**/api/rooms/room-bank/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: null, playerId: null, isBank: true, activeHere: true }),
    room: { id: 'room-bank', name: bankRoom.name, status: 'PLAYING', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-bank/snapshot*', (route) => route.fulfill({ json: {
    ...gameSnapshot,
    id: 'room-bank',
    name: bankRoom.name,
    startReward: 1_000,
    currentPlayerId: undefined,
    players: [],
  } }));

  let releasePreview!: () => void;
  const previewWait = new Promise<void>((resolve) => { releasePreview = resolve; });
  let previewReads = 0;
  await page.route('**/api/rooms/room-bank/settlement/preview', async (route) => {
    previewReads += 1;
    await previewWait;
    return route.fulfill({ json: { blockers: [], players: [] } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /延迟结算的景仁宫/ }).click();
  await expect(page.getByRole('heading', { name: '银行端', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '事务' }).click();
  await page.getByRole('button', { name: '结束游戏' }).click();
  await expect.poll(() => previewReads).toBe(1);
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('button', { name: '确认返回' }).click();
  await expect(page.getByText('当前账号')).toBeVisible();

  releasePreview();
  await page.waitForLoadState('networkidle');

  await expect(page.getByText('当前账号')).toBeVisible();
  await expect(page.getByRole('heading', { name: '结束游戏' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '创建房间' })).toBeEnabled();
});

test('a delayed room A game action cannot refresh over later room B navigation', async ({ page }) => {
  const roomA = room({ id: 'room-a', name: '先前的碎玉轩', status: 'PLAYING' });
  const roomB = room({ id: 'room-b', name: '当前的翊坤宫', status: 'PLAYING' });
  const capability = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
  const secondPlayer = { id: 'player-2', name: '眉庄', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0 };
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [roomA, roomB]);
  await page.route('**/api/rooms/room-a/seats', (route) => route.fulfill({ json: {
    ...seatResponse(capability),
    room: { id: roomA.id, name: roomA.name, status: 'PLAYING', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-b/seats', (route) => route.fulfill({ json: {
    ...seatResponse(capability),
    room: { id: roomB.id, name: roomB.name, status: 'PLAYING', skillEnabled: true },
  } }));
  let roomASnapshotReads = 0;
  await page.route('**/api/rooms/room-a/snapshot*', (route) => {
    roomASnapshotReads += 1;
    return route.fulfill({ json: {
      ...gameSnapshot,
      id: roomA.id,
      name: roomASnapshotReads === 1 ? '房间 A 初始快照' : '房间 A 过期快照',
      players: [...gameSnapshot.players, secondPlayer],
    } });
  });
  await page.route('**/api/rooms/room-b/snapshot*', (route) => route.fulfill({ json: {
    ...gameSnapshot,
    id: roomB.id,
    name: '房间 B 最新快照',
    players: [...gameSnapshot.players, secondPlayer],
  } }));
  let releaseTransfer!: () => void;
  const transferWait = new Promise<void>((resolve) => { releaseTransfer = resolve; });
  let transferWrites = 0;
  const transferKeys: Array<string | undefined> = [];
  await page.route('**/api/rooms/room-a/transfers', async (route) => {
    transferWrites += 1;
    transferKeys.push(route.request().headers()['idempotency-key']);
    await transferWait;
    return route.fulfill({ json: { id: 'transfer-a' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /先前的碎玉轩/ }).click();
  await expect(page.getByText('房间 A 初始快照')).toBeVisible();
  await page.getByRole('button', { name: '转帐' }).click();
  await page.getByLabel('转帐金额').fill('100');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferWrites).toBe(1);
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('button', { name: '确认返回' }).click();
  await page.getByRole('button', { name: /当前的翊坤宫/ }).click();
  await expect(page.getByText('房间 B 最新快照')).toBeVisible();

  releaseTransfer();
  await page.waitForTimeout(300);

  await expect(page.getByText('房间 B 最新快照')).toBeVisible();
  await expect(page.getByText('房间 A 过期快照')).toHaveCount(0);

  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('button', { name: '确认返回' }).click();
  await page.getByRole('button', { name: /先前的碎玉轩/ }).click();
  await page.getByRole('button', { name: '转帐' }).click();
  await page.getByLabel('转帐金额').fill('100');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferWrites).toBe(2);
  await page.getByRole('button', { name: '转帐' }).click();
  await page.getByLabel('转帐金额').fill('100');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferWrites).toBe(3);

  expect(transferKeys[0]).toBeTruthy();
  expect(transferKeys[1]).toBe(transferKeys[0]);
  expect(transferKeys[2]).toBeTruthy();
  expect(transferKeys[2]).not.toBe(transferKeys[1]);
});

test('a delayed room A game action error cannot surface in later room B', async ({ page }) => {
  const roomA = room({ id: 'room-a', name: '先前的碎玉轩', status: 'PLAYING' });
  const roomB = room({ id: 'room-b', name: '当前的翊坤宫', status: 'PLAYING' });
  const capability = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
  const secondPlayer = { id: 'player-2', name: '眉庄', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0 };
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [roomA, roomB]);
  await page.route('**/api/rooms/room-a/seats', (route) => route.fulfill({ json: {
    ...seatResponse(capability),
    room: { id: roomA.id, name: roomA.name, status: 'PLAYING', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-b/seats', (route) => route.fulfill({ json: {
    ...seatResponse(capability),
    room: { id: roomB.id, name: roomB.name, status: 'PLAYING', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-a/snapshot*', (route) => route.fulfill({ json: {
    ...gameSnapshot,
    id: roomA.id,
    name: '房间 A 初始快照',
    players: [...gameSnapshot.players, secondPlayer],
  } }));
  await page.route('**/api/rooms/room-b/snapshot*', (route) => route.fulfill({ json: {
    ...gameSnapshot,
    id: roomB.id,
    name: '房间 B 最新快照',
    players: [...gameSnapshot.players, secondPlayer],
  } }));
  let releaseTransfer!: () => void;
  const transferWait = new Promise<void>((resolve) => { releaseTransfer = resolve; });
  let transferWrites = 0;
  await page.route('**/api/rooms/room-a/transfers', async (route) => {
    transferWrites += 1;
    await transferWait;
    return route.fulfill({ status: 409, json: { error: 'INVALID_TRANSFER' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /先前的碎玉轩/ }).click();
  await expect(page.getByText('房间 A 初始快照')).toBeVisible();
  await page.getByRole('button', { name: '转帐' }).click();
  await page.getByLabel('转帐金额').fill('100');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferWrites).toBe(1);
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('button', { name: '确认返回' }).click();
  await page.getByRole('button', { name: /当前的翊坤宫/ }).click();
  await expect(page.getByText('房间 B 最新快照')).toBeVisible();

  releaseTransfer();
  await page.waitForTimeout(300);

  await expect(page.getByText('房间 B 最新快照')).toBeVisible();
  await expect(page.getByText('转帐信息无效，请检查收款对象和金额')).toHaveCount(0);
});

test('game action keeps its intent key until the authoritative snapshot refresh succeeds', async ({ page }) => {
  const capability = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
  const secondPlayer = { id: 'player-2', name: '眉庄', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0 };
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page);
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(capability) }));
  let snapshotReads = 0;
  let refreshFailures = 0;
  let transferWrites = 0;
  const transferKeys: Array<string | undefined> = [];
  await page.route('**/api/rooms/room-1/snapshot*', (route) => {
    snapshotReads += 1;
    if (transferWrites > 0 && refreshFailures === 0) {
      refreshFailures += 1;
      return route.abort('connectionreset');
    }
    return route.fulfill({ json: { ...gameSnapshot, players: [...gameSnapshot.players, secondPlayer] } });
  });
  await page.route('**/api/rooms/room-1/transfers', (route) => {
    transferWrites += 1;
    transferKeys.push(route.request().headers()['idempotency-key']);
    return route.fulfill({ json: { id: `transfer-${transferWrites}` } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '转帐' }).click();
  await page.getByLabel('转帐金额').fill('100');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => refreshFailures).toBe(1);
  await expect(page.getByRole('heading', { name: '转帐' })).toBeVisible();

  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferWrites).toBe(2);
  await expect(page.getByRole('heading', { name: '转帐' })).toHaveCount(0);
  await page.getByRole('button', { name: '转帐' }).click();
  await page.getByLabel('转帐金额').fill('100');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferWrites).toBe(3);

  expect(snapshotReads).toBe(4);
  expect(transferKeys[0]).toBeTruthy();
  expect(transferKeys[1]).toBe(transferKeys[0]);
  expect(transferKeys[2]).toBeTruthy();
  expect(transferKeys[2]).not.toBe(transferKeys[1]);
});

test('unified transfer renders recipient cards and submits the selected player or bank command', async ({ page }) => {
  const transferBodies: Record<string, unknown>[] = [];
  const capability = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
  const snapshotWithRecipient = {
    ...gameSnapshot,
    players: [
      { ...gameSnapshot.players[0], name: '甄嬛玩家' },
      { id: 'player-2', name: '眉庄玩家', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0, plotFineReduction: 200 },
    ],
  };

  await mockAccount(page);
  await mockLobby(page);
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(capability) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: snapshotWithRecipient }));
  await page.route('**/api/rooms/room-1/transfers', async (route) => {
    transferBodies.push(await postBody(route));
    await route.fulfill({ json: { id: `transfer-${transferBodies.length}` } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '转帐', exact: true }).click();
  await expect(page.getByRole('heading', { name: '转帐', exact: true })).toBeVisible();
  await expect(page.getByText('玩家转账', { exact: true })).toHaveCount(0);
  const playerCard = page.getByRole('button', { name: /沈眉庄.*眉庄玩家/ });
  const bankCard = page.getByRole('button', { name: /银行.*管理审批、轮次与结算/ });
  await expect(playerCard).toHaveAttribute('aria-pressed', 'true');
  await expect(bankCard).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /钮祜禄·甄嬛.*甄嬛玩家/ })).toHaveCount(0);

  await bankCard.click();
  await expect(bankCard).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('转帐金额').fill('500');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferBodies).toEqual([{ fromPlayerId: 'player-1', recipientType: 'BANK', amount: 500, isPlotFine: false }]);

  await page.getByRole('button', { name: '转帐', exact: true }).click();
  await playerCard.click();
  await page.getByLabel('转帐金额').fill('400');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferBodies).toEqual([
    { fromPlayerId: 'player-1', recipientType: 'BANK', amount: 500, isPlotFine: false },
    { fromPlayerId: 'player-1', recipientType: 'PLAYER', toPlayerId: 'player-2', amount: 400, isPlotFine: false },
  ]);
});

test('meizhuang plot fine transfer sends the original amount for server-authoritative reduction', async ({ page }) => {
  const meizhuangCapability = { characterId: 'meizhuang', playerId: 'player-2', isBank: false, activeHere: true };
  const transferBodies: Record<string, unknown>[] = [];
  const meizhuangSnapshot = {
    ...gameSnapshot,
    currentPlayerId: 'player-2',
    players: [
      ...gameSnapshot.players,
      { id: 'player-2', name: '沈眉庄', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0, plotFineReduction: 200 },
    ],
  };

  await mockAccount(page);
  await mockLobby(page, [room({ characterId: 'meizhuang', myCharacter: '沈眉庄' })]);
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(meizhuangCapability) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: meizhuangSnapshot }));
  await page.route('**/api/rooms/room-1/transfers', async (route) => {
    transferBodies.push(await postBody(route));
    await route.fulfill({ json: { id: 'transfer-1' } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '转帐', exact: true }).click();
  await page.getByRole('button', { name: /银行.*管理审批、轮次与结算/ }).click();
  await expect(page.getByLabel('剧情罚俸或损失时勾选（沈眉庄专属技能）')).toBeVisible();
  await page.getByLabel('剧情罚俸或损失时勾选（沈眉庄专属技能）').check();
  await page.getByLabel('转帐金额').fill('500');
  await expect(page.getByText('原始金额 500 两')).toBeVisible();
  await expect(page.getByText('沈眉庄减免 200 两')).toBeVisible();
  await expect(page.getByText('预计支付 300 两')).toBeVisible();
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferBodies).toEqual([{ fromPlayerId: 'player-2', recipientType: 'BANK', amount: 500, isPlotFine: true }]);

  await page.getByRole('button', { name: '转帐', exact: true }).click();
  await page.getByLabel('剧情罚俸或损失时勾选（沈眉庄专属技能）').check();
  await page.getByLabel('转帐金额').fill('200');
  await expect(page.getByText('预计支付 0 两')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认转帐' })).toBeEnabled();
});

test('non-meizhuang transfer keeps the entered amount without a plot fine control', async ({ page }) => {
  const transferBodies: Record<string, unknown>[] = [];
  const capability = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
  const snapshotWithRecipient = {
    ...gameSnapshot,
    players: [...gameSnapshot.players, { id: 'player-2', name: '沈眉庄', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0 }],
  };

  await mockAccount(page);
  await mockLobby(page);
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(capability) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: snapshotWithRecipient }));
  await page.route('**/api/rooms/room-1/transfers', async (route) => {
    transferBodies.push(await postBody(route));
    await route.fulfill({ json: { id: 'transfer-2' } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '转帐', exact: true }).click();
  await expect(page.getByLabel('剧情罚俸或损失时勾选（沈眉庄专属技能）')).toHaveCount(0);
  await page.getByLabel('转帐金额').fill('500');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect.poll(() => transferBodies).toEqual([{ fromPlayerId: 'player-1', recipientType: 'PLAYER', toPlayerId: 'player-2', amount: 500, isPlotFine: false }]);
});

test('bank approval presents unified player and bank transfer details', async ({ page }) => {
  const capability = { characterId: null, playerId: null, isBank: true, activeHere: true };
  const approvalSnapshot = {
    ...gameSnapshot,
    players: [
      { id: 'player-1', name: '沈眉庄玩家', characterId: 'meizhuang', balance: 5_000, remainingSkipTurns: 0, plotFineReduction: 200 },
      { id: 'player-2', name: '甄嬛玩家', characterId: 'zhenhuan', balance: 5_000, remainingSkipTurns: 0 },
    ],
    requests: [
      { id: 'transfer-bank-1', type: 'PLAYER_TRANSFER', playerId: 'player-1', targetPlayerId: null, recipientType: 'BANK', originalAmount: 500, reduction: 200, actualAmount: 300, amount: 300, isPlotFine: true, status: 'PENDING' },
      { id: 'transfer-player-1', type: 'PLAYER_TRANSFER', playerId: 'player-2', targetPlayerId: 'player-1', recipientType: 'PLAYER', originalAmount: 400, reduction: 0, actualAmount: 400, amount: 400, isPlotFine: false, status: 'PENDING' },
    ],
  };

  await mockAccount(page);
  await mockLobby(page, [room({ characterId: null, myCharacter: null, isBank: true })]);
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(capability) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: approvalSnapshot }));

  await openRoom(page);
  await page.getByRole('button', { name: /审批/ }).click();

  const bankTransfer = page.locator('.approval-list article').filter({ hasText: '收款：银行' });
  await expect(bankTransfer).toContainText('转帐');
  await expect(bankTransfer).toContainText('收款：银行');
  await expect(bankTransfer).toContainText('原始金额 500 两');
  await expect(bankTransfer).toContainText('沈眉庄减免 200 两');
  await expect(bankTransfer).toContainText('实际金额 300 两');
  await expect(bankTransfer.getByRole('button', { name: '批准 300 两' })).toBeVisible();
  await expect(bankTransfer.getByRole('button', { name: '拒绝 300 两' })).toBeVisible();

  const playerTransfer = page.locator('.approval-list article').filter({ hasText: '甄嬛玩家' });
  await expect(playerTransfer).toContainText('收款：沈眉庄玩家（沈眉庄）');
  await expect(playerTransfer).toContainText('原始金额 400 两');
  await expect(playerTransfer).toContainText('实际金额 400 两');
});

test('generated start-landing intent survives room child unmount with the same key and landing id', async ({ page }) => {
  const roomA = room({ id: 'room-a', name: '起点待确认的碎玉轩', status: 'PLAYING' });
  const roomB = room({ id: 'room-b', name: '临时打开的翊坤宫', status: 'LOBBY', characterId: null, myCharacter: null, playerCount: 0 });
  const capability = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [roomA, roomB]);
  await page.route('**/api/rooms/room-a/seats', (route) => route.fulfill({ json: {
    ...seatResponse(capability),
    room: { id: roomA.id, name: roomA.name, status: 'PLAYING', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-b/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
    room: { id: roomB.id, name: roomB.name, status: 'LOBBY', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-a/snapshot*', (route) => route.fulfill({ json: {
    ...gameSnapshot,
    id: roomA.id,
    name: roomA.name,
    landings: [],
  } }));

  let releaseLanding!: () => void;
  const landingWait = new Promise<void>((resolve) => { releaseLanding = resolve; });
  let landingWrites = 0;
  const landingKeys: Array<string | undefined> = [];
  const landingBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/rooms/room-a/landings/start', async (route) => {
    landingWrites += 1;
    landingKeys.push(route.request().headers()['idempotency-key']);
    const request = await postBody(route);
    landingBodies.push(request);
    if (landingWrites === 1) await landingWait;
    return route.fulfill({ json: { id: request.landingId } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /起点待确认的碎玉轩/ }).click();
  await page.getByRole('button', { name: '起点奖励' }).click();
  await page.getByRole('button', { name: '声明停留起点' }).click();
  await expect.poll(() => landingWrites).toBe(1);
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('button', { name: '确认返回' }).click();
  await page.getByRole('button', { name: /临时打开的翊坤宫/ }).click();
  await expect(page.getByText('临时打开的翊坤宫', { exact: true })).toBeVisible();

  releaseLanding();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '房间列表' }).click();
  await page.getByRole('button', { name: /起点待确认的碎玉轩/ }).click();
  await page.getByRole('button', { name: '起点奖励' }).click();
  await page.getByRole('button', { name: '声明停留起点' }).click();
  await expect.poll(() => landingWrites).toBe(2);

  expect(landingKeys[0]).toBeTruthy();
  expect(landingKeys[1]).toBe(landingKeys[0]);
  expect(landingBodies[0].landingId).toBeTruthy();
  expect(landingBodies[1].landingId).toBe(landingBodies[0].landingId);
});

test('finish keeps its intent key across room navigation until settlement refresh succeeds', async ({ page }) => {
  const roomA = room({ id: 'room-a', name: '待结算的景仁宫', status: 'PLAYING', characterId: null, myCharacter: null, isBank: true });
  const roomB = room({ id: 'room-b', name: '临时查看的碎玉轩', status: 'LOBBY', characterId: null, myCharacter: null, isBank: false, playerCount: 0 });
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [roomA, roomB]);
  await page.route('**/api/rooms/room-a/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: null, playerId: null, isBank: true, activeHere: true }),
    room: { id: roomA.id, name: roomA.name, status: 'PLAYING', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-b/seats', (route) => route.fulfill({ json: {
    ...seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY'),
    room: { id: roomB.id, name: roomB.name, status: 'LOBBY', skillEnabled: true },
  } }));
  await page.route('**/api/rooms/room-a/snapshot*', (route) => route.fulfill({ json: {
    ...gameSnapshot,
    id: roomA.id,
    name: roomA.name,
  } }));
  await page.route('**/api/rooms/room-a/settlement/preview', (route) => route.fulfill({ json: { blockers: [], players: [] } }));
  let releaseSettlement!: () => void;
  const settlementWait = new Promise<void>((resolve) => { releaseSettlement = resolve; });
  let settlementReads = 0;
  await page.route('**/api/rooms/room-a/settlement', async (route) => {
    settlementReads += 1;
    if (settlementReads === 1) {
      await settlementWait;
      return route.fulfill({ status: 503, json: { error: 'SNAPSHOT_UNAVAILABLE' } });
    }
    return route.fulfill({ json: {
      id: 'settlement-a', roomId: roomA.id, endedByAccountId: 'account-1', endedAt: now, totalTurns: 8, durationSeconds: 3600, forced: false, forceReason: null,
      winners: ['account-1'], ranking: [{ accountId: 'account-1', rank: 1 }], overriddenBlockers: [],
      players: [{ accountId: 'account-1', displayNameSnapshot: '甄嬛', characterNameSnapshot: '钮祜禄·甄嬛', cash: 1_000, unmortgagedPropertyValue: 0, mortgagedPropertyNetValue: 0, buildingSellValue: 0, totalWealth: 1_000, rank: 1, isWinner: true, propertyDetails: [] }],
    } });
  });

  let finishWrites = 0;
  const finishKeys: Array<string | undefined> = [];
  await page.route('**/api/rooms/room-a/finish', (route) => {
    finishWrites += 1;
    finishKeys.push(route.request().headers()['idempotency-key']);
    return route.fulfill({ json: { created: finishWrites === 1 } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /待结算的景仁宫/ }).click();
  await page.getByRole('button', { name: '事务' }).click();
  await page.getByRole('button', { name: '结束游戏', exact: true }).click();
  await page.getByLabel('输入“确认结束游戏”').fill('确认结束游戏');
  await page.getByRole('button', { name: '确认结束游戏' }).click();
  await expect.poll(() => finishWrites).toBe(1);
  await expect.poll(() => settlementReads).toBe(1);
  await page.getByRole('button', { name: '返回银行端' }).click();
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('button', { name: '确认返回' }).click();
  await page.getByRole('button', { name: /临时查看的碎玉轩/ }).click();
  await expect(page.getByText('临时查看的碎玉轩', { exact: true })).toBeVisible();

  releaseSettlement();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('临时查看的碎玉轩', { exact: true })).toBeVisible();
  await expect(page.getByText('服务暂时不可用，请稍后重试')).toHaveCount(0);
  await page.getByRole('button', { name: '房间列表' }).click();
  await page.getByRole('button', { name: /待结算的景仁宫/ }).click();
  await page.getByRole('button', { name: '事务' }).click();
  await page.getByRole('button', { name: '结束游戏', exact: true }).click();
  await page.getByLabel('输入“确认结束游戏”').fill('确认结束游戏');
  await page.getByRole('button', { name: '确认结束游戏' }).click();
  await expect.poll(() => finishWrites).toBe(2);
  await expect(page.getByText('不可变结算快照')).toBeVisible();

  expect(finishKeys[0]).toBeTruthy();
  expect(finishKeys[1]).toBe(finishKeys[0]);
});

test('join keeps its intent key when POST succeeds but the authoritative refresh fails', async ({ page }) => {
  const joinable = room({ status: 'LOBBY', mine: false, characterId: null, myCharacter: null, isBank: false, playerCount: 0 });
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [], [joinable]);
  const keys: Array<string | undefined> = [];
  let postAttempts = 0;
  let refreshFailures = 0;
  await page.route('**/api/rooms/room-1/join', (route) => {
    postAttempts += 1;
    keys.push(route.request().headers()['idempotency-key']);
    return route.fulfill({ json: { membership: { id: 'membership-1', characterId: null, playerId: null, isBank: false, activeHere: true } } });
  });
  await page.route('**/api/rooms/mine', (route) => {
    if (postAttempts === 0) return route.fulfill({ json: [] });
    if (postAttempts > 0 && refreshFailures === 0) {
      refreshFailures += 1;
      return route.abort('connectionreset');
    }
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse({ characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY') }));

  await openRoom(page);
  await page.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect.poll(() => refreshFailures).toBe(1);
  await page.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect.poll(() => postAttempts).toBe(2);
  await expect(page.getByRole('heading', { name: '选择席位' })).toBeVisible();
  await page.getByRole('button', { name: '房间列表' }).click();
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect.poll(() => postAttempts).toBe(3);

  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).toBeTruthy();
  expect(keys[2]).not.toBe(keys[1]);
});

test('seat acquisition keeps its intent key when POST succeeds but the authoritative refresh fails', async ({ page }) => {
  const lobbyRoom = room({ status: 'LOBBY', characterId: null, myCharacter: null, isBank: false, playerCount: 0 });
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page, [lobbyRoom]);
  const keys: Array<string | undefined> = [];
  let postAttempts = 0;
  let refreshFailures = 0;
  let selected = false;
  await page.route('**/api/rooms/room-1/select-character', (route) => {
    postAttempts += 1;
    selected = true;
    keys.push(route.request().headers()['idempotency-key']);
    return route.fulfill({ json: { membership: { id: 'membership-1', characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }, player: { id: 'player-1' } } });
  });
  await page.route('**/api/rooms/mine', (route) => {
    if (postAttempts > 0 && refreshFailures === 0) {
      refreshFailures += 1;
      return route.abort('connectionreset');
    }
    return route.fulfill({ json: [lobbyRoom] });
  });
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seatResponse(selected
    ? { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }
    : { characterId: null, playerId: null, isBank: false, activeHere: true }, 'LOBBY') }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: gameSnapshot }));

  await openRoom(page);
  await page.getByRole('button', { name: '选择角色', exact: true }).click();
  await expect.poll(() => refreshFailures).toBe(1);
  await page.getByRole('button', { name: '选择角色', exact: true }).click();
  await expect.poll(() => postAttempts).toBe(2);
  await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出' }).click();
  await page.getByRole('button', { name: '确认返回' }).click();
  selected = false;
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '选择角色', exact: true }).click();
  await expect.poll(() => postAttempts).toBe(3);

  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).toBeTruthy();
  expect(keys[2]).not.toBe(keys[1]);
});

test('swap request keeps its intent key when POST succeeds but the authoritative refresh fails', async ({ page }) => {
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page);
  const keys: Array<string | undefined> = [];
  let postAttempts = 0;
  let refreshFailures = 0;
  const swapSeats = {
    ...seatResponse({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }),
    characters: [
      ...seatResponse({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }).characters,
      { id: 'yixiu', name: '乌拉那拉·宜修', skill: { coldPalaceSkipReduction: 2 }, initialProperty: '景仁宫', occupiedBy: '皇后', canSelect: false },
    ],
  };
  await page.route('**/api/rooms/room-1/seats', (route) => {
    if (postAttempts > 0 && refreshFailures === 0) {
      refreshFailures += 1;
      return route.abort('connectionreset');
    }
    return route.fulfill({ json: swapSeats });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: gameSnapshot }));
  await page.route('**/api/rooms/room-1/role-swap-requests', (route) => {
    postAttempts += 1;
    keys.push(route.request().headers()['idempotency-key']);
    return route.fulfill({ json: { id: 'swap-new' } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '管理席位' }).click();
  await page.getByRole('button', { name: '申请交换' }).click();
  await expect.poll(() => refreshFailures).toBe(1);
  await page.getByRole('button', { name: '申请交换' }).click();
  await expect.poll(() => postAttempts).toBe(2);
  await expect(page.getByRole('button', { name: '申请交换' })).toBeEnabled();
  await page.getByRole('button', { name: '申请交换' }).click();
  await expect.poll(() => postAttempts).toBe(3);

  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).toBeTruthy();
  expect(keys[2]).not.toBe(keys[1]);
});

test('swap action keeps its intent key when POST succeeds but the authoritative refresh fails', async ({ page }) => {
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page);
  const keys: Array<string | undefined> = [];
  let postAttempts = 0;
  let refreshFailures = 0;
  const request = {
    id: 'swap-pending', roomId: 'room-1', requesterMembershipId: 'membership-2', targetMembershipId: 'membership-1',
    requesterCharacterId: 'yixiu', targetCharacterId: 'zhenhuan', requesterDisplayName: '皇后', targetDisplayName: '甄嬛',
    status: 'PENDING_TARGET', rejectionReason: null, createdAt: now, updatedAt: now, resolvedAt: null,
    actions: { canAccept: true, canReject: true, canCancel: false, canApproveBank: false },
  };
  const actionSeats = { ...seatResponse({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }), roleSwapRequests: [request] };
  await page.route('**/api/rooms/room-1/seats', (route) => {
    if (postAttempts > 0 && refreshFailures === 0) {
      refreshFailures += 1;
      return route.abort('connectionreset');
    }
    return route.fulfill({ json: actionSeats });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: gameSnapshot }));
  await page.route('**/api/role-swap-requests/swap-pending/accept', (route) => {
    postAttempts += 1;
    keys.push(route.request().headers()['idempotency-key']);
    return route.fulfill({ json: { ...request, status: 'PENDING_BANK' } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '管理席位' }).click();
  await page.getByRole('button', { name: '接受交换' }).click();
  await expect.poll(() => refreshFailures).toBe(1);
  await page.getByRole('button', { name: '接受交换' }).click();
  await expect.poll(() => postAttempts).toBe(2);
  await expect(page.getByRole('button', { name: '接受交换' })).toBeEnabled();
  await page.getByRole('button', { name: '接受交换' }).click();
  await expect.poll(() => postAttempts).toBe(3);

  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).toBeTruthy();
  expect(keys[2]).not.toBe(keys[1]);
});

test('takeover keeps its intent key when POST succeeds but the authoritative refresh fails', async ({ page }) => {
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockAccount(page);
  await mockLobby(page);
  const keys: Array<string | undefined> = [];
  let postAttempts = 0;
  let refreshFailures = 0;
  let activeHere = false;
  await page.route('**/api/rooms/room-1/seats', (route) => {
    if (postAttempts > 0 && refreshFailures === 0) {
      refreshFailures += 1;
      return route.abort('connectionreset');
    }
    return route.fulfill({ json: seatResponse({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere }) });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: gameSnapshot }));
  await page.route('**/api/rooms/room-1/take-control', (route) => {
    postAttempts += 1;
    activeHere = true;
    keys.push(route.request().headers()['idempotency-key']);
    return route.fulfill({ json: { membership: { id: 'membership-1', characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true } } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '接管本房间' }).click();
  await expect.poll(() => refreshFailures).toBe(1);
  await page.getByRole('button', { name: '接管本房间' }).click();
  await expect.poll(() => postAttempts).toBe(2);
  await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
  activeHere = false;
  await page.getByRole('button', { name: '管理席位' }).click();
  await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();
  await page.getByRole('button', { name: '接管本房间' }).click();
  await expect.poll(() => postAttempts).toBe(3);

  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).toBeTruthy();
  expect(keys[2]).not.toBe(keys[1]);
});

test('legacy identity entry points and copy are absent', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));
  await page.goto('/');
  await page.getByRole('button', { name: '加入游戏组' }).click();
  for (const legacy of ['房间码', '昵称', '设备名称', '银行授权码', '超管令牌', '恢复身份', '游客', '注册', '找回密码', '观战', '只读']) {
    await expect(page.getByText(legacy, { exact: false })).toHaveCount(0);
  }
  await expect(page.locator('input')).toHaveCount(2);
});
