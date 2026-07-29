# 沈眉庄地主剧情罚款减免 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让沈眉庄向其他玩家支付剧情罚俸或损失时，按原始金额输入并自动减免 200 两。

**Architecture:** 保持现有 `POST /api/rooms/:id/transfers` 及其账本逻辑不变。在 `PlayerView` 中只对付款方人物标识为 `meizhuang` 的转账表单维护一个本地勾选状态，并在提交前将原始金额转换为实际付款金额。Playwright 以沈眉庄席位打开该表单，验证专属控件、请求金额和不付款边界。

**Tech Stack:** TypeScript、React、Next.js、Playwright。

## Global Constraints

- 仅当前付款玩家的人物为沈眉庄时显示“剧情罚俸或损失时勾选”复选框。
- 提示必须为“金额填写实际罚款金额，系统会自动计算扣减-200，请不要填写减后的金额”。
- 勾选后，`POST /api/rooms/:id/transfers` 的 `amount` 等于原始输入金额减 200。
- 原始金额小于或等于 200 时，实际付款为 0，禁止提交。
- 未勾选和非沈眉庄的玩家转账行为保持不变。
- 国有剧情罚款接口、数据库与样式文件不变。

---

## File Structure

- `apps/web/app/components/app-router-client.tsx`：维护沈眉庄剧情付款复选状态、派生实际转账金额，并在既有“玩家转账”抽屉按条件渲染控件。
- `tests/e2e/task7-contract.spec.ts`：在现有浏览器合同测试中覆盖沈眉庄减免请求和普通玩家无专属控件。

### Task 1: 沈眉庄地主剧情付款减免

**Files:**
- Modify: `tests/e2e/task7-contract.spec.ts`（在现有玩家转账合同测试后新增回归测试）
- Modify: `apps/web/app/components/app-router-client.tsx:1388-1717`

**Interfaces:**
- Consumes: `Player.characterId`, `transferAmount`, `idempotentAction(path, body)` 和现有 `POST /api/rooms/:id/transfers` 请求体 `{ fromPlayerId, toPlayerId, amount }`。
- Produces: 当 `membership.playerId` 指向 `characterId: 'meizhuang'` 的玩家且勾选剧情付款时，提交体的 `amount` 为 `Number(transferAmount) - 200`；其余情况仍为 `Number(transferAmount)`。

- [ ] **Step 1: 写入失败的浏览器回归测试**

  在 `tests/e2e/task7-contract.spec.ts` 新增测试。使用现有房间和快照夹具，将席位能力替换为 `{ characterId: 'meizhuang', playerId: 'player-2', isBank: false, activeHere: true }`，并拦截转账路由。测试填写原始金额 `500`、勾选复选框后提交，断言请求体为 `amount: 300`；再填写 `200`，断言按钮禁用。重新以非沈眉庄席位打开，断言复选框不存在且 500 两普通转账仍提交 500。

  ```ts
  const transfers: Array<{ amount: number; fromPlayerId: string; toPlayerId: string }> = [];
  await page.route('**/api/rooms/room-1/transfers', async (route) => {
    transfers.push(route.request().postDataJSON());
    await route.fulfill({ json: { id: 'transfer-1' } });
  });

  await page.getByRole('button', { name: '玩家转账' }).click();
  await page.getByLabel('剧情罚俸或损失时勾选').check();
  await page.getByLabel('转账金额').fill('500');
  await page.getByRole('button', { name: '确认转账' }).click();
  expect(transfers).toEqual([{ fromPlayerId: 'player-2', toPlayerId: 'player-1', amount: 300 }]);
  ```

- [ ] **Step 2: 运行测试并确认它因缺少控件而失败**

  Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep "meizhuang landlord plot fine"`

  Expected: FAIL，定位器找不到标签“剧情罚俸或损失时勾选”。

- [ ] **Step 3: 最小化实现专属勾选和实际金额计算**

  在 `PlayerView` 添加 `const [transferIsPlotFine, setTransferIsPlotFine] = useState(false);`，并派生以下值：

  ```tsx
  const isMeizhuang = me?.characterId === 'meizhuang';
  const rawTransferAmount = Number(transferAmount);
  const transferAmountAfterPlotFineReduction = isMeizhuang && transferIsPlotFine
    ? rawTransferAmount - 200
    : rawTransferAmount;
  const validTransferAmount = Number.isInteger(rawTransferAmount)
    && transferAmountAfterPlotFineReduction > 0;
  ```

  将 `submitTransfer` 的 `amount` 替换为 `transferAmountAfterPlotFineReduction`，成功后同时清空输入和复选状态。将按钮禁用条件替换为 `!validTransferAmount`。在转账金额字段后、确认按钮前仅当 `isMeizhuang` 时添加：

  ```tsx
  <label>
    <input
      type="checkbox"
      checked={transferIsPlotFine}
      onChange={(event) => setTransferIsPlotFine(event.target.checked)}
    />
    剧情罚俸或损失时勾选
  </label>
  {transferIsPlotFine && <p className="sheet-copy">金额填写实际罚款金额，系统会自动计算扣减-200，请不要填写减后的金额</p>}
  ```

- [ ] **Step 4: 运行针对性回归测试并确认通过**

  Run: `npm run test:e2e -- tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep "meizhuang landlord plot fine"`

  Expected: PASS，500 两剧情金额发送 300 两，200 两时按钮禁用，普通玩家不显示勾选且保持原金额。

- [ ] **Step 5: 运行静态验证**

  Run: `npm run typecheck && npm run lint`

  Expected: 两个命令均以 exit code 0 完成。

- [ ] **Step 6: 提交实现**

  ```bash
  git add apps/web/app/components/app-router-client.tsx tests/e2e/task7-contract.spec.ts
  git commit -m "feat: reduce meizhuang landlord plot fines"
  ```
