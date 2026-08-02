import { expect, test, type Page } from '@playwright/test';
import type {
  BrowserRoomSummary,
  BrowserSeatSnapshot,
  BrowserSnapshot,
} from './browser-fixture-types';

const account = {
  id: 'a1',
  username: 'zhenhuan',
  displayName: '甄嬛',
  isSuperAdmin: false,
  canCreateRoom: false,
  lastLoginAt: '2026-08-01T08:00:00.000Z',
};

const room: BrowserRoomSummary = {
  id: 'r1',
  name: '碎玉轩夜局',
  status: 'PLAYING',
  creator: '甄嬛',
  memberCount: 2,
  playerCount: 2,
  playerLimit: 5,
  hasPassword: false,
  mine: true,
  characterId: 'zhenhuan',
  myCharacter: '钮祜禄·甄嬛',
  isBank: true,
};

const snapshot: BrowserSnapshot = {
  id: 'r1',
  stateVersion: 1,
  code: 'SYX',
  name: room.name,
  status: 'PLAYING',
  diceMode: 'PHYSICAL',
  redemptionFee: 500,
  startReward: 1_000,
  currentPlayerId: 'p1',
  turn: null,
  players: [
    {
      id: 'p1',
      name: '甄嬛',
      characterId: 'zhenhuan',
      balance: 5_000,
      remainingSkipTurns: 0,
    },
    {
      id: 'p2',
      name: '眉庄',
      characterId: 'meizhuang',
      balance: 3_200,
      remainingSkipTurns: 0,
    },
  ],
  properties: [
    {
      name: '碎玉轩',
      ownerId: 'p1',
      level: 1,
      mortgaged: false,
      mortgage: 1_000,
      purchasePrice: 2_000,
      build: 500,
      buildingSell: 300,
      tolls: [100, 200, 300, 400, 500, 600],
    },
    {
      name: '永寿宫',
      ownerId: 'p1',
      level: 4,
      mortgaged: true,
      mortgage: 1_000,
      purchasePrice: 2_000,
      build: 500,
      buildingSell: 300,
      tolls: [100, 200, 300, 400, 500, 600],
    },
    {
      name: '寿康宫',
      ownerId: 'p1',
      level: 5,
      mortgaged: false,
      mortgage: 1_000,
      purchasePrice: 2_000,
      build: 500,
      buildingSell: 300,
      tolls: [100, 200, 300, 400, 500, 600],
    },
  ],
  ledger: [],
  requests: [],
  landings: [],
  audit: [],
  reversalCandidate: null,
};

async function mockOverviewRoom(page: Page) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { account, sessions: [] } }),
  );
  await page.route('**/api/rooms/mine', (route) =>
    route.fulfill({ json: [room] }),
  );
  await page.route('**/api/rooms/history', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/rooms', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/rooms/r1/seats', (route) => {
    const seats: BrowserSeatSnapshot = {
      stateVersion: 1,
      room: {
        id: 'r1',
        name: room.name,
        status: 'PLAYING',
        skillEnabled: true,
      },
      membership: {
        id: 'm1',
        characterId: 'zhenhuan',
        playerId: 'p1',
        isBank: true,
        activeHere: true,
      },
      characters: [],
      bank: { occupiedBy: '甄嬛' },
      roleSwapRequests: [],
    };
    return route.fulfill({ json: seats });
  });
  await page.route('**/api/rooms/r1/snapshot*', (route) =>
    route.fulfill({ json: snapshot }),
  );
}

test('玩家与银行概览共享只读资产 Accordion 和地产组件', async ({ page }) => {
  await mockOverviewRoom(page);
  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '玩家端', exact: true }).click();

  await page.getByRole('button', { name: '概览', exact: true }).click();
  await expect(page.getByText('玩家资产概览', { exact: true })).toBeVisible();
  await expect(page.getByText('2 人', { exact: true })).toBeVisible();

  const zhenhuan = page.getByRole('button', { name: '甄嬛资产详情' });
  const meizhuang = page.getByRole('button', { name: '眉庄资产详情' });
  await expect(zhenhuan).toHaveAttribute('aria-expanded', 'false');
  await expect(zhenhuan).toContainText('5,000 两');
  await expect(zhenhuan).toContainText('3 块');
  await expect(zhenhuan).toContainText('5 栋');
  await expect(zhenhuan).toContainText('1 座');

  await zhenhuan.click();
  await expect(zhenhuan).toHaveAttribute('aria-expanded', 'true');
  const playerRegion = page.getByRole('region', { name: '甄嬛资产详情' });
  await expect(playerRegion.locator('.landing-property-card')).toHaveCount(3);
  await playerRegion.getByRole('button', { name: /碎玉轩/ }).click();
  await expect(playerRegion.getByText('价格信息')).toBeVisible();
  await expect(playerRegion.getByText('确认地产修正')).toHaveCount(0);

  await meizhuang.click();
  await expect(zhenhuan).toHaveAttribute('aria-expanded', 'false');
  await expect(meizhuang).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('region', { name: '眉庄资产详情' })
      .getByText('没有找到匹配的地产'),
  ).toBeVisible();

  await page.getByRole('button', { name: '银行端', exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/r1\/bank$/);
  const bankZhenhuan = page.getByRole('button', { name: '甄嬛资产详情' });
  await bankZhenhuan.click();
  const bankRegion = page.getByRole('region', { name: '甄嬛资产详情' });
  await expect(bankRegion.locator('.landing-property-card')).toHaveCount(3);
  await expect(bankRegion.getByText('确认地产修正')).toHaveCount(0);
});
