import { expect, test, type Page, type Route } from '@playwright/test';

const now = '2026-07-27T08:00:00.000Z';
const account = { id: 'account-1', username: 'zhenhuan', displayName: '甄嬛', isSuperAdmin: true, canCreateRoom: true, lastLoginAt: now };
const room = { id: 'room-1', name: '碎玉轩夜局', status: 'LOBBY', creator: '甄嬛', memberCount: 2, playerCount: 1, playerLimit: 5, hasPassword: false, mine: true, characterId: 'zhenhuan', myCharacter: '钮祜禄·甄嬛', isBank: true };

async function body(route: Route) { return route.request().postDataJSON() as Record<string, unknown>; }

async function lobbyRoutes(page: Page, rooms: unknown[] = [room], sessions: unknown[] = []) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: rooms }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: rooms }));
}

test('room creation submits every supported setting after scannable confirmation', async ({ page }) => {
  await lobbyRoutes(page, []);
  let submitted: Record<string, unknown> = {};
  const keys: Array<string | undefined> = [];
  let attempts = 0;
  await page.route('**/api/rooms', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    submitted = await body(route);
    keys.push(route.request().headers()['idempotency-key']);
    attempts += 1;
    if (attempts === 1) return route.abort('connectionreset');
    return route.fulfill({ json: { id: 'room-new' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '创建房间' }).click();
  await page.getByLabel('房间名称').fill('翊坤宫超长夜局名称');
  await page.getByLabel('房间密码（可选）').fill('palace-secret');
  await page.getByLabel('初始资金').fill('6800');
  await page.getByLabel('起点奖励').fill('1200');
  await expect(page.getByLabel('赎回手续费')).toHaveValue('200');
  await page.getByLabel('赎回手续费').fill('0');
  await page.getByRole('button', { name: '实体骰子' }).click();
  await page.getByLabel('房间可见性').selectOption('PRIVATE');
  await page.getByLabel('启用人物技能').uncheck();
  await page.getByLabel('允许中途加入').check();
  await page.getByLabel('玩家转帐需要审批').check();
  await page.getByRole('button', { name: '检查设置' }).click();
  await expect(page.getByRole('heading', { name: '确认房间设置' })).toBeVisible();
  await expect(page.getByText('6,800 / 1,200 两')).toBeVisible();
  await expect(page.getByText('赎回手续费 0 两')).toBeVisible();
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect.poll(() => attempts).toBe(1);
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect.poll(() => attempts).toBe(2);
  expect(submitted).toEqual({ name: '翊坤宫超长夜局名称', password: 'palace-secret', initialBalance: 6800, diceMode: 'PHYSICAL', skillEnabled: false, startReward: 1200, redemptionFee: 0, allowMidgameJoin: true, visibility: 'PRIVATE', transferApprovalRequired: true });
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test('room creation keeps its intent key when POST succeeds but the follow-up room refresh fails', async ({ page }) => {
  await lobbyRoutes(page, []);
  const keys: Array<string | undefined> = [];
  let postAttempts = 0;
  let refreshFailures = 0;
  await page.route('**/api/rooms', async (route) => {
    if (route.request().method() === 'POST') {
      postAttempts += 1;
      keys.push(route.request().headers()['idempotency-key']);
      return route.fulfill({ json: { id: 'room-created' } });
    }
    if (postAttempts > 0 && refreshFailures === 0) {
      refreshFailures += 1;
      return route.abort('connectionreset');
    }
    return route.fulfill({ json: [] });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '创建房间' }).click();
  await page.getByLabel('房间名称').fill('断线重试夜局');
  await page.getByRole('button', { name: '检查设置' }).click();
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect.poll(() => refreshFailures).toBe(1);
  await expect(page.getByRole('heading', { name: '确认房间设置' })).toBeVisible();
  await page.getByRole('button', { name: '确认创建' }).click();
  await expect.poll(() => postAttempts).toBe(2);

  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test('profile shows authoritative timestamps and confirms revoke-one and logout-others', async ({ page }) => {
  const devices = [
    { id: 'session-current', deviceName: '当前 iPhone', browser: 'Safari', operatingSystem: 'iOS', loginIp: '120.***.***.36', lastIp: '120.***.***.36', createdAt: now, lastActiveAt: now, current: true },
    { id: 'session-other', deviceName: '另一台设备名称非常非常长', browser: 'Chrome', operatingSystem: 'macOS', loginIp: '10.***.***.8', lastIp: '10.***.***.9', createdAt: now, lastActiveAt: now, current: false },
  ];
  await lobbyRoutes(page, [room], devices);
  await page.route('**/api/auth/sessions', (route) => route.fulfill({ json: devices }));
  let revoked = 0; let logoutOthers = 0;
  await page.route('**/api/auth/sessions/session-other', (route) => { revoked += 1; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/auth/sessions/logout-others', (route) => { logoutOthers += 1; return route.fulfill({ json: { revoked: 1 } }); });
  await page.goto('/');
  await page.getByRole('button', { name: '个人信息' }).click();
  await expect(page.getByText('最近登录', { exact: false })).toBeVisible();
  await expect(page.getByText('登录 IP 120.***.***.36', { exact: false })).toBeVisible();
  await expect(page.getByText('当前设备')).toBeVisible();
  await expect(page.getByRole('button', { name: '退出其他所有设备' })).toHaveCSS('margin-top', '24px');
  await page.getByRole('button', { name: '退出设备' }).click();
  await expect(page.getByRole('dialog', { name: '退出指定设备' })).toBeVisible();
  await page.getByRole('button', { name: '确认退出' }).click();
  await expect.poll(() => revoked).toBe(1);
  await page.getByRole('button', { name: '退出其他所有设备' }).click();
  await page.getByRole('button', { name: '确认退出' }).click();
  await expect.poll(() => logoutOthers).toBe(1);
});

test('manual admin refresh presents completion feedback', async ({ page }) => {
  await lobbyRoutes(page);
  let adminReads = 0;
  await page.route('**/api/admin/**', (route) => {
    adminReads += 1;
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/accounts')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/rooms')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/security-logs')
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/dashboard')
      return route.fulfill({ json: {
        accounts: { total: 1, active: 1 },
        sessions: { valid: 1 },
        rooms: { lobby: 0, playing: 0, finished: 0 },
        games: { settledTotal: 0, averageDurationSeconds: 0 },
        characterSelections: [], characterWins: [], recentGames: [],
      } });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '超管后台' }).click();
  await expect.poll(() => adminReads).toBeGreaterThan(0);
  const readsBeforeRefresh = adminReads;
  await page.getByRole('button', { name: '刷新后台' }).click();

  await expect.poll(() => adminReads).toBeGreaterThan(readsBeforeRefresh);
  await expect(page.locator('.toast')).toContainText('后台数据已刷新');
});

test('super-admin exposes and calls complete Task 6 account, device, room, log, and dashboard routes', async ({ page }) => {
  await lobbyRoutes(page);
  const adminAccounts = [
    { id: 'account-active', username: 'meizhuang', displayName: '沈眉庄', note: '主账号', status: 'ACTIVE', isSuperAdmin: false, canCreateRoom: true, lastLoginAt: now, createdAt: now, updatedAt: now },
    { id: 'account-disabled', username: 'anlingrong', displayName: '安陵容', note: null, status: 'DISABLED', isSuperAdmin: false, canCreateRoom: false, lastLoginAt: null, createdAt: now, updatedAt: now },
  ];
  const pagedAccount = { id: 'account-paged', username: 'fuchaguiren', displayName: '富察贵人', note: null, status: 'ACTIVE', isSuperAdmin: false, canCreateRoom: false, lastLoginAt: null, createdAt: now, updatedAt: now };
  const adminRooms = [{ id: 'room-1', name: room.name, status: 'LOBBY', visibility: 'PUBLIC', creator: { id: 'account-1', displayName: '甄嬛' }, memberCount: 2, playerCount: 1, hasBank: true, hasPassword: false, createdAt: now, updatedAt: now, settlement: null }];
  const detail = { id: 'room-1', code: 'SYX', name: room.name, status: 'LOBBY', creator: { id: 'account-1', displayName: '甄嬛', username: 'zhenhuan' }, configuration: { initialBalance: 5000, diceMode: 'ELECTRONIC', skillEnabled: true, startReward: 1000, redemptionFee: 200, allowMidgameJoin: false, visibility: 'PUBLIC', transferApprovalRequired: false, playerLimit: 5, hasPassword: false }, lifecycle: { createdAt: now, startedAt: null, updatedAt: now, expiresAt: now }, members: [{ id: 'membership-1', accountId: 'account-active', displayNameSnapshot: '沈眉庄', status: 'ACTIVE', characterId: 'meizhuang', characterName: '沈眉庄', isBank: true, controllerActive: true, joinedAt: now, player: { id: 'player-1', balance: 5000, status: 'ACTIVE', ownedPropertyCount: 1 } }, { id: 'membership-2', accountId: 'account-disabled', displayNameSnapshot: '安陵容', status: 'ACTIVE', characterId: null, characterName: null, isBank: false, controllerActive: false, joinedAt: now, player: null }], blockers: { pendingRequests: 0, pendingSwaps: 0, openDebts: 0, activeTurns: 0 }, settlement: null };
  const dashboard = { accounts: { total: 3, active: 2 }, sessions: { valid: 2 }, rooms: { lobby: 1, playing: 0, finished: 1 }, games: { settledTotal: 1, averageDurationSeconds: 3600 }, characterSelections: [{ characterId: 'zhenhuan', characterNameSnapshot: '钮祜禄·甄嬛', count: 2 }], characterWins: [{ characterNameSnapshot: '钮祜禄·甄嬛', count: 1 }], recentGames: [{ roomId: 'history-1', roomNameSnapshot: '永寿宫旧局', endedAt: now, durationSeconds: 3600, forced: false, winners: [{ displayNameSnapshot: '甄嬛', characterNameSnapshot: '钮祜禄·甄嬛' }] }] };
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let roomDetailReads = 0;
  let detailDeleteStarted = false;
  let detailDeleteWrites = 0;
  const detailDeleteRefreshEvents: Array<'trash' | 'admin'> = [];
  let releaseDetailTrashRefresh!: () => void;
  let releaseDetailAdminRefresh!: () => void;
  const detailTrashRefreshGate = new Promise<void>((resolve) => {
    releaseDetailTrashRefresh = resolve;
  });
  const detailAdminRefreshGate = new Promise<void>((resolve) => {
    releaseDetailAdminRefresh = resolve;
  });
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname; const method = route.request().method();
    if (method !== 'GET') {
      const requestBody = (await body(route)) ?? {};
      writes.push({ method, path, body: requestBody });
      if (method === 'DELETE' && path === '/api/admin/rooms/room-1') {
        detailDeleteStarted = true;
        detailDeleteWrites += 1;
      }
      if (method === 'PATCH' && path === '/api/admin/accounts/account-active')
        Object.assign(adminAccounts[0], requestBody);
      return route.fulfill({ json: { ok: true, account: adminAccounts[0], revokedSessions: 1 } });
    }
    if (path === '/api/admin/accounts') return route.fulfill({ json: url.searchParams.get('cursor') === 'accounts-page-2' ? { items: [pagedAccount], nextCursor: null } : { items: adminAccounts, nextCursor: 'accounts-page-2' } });
    if (path.endsWith('/sessions')) return route.fulfill({ json: { items: [{ id: 'target-session', deviceName: '目标 Mac', browser: 'Chrome', operatingSystem: 'macOS', loginIp: '10.***.***.8', lastIp: '10.***.***.9', createdAt: now, lastActiveAt: now, expiresAt: now, active: true, revokedAt: null, revokeReason: null }], nextCursor: null } });
    if (path === '/api/admin/rooms/trash') {
      if (detailDeleteStarted) {
        detailDeleteRefreshEvents.push('trash');
        await detailTrashRefreshGate;
      }
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (path === '/api/admin/rooms') {
      if (detailDeleteStarted) {
        detailDeleteRefreshEvents.push('admin');
        await detailAdminRefreshGate;
        detailDeleteStarted = false;
      }
      return route.fulfill({ json: { items: adminRooms, nextCursor: null } });
    }
    if (path === '/api/admin/rooms/room-1') { roomDetailReads += 1; return route.fulfill({ json: detail }); }
    if (path.endsWith('/audit-logs')) return route.fulfill({ json: { items: [{ id: 'audit-1', action: 'ADMIN_ROOM_UPDATED', actorRole: 'ADMIN', reason: null, createdAt: now }], nextCursor: null } });
    if (path === '/api/admin/security-logs') return route.fulfill({ json: { items: [{ id: 'log-1', action: 'LOGIN_SUCCEEDED', accountId: 'account-active', actorAccountId: null, ip: '120.***.***.36', createdAt: now }], nextCursor: null } });
    if (path === '/api/admin/dashboard') return route.fulfill({ json: dashboard });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '超管后台' }).click();
  await expect(page.getByText('2/3')).toBeVisible();
  await expect(page.getByText('永寿宫旧局')).toBeVisible();

  const dashboardTab = page.getByRole('tab', { name: '数据看板' });
  await dashboardTab.focus();
  await dashboardTab.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '账号' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '账号' }).click();
  await expect(page.getByText('富察贵人')).toBeVisible();
  await page.getByLabel('新用户名').fill('huafei'); await page.getByLabel('新用户昵称').fill('年世兰'); await page.getByLabel('初始密码').fill('StrongPassword42');
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.getByRole('button', { name: '管理' }).first().click();
  await page.getByLabel('昵称', { exact: true }).fill('惠贵人'); await page.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('status')).toContainText('已保存并生效');
  await page.getByLabel('重置后的密码').fill('AnotherPassword42'); await page.getByRole('button', { name: '重置密码' }).click(); await page.getByRole('button', { name: '确认执行' }).click();
  await page.getByRole('button', { name: '禁用账号' }).click(); await page.getByRole('button', { name: '确认执行' }).click();
  await page.getByRole('button', { name: '注销' }).click();
  const revokeDialog = page.getByRole('dialog', { name: '注销目标设备' });
  await expect(revokeDialog).toContainText('原因：管理员注销设备');
  await revokeDialog.getByRole('button', { name: '确认执行' }).click();
  await page.getByRole('button', { name: '管理' }).nth(1).click(); await page.getByRole('button', { name: '启用账号' }).click(); await page.getByRole('button', { name: '确认执行' }).click();
  await page.getByRole('button', { name: '删除账号' }).click();
  await expect(page.getByRole('button', { name: '确认删除' })).toBeDisabled();
  await expect(page.getByText('请输入用户名或昵称：anlingrong / 安陵容')).toBeVisible();
  await page.getByLabel('确认删除账号').fill('安陵容');
  await expect(page.getByRole('button', { name: '确认删除' })).toBeEnabled();
  await page.getByRole('button', { name: '确认删除' }).click();

  const roomsTab = page.getByRole('tab', { name: '房间' });
  await roomsTab.click();
  await expect(roomsTab).toHaveAttribute('aria-selected', 'true');
  const roomsPanel = page.getByRole('tabpanel', { name: '房间' });
  await roomsPanel.getByRole('button', { name: '管理' }).click();
  await page.getByLabel('房间名称').fill('碎玉轩新夜局'); await page.getByRole('button', { name: '保存房间配置' }).click();
  await page.getByLabel('新房间密码').fill('new-secret'); await page.getByRole('button', { name: '更新密码' }).click(); await page.getByRole('button', { name: '确认执行' }).click();
  await page.getByRole('button', { name: '移除成员' }).first().click(); await page.getByRole('button', { name: '确认执行' }).click();
  const bankSelect = roomsPanel.getByRole('combobox', { name: '更换银行' });
  await bankSelect.selectOption('membership-2'); const readsBeforeBank = roomDetailReads; await page.getByRole('button', { name: '确认更换银行' }).click();
  const bankDialog = page.getByRole('dialog', { name: '更换银行' });
  await bankDialog.getByRole('button', { name: '确认执行' }).click(); await expect.poll(() => roomDetailReads).toBeGreaterThan(readsBeforeBank);
  await expect(bankDialog).toHaveCount(0);
  await expect(bankSelect).toHaveValue('membership-1');
  await page.getByLabel('强制结束原因').fill('现场提前结束'); await expect(page.getByRole('button', { name: '强制结束' })).toBeEnabled(); await page.getByRole('button', { name: '强制结束' }).click(); await page.getByRole('button', { name: '确认执行' }).click();
  const detailDeleteButton = page.getByRole('button', { name: '删除房间', exact: true });
  await detailDeleteButton.click();
  let detailDeleteDialog = page.getByRole('dialog', { name: '删除房间' });
  await detailDeleteDialog.getByRole('button', { name: '取消' }).click();
  await expect(detailDeleteButton).toBeFocused();
  await detailDeleteButton.click();
  detailDeleteDialog = page.getByRole('dialog', { name: '删除房间' });
  const moveToTrash = detailDeleteDialog.getByRole('button', { name: '移入垃圾桶' });
  const cancelDetailDelete = detailDeleteDialog.getByRole('button', { name: '取消' });
  await expect(moveToTrash).toBeDisabled();
  await detailDeleteDialog.getByLabel('确认删除房间').fill(room.name);
  await expect(moveToTrash).toBeEnabled();
  await moveToTrash.click();
  await expect.poll(() => detailDeleteWrites).toBe(1);
  await expect.poll(() => detailDeleteRefreshEvents).toEqual(['trash']);
  await expect(moveToTrash).toBeDisabled();
  await expect(cancelDetailDelete).toBeDisabled();
  await detailDeleteDialog.press('Escape');
  await expect(detailDeleteDialog).toBeVisible();
  await moveToTrash.evaluate((button: HTMLButtonElement) => button.click());
  expect(detailDeleteWrites).toBe(1);
  releaseDetailTrashRefresh();
  await expect.poll(() => detailDeleteRefreshEvents).toEqual(['trash', 'admin']);
  await expect(moveToTrash).toBeDisabled();
  await detailDeleteDialog.press('Escape');
  await expect(detailDeleteDialog).toBeVisible();
  releaseDetailAdminRefresh();
  await expect(detailDeleteDialog).toHaveCount(0);
  expect(detailDeleteRefreshEvents).toEqual(['trash', 'admin']);
  await expect(page.getByRole('dialog', { name: '待删除房间' })).toHaveCount(0);
  await page.getByRole('tab', { name: '安全日志' }).click(); await expect(page.getByText('LOGIN_SUCCEEDED')).toBeVisible();

  const paths = writes.map((item) => `${item.method} ${item.path}`);
  for (const expected of [
    'POST /api/admin/accounts', 'PATCH /api/admin/accounts/account-active', 'POST /api/admin/accounts/account-active/reset-password',
    'POST /api/admin/accounts/account-active/disable', 'POST /api/admin/accounts/account-active/sessions/target-session/revoke', 'POST /api/admin/accounts/account-disabled/enable',
    'DELETE /api/admin/accounts/account-disabled',
    'PATCH /api/admin/rooms/room-1', 'POST /api/admin/rooms/room-1/password', 'POST /api/admin/rooms/room-1/members/membership-1/remove',
    'POST /api/admin/rooms/room-1/bank/reassign', 'POST /api/admin/rooms/room-1/finish', 'DELETE /api/admin/rooms/room-1',
  ]) expect(paths).toContain(expected);
  expect(writes).toContainEqual({
    method: 'POST',
    path: '/api/admin/accounts/account-active/sessions/target-session/revoke',
    body: { reason: '管理员注销设备' },
  });
  expect(writes.every((write) => write.path.startsWith('/api/admin/'))).toBe(true);
});

test('管理员房间配置在回读后确认保存', async ({ page }) => {
  await lobbyRoutes(page);
  const adminRooms = [{ id: 'room-1', name: room.name, status: 'LOBBY', visibility: 'PUBLIC', creator: { id: 'account-1', displayName: '甄嬛' }, memberCount: 2, playerCount: 1, hasBank: true, hasPassword: false, createdAt: now, updatedAt: now, settlement: null }];
  const configuration = { initialBalance: 5000, diceMode: 'ELECTRONIC', skillEnabled: true, startReward: 1000, redemptionFee: 200, allowMidgameJoin: false, visibility: 'PUBLIC', transferApprovalRequired: false, playerLimit: 5, hasPassword: false };
  const dashboard = { accounts: { total: 1, active: 1 }, sessions: { valid: 1 }, rooms: { lobby: 1, playing: 0, finished: 0 }, games: { settledTotal: 0, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [] };
  let roomStatus: 'LOBBY' | 'PLAYING' = 'LOBBY';
  const detail = () => ({ id: 'room-1', code: 'SYX', name: room.name, status: roomStatus, creator: { id: 'account-1', displayName: '甄嬛', username: 'zhenhuan' }, configuration, lifecycle: { createdAt: now, startedAt: null, updatedAt: now, expiresAt: now }, members: [], blockers: { pendingRequests: 0, pendingSwaps: 0, openDebts: 0, activeTurns: 0 }, settlement: null });
  let writes = 0;
  let submitted: Record<string, unknown> = {};
  await page.route('**/api/auth/login', (route) => route.fulfill({ json: { account } }));
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === '/api/admin/rooms/room-1' && method === 'PATCH') {
      writes += 1;
      submitted = await body(route);
      Object.assign(configuration, submitted);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return route.fulfill({ json: { roomId: 'room-1' } });
    }
    if (path === '/api/admin/rooms/room-1') return route.fulfill({ json: detail() });
    if (path.endsWith('/audit-logs')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/rooms/trash') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/rooms') return route.fulfill({ json: { items: adminRooms, nextCursor: null } });
    if (path === '/api/admin/accounts') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/security-logs') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/dashboard') return route.fulfill({ json: dashboard });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '超管后台' }).click();
  await page.getByRole('tab', { name: '房间' }).click();
  await page.getByRole('button', { name: '管理' }).click();
  await page.getByLabel('赎回手续费').fill('0');
  await page.getByRole('button', { name: '保存房间配置' }).click();

  await expect(page.getByRole('button', { name: '正在保存' })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('正在保存房间配置');
  await expect(page.getByRole('status')).toHaveText('已保存并生效');
  await expect(page.getByLabel('赎回手续费')).toHaveValue('0');
  expect(writes).toBe(1);
  expect(submitted).toEqual({ redemptionFee: 0 });

  await page.getByRole('button', { name: '关闭' }).click();
  roomStatus = 'PLAYING';
  await page.getByRole('button', { name: '管理' }).click();
  await expect(page.getByLabel('赎回手续费')).toHaveValue('0');
  await expect(page.getByLabel('赎回手续费')).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除房间', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除房间', exact: true })).toHaveAttribute('title', '请先结束对局后删除');
});

test('room trash entry, responsive panel, confirmations, busy state, and refreshes', async ({ page }) => {
  await lobbyRoutes(page);
  const deletedAt = '2026-08-04T08:00:00.000Z';
  const purgeAfter = '2099-08-05T08:00:00.000Z';
  let trashRooms = [
    { id: 'trash-restore', name: '碎玉轩旧局', code: 'SYX-OLD', status: 'FINISHED', deletedAt, purgeAfter, deletedBy: { id: account.id, displayName: account.displayName } },
    { id: 'trash-delete', name: '翊坤宫终局', code: 'YKG-END', status: 'CLOSED', deletedAt, purgeAfter, deletedBy: null },
  ];
  let trashReads = 0;
  let adminRoomReads = 0;
  let restoreWrites = 0;
  let permanentWrites = 0;
  const refreshEvents: Array<'trash' | 'admin'> = [];
  let trashMutation: 'restore' | 'permanent' | null = null;
  let releaseRestoreTrashRefresh!: () => void;
  let releaseRestoreAdminRefresh!: () => void;
  let releasePermanentTrashRefresh!: () => void;
  let releasePermanentAdminRefresh!: () => void;
  const restoreTrashRefreshGate = new Promise<void>((resolve) => {
    releaseRestoreTrashRefresh = resolve;
  });
  const restoreAdminRefreshGate = new Promise<void>((resolve) => {
    releaseRestoreAdminRefresh = resolve;
  });
  const permanentTrashRefreshGate = new Promise<void>((resolve) => {
    releasePermanentTrashRefresh = resolve;
  });
  const permanentAdminRefreshGate = new Promise<void>((resolve) => {
    releasePermanentAdminRefresh = resolve;
  });
  const dashboard = { accounts: { total: 1, active: 1 }, sessions: { valid: 1 }, rooms: { lobby: 0, playing: 0, finished: 0 }, games: { settledTotal: 0, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [] };

  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/admin/rooms/trash') {
      trashReads += 1;
      refreshEvents.push('trash');
      if (trashMutation === 'restore') await restoreTrashRefreshGate;
      if (trashMutation === 'permanent') await permanentTrashRefreshGate;
      return route.fulfill({ json: { items: trashRooms, nextCursor: null } });
    }
    if (path === '/api/admin/rooms/trash-restore/restore' && method === 'POST') {
      restoreWrites += 1;
      trashMutation = 'restore';
      trashRooms = trashRooms.filter((item) => item.id !== 'trash-restore');
      return route.fulfill({ json: { restored: true, id: 'trash-restore' } });
    }
    if (path === '/api/admin/rooms/trash-delete/permanent' && method === 'DELETE') {
      permanentWrites += 1;
      trashMutation = 'permanent';
      trashRooms = trashRooms.filter((item) => item.id !== 'trash-delete');
      return route.fulfill({ json: { deleted: true, id: 'trash-delete' } });
    }
    if (path === '/api/admin/rooms') {
      adminRoomReads += 1;
      refreshEvents.push('admin');
      if (trashMutation === 'restore') await restoreAdminRefreshGate;
      if (trashMutation === 'permanent') await permanentAdminRefreshGate;
      trashMutation = null;
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (path === '/api/admin/accounts') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/security-logs') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/dashboard') return route.fulfill({ json: dashboard });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '超管后台' }).click();
  const trigger = page.locator('.room-trash-trigger');
  await expect(trigger).toHaveCount(0);
  await page.getByRole('tab', { name: '账号' }).click();
  await expect(trigger).toHaveCount(0);
  await page.getByRole('tab', { name: '房间' }).click();
  await expect(trigger).toBeVisible();
  await expect(trigger.locator('.room-trash-count')).toHaveText('2');

  await trigger.click();
  const panel = page.getByRole('dialog', { name: '待删除房间' });
  await expect(panel).toBeVisible();
  const closeTrash = panel.getByRole('button', { name: '关闭垃圾桶' });
  await expect(closeTrash).toBeFocused();
  const backgroundState = await page.locator('.admin-tabs').evaluate((element) => ({
    inert: (element as HTMLElement).inert,
    ariaHidden: element.getAttribute('aria-hidden'),
  }));
  expect(backgroundState).toEqual({ inert: true, ariaHidden: 'true' });
  await closeTrash.press('Shift+Tab');
  await expect(panel.getByRole('button', { name: '立即删除' }).last()).toBeFocused();
  await panel.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator('.admin-tabs')).not.toHaveAttribute('aria-hidden', 'true');
  await trigger.click();
  await expect(panel).toBeVisible();
  const geometry = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  if (geometry.viewportWidth >= 900) {
    expect(geometry.top).toBeCloseTo(0, 0);
    expect(geometry.right).toBeCloseTo(geometry.viewportWidth, 0);
    expect(geometry.bottom).toBeCloseTo(geometry.viewportHeight, 0);
    expect(geometry.width).toBeLessThanOrEqual(420);
  } else {
    expect(geometry.left).toBeCloseTo(0, 0);
    expect(geometry.right).toBeCloseTo(geometry.viewportWidth, 0);
    expect(geometry.bottom).toBeCloseTo(geometry.viewportHeight, 0);
    expect(geometry.top).toBeGreaterThan(0);
  }

  const restoreRow = panel.locator('.room-trash-row').filter({ hasText: '碎玉轩旧局' });
  await expect(restoreRow).toContainText('SYX-OLD · 已结算');
  await expect(restoreRow).toContainText(`删除时间：${new Date(deletedAt).toLocaleString('zh-CN')}`);
  await expect(restoreRow).toContainText(/剩余 \d+ 小时/);
  await expect(restoreRow).toContainText(/自动删除：.*2099/);

  const restoreButton = restoreRow.getByRole('button', { name: '恢复' });
  await restoreButton.click();
  let restoreDialog = page.getByRole('dialog', { name: '恢复房间' });
  await restoreDialog.getByRole('button', { name: '取消' }).click();
  await expect(restoreButton).toBeFocused();

  const trashReadsBeforeRestore = trashReads;
  const adminReadsBeforeRestore = adminRoomReads;
  const refreshEventsBeforeRestore = refreshEvents.length;
  await restoreButton.click();
  restoreDialog = page.getByRole('dialog', { name: '恢复房间' });
  const restoreSubmit = restoreDialog.getByRole('button', { name: '确认恢复' });
  const restoreCancel = restoreDialog.getByRole('button', { name: '取消' });
  await restoreSubmit.click();
  await expect.poll(() => restoreWrites).toBe(1);
  await expect.poll(() => trashReads).toBeGreaterThan(trashReadsBeforeRestore);
  await expect(restoreSubmit).toBeDisabled();
  await expect(restoreCancel).toBeDisabled();
  await restoreDialog.press('Escape');
  await expect(restoreDialog).toBeVisible();
  await restoreSubmit.evaluate((button: HTMLButtonElement) => button.click());
  expect(restoreWrites).toBe(1);
  releaseRestoreTrashRefresh();
  await expect.poll(() => adminRoomReads).toBeGreaterThan(adminReadsBeforeRestore);
  await expect(restoreSubmit).toBeDisabled();
  await restoreDialog.press('Escape');
  await expect(restoreDialog).toBeVisible();
  expect(restoreWrites).toBe(1);
  releaseRestoreAdminRefresh();
  await expect(restoreDialog).toHaveCount(0);
  await expect(trigger.locator('.room-trash-count')).toHaveText('1');
  await expect(closeTrash).toBeFocused();
  expect(refreshEvents.slice(refreshEventsBeforeRestore, refreshEventsBeforeRestore + 2)).toEqual(['trash', 'admin']);

  const deleteRow = panel.locator('.room-trash-row').filter({ hasText: '翊坤宫终局' });
  await expect(deleteRow).toContainText('YKG-END · 已关闭');
  const permanentButton = deleteRow.getByRole('button', { name: '立即删除' });
  await permanentButton.click();
  const permanentDialog = page.getByRole('dialog', { name: '立即删除房间' });
  const permanentSubmit = permanentDialog.getByRole('button', { name: '永久删除' });
  const permanentCancel = permanentDialog.getByRole('button', { name: '取消' });
  await expect(permanentSubmit).toBeDisabled();
  await permanentDialog.getByLabel('确认立即删除房间').fill('翊坤宫');
  await expect(permanentSubmit).toBeDisabled();
  await permanentDialog.getByLabel('确认立即删除房间').fill('翊坤宫终局');
  await expect(permanentSubmit).toBeEnabled();
  const trashReadsBeforePermanent = trashReads;
  const adminReadsBeforePermanent = adminRoomReads;
  const refreshEventsBeforePermanent = refreshEvents.length;
  await permanentSubmit.click();
  await expect.poll(() => permanentWrites).toBe(1);
  await expect.poll(() => trashReads).toBeGreaterThan(trashReadsBeforePermanent);
  await expect(permanentSubmit).toBeDisabled();
  await expect(permanentCancel).toBeDisabled();
  await permanentDialog.press('Escape');
  await expect(permanentDialog).toBeVisible();
  await permanentSubmit.evaluate((button: HTMLButtonElement) => button.click());
  expect(permanentWrites).toBe(1);
  releasePermanentTrashRefresh();
  await expect.poll(() => adminRoomReads).toBeGreaterThan(adminReadsBeforePermanent);
  await expect(permanentSubmit).toBeDisabled();
  await permanentDialog.press('Escape');
  await expect(permanentDialog).toBeVisible();
  expect(permanentWrites).toBe(1);
  releasePermanentAdminRefresh();
  await expect(permanentDialog).toHaveCount(0);
  await expect(panel.getByText('垃圾桶为空')).toBeVisible();
  await expect(trigger.locator('.room-trash-count')).toHaveCount(0);
  await expect(closeTrash).toBeFocused();
  expect(refreshEvents.slice(refreshEventsBeforePermanent, refreshEventsBeforePermanent + 2)).toEqual(['trash', 'admin']);

  await panel.getByRole('button', { name: '关闭垃圾桶' }).click();
  await page.getByRole('tab', { name: '安全日志' }).click();
  await expect(trigger).toHaveCount(0);
});

test('admin mutation reuses its key after a lost response', async ({ page }) => {
  await lobbyRoutes(page);
  let attempts = 0;
  const keys: Array<string | undefined> = [];
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === '/api/admin/accounts' && method === 'POST') {
      attempts += 1;
      keys.push(route.request().headers()['idempotency-key']);
      if (attempts === 1) return route.abort('connectionreset');
      return route.fulfill({ json: { id: 'account-new' } });
    }
    if (path === '/api/admin/accounts') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/rooms') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/security-logs') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/dashboard') return route.fulfill({ json: { accounts: { total: 1, active: 1 }, sessions: { valid: 1 }, rooms: { lobby: 0, playing: 0, finished: 0 }, games: { settledTotal: 0, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [] } });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '超管后台' }).click();
  await page.getByRole('tab', { name: '账号' }).click();
  await page.getByLabel('新用户名').fill('huafei');
  await page.getByLabel('新用户昵称').fill('年世兰');
  await page.getByLabel('初始密码').fill('StrongPassword42');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect.poll(() => attempts).toBe(1);
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect.poll(() => attempts).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test('account creation keeps its intent key when POST succeeds but the follow-up admin refresh fails', async ({ page }) => {
  await lobbyRoutes(page);
  const keys: Array<string | undefined> = [];
  let postAttempts = 0;
  let refreshFailures = 0;
  const dashboard = { accounts: { total: 1, active: 1 }, sessions: { valid: 1 }, rooms: { lobby: 0, playing: 0, finished: 0 }, games: { settledTotal: 0, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [] };
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === '/api/admin/accounts' && method === 'POST') {
      postAttempts += 1;
      keys.push(route.request().headers()['idempotency-key']);
      return route.fulfill({ json: { id: 'account-created' } });
    }
    if (path === '/api/admin/accounts') {
      if (postAttempts > 0 && refreshFailures === 0) {
        refreshFailures += 1;
        return route.abort('connectionreset');
      }
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (path === '/api/admin/rooms') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/security-logs') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/dashboard') return route.fulfill({ json: dashboard });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '超管后台' }).click();
  await page.getByRole('tab', { name: '账号' }).click();
  await page.getByLabel('新用户名').fill('huafei');
  await page.getByLabel('新用户昵称').fill('年世兰');
  await page.getByLabel('初始密码').fill('StrongPassword42');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect.poll(() => refreshFailures).toBe(1);
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect.poll(() => postAttempts).toBe(2);

  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test('selected admin account and password draft refresh after successful target mutations', async ({ page }) => {
  await lobbyRoutes(page);
  let status: 'ACTIVE' | 'DISABLED' = 'ACTIVE';
  let passwordResets = 0;
  let statusWrites = 0;
  const currentAccount = () => ({ id: 'account-target', username: 'meizhuang', displayName: '沈眉庄', note: null, status, isSuperAdmin: false, canCreateRoom: true, lastLoginAt: now, createdAt: now, updatedAt: now });
  const dashboard = { accounts: { total: 1, active: status === 'ACTIVE' ? 1 : 0 }, sessions: { valid: 0 }, rooms: { lobby: 0, playing: 0, finished: 0 }, games: { settledTotal: 0, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [] };
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method !== 'GET') {
      if (path.endsWith('/reset-password')) passwordResets += 1;
      if (path.endsWith('/disable')) { status = 'DISABLED'; statusWrites += 1; }
      if (path.endsWith('/enable')) { status = 'ACTIVE'; statusWrites += 1; }
      return route.fulfill({ json: { ok: true, account: currentAccount() } });
    }
    if (path === '/api/admin/accounts') return route.fulfill({ json: { items: [currentAccount()], nextCursor: null } });
    if (path.endsWith('/sessions')) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/rooms') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/security-logs') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/admin/dashboard') return route.fulfill({ json: dashboard });
    return route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '超管后台' }).click();
  await page.getByRole('tab', { name: '账号' }).click();
  await page.getByRole('button', { name: '管理' }).click();
  await page.getByLabel('重置后的密码').fill('AnotherPassword42');
  await page.getByRole('button', { name: '重置密码' }).click();
  await page.getByRole('button', { name: '确认执行' }).click();
  await expect.poll(() => passwordResets).toBe(1);
  await expect.soft(page.getByLabel('重置后的密码')).toHaveValue('');

  await page.getByRole('button', { name: '禁用账号' }).click();
  await page.getByRole('button', { name: '确认执行' }).click();
  await expect.poll(() => statusWrites).toBe(1);
  await expect.soft(page.getByRole('button', { name: '启用账号' })).toBeVisible();
});
