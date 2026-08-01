import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { hashPassword } from '../../apps/api/src/auth-domain.js';

const enabled = process.env.FUND_TOAST_REAL_STACK === '1';
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type RoomReference = { id: string; name: string };
type RequestReference = { id: string; status: string };
type PlayerReference = { id: string; accountId: string };
type LandingReference = { id: string };

async function postJson<T>(
  context: BrowserContext,
  path: string,
  data: unknown,
  key: string,
): Promise<T> {
  const response = await context.request.post(`${apiUrl}${path}`, {
    data,
    headers: { 'idempotency-key': key },
  });
  if (!response.ok()) {
    throw new Error(`POST ${path} failed with ${response.status()}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function login(page: Page, username: string, password: string, localWebKit = false) {
  if (localWebKit) {
    const response = await page.context().request.post(`${apiUrl}/api/auth/login`, {
      data: { username, password },
    });
    if (!response.ok()) {
      throw new Error(`POST /api/auth/login failed with ${response.status()}: ${await response.text()}`);
    }
    const setCookie = response.headers()['set-cookie'];
    const token = setCookie?.match(/(?:^|;\s*)zhenhuan_session=([^;]+)/)?.[1];
    if (!token) throw new Error('Login response did not include the session cookie');
    await page.context().addCookies([{
      name: 'zhenhuan_session',
      value: decodeURIComponent(token),
      url: new URL(apiUrl).origin,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    await page.goto('/rooms');
    await expect(page.getByText(`@${username}`)).toBeVisible();
    return;
  }
  await page.goto('/');
  await page.getByRole('button', { name: '加入游戏组' }).click();
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText(`@${username}`)).toBeVisible();
}

async function openRoom(page: Page, roomName: string, view: '玩家端' | '银行端') {
  await page.goto('/rooms');
  await page.getByRole('button', { name: new RegExp(roomName) }).click();
  await expect(page.getByRole('heading', { name: view, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新房间快照' })).toBeVisible();
}

async function waitForNoToast(...pages: Page[]) {
  await Promise.all(pages.map((page) => expect(page.locator('.toast')).toHaveCount(0, { timeout: 4_500 })));
}

async function expectToastPresentation(page: Page, tone: 'success' | 'rejected', mobile: boolean) {
  const toast = page.locator(`.toast-${tone}`);
  await expect(toast).toBeVisible();
  const presentation = await toast.evaluate((element) => {
    const style = getComputedStyle(element);
    const icon = element.querySelector('svg');
    const message = element.querySelector('span');
    return {
      animationDuration: style.animationDuration,
      animationFillMode: style.animationFillMode,
      animationTimingFunction: style.animationTimingFunction,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      color: style.color,
      fontSize: style.fontSize,
      gap: style.gap,
      iconHeight: icon ? getComputedStyle(icon).height : null,
      iconWidth: icon ? getComputedStyle(icon).width : null,
      messageWrapped: message ? message.scrollHeight > message.clientHeight : true,
      paddingTop: style.paddingTop,
      whiteSpace: style.whiteSpace,
      width: style.width,
    };
  });

  expect(presentation).toMatchObject({
    animationDuration: '0.26s',
    animationFillMode: 'both',
    animationTimingFunction: 'ease-out',
    borderRadius: '8px',
    fontSize: '12px',
    gap: '6px',
    iconHeight: '13px',
    iconWidth: '13px',
    messageWrapped: false,
    paddingTop: '8px',
    whiteSpace: 'nowrap',
  });
  expect(presentation.backgroundColor).toBe(
    tone === 'success' ? 'rgb(228, 242, 232)' : 'rgb(249, 232, 233)',
  );
  expect(presentation.color).toBe(
    tone === 'success' ? 'rgb(23, 77, 52)' : 'rgb(139, 39, 48)',
  );
  if (mobile) {
    expect(Number.parseFloat(presentation.width)).toBeCloseTo(382, 0);
  } else {
    expect(Number.parseFloat(presentation.width)).toBeLessThanOrEqual(680);
  }
}

test.describe('real fund-flow Toast delivery', () => {
  test.skip(!enabled, 'Set FUND_TOAST_REAL_STACK=1 and run against the Docker Compose stack.');

  test('isolates audiences, queues committed funds, and reports rejected requests and landings', async ({ browser }, testInfo) => {
    test.skip(!['desktop-chromium', 'iphone-webkit'].includes(testInfo.project.name));
    test.setTimeout(120_000);

    const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`.toLowerCase();
    const password = `Toast-${runId}-Strong-42`;
    const users = {
      bank: { username: `toast-${runId}-bank`, displayName: '银行测试员' },
      payer: { username: `toast-${runId}-payer`, displayName: '张三' },
      receiver: { username: `toast-${runId}-receiver`, displayName: '李四' },
      unrelated: { username: `toast-${runId}-other`, displayName: '王五' },
    };
    const database = new PrismaClient();
    const contexts: BrowserContext[] = [];
    const accountIds: string[] = [];
    const roomIds: string[] = [];
    const mobile = testInfo.project.name === 'iphone-webkit';
    const newContext = async () => {
      const context = await browser.newContext({
        baseURL: 'http://localhost:3000',
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        deviceScaleFactor: mobile ? 3 : 1,
        isMobile: mobile,
        hasTouch: mobile,
      });
      contexts.push(context);
      return context;
    };

    try {
      const passwordHash = await hashPassword(password);
      for (const user of Object.values(users)) {
        const account = await database.account.create({
          data: {
            username: user.username,
            displayName: user.displayName,
            passwordHash,
            canCreateRoom: user === users.bank,
            note: `Disposable fund Toast E2E ${runId}`,
          },
        });
        accountIds.push(account.id);
      }

      const [bankContext, payerContext, receiverContext, unrelatedContext] = await Promise.all([
        newContext(), newContext(), newContext(), newContext(),
      ]);
      const [bankPage, payerPage, receiverPage, unrelatedPage] = await Promise.all([
        bankContext.newPage(), payerContext.newPage(), receiverContext.newPage(), unrelatedContext.newPage(),
      ]);
      await login(bankPage, users.bank.username, password, mobile);
      await login(payerPage, users.payer.username, password, mobile);
      await login(receiverPage, users.receiver.username, password, mobile);
      await login(unrelatedPage, users.unrelated.username, password, mobile);

      const createRoom = async (approvalRequired: boolean) => {
        const room = await postJson<RoomReference>(bankContext, '/api/rooms', {
          name: `${approvalRequired ? '审批' : '即时'}资金提醒 ${runId}`.slice(0, 40),
          initialBalance: 5_000,
          diceMode: 'PHYSICAL',
          skillEnabled: true,
          startReward: 1_000,
          allowMidgameJoin: false,
          visibility: 'PRIVATE',
          transferApprovalRequired: approvalRequired,
        }, `create-${approvalRequired}-${runId}`);
        roomIds.push(room.id);
        await Promise.all([
          postJson(bankContext, `/api/rooms/${room.id}/join`, {}, `join-bank-${room.id}`),
          postJson(payerContext, `/api/rooms/${room.id}/join`, {}, `join-payer-${room.id}`),
          postJson(receiverContext, `/api/rooms/${room.id}/join`, {}, `join-receiver-${room.id}`),
          postJson(unrelatedContext, `/api/rooms/${room.id}/join`, {}, `join-other-${room.id}`),
        ]);
        await Promise.all([
          postJson(bankContext, `/api/rooms/${room.id}/select-bank`, {}, `seat-bank-${room.id}`),
          postJson(payerContext, `/api/rooms/${room.id}/select-character`, { characterId: 'zhenhuan' }, `seat-payer-${room.id}`),
          postJson(receiverContext, `/api/rooms/${room.id}/select-character`, { characterId: 'huashifei' }, `seat-receiver-${room.id}`),
          postJson(unrelatedContext, `/api/rooms/${room.id}/select-character`, { characterId: 'anlingrong' }, `seat-other-${room.id}`),
        ]);
        await postJson(bankContext, `/api/rooms/${room.id}/start`, {}, `start-${room.id}`);
        const persisted = await database.room.findUniqueOrThrow({
          where: { id: room.id },
          include: { members: { include: { player: true } } },
        });
        const players = Object.fromEntries(persisted.members
          .filter((member): member is typeof member & { player: NonNullable<typeof member.player> } => member.player !== null)
          .map((member) => [member.accountId, { id: member.player.id, accountId: member.accountId } satisfies PlayerReference]));
        return { room, players };
      };

      const immediate = await createRoom(false);
      const payer = immediate.players[accountIds[1]];
      const receiver = immediate.players[accountIds[2]];
      expect(payer).toBeTruthy();
      expect(receiver).toBeTruthy();
      await Promise.all([
        openRoom(bankPage, immediate.room.name, '银行端'),
        openRoom(payerPage, immediate.room.name, '玩家端'),
        openRoom(receiverPage, immediate.room.name, '玩家端'),
        openRoom(unrelatedPage, immediate.room.name, '玩家端'),
      ]);
      await payerPage.waitForTimeout(400);

      await postJson(payerContext, `/api/rooms/${immediate.room.id}/transfers`, {
        fromPlayerId: payer.id,
        recipientType: 'PLAYER',
        toPlayerId: receiver.id,
        amount: 500,
        isPlotFine: false,
      }, `immediate-transfer-${runId}`);
      await Promise.all([
        expect(payerPage.locator('.toast')).toHaveText('你向李四支付 500 两'),
        expect(receiverPage.locator('.toast')).toHaveText('张三向你转入 500 两'),
        expect(bankPage.locator('.toast')).toHaveText('张三向李四支付 500 两'),
      ]);
      await unrelatedPage.waitForTimeout(400);
      await expect(unrelatedPage.locator('.toast')).toHaveCount(0);

      await expectToastPresentation(payerPage, 'success', mobile);

      const toastBox = await payerPage.locator('.toast').boundingBox();
      expect(toastBox).toBeTruthy();
      if (mobile) {
        expect(Math.abs((toastBox!.x + toastBox!.width / 2) - 195)).toBeLessThan(3);
      } else {
        expect(1440 - toastBox!.x - toastBox!.width).toBeCloseTo(24, 0);
      }
      await payerPage.getByRole('button', { name: '刷新房间快照' }).click();
      await payerPage.screenshot({ path: testInfo.outputPath('fund-flow-toast-success.png'), fullPage: true });
      await waitForNoToast(bankPage, payerPage, receiverPage);

      await postJson(bankContext, `/api/rooms/${immediate.room.id}/bank/adjust-balance`, {
        playerId: payer.id, amount: 111, reason: '队列一',
      }, `queue-one-${runId}`);
      await postJson(bankContext, `/api/rooms/${immediate.room.id}/bank/adjust-balance`, {
        playerId: payer.id, amount: -222, reason: '队列二',
      }, `queue-two-${runId}`);
      await expect(payerPage.locator('.toast')).toHaveText('银行向你发放队列一 111 两');
      await payerPage.waitForTimeout(2_500);
      await expect(payerPage.locator('.toast')).toHaveText('银行向你发放队列一 111 两');
      await expect(payerPage.locator('.toast')).toHaveText('银行扣除你 222 两（队列二）', { timeout: 1_000 });
      await expect(payerPage.locator('.toast')).toHaveCount(0, { timeout: 3_500 });
      await waitForNoToast(bankPage);

      const approval = await createRoom(true);
      const approvalPayer = approval.players[accountIds[1]];
      const approvalReceiver = approval.players[accountIds[2]];
      expect(approvalPayer).toBeTruthy();
      expect(approvalReceiver).toBeTruthy();
      await Promise.all([
        openRoom(bankPage, approval.room.name, '银行端'),
        openRoom(payerPage, approval.room.name, '玩家端'),
        openRoom(receiverPage, approval.room.name, '玩家端'),
        openRoom(unrelatedPage, approval.room.name, '玩家端'),
      ]);
      await payerPage.waitForTimeout(400);

      const pendingApproval = await postJson<RequestReference>(payerContext, `/api/rooms/${approval.room.id}/transfers`, {
        fromPlayerId: approvalPayer.id,
        recipientType: 'PLAYER',
        toPlayerId: approvalReceiver.id,
        amount: 300,
        isPlotFine: false,
      }, `pending-approval-${runId}`);
      expect(pendingApproval.status).toBe('PENDING');
      await payerPage.waitForTimeout(500);
      await Promise.all([bankPage, payerPage, receiverPage, unrelatedPage].map((page) => expect(page.locator('.toast')).toHaveCount(0)));

      await postJson(bankContext, `/api/rooms/${approval.room.id}/requests/${pendingApproval.id}/approve`, {}, `approve-${runId}`);
      await Promise.all([
        expect(payerPage.locator('.toast')).toHaveText('你向李四支付 300 两'),
        expect(receiverPage.locator('.toast')).toHaveText('张三向你转入 300 两'),
        expect(bankPage.locator('.toast')).toHaveText('张三向李四支付 300 两'),
      ]);
      await expect(unrelatedPage.locator('.toast')).toHaveCount(0);
      await waitForNoToast(bankPage, payerPage, receiverPage);

      const pendingRejection = await postJson<RequestReference>(payerContext, `/api/rooms/${approval.room.id}/transfers`, {
        fromPlayerId: approvalPayer.id,
        recipientType: 'PLAYER',
        toPlayerId: approvalReceiver.id,
        amount: 250,
        isPlotFine: false,
      }, `pending-rejection-${runId}`);
      await postJson(bankContext, `/api/rooms/${approval.room.id}/requests/${pendingRejection.id}/reject`, {
        reason: '金额有误',
      }, `reject-${runId}`);
      await expect(payerPage.locator('.toast-rejected')).toHaveText('你的转帐申请已被银行拒绝：金额有误');
      await expectToastPresentation(payerPage, 'rejected', mobile);
      await receiverPage.waitForTimeout(400);
      await Promise.all([bankPage, receiverPage, unrelatedPage].map((page) => expect(page.locator('.toast')).toHaveCount(0)));
      await waitForNoToast(payerPage);

      await Promise.all([
        openRoom(bankPage, immediate.room.name, '银行端'),
        openRoom(payerPage, immediate.room.name, '玩家端'),
        openRoom(receiverPage, immediate.room.name, '玩家端'),
        openRoom(unrelatedPage, immediate.room.name, '玩家端'),
      ]);
      const landing = await postJson<LandingReference>(payerContext, `/api/rooms/${immediate.room.id}/landings`, {
        playerId: payer.id,
        propertyName: '甘露寺',
      }, `landing-rejection-${runId}`);
      await postJson(bankContext, `/api/rooms/${immediate.room.id}/landings/${landing.id}/cancel-property-actions`, {
        reason: '现场落点有误',
      }, `cancel-landing-${runId}`);
      await expect(payerPage.locator('.toast-rejected')).toHaveText('你的落点申请已被银行拒绝：现场落点有误');
      await expectToastPresentation(payerPage, 'rejected', mobile);
      await payerPage.screenshot({ path: testInfo.outputPath('fund-flow-toast-rejected.png'), fullPage: true });
      await receiverPage.waitForTimeout(400);
      await Promise.all([bankPage, receiverPage, unrelatedPage].map((page) => expect(page.locator('.toast')).toHaveCount(0)));
    } finally {
      await Promise.allSettled(contexts.map((context) => context.close()));
      if (roomIds.length) {
        await database.room.updateMany({
          where: { id: { in: roomIds } },
          data: { visibility: 'PRIVATE', expiresAt: new Date() },
        });
      }
      if (accountIds.length) {
        const revokedAt = new Date();
        await database.accountSession.updateMany({
          where: { accountId: { in: accountIds }, revokedAt: null },
          data: { revokedAt, revokeReason: 'E2E_CLEANUP' },
        });
        await database.account.updateMany({
          where: { id: { in: accountIds } },
          data: { status: 'DISABLED', canCreateRoom: false, deletedAt: revokedAt },
        });
      }
      await database.$disconnect();
    }
  });
});
