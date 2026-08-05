# 页面骨架最短展示与内容淡入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已有全屏页面骨架至少展示 600ms，并在数据就绪后以 160ms 淡入目标内容，同时保持局部业务操作原速度。

**Architecture:** 在现有 `route-transition.ts` 中增加不依赖 React 的最短展示门控器，以代次和单调时间控制释放；新增一个专用 React Hook 把原始路由加载状态转换成最终骨架可见状态，并处理减少动态效果和内容淡入。`AppRouterClient` 继续负责认证、路由和数据就绪，只接入 Hook，不改变业务请求流程。

**Tech Stack:** Next.js 16、React 19、TypeScript、CSS Modules/全局 CSS、Vitest、Playwright、Docker Compose。

## Global Constraints

- 全屏骨架一旦出现，默认至少展示 `600ms`。
- 目标内容淡入时间固定为 `160ms`。
- 真实加载超过 `600ms` 时不得再附加最短展示等待。
- `prefers-reduced-motion: reduce` 时取消人为等待、骨架脉冲和内容淡入。
- 不延长转帐、审批、建造、修正、登录提交等局部加载状态。
- 保持现有 `10_000ms` 路由看门狗及提示文案不变。
- 服务只能通过 Docker Compose 运行在 Web `3000`、API `4000`；不得用 npm 启动服务或另开测试端口。
- 不修改或提交 `.superpowers/sdd/*`。
- 未经用户明确确认，不得合并分支或推送远端。

---

## File Structure

- Modify: `apps/web/app/components/route-transition.ts` — 提供时间常量和可独立测试的最短展示门控器。
- Modify: `apps/web/app/components/route-transition.test.ts` — 覆盖剩余等待、慢加载、连续导航和取消。
- Create: `apps/web/app/components/route-transition-presentation.ts` — React 展示 Hook，管理骨架保留、减少动态效果和内容淡入标记。
- Create: `apps/web/app/components/route-transition-presentation.test.ts` — 约束 Hook 的媒体查询、清理和淡入接线。
- Modify: `apps/web/app/components/app-router-client.tsx` — 将现有原始加载条件接入展示 Hook，并让看门狗清理人为等待。
- Modify: `apps/web/app/components/app-router-client.test.ts` — 约束路由组件只通过新 Hook决定骨架可见性。
- Modify: `apps/web/app/globals.css` — 增加 160ms 页面根内容淡入动画及减少动态效果覆盖。
- Modify: `tests/e2e/routing.spec.ts` — 验证快速、慢速和减少动态效果三种页面级过渡。

---

### Task 1: 最短展示计时门控器

**Files:**
- Modify: `apps/web/app/components/route-transition.ts`
- Modify: `apps/web/app/components/route-transition.test.ts`

**Interfaces:**
- Consumes: 平台 `setTimeout`、`clearTimeout` 和单调时间函数。
- Produces: `MIN_ROUTE_SKELETON_MS`、`ROUTE_CONTENT_REVEAL_MS`、`createMinimumRouteSkeletonGate(options)`；Task 2 的 React Hook 依赖这些导出。

- [ ] **Step 1: 写门控器失败测试**

在 `route-transition.test.ts` 的导入中加入新接口，并追加以下测试：

```ts
import {
  MIN_ROUTE_SKELETON_MS,
  ROUTE_CONTENT_REVEAL_MS,
  ROUTE_TRANSITION_TIMEOUT_MS,
  createMinimumRouteSkeletonGate,
  createRouteTransitionWatchdog,
  isSameClientRoute,
} from "./route-transition";

it("holds a fast route only for the remaining minimum duration", () => {
  vi.useFakeTimers();
  let now = 0;
  const onRelease = vi.fn();
  const gate = createMinimumRouteSkeletonGate({ onRelease, now: () => now });

  const generation = gate.begin();
  now = 200;
  expect(gate.requestRelease(generation)).toBe(true);
  vi.advanceTimersByTime(MIN_ROUTE_SKELETON_MS - 201);
  expect(onRelease).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onRelease).toHaveBeenCalledWith(generation);
});

it("releases immediately when real loading exceeds the minimum", () => {
  let now = 0;
  const onRelease = vi.fn();
  const gate = createMinimumRouteSkeletonGate({ onRelease, now: () => now });

  const generation = gate.begin();
  now = MIN_ROUTE_SKELETON_MS + 1;
  expect(gate.requestRelease(generation)).toBe(true);
  expect(onRelease).toHaveBeenCalledWith(generation);
});

it("cannot release a newer navigation from an older timer", () => {
  vi.useFakeTimers();
  let now = 0;
  const onRelease = vi.fn();
  const gate = createMinimumRouteSkeletonGate({ onRelease, now: () => now });

  const first = gate.begin();
  now = 100;
  gate.requestRelease(first);
  now = 200;
  const second = gate.begin();
  now = 250;
  gate.requestRelease(second);

  vi.advanceTimersByTime(500);
  expect(onRelease).not.toHaveBeenCalled();
  vi.advanceTimersByTime(50);
  expect(onRelease).toHaveBeenCalledTimes(1);
  expect(onRelease).toHaveBeenCalledWith(second);
});

it("cancel prevents a pending artificial release", () => {
  vi.useFakeTimers();
  const onRelease = vi.fn();
  const gate = createMinimumRouteSkeletonGate({ onRelease, now: () => 0 });

  const generation = gate.begin();
  gate.requestRelease(generation);
  gate.cancel();
  vi.runAllTimers();

  expect(onRelease).not.toHaveBeenCalled();
});

it("exports the approved transition timings", () => {
  expect(MIN_ROUTE_SKELETON_MS).toBe(600);
  expect(ROUTE_CONTENT_REVEAL_MS).toBe(160);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
npm exec vitest run -- apps/web/app/components/route-transition.test.ts
```

Expected: FAIL，提示 `createMinimumRouteSkeletonGate`、`MIN_ROUTE_SKELETON_MS` 和 `ROUTE_CONTENT_REVEAL_MS` 尚未导出。

- [ ] **Step 3: 实现最小门控器**

在 `route-transition.ts` 中保留现有接口，并增加：

```ts
export const MIN_ROUTE_SKELETON_MS = 600;
export const ROUTE_CONTENT_REVEAL_MS = 160;

type MinimumRouteSkeletonGateOptions = {
  onRelease: (generation: number) => void;
  minimumMs?: number;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
};

export function createMinimumRouteSkeletonGate({
  onRelease,
  minimumMs = MIN_ROUTE_SKELETON_MS,
  now = () => performance.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
}: MinimumRouteSkeletonGateOptions) {
  let generation = 0;
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  return {
    begin() {
      generation += 1;
      clearTimer();
      startedAt = now();
      return generation;
    },
    requestRelease(expectedGeneration = generation) {
      if (startedAt === null || expectedGeneration !== generation) return false;
      clearTimer();
      const remaining = Math.max(0, minimumMs - (now() - startedAt));
      const finish = () => {
        if (startedAt === null || expectedGeneration !== generation) return;
        timer = null;
        startedAt = null;
        onRelease(expectedGeneration);
      };
      if (remaining === 0) finish();
      else timer = schedule(finish, remaining);
      return true;
    },
    cancel() {
      generation += 1;
      clearTimer();
      startedAt = null;
    },
    currentGeneration() {
      return generation;
    },
  };
}
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run:

```bash
npm exec vitest run -- apps/web/app/components/route-transition.test.ts
```

Expected: 所有 `route transition` 测试通过，0 failures。

- [ ] **Step 5: 提交 Task 1**

```bash
git add apps/web/app/components/route-transition.ts apps/web/app/components/route-transition.test.ts
git commit -m "feat(web): add minimum route skeleton gate"
```

---

### Task 2: React 展示 Hook 与淡入样式

**Files:**
- Create: `apps/web/app/components/route-transition-presentation.ts`
- Create: `apps/web/app/components/route-transition-presentation.test.ts`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: Task 1 的 `createMinimumRouteSkeletonGate()` 和 `ROUTE_CONTENT_REVEAL_MS`。
- Produces: `useRouteTransitionPresentation(loading): { showSkeleton: boolean; cancelMinimumDelay: () => void }`，供 Task 3 的路由组件调用。

- [ ] **Step 1: 写 Hook 与样式源码契约失败测试**

创建 `route-transition-presentation.test.ts`：

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hookUrl = new URL("./route-transition-presentation.ts", import.meta.url);
const cssUrl = new URL("../globals.css", import.meta.url);

describe("route transition presentation", () => {
  it("holds route loading with the shared gate and exposes watchdog cancellation", async () => {
    const source = await readFile(fileURLToPath(hookUrl), "utf8");
    expect(source).toContain("createMinimumRouteSkeletonGate");
    expect(source).toContain("matchMedia(\"(prefers-reduced-motion: reduce)\")");
    expect(source).toContain("cancelMinimumDelay");
    expect(source).toMatch(/showSkeleton:\s*loading\s*\|\|\s*holding/);
  });

  it("adds one root reveal animation with a reduced-motion override", async () => {
    const css = await readFile(fileURLToPath(cssUrl), "utf8");
    expect(css).toMatch(/html\[data-route-reveal="true"\]\s+#root\s*>\s*main/);
    expect(css).toMatch(/animation:\s*route-content-reveal 160ms ease-out both/);
    expect(css).toMatch(/@keyframes route-content-reveal[\s\S]*?opacity:\s*0[\s\S]*?opacity:\s*1/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
npm exec vitest run -- apps/web/app/components/route-transition-presentation.test.ts
```

Expected: FAIL，因为 Hook 文件和淡入 CSS 尚不存在。

- [ ] **Step 3: 创建展示 Hook**

创建 `route-transition-presentation.ts`：

```ts
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ROUTE_CONTENT_REVEAL_MS,
  createMinimumRouteSkeletonGate,
} from "./route-transition";

export function useRouteTransitionPresentation(loading: boolean) {
  const [holding, setHolding] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const loadingRef = useRef(loading);
  const revealTimer = useRef<number | null>(null);
  const gateRef = useRef<ReturnType<
    typeof createMinimumRouteSkeletonGate
  > | null>(null);
  loadingRef.current = loading;

  const clearReveal = useCallback(() => {
    if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    revealTimer.current = null;
    delete document.documentElement.dataset.routeReveal;
  }, []);

  if (gateRef.current === null) {
    gateRef.current = createMinimumRouteSkeletonGate({
      onRelease: (generation) => {
        if (
          loadingRef.current ||
          gateRef.current?.currentGeneration() !== generation
        )
          return;
        clearReveal();
        document.documentElement.dataset.routeReveal = "true";
        setHolding(false);
        revealTimer.current = window.setTimeout(
          clearReveal,
          ROUTE_CONTENT_REVEAL_MS,
        );
      },
    });
  }

  const cancelMinimumDelay = useCallback(() => {
    gateRef.current?.cancel();
    clearReveal();
    setHolding(false);
  }, [clearReveal]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useLayoutEffect(() => {
    if (reducedMotion) {
      gateRef.current?.cancel();
      clearReveal();
      setHolding(false);
      return;
    }
    if (loading) {
      clearReveal();
      gateRef.current?.begin();
      setHolding(true);
      return;
    }
    gateRef.current?.requestRelease();
  }, [clearReveal, loading, reducedMotion]);

  useEffect(
    () => () => {
      gateRef.current?.cancel();
      clearReveal();
    },
    [clearReveal],
  );

  return { showSkeleton: loading || holding, cancelMinimumDelay };
}
```

- [ ] **Step 4: 增加 160ms 根内容淡入**

在 `globals.css` 的全局减少动态效果媒体查询之前加入：

```css
html[data-route-reveal="true"] #root > main {
  animation: route-content-reveal 160ms ease-out both;
}

@keyframes route-content-reveal {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

在现有 `@media (prefers-reduced-motion: reduce)` 内明确保留：

```css
html[data-route-reveal="true"] #root > main {
  animation: none;
}
```

- [ ] **Step 5: 运行聚焦测试并确认 GREEN**

Run:

```bash
npm exec vitest run -- apps/web/app/components/route-transition.test.ts apps/web/app/components/route-transition-presentation.test.ts apps/web/app/components/route-skeleton.test.ts
```

Expected: 三个测试文件全部通过，0 failures。

- [ ] **Step 6: 提交 Task 2**

```bash
git add apps/web/app/components/route-transition-presentation.ts apps/web/app/components/route-transition-presentation.test.ts apps/web/app/globals.css
git commit -m "feat(web): present minimum route loading state"
```

---

### Task 3: 接入 AppRouterClient 与看门狗

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:18-26, 1150-1230, 2235-2250`
- Modify: `apps/web/app/components/app-router-client.test.ts:20-50`

**Interfaces:**
- Consumes: Task 2 的 `useRouteTransitionPresentation(loading)`。
- Produces: 所有现有页面级 `RouteSkeleton` 统一遵循最短展示；看门狗可取消人为等待。

- [ ] **Step 1: 更新源码契约测试并确认旧实现不满足**

在 `app-router-client.test.ts` 的 `route transition skeleton` 测试中加入：

```ts
expect(component).toContain(
  'import { useRouteTransitionPresentation } from "./route-transition-presentation"',
);
expect(component).toMatch(
  /const routeLoading =[\s\S]*?routePending[\s\S]*?!pageReady/,
);
expect(component).toContain(
  "const { showSkeleton, cancelMinimumDelay } = useRouteTransitionPresentation(routeLoading)",
);
expect(component).toContain("cancelMinimumDelay();");
expect(component).toMatch(/if \(showSkeleton\) return <RouteSkeleton/);
```

并将原来直接匹配 `routePending` 条件返回骨架的断言删除。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
npm exec vitest run -- apps/web/app/components/app-router-client.test.ts
```

Expected: FAIL，提示新 Hook 尚未导入和调用。

- [ ] **Step 3: 在 AppRouterClient 中接入统一展示状态**

增加导入：

```ts
import { useRouteTransitionPresentation } from "./route-transition-presentation";
```

在现有 Toast 回调之后、路由看门狗 effect 之前计算：

```ts
const publicScreen =
  screen === "LANDING" || screen === "LOGIN" || screen === "FORBIDDEN";
const routeLoading =
  routePending ||
  (!publicScreen && (!authChecked || !account || !pageReady));
const { showSkeleton, cancelMinimumDelay } =
  useRouteTransitionPresentation(routeLoading);
```

把看门狗回调改为：

```ts
const watchdog = createRouteTransitionWatchdog(() => {
  cancelMinimumDelay();
  setRoutePending(false);
  showNotice("页面加载较慢，请重试");
});
```

对应 effect 依赖更新为：

```ts
}, [cancelMinimumDelay, showNotice]);
```

删除渲染末端重复的 `publicScreen` 定义，并把原始条件返回替换为：

```tsx
if (showSkeleton) return <RouteSkeleton />;
```

- [ ] **Step 4: 运行组件与计时测试并确认 GREEN**

Run:

```bash
npm exec vitest run -- apps/web/app/components/app-router-client.test.ts apps/web/app/components/route-transition.test.ts apps/web/app/components/route-transition-presentation.test.ts
```

Expected: 所有聚焦测试通过，0 failures。

- [ ] **Step 5: 运行现有路由 E2E 回归**

前提：Docker Compose 已在 `3000/4000` 运行当前工作树，不启动任何 npm 服务。

Run:

```bash
PLAYWRIGHT_EXTERNAL_STACK=1 npm exec playwright test -- tests/e2e/routing.spec.ts tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep "route skeleton|delayed finish preview|takeover keeps"
```

Expected: 旧页面遮罩、延迟结束预览和接管控制权用例全部通过。

- [ ] **Step 6: 提交 Task 3**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts
git commit -m "feat(web): hold full-screen route skeletons"
```

---

### Task 4: 浏览器时间、慢请求与减少动态效果验收

**Files:**
- Modify: `tests/e2e/routing.spec.ts`

**Interfaces:**
- Consumes: Task 3 的页面级最短骨架行为。
- Produces: 对快速路由、慢请求不叠加延迟和减少动态效果的自动化回归证据。

- [ ] **Step 1: 添加快速路由最短展示测试**

在 `routing.spec.ts` 中加入：

```ts
test('fast route data keeps the full-screen skeleton visible for the approved minimum', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'one timing gate is sufficient');
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/sessions', (route) => route.fulfill({ json: [] }));

  await page.goto('/rooms');
  await expect(page.getByRole('button', { name: '个人信息' })).toBeVisible();
  const startedAt = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: '个人信息' }).click();
  await expect(page.getByTestId('route-skeleton')).toBeVisible();
  await expect(page.getByRole('heading', { name: '个人信息' })).toBeVisible();
  const elapsed = await page.evaluate((started) => performance.now() - started, startedAt);

  expect(elapsed).toBeGreaterThanOrEqual(550);
  expect(elapsed).toBeLessThan(1_500);
  await expect(page.locator('html')).toHaveAttribute('data-route-reveal', 'true');
});
```

- [ ] **Step 2: 添加慢请求不叠加等待测试**

```ts
test('a real load longer than the minimum reveals immediately after data arrives', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'one timing gate is sufficient');
  let releaseSessions!: () => void;
  const sessionsGate = new Promise<void>((resolve) => { releaseSessions = resolve; });
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/sessions', async (route) => {
    await sessionsGate;
    await route.fulfill({ json: [] });
  });

  await page.goto('/rooms');
  await page.getByRole('button', { name: '个人信息' }).click();
  await expect(page.getByTestId('route-skeleton')).toBeVisible();
  await page.waitForTimeout(700);
  const releasedAt = await page.evaluate(() => performance.now());
  releaseSessions();
  await expect(page.getByRole('heading', { name: '个人信息' })).toBeVisible();
  const revealDelay = await page.evaluate((started) => performance.now() - started, releasedAt);

  expect(revealDelay).toBeLessThan(400);
});
```

- [ ] **Step 3: 添加减少动态效果测试**

```ts
test('reduced motion waits only for real route data', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'one media gate is sufficient');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/sessions', (route) => route.fulfill({ json: [] }));

  await page.goto('/rooms');
  const startedAt = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: '个人信息' }).click();
  await expect(page.getByRole('heading', { name: '个人信息' })).toBeVisible();
  const elapsed = await page.evaluate((started) => performance.now() - started, startedAt);

  expect(elapsed).toBeLessThan(550);
  await expect(page.locator('html')).not.toHaveAttribute('data-route-reveal', 'true');
});
```

- [ ] **Step 4: 先在未实现状态运行新用例确认 RED，再在实现后确认 GREEN**

实现者必须在 Task 3 合并前临时运行这些测试对旧提交确认至少“600ms 最短展示”用例失败；恢复 Task 3 后运行：

```bash
PLAYWRIGHT_EXTERNAL_STACK=1 npm exec playwright test -- tests/e2e/routing.spec.ts --project=desktop-chromium --grep "approved minimum|longer than the minimum|reduced motion"
```

Expected: 3 passed，0 failed。

- [ ] **Step 5: 提交 Task 4**

```bash
git add tests/e2e/routing.spec.ts
git commit -m "test(e2e): cover minimum route loading duration"
```

---

### Task 5: 完整验证与本地交付

**Files:**
- Verify only; do not modify `.superpowers/sdd/*` or generated `apps/web/next-env.d.ts`.

**Interfaces:**
- Consumes: Tasks 1-4 的全部本地提交。
- Produces: 可供用户决定是否推送/合并的验证证据。

- [ ] **Step 1: 运行四项质量门禁**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Expected: 四个命令退出码均为 0；若构建改写 `apps/web/next-env.d.ts`，只恢复该生成差异，不改动其他文件。

- [ ] **Step 2: 运行完整 Playwright 矩阵**

确认 Docker Web/API/PostgreSQL 均来自当前工作树且端口固定为 `3000/4000`：

```bash
docker compose ps
PLAYWRIGHT_EXTERNAL_STACK=1 npm run test:e2e
```

Expected: 0 failed；条件跳过项按测试配置记录，不视为失败。

- [ ] **Step 3: 进行响应式视觉检查**

使用 Docker 页面 `http://localhost:3000` 检查 `1440x900`、`390x844`、`375x667`：

- 骨架非空白，布局稳定，无横向滚动。
- 快速导航可看清至少一次骨架脉冲。
- 内容淡入不遮挡按钮、不改变滚动位置。
- 页面标题、登录表单或旧房间内容不回闪。

- [ ] **Step 4: 检查工作树和提交边界**

```bash
git diff --check
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected: 工作树干净，仅包含本功能的计划内提交；无 `.superpowers/sdd/*`、测试产物或生成文件差异。

- [ ] **Step 5: 等待用户确认远端操作**

汇报本地分支、提交、四项门禁、完整 E2E 和视觉结果。不得运行 `git push`、`git merge` 或创建 PR；只有用户明确确认后才能执行相应远端操作。
