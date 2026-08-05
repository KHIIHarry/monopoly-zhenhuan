import { expect, test } from '@playwright/test';

const account = { id: 'account-1', username: 'zhenhuan', displayName: '甄嬛', isSuperAdmin: false, canCreateRoom: true, lastLoginAt: null };

test('route skeleton hides the login page until the room list is ready', async ({ page }) => {
  let authChecks = 0;
  let releaseDestinationAuth!: () => void;
  const destinationAuth = new Promise<void>((resolve) => {
    releaseDestinationAuth = resolve;
  });

  await page.route('**/api/auth/me', async (route) => {
    authChecks += 1;
    if (authChecks === 1) {
      await route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } });
      return;
    }
    await destinationAuth;
    await route.fulfill({ json: { account, sessions: [] } });
  });
  await page.route('**/api/auth/login', (route) => route.fulfill({ json: { account } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [] }));

  await page.goto('/login');
  await expect.poll(() => authChecks).toBe(1);
  await page.getByRole('textbox', { name: '用户名' }).fill('zhenhuan');
  await page.getByRole('textbox', { name: '密码' }).fill('test-password');
  await page.getByRole('button', { name: '登录' }).click();

  try {
    await expect(page.getByTestId('route-skeleton')).toBeVisible();
    await expect(page.getByRole('heading', { name: '账号登录' })).toHaveCount(0);
  } finally {
    releaseDestinationAuth();
  }

  await expect(page).toHaveURL('/rooms');
  await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible();
  await expect(page.getByTestId('route-skeleton')).toHaveCount(0);
});

test('route skeleton covers a direct protected route while auth and page data load', async ({ page }) => {
  let releaseAuth!: () => void;
  const authGate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });

  await page.route('**/api/auth/me', async (route) => {
    await authGate;
    await route.fulfill({ json: { account, sessions: [] } });
  });
  await page.route('**/api/auth/sessions', (route) => route.fulfill({ json: [] }));

  await page.goto('/profile');
  try {
    await expect(page.getByTestId('route-skeleton')).toBeVisible();
    await expect(page.getByRole('heading', { name: '个人信息' })).toHaveCount(0);
  } finally {
    releaseAuth();
  }

  await expect(page.getByRole('heading', { name: '个人信息' })).toBeVisible();
  await expect(page.getByTestId('route-skeleton')).toHaveCount(0);
});

test('room routes remain addressable and enforce the selected workbench capability', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: {
    room: { id: 'room-1', name: '碎玉轩夜局', status: 'PLAYING', skillEnabled: true },
    membership: { id: 'membership-1', characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true },
    characters: [], bank: { occupiedBy: null }, roleSwapRequests: [],
  } }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: {
    id: 'room-1', stateVersion: 1, code: 'SYX', name: '碎玉轩夜局', status: 'PLAYING', diceMode: 'PHYSICAL', redemptionFee: 500, startReward: 1000,
    currentPlayerId: 'player-1', turn: null, players: [{ id: 'player-1', name: '甄嬛', characterId: 'zhenhuan', balance: 5000, remainingSkipTurns: 0 }],
    properties: [], ledger: [], requests: [], landings: [], audit: [], reversalCandidate: null,
  } }));

  await page.goto('/rooms/room-1/player');
  await expect(page).toHaveURL('/rooms/room-1/player');
  await expect(page.getByRole('heading', { name: '玩家端' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL('/rooms/room-1/player');
  await expect(page.getByRole('heading', { name: '玩家端' })).toBeVisible();

  await page.goto('/rooms/room-1/bank');
  await expect(page).toHaveURL('/403');
});

test('lobby navigation uses browser history instead of a component page state', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  const room = { id: 'room-1', name: '碎玉轩夜局', status: 'PLAYING', creator: '甄嬛', memberCount: 1, playerCount: 1, playerLimit: 5, hasPassword: false, mine: true, characterId: 'zhenhuan', myCharacter: '钮祜禄·甄嬛', isBank: false };
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [room] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [room] }));
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: {
    room: { id: 'room-1', name: room.name, status: 'PLAYING', skillEnabled: true },
    membership: { id: 'membership-1', characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }, characters: [], bank: { occupiedBy: null }, roleSwapRequests: [],
  } }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: {
    id: 'room-1', stateVersion: 1, code: 'SYX', name: room.name, status: 'PLAYING', diceMode: 'PHYSICAL', redemptionFee: 500, startReward: 1000, currentPlayerId: 'player-1', turn: null,
    players: [{ id: 'player-1', name: '甄嬛', characterId: 'zhenhuan', balance: 5000, remainingSkipTurns: 0 }], properties: [], ledger: [], requests: [], landings: [], audit: [], reversalCandidate: null,
  } }));

  await page.goto('/rooms');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await expect(page).toHaveURL('/rooms/room-1/player');
  await page.goBack();
  await expect(page).toHaveURL('/rooms');
  await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible();
});

test('unauthenticated protected routes redirect to login and retain their destination', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));

  await page.goto('/rooms');
  await expect(page).toHaveURL(/\/login\?next=%2Frooms/);
});

test('finished game workbench routes redirect to their settlement route', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: {
    room: { id: 'room-1', name: '碎玉轩夜局', status: 'FINISHED', skillEnabled: true },
    membership: { id: 'membership-1', characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true },
    characters: [], bank: { occupiedBy: null }, roleSwapRequests: [],
  } }));
  await page.route('**/api/rooms/room-1/settlement', (route) => route.fulfill({ json: {
    id: 'settlement-1', roomId: 'room-1', stateVersion: 1, endedByAccountId: 'account-1', endedAt: '2026-07-28T00:00:00.000Z', totalTurns: 1, durationSeconds: 60,
    forced: false, forceReason: null, winners: [], ranking: [], overriddenBlockers: [], players: [],
  } }));

  await page.goto('/rooms/room-1/player');
  await expect(page).toHaveURL('/rooms/room-1/settlement');
  await expect(page.getByRole('heading', { name: '对局结算' })).toBeVisible();
});

test('finish route can be opened directly by the bank after a refresh', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: {
    room: { id: 'room-1', name: '碎玉轩夜局', status: 'PLAYING', skillEnabled: true },
    membership: { id: 'membership-1', characterId: null, playerId: null, isBank: true, activeHere: true }, characters: [], bank: { occupiedBy: '甄嬛' }, roleSwapRequests: [],
  } }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: {
    id: 'room-1', stateVersion: 1, code: 'SYX', name: '碎玉轩夜局', status: 'PLAYING', diceMode: 'PHYSICAL', redemptionFee: 500, startReward: 1000, currentPlayerId: undefined, turn: null,
    players: [], properties: [], ledger: [], requests: [], landings: [], audit: [], reversalCandidate: null,
  } }));
  await page.route('**/api/rooms/room-1/settlement/preview', (route) => route.fulfill({ json: { blockers: [], players: [] } }));

  await page.goto('/rooms/room-1/finish');
  await expect(page).toHaveURL('/rooms/room-1/finish');
  await expect(page.getByRole('heading', { name: '结束游戏' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '结束游戏' })).toBeVisible();
});

test('legacy ended rooms use the settlement URL without a loading loop', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: {
    room: { id: 'room-1', name: '旧局', status: 'ENDED', skillEnabled: true }, membership: null, characters: [], bank: { occupiedBy: null }, roleSwapRequests: [],
  } }));
  await page.route('**/api/rooms/room-1/settlement', (route) => route.fulfill({ status: 409, json: { error: 'LEGACY_SETTLEMENT_UNAVAILABLE' } }));

  await page.goto('/rooms/room-1/player');
  await expect(page).toHaveURL('/rooms/room-1/settlement');
  await expect(page.getByRole('heading', { name: '结算不可用' })).toBeVisible();
});
