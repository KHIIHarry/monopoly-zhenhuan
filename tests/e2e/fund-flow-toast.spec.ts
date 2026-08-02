import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { hashPassword, sessionCookieName } from '../../apps/api/src/auth-domain.js';

const enabled = process.env.FUND_TOAST_REAL_STACK === '1';
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type RoomReference = { id: string; name: string };
type PlayerReference = { id: string; accountId: string };
type LandingReference = { id: string };

async function postJson<T>(context: BrowserContext, path: string, data: unknown, key: string): Promise<T> {
  const response = await context.request.post(`${apiUrl}${path}`, {
    data,
    headers: { 'idempotency-key': key },
  });
  if (!response.ok()) {
    throw new Error(`POST ${path} failed with ${response.status()}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function patchJson<T>(context: BrowserContext, path: string, data: unknown, key: string): Promise<T> {
  const response = await context.request.patch(`${apiUrl}${path}`, {
    data,
    headers: { 'idempotency-key': key },
  });
  if (!response.ok()) {
    throw new Error(`PATCH ${path} failed with ${response.status()}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function loginRequest(context: BrowserContext, username: string, password: string) {
  const response = await context.request.post(`${apiUrl}/api/auth/login`, {
    data: { username, password },
  });
  if (!response.ok()) {
    throw new Error(`POST /api/auth/login failed with ${response.status()}: ${await response.text()}`);
  }
}

async function login(page: Page, username: string, password: string, localWebKit = false) {
  if (localWebKit) {
    await loginRequest(page.context(), username, password);
    const cookies = await page.context().cookies(apiUrl);
    const session = cookies.find((cookie) => cookie.name === 'zhenhuan_session');
    if (!session) throw new Error('Login response did not include the session cookie');
    await page.context().addCookies([{
      name: sessionCookieName,
      value: session.value,
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

async function submitTransfer(page: Page, recipient: string, amount: number) {
  const dialog = page.getByRole('dialog', { name: '转帐' });
  if (!(await dialog.isVisible())) {
    await page.getByRole('button', { name: '转帐', exact: true }).click();
  }
  if (recipient === '银行') {
    await dialog.getByRole('button', { name: '银行，管理审批、轮次与结算' }).click();
  } else {
    await dialog.getByRole('button', { name: new RegExp(`，${recipient}，`) }).click();
  }
  await dialog.getByLabel('转帐金额').fill(String(amount));
  await dialog.getByRole('button', { name: '确认转帐' }).click();
}

async function approveTransfer(page: Page, amount: number) {
  await page.getByRole('button', { name: `批准 ${amount} 两` }).click();
  await page.getByRole('button', { name: '确认批准' }).click();
}

async function rejectTransfer(page: Page, amount: number, reason: string) {
  await page.getByRole('button', { name: `拒绝 ${amount} 两` }).click();
  await page.getByLabel('拒绝原因').fill(reason);
  await page.getByRole('button', { name: '确认拒绝' }).click();
}

async function expectNoToast(page: Page) {
  await page.waitForTimeout(350);
  await expect(page.locator('.toast')).toHaveCount(0);
}

async function waitForNoToast(...pages: Page[]) {
  await Promise.all(pages.map((page) => expect(page.locator('.toast')).toHaveCount(0, { timeout: 7_500 })));
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
      pointerEvents: style.pointerEvents,
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
    pointerEvents: 'none',
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

  test('uses live transfer mode and isolates every Toast audience', async ({ browser }, testInfo) => {
    test.skip(!['desktop-chromium', 'iphone-webkit'].includes(testInfo.project.name));
    test.setTimeout(240_000);

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
    const adminUsername = process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
    let adminSessionId: string | null = null;
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
      const admin = await database.account.findUniqueOrThrow({
        where: { username: adminUsername },
        select: { id: true, passwordHash: true },
      });
      const activeAdminSessions = await database.accountSession.findMany({
        where: {
          accountId: admin.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, expiresAt: true },
      });
      const parkedAdminSession = activeAdminSessions.length >= 2
        ? activeAdminSessions[0]
        : null;
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

      const [adminContext, bankContext, payerContext, receiverContext, unrelatedContext] = await Promise.all([
        newContext(), newContext(), newContext(), newContext(), newContext(),
      ]);
      await database.account.update({
        where: { id: admin.id },
        data: { passwordHash },
      });
      if (parkedAdminSession) {
        await database.accountSession.update({
          where: { id: parkedAdminSession.id },
          data: { expiresAt: new Date(0) },
        });
      }
      try {
        await loginRequest(adminContext, adminUsername, password);
      } finally {
        await Promise.all([
          database.account.update({
            where: { id: admin.id },
            data: { passwordHash: admin.passwordHash },
          }),
          parkedAdminSession
            ? database.accountSession.update({
                where: { id: parkedAdminSession.id },
                data: { expiresAt: parkedAdminSession.expiresAt },
              })
            : Promise.resolve(),
        ]);
      }
      const adminCookie = (await adminContext.cookies(apiUrl)).find((cookie) => cookie.name === sessionCookieName);
      if (!adminCookie) throw new Error('Bootstrap administrator login did not include the session cookie');
      const adminSession = await database.accountSession.findUniqueOrThrow({
        where: { sessionTokenHash: createHash('sha256').update(adminCookie.value).digest('hex') },
        select: { id: true },
      });
      adminSessionId = adminSession.id;
      const [bankPage, payerPage, receiverPage, unrelatedPage] = await Promise.all([
        bankContext.newPage(), payerContext.newPage(), receiverContext.newPage(), unrelatedContext.newPage(),
      ]);
      await login(bankPage, users.bank.username, password, mobile);
      await login(payerPage, users.payer.username, password, mobile);
      await login(receiverPage, users.receiver.username, password, mobile);
      await login(unrelatedPage, users.unrelated.username, password, mobile);

      const room = await postJson<RoomReference>(bankContext, '/api/rooms', {
        name: `实时转账提醒 ${runId}`.slice(0, 40),
        initialBalance: 5_000,
        diceMode: 'PHYSICAL',
        skillEnabled: true,
        startReward: 1_000,
        allowMidgameJoin: false,
        visibility: 'PRIVATE',
        transferApprovalRequired: false,
      }, `create-${runId}`);
      roomIds.push(room.id);
      await Promise.all([
        postJson(bankContext, `/api/rooms/${room.id}/join`, {}, `join-bank-${runId}`),
        postJson(payerContext, `/api/rooms/${room.id}/join`, {}, `join-payer-${runId}`),
        postJson(receiverContext, `/api/rooms/${room.id}/join`, {}, `join-receiver-${runId}`),
        postJson(unrelatedContext, `/api/rooms/${room.id}/join`, {}, `join-other-${runId}`),
      ]);
      await Promise.all([
        postJson(bankContext, `/api/rooms/${room.id}/select-bank`, {}, `seat-bank-${runId}`),
        postJson(payerContext, `/api/rooms/${room.id}/select-character`, { characterId: 'zhenhuan' }, `seat-payer-${runId}`),
        postJson(receiverContext, `/api/rooms/${room.id}/select-character`, { characterId: 'huashifei' }, `seat-receiver-${runId}`),
        postJson(unrelatedContext, `/api/rooms/${room.id}/select-character`, { characterId: 'anlingrong' }, `seat-other-${runId}`),
      ]);
      await postJson(bankContext, `/api/rooms/${room.id}/start`, {}, `start-${runId}`);
      const persisted = await database.room.findUniqueOrThrow({
        where: { id: room.id },
        include: { members: { include: { player: true } } },
      });
      const players = Object.fromEntries(persisted.members
        .filter((member): member is typeof member & { player: NonNullable<typeof member.player> } => member.player !== null)
        .map((member) => [member.accountId, { id: member.player.id, accountId: member.accountId } satisfies PlayerReference]));
      const payer = players[accountIds[1]];
      const receiver = players[accountIds[2]];
      expect(payer).toBeTruthy();
      expect(receiver).toBeTruthy();

      await Promise.all([
        openRoom(bankPage, room.name, '银行端'),
        openRoom(payerPage, room.name, '玩家端'),
        openRoom(receiverPage, room.name, '玩家端'),
        openRoom(unrelatedPage, room.name, '玩家端'),
      ]);
      await payerPage.waitForTimeout(400);

      await submitTransfer(payerPage, '李四', 500);
      await Promise.all([
        expect(payerPage.locator('.toast-success')).toHaveText('转账已成功，结果已同步至账本'),
        expect(receiverPage.locator('.toast-success')).toHaveText('张三向你转入 500 两'),
        expect(bankPage.locator('.toast-success')).toHaveText('张三向李四支付 500 两'),
      ]);
      await expectNoToast(unrelatedPage);
      await expectToastPresentation(payerPage, 'success', mobile);
      const toastBox = await payerPage.locator('.toast').boundingBox();
      expect(toastBox).toBeTruthy();
      if (mobile) {
        expect(Math.abs((toastBox!.x + toastBox!.width / 2) - 195)).toBeLessThan(3);
      } else {
        expect(1440 - toastBox!.x - toastBox!.width).toBeCloseTo(24, 0);
      }
      await payerPage.screenshot({ path: testInfo.outputPath('fund-flow-toast-success.png'), fullPage: true });
      await waitForNoToast(bankPage, payerPage, receiverPage);

      await patchJson(adminContext, `/api/admin/rooms/${room.id}`, {
        transferApprovalRequired: true,
      }, `mode-on-${runId}`);
      await expect.poll(async () => (await database.room.findUniqueOrThrow({ where: { id: room.id } })).transferApprovalRequired).toBe(true);
      await expect.poll(async () => (await database.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('PLAYING');

      await submitTransfer(payerPage, '李四', 300);
      await Promise.all([
        expect(payerPage.locator('.toast-success')).toHaveText('转账已提交，请等待银行审批'),
        expect(bankPage.locator('.toast-success')).toHaveText('收到张三的转账申请：向李四支付 300 两'),
      ]);
      await Promise.all([expectNoToast(receiverPage), expectNoToast(unrelatedPage)]);
      await waitForNoToast(bankPage, payerPage);
      await approveTransfer(bankPage, 300);
      await Promise.all([
        expect(payerPage.locator('.toast-success')).toHaveText('银行审批通过，转账已成功，结果已同步至账本'),
        expect(receiverPage.locator('.toast-success')).toHaveText('张三向你转入 300 两'),
        expect(bankPage.locator('.toast-success')).toHaveText('张三向李四支付 300 两'),
      ]);
      await expectNoToast(unrelatedPage);
      await waitForNoToast(bankPage, payerPage, receiverPage);

      await submitTransfer(payerPage, '李四', 250);
      await Promise.all([
        expect(payerPage.locator('.toast-success')).toHaveText('转账已提交，请等待银行审批'),
        expect(bankPage.locator('.toast-success')).toHaveText('收到张三的转账申请：向李四支付 250 两'),
      ]);
      await waitForNoToast(bankPage, payerPage);
      await rejectTransfer(bankPage, 250, '金额有误');
      await expect(payerPage.locator('.toast-rejected')).toHaveText('转账申请已被银行拒绝：金额有误');
      await expectToastPresentation(payerPage, 'rejected', mobile);
      await Promise.all([
        expectNoToast(bankPage),
        expectNoToast(receiverPage),
        expectNoToast(unrelatedPage),
      ]);
      await payerPage.screenshot({ path: testInfo.outputPath('fund-flow-toast-rejected.png'), fullPage: true });
      await waitForNoToast(bankPage, payerPage);

      await submitTransfer(payerPage, '银行', 120);
      await Promise.all([
        expect(payerPage.locator('.toast-success')).toHaveText('转账已提交，请等待银行审批'),
        expect(bankPage.locator('.toast-success')).toHaveText('收到张三的转账申请：向银行支付 120 两'),
      ]);
      await Promise.all([expectNoToast(receiverPage), expectNoToast(unrelatedPage)]);
      await waitForNoToast(bankPage, payerPage);
      await approveTransfer(bankPage, 120);
      await Promise.all([
        expect(payerPage.locator('.toast-success')).toHaveText('银行审批通过，转账已成功，结果已同步至账本'),
        expect(bankPage.locator('.toast-success')).toHaveText('银行收到张三支付 120 两'),
      ]);
      await Promise.all([expectNoToast(receiverPage), expectNoToast(unrelatedPage)]);
      await waitForNoToast(bankPage, payerPage);

      await database.player.update({ where: { id: receiver.id }, data: { status: 'LEFT' } });
      await submitTransfer(payerPage, '李四', 130);
      await Promise.all([
        expect(payerPage.locator('.toast-rejected')).toHaveText('转账申请提交失败：玩家状态已变化，请刷新后重试'),
        expect(bankPage.locator('.toast-rejected')).toHaveText('张三的转账申请提交失败：玩家状态已变化，请刷新后重试'),
      ]);
      await Promise.all([expectNoToast(receiverPage), expectNoToast(unrelatedPage)]);
      await database.player.update({ where: { id: receiver.id }, data: { status: 'ACTIVE' } });
      await waitForNoToast(bankPage, payerPage);

      await submitTransfer(payerPage, '李四', 200);
      await Promise.all([
        expect(payerPage.locator('.toast-success')).toHaveText('转账已提交，请等待银行审批'),
        expect(bankPage.locator('.toast-success')).toHaveText('收到张三的转账申请：向李四支付 200 两'),
      ]);
      const pendingFailure = await database.gameRequest.findFirstOrThrow({
        where: { roomId: room.id, actorPlayerId: payer.id, type: 'PLAYER_TRANSFER', status: 'PENDING', amount: 200 },
        orderBy: { createdAt: 'desc' },
      });
      const payerBalance = (await database.player.findUniqueOrThrow({ where: { id: payer.id }, select: { balance: true } })).balance;
      await database.player.update({ where: { id: payer.id }, data: { balance: 10 } });
      await waitForNoToast(bankPage, payerPage);
      await approveTransfer(bankPage, 200);
      await Promise.all([
        expect(bankPage.locator('.toast-rejected')).toHaveText('银行审批执行失败：余额不足'),
        expect(payerPage.locator('.toast-rejected')).toHaveText('银行审批执行失败：余额不足'),
      ]);
      await Promise.all([expectNoToast(receiverPage), expectNoToast(unrelatedPage)]);
      await expect.poll(async () => (await database.gameRequest.findUniqueOrThrow({ where: { id: pendingFailure.id } })).status).toBe('PENDING');
      await database.player.update({ where: { id: payer.id }, data: { balance: payerBalance } });
      await waitForNoToast(bankPage, payerPage);

      await patchJson(adminContext, `/api/admin/rooms/${room.id}`, {
        transferApprovalRequired: false,
      }, `mode-off-${runId}`);
      await expect.poll(async () => (await database.room.findUniqueOrThrow({ where: { id: room.id } })).transferApprovalRequired).toBe(false);
      await expect.poll(async () => (await database.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('PLAYING');

      await submitTransfer(payerPage, '李四', 999_999);
      await expect(payerPage.locator('.toast-rejected')).toHaveText('转账失败：余额不足');
      await Promise.all([expectNoToast(bankPage), expectNoToast(receiverPage), expectNoToast(unrelatedPage)]);
      await waitForNoToast(payerPage);

      await submitTransfer(payerPage, '李四', 90);
      await Promise.all([
        expect(payerPage.locator('.toast-success')).toHaveText('转账已成功，结果已同步至账本'),
        expect(receiverPage.locator('.toast-success')).toHaveText('张三向你转入 90 两'),
        expect(bankPage.locator('.toast-success')).toHaveText('张三向李四支付 90 两'),
      ]);
      await expectNoToast(unrelatedPage);
      await waitForNoToast(bankPage, payerPage, receiverPage);

      let abortTransfer = true;
      await payerPage.route(`**/api/rooms/${room.id}/transfers`, async (route) => {
        if (abortTransfer) {
          abortTransfer = false;
          await route.abort('failed');
          return;
        }
        await route.continue();
      });
      await submitTransfer(payerPage, '李四', 80);
      await expect(payerPage.locator('.toast-rejected')).toHaveText('转账失败：服务暂时不可用，请稍后重试');
      await Promise.all([expectNoToast(bankPage), expectNoToast(receiverPage), expectNoToast(unrelatedPage)]);
      await payerPage.unroute(`**/api/rooms/${room.id}/transfers`);
      await waitForNoToast(payerPage);

      await payerPage.evaluate(() => {
        const timing = {
          firstShownAt: null as number | null,
          firstHiddenAt: null as number | null,
          secondShownAt: null as number | null,
          secondHiddenAt: null as number | null,
        };
        const firstMessage = '银行向你发放队列一 111 两';
        const secondMessage = '银行扣除你 222 两（队列二）';
        const sample = () => {
          const message = document.querySelector('.toast span')?.textContent?.trim() ?? null;
          const now = performance.now();
          if (message === firstMessage && timing.firstShownAt === null) timing.firstShownAt = now;
          if (message === secondMessage && timing.secondShownAt === null) {
            timing.firstHiddenAt = now;
            timing.secondShownAt = now;
          }
          if (message === null && timing.secondShownAt !== null && timing.secondHiddenAt === null) {
            timing.secondHiddenAt = now;
          }
        };
        const observer = new MutationObserver(sample);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        (window as typeof window & { __fundToastTiming?: { timing: typeof timing; observer: MutationObserver } }).__fundToastTiming = { timing, observer };
        sample();
      });
      await postJson(bankContext, `/api/rooms/${room.id}/bank/adjust-balance`, {
        playerId: payer.id, amount: 111, reason: '队列一',
      }, `queue-one-${runId}`);
      await postJson(bankContext, `/api/rooms/${room.id}/bank/adjust-balance`, {
        playerId: payer.id, amount: -222, reason: '队列二',
      }, `queue-two-${runId}`);
      await expect(payerPage.locator('.toast')).toHaveText('银行向你发放队列一 111 两');
      await expect(payerPage.locator('.toast')).toHaveText('银行扣除你 222 两（队列二）', { timeout: 3_500 });
      await expect(payerPage.locator('.toast')).toHaveCount(0, { timeout: 3_500 });
      const toastLifetimes = await payerPage.evaluate(() => {
        const state = (window as typeof window & {
          __fundToastTiming?: {
            timing: { firstShownAt: number | null; firstHiddenAt: number | null; secondShownAt: number | null; secondHiddenAt: number | null };
            observer: MutationObserver;
          };
        }).__fundToastTiming;
        if (!state) throw new Error('Toast timing observer was not installed');
        state.observer.disconnect();
        const { firstShownAt, firstHiddenAt, secondShownAt, secondHiddenAt } = state.timing;
        if (firstShownAt === null || firstHiddenAt === null || secondShownAt === null || secondHiddenAt === null) {
          throw new Error(`Incomplete Toast timing: ${JSON.stringify(state.timing)}`);
        }
        return {
          firstToastLifetimeMs: firstHiddenAt - firstShownAt,
          secondToastLifetimeMs: secondHiddenAt - secondShownAt,
        };
      });
      expect(toastLifetimes.firstToastLifetimeMs).toBeGreaterThanOrEqual(2_650);
      expect(toastLifetimes.firstToastLifetimeMs).toBeLessThanOrEqual(3_350);
      expect(toastLifetimes.secondToastLifetimeMs).toBeGreaterThanOrEqual(2_650);
      expect(toastLifetimes.secondToastLifetimeMs).toBeLessThanOrEqual(3_350);
      await waitForNoToast(bankPage);

      const landing = await postJson<LandingReference>(payerContext, `/api/rooms/${room.id}/landings`, {
        playerId: payer.id,
        propertyName: '甘露寺',
      }, `landing-rejection-${runId}`);
      await postJson(bankContext, `/api/rooms/${room.id}/landings/${landing.id}/cancel-property-actions`, {
        reason: '现场落点有误',
      }, `cancel-landing-${runId}`);
      await expect(payerPage.locator('.toast-rejected')).toHaveText('你的落点申请已被银行拒绝：现场落点有误');
      await Promise.all([expectNoToast(bankPage), expectNoToast(receiverPage), expectNoToast(unrelatedPage)]);
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
      if (adminSessionId) {
        await database.accountSession.deleteMany({ where: { id: adminSessionId } });
      }
      await database.$disconnect();
    }
  });
});
