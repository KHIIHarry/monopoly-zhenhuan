# 实体事件与伙伴卡放回 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 合并实体事件停轮输入，新增固定奖励 500 两的伙伴卡放回审批事务，并停止伙伴卡相关甄嬛自动资金奖励。

**Architecture:** `RETURN_COMPANION_EVENT` 复用现有 `GameRequest` 创建、银行批准、幂等和版本通知路径。服务端在批准事务内按当前伙伴卡数量决定减 1 或保持 0，同时写余额、账本、事务元数据、审计和请求状态；前端只提交类型并从权威快照显示确认和审批信息。

**Tech Stack:** TypeScript、Fastify、Prisma、PostgreSQL、React、Next.js、Vitest、Playwright、Socket.IO。

## Global Constraints

- 冷宫和剧情停轮只合并前端次数输入，后端继续使用 `COLD_PALACE_EVENT` / `PLOT_REST_EVENT` 和 `COLD_PALACE` / `PLOT_REST` 来源。
- 冷宫继续触发宜修技能并阻止收取过路费；剧情停轮不触发宜修技能且不阻止收取过路费。
- `RETURN_COMPANION_EVENT` 每次固定放回 1 张、固定奖励 500 两，金额与数量由服务端决定，前端不上传。
- 伙伴卡数量为 0 时仍可创建和批准放回，数量保持 0；批准时按当前数据库状态写入 `untrackedPhysicalReturn`。
- 放回不关联落点，不检查回合或骰子模式，允许多笔待审批，同一请求只能执行一次。
- 卡数、余额、账本、事务、审计、请求状态、房间版本和幂等结果必须处于同一 PostgreSQL 事务。
- `COMPANION_EVENT` 与 `RETURN_COMPANION_EVENT` 都不自动执行甄嬛资金技能；Master Data 和展示文案不变。
- 放回事务不可撤销；保留现有银行审批、拒绝、幂等和 Socket 失效通知模型。
- 当前工作区包含用户未提交的前端改动；只在当前内容上做局部编辑，不格式化或覆盖无关代码。

---

## File Structure

- `apps/api/src/prisma-game-service.ts`：新增请求类型、严格事件载荷校验、固定服务端金额/数量、批准事务、审计与不可撤销规则；移除伙伴卡获得的自动技能资金。
- `apps/api/src/prisma-game-service.integration.test.ts`：覆盖获得伙伴卡无奖励、放回的有记录/零记录/多待办/幂等/回滚/重连权威快照语义。
- `apps/api/src/app.ts`：允许通用请求路由接收 `RETURN_COMPANION_EVENT`；金额、数量和落点限制仍由服务层作为最终规则执行。
- `apps/api/src/app-socket.test.ts`：覆盖新类型的 HTTP 转发、幂等键和版本通知契约。
- `apps/web/app/components/app-router-client.tsx`：合并停轮状态和控件，新增放回确认、卡数类型、银行审批文案。
- `tests/e2e/task7-contract.spec.ts`：覆盖玩家请求体、输入重置、零卡确认和银行审批展示。

### Task 1: 服务层放回事务与甄嬛技能隔离

**Files:**
- Modify: `apps/api/src/prisma-game-service.integration.test.ts`
- Modify: `apps/api/src/prisma-game-service.ts`

**Interfaces:**
- Consumes: `createRequest(actor, roomId, playerId, action, key)`、`approve(actor, roomId, requestId, key)`、现有 `changeBalance()` 和 `executeIdempotent()`。
- Produces: `RequestAction` 接受 `{ type: 'RETURN_COMPANION_EVENT' }`；请求固定保存 `amount: 500`、`quantity: 1`；事务元数据包含 `companionCardCountBefore`、`companionCardCountAfter`、`returnedCount`、`rewardAmount`、`untrackedPhysicalReturn`。

- [ ] **Step 1: 写入伙伴卡获得不再自动奖励的失败断言**

  在现有 `requires bank approval before applying companion and cold-palace events` 测试中，把伙伴卡批准后的期望改为余额不变、数量为 1，并断言该请求事务没有 `SKILL_REWARD` 账本：

  ```ts
  const companionTransaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: companion.id } });
  expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({
    balance: before.balance,
    partnerCardCount: 1,
  });
  expect(await firstDb.ledgerEntry.count({
    where: { transactionId: companionTransaction.id, type: 'SKILL_REWARD' },
  })).toBe(0);
  ```

- [ ] **Step 2: 写入有记录和零记录放回的失败测试**

  在相同集成测试组新增两个用例。第一个直接把卡数设为 2 后创建请求，审批前断言状态不变，批准后断言卡数 1、余额 +500、一笔账本、不可撤销事务和审计：

  ```ts
  it('returns one tracked companion card for the server-defined reward after bank approval', async () => {
    const { room, a, bank } = await physicalRoom();
    await firstDb.player.update({ where: { id: a.playerId }, data: { partnerCardCount: 2 } });
    const before = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });

    const request = await first.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'return-tracked-companion');
    expect(request).toMatchObject({ amount: 500, quantity: 1, landingEventId: null, turnId: null, status: 'PENDING' });
    expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } })).toMatchObject({ balance: before.balance, partnerCardCount: 2 });

    await first.approve(room.id, request.id, bank.token, 'approve-return-tracked-companion');

    const player = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    const transaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: request.id } });
    const metadata = transaction.metadata as Record<string, unknown>;
    expect(player).toMatchObject({ balance: before.balance + 500, partnerCardCount: 1 });
    expect(transaction).toMatchObject({ type: 'RETURN_COMPANION_EVENT', reversible: false });
    expect(metadata).toMatchObject({ companionCardCountBefore: 2, companionCardCountAfter: 1, returnedCount: 1, rewardAmount: 500, untrackedPhysicalReturn: false });
    expect(await firstDb.ledgerEntry.findMany({ where: { transactionId: transaction.id } })).toHaveLength(1);
    expect(await firstDb.auditLog.findFirstOrThrow({ where: { roomId: room.id, entityId: a.playerId, action: 'RETURN_COMPANION_EVENT' } })).toMatchObject({
      actorRole: 'BANK',
      beforeJson: { balance: before.balance, partnerCardCount: 2 },
      afterJson: { balance: before.balance + 500, partnerCardCount: 1, returnedCount: 1, rewardAmount: 500, untrackedPhysicalReturn: false },
    });
  });

  it('approves an untracked physical return while keeping the H5 count at zero', async () => {
    const { room, a, bank } = await physicalRoom();
    const before = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    const request = await first.createRequest(room.id, a.playerId, { type: 'RETURN_COMPANION_EVENT' }, 'return-untracked-companion');

    await first.approve(room.id, request.id, bank.token, 'approve-return-untracked-companion');

    const player = await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } });
    const transaction = await firstDb.gameTransaction.findUniqueOrThrow({ where: { requestId: request.id } });
    expect(player).toMatchObject({ balance: before.balance + 500, partnerCardCount: 0 });
    expect(transaction.metadata).toMatchObject({ companionCardCountBefore: 0, companionCardCountAfter: 0, untrackedPhysicalReturn: true });
    expect((await firstDb.auditLog.findFirstOrThrow({ where: { action: 'RETURN_COMPANION_EVENT', entityId: a.playerId } })).afterJson).toMatchObject({ untrackedPhysicalReturn: true });
  });
  ```

- [ ] **Step 3: 写入多待办、重复批准和事务失败回滚测试**

  新增一个多待办用例：卡数设为 1，使用两个不同创建键生成两笔请求，依次批准；断言最终卡数 0、余额 +1000、两笔事务中第二笔 `untrackedPhysicalReturn: true`。

  新增一个幂等用例：通过 `Promise.all` 让两个服务实例使用同一审批键批准同一请求，断言响应相同，且 `requestId` 关联的事务、账本和 `RETURN_COMPANION_EVENT` 审计各只有一笔。

  新增审计失败回滚用例，在批准前安装仅拦截放回审计的测试触发器：

  ```ts
  await firstDb.$executeRawUnsafe(`
    CREATE FUNCTION "fail_return_companion_audit"() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'injected return companion audit failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await firstDb.$executeRawUnsafe(`
    CREATE TRIGGER "fail_return_companion_audit_trigger"
    BEFORE INSERT ON "AuditLog"
    FOR EACH ROW WHEN (NEW."action" = 'RETURN_COMPANION_EVENT')
    EXECUTE FUNCTION "fail_return_companion_audit"()
  `);
  try {
    await expect(first.approve(room.id, request.id, bank.token, 'approve-return-with-audit-failure')).rejects.toThrow(/injected return companion audit failure/);
  } finally {
    await firstDb.$executeRawUnsafe('DROP TRIGGER IF EXISTS "fail_return_companion_audit_trigger" ON "AuditLog"');
    await firstDb.$executeRawUnsafe('DROP FUNCTION IF EXISTS "fail_return_companion_audit"()');
  }
  ```

  触发器移除后断言玩家余额和卡数均等于批准前、请求仍为 `PENDING` 且批准字段为空，`requestId` 关联事务为 0、对应账本和审计为 0、审批幂等记录为 0。

- [ ] **Step 4: 运行集成测试并确认 RED**

  Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run apps/api/src/prisma-game-service.integration.test.ts`

  Expected: `RETURN_COMPANION_EVENT` 因不在 `RequestAction` 联合而产生 TypeScript/运行时失败，现有伙伴卡获得余额断言因仍自动加 500 而失败。

- [ ] **Step 5: 实现严格请求创建规则和固定服务端值**

  在 `prisma-game-service.ts` 增加常量和请求类型：

  ```ts
  const RETURN_COMPANION_REWARD = 500;
  const nonReversibleRequestTypes = new Set(['COMPANION_EVENT', 'COLD_PALACE_EVENT', 'RETURN_COMPANION_EVENT']);
  ```

  将 `RETURN_COMPANION_EVENT` 加入 `RequestAction['type']`。在 `createRequest()` 读取玩家后加入：

  ```ts
  if (action.type === 'RETURN_COMPANION_EVENT' && (
    action.propertyName !== undefined || action.targetPlayerId !== undefined ||
    action.amount !== undefined || action.count !== undefined ||
    action.landingId !== undefined || action.reason !== undefined
  )) fail('INVALID_RETURN_COMPANION_EVENT');
  ```

  计算请求值时使用：

  ```ts
  if (action.type === 'RETURN_COMPANION_EVENT') computedAmount = RETURN_COMPANION_REWARD;
  const quantity = action.type === 'RETURN_COMPANION_EVENT' ? 1 : action.count;
  ```

  `GameRequest.create` 写入该 `quantity`。不要检查卡数、当前回合、骰子模式或落点。

- [ ] **Step 6: 实现批准事务与审计**

  在 `approve()` 的 switch 前声明：

  ```ts
  let approvalAudit: {
    action: string;
    entityType: string;
    entityId: string;
    beforeJson: Prisma.InputJsonObject;
    afterJson: Prisma.InputJsonObject;
  } | null = null;
  ```

  把 `COMPANION_EVENT` 分支改为只增加数量，不读取技能配置、不调用 `addEffect()`。

  新增放回分支：先调用 `addEffect(actorId, RETURN_COMPANION_REWARD, 'RETURN_COMPANION_EVENT', '放回实体伙伴卡奖励')`，再在卡数大于 0 时用 `version: request.actor.version + 1` 和精确 `partnerCardCount` 条件执行减 1 与版本加 1；卡数为 0 时不执行减法。设置：

  ```ts
  const untrackedPhysicalReturn = request.actor.partnerCardCount === 0;
  const companionCardCountAfter = Math.max(0, request.actor.partnerCardCount - 1);
  transactionMetadata = {
    companionCardCountBefore: request.actor.partnerCardCount,
    companionCardCountAfter,
    returnedCount: 1,
    rewardAmount: RETURN_COMPANION_REWARD,
    untrackedPhysicalReturn,
  };
  approvalAudit = {
    action: 'RETURN_COMPANION_EVENT',
    entityType: 'Player',
    entityId: actorId,
    beforeJson: { balance: request.actor.balance, partnerCardCount: request.actor.partnerCardCount },
    afterJson: {
      balance: request.actor.balance + RETURN_COMPANION_REWARD,
      partnerCardCount: companionCardCountAfter,
      returnedCount: 1,
      rewardAmount: RETURN_COMPANION_REWARD,
      untrackedPhysicalReturn,
    },
  };
  ```

  创建事务时使用 `reversible: !nonReversibleRequestTypes.has(request.type)`。创建账本后、请求标记 `EXECUTED` 前，如果 `approvalAudit` 非空，则以 `actorMemberId: bank.id`、`actorRole: 'BANK'` 创建 `AuditLog`。所有写入继续留在当前 `executeIdempotent()` 回调中。

- [ ] **Step 7: 运行集成测试并确认 GREEN**

  Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run apps/api/src/prisma-game-service.integration.test.ts`

  Expected: 新增伙伴卡测试通过，审计触发器失败用例证明请求、卡数、余额、事务与账本全部回滚。

### Task 2: HTTP 请求类型与版本通知契约

**Files:**
- Modify: `apps/api/src/app-socket.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: Task 1 的 `createRequest()` 新动作。
- Produces: `POST /api/rooms/:id/requests` 接受 `{ playerId, type: 'RETURN_COMPANION_EVENT' }` 并继续调用 `notifyVersion()`。

- [ ] **Step 1: 写入路由失败测试**

  在 `passes custom request versions directly to the notifier` 中插入：

  ```ts
  const returned = await app.inject({
    method: 'POST',
    url: '/api/rooms/room-a/requests',
    headers: { cookie: `${sessionCookieName}=cookie-token`, 'idempotency-key': 'return-companion-version' },
    payload: { playerId: 'player-1', type: 'RETURN_COMPANION_EVENT' },
  });
  expect(returned.statusCode).toBe(200);
  expect(games.createRequest).toHaveBeenCalledWith(
    expect.anything(), 'room-a', 'player-1', { type: 'RETURN_COMPANION_EVENT' }, 'return-companion-version',
  );
  ```

  同时更新 notifier 调用序号，断言返回的 `stateVersion: 8` 继续发出房间版本通知。

- [ ] **Step 2: 运行路由测试并确认 RED**

  Run: `npx vitest run apps/api/src/app-socket.test.ts`

  Expected: 新请求返回 400，`createRequest` 未收到 `RETURN_COMPANION_EVENT`。

- [ ] **Step 3: 扩展 Zod 类型白名单**

  在通用请求路由的 `type: z.enum([...])` 中加入 `'RETURN_COMPANION_EVENT'`。不新增金额默认值，也不新增专用 endpoint；Task 1 服务层继续作为固定金额与非法载荷的最终校验。

- [ ] **Step 4: 运行路由测试并确认 GREEN**

  Run: `npx vitest run apps/api/src/app-socket.test.ts`

  Expected: 新类型被原样转发，幂等键和版本通知断言通过。

### Task 3: 合并实体事件表单与放回确认/审批界面

**Files:**
- Modify: `tests/e2e/task7-contract.spec.ts`
- Modify: `apps/web/app/components/app-router-client.tsx`

**Interfaces:**
- Consumes: Task 2 的通用请求类型；快照 `players[].partnerCardCount`。
- Produces: 单一 `eventSkipCount`、玩家放回确认流程、银行放回审批详情。

- [ ] **Step 1: 写入合并输入和不同请求类型的浏览器失败测试**

  把现有剧情停留测试扩展为同时拦截 `/events/cold-palace` 和 `/requests`。打开实体事件后断言只有一个 `停轮次数` 标签，不存在 `冷宫停轮次数` 与 `剧情停留次数`；填入 2、保持说明为空，断言剧情停轮按钮禁用而冷宫可用。提交冷宫后重新打开，断言次数重置为 1、说明为空；再填入 3 和原因提交剧情停轮。最终断言请求体分别为：

  ```ts
  expect(coldBodies).toEqual([{ playerId: 'player-1', count: 2 }]);
  expect(requests[0]).toEqual({ playerId: 'player-1', type: 'PLOT_REST_EVENT', count: 3, reason: '养病留宫' });
  ```

- [ ] **Step 2: 写入零卡放回确认与银行审批展示失败测试**

  玩家快照设置 `partnerCardCount: 0`。点击放回伙伴卡后断言固定三行说明和额外零卡警告可见，确认按钮可用；确认后断言通用请求体严格等于：

  ```ts
  { playerId: 'player-1', type: 'RETURN_COMPANION_EVENT' }
  ```

  银行快照加入：

  ```ts
  requests: [{
    id: 'return-companion-request', type: 'RETURN_COMPANION_EVENT', playerId: 'player-1',
    amount: 500, quantity: 1, status: 'PENDING',
  }]
  ```

  断言审批卡片包含“放回伙伴卡”“放回 1 张”“奖励 500 两”“未记录实体卡放回：是”“批准后不可撤销”；点击批准后确认框重复显示玩家、数量、奖励、未记录状态和不可撤销提示。

- [ ] **Step 3: 运行浏览器测试并确认 RED**

  Run: `npx playwright test tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep "实体事件|伙伴卡放回"`

  Expected: 失败于双次数输入仍存在、没有放回按钮/确认框、前端类型没有伙伴卡数量和银行文案。

- [ ] **Step 4: 实现玩家端单一输入和统一成功重置**

  给 `Player` 增加必填 `partnerCardCount: number`。把 `coldPalaceCount`、`plotRestCount` 合并为 `eventSkipCount`，保留 `plotRestReason`，新增 `returnCompanionOpen`。

  提取成功重置：

  ```ts
  function finishPhysicalEvent(message: string) {
    setEventSkipCount('1');
    setPlotRestReason('');
    setReturnCompanionOpen(false);
    setPanel(null);
    showNotice(message);
  }
  ```

  冷宫与剧情函数都读取 `Number(eventSkipCount)`；冷宫请求仍只发送 `{ playerId, count }`，剧情请求仍发送 `{ playerId, type: 'PLOT_REST_EVENT', count, reason }`。伙伴卡获得成功也调用统一重置。

  把面板改为一个“停轮次数”输入、一个占位符为“填写剧情停轮原因”的说明和四个按钮，按钮文案严格为“冷宫事件”“剧情停轮”“获得伙伴卡”“放回伙伴卡”。说明输入不设置 HTML `required`，只由剧情按钮和 handler 检查非空，确保冷宫可在空说明下提交。

- [ ] **Step 5: 实现放回二次确认**

  点击放回按钮时先 `setPanel(null)`，再 `setReturnCompanionOpen(true)`；取消确认时关闭确认框并重新打开事件面板。确认 handler 调用：

  ```ts
  idempotentAction(`/api/rooms/${snapshot.id}/requests`, {
    playerId,
    type: 'RETURN_COMPANION_EVENT',
  });
  ```

  `ConfirmDialog` 显示规范中的三行固定文案；`me.partnerCardCount === 0` 时额外显示规范警告，但不要设置 `disabled`。

- [ ] **Step 6: 实现银行审批文案**

  在 `requestLabel()` 映射 `RETURN_COMPANION_EVENT: '放回伙伴卡'`，在 `requestActionLabel()` 把它视为事件。在 `approvalDetails()` 中根据当前玩家 `partnerCardCount === 0` 追加：

  ```ts
  `放回 ${request.quantity ?? 1} 张`,
  `奖励 ${formatMoney(request.amount)} 两`,
  `未记录实体卡放回：${player?.partnerCardCount === 0 ? '是' : '否'}`,
  '批准后不可撤销',
  ```

  在批准 `ConfirmDialog` 中为该类型渲染专用数量、奖励、未记录状态和不可撤销提示，避免显示无关的“地产：无”。

- [ ] **Step 7: 运行浏览器测试并确认 GREEN**

  Run: `npx playwright test tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep "实体事件|伙伴卡放回"`

  Expected: 合并输入、两个事件类型、成功重置、零卡可提交、确认文案和银行审批详情全部通过。

### Task 4: 一致性回归与视觉验证

**Files:**
- Modify only if a failing regression exposes an in-scope defect.

**Interfaces:**
- Consumes: Tasks 1-3 的完整实现。
- Produces: 可复现的验证证据和移动/桌面 UI 截图检查结果。

- [ ] **Step 1: 运行格式、类型和单元测试**

  Run: `npm run lint`

  Expected: exit 0, zero warnings.

  Run: `npm run typecheck`

  Expected: exit 0.

  Run: `npm test`

  Expected: exit 0；未设置 `TEST_DATABASE_URL` 时只允许数据库用例按既有门禁跳过。

- [ ] **Step 2: 运行 PostgreSQL 集成测试**

  若仓库环境已提供 `TEST_DATABASE_URL`：

  Run: `npm run test:integration`

  Expected: 所有 Prisma 游戏服务集成用例通过，包括审计失败后的完整回滚。

  若未提供，启动仓库 `docker-compose.yml` 的 PostgreSQL 测试数据库，使用以 `_test` 结尾的数据库名后再运行，不能用普通单元测试替代本事务验证。

- [ ] **Step 3: 运行完整浏览器契约**

  Run: `npx playwright test tests/e2e/task7-contract.spec.ts --project=desktop-chromium`

  Expected: exit 0.

- [ ] **Step 4: 启动开发服务并进行视觉检查**

  Run: `npm run dev`

  在桌面和移动视口打开玩家端实体事件面板，确认四个按钮两列稳定排列、文本不溢出、确认框无重叠；打开银行审批确认框确认详情完整。使用浏览器截图记录检查，不修改既有宫廷视觉体系。

- [ ] **Step 5: 独立代码审查**

  检查最终 diff 是否覆盖设计全部要求，重点审查零卡批准、多待办批准时判定、重复审批、审计失败回滚、甄嬛无自动奖励、非撤销候选和未覆盖的旧文案/旧状态名。修复所有 Critical/Important 问题后重新运行受影响测试。
