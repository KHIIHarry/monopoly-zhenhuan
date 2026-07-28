# 事务板块剧情罚款排序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将银行端“事务”板块的剧情罚款模块移动到第一个位置，同时保持其罚款流程不变。

**Architecture:** 在 `BankWorkbench` 的 `TRANSACTION` 分支内移动现有剧情罚款 JSX 区块，不改变表单状态或事件处理器。Playwright 使用已有银行工作台夹具进入“事务”页，验证模块顺序并执行原有的提交到二次确认流程。

**Tech Stack:** TypeScript、React、Next.js、Playwright。

## Global Constraints

- “剧情罚款”标题及表单是“事务”内容的第一个模块。
- 不修改罚款玩家、金额、提交按钮、二次确认或沈眉庄减免文案。
- 不修改 `POST /api/rooms/:id/events/plot-fine` 请求、参数或提交后的刷新行为。
- 不变更 API、Socket、数据库和 CSS。
- 工作目录不含 `.git`，提交步骤记录为跳过。

---

## File Structure

- `apps/web/app/components/app-router-client.tsx`：移动“剧情罚款”标题及表单至 `TRANSACTION` 内容开头。
- `tests/e2e/task7-visual.spec.ts`：验证事务模块首项及剧情罚款确认流程。

### Task 1: 剧情罚款优先展示

**Files:**
- Modify: `tests/e2e/task7-visual.spec.ts:517-610`
- Modify: `apps/web/app/components/app-router-client.tsx:1990-2024`

**Interfaces:**
- Consumes: `BankWorkbench` 的 `plotFinePlayerId`、`plotFineAmount`、`plotFineOpen` 状态和 `executePlotFine()`。
- Produces: “事务”面板中第一个 `.section-title` 的标题“剧情罚款”。
- Preserves: `POST /api/rooms/${snapshot.id}/events/plot-fine` with `{ playerId, amount }` after confirmation.

- [ ] **Step 1: Write the failing browser regression test**

Add this test after the existing bank-workbench visual test. It reuses the file's `mockAuthenticated`, `mockRoom`, `snapshot`, and `dual` fixtures:

```ts
test('transaction starts with plot fine and retains its confirmation flow', async ({ page }) => {
  const requests: Array<{ method: string; body: unknown }> = [];
  await mockAuthenticated(page);
  await mockRoom(page);
  await page.route('**/api/rooms/room-1/events/plot-fine', async (route) => {
    requests.push({ method: route.request().method(), body: route.request().postDataJSON() });
    await route.fulfill({ json: {} });
  });

  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(longRoomName) }).click();
  await page.getByRole('button', { name: '银行端', exact: true }).click();
  await page.getByRole('button', { name: '事务', exact: true }).click();

  const transaction = page.locator('.transaction-page');
  await expect(transaction.locator('.section-title').first()).toHaveText(/剧情罚款/);
  await transaction.getByLabel('剧情罚款金额').fill('100');
  await transaction.getByRole('button', { name: '执行剧情罚款', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认剧情罚款' })).toBeVisible();
  await page.getByRole('dialog', { name: '确认剧情罚款' }).getByRole('button', { name: '确认罚款', exact: true }).click();
  await expect.poll(() => requests).toEqual([{ method: 'POST', body: { playerId: snapshot.players[0].id, amount: 100 } }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- tests/e2e/task7-visual.spec.ts --project=desktop-chromium --grep "transaction starts with plot fine"`

Expected: FAIL because the first `.section-title` is currently “轮次控制”.

- [ ] **Step 3: Move the existing JSX block**

In the `tab === 'TRANSACTION'` branch, cut this existing block without changing its contents:

```tsx
<SectionTitle title="剧情罚款" action="需要二次确认" />
<form className="tool-section" onSubmit={(event) => { event.preventDefault(); setPlotFineOpen(true); }}>
  <div className="tool-heading"><AlertTriangle /><div><h2>执行剧情罚款</h2><p>按剧情卡原始金额录入</p></div></div>
  <label>罚款玩家<select required value={plotFinePlayerId} onChange={(event) => setPlotFinePlayerId(event.target.value)}>{snapshot.players.map((player) => <option value={player.id} key={player.id}>{player.name}</option>)}</select></label>
  <label>剧情罚款金额<input required type="number" min="1" step="1" inputMode="numeric" value={plotFineAmount} onChange={(event) => setPlotFineAmount(event.target.value)} /></label>
  <button className="danger-button" type="submit" disabled={busy || !plotFinePlayerId || !Number.isInteger(Number(plotFineAmount)) || Number(plotFineAmount) <= 0}>执行剧情罚款</button>
</form>
```

Paste it immediately after `<div className="transaction-page">`, before the existing “轮次控制” `SectionTitle`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:e2e -- tests/e2e/task7-visual.spec.ts --project=desktop-chromium --grep "transaction starts with plot fine"`

Expected: PASS. The first module is “剧情罚款”, and one confirmed POST carries the selected player id and integer amount.

- [ ] **Step 5: Run static verification**

Run: `npm run typecheck && npm run lint`

Expected: both commands exit with code 0 and report no TypeScript or ESLint errors.

- [ ] **Step 6: Commit**

Skip: this workspace has no `.git` directory.
