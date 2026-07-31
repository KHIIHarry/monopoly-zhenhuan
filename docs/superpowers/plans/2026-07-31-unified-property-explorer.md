# 统一地产浏览与角色主题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让落点声明、玩家端和银行端使用同一地产浏览组件，统一拼音搜索、角色筛选、产权排序、所有者格式、主题色边框和抵押标签。

**Architecture:** 扩展现有 `LandingPropertyCardPicker` 为可配置的共享地产浏览器：落点模式保持可选择卡片，浏览模式用于玩家端和银行端的地产列表。筛选、排序和产权展示元数据留在 `landing-property-picker.ts` 的纯模型中；`app-router-client.tsx` 只传入已有地产与玩家快照。

**Tech Stack:** Next.js、React、TypeScript、Vitest、`pinyin-pro`、CSS。

## Global Constraints

- 标签仅显示本局已选择人物的玩家，文字仅为角色名；“全部”使用中性深色，角色标签使用主题色填充。
- 保留中文、全拼连续片段、首字母和中拼混输搜索，且标签与关键词取交集。
- 已持有地产排在国库地产前，组内保留传入的原始顺序。
- 所有者显示为“角色名（玩家昵称）”，昵称灰色；无主显示“无主”。
- 已持有地产按角色主题色显示左侧隔离线，国库使用黑色；抵押状态在右下角显示贴边“已抵押”标签，不降低整卡透明度。
- 不新增 API、数据库字段或持久化筛选状态；不改变选择落点、确认落点、租金、冷宫免过路费、购买价或升级费用规则。

---

### Task 1: 地产产权展示与排序模型

**Files:**
- Modify: `apps/web/app/components/landing-property-picker.ts`
- Modify: `apps/web/app/components/landing-property-picker.test.ts`

**Interfaces:**
- Consumes: `LandingProperty` 和扩展后的 `LandingPlayer`，后者包含可选 `characterId?: string | null`。
- Produces:
  - `propertyCharacterMeta(characterId: string | null): { name: string; theme: string } | null`
  - `propertyOwner(property, players): { label: '已持有' | '国库'; player: LandingPlayer | null; characterName: string | null; theme: string }`
  - `visibleLandingPlayers(players): LandingPlayer[]`
  - `sortPropertiesByOwnership<T extends LandingProperty>(properties: T[]): T[]`

- [ ] **Step 1: 写出失败的产权元数据与排序测试**

在 `landing-property-picker.test.ts` 将测试玩家补充 `characterId`，并添加：

```ts
it('formats an owned property with its character theme and player name', () => {
  expect(propertyOwner(properties[0], players)).toMatchObject({
    label: '已持有',
    characterName: '乌拉那拉·宜修',
    theme: 'yixiu',
    player: { name: '小行老师' },
  });
});

it('keeps only seated characters in the filter list', () => {
  expect(visibleLandingPlayers([
    ...players,
    { id: 'bank', name: '银行', characterId: null },
  ]).map((player) => player.id)).toEqual(['p1']);
});

it('places owned properties before treasury properties without changing group order', () => {
  expect(sortPropertiesByOwnership([properties[1], properties[0]])).toEqual([
    properties[0],
    properties[1],
  ]);
});
```

- [ ] **Step 2: 运行模型测试，确认失败**

```bash
npm test -- apps/web/app/components/landing-property-picker.test.ts
```

预期：测试因产权元数据、已选角色筛选和产权排序函数尚不存在而失败。

- [ ] **Step 3: 实现角色元数据、产权显示与稳定排序**

在 `landing-property-picker.ts` 定义角色配置，并在同一模块实现产权帮助函数：

```ts
const propertyCharacters = {
  yixiu: { name: '乌拉那拉·宜修', theme: 'yixiu' },
  zhenhuan: { name: '钮祜禄·甄嬛', theme: 'zhenhuan' },
  huashifei: { name: '年世兰', theme: 'huashifei' },
  meizhuang: { name: '沈眉庄', theme: 'meizhuang' },
  anlingrong: { name: '安陵容', theme: 'anlingrong' },
} as const;

export function visibleLandingPlayers(players: LandingPlayer[]) {
  return players.filter((player) => player.characterId !== null);
}

export function sortPropertiesByOwnership<T extends LandingProperty>(properties: T[]) {
  return properties
    .map((property, index) => ({ property, index }))
    .sort((left, right) => Number(left.property.ownerId === null) - Number(right.property.ownerId === null) || left.index - right.index)
    .map(({ property }) => property);
}
```

`propertyOwner` 必须在找不到角色配置时回退到 `characterName: null` 和 `theme: 'treasury'`，且不得把无主地产误标为已持有。

- [ ] **Step 4: 运行模型测试，确认通过**

```bash
npm test -- apps/web/app/components/landing-property-picker.test.ts
```

预期：全部模型测试通过，包括既有拼音和所有者交集筛选测试。

- [ ] **Step 5: 提交模型变更**

```bash
git add apps/web/app/components/landing-property-picker.ts apps/web/app/components/landing-property-picker.test.ts
git commit -m "feat: model themed property ownership"
```

### Task 2: 共用地产浏览器与落点选择模式

**Files:**
- Modify: `apps/web/app/components/landing-property-card-picker.tsx`
- Modify: `apps/web/app/components/landing-property-card-picker.test.ts`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: Task 1 的 `filterLandingProperties`、`visibleLandingPlayers`、`sortPropertiesByOwnership`、`propertyOwner` 和 `landingPropertyToll`。
- Produces: `LandingPropertyCardPicker` 增加 `mode?: 'browse' | 'landing'`，默认 `landing`；`value` 与 `onChange` 只在 `landing` 模式需要。

- [ ] **Step 1: 写出失败的共享浏览器渲染测试**

将组件测试的玩家数据补充 `characterId: 'yixiu'`，并增加浏览模式断言：

```ts
it('renders character-only filters and a themed owner label in browse mode', () => {
  const ownedProperty = {
    name: '景仁宫', ownerId: 'p1', level: 0, mortgaged: true,
    mortgage: 1500, purchasePrice: 3000, build: 2000,
    buildingSell: 1200, tolls: [800],
  };
  const html = renderToStaticMarkup(createElement(LandingPropertyCardPicker, {
    mode: 'browse',
    properties: [ownedProperty],
    players: [{ id: 'p1', name: '小行老师', characterId: 'yixiu' }],
  }));

  expect(html).toContain('乌拉那拉·宜修');
  expect(html).not.toContain('小行老师</button>');
  expect(html).toContain('乌拉那拉·宜修（<span class="property-owner-nickname">小行老师</span>）');
  expect(html).toContain('property-theme-yixiu');
  expect(html).toContain('已抵押');
});
```

在同一测试中加入确定的排序断言：

```ts
const sortedHtml = renderToStaticMarkup(createElement(LandingPropertyCardPicker, {
  mode: 'browse',
  properties: [
    { ...ownedProperty, name: '甘露寺', ownerId: null, mortgaged: false },
    ownedProperty,
  ],
  players: [{ id: 'p1', name: '小行老师', characterId: 'yixiu' }],
}));

expect(sortedHtml.indexOf('景仁宫')).toBeLessThan(sortedHtml.indexOf('甘露寺'));
```

- [ ] **Step 2: 运行组件测试，确认失败**

```bash
npm test -- apps/web/app/components/landing-property-card-picker.test.ts
```

预期：测试因浏览模式、角色名筛选标签、主题类、所有者格式和右下角抵押标签尚不存在而失败。

- [ ] **Step 3: 把卡片选择器扩展为两种共享模式**

更新组件 props 和可见列表：

```tsx
type LandingPropertyPickerProps = {
  properties: LandingProperty[];
  players: LandingPlayer[];
  mode?: 'browse' | 'landing';
  value?: string;
  onChange?: (propertyName: string) => void;
};

const propertyPlayers = useMemo(() => visibleLandingPlayers(players), [players]);
const visibleProperties = useMemo(
  () => sortPropertiesByOwnership(filterLandingProperties(properties, query, selectedOwnerId)),
  [properties, query, selectedOwnerId],
);
```

筛选标签遍历 `propertyPlayers`，文字使用 `propertyCharacterMeta(player.characterId)?.name`，标签 class 追加 `property-theme-${theme}`。仅在 `mode === 'landing'` 渲染可点击选择卡片、`aria-pressed` 和选中标记；浏览模式渲染语义化 `article`，不提供落点选择回调。

卡片在两种模式中均渲染：产权状态、地产名、所有者、建筑、购买/升级价、当前过路费、冷宫免过路费与完整价格/租金。所有者由 JSX 分段渲染，确保昵称可用 `.property-owner-nickname` 单独置灰；无主地产只显示“无主”。抵押卡渲染 `<span className="property-mortgaged-tag">已抵押</span>`。

- [ ] **Step 4: 添加角色主题与抵押标签样式**

在 `globals.css` 定义地产主题变量和共享卡片规则：

```css
.property-theme-treasury { --property-theme: #24211f; }
.property-theme-yixiu { --property-theme: #6fb6dc; }
.property-theme-zhenhuan { --property-theme: #e7bd3f; }
.property-theme-huashifei { --property-theme: #b487d4; }
.property-theme-meizhuang { --property-theme: #d96f93; }
.property-theme-anlingrong { --property-theme: #71b979; }
.property-card { position: relative; border-left: 4px solid var(--property-theme); }
.property-owner-nickname { color: var(--muted); font-weight: 400; }
.property-mortgaged-tag { position: absolute; right: -1px; bottom: -1px; border: 1px solid #777; border-right: 0; border-bottom: 0; background: #5f5f5f; color: #fff; padding: 4px 8px; font-size: 11px; font-weight: 700; }
.property-owner-filter { background: var(--property-theme); color: var(--ink); }
.property-owner-filter.selected { outline: 3px solid var(--ink); outline-offset: 1px; }
```

将旧的通用金色边框和 `.mortgaged { opacity: .72 }` 覆盖替换为主题变量规则；保持选中落点的红色轮廓、键盘焦点轮廓、响应式网格和文本不溢出。

- [ ] **Step 5: 运行组件测试，确认通过**

```bash
npm test -- apps/web/app/components/landing-property-card-picker.test.ts
```

预期：测试通过，证明默认“全部”状态、角色名标签、灰色昵称、主题类、抵押标签和已持有优先排序均被渲染。

- [ ] **Step 6: 提交共享组件变更**

```bash
git add apps/web/app/components/landing-property-card-picker.tsx apps/web/app/components/landing-property-card-picker.test.ts apps/web/app/globals.css
git commit -m "feat: unify themed property cards"
```

### Task 3: 接入玩家端与银行端地产模块

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx`
- Test: `apps/web/app/components/app-router-client.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LandingPropertyCardPicker`，其中 `mode: 'browse'` 不需要 `value` 或 `onChange`。
- Produces: 玩家端“我的地产 / 全局地产”和银行端“全地图地产”使用同一浏览器；实体落点声明显式使用 `mode="landing"` 并传入当前 `landing` 与 `setLanding`。

- [ ] **Step 1: 写出失败的入口接入契约测试**

在 `apps/web/app/components/app-router-client.test.ts` 中读取同目录 `app-router-client.tsx` 源码，并添加：

```ts
test('uses the shared property explorer for player and bank property views', async () => {
  const source = await readFile(
    fileURLToPath(new URL('./app-router-client.tsx', import.meta.url)),
    'utf8',
  );

  expect(source.match(/<LandingPropertyCardPicker\s+mode="browse"/g)).toHaveLength(3);
  expect(source).toContain('mode="landing"');
  expect(source).not.toContain('function PropertyList(');
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm test -- apps/web/app/components/app-router-client.test.ts
```

预期：当前源码仍有 `PropertyList`，且还没有三处浏览模式入口，断言失败。

- [ ] **Step 3: 替换双端 `PropertyList` 使用点**

在 `app-router-client.tsx` 用以下浏览模式替换三处 `PropertyList`：

```tsx
<LandingPropertyCardPicker mode="browse" properties={mine} players={snapshot.players} />
<LandingPropertyCardPicker mode="browse" properties={snapshot.properties} players={snapshot.players} />
```

落点声明保持相同组件但显式声明模式：

```tsx
<LandingPropertyCardPicker
  mode="landing"
  properties={snapshot.properties}
  players={snapshot.players}
  value={landing}
  onChange={setLanding}
/>
```

删除不再使用的本地 `PropertyList` 函数，保留 `currentPropertyToll` 供落点金额和其他业务 UI 使用。确认所有导入从既有组件路径保留，不新增页面专用地产卡组件。

- [ ] **Step 4: 运行组件测试与类型检查，确认通过**

```bash
npm test -- apps/web/app/components/landing-property-picker.test.ts apps/web/app/components/landing-property-card-picker.test.ts apps/web/app/components/app-router-client.test.ts
npm run typecheck
```

预期：两份组件测试和 TypeScript 构建通过。

- [ ] **Step 5: 提交双端接入**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts
git commit -m "feat: share property explorer across workbenches"
```

### Task 4: 全量验证

**Files:**
- Modify: none

**Interfaces:**
- Consumes: Tasks 1 至 3 的主工作树代码。
- Produces: 已验证的统一地产浏览器。

- [ ] **Step 1: 运行完整单元测试**

```bash
SUPER_ADMIN_USERNAMES=admin npm test
```

预期：Vitest 报告零失败；数据库相关测试按本地配置正常通过或跳过。

- [ ] **Step 2: 运行静态检查**

```bash
npm run typecheck
npm run lint
```

预期：两个命令退出码均为 0。

- [ ] **Step 3: 运行生产构建**

```bash
npm run build
```

预期：API、Web、数据库和共享包构建均成功。
