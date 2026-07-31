# 伙伴卡审批弹窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让银行审批“获得伙伴卡”时只看见关联信息，并仅为甄嬛显示自动奖励 500 两。

**Architecture:** 在现有 `approveTarget` 弹窗中为 `COMPANION_EVENT` 增加专用渲染分支。该分支从快照玩家列表读取当前 `characterId`，显示条件奖励说明或不可撤销说明；它不改变服务端请求、结算或其他审批类型。

**Tech Stack:** TypeScript, React, Playwright

## Global Constraints

- `COMPANION_EVENT` 不显示“地产：无”“金额：0 两”或“数量：无”。
- 仅 `characterId === 'zhenhuan'` 的申请玩家显示“自动奖励 500 两”。
- 所有伙伴卡获得审批都显示“伙伴卡事件批准后立即生效，不可撤销”。
- 放回伙伴卡和其他审批事件保持现有显示与行为。

---

### Task 1: 伙伴卡获得审批专用内容

**Files:**
- Modify: `tests/e2e/task7-contract.spec.ts:984-1016`
- Modify: `apps/web/app/components/app-router-client.tsx:7052-7084`

**Interfaces:**
- Consumes: `approveTarget.type`, `approveTarget.playerId` 和 `snapshot.players[].characterId`。
- Produces: `COMPANION_EVENT` 审批弹窗的条件奖励文案，且不渲染通用地产、金额、数量字段。

- [ ] **Step 1: 写出失败的浏览器契约**

新增两条银行审批快照：一条申请玩家 `characterId: 'zhenhuan'`，一条为 `characterId: 'yixiu'`。两者请求均为：

```ts
{
  id: 'companion-request',
  type: 'COMPANION_EVENT',
  playerId: 'player-1',
  amount: 0,
  status: 'PENDING',
}
```

甄嬛断言：

```ts
await expect(dialog).toContainText('自动奖励 500 两');
await expect(dialog).toContainText('伙伴卡事件批准后立即生效，不可撤销');
await expect(dialog).not.toContainText('地产：无');
await expect(dialog).not.toContainText('金额：0 两');
await expect(dialog).not.toContainText('数量：无');
```

非甄嬛断言相同的不可撤销与无关字段移除条件，但使用 `not.toContainText('自动奖励 500 两')`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --grep '伙伴卡获得审批'`

Expected: FAIL，因为当前通用分支渲染地产、金额、数量，且未显示甄嬛奖励说明。

- [ ] **Step 3: 实现最小专用分支**

在 `RETURN_COMPANION_EVENT` 分支之后、通用分支之前添加：

```tsx
) : approveTarget.type === "COMPANION_EVENT" ? (
  <>
    {snapshot.players.find((player) => player.id === approveTarget.playerId)
      ?.characterId === "zhenhuan" && <p>自动奖励 500 两</p>}
    <p className="error">伙伴卡事件批准后立即生效，不可撤销</p>
  </>
) : (
```

删除现有独立的 `COMPANION_EVENT` 不可撤销段落，避免重复显示。保留 `COLD_PALACE_EVENT` 的独立提示与通用分支不变。

- [ ] **Step 4: 运行浏览器契约和类型检查**

Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --grep '伙伴卡获得审批'`

Expected: PASS，六种浏览器配置中的甄嬛与非甄嬛审批文案均正确。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交任务**

```bash
git add apps/web/app/components/app-router-client.tsx tests/e2e/task7-contract.spec.ts
git commit -m "fix: clarify companion approval dialog"
```
