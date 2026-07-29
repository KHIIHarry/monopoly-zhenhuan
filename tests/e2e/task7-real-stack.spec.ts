import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { hashPassword } from '../../apps/api/src/auth-domain.js';

const enabled = process.env.TASK7_REAL_STACK === '1';

type RealStackConfig = {
  usernamePrefix: string;
  password: string;
  roomNamePrefix: string;
  apiUrl: string;
  schema: string;
  cleanupDatabaseUrl: string;
};

type RoomReference = { id: string; name: string };
type VersionedResult = { stateVersion: number; [key: string]: unknown };
type GameSnapshot = {
  stateVersion: number;
  players: Array<{ id: string; balance: number }>;
  [key: string]: unknown;
};
type SessionView = { id: string; current: boolean };
type SnapshotCounter = { requests: number; responses: number };

function requireRealStackConfig(): RealStackConfig {
  const usernamePrefix = process.env.TASK7_REAL_USERNAME?.trim();
  const password = process.env.TASK7_REAL_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!usernamePrefix || !password || !databaseUrl || !apiUrl) {
    throw new Error('TASK7_REAL_STACK requires explicit TASK7_REAL_USERNAME, TASK7_REAL_PASSWORD, DATABASE_URL, and NEXT_PUBLIC_API_URL.');
  }
  if (password.length < 8) throw new Error('TASK7_REAL_PASSWORD must contain at least 8 characters.');

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol.');
  }
  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.replace(/^\//, ''));
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Task 7 real-stack refused database "${databaseName}": the database name must end in _test.`);
  }
  const schema = parsedDatabaseUrl.searchParams.get('schema') ?? '';
  if (!/^task7_real_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`Task 7 real-stack refused schema "${schema}": expected ^task7_real_[a-z0-9_]+$.`);
  }
  const cleanupDatabaseUrl = new URL(parsedDatabaseUrl);
  cleanupDatabaseUrl.searchParams.set('schema', 'public');

  let parsedApiUrl: URL;
  try {
    parsedApiUrl = new URL(apiUrl);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL must be a valid URL.');
  }
  if (parsedApiUrl.origin !== 'http://localhost:4000' || parsedApiUrl.pathname !== '/') {
    throw new Error('TASK7_REAL_STACK requires NEXT_PUBLIC_API_URL=http://localhost:4000 so the Secure Cookie is shared with the localhost page origin.');
  }

  return {
    usernamePrefix,
    password,
    roomNamePrefix: (process.env.TASK7_REAL_ROOM_NAME ?? 'Task 7 PostgreSQL disposable room').trim().slice(0, 36),
    apiUrl: parsedApiUrl.origin,
    schema,
    cleanupDatabaseUrl: cleanupDatabaseUrl.toString(),
  };
}

const config = enabled ? requireRealStackConfig() : null;

async function dropIsolatedSchema(schema: string, cleanupDatabaseUrl: string) {
  if (!/^task7_real_[a-z0-9_]+$/.test(schema)) throw new Error(`TASK7_REAL_STACK_CLEANUP_REFUSED:${schema}`);
  const cleanupDatabase = new PrismaClient({ datasources: { db: { url: cleanupDatabaseUrl } } });
  try {
    await cleanupDatabase.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const result = await cleanupDatabase.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${schema}) AS "exists"
    `;
    if (result[0]?.exists !== false) throw new Error(`TASK7_REAL_STACK_SCHEMA_CLEANUP_FAILED:${schema}`);
  } finally {
    await cleanupDatabase.$disconnect();
  }
}

async function responseJson<T>(response: Awaited<ReturnType<APIRequestContext['get']>>, label: string): Promise<T> {
  if (!response.ok()) throw new Error(`${label} failed with ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function getJson<T>(context: BrowserContext, apiUrl: string, path: string): Promise<T> {
  return responseJson<T>(await context.request.get(`${apiUrl}${path}`), `GET ${path}`);
}

async function postJson<T>(context: BrowserContext, apiUrl: string, path: string, data: unknown, key: string): Promise<T> {
  const response = await context.request.post(`${apiUrl}${path}`, {
    data,
    headers: { 'idempotency-key': key },
  });
  return responseJson<T>(response, `POST ${path}`);
}

async function login(page: Page, username: string, password: string, apiUrl: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '加入游戏组' }).click();
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText(`@${username}`)).toBeVisible();

  const cookie = (await page.context().cookies(apiUrl)).find((item) => item.name === 'zhenhuan_session');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
  expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(29 * 24 * 60 * 60);
}

async function openRoom(page: Page, roomName: string, expectedWorkbench: '银行端' | '玩家端') {
  await page.goto('/');
  await expect(page.getByText('当前账号')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(roomName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await expect(page.getByRole('heading', { name: expectedWorkbench, exact: true })).toBeVisible();
}

function observeSnapshots(page: Page, apiUrl: string, roomId: string): SnapshotCounter {
  const expectedPath = `/api/rooms/${roomId}/snapshot`;
  const counter: SnapshotCounter = { requests: 0, responses: 0 };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === apiUrl && url.pathname === expectedPath) counter.requests += 1;
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === apiUrl && url.pathname === expectedPath && response.ok()) counter.responses += 1;
  });
  return counter;
}

const displayedBalance = (page: Page) => page.locator('.identity-band .balance strong');
const formattedBalance = (value: number) => `${value.toLocaleString('zh-CN')} 两`;

async function settleRenderedState(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test.describe('Task 7 real Cookie/API/PostgreSQL realtime gate', () => {
  test.skip(!enabled, 'Set TASK7_REAL_STACK=1 with explicit credentials and an isolated *_test/task7_real_* database schema.');

  test('real bank and two H5 players converge, isolate rooms, reconnect, reject stale snapshots, replay safely, and revoke a device', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'The guarded real-stack workflow owns its disposable schema and runs once in desktop-chromium.');
    test.setTimeout(180_000);
    if (!config) throw new Error('TASK7_REAL_STACK_CONFIG_MISSING');

    const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`.toLowerCase();
    const usernameBase = `${config.usernamePrefix.slice(0, 50)}-${runId}`;
    const usernames = {
      bank: `${usernameBase}-bank`,
      playerOne: `${usernameBase}-p1`,
      playerTwo: `${usernameBase}-p2`,
    };
    const roomName = `${config.roomNamePrefix.slice(0, 39 - runId.length)} ${runId}`;
    const isolationRoomName = `Task 7 isolation ${runId}`.slice(0, 40);
    const database = new PrismaClient();
    const contexts: BrowserContext[] = [];
    const mobileContext = async () => {
      const context = await browser.newContext({
        baseURL: 'http://localhost:3000',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      });
      contexts.push(context);
      return context;
    };

    try {
      const passwordHash = await hashPassword(config.password);
      const [bankAccount, playerOneAccount, playerTwoAccount] = await Promise.all([
        database.account.create({ data: { username: usernames.bank, passwordHash, displayName: `Bank ${runId}`, canCreateRoom: true, note: `Disposable Task 7 real-stack bank ${runId}` } }),
        database.account.create({ data: { username: usernames.playerOne, passwordHash, displayName: `Player one ${runId}`, note: `Disposable Task 7 real-stack player one ${runId}` } }),
        database.account.create({ data: { username: usernames.playerTwo, passwordHash, displayName: `Player two ${runId}`, note: `Disposable Task 7 real-stack player two ${runId}` } }),
      ]);

      const [bankContext, playerOneContext, playerTwoContext] = await Promise.all([
        mobileContext(), mobileContext(), mobileContext(),
      ]);
      const [bankPage, playerOnePage, playerTwoPage] = await Promise.all([
        bankContext.newPage(), playerOneContext.newPage(), playerTwoContext.newPage(),
      ]);
      await Promise.all([
        login(bankPage, usernames.bank, config.password, config.apiUrl),
        login(playerOnePage, usernames.playerOne, config.password, config.apiUrl),
        login(playerTwoPage, usernames.playerTwo, config.password, config.apiUrl),
      ]);

      const room = await postJson<RoomReference>(bankContext, config.apiUrl, '/api/rooms', {
        name: roomName,
        initialBalance: 5_000,
        diceMode: 'PHYSICAL',
        skillEnabled: true,
        startReward: 1_000,
        allowMidgameJoin: false,
        visibility: 'PUBLIC',
        transferApprovalRequired: false,
      }, `create-primary-${runId}`);
      const isolationRoom = await postJson<RoomReference>(bankContext, config.apiUrl, '/api/rooms', {
        name: isolationRoomName,
        initialBalance: 5_000,
        diceMode: 'PHYSICAL',
        skillEnabled: true,
        startReward: 1_000,
        allowMidgameJoin: false,
        visibility: 'PUBLIC',
        transferApprovalRequired: false,
      }, `create-isolation-${runId}`);

      await Promise.all([
        postJson(bankContext, config.apiUrl, `/api/rooms/${room.id}/join`, {}, `join-bank-${runId}`),
        postJson(playerOneContext, config.apiUrl, `/api/rooms/${room.id}/join`, {}, `join-p1-${runId}`),
        postJson(playerTwoContext, config.apiUrl, `/api/rooms/${room.id}/join`, {}, `join-p2-${runId}`),
        postJson(bankContext, config.apiUrl, `/api/rooms/${isolationRoom.id}/join`, {}, `join-isolation-${runId}`),
      ]);
      await Promise.all([
        postJson(bankContext, config.apiUrl, `/api/rooms/${room.id}/select-bank`, {}, `bank-primary-${runId}`),
        postJson(playerOneContext, config.apiUrl, `/api/rooms/${room.id}/select-character`, { characterId: 'zhenhuan' }, `character-p1-${runId}`),
        postJson(playerTwoContext, config.apiUrl, `/api/rooms/${room.id}/select-character`, { characterId: 'huashifei' }, `character-p2-${runId}`),
        postJson(bankContext, config.apiUrl, `/api/rooms/${isolationRoom.id}/select-bank`, {}, `bank-isolation-${runId}`),
      ]);
      const started = await postJson<GameSnapshot>(bankContext, config.apiUrl, `/api/rooms/${room.id}/start`, {}, `start-${runId}`);
      expect(started).toMatchObject({ stateVersion: expect.any(Number) });

      const persistedRoom = await database.room.findUniqueOrThrow({
        where: { id: room.id },
        include: { members: { include: { player: true } } },
      });
      expect(persistedRoom.status).toBe('PLAYING');
      expect(persistedRoom.members).toHaveLength(3);
      expect(persistedRoom.members.find((member) => member.accountId === bankAccount.id)).toMatchObject({ isBank: true, characterId: null });
      expect(persistedRoom.members.find((member) => member.accountId === playerOneAccount.id)).toMatchObject({ isBank: false, characterId: 'zhenhuan' });
      expect(persistedRoom.members.find((member) => member.accountId === playerTwoAccount.id)).toMatchObject({ isBank: false, characterId: 'huashifei' });
      const playerOne = persistedRoom.members.find((member) => member.accountId === playerOneAccount.id)?.player;
      const playerTwo = persistedRoom.members.find((member) => member.accountId === playerTwoAccount.id)?.player;
      expect(playerOne).toBeTruthy();
      expect(playerTwo).toBeTruthy();

      const bankSnapshots = observeSnapshots(bankPage, config.apiUrl, room.id);
      const playerOneSnapshots = observeSnapshots(playerOnePage, config.apiUrl, room.id);
      const playerTwoSnapshots = observeSnapshots(playerTwoPage, config.apiUrl, room.id);
      const isolationRoomPage = await bankContext.newPage();
      const isolationSnapshots = observeSnapshots(isolationRoomPage, config.apiUrl, isolationRoom.id);
      await Promise.all([
        openRoom(bankPage, roomName, '银行端'),
        openRoom(playerOnePage, roomName, '玩家端'),
        openRoom(playerTwoPage, roomName, '玩家端'),
        openRoom(isolationRoomPage, isolationRoomName, '银行端'),
      ]);
      await Promise.all([
        expect.poll(() => bankSnapshots.responses).toBeGreaterThan(0),
        expect.poll(() => playerOneSnapshots.responses).toBeGreaterThan(0),
        expect.poll(() => playerTwoSnapshots.responses).toBeGreaterThan(0),
        expect.poll(() => isolationSnapshots.responses).toBeGreaterThan(0),
      ]);
      await Promise.all([
        expect.poll(() => bankSnapshots.requests - bankSnapshots.responses).toBe(0),
        expect.poll(() => playerOneSnapshots.requests - playerOneSnapshots.responses).toBe(0),
        expect.poll(() => playerTwoSnapshots.requests - playerTwoSnapshots.responses).toBe(0),
        expect.poll(() => isolationSnapshots.requests - isolationSnapshots.responses).toBe(0),
      ]);
      await settleRenderedState(isolationRoomPage);

      const isolationBaseline = isolationSnapshots.requests;
      const p1FirstBaseline = { one: playerOneSnapshots.responses, two: playerTwoSnapshots.responses, bank: bankSnapshots.responses };
      await postJson<VersionedResult>(bankContext, config.apiUrl, `/api/rooms/${room.id}/bank/adjust-balance`, {
        playerId: playerOne!.id, amount: 111, reason: 'real-stack initial player-one adjustment',
      }, `adjust-initial-p1-${runId}`);
      await Promise.all([
        expect.poll(() => playerOneSnapshots.responses).toBeGreaterThan(p1FirstBaseline.one),
        expect.poll(() => playerTwoSnapshots.responses).toBeGreaterThan(p1FirstBaseline.two),
        expect.poll(() => bankSnapshots.responses).toBeGreaterThan(p1FirstBaseline.bank),
      ]);

      const p2FirstBaseline = { one: playerOneSnapshots.responses, two: playerTwoSnapshots.responses, bank: bankSnapshots.responses };
      await postJson<VersionedResult>(bankContext, config.apiUrl, `/api/rooms/${room.id}/bank/adjust-balance`, {
        playerId: playerTwo!.id, amount: 222, reason: 'real-stack initial player-two adjustment',
      }, `adjust-initial-p2-${runId}`);
      await Promise.all([
        expect.poll(() => playerOneSnapshots.responses).toBeGreaterThan(p2FirstBaseline.one),
        expect.poll(() => playerTwoSnapshots.responses).toBeGreaterThan(p2FirstBaseline.two),
        expect.poll(() => bankSnapshots.responses).toBeGreaterThan(p2FirstBaseline.bank),
        expect(displayedBalance(playerOnePage)).toHaveText(formattedBalance(5_111)),
        expect(displayedBalance(playerTwoPage)).toHaveText(formattedBalance(5_222)),
      ]);
      await settleRenderedState(isolationRoomPage);
      expect(isolationSnapshots.requests).toBe(isolationBaseline);

      const staleSnapshot = await getJson<GameSnapshot>(playerOneContext, config.apiUrl, `/api/rooms/${room.id}/snapshot?view=PLAYER`);
      expect(staleSnapshot.players.find((player) => player.id === playerOne!.id)?.balance).toBe(5_111);
      let staleSnapshotsInjected = 0;
      await playerOnePage.route(`**/api/rooms/${room.id}/snapshot*`, async (route) => {
        staleSnapshotsInjected += 1;
        await route.fulfill({ json: staleSnapshot });
      }, { times: 1 });
      const staleBaseline = { one: playerOneSnapshots.responses, two: playerTwoSnapshots.responses };
      const staleAdjustment = await postJson<VersionedResult>(bankContext, config.apiUrl, `/api/rooms/${room.id}/bank/adjust-balance`, {
        playerId: playerOne!.id, amount: 300, reason: 'real-stack stale-snapshot guard',
      }, `adjust-stale-${runId}`);
      expect(staleSnapshot.stateVersion).toBeLessThan(staleAdjustment.stateVersion);
      await Promise.all([
        expect.poll(() => playerOneSnapshots.responses).toBeGreaterThan(staleBaseline.one),
        expect.poll(() => playerTwoSnapshots.responses).toBeGreaterThan(staleBaseline.two),
      ]);
      await settleRenderedState(playerOnePage);
      expect(staleSnapshotsInjected).toBe(1);
      await expect(displayedBalance(playerOnePage)).toHaveText(formattedBalance(5_111));

      await playerTwoContext.setOffline(true);
      const offlineBaseline = { one: playerOneSnapshots.responses, two: playerTwoSnapshots.responses };
      await postJson<VersionedResult>(bankContext, config.apiUrl, `/api/rooms/${room.id}/bank/adjust-balance`, {
        playerId: playerTwo!.id, amount: 333, reason: 'real-stack offline convergence',
      }, `adjust-offline-${runId}`);
      await expect.poll(() => playerOneSnapshots.responses).toBeGreaterThan(offlineBaseline.one);
      await expect(displayedBalance(playerOnePage)).toHaveText(formattedBalance(5_411));
      expect(playerTwoSnapshots.responses).toBe(offlineBaseline.two);

      await playerTwoContext.setOffline(false);
      await expect.poll(() => playerTwoSnapshots.responses).toBeGreaterThan(offlineBaseline.two);
      await expect(displayedBalance(playerTwoPage)).toHaveText(formattedBalance(5_555));

      const beforeReplayRoom = await database.room.findUniqueOrThrow({ where: { id: room.id }, select: { stateVersion: true } });
      const beforeReplayPlayer = await database.player.findUniqueOrThrow({ where: { id: playerOne!.id }, select: { balance: true } });
      const replayKey = `adjust-replay-${runId}`;
      const replayBody = { playerId: playerOne!.id, amount: 444, reason: 'real-stack idempotency replay' };
      const firstReplay = await postJson<VersionedResult>(bankContext, config.apiUrl, `/api/rooms/${room.id}/bank/adjust-balance`, replayBody, replayKey);
      await expect(displayedBalance(playerOnePage)).toHaveText(formattedBalance(beforeReplayPlayer.balance + 444));
      const secondReplay = await postJson<VersionedResult>(bankContext, config.apiUrl, `/api/rooms/${room.id}/bank/adjust-balance`, replayBody, replayKey);
      const [afterReplayRoom, afterReplayPlayer, replayRecords] = await Promise.all([
        database.room.findUniqueOrThrow({ where: { id: room.id }, select: { stateVersion: true } }),
        database.player.findUniqueOrThrow({ where: { id: playerOne!.id }, select: { balance: true } }),
        database.idempotencyRecord.count({ where: { scope: `account:${bankAccount.id}:room:${room.id}:adjust-balance`, key: replayKey } }),
      ]);
      expect(firstReplay.stateVersion).toBe(beforeReplayRoom.stateVersion + 1);
      expect(secondReplay.stateVersion).toBe(firstReplay.stateVersion);
      expect(afterReplayRoom.stateVersion).toBe(beforeReplayRoom.stateVersion + 1);
      expect(afterReplayPlayer.balance).toBe(beforeReplayPlayer.balance + 444);
      expect(replayRecords).toBe(1);

      const secondDeviceContext = await mobileContext();
      const secondDevicePage = await secondDeviceContext.newPage();
      await login(secondDevicePage, usernames.playerOne, config.password, config.apiUrl);
      const sessions = await getJson<SessionView[]>(secondDeviceContext, config.apiUrl, '/api/auth/sessions');
      expect(sessions).toHaveLength(2);
      const firstDeviceSession = sessions.find((session) => !session.current);
      expect(firstDeviceSession).toBeTruthy();
      const revokeResponse = await secondDeviceContext.request.delete(`${config.apiUrl}/api/auth/sessions/${firstDeviceSession!.id}`);
      if (!revokeResponse.ok()) throw new Error(`DELETE /api/auth/sessions/:id failed with ${revokeResponse.status()}: ${await revokeResponse.text()}`);
      await expect(playerOnePage.getByRole('heading', { name: '账号登录' })).toBeVisible();
      await expect(playerOnePage.getByText('当前登录已失效，请重新登录')).toBeVisible();
      expect(await database.accountSession.findUniqueOrThrow({ where: { id: firstDeviceSession!.id }, select: { revokeReason: true } }))
        .toMatchObject({ revokeReason: 'USER_REVOKED' });
    } finally {
      await Promise.allSettled(contexts.map((context) => context.close()));
      try {
        await database.$disconnect();
      } finally {
        await dropIsolatedSchema(config.schema, config.cleanupDatabaseUrl);
      }
    }
  });
});
