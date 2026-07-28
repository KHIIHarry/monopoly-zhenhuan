import { expect, test, type Page } from '@playwright/test';

const account = { id: 'account-1', username: 'zhenhuan', displayName: '甄嬛', isSuperAdmin: true, canCreateRoom: true, lastLoginAt: null };
const managedAccount = { id: 'account-2', username: 'meizhuang', displayName: '眉庄', note: null, status: 'ACTIVE', isSuperAdmin: false, canCreateRoom: true, lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

async function openCreateRoom(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.goto('/rooms/create');
  await expect(page.getByRole('heading', { name: '创建房间' })).toBeVisible();
}

async function openLobby(page: Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [] }));
  await page.goto('/rooms');
  await expect(page.getByRole('heading', { name: '甄嬛' })).toBeVisible();
}

async function mockAccountPages(page: Page, adminAccounts: typeof managedAccount[] = []) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/auth/sessions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/accounts**', (route) => route.fulfill({ json: { items: route.request().url().includes('/sessions') ? [] : adminAccounts, nextCursor: null } }));
  await page.route('**/api/admin/rooms**', (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route('**/api/admin/security-logs**', (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route('**/api/admin/dashboard', (route) => route.fulfill({ json: {
    accounts: { total: 0, active: 0 }, sessions: { valid: 0 }, rooms: { lobby: 0, playing: 0, finished: 0 },
    games: { settledTotal: 0, averageDurationSeconds: 0 }, characterSelections: [], characterWins: [], recentGames: [],
  } }));
}

test('create-room requires a manually entered room name', async ({ page }) => {
  await openCreateRoom(page);

  const name = page.getByLabel('房间名称', { exact: true });
  await expect(name).toHaveValue('');
  await expect(name).toHaveAttribute('placeholder', '例：翊坤宫夜局');
  expect(await name.evaluate((input) => input.checkValidity())).toBe(false);
});

test('create-room rejects a room name containing only whitespace', async ({ page }) => {
  await openCreateRoom(page);

  const name = page.getByLabel('房间名称', { exact: true });
  await name.fill('   ');
  expect(await name.evaluate((input) => input.checkValidity())).toBe(false);
});

test('create-room form uses three desktop columns and one mobile column', async ({ page }, testInfo) => {
  await openCreateRoom(page);

  const back = page.getByRole('button', { name: '🔙 房间列表', exact: true });
  await expect(back).toBeVisible();
  await expect(back).toHaveClass(/room-list-back/);
  await expect(back).toHaveCSS('border-top-width', '1px');

  const columns = await page.locator('.create-form').evaluate((form) => getComputedStyle(form).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(testInfo.project.name.startsWith('desktop-') ? 3 : 1);

  const positions = await Promise.all(['房间名称', '房间密码（可选）', '初始资金', '起点奖励'].map(async (label) => {
    const box = await page.getByLabel(label, { exact: true }).boundingBox();
    expect(box, `${label} input box`).not.toBeNull();
    return box!;
  }));

  if (testInfo.project.name.startsWith('desktop-')) {
    expect(positions[1].y).toBeCloseTo(positions[0].y, 0);
    expect(positions[2].y).toBeCloseTo(positions[0].y, 0);
    expect(positions[3].y).toBeGreaterThan(positions[0].y);

    const [startReward, diceMode, visibility] = await Promise.all([
      page.getByLabel('起点奖励', { exact: true }).boundingBox(),
      page.locator('.create-form .segment').boundingBox(),
      page.getByRole('combobox', { name: '房间可见性', exact: true }).boundingBox(),
    ]);
    expect(startReward).not.toBeNull();
    expect(diceMode).not.toBeNull();
    expect(visibility).not.toBeNull();
    expect(diceMode!.y).toBeCloseTo(startReward!.y, 0);
    expect(diceMode!.y).toBeCloseTo(visibility!.y, 0);
    expect(diceMode!.height).toBeCloseTo(startReward!.height, 0);
  } else {
    expect(positions[1].y).toBeGreaterThan(positions[0].y);
    expect(positions[2].y).toBeGreaterThan(positions[1].y);
  }

  const toggleGroup = page.locator('.create-form-toggles');
  await expect(toggleGroup).toHaveCount(1);
  const toggleLayout = await toggleGroup.evaluate((group) => ({
    columns: getComputedStyle(group).gridTemplateColumns.split(' ').length,
    rows: [...group.querySelectorAll('.toggle-row')].map((row) => row.getBoundingClientRect().y),
  }));
  expect(toggleLayout.columns).toBe(testInfo.project.name.startsWith('desktop-') ? 4 : 1);
  if (testInfo.project.name.startsWith('desktop-')) {
    expect(new Set(toggleLayout.rows.map((row) => Math.round(row))).size).toBe(1);
  }

  if (['desktop-chromium', 'android-chromium'].includes(testInfo.project.name)) {
    await page.screenshot({ path: `test-results/create-room-layout/${testInfo.project.name}.png`, fullPage: true });
  }
});

test('room-list and account actions use small rounded corners', async ({ page }) => {
  await openCreateRoom(page);
  await expect(page.getByRole('button', { name: '🔙 房间列表', exact: true })).toHaveCSS('border-top-left-radius', '6px');

  await openLobby(page);
  for (const name of ['个人信息', '超管后台', '退出']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCSS('border-top-left-radius', '6px');
  }
});

test('profile and admin return actions match the room-list button', async ({ page }) => {
  await mockAccountPages(page);

  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: '个人信息', exact: true })).toBeVisible();
  const profileBack = page.getByRole('button', { name: '🔙 房间列表', exact: true });
  await expect(profileBack).toHaveClass(/room-list-back/);
  await expect(profileBack).toHaveCSS('border-top-width', '1px');
  await expect(profileBack).toHaveCSS('border-top-left-radius', '6px');

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '超级管理员', exact: true })).toBeVisible();
  const adminBack = page.getByRole('button', { name: '🔙 房间列表', exact: true });
  await expect(adminBack).toHaveClass(/room-list-back/);
  await expect(adminBack).toHaveCSS('border-top-width', '1px');
  await expect(adminBack).toHaveCSS('border-top-left-radius', '6px');
});

test('admin account management does not show a device revocation reason field', async ({ page }) => {
  await mockAccountPages(page, [managedAccount]);

  await page.goto('/admin/accounts');
  const manage = page.getByRole('button', { name: '管理', exact: true });
  await expect(manage).toHaveCount(1);
  await manage.click();

  await expect(page.getByLabel('设备注销原因', { exact: true })).toHaveCount(0);
  const close = page.getByRole('button', { name: '关闭', exact: true });
  await expect(close).toHaveClass(/close-icon/);
  await expect(close).toHaveText('');
  await expect(close.locator('svg')).toHaveCount(1);
  await expect(close).toHaveCSS('transition-duration', '0.15s, 0.15s, 0.15s');
});
