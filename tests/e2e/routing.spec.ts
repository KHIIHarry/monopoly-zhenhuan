import { expect, test } from '@playwright/test';

const account = { id: 'account-1', username: 'zhenhuan', displayName: '甄嬛', isSuperAdmin: false, canCreateRoom: true, lastLoginAt: null };

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
