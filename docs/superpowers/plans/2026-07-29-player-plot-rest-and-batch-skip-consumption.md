# 玩家剧情停留与批量减除停轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家申请剧情停留和批量减除停轮，并让银行审批这些申请或直接批量扣减。

**Architecture:** 在既有 `GameRequest` 请求/审批体系中增加 `PLOT_REST_EVENT` 和 `CONSUME_SKIP_TURNS`。服务层抽出唯一的批量消耗事务，供银行直接操作与申请审批共用；前端仅向通用请求接口提交玩家申请，并将银行直接操作升级为次数选择。

**Tech Stack:** TypeScript、Fastify、Prisma、React、Next.js、Vitest、Playwright。

## Global Constraints

- `PLOT_REST_EVENT` 必须包含正整数次数和非空剧情说明；其停轮记录固定为 `sourceType: 'PLOT_REST'`、`blocksTollCollection: false`。
- `CONSUME_SKIP_TURNS` 仅在实体骰子模式可创建和批准，必须包含正整数次数，且玩家申请不要求原因。
- “全部”在客户端/银行提交时转换为当时的具体 `remainingSkipTurns` 数字；审批时再次校验，次数不足时整个操作失败，不做部分扣减。
- 消耗顺序为 `SkipTurnEntry.createdAt ASC`；已消耗次数由 `originalCount - remainingCount` 计算，不新增数据库字段或迁移。
- 冷宫仅接受次数；宜修只对 `COLD_PALACE` 减 2（最低 0）并发放既有 500 两，绝不影响剧情停留。
- 保留银行直接扣减的必填现场原因与审计日志；玩家减除申请使用请求和事务记录审计审批。
- 不修改工作区中与此功能无关的未提交文件。

---

## File Structure

- `apps/api/src/prisma-game-service.ts`：定义新请求动作、创建时校验并持久化剧情说明；在审批时创建剧情停留记录或调用共享批量消耗 helper；将银行直接消耗从单次扩展为指定次数。
- `apps/api/src/prisma-game-service.integration.test.ts`：覆盖剧情停留、宜修隔离、跨来源批量消耗、原子失败和玩家减除请求的端到端服务语义。
- `apps/api/src/app.ts`：扩展通用请求 schema，并让银行扣减 endpoint 接受 `count`。
- `apps/api/src/app-socket.test.ts`：断言新 API 请求类型和银行批量扣减的路由契约及版本通知。
- `apps/web/app/components/app-router-client.tsx`：渲染剧情停留、玩家减除停轮和银行批量扣减控件，并显示新增请求的说明、次数和审批文案。
- `apps/web/app/globals.css`：使实体事件内的三项操作在手机和桌面下稳定排列，且第三个快捷模块不挤压现有操作。
- `tests/e2e/task7-contract.spec.ts`：验证玩家端提交的两个请求体、冷宫表单不含原因、银行直接操作的批量请求体与审批信息。

### Task 1: 服务层的剧情停留与原子批量消耗

**Files:**
- Modify: `apps/api/src/prisma-game-service.integration.test.ts:789-875, 1230-1290`
- Modify: `apps/api/src/prisma-game-service.ts:9-16, 128-170, 275-505, 589-631`

**Interfaces:**
- Consumes: `createRequest(actor, roomId, playerId, action, key)` 与 `approve(actor, roomId, requestId, key)`。
- Produces: `RequestAction` 支持 `{ type: 'PLOT_REST_EVENT'; count: number; reason: string }` 和 `{ type: 'CONSUME_SKIP_TURNS'; count: number }`；`consumeSkip(actor, roomId, playerId, count, key, reason)`；私有 `consumeSkipTurns(tx, roomId, playerId, count)` 返回 `{ before, after }`。

- [ ] **Step 1: 写入服务层失败测试**

  在现有 `physicalRoom()` 测试组新增以下测试。使用两笔不同来源的记录验证先进先出；以宜修创建剧情停留验证没有减免或奖励。

  ```ts
  it('approves plot rest without blocking tolls or applying Yixiu cold-palace skill', async () => {
    const room = await first.createRoom({ name: '剧情停留', initialBalance: 5000, diceMode: 'PHYSICAL' });
    const yixiu = await first.joinPlayer(room.code, '宜修', 'yixiu');
    await first.joinPlayer(room.code, '乙', 'huashifei');
    const bank = await first.joinBank(room.code, '国库');
    await first.start(room.id, bank.token, 'start-plot-rest');
    const request = await first.createRequest(room.id, yixiu.playerId, { type: 'PLOT_REST_EVENT', count: 3, reason: '养病留宫' }, 'plot-rest-request');

    await first.approve(room.id, request.id, bank.token, 'approve-plot-rest');

    expect(await firstDb.player.findUniqueOrThrow({ where: { id: yixiu.playerId } })).toMatchObject({ remainingSkipTurns: 3, balance: 5000 });
    expect(await firstDb.skipTurnEntry.findFirstOrThrow({ where: { roomId: room.id, playerId: yixiu.playerId } })).toMatchObject({
      sourceType: 'PLOT_REST', sourceDescription: '养病留宫', originalCount: 3, remainingCount: 3, blocksTollCollection: false,
    });
    expect((await first.snapshot(room.id)).players.find((player) => player.id === yixiu.playerId)).toMatchObject({ tollCollectionBlocked: false });
  });

  it('consumes the requested number across oldest skip entries atomically', async () => {
    const { room, a, bank } = await physicalRoom();
    const firstEntry = await first.addSkipTurns(room.id, a.playerId, 2, 'PLOT_REST', bank.token, 'first-entry', '剧情停留');
    const secondEntry = await first.addSkipTurns(room.id, a.playerId, 3, 'MANUAL', bank.token, 'second-entry', '现场裁定');

    await first.consumeSkip(room.id, a.playerId, 4, bank.token, 'consume-four', '已跳过四回合');

    expect(await firstDb.skipTurnEntry.findUniqueOrThrow({ where: { id: firstEntry.id } })).toMatchObject({ remainingCount: 0 });
    expect(await firstDb.skipTurnEntry.findUniqueOrThrow({ where: { id: secondEntry.id } })).toMatchObject({ remainingCount: 1 });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ remainingSkipTurns: 1 });
    await expect(first.consumeSkip(room.id, a.playerId, 2, bank.token, 'consume-too-many', '不可部分扣除')).rejects.toThrow('INSUFFICIENT_SKIP_TURNS');
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ remainingSkipTurns: 1 });
  });

  it('requires bank approval before a player skip-consumption request changes state', async () => {
    const { room, a, bank } = await physicalRoom();
    await first.addSkipTurns(room.id, a.playerId, 2, 'PLOT_REST', bank.token, 'setup-consume-request', '剧情停留');
    const request = await first.createRequest(room.id, a.playerId, { type: 'CONSUME_SKIP_TURNS', count: 2 }, 'player-consume-request');

    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).remainingSkipTurns).toBe(2);
    await first.approve(room.id, request.id, bank.token, 'approve-player-consume');
    expect((await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).remainingSkipTurns).toBe(0);
  });
  ```

- [ ] **Step 2: 运行服务测试并确认失败原因正确**

  Run: `npm run test:integration`

  Expected: 新测试因 `PLOT_REST_EVENT` / `CONSUME_SKIP_TURNS` 尚不被 `RequestAction` 接受、或 `consumeSkip` 参数数不匹配而失败；既有测试保持通过。若本机没有 `TEST_DATABASE_URL`，记录该前置条件，改用 Task 2 的路由单测继续推进。

- [ ] **Step 3: 最小化实现新动作和共享批量消耗 helper**

  扩展 `RequestAction` 的 `type` 联合并增加 `reason?: string`。在 `createRequest` 中只允许新动作需要的字段，并在写入 `GameRequest` 时保存 `note: action.type === 'PLOT_REST_EVENT' ? action.reason.trim() : null`；将 `note` 加入 snapshot 的请求映射。

  在 `createRequest` 的现有冷宫校验后插入以下约束：

  ```ts
  const skipRequest = action.type === 'PLOT_REST_EVENT' || action.type === 'CONSUME_SKIP_TURNS';
  if (skipRequest && (action.propertyName || action.amount !== undefined || action.targetPlayerId || action.landingId)) fail('INVALID_SKIP_REQUEST_PAYLOAD');
  if (action.type === 'PLOT_REST_EVENT' && (!Number.isInteger(action.count) || (action.count ?? 0) <= 0 || !action.reason?.trim())) fail('INVALID_PLOT_REST');
  if (action.type === 'CONSUME_SKIP_TURNS') {
    if (room.diceMode !== 'PHYSICAL') fail('PHYSICAL_DICE_MODE_REQUIRED');
    if (action.reason !== undefined || !Number.isInteger(action.count) || (action.count ?? 0) <= 0 || (action.count ?? 0) > player.remainingSkipTurns) fail('INSUFFICIENT_SKIP_TURNS');
  }
  ```

  提取以下私有 helper，并让直接银行操作和批准分支调用它。`updateMany` 的失败必须抛出，使外层 serializable transaction 回滚。

  ```ts
  private async consumeSkipTurns(tx: Prisma.TransactionClient, roomId: string, playerId: string, count: number) {
    const player = await tx.player.findFirst({ where: { id: playerId, roomId } });
    if (!player || !Number.isInteger(count) || count <= 0 || player.remainingSkipTurns < count) fail('INSUFFICIENT_SKIP_TURNS');
    const entries = await tx.skipTurnEntry.findMany({ where: { roomId, playerId, remainingCount: { gt: 0 } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (entries.reduce((sum, entry) => sum + entry.remainingCount, 0) < count) fail('INSUFFICIENT_SKIP_TURNS');
    let remaining = count;
    for (const entry of entries) {
      if (!remaining) break;
      const consumed = Math.min(entry.remainingCount, remaining);
      const changed = await tx.skipTurnEntry.updateMany({ where: { id: entry.id, remainingCount: entry.remainingCount }, data: { remainingCount: { decrement: consumed } } });
      if (changed.count !== 1) fail('SKIP_STATE_CHANGED');
      remaining -= consumed;
    }
    const changed = await tx.player.updateMany({ where: { id: playerId, roomId, version: player.version, remainingSkipTurns: player.remainingSkipTurns }, data: { remainingSkipTurns: { decrement: count }, version: { increment: 1 } } });
    if (changed.count !== 1) fail('SKIP_STATE_CHANGED');
    return { before: player.remainingSkipTurns, after: player.remainingSkipTurns - count };
  }
  ```

  在 `approve` 的 switch 加入：

  ```ts
  case 'PLOT_REST_EVENT': {
    if (!actorId || !request.actor || !Number.isInteger(request.quantity) || !request.note?.trim()) fail('INVALID_PLOT_REST');
    const changed = await tx.player.updateMany({ where: { id: actorId, roomId, version: request.actor.version }, data: { remainingSkipTurns: { increment: request.quantity }, version: { increment: 1 } } });
    if (changed.count !== 1) fail('PLAYER_STATE_CHANGED');
    await tx.skipTurnEntry.create({ data: { roomId, playerId: actorId, sourceType: 'PLOT_REST', sourceDescription: request.note.trim(), originalCount: request.quantity, remainingCount: request.quantity, blocksTollCollection: false, createdBy: request.actor.memberId, approvedBy: bank.id } });
    break;
  }
  case 'CONSUME_SKIP_TURNS': {
    if (!actorId || !Number.isInteger(request.quantity)) fail('INSUFFICIENT_SKIP_TURNS');
    await this.consumeSkipTurns(tx, roomId, actorId, request.quantity);
    break;
  }
  ```

  将 `consumeSkip` 改为 `(actor, roomId, playerId, count, key, reason)`，要求 `count` 是正整数，保留实体骰子及必填原因限制，并调用 helper 后用其 `before`/`after` 写审计日志。直接操作的 idempotency body 必须包含 `count`。

- [ ] **Step 4: 运行服务测试并确认通过**

  Run: `npm run test:integration`

  Expected: 新测试通过；剧情停留保留全部 3 次、宜修余额不变且收租未被禁用；4 次跨记录扣减后剩 1 次；申请批准前不改变状态，批准后才消耗。

- [ ] **Step 5: 提交服务层实现**

  ```bash
  git add apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts
  git commit -m "feat: add plot rest and batch skip consumption"
  ```

### Task 2: HTTP 路由契约与版本通知

**Files:**
- Modify: `apps/api/src/app.ts:338,351-352`
- Modify: `apps/api/src/app-socket.test.ts:560-593`

**Interfaces:**
- Consumes: `PrismaGameService.createRequest(actor, roomId, playerId, action, key)` 与 `consumeSkip(actor, roomId, playerId, count, key, reason)`。
- Produces: `POST /api/rooms/:id/requests` 接受 `PLOT_REST_EVENT` / `CONSUME_SKIP_TURNS`；`POST /api/rooms/:id/bank/consume-skip-turn` 要求 `{ playerId, count, reason }`。

- [ ] **Step 1: 写入失败的 API 路由测试**

  扩展 `passes custom request versions directly to the notifier` 的 `games` stub，加入 `consumeSkip`。新增调用和断言：

  ```ts
  await app.inject({
    method: 'POST', url: '/api/rooms/room-a/requests',
    headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'plot-rest-version' },
    payload: { playerId: 'player-1', type: 'PLOT_REST_EVENT', count: 3, reason: '养病留宫' },
  });
  await app.inject({
    method: 'POST', url: '/api/rooms/room-a/bank/consume-skip-turn',
    headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'consume-three-version' },
    payload: { playerId: 'player-1', count: 3, reason: '实体回合已跳过' },
  });

  expect(games.createRequest).toHaveBeenCalledWith(expect.anything(), 'room-a', 'player-1', { type: 'PLOT_REST_EVENT', count: 3, reason: '养病留宫' }, 'plot-rest-version');
  expect(games.consumeSkip).toHaveBeenCalledWith(expect.anything(), 'room-a', 'player-1', 3, 'consume-three-version', '实体回合已跳过');
  ```

  再用 `{ type: 'PLOT_REST_EVENT', count: 1 }` 调用通用请求路由，断言 HTTP 400，确保 route schema 不会静默漏掉剧情说明。

- [ ] **Step 2: 运行路由测试并确认失败**

  Run: `npm test -- apps/api/src/app-socket.test.ts`

  Expected: 失败于 `PLOT_REST_EVENT` 尚不在 Zod enum，且银行路由尚未接受 `count`。

- [ ] **Step 3: 扩展 Zod schema 和方法调用**

  将通用请求 body 的类型枚举补上两种请求，并增加 `reason`：

  ```ts
  type: z.enum(['BUY_PROPERTY', 'BUILD_PROPERTY', 'SELL_BUILDING', 'MORTGAGE_PROPERTY', 'REDEEM_PROPERTY', 'SELL_PROPERTY_TO_BANK', 'TRADE_PROPERTY', 'START_REWARD', 'COLD_PALACE_EVENT', 'COMPANION_EVENT', 'PLOT_REST_EVENT', 'CONSUME_SKIP_TURNS']),
  reason: z.string().trim().min(1).optional(),
  ```

  在 route parse 后增加动作专属校验，使其在调用服务前返回 400：

  ```ts
  if (body.type === 'PLOT_REST_EVENT' && !body.reason) throw new RuleError('REASON_REQUIRED');
  ```

  将银行扣减 body 和调用替换为：

  ```ts
  const body = z.object({ playerId: z.string(), count: z.number().int().positive(), reason: z.string().trim().min(1) }).parse(request.body);
  const result = await games.consumeSkip(gameActor(auth), id, body.playerId, body.count, idempotencyKey(request.headers['idempotency-key']), body.reason);
  ```

  每个成功响应继续通过 `notifyVersion` 发布其返回的 `stateVersion`。

- [ ] **Step 4: 运行路由测试并确认通过**

  Run: `npm test -- apps/api/src/app-socket.test.ts`

  Expected: 新请求被原样转发、银行扣减接收次数且两条 mutation 都发出一次状态版本通知；缺少剧情说明返回 400。

- [ ] **Step 5: 提交路由实现**

  ```bash
  git add apps/api/src/app.ts apps/api/src/app-socket.test.ts
  git commit -m "feat: expose plot rest and batch skip APIs"
  ```

### Task 3: 玩家和银行操作界面

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:8-32,77-87,1377-1731,1735-2225`
- Modify: `apps/web/app/globals.css:522-539,830-855`
- Modify: `tests/e2e/task7-contract.spec.ts`

**Interfaces:**
- Consumes: 玩家请求 `{ playerId, type: 'PLOT_REST_EVENT', count, reason }`、`{ playerId, type: 'CONSUME_SKIP_TURNS', count }`，银行直接请求 `{ playerId, count, reason }`。
- Produces: 仅实体骰子房间显示玩家“停轮次数减除”快捷入口；玩家的“全部”转换为具体数量；银行能直接选择指定次数或全部；审批列表显示剧情说明。

- [ ] **Step 1: 写入失败的浏览器合同测试**

  在 `task7-contract.spec.ts` 使用现有 `gameSnapshot` 增加 `player-1.remainingSkipTurns = 3` 和一个待审批 `PLOT_REST_EVENT`，并为下面路由收集 body：

  ```ts
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/api/rooms/room-1/requests', async (route) => {
    requests.push(await postBody(route));
    await route.fulfill({ json: { id: `request-${requests.length}`, stateVersion: 2 } });
  });

  await page.getByRole('button', { name: '实体事件' }).click();
  await page.getByLabel('剧情停留次数').fill('2');
  await page.getByLabel('剧情说明').fill('养病留宫');
  await page.getByRole('button', { name: '提交剧情停留' }).click();
  await page.getByRole('button', { name: '停轮次数减除' }).click();
  await page.getByLabel('减除次数').selectOption('3');
  await page.getByRole('button', { name: '提交减除申请' }).click();

  expect(requests).toEqual([
    { playerId: 'player-1', type: 'PLOT_REST_EVENT', count: 2, reason: '养病留宫' },
    { playerId: 'player-1', type: 'CONSUME_SKIP_TURNS', count: 3 },
  ]);
  await expect(page.getByLabel('冷宫原因')).toHaveCount(0);
  ```

  使用银行席位打开同一 mock snapshot，选择“全部”并填写 `实体回合已跳过`，断言 `/bank/consume-skip-turn` body 为 `{ playerId: 'player-1', count: 3, reason: '实体回合已跳过' }`，并断言审批列表包含 `剧情停留`、`停轮 2 次` 和 `养病留宫`。

- [ ] **Step 2: 运行浏览器合同测试并确认失败**

  Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep "plot rest|batch skip"`

  Expected: 失败于“剧情停留次数”和“停轮次数减除”控件尚不存在。

- [ ] **Step 3: 最小化实现玩家端、银行端和请求呈现**

  在 `BankRequest` 新增 `note?: string | null`，将请求快照带来的 `note` 呈现在 `approvalDetails`。加入 `CircleMinus` 图标，并扩展 Player `panel` 联合：

  ```tsx
  const [panel, setPanel] = useState<'LANDING' | 'START' | 'PROPERTY' | 'ASSET' | 'TRANSFER' | 'BANK_PAYMENT' | 'EVENT' | 'END' | 'SKIP_CONSUME' | null>(null);
  const [plotRestCount, setPlotRestCount] = useState('1');
  const [plotRestReason, setPlotRestReason] = useState('');
  const [playerSkipConsumeCount, setPlayerSkipConsumeCount] = useState('1');
  ```

  在“实体事件” ActionSheet 保留无原因的冷宫字段，增加以下独立表单后再渲染伙伴卡按钮：

  ```tsx
  <label>剧情停留次数<input aria-label="剧情停留次数" type="number" min="1" step="1" value={plotRestCount} onChange={(event) => setPlotRestCount(event.target.value)} /></label>
  <label>剧情说明<textarea aria-label="剧情说明" required value={plotRestReason} onChange={(event) => setPlotRestReason(event.target.value)} /></label>
  <button className="quick" disabled={busy || !Number.isInteger(Number(plotRestCount)) || Number(plotRestCount) <= 0 || !plotRestReason.trim()} onClick={() => void requestPlotRest()}>
    <CircleMinus /><span>提交剧情停留</span>
  </button>
  ```

  `requestPlotRest()` 仅调用通用 `/requests`，成功后清空两个字段、关闭弹窗并显示“剧情停留已提交银行确认”。主快捷区在“实体事件”“结束回合”后加入 `Quick`，仅实体骰子可用：

  ```tsx
  <Quick icon={<CircleMinus />} label="停轮次数减除" disabled={busy || snapshot.diceMode !== 'PHYSICAL' || me.remainingSkipTurns <= 0} onClick={() => setPanel('SKIP_CONSUME')} />
  ```

  `SKIP_CONSUME` 弹窗用 `Array.from({ length: me.remainingSkipTurns }, (_, index) => index + 1)` 生成选择器，并提供值为 `ALL` 的“全部（N 次）”选项；提交时将 `ALL` 转为 `me.remainingSkipTurns`，再提交 `CONSUME_SKIP_TURNS`。不渲染原因输入。

  在 BankView 以同一 `ALL` 转换方式维护 `skipConsumeCount`，把直接扣减 body 改为 `{ playerId, count, reason }`，确认弹窗的“变更”与前后数量使用选定 `count`。保留 `skipConsumeReason` 的必填要求。为 `PLOT_REST_EVENT` / `CONSUME_SKIP_TURNS` 更新 `approvalDetails`、`requestLabel` 与 `requestActionLabel`，使它们显示次数及剧情说明而非 0 两金额。

  将 `.event-actions` 改为可容纳三项的稳定网格，窄屏用单列：

  ```css
  .event-actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  @media (max-width: 520px) { .event-actions { grid-template-columns: 1fr; } }
  ```

  保持 `.quick-grid` 的固定三列，以便新增快捷操作自然换行且不改变已有模块宽度。

- [ ] **Step 4: 运行浏览器合同测试并确认通过**

  Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep "plot rest|batch skip"`

  Expected: 玩家请求的剧情说明与固化次数正确；冷宫没有原因字段；玩家减除不发原因；银行“全部”发送当前 3 次；审批列表同时显示次数与说明。

- [ ] **Step 5: 运行全量静态和相关测试**

  Run: `npm run typecheck`

  Expected: exit code 0。

  Run: `npm run lint`

  Expected: exit code 0。

  Run: `npm test -- apps/api/src/app-socket.test.ts`

  Expected: exit code 0。

  Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --project=desktop-chromium`

  Expected: exit code 0。

- [ ] **Step 6: 提交前端实现**

  ```bash
  git add apps/web/app/components/app-router-client.tsx apps/web/app/globals.css tests/e2e/task7-contract.spec.ts
  git commit -m "feat: add player plot rest controls"
  ```

## Plan Self-Review

- Spec coverage: Task 1 covers the new request types, `PLOT_REST` record shape, toll/宜修 distinction, ordered atomic consumption, and approval behavior. Task 2 covers the exposed route contract and state-version notification. Task 3 covers all requested player and bank controls, “全部” semantics, and visible approval details.
- Placeholder scan: no incomplete or deferred implementation steps remain.
- Type consistency: all request types use `count`; the plot description is `reason` from the API and `note` in persisted/snapshot request data; direct bank consumption uses `(playerId, count, key, reason)`.
