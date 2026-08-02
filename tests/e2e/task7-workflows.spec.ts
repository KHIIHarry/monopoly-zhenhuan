import { expect, test, type Page, type Route } from '@playwright/test';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import type { BrowserRoomStatus, BrowserRoomSummary, BrowserSeatSnapshot, BrowserSnapshot } from './browser-fixture-types';

const now = '2026-07-27T08:00:00.000Z';
const account = { id: 'account-1', username: 'zhenhuan', displayName: '甄嬛', isSuperAdmin: true, canCreateRoom: true, lastLoginAt: now };
type RoomSummary = BrowserRoomSummary;
const baseRoom: RoomSummary = { id: 'room-1', name: '碎玉轩夜局', status: 'PLAYING', creator: '甄嬛', memberCount: 2, playerCount: 1, playerLimit: 5, hasPassword: false, mine: true, characterId: 'zhenhuan', myCharacter: '钮祜禄·甄嬛', isBank: true };
const snapshot: BrowserSnapshot & { stateVersion: number } = { id: 'room-1', stateVersion: 1, code: 'SYX', name: baseRoom.name, status: 'PLAYING', diceMode: 'PHYSICAL', redemptionFee: 500, startReward: 1_000, currentPlayerId: 'player-1', turn: null, players: [{ id: 'player-1', name: '甄嬛', characterId: 'zhenhuan', balance: 5_000, remainingSkipTurns: 0 }], properties: [], ledger: [], requests: [], landings: [], audit: [], reversalCandidate: null };

type Membership = { characterId: string | null; playerId: string | null; isBank: boolean; activeHere: boolean };
type Swap = {
  id: string; roomId: string; requesterMembershipId: string; targetMembershipId: string; requesterCharacterId: string | null; targetCharacterId: string;
  requesterDisplayName: string; targetDisplayName: string; status: string; rejectionReason: string | null; createdAt: string; updatedAt: string; resolvedAt: string | null;
  actions: { canAccept: boolean; canReject: boolean; canCancel: boolean; canApproveBank: boolean };
};

const characters = [
  { id: 'zhenhuan', name: '钮祜禄·甄嬛', skill: { companionCashReward: 500 }, initialProperty: '永寿宫', occupiedBy: '甄嬛', canSelect: false },
  { id: 'yixiu', name: '乌拉那拉·宜修', skill: { coldPalaceSkipReduction: 2 }, initialProperty: '景仁宫', occupiedBy: '皇后', canSelect: false },
];

function seats(membership: Membership, roleSwapRequests: Swap[] = [], status: BrowserRoomStatus = 'PLAYING'): BrowserSeatSnapshot<Swap> & { stateVersion: number } {
  return { stateVersion: 1, room: { id: 'room-1', name: baseRoom.name, status, skillEnabled: true }, membership: { id: 'membership-1', ...membership }, characters, bank: { occupiedBy: membership.isBank ? '甄嬛' : null }, roleSwapRequests };
}

async function body(route: Route) { return route.request().postDataJSON() as Record<string, unknown>; }

async function listenForSocketTest(server: ReturnType<typeof createServer>) {
  const deadline = Date.now() + 90_000;
  while (true) {
    const listening = await new Promise<boolean>((resolve, reject) => {
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      const onError = (caught: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (caught.code === 'EADDRINUSE') resolve(false);
        else reject(caught);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(4000, '127.0.0.1');
    });
    if (listening) return;
    if (Date.now() >= deadline) throw new Error('SOCKET_TEST_PORT_TIMEOUT:127.0.0.1:4000');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function mockBase(page: Page, room = baseRoom) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [room] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [room] }));
}

async function openRoom(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
}

test('bank-first then character preserves bank and creates one stable Player identity', async ({ page }) => {
  await mockBase(page, { ...baseRoom, status: 'LOBBY', playerCount: 0, characterId: null, myCharacter: null, isBank: true });
  let membership: Membership = { characterId: null, playerId: null, isBank: true, activeHere: true };
  const playerIds: string[] = [];
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: { ...seats(membership, [], 'LOBBY'), characters: [{ ...characters[0], occupiedBy: membership.characterId ? '甄嬛' : null, canSelect: membership.characterId === null }] } }));
  await page.route('**/api/rooms/room-1/select-character', async (route) => {
    expect(await body(route)).toEqual({ characterId: 'zhenhuan' });
    membership = { characterId: 'zhenhuan', playerId: 'player-1', isBank: true, activeHere: true };
    playerIds.push(membership.playerId!);
    return route.fulfill({ json: { membership: { id: 'membership-1', ...membership }, player: { id: membership.playerId } } });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: snapshot }));

  await openRoom(page);
  await page.getByRole('button', { name: '管理席位' }).click();
  await page.getByRole('button', { name: '选择角色' }).click();
  await expect(page.getByRole('heading', { name: '选择工作台' })).toBeVisible();
  expect(membership.isBank).toBe(true);
  expect(playerIds).toEqual(['player-1']);
});

test('swap read model renders every state and dual target-bank decisions remain distinct requests', async ({ page }) => {
  await mockBase(page);
  const terminal = ['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'CONFLICTED'] as const;
  let phase: 'TARGET' | 'BANK' = 'TARGET';
  const pending = (): Swap => ({ id: 'swap-pending', roomId: 'room-1', requesterMembershipId: 'membership-2', targetMembershipId: 'membership-1', requesterCharacterId: 'yixiu', targetCharacterId: 'zhenhuan', requesterDisplayName: '皇后', targetDisplayName: '甄嬛', status: phase === 'TARGET' ? 'PENDING_TARGET' : 'PENDING_BANK', rejectionReason: null, createdAt: now, updatedAt: now, resolvedAt: null, actions: { canAccept: phase === 'TARGET', canReject: phase === 'TARGET', canCancel: false, canApproveBank: phase === 'BANK' } });
  const swaps = () => [pending(), ...terminal.map((status, index): Swap => ({ ...pending(), id: `swap-${index}`, status, rejectionReason: status === 'REJECTED' ? '席位暂不调整' : null, resolvedAt: now, actions: { canAccept: false, canReject: false, canCancel: false, canApproveBank: false } }))];
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: true, activeHere: true }, swaps()) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: snapshot }));
  const calls: string[] = [];
  await page.route('**/api/role-swap-requests/swap-pending/accept', (route) => { calls.push('accept'); phase = 'BANK'; return route.fulfill({ json: { ...pending(), status: 'PENDING_BANK' } }); });
  await page.route('**/api/role-swap-requests/swap-pending/approve-bank', (route) => { calls.push('approve-bank'); return route.fulfill({ json: { ...pending(), status: 'APPROVED' } }); });

  await openRoom(page);
  await page.getByRole('button', { name: '管理席位' }).click();
  await expect(page.getByRole('heading', { name: '我的申请' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '待我处理' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '银行确认' })).toBeVisible();
  for (const label of ['等待目标决定', '已同意', '已拒绝', '已取消', '已过期', '状态冲突']) await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: '接受交换' }).click();
  await expect(page.getByText('等待银行确认', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: '银行确认' }).click();
  expect(calls).toEqual(['accept', 'approve-bank']);
});

test('a player requester keeps PENDING_BANK in my outbox', async ({ page }) => {
  await mockBase(page, { ...baseRoom, isBank: false });
  const request: Swap = {
    id: 'swap-player-outbox', roomId: 'room-1', requesterMembershipId: 'membership-1', targetMembershipId: 'membership-2',
    requesterCharacterId: 'zhenhuan', targetCharacterId: 'yixiu', requesterDisplayName: '我发起的交换', targetDisplayName: '皇后',
    status: 'PENDING_BANK', rejectionReason: null, createdAt: now, updatedAt: now, resolvedAt: null,
    actions: { canAccept: false, canReject: false, canCancel: true, canApproveBank: false },
  };
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }, [request]) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: snapshot }));

  await openRoom(page);
  await page.getByRole('button', { name: '管理席位' }).click();
  const mine = page.locator('.swap-group').filter({ has: page.getByRole('heading', { name: '我的申请' }) });
  await expect(mine.getByText('我发起的交换')).toBeVisible();
});

test('bank-only terminal swap history stays in the bank group instead of my inbox', async ({ page }) => {
  await mockBase(page, { ...baseRoom, characterId: null, myCharacter: null, isBank: true, playerCount: 0 });
  const request: Swap = {
    id: 'swap-bank-history', roomId: 'room-1', requesterMembershipId: 'membership-2', targetMembershipId: 'membership-3',
    requesterCharacterId: 'yixiu', targetCharacterId: 'zhenhuan', requesterDisplayName: '皇后', targetDisplayName: '甄嬛',
    status: 'APPROVED', rejectionReason: null, createdAt: now, updatedAt: now, resolvedAt: now,
    actions: { canAccept: false, canReject: false, canCancel: false, canApproveBank: false },
  };
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seats({ characterId: null, playerId: null, isBank: true, activeHere: true }, [request]) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: snapshot }));

  await openRoom(page);
  await page.getByRole('button', { name: '管理席位' }).click();
  const bank = page.locator('.swap-group').filter({ has: page.getByRole('heading', { name: '银行确认' }) });
  const inbox = page.locator('.swap-group').filter({ has: page.getByRole('heading', { name: '待我处理' }) });
  await expect(bank.getByText('皇后 → 甄嬛')).toBeVisible();
  await expect(inbox.getByText('皇后 → 甄嬛')).toHaveCount(0);
});

test('settlement preview blocks, exact confirmation finishes, and immutable details show ties once each', async ({ page }) => {
  await mockBase(page, { ...baseRoom, characterId: null, myCharacter: null, isBank: true, playerCount: 0 });
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seats({ characterId: null, playerId: null, isBank: true, activeHere: true }) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: snapshot }));
  let blocked = true;
  const ranked = [
    { accountId: 'account-1', displayNameSnapshot: '甄嬛', characterNameSnapshot: '钮祜禄·甄嬛', cash: 1_000, unmortgagedPropertyValue: 3_600, mortgagedPropertyNetValue: 1_500, buildingSellValue: 1_200, totalWealth: 7_300, rank: 1, isWinner: true, propertyDetails: [{ roomPropertyId: 'property-1', nameSnapshot: '永寿宫', mortgaged: false, mortgagePriceSnapshot: 1_800, landSaleValue: 3_600, landSettlementValue: 3_600, buildingLevel: 2, buildingSellPriceSnapshot: 300, buildingSellValue: 600 }] },
    { accountId: 'account-2', displayNameSnapshot: '眉庄', characterNameSnapshot: '沈眉庄', cash: 1_000, unmortgagedPropertyValue: 3_600, mortgagedPropertyNetValue: 1_500, buildingSellValue: 1_200, totalWealth: 7_300, rank: 1, isWinner: true, propertyDetails: [] },
  ];
  await page.route('**/api/rooms/room-1/settlement/preview', (route) => route.fulfill({ json: { blockers: blocked ? [{ code: 'PENDING_ROLE_SWAP', roleSwapRequestId: 'swap-1', status: 'PENDING_BANK' }] : [], players: ranked } }));
  const finishRequests: Array<{ body: Record<string, unknown>; key?: string; auth?: string }> = [];
  const settlementSequence: string[] = [];
  await page.route('**/api/rooms/room-1/finish', async (route) => {
    settlementSequence.push('POST finish');
    finishRequests.push({ body: await body(route), key: route.request().headers()['idempotency-key'], auth: route.request().headers().authorization });
    return route.fulfill({ json: { created: true, settlement: { id: 'settlement-1', roomId: 'room-1', endedByAccountId: 'account-1', endedAt: now, totalTurns: 8, durationSeconds: 3600, forced: false, forceReason: null, winners: ['account-1', 'account-2'], ranking: ranked.map(({ accountId, rank }) => ({ accountId, rank })), overriddenBlockers: [], players: ranked } } });
  });
  await page.route('**/api/rooms/room-1/settlement', (route) => {
    settlementSequence.push('GET settlement');
    return route.fulfill({ json: { id: 'settlement-1', roomId: 'room-1', stateVersion: 1, endedByAccountId: 'account-1', endedAt: now, totalTurns: 8, durationSeconds: 3600, forced: false, forceReason: null, winners: ['account-1', 'account-2'], ranking: ranked.map(({ accountId, rank }) => ({ accountId, rank })), overriddenBlockers: [], players: ranked } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '事务' }).click();
  await page.getByRole('button', { name: '结束游戏' }).click();
  await expect(page.getByText('待处理角色交换')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认结束游戏' })).toBeDisabled();
  blocked = false;
  await page.getByRole('button', { name: '返回银行端' }).click();
  await page.getByRole('button', { name: '事务' }).click();
  await page.getByRole('button', { name: '结束游戏' }).click();
  await page.getByLabel('输入“确认结束游戏”').fill('确认结束游戏');
  await page.getByRole('button', { name: '确认结束游戏' }).click();
  await expect(page.getByText('不可变结算快照')).toBeVisible();
  await expect(page.getByText('第 1 名 · 获胜')).toHaveCount(2);
  await page.getByText('地产结算明细（1）').click();
  await expect(page.getByText('永寿宫')).toBeVisible();
  expect(finishRequests).toHaveLength(1);
  expect(finishRequests[0]).toMatchObject({ body: { confirmation: '确认结束游戏' }, auth: undefined });
  expect(finishRequests[0]?.key).toBeTruthy();
  expect(settlementSequence).toEqual(['POST finish', 'GET settlement']);
});

test('landing cards search, select a purchased property, and preserve the declaration flow', async ({ page }) => {
  const properties = [
    { name: '碎玉轩', ownerId: null, level: 0, mortgaged: false, mortgage: 800, purchasePrice: 1600, build: 1000, buildingSell: 600, tolls: [300, 700, 1800, 5000, 7000, 9000] },
    { name: '景仁宫', ownerId: 'player-2', level: 2, mortgaged: true, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1200, tolls: [800, 2000, 3900, 9000, 11000, 13000] }
  ];
  const players = [...snapshot.players, { id: 'player-2', name: '皇后', characterId: 'yixiu', balance: 5_000, remainingSkipTurns: 0 }];
  let declared: Record<string, unknown> | null = null;
  let snapshotReads = 0;
  await mockBase(page, { ...baseRoom, isBank: false });
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => {
    snapshotReads += 1;
    return route.fulfill({ json: { ...snapshot, players, properties, landings: declared ? [declared] : [] } });
  });
  await page.route('**/api/rooms/room-1/landings', async (route) => {
    expect(await body(route)).toEqual({ playerId: 'player-1', propertyName: '景仁宫' });
    declared = { id: 'landing-1', playerId: 'player-1', propertyName: '景仁宫', spaceType: 'PROPERTY', status: 'DECLARED', plotResolved: false, propertyActionsCancelled: false };
    return route.fulfill({ json: declared });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '声明落点' }).click();
  await expect(page.getByText('请选择棋子精确停留的地产。系统不会追踪棋盘位置。')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认落点' })).toBeVisible();
  const unowned = page.getByRole('button', { name: /碎玉轩.*无主/ });
  await expect(unowned.getByText('0 两', { exact: true })).toBeVisible();
  await page.getByPlaceholder('搜索地产名称').fill('不存在');
  await expect(page.getByText('没有找到匹配的地产')).toBeVisible();
  await page.getByPlaceholder('搜索地产名称').fill('景仁');
  await expect(page.getByText('碎玉轩', { exact: true })).toHaveCount(0);
  const purchased = page.getByRole('button', { name: /景仁宫.*已购.*皇后/ });
  await expect(purchased).toBeVisible();
  await expect(purchased.getByText('已抵押')).toBeVisible();
  await purchased.click();
  await expect(page.getByText('已选：景仁宫')).toBeVisible();
  await page.getByRole('button', { name: '确认落点' }).click();
  await expect.poll(() => snapshotReads).toBeGreaterThan(1);
  await expect(page.getByRole('heading', { name: '声明实体落点' })).toHaveCount(0);
  await expect(page.getByText('落点待银行确认：景仁宫')).toBeVisible();
  expect(await page.evaluate(() => [...Object.entries(localStorage), ...Object.entries(sessionStorage)].filter(([key, value]) => /auth|token|identity|membership|playerId|roomId|zhenhuan-landings|room-1|player-1/i.test(`${key}:${value}`)))).toEqual([]);
});

test('property actions use only the confirmed landing and never offer another property as a target', async ({ page }) => {
  const purchaseProperties = [
    { name: '碎玉轩', ownerId: null, level: 0, mortgaged: false, mortgage: 800, purchasePrice: 1600, build: 1000, buildingSell: 600, tolls: [300, 700, 1800, 5000, 7000, 9000] },
    { name: '景仁宫', ownerId: null, level: 0, mortgaged: false, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1200, tolls: [800, 2000, 3900, 9000, 11000, 13000] },
  ];
  const buildProperties = [
    { ...purchaseProperties[0], ownerId: 'player-1', level: 1 },
    { ...purchaseProperties[1], ownerId: 'player-1', level: 1 },
  ];
  let mode: 'BUY' | 'BUILD' = 'BUY';
  const requests: string[] = [];
  await mockBase(page, { ...baseRoom, isBank: false });
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: {
    ...snapshot,
    diceMode: 'ELECTRONIC',
    turn: { id: 'turn-1', total: 7 },
    properties: mode === 'BUY' ? purchaseProperties : buildProperties,
    landings: [{ id: 'landing-1', turnId: 'turn-1', playerId: 'player-1', propertyName: '碎玉轩', spaceType: 'PROPERTY', status: 'CONFIRMED', plotResolved: true, propertyActionsCancelled: false }],
  } }));
  await page.route('**/api/rooms/room-1/properties/**', (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { id: `request-${requests.length}` } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '购买 / 建造' }).click();
  const purchaseSheet = page.getByRole('dialog', { name: '购买或建造' });
  await expect(purchaseSheet.getByLabel('目标地产')).toHaveCount(0);
  await expect(purchaseSheet.getByText('碎玉轩', { exact: true })).toBeVisible();
  await expect(purchaseSheet.getByText('景仁宫', { exact: true })).toHaveCount(0);
  await purchaseSheet.getByRole('button', { name: '提交购买申请' }).click();
  expect(requests).toEqual(['/api/rooms/room-1/properties/%E7%A2%8E%E7%8E%89%E8%BD%A9/buy']);

  mode = 'BUILD';
  await page.reload();
  await page.getByRole('button', { name: '购买 / 建造' }).click();
  const buildSheet = page.getByRole('dialog', { name: '购买或建造' });
  await buildSheet.getByRole('button', { name: '建造升级' }).click();
  await expect(buildSheet.getByLabel('目标地产')).toHaveCount(0);
  await expect(buildSheet.getByText('碎玉轩', { exact: true })).toBeVisible();
  await expect(buildSheet.getByText('景仁宫', { exact: true })).toHaveCount(0);
  await buildSheet.getByRole('button', { name: '提交建造申请' }).click();
  expect(requests).toEqual([
    '/api/rooms/room-1/properties/%E7%A2%8E%E7%8E%89%E8%BD%A9/buy',
    '/api/rooms/room-1/properties/%E7%A2%8E%E7%8E%89%E8%BD%A9/build',
  ]);
});

test('landing-bound toll payment uses the confirmed landing and explains disabled states', async ({ page }) => {
  const payableProperty = { name: '甘露寺', ownerId: 'player-2', level: 2, mortgaged: false, mortgage: 800, purchasePrice: 1600, build: 1000, buildingSell: 600, tolls: [300, 700, 1800, 5000, 7000, 9000] };
  const otherProperty = { name: '景仁宫', ownerId: 'player-2', level: 0, mortgaged: false, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1200, tolls: [800, 2000, 3900, 9000, 11000, 13000] };
  const payablePlayers = [...snapshot.players, { id: 'player-2', name: '皇后', characterId: 'yixiu', balance: 5000, remainingSkipTurns: 0 }];
  const landing = { id: 'landing-1', turnId: 'turn-1', playerId: 'player-1', propertyName: '甘露寺', spaceType: 'PROPERTY', status: 'CONFIRMED', plotResolved: true, propertyActionsCancelled: false, tollSettled: false };
  const disabledCases = {
    'no-landing': { landings: [], property: payableProperty, players: payablePlayers, reason: '请先声明该地产落点，并由银行确认剧情已结算。' },
    unowned: { landings: [{ ...landing, tollSettled: false }], property: { ...payableProperty, ownerId: null }, players: payablePlayers, reason: '当前落点为无主地产，无需支付过路费。' },
    'self-owned': { landings: [{ ...landing, tollSettled: false }], property: { ...payableProperty, ownerId: 'player-1' }, players: payablePlayers, reason: '当前落点归你所有，无需支付过路费。' },
    mortgaged: { landings: [{ ...landing, tollSettled: false }], property: { ...payableProperty, mortgaged: true }, players: payablePlayers, reason: '当前落点地产已抵押，无需支付过路费。' },
    'owner-blocked': { landings: [{ ...landing, tollSettled: false }], property: payableProperty, players: [{ ...payablePlayers[0] }, { ...payablePlayers[1], tollCollectionBlocked: true }], reason: '地主正在冷宫中，本次免过路费。' },
    settled: { landings: [{ ...landing, tollSettled: true }], property: payableProperty, players: payablePlayers, reason: '本次过路费已经结算。' },
  } as const;
  let tollCase: keyof typeof disabledCases | 'payable' = 'payable';
  const tollRequests: string[] = [];
  await mockBase(page, { ...baseRoom, isBank: false });
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => {
    const fixture = tollCase === 'payable'
      ? { landings: [landing], property: payableProperty, players: payablePlayers }
      : disabledCases[tollCase];
    return route.fulfill({ json: {
      ...snapshot,
      diceMode: 'ELECTRONIC',
      turn: { id: 'turn-1', total: 7 },
      properties: [fixture.property, otherProperty],
      players: fixture.players,
      landings: fixture.landings,
    } });
  });
  await page.route('**/api/rooms/room-1/properties/**', (route) => {
    tollRequests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { id: 'toll-1' } });
  });

  await openRoom(page);
  await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
  const quickLabels = await page.locator('.quick-grid .quick').evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim()));
  expect(quickLabels.indexOf('支付过路费')).toBe(quickLabels.indexOf('资产操作') - 1);

  await page.getByRole('button', { name: '资产操作' }).click();
  const assetSheet = page.getByRole('dialog', { name: '资产操作' });
  await expect(assetSheet.getByRole('option', { name: '支付过路费' })).toHaveCount(0);
  await assetSheet.getByRole('button', { name: '关闭' }).click();

  await expect(page.getByRole('button', { name: '支付过路费' })).toBeEnabled();
  await page.getByRole('button', { name: '支付过路费' }).click();
  const tollSheet = page.getByRole('dialog', { name: '支付过路费' });
  await expect(tollSheet.getByLabel('目标地产')).toHaveCount(0);
  await expect(tollSheet.getByText('甘露寺', { exact: true })).toBeVisible();
  await expect(tollSheet.getByText('乌拉那拉·宜修', { exact: true })).toBeVisible();
  await expect(tollSheet.getByText('皇后', { exact: true })).toHaveCount(0);
  await expect(tollSheet.getByText('1,800 两', { exact: true })).toBeVisible();
  await tollSheet.getByRole('button', { name: '确认支付过路费' }).click();
  expect(tollRequests).toEqual(['/api/rooms/room-1/properties/%E7%94%98%E9%9C%B2%E5%AF%BA/toll']);

  for (const [name, fixture] of Object.entries(disabledCases)) {
    tollCase = name as keyof typeof disabledCases;
    await page.reload();
    const tollQuick = page.getByRole('button', { name: '支付过路费' });
    if (name === 'no-landing') {
      await expect(tollQuick).toBeDisabled();
      continue;
    }
    await tollQuick.click();
    const sheet = page.getByRole('dialog', { name: '支付过路费' });
    if (name === 'unowned') await expect(sheet.getByText('国库', { exact: true })).toBeVisible();
    await expect(sheet.getByText(fixture.reason, { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: '确认支付过路费' })).toBeDisabled();
  }
});

test('ROOM_CONTROL_LOST from a write refetches seats and routes to takeover', async ({ page }) => {
  let activeHere = true;
  let seatReads = 0;
  const actionSnapshot = { ...snapshot, players: [...snapshot.players, { id: 'player-2', name: '眉庄', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0 }] };
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockBase(page, { ...baseRoom, isBank: false });
  await page.route('**/api/rooms/room-1/seats', (route) => {
    seatReads += 1;
    return route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere }) });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: actionSnapshot }));
  await page.route('**/api/rooms/room-1/transfers', (route) => {
    activeHere = false;
    return route.fulfill({ status: 409, json: { error: 'ROOM_CONTROL_LOST' } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '转帐' }).click();
  await page.getByLabel('转帐金额').fill('100');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();
  expect(seatReads).toBeGreaterThan(1);
  await expect(page.getByText('余额')).toHaveCount(0);
});

test('ROOM_CONTROL_LOST routes a freshly finished room to settlement', async ({ page }) => {
  let finished = false;
  let seatReads = 0;
  const actionSnapshot = { ...snapshot, players: [...snapshot.players, { id: 'player-2', name: '眉庄', characterId: 'meizhuang', balance: 4_600, remainingSkipTurns: 0 }] };
  const settledPlayer = {
    accountId: 'account-1', displayNameSnapshot: '甄嬛', characterNameSnapshot: '钮祜禄·甄嬛', cash: 5_000,
    unmortgagedPropertyValue: 0, mortgagedPropertyNetValue: 0, buildingSellValue: 0, totalWealth: 5_000,
    rank: 1, isWinner: true, propertyDetails: [],
  };
  await page.route('**/socket.io/**', (route) => route.abort());
  await mockBase(page, { ...baseRoom, isBank: false });
  await page.route('**/api/rooms/room-1/seats', (route) => {
    seatReads += 1;
    return route.fulfill({
      json: seats(
        { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: !finished },
        [],
        finished ? 'FINISHED' : 'PLAYING',
      ),
    });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: actionSnapshot }));
  await page.route('**/api/rooms/room-1/transfers', (route) => {
    finished = true;
    return route.fulfill({ status: 409, json: { error: 'ROOM_CONTROL_LOST' } });
  });
  await page.route('**/api/rooms/room-1/settlement', (route) => route.fulfill({
    json: {
      id: 'settlement-1', roomId: 'room-1', stateVersion: 1, endedByAccountId: 'account-1', endedAt: now, totalTurns: 8,
      durationSeconds: 3600, forced: false, forceReason: null, winners: ['account-1'],
      ranking: [{ accountId: 'account-1', rank: 1 }], overriddenBlockers: [], players: [settledPlayer],
    },
  }));

  await openRoom(page);
  await page.getByRole('button', { name: '转帐' }).click();
  await page.getByLabel('转帐金额').fill('100');
  await page.getByRole('button', { name: '确认转帐' }).click();
  await expect(page.getByRole('heading', { name: '对局结算' })).toBeVisible();
  await expect(page.getByText('不可变结算快照')).toBeVisible();
  await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toHaveCount(0);
  expect(seatReads).toBeGreaterThan(1);
});

test.describe.serial('Cookie socket notifications', () => {
test.describe.configure({ timeout: 120_000 });
test('preserve explicit seat routing, filter room payloads, clean subscriptions, recover control, and reconnect', async ({ page }) => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    cors: { origin: 'http://localhost:3000', credentials: true },
    allowRequest: (request, callback) => callback(null, request.headers.cookie?.includes('task7_socket_test=1') ?? false),
  });
  let targetSubscriptions = 0;
  const unsubscribedRooms: string[] = [];
  const targetSocketIds = new Set<string>();
  socketServer.on('connection', (socket) => {
    targetSocketIds.add(socket.id);
    socket.on('disconnect', () => targetSocketIds.delete(socket.id));
    socket.on('room.subscribe', ({ roomId }: { roomId: string }) => {
      targetSubscriptions += 1;
      void socket.join(roomId);
    });
    socket.on('room.unsubscribe', ({ roomId }: { roomId: string }) => {
      unsubscribedRooms.push(roomId);
      void socket.leave(roomId);
    });
  });
  await listenForSocketTest(httpServer);
  await page.context().addCookies([{ name: 'task7_socket_test', value: '1', url: 'http://localhost:4000' }]);
  await mockBase(page, { ...baseRoom, status: 'LOBBY', playerCount: 0, characterId: null, myCharacter: null, isBank: false });
  let seatReads = 0;
  let snapshotReads = 0;
  let activeHere = true;
  let membership: Membership = { characterId: null, playerId: null, isBank: false, activeHere: true };
  let delayedSelectionSnapshot = false;
  await page.route('**/api/rooms/room-1/seats', (route) => {
    seatReads += 1;
    return route.fulfill({ json: {
      ...seats({ ...membership, activeHere }, [], 'LOBBY'),
      characters: characters.map((character) => character.id === 'zhenhuan'
        ? { ...character, occupiedBy: membership.characterId ? '甄嬛' : null, canSelect: membership.characterId === null }
        : character),
    } });
  });
  await page.route('**/api/rooms/room-1/snapshot*', async (route) => {
    snapshotReads += 1;
    if (membership.characterId && !delayedSelectionSnapshot) {
      delayedSelectionSnapshot = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!activeHere) return route.fulfill({ status: 409, json: { error: 'ROOM_CONTROL_LOST' } });
    return route.fulfill({ json: snapshot });
  });
  const emitToTarget = (event: string, payload: Record<string, unknown>) => {
    expect(targetSocketIds.size).toBeGreaterThan(0);
    for (const socketId of targetSocketIds) socketServer.to(socketId).emit(event, payload);
  };
  await page.route('**/api/rooms/room-1/select-character', async (route) => {
    membership = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
    emitToTarget('room.snapshot-required', { roomId: 'room-1' });
    return route.fulfill({ json: { membership: { id: 'membership-1', ...membership }, player: { id: 'player-1' } } });
  });
  try {
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect.poll(() => targetSubscriptions).toBeGreaterThan(0);
    await expect.poll(() => targetSocketIds.size).toBeGreaterThan(0);
    await expect.poll(() => seatReads).toBeGreaterThan(0);
    await page.getByRole('button', { name: '选择角色', exact: true }).click();
    await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    const beforeForeignRoom = snapshotReads;
    emitToTarget('room.snapshot-required', { roomId: 'room-2' });
    await page.waitForTimeout(250);
    expect(snapshotReads).toBe(beforeForeignRoom);
    const before = snapshotReads;
    emitToTarget('room.snapshot-required', { roomId: 'room-1', forgedBalance: 999_999 });
    await expect.poll(() => snapshotReads).toBeGreaterThan(before);
    const beforeReconnect = targetSubscriptions;
    const snapshotsBeforeReconnect = snapshotReads;
    for (const socketId of targetSocketIds) socketServer.sockets.sockets.get(socketId)?.conn.close();
    await expect.poll(() => targetSubscriptions, { timeout: 8_000 }).toBeGreaterThan(beforeReconnect);
    await expect.poll(() => targetSocketIds.size).toBeGreaterThan(0);
    await expect.poll(() => snapshotReads).toBeGreaterThan(snapshotsBeforeReconnect);
    activeHere = false;
    emitToTarget('room.snapshot-required', { roomId: 'room-1' });
    await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();
    await page.getByRole('button', { name: '返回房间列表' }).click();
    await expect(page.getByText('当前账号')).toBeVisible();
    await expect.poll(() => unsubscribedRooms).toContain('room-1');
    const readsAfterLeave = snapshotReads;
    emitToTarget('room.snapshot-required', { roomId: 'room-1' });
    await page.waitForTimeout(250);
    expect(snapshotReads).toBe(readsAfterLeave);
    await expect(page.getByText('当前账号')).toBeVisible();
    emitToTarget('account.session.revoked', { reason: 'ADMIN_REVOKED' });
    await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
  } finally {
    await page.close();
    await socketServer.close();
  }
});

test('retries the current room subscription after rejection and reverse control changes', async ({ page }) => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    cors: { origin: 'http://localhost:3000', credentials: true },
    allowRequest: (request, callback) => callback(null, request.headers.cookie?.includes('task7_control_recovery=1') ?? false),
  });
  const socketIds = new Set<string>();
  let activeHere = false;
  let subscribeAttempts = 0;
  let acceptedSubscriptions = 0;
  socketServer.on('connection', (socket) => {
    socketIds.add(socket.id);
    socket.on('disconnect', () => socketIds.delete(socket.id));
    socket.on('room.subscribe', ({ roomId }: { roomId: string }) => {
      subscribeAttempts += 1;
      if (!activeHere) {
        socket.emit('room.subscription-rejected', { roomId });
        return;
      }
      acceptedSubscriptions += 1;
      void socket.join(roomId);
    });
    socket.on('room.unsubscribe', ({ roomId }: { roomId: string }) => { void socket.leave(roomId); });
  });
  await listenForSocketTest(httpServer);
  await page.context().addCookies([{ name: 'task7_control_recovery', value: '1', url: 'http://localhost:4000' }]);
  await mockBase(page, { ...baseRoom, isBank: false });
  let seatReads = 0;
  await page.route('**/api/rooms/room-1/seats', (route) => {
    seatReads += 1;
    return route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere }) });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => {
    if (!activeHere) return route.fulfill({ status: 409, json: { error: 'ROOM_CONTROL_LOST' } });
    return route.fulfill({ json: snapshot });
  });
  await page.route('**/api/rooms/room-1/take-control', (route) => {
    activeHere = true;
    return route.fulfill({ json: { stateVersion: 2 } });
  });

  try {
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();
    await expect.poll(() => subscribeAttempts).toBeGreaterThan(0);

    await page.getByRole('button', { name: '接管本房间' }).click();
    await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
    await expect.poll(() => acceptedSubscriptions).toBe(1);

    const readsBeforeControlLoss = seatReads;
    activeHere = false;
    for (const socketId of socketIds) {
      const socket = socketServer.sockets.sockets.get(socketId);
      void socket?.leave('room-1');
      socket?.emit('room.control.changed', { roomId: 'room-1' });
    }
    await expect.poll(() => seatReads).toBeGreaterThan(readsBeforeControlLoss);
    await expect(page.getByRole('heading', { name: '该房间已在另一台设备打开' })).toBeVisible();

    await page.getByRole('button', { name: '接管本房间' }).click();
    await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
    await expect.poll(() => acceptedSubscriptions).toBe(2);
  } finally {
    await page.close();
    socketServer.disconnectSockets(true);
    await socketServer.close();
  }
});

test('returns a member removed at start to the room list', async ({ page }) => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    cors: { origin: 'http://localhost:3000', credentials: true },
    allowRequest: (request, callback) => callback(null, request.headers.cookie?.includes('task7_start_removal=1') ?? false),
  });
  const socketIds = new Set<string>();
  let removed = false;
  socketServer.on('connection', (socket) => {
    socketIds.add(socket.id);
    socket.on('disconnect', () => socketIds.delete(socket.id));
    socket.on('room.subscribe', ({ roomId }: { roomId: string }) => { void socket.join(roomId); });
    socket.on('room.unsubscribe', ({ roomId }: { roomId: string }) => { void socket.leave(roomId); });
  });
  await listenForSocketTest(httpServer);
  await page.context().addCookies([{ name: 'task7_start_removal', value: '1', url: 'http://localhost:4000' }]);
  const lobbyRoom = {
    ...baseRoom,
    status: 'LOBBY' as const,
    characterId: null,
    myCharacter: null,
    isBank: false,
  };
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: removed ? [] : [lobbyRoom] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({
    json: removed ? [{ ...lobbyRoom, status: 'PLAYING', mine: false }] : [lobbyRoom],
  }));
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({
    json: seats({ characterId: null, playerId: null, isBank: false, activeHere: true }, [], 'LOBBY'),
  }));

  try {
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect(page).toHaveURL(/\/rooms\/room-1\/seats$/);
    await expect.poll(() => socketIds.size).toBeGreaterThan(0);

    removed = true;
    for (const socketId of socketIds) {
      socketServer.sockets.sockets.get(socketId)?.emit('room.subscription-rejected', {
        roomId: 'room-1',
        reason: 'ROOM_STARTED_WITHOUT_CAPABILITY',
      });
    }

    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByRole('alert')).toContainText(
      '游戏已开始，你因未选择人物或银行身份已退出房间',
    );
    await expect(page.getByRole('region', { name: '我参与的游戏' }))
      .not.toContainText('碎玉轩夜局');
    await expect(page.getByRole('region', { name: '可加入房间' }))
      .toContainText('碎玉轩夜局');
  } finally {
    await page.close();
    socketServer.disconnectSockets(true);
    await socketServer.close();
  }
});

test('socket seat refresh applies global session invalidation', async ({ page }) => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    cors: { origin: 'http://localhost:3000', credentials: true },
    allowRequest: (request, callback) => callback(null, request.headers.cookie?.includes('task7_auth_socket=1') ?? false),
  });
  const targetSocketIds = new Set<string>();
  socketServer.on('connection', (socket) => {
    targetSocketIds.add(socket.id);
    socket.on('disconnect', () => targetSocketIds.delete(socket.id));
    socket.on('room.subscribe', ({ roomId }: { roomId: string }) => { void socket.join(roomId); });
    socket.on('room.unsubscribe', ({ roomId }: { roomId: string }) => { void socket.leave(roomId); });
  });
  await listenForSocketTest(httpServer);
  await page.context().addCookies([{ name: 'task7_auth_socket', value: '1', url: 'http://localhost:4000' }]);
  await mockBase(page, { ...baseRoom, isBank: false });
  let sessionInvalid = false;
  let invalidSnapshotReads = 0;
  await page.route('**/api/rooms/room-1/seats', (route) => {
    return route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }) });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => {
    if (sessionInvalid) {
      invalidSnapshotReads += 1;
      return route.fulfill({ status: 401, json: { error: 'SESSION_INVALID' } });
    }
    return route.fulfill({ json: snapshot });
  });

  try {
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
    await expect.poll(() => targetSocketIds.size).toBeGreaterThan(0);

    sessionInvalid = true;
    for (const socketId of targetSocketIds) socketServer.to(socketId).emit('room.snapshot-required', { roomId: 'room-1' });
    await expect.poll(() => invalidSnapshotReads).toBeGreaterThan(0);

    await expect(page.getByRole('heading', { name: '账号登录' })).toBeVisible();
    await expect(page.getByText('登录已失效，请重新登录')).toBeVisible();
  } finally {
    await page.close();
    await socketServer.close();
  }
});

test('versioned game notifications refresh the authoritative snapshot without rereading seats', async ({ page }) => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    cors: { origin: 'http://localhost:3000', credentials: true },
    allowRequest: (request, callback) => callback(null, request.headers.cookie?.includes('task7_versioned_socket=1') ?? false),
  });
  const socketIds = new Set<string>();
  socketServer.on('connection', (socket) => {
    socketIds.add(socket.id);
    socket.on('disconnect', () => socketIds.delete(socket.id));
    socket.on('room.subscribe', ({ roomId }: { roomId: string }) => { void socket.join(roomId); });
    socket.on('room.unsubscribe', ({ roomId }: { roomId: string }) => { void socket.leave(roomId); });
  });
  await listenForSocketTest(httpServer);
  await page.context().addCookies([{ name: 'task7_versioned_socket', value: '1', url: 'http://localhost:4000' }]);
  await mockBase(page, { ...baseRoom, isBank: false });
  let seatsReads = 0;
  let snapshotReads = 0;
  let stateVersion = 1;
  await page.route('**/api/rooms/room-1/seats', (route) => {
    seatsReads += 1;
    return route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }) });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => {
    snapshotReads += 1;
    return route.fulfill({ json: { ...snapshot, stateVersion, players: [{ ...snapshot.players[0], balance: stateVersion === 1 ? 5_000 : 6_400 }] } });
  });

  try {
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
    await expect.poll(() => socketIds.size).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    const seatsBeforeNotification = seatsReads;
    const snapshotsBeforeNotification = snapshotReads;

    stateVersion = 2;
    for (const socketId of socketIds) socketServer.to(socketId).emit('room.snapshot-required', { roomId: 'room-1', stateVersion });

    await expect.poll(() => snapshotReads).toBeGreaterThan(snapshotsBeforeNotification);
    await expect(page.getByText('6,400 两')).toBeVisible();
    await page.waitForTimeout(150);
    expect(seatsReads).toBe(seatsBeforeNotification);
  } finally {
    await page.close();
    await socketServer.close();
  }
});

test('newer snapshot versions win over delayed replies and page recovery signals refresh once', async ({ page }) => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    cors: { origin: 'http://localhost:3000', credentials: true },
    allowRequest: (request, callback) => callback(null, request.headers.cookie?.includes('task7_recovery_socket=1') ?? false),
  });
  const socketIds = new Set<string>();
  socketServer.on('connection', (socket) => {
    socketIds.add(socket.id);
    socket.on('disconnect', () => socketIds.delete(socket.id));
    socket.on('room.subscribe', ({ roomId }: { roomId: string }) => { void socket.join(roomId); });
    socket.on('room.unsubscribe', ({ roomId }: { roomId: string }) => { void socket.leave(roomId); });
  });
  await listenForSocketTest(httpServer);
  await page.context().addCookies([{ name: 'task7_recovery_socket', value: '1', url: 'http://localhost:4000' }]);
  await mockBase(page, { ...baseRoom, isBank: false });
  let seatsReads = 0;
  let snapshotReads = 0;
  let responseVersion = 1;
  let holdVersionTwo = false;
  let delayedVersionTwoStarted = false;
  let releaseVersionTwo: (() => void) | null = null;
  await page.route('**/api/rooms/room-1/seats', (route) => {
    seatsReads += 1;
    return route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }) });
  });
  await page.route('**/api/rooms/room-1/snapshot*', async (route) => {
    snapshotReads += 1;
    const version = responseVersion;
    if (version === 2 && holdVersionTwo) {
      delayedVersionTwoStarted = true;
      await new Promise<void>((resolve) => { releaseVersionTwo = resolve; });
    }
    return route.fulfill({ json: { ...snapshot, stateVersion: version, players: [{ ...snapshot.players[0], balance: version === 3 ? 6_400 : 5_200 }] } });
  });
  const emitSnapshotRequired = (stateVersion: number) => {
    for (const socketId of socketIds) socketServer.to(socketId).emit('room.snapshot-required', { roomId: 'room-1', stateVersion });
  };

  try {
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
    await expect.poll(() => socketIds.size).toBeGreaterThan(0);
    const seatsAfterOpen = seatsReads;

    responseVersion = 2;
    holdVersionTwo = true;
    emitSnapshotRequired(2);
    await expect.poll(() => delayedVersionTwoStarted).toBe(true);

    responseVersion = 3;
    emitSnapshotRequired(3);
    await expect(page.getByText('6,400 两')).toBeVisible();
    releaseVersionTwo?.();
    await page.waitForTimeout(150);
    await expect(page.getByText('6,400 两')).toBeVisible();
    expect(seatsReads).toBe(seatsAfterOpen);

    const snapshotsBeforeStaleNotification = snapshotReads;
    emitSnapshotRequired(2);
    await page.waitForTimeout(150);
    expect(snapshotReads).toBe(snapshotsBeforeStaleNotification);

    for (const event of ['online', 'pageshow', 'visibilitychange']) {
      const before = snapshotReads;
      await page.evaluate((name) => {
        const target = name === 'visibilitychange' ? document : window;
        target.dispatchEvent(new Event(name));
      }, event);
      await expect.poll(() => snapshotReads).toBeGreaterThan(before);
      await page.waitForTimeout(150);
      expect(snapshotReads).toBe(before + 1);
    }
  } finally {
    await page.close();
    socketServer.disconnectSockets(true);
    await socketServer.close();
  }
});

test('FINISH closes before routing after BANK authority loss even when the destination snapshot fails', async ({ page }) => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    cors: { origin: 'http://localhost:3000', credentials: true },
    allowRequest: (request, callback) => callback(null, request.headers.cookie?.includes('task7_finish_socket=1') ?? false),
  });
  const targetSocketIds = new Set<string>();
  socketServer.on('connection', (socket) => {
    targetSocketIds.add(socket.id);
    socket.on('disconnect', () => targetSocketIds.delete(socket.id));
    socket.on('room.subscribe', ({ roomId }: { roomId: string }) => { void socket.join(roomId); });
    socket.on('room.unsubscribe', ({ roomId }: { roomId: string }) => { void socket.leave(roomId); });
  });
  await listenForSocketTest(httpServer);
  await page.context().addCookies([{ name: 'task7_finish_socket', value: '1', url: 'http://localhost:4000' }]);
  await mockBase(page, { ...baseRoom, characterId: null, myCharacter: null, isBank: true, playerCount: 1 });
  let membership: Membership = { characterId: null, playerId: null, isBank: true, activeHere: true };
  let seatReads = 0;
  let failPlayerSnapshot = false;
  const snapshotViews: Array<string | null> = [];
  await page.route('**/api/rooms/room-1/seats', (route) => {
    seatReads += 1;
    return route.fulfill({ json: {
      ...seats(membership),
      room: { id: 'room-1', name: baseRoom.name, status: 'PLAYING', skillEnabled: true },
    } });
  });
  await page.route('**/api/rooms/room-1/snapshot*', (route) => {
    const view = new URL(route.request().url()).searchParams.get('view');
    snapshotViews.push(view);
    if (!membership.isBank && view === 'BANK') return route.fulfill({ status: 403, json: { error: 'BANK_REQUIRED' } });
    if (failPlayerSnapshot && view === 'PLAYER') return route.fulfill({ status: 503, json: { error: 'SNAPSHOT_UNAVAILABLE' } });
    return route.fulfill({ json: { ...snapshot, startReward: 1_000 } });
  });
  await page.route('**/api/rooms/room-1/settlement/preview', (route) => route.fulfill({ json: { blockers: [], players: [] } }));

  try {
    await page.goto('http://localhost:3000/');
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect(page.getByRole('heading', { name: '银行端', exact: true })).toBeVisible();
    await expect.poll(() => targetSocketIds.size).toBeGreaterThan(0);
    await page.getByRole('button', { name: '事务' }).click();
    await page.getByRole('button', { name: '结束游戏' }).click();
    await expect(page.getByRole('heading', { name: '结束游戏', exact: true })).toBeVisible();

    const readsBeforeLoss = seatReads;
    membership = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true };
    failPlayerSnapshot = true;
    for (const socketId of targetSocketIds) socketServer.to(socketId).emit('room.snapshot-required', { roomId: 'room-1' });

    await expect.poll(() => seatReads).toBeGreaterThan(readsBeforeLoss);
    await expect(page.getByRole('heading', { name: '结束游戏', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '选择席位', exact: true })).toBeVisible();

    failPlayerSnapshot = false;
    await page.getByRole('button', { name: '房间列表', exact: true }).click();
    await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
    await expect(page.getByRole('heading', { name: '玩家端', exact: true })).toBeVisible();
    expect(snapshotViews.at(-1)).toBe('PLAYER');
  } finally {
    await page.close();
    socketServer.disconnectSockets(true);
    await socketServer.close();
  }
});
});
