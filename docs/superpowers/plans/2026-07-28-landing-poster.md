# 宫廷海报首页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将登录前首页改造成由独立本地素材和组件组成、可适配手机到桌面的竖版宫廷海报，并保留“加入游戏组”进入登录页的既有行为。

**Architecture:** 首页继续由 `page.tsx` 持有 `screen` 状态和登录回调。新增 `app/components/landing` 下的职责单一组件，`LandingPoster` 只组合图层，背景、边框、人物、标题、装饰和可点击按钮分别渲染。静态素材由项目根目录的 `板式2-元素拆分.PNG` 裁切到 Next.js `public/assets/landing`，运行时只引用裁切后的文件。

**Tech Stack:** React 19、Next.js 16、TypeScript、CSS Grid/Flex、Next Image、Playwright。

## Global Constraints

- 不使用整张设计图或拆分示意图作为页面背景。
- 必须保留按钮文本“加入游戏组”及其 `setScreen('LOGIN')` 行为。
- 外层使用 `100dvh` 和 safe-area，首页不得产生横向或纵向滚动条。
- 手机使用可用高度缩放；iPad 与桌面居中展示竖版海报，周围背景可延展但海报不横向拉伸。
- 背景使用 `cover`；人物、标题和按钮使用 `contain` 且保持原始比例。
- 排版优先使用 Grid、Flex、百分比、`clamp()` 与 `aspect-ratio`；不使用大量固定像素定位。
- 边框和前景装饰不得拦截按钮的鼠标、触摸或键盘交互。
- 当前目录无 Git 元数据；省略提交步骤。

---

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
  expect(await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  }))).toMatchObject({ scrollWidth: await page.evaluate(() => window.innerWidth), scrollHeight: await page.evaluate(() => window.innerHeight) });

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

### Task 2: 裁切并导出可独立组合的本地海报素材

**Files:**
- Create: `scripts/extract-landing-assets.sh`
- Create: `apps/web/public/assets/landing/background-texture.png`
- Create: `apps/web/public/assets/landing/palace-sky.png`
- Create: `apps/web/public/assets/landing/gold-frame.png`
- Create: `apps/web/public/assets/landing/characters.png`
- Create: `apps/web/public/assets/landing/foreground-flora.png`
- Create: `apps/web/public/assets/landing/game-title.png`
- Create: `apps/web/public/assets/landing/game-subtitle.png`
- Create: `apps/web/public/assets/landing/join-button.png`

**Interfaces:**
- Consumes: `/Users/harry/Documents/甄嬛传大富翁/板式2-元素拆分.PNG`（1536x1024）。
- Produces: `/assets/landing/<name>.png`，供首页组件使用。

- [ ] **Step 1: 写入可重复运行的裁切脚本，使用 `sips` 从示意图提取每个素材区域。**

```sh
#!/bin/zsh
set -euo pipefail
source_image="${0:A:h:h:h}/板式2-元素拆分.PNG"
output_dir="${0:A:h:h}/apps/web/public/assets/landing"
mkdir -p "$output_dir"
sips -c 302 256 --cropOffset 58 587 "$source_image" --out "$output_dir/background-texture.png"
sips -c 305 256 --cropOffset 55 869 "$source_image" --out "$output_dir/palace-sky.png"
sips -c 300 300 --cropOffset 58 1202 "$source_image" --out "$output_dir/gold-frame.png"
sips -c 250 600 --cropOffset 420 565 "$source_image" --out "$output_dir/characters.png"
sips -c 300 320 --cropOffset 408 1200 "$source_image" --out "$output_dir/foreground-flora.png"
sips -c 150 330 --cropOffset 770 570 "$source_image" --out "$output_dir/game-title.png"
sips -c 155 300 --cropOffset 770 900 "$source_image" --out "$output_dir/game-subtitle.png"
sips -c 100 300 --cropOffset 795 1200 "$source_image" --out "$output_dir/join-button.png"
```

- [ ] **Step 2: 执行脚本并用 `sips` 核对所有输出为 PNG 且具有正的宽高。**

Run: `zsh scripts/extract-landing-assets.sh && for asset in apps/web/public/assets/landing/*.png; do sips -g pixelWidth -g pixelHeight "$asset"; done`

Expected: 八个 PNG 文件均输出 `pixelWidth` 与 `pixelHeight`，数值大于 0。

- [ ] **Step 3: 逐个查看输出，必要时仅调整裁切坐标，确保运行时素材不带图三中的编号、说明文字或相邻组件。**

Run: `open apps/web/public/assets/landing`

Expected: 每个文件只包含其命名所对应的视觉元素；保留的纯黑底将由后续 CSS `mix-blend-mode: screen` 作为透明预览底处理，不能作为整张设计图背景使用。

### Task 3: 创建独立图层组件并完成响应式组合

**Files:**
- Create: `apps/web/app/components/landing/poster-background.tsx`
- Create: `apps/web/app/components/landing/poster-frame.tsx`
- Create: `apps/web/app/components/landing/poster-characters.tsx`
- Create: `apps/web/app/components/landing/poster-title.tsx`
- Create: `apps/web/app/components/landing/poster-decorations.tsx`
- Create: `apps/web/app/components/landing/poster-join-button.tsx`
- Create: `apps/web/app/components/landing/landing-poster.tsx`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- `LandingPoster({ onJoin }: { onJoin: () => void }): ReactNode` 是首页唯一入口组件。
- `PosterJoinButton({ onJoin }: { onJoin: () => void }): ReactNode` 必须输出 native `<button type="button">` 和文本“加入游戏组”。
- 每个视觉组件根节点使用对应的 `data-testid`：`landing-background`、`landing-frame`、`landing-characters`、`landing-title`、`landing-decorations`、`landing-join-button`；组合根节点为 `landing-poster`。

- [ ] **Step 1: 实现六个只渲染所属素材的组件，并由 `LandingPoster` 使用 Grid 的同一图层区域组合。**

```tsx
export function LandingPoster({ onJoin }: { onJoin: () => void }) {
  return <main className="landing-page">
    <section className="landing-poster" data-testid="landing-poster" aria-label="甄嬛传大富翁">
      <PosterBackground />
      <PosterCharacters />
      <PosterTitle />
      <PosterDecorations />
      <PosterFrame />
      <PosterJoinButton onJoin={onJoin} />
    </section>
  </main>;
}
```

- [ ] **Step 2: 以 `LandingPoster` 替换 `page.tsx` 中 `screen === 'LANDING'` 的内联海报，并保留原回调。**

```tsx
if (screen === 'LANDING') return <LandingPoster onJoin={() => setScreen('LOGIN')} />;
```

- [ ] **Step 3: 在同一任务中完成 Task 4 的比例海报布局。**

Task 1 的无溢出断言需要实际响应式样式，故组件和布局必须在同一个 GREEN 阶段交付。删除旧 `.v2-landing` 和 `.v2-poster` 样式，使用 `.landing-page`、`.landing-poster`、`.landing-layer` 和最高层级 `.landing-join-button` 实现 `100dvh`、safe-area、`aspect-ratio: 2 / 3`、Grid 叠层与 `overflow: clip`。外层纹理背景使用 `/assets/landing/background-texture.png` 的 `cover`；宫殿背景用 `cover`；人物、标题、按钮用 `contain`；边框和装饰使用 `pointer-events: none`。

- [ ] **Step 4: 运行 Task 1 的测试并确认组件、响应式布局、素材和原跳转行为通过。**

Run: `npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium --grep '首页以分层宫廷海报' --reporter=line`

Expected: PASS。

### Task 4: 已并入 Task 3

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/components/landing/*.tsx`

**Interfaces:**
- `.landing-page` 占用可视区域且不滚动。
- `.landing-poster` 使用 `aspect-ratio: 2 / 3`，仅由高度和比例计算宽度。
- `.landing-layer` 共享 Grid 区域；`.landing-join-button` 的 z-index 高于所有装饰。

- [ ] **Step 1: 将旧 `.v2-landing` 和 `.v2-poster` 首页样式替换为以下结构性规则。**

```css
.landing-page { min-height: 100dvh; height: 100dvh; overflow: clip; display: grid; place-items: center; padding: env(safe-area-inset-top) max(0.75rem, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(0.75rem, env(safe-area-inset-left)); background: #4f080b url('/assets/landing/background-texture.png') center / cover; }
.landing-poster { width: min(100%, calc((100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)) * 2 / 3)); height: min(100%, calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom))); aspect-ratio: 2 / 3; display: grid; grid-template: 1fr / 1fr; isolation: isolate; overflow: hidden; }
.landing-layer { grid-area: 1 / 1; min-width: 0; min-height: 0; pointer-events: none; }
.landing-poster img { width: 100%; height: 100%; object-fit: contain; }
.landing-background img { object-fit: cover; }
.landing-join-button { grid-area: 1 / 1; z-index: 8; align-self: end; justify-self: center; width: clamp(11rem, 55%, 21rem); margin-bottom: clamp(2.5rem, 8%, 6.5rem); border: 0; background: transparent; padding: 0; }
.landing-join-button img { display: block; width: 100%; height: auto; }
```

- [ ] **Step 2: 使用百分比 Grid 区域定位人物、标题、前景花卉和边框；为标题及按钮规定 `clamp()` 宽度，禁止使用拉伸尺寸。**

```css
.landing-characters { z-index: 2; align-self: center; justify-self: center; width: min(96%, 42rem); transform: translateY(-8%); }
.landing-title { z-index: 4; align-self: end; justify-self: center; width: clamp(12rem, 72%, 34rem); transform: translateY(-85%); }
.landing-decorations { z-index: 5; align-self: end; width: 100%; mix-blend-mode: screen; }
.landing-frame { z-index: 7; inset: 1.2%; width: 97.6%; height: 97.6%; mix-blend-mode: screen; }
```

- [ ] **Step 3: 执行移动、iPad 和桌面测试，确认无滚动和按钮可点击。**

Run: `npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium --grep '首页以分层宫廷海报' --reporter=line`

Expected: PASS；测试内部的 360x800、768x1024 与 1440x900 断言均通过。

### Task 5: 完整验证与视觉检查

**Files:**
- Modify: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- 保持所有既有首页、登录和工作台流程测试的公共选择器不变。

- [ ] **Step 1: 为三种视口添加截图，保留在 Playwright `test-results` 以人工检查居中、比例和图层顺序。**

```ts
await page.screenshot({ path: `test-results/landing-${viewport.width}x${viewport.height}.png` });
```

- [ ] **Step 2: 运行首页端到端测试。**

Run: `npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium --reporter=line`

Expected: PASS，且首页测试证明点击“加入游戏组”进入登录界面。

- [ ] **Step 3: 运行项目静态检查与构建。**

Run: `npm run lint && npm run typecheck && npm run build`

Expected: 三条命令均以 exit code 0 结束。

- [ ] **Step 4: 人工查看三张截图，检查手机、iPad 和桌面均为居中的竖版海报，外层背景延展而主体未被拉伸，按钮无遮挡且可点击。**

Run: `open test-results/landing-360x800.png test-results/landing-768x1024.png test-results/landing-1440x900.png`

Expected: 三个视口均无滚动条、无变形、无文字或素材越界。
