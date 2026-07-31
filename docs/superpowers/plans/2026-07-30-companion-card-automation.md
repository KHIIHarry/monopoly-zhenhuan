# 伙伴卡奖励自动化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 甄嬛经银行批准获得伙伴卡时自动获得 500 两，且伙伴卡不再作为系统计数状态。

**Architecture:** 保留 `COMPANION_EVENT` 和 `RETURN_COMPANION_EVENT` 的实体事件审批、交易和不可撤销语义。服务端在批准获得事件时根据房间技能开关与人物技能直接生成 `SKILL_REWARD`；返还事件只结算固定奖励，不再读取或修改 `partnerCardCount`。快照与前端删除该状态的契约和所有基于该状态的提示。

**Tech Stack:** TypeScript, Fastify, Prisma, Vitest, Next.js, Playwright

## Global Constraints

- 保留数据库 `Player.partnerCardCount` 列，不创建迁移；该字段不再被游戏伙伴卡流程使用。
- 保留两种伙伴卡事件的银行审批、幂等、交易和不可撤销语义。
- 仅技能开启且人物技能代码为 `COMPANION_REWARD` 时，`COMPANION_EVENT` 生成 500 两 `SKILL_REWARD`。
- `RETURN_COMPANION_EVENT` 始终按既有规则在批准后奖励 500 两，但不得依赖伙伴卡数量。

---

## File Structure

- `apps/api/src/prisma-game-service.ts`: 伙伴卡申请验证、批准结算与快照投影。
- `apps/api/src/prisma-game-service.integration.test.ts`: 服务端资金流水、技能开关、返还幂等和审计行为。
- `apps/web/app/components/app-router-client.tsx`: 客户端快照类型和伙伴卡确认/审批/详情文案。
- `tests/e2e/task7-contract.spec.ts`: 玩家和银行伙伴卡界面的浏览器契约。

### Task 1: 伙伴卡服务端结算与无计数流程

**Files:**
- Modify: `apps/api/src/prisma-game-service.integration.test.ts:1617-1740,2044-2065`
- Modify: `apps/api/src/prisma-game-service.ts:163,352,541-561`

**Interfaces:**
- Consumes: `COMPANION_REWARD` 人物技能配置的 `cashReward` 和 `RETURN_COMPANION_REWARD` 常量。
- Produces: `COMPANION_EVENT` 批准时零或一笔 `SKILL_REWARD` 资金流水；伙伴卡事件不再读写或快照暴露 `partnerCardCount`。

- [ ] **Step 1: 写出服务端失败测试**

替换伙伴卡获得测试，使其期望甄嬛在审批前余额不变、审批后增加 500，并验证唯一的技能流水：

```ts
await first.approve(room.id, companion.id, bank.token, 'approve-companion-event');
expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } }))
  .toMatchObject({ balance: before.balance + 500 });
expect(await firstDb.ledgerEntry.findMany({
  where: { transactionId: companionTransaction.id, type: 'SKILL_REWARD' },
})).toMatchObject([{ amount: 500, description: '甄嬛伙伴卡奖励' }]);
```

在“人物技能生产路径”测试中将甄嬛的余额断言从 `10000` 改为 `10500`；随后把房间 `skillEnabled` 设为 `false`，为甄嬛建立新的伙伴卡请求并断言审批后余额不变。重写返还测试，使任意历史 `partnerCardCount` 值都得到同样的奖励、交易元数据仅包含 `{ returnedCount: 1, rewardAmount: 500 }`、审计只记录余额和返还/奖励字段。

- [ ] **Step 2: 运行失败测试并确认失败原因**

Run: `npm run test:integration -- --testNamePattern='companion|人物技能生产路径'`

Expected: FAIL，当前代码仍将伙伴卡数量加一且没有为 `COMPANION_EVENT` 创建 `SKILL_REWARD`。

- [ ] **Step 3: 实现最小服务端变更**

删除伙伴卡申请时的上限检查和批准时的数量更新；从快照玩家映射中删除 `partnerCardCount`。将两个批准分支替换为以下逻辑，其中 `int` 与 `asObject` 是本文件已有工具：

```ts
case 'COMPANION_EVENT': {
  if (!actorId || !request.actor) fail('PLAYER_NOT_FOUND');
  const config = asObject(request.actor.character?.skillConfig);
  const reward = request.room.skillEnabled
    && request.actor.character?.skillCode === 'COMPANION_REWARD'
    ? int(config.cashReward)
    : 0;
  if (reward) await addEffect(actorId, reward, 'SKILL_REWARD', '甄嬛伙伴卡奖励');
  break;
}
case 'RETURN_COMPANION_EVENT': {
  if (!actorId || !request.actor || request.amount !== RETURN_COMPANION_REWARD || request.quantity !== 1) {
    fail('INVALID_RETURN_COMPANION_REQUEST');
  }
  await addEffect(actorId, RETURN_COMPANION_REWARD, 'RETURN_COMPANION_EVENT', '放回实体伙伴卡奖励');
  transactionMetadata = { returnedCount: 1, rewardAmount: RETURN_COMPANION_REWARD };
  approvalAudit = {
    beforeJson: { balance: request.actor.balance },
    afterJson: { balance: request.actor.balance + RETURN_COMPANION_REWARD, returnedCount: 1, rewardAmount: RETURN_COMPANION_REWARD },
  };
  break;
}
```

保留 `RETURN_COMPANION_EVENT` 的严格客户端载荷校验、固定金额、数量和审计创建；不要变更 Prisma schema 或无关账户服务中的历史字段保留测试。

- [ ] **Step 4: 运行服务端测试至通过**

Run: `npm run test:integration -- --testNamePattern='companion|人物技能生产路径'`

Expected: PASS，甄嬛审批获得奖励 500、技能关闭或非甄嬛无奖励、返还始终结算 500 且没有计数元数据。

- [ ] **Step 5: 提交服务端任务**

```bash
git add apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts
git commit -m "feat: automate Zhenhuan companion reward"
```

### Task 2: 删除伙伴卡计数界面与浏览器契约

**Files:**
- Modify: `tests/e2e/task7-contract.spec.ts:950-1017`
- Modify: `apps/web/app/components/app-router-client.tsx:56-69,5826-5841,7054-7067,7250-7256`

**Interfaces:**
- Consumes: 服务端快照中的玩家余额、伙伴卡请求的 `amount` 与 `quantity`。
- Produces: 放回伙伴卡的玩家与银行界面只呈现固定奖励、数量和不可撤销说明，且没有伙伴卡计数属性或“未记录”文案。

- [ ] **Step 1: 写出浏览器失败测试**

在 `task7-contract.spec.ts` 的两个伙伴卡放回测试中移除 mock 快照里的 `partnerCardCount`。将断言改成：

```ts
await expect(dialog.getByText('H5 当前未记录伙伴卡，请确认玩家已在线下实际放回实体卡。')).toHaveCount(0);
await expect(approval).not.toContainText('未记录实体卡放回');
await expect(dialog).not.toContainText('未记录实体卡放回');
```

保留对请求体 `{ playerId: 'player-1', type: 'RETURN_COMPANION_EVENT' }`、`放回 1 张`、`奖励 500 两` 与不可撤销文案的断言。

- [ ] **Step 2: 运行失败测试并确认失败原因**

Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --grep '伙伴卡放回'`

Expected: FAIL，因为界面仍渲染“未记录实体卡放回”告警和审批详情。

- [ ] **Step 3: 实现最小前端变更**

从 `Player` 类型删除 `partnerCardCount`，并删除以下三个依赖块：

```tsx
{me.partnerCardCount === 0 && (
  <p className="error">H5 当前未记录伙伴卡，请确认玩家已在线下实际放回实体卡。</p>
)}
```

```tsx
<p>未记录实体卡放回：{/* partnerCardCount 判定 */}</p>
```

```ts
`未记录实体卡放回：${player?.partnerCardCount === 0 ? '是' : '否'}`,
```

其余返还奖励、数量、审批和不可撤销文案保持不变。不要添加新的前端状态或按钮限制。

- [ ] **Step 4: 运行浏览器测试与类型检查至通过**

Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --grep '伙伴卡放回'`

Expected: PASS，玩家可提交放回请求，银行只看见数量、奖励和不可撤销说明。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交前端任务**

```bash
git add apps/web/app/components/app-router-client.tsx tests/e2e/task7-contract.spec.ts
git commit -m "feat: remove companion card tracking UI"
```

### Task 3: 完整回归验证

**Files:**
- Verify only: `apps/api/src/prisma-game-service.ts`
- Verify only: `apps/web/app/components/app-router-client.tsx`

- [ ] **Step 1: 验证无游戏流程计数引用**

Run: `rg -n 'partnerCardCount' apps/api/src/prisma-game-service.ts apps/web/app/components/app-router-client.tsx tests/e2e/task7-contract.spec.ts`

Expected: command exits with status 1 and no output. Historical schema and账户服务测试可继续引用数据库列。

- [ ] **Step 2: 运行完整测试与静态检查**

Run: `npm test`

Expected: PASS.

Run: `npm run lint && npm run typecheck`

Expected: PASS with zero lint warnings.

- [ ] **Step 3: 核对提交范围**

Run: `git status --short && git log -2 --oneline`

Expected: 仅本功能相关文件出现在两个新增提交中；不修改或提交工作区原有未提交文件。
