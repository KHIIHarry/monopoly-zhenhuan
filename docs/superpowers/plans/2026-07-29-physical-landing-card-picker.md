# 实体落点地产卡片选择器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将玩家端的实体落点下拉框替换为可搜索、可选择且展示产权状态的地产卡片选择器。

**Architecture:** 新增无 React 依赖的地产选择模型，负责名称筛选和由 `ownerId` 推导“已购/无主”展示状态，并以 Vitest 覆盖。新增局部 React 组件负责搜索输入、可访问的卡片按钮与选中反馈；玩家工作台继续持有 `landing` 状态并将其传入组件，确认请求保持不变。

**Tech Stack:** Next.js、React、TypeScript、Lucide React、Vitest、Playwright、CSS。

## Global Constraints

- 仅修改玩家端“声明实体落点”面板，不改其他地产下拉框。
- `POST /api/rooms/:roomId/landings` 的请求体继续为 `{ playerId, propertyName }`。
- 已购、无主和已抵押是纯展示状态，任何卡片都必须可选。
- 所有状态由实时 `snapshot.properties` 与 `snapshot.players` 推导；禁止新增本地产权状态或持久化。
- 卡片必须以按钮语义支持键盘选择，选中状态不得只通过颜色表达。
- 保留既有说明文字和酒红色“确认落点”主按钮的文案、视觉等级与提交行为。

---

### Task 1: 通过纯模型固定筛选与产权状态规则

**Files:**
- Create: `apps/web/app/components/landing-property-picker.ts`
- Create: `apps/web/app/components/landing-property-picker.test.ts`

**Interfaces:**
- Produces: `LandingProperty`、`LandingPlayer`、`filterLandingProperties()`、`landingOwnership()`。
- Consumes: 结构兼容的工作台 `Property` 和 `Player` 数据，不依赖 React 或 API。

- [ ] **Step 1: 编写失败的单元测试**

```ts
import { describe, expect, it } from 'vitest';
import { filterLandingProperties, landingOwnership } from './landing-property-picker';

const properties = [
  { name: '景仁宫', ownerId: 'p1', level: 2, mortgaged: false, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1200, tolls: [800, 2000] },
  { name: '碎玉轩', ownerId: null, level: 0, mortgaged: false, mortgage: 800, purchasePrice: 1600, build: 1000, buildingSell: 600, tolls: [300, 700] }
];

describe('landing property picker model', () => {
  it('filters property names after trimming whitespace', () => {
    expect(filterLandingProperties(properties, ' 玉轩 ')).toEqual([properties[1]]);
  });

  it('marks a property with an owner as purchased and resolves the owner name', () => {
    expect(landingOwnership(properties[0], [{ id: 'p1', name: '皇后' }])).toEqual({ label: '已购', ownerName: '皇后' });
  });

  it('marks a property without an owner as unowned', () => {
    expect(landingOwnership(properties[1], [{ id: 'p1', name: '皇后' }])).toEqual({ label: '无主', ownerName: null });
  });
});
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test -- apps/web/app/components/landing-property-picker.test.ts`

Expected: FAIL，因为 `./landing-property-picker` 尚不存在。

- [ ] **Step 3: 写入最小模型实现**

```ts
export type LandingProperty = {
  name: string;
  ownerId: string | null;
  level: number;
  mortgaged: boolean;
  mortgage: number;
  purchasePrice: number;
  build: number;
  buildingSell: number;
  tolls: number[];
};

export type LandingPlayer = { id: string; name: string };

export function filterLandingProperties<T extends LandingProperty>(properties: T[], query: string): T[] {
  const term = query.trim();
  return term ? properties.filter((property) => property.name.includes(term)) : properties;
}

export function landingOwnership(property: LandingProperty, players: LandingPlayer[]) {
  const ownerName = property.ownerId ? players.find((player) => player.id === property.ownerId)?.name ?? '未知玩家' : null;
  return { label: property.ownerId ? '已购' : '无主', ownerName } as const;
}
```

- [ ] **Step 4: 验证单元测试通过**

Run: `npm test -- apps/web/app/components/landing-property-picker.test.ts`

Expected: PASS，3 个测试全部通过。

- [ ] **Step 5: 提交（仓库存在时）**

```bash
git add apps/web/app/components/landing-property-picker.ts apps/web/app/components/landing-property-picker.test.ts
git commit -m "test: define landing property picker rules"
```

### Task 2: 建立可访问的地产卡片选择组件

**Files:**
- Create: `apps/web/app/components/landing-property-card-picker.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `LandingProperty`、`LandingPlayer`、`filterLandingProperties()` 和 `landingOwnership()`。
- Produces: `LandingPropertyPicker({ properties, players, value, onChange })`；每个卡片为 `button`，卡片名称为其可访问名称。

- [ ] **Step 1: 扩展失败的端到端测试**

在 `tests/e2e/task7-workflows.spec.ts` 的 `successful landing declaration...` 用例中将快照地产改为一块无主、一块已购且已抵押的地产，并在点击“声明落点”后加入：

```ts
await page.getByPlaceholder('搜索地产名称').fill('景仁');
await expect(page.getByText('碎玉轩', { exact: true })).toHaveCount(0);
const purchased = page.getByRole('button', { name: /景仁宫.*已购.*皇后/ });
await expect(purchased).toBeVisible();
await expect(purchased.getByText('已抵押')).toBeVisible();
await purchased.click();
await expect(page.getByText('已选：景仁宫')).toBeVisible();
await page.getByRole('button', { name: '确认落点' }).click();
```

并将路由断言调整为 `{ playerId: 'player-1', propertyName: '景仁宫' }`。新增一个独立用例，搜索不存在的名称并断言“没有找到匹配的地产”。

- [ ] **Step 2: 验证端到端测试失败**

Run: `npm run test:e2e -- tests/e2e/task7-workflows.spec.ts -g "successful landing declaration|landing picker shows empty state"`

Expected: FAIL，因为搜索框和卡片按钮尚不存在。

- [ ] **Step 3: 实现最小卡片组件**

在 `apps/web/app/components/landing-property-card-picker.tsx` 中使用本任务的模型函数，维护局部 `query` 状态，并按如下结构渲染：

```tsx
<div className="landing-property-picker">
  <label className="landing-property-search">
    <span>搜索地产</span>
    <input placeholder="搜索地产名称" value={query} onChange={(event) => setQuery(event.target.value)} />
  </label>
  <p className="landing-property-selection" aria-live="polite">已选：{value || '未选择'}</p>
  <div className="landing-property-grid" aria-label="选择落点地产">
    {visible.map((property) => {
      const ownership = landingOwnership(property, players);
      const selected = property.name === value;
      return <button type="button" className={`landing-property-card${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={() => onChange(property.name)}>
        <span className={`landing-property-badge ${ownership.label === '已购' ? 'owned' : 'unowned'}`}>{ownership.label}</span>
        <span className="landing-property-card-title">{property.name}{selected && <Check aria-label="已选择" />}</span>
        <span className="landing-property-card-meta"><span>购买价<strong>{formatMoney(property.purchasePrice)} 两</strong></span><span>当前过路费<strong>{formatMoney(property.tolls[property.level] ?? 0)} 两</strong></span></span>
        <span className="landing-property-card-meta"><span>所有者<strong>{ownership.ownerName ?? '无主'}</strong></span><span>建筑<strong>{property.level === 5 ? '大宫殿' : `${property.level} 级`}</strong></span></span>
        {property.mortgaged && <span className="landing-property-mortgaged">已抵押</span>}
      </button>;
    })}
  </div>
  {!visible.length && <div className="empty no-margin">没有找到匹配的地产</div>}
</div>
```

卡片需显示 `property.name`、`purchasePrice`、`property.tolls[property.level] ?? 0`、`level`、`ownership.ownerName ?? '无主'`；卡片右上状态角标显示 `ownership.label`，`mortgaged` 时显示“已抵押”。从 `lucide-react` 导入 `Check` 与 `Search`，用 `Check` 辅助选中反馈。

在 `apps/web/app/globals.css` 添加以下类的响应式样式：`.landing-property-picker`、`.landing-property-search`、`.landing-property-selection`、`.landing-property-grid`、`.landing-property-card`、`.landing-property-card.selected`、`.landing-property-badge`、`.landing-property-card-meta`。网格使用 `repeat(auto-fit, minmax(190px, 1fr))`，卡片采用现有白纸、金色边线和红色已购角标；在小屏上保持单列且卡片文本不溢出。

- [ ] **Step 4: 验证端到端测试通过**

Run: `npm run test:e2e -- tests/e2e/task7-workflows.spec.ts -g "successful landing declaration|landing picker shows empty state"`

Expected: PASS，已购卡片可选择、请求体为选中地产、无匹配搜索显示空状态。

- [ ] **Step 5: 提交（仓库存在时）**

```bash
git add apps/web/app/components/landing-property-card-picker.tsx apps/web/app/globals.css tests/e2e/task7-workflows.spec.ts
git commit -m "feat: add searchable landing property cards"
```

### Task 3: 接入玩家工作台并完成回归验证

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:1-30, 1389-1390, 1642-1646`
- Modify: `tests/e2e/task7-visual.spec.ts`（仅在现有落点弹窗视觉检查需要更新定位时）

**Interfaces:**
- Consumes: `LandingPropertyPicker` 的 `value` 和 `onChange` 受控接口。
- Preserves: `confirmLanding()`、`landing` state、请求体和成功后的 `trustLanding()` 行为。

- [ ] **Step 1: 为工作台接入写失败的浏览器断言**

在 Task 2 的成功声明用例末尾保留以下断言，确保新 UI 不改变既有成功路径：

```ts
await expect(page.getByRole('heading', { name: '声明实体落点' })).toHaveCount(0);
await expect(page.getByText('落点待银行确认：景仁宫')).toBeVisible();
expect(await page.evaluate(() => [...Object.entries(localStorage), ...Object.entries(sessionStorage)].filter(([key, value]) => /auth|token|identity|membership|playerId|roomId|zhenhuan-landings|room-1|player-1/i.test(`${key}:${value}`)))).toEqual([]);
```

- [ ] **Step 2: 验证接入测试失败**

Run: `npm run test:e2e -- tests/e2e/task7-workflows.spec.ts -g "successful landing declaration"`

Expected: FAIL，直到原生 `select` 被新组件替换且选择值连接到 `landing` state。

- [ ] **Step 3: 替换落点下拉框**

在 `app-router-client.tsx` 顶部导入新组件，并将原来的：

```tsx
<label>到达地产<select value={landing} onChange={(event) => setLanding(event.target.value)}>{snapshot.properties.map((property) => <option key={property.name}>{property.name}</option>)}</select></label>
```

替换为：

```tsx
<LandingPropertyPicker properties={snapshot.properties} players={snapshot.players} value={landing} onChange={setLanding} />
```

不要修改 `confirmLanding()`、按钮禁用条件或任何服务端代码。

- [ ] **Step 4: 验证工作台行为通过**

Run: `npm run test:e2e -- tests/e2e/task7-workflows.spec.ts -g "successful landing declaration|landing picker shows empty state"`

Expected: PASS，选择卡片后的提交、面板关闭和待确认消息均保持正确。

- [ ] **Step 5: 执行静态检查与视觉验证**

Run: `npm test -- apps/web/app/components/landing-property-picker.test.ts && npm run typecheck && npm run lint && npm run build -w @zhenhuan/web`

Expected: 全部 PASS。

Run: `npm run test:e2e -- tests/e2e/task7-visual.spec.ts`

Expected: PASS；如视觉基线已有预期更新，检查声明落点面板在桌面和移动端没有截断、重叠或不可见内容。

- [ ] **Step 6: 提交（仓库存在时）**

```bash
git add apps/web/app/components/app-router-client.tsx tests/e2e/task7-visual.spec.ts
git commit -m "feat: use property cards for physical landings"
```
