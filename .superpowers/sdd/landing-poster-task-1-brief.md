### Task 1: 建立首页海报的行为与响应式回归测试

**Files:**
- Modify: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- Consumes: 现有首页 `button` accessible name `加入游戏组`。
- Produces: 首页可视层、无溢出和跳转行为的 Playwright 回归测试。

- [ ] **Step 1: 写入会失败的首页海报测试。**

```ts
test('首页以分层宫廷海报展示且加入游戏组仍进入登录页', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } }));
  await page.goto('/');

  await expect(page.getByTestId('landing-poster')).toBeVisible();
  for (const layer of ['background', 'frame', 'characters', 'title', 'decorations', 'join-button']) {
    await expect(page.getByTestId(`landing-${layer}`)).toBeVisible();
  }
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);

  await page.getByRole('button', { name: '加入游戏组' }).click();
  await expect(page.getByLabel('用户名')).toBeVisible();
});
```

- [ ] **Step 2: 运行测试并确认它因缺少海报图层标识而失败。**

Run: `npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium --grep '首页以分层宫廷海报' --reporter=line`

Expected: FAIL，错误指向未找到 `landing-poster`。

- [ ] **Step 3: 将同一测试参数化为移动、iPad 和桌面视口。**

```ts
for (const viewport of [{ width: 360, height: 800 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.getByTestId('landing-poster')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
}
```

- [ ] **Step 4: 重跑测试，确认在实现前仍为预期失败。**

Run: `npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium --grep '首页以分层宫廷海报' --reporter=line`

Expected: FAIL，且失败原因仍是缺少实现而非测试语法错误。

Do not implement production components or CSS in this task. Preserve existing tests. The current workspace has no Git metadata, so record the absence rather than attempting a commit.
