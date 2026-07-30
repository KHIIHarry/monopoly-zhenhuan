# 实体落点拼音与角色筛选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让实体落点声明可按中文、拼音、首字母或混输搜索地产，并通过“全部”和角色标签按所有者筛选。

**Architecture:** 保持 `landing-property-picker.ts` 为唯一的筛选模型边界；它以名称搜索词和可选所有者 ID 过滤地产。`LandingPropertyCardPicker` 仅持有输入文本、选中标签和显示状态，并将两个条件传给模型；`pinyin-pro` 负责汉字读音匹配。

**Tech Stack:** Next.js、React、TypeScript、Vitest、`pinyin-pro`、CSS。

## Global Constraints

- 只改变“声明实体落点”内的地产卡片筛选，不改变确认、选择、后端接口或持久化状态。
- 查询忽略大小写与空白，支持中文、无声调全拼连续片段、首字母连续片段和中拼混输。
- 所有者标签与关键词为交集；“全部”清除所有者限制且默认选中。
- 标签数据来自既有本局玩家 `players` 和地产 `ownerId`；不新增 API 或数据库字段。

---

### Task 1: 搜索与所有者筛选模型

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Modify: `apps/web/app/components/landing-property-picker.ts`
- Modify: `apps/web/app/components/landing-property-picker.test.ts`

**Interfaces:**
- Consumes: `LandingProperty[]`，其中每项具有 `name: string` 与 `ownerId: string | null`。
- Produces: `filterLandingProperties<T extends LandingProperty>(properties: T[], query: string, ownerId?: string | null): T[]`；`ownerId` 缺省或为 `null` 时表示“全部”。

- [ ] **Step 1: 添加 Web 端拼音库依赖**

```bash
npm install -w @zhenhuan/web pinyin-pro@3.28.2
```

预期：`apps/web/package.json` 的 `dependencies` 包含精确版本 `pinyin-pro`，并同步更新根目录 `package-lock.json`。

- [ ] **Step 2: 写出失败的筛选模型测试**

在 `apps/web/app/components/landing-property-picker.test.ts` 中新增：

```ts
it('matches Chinese, a full-pinyin substring, initials, and mixed text', () => {
  expect(filterLandingProperties(properties, '仁')).toEqual([properties[0]]);
  expect(filterLandingProperties(properties, 'ren')).toEqual([properties[0]]);
  expect(filterLandingProperties(properties, 'jrg')).toEqual([properties[0]]);
  expect(filterLandingProperties(properties, '景ren')).toEqual([properties[0]]);
});

it('ignores query case and whitespace', () => {
  expect(filterLandingProperties(properties, ' Jing Ren ')).toEqual([properties[0]]);
});

it('filters by owner and intersects the owner with the query', () => {
  expect(filterLandingProperties(properties, '', 'p1')).toEqual([properties[0]]);
  expect(filterLandingProperties(properties, 'ren', 'p1')).toEqual([properties[0]]);
  expect(filterLandingProperties(properties, 'yu', 'p1')).toEqual([]);
  expect(filterLandingProperties(properties, '', null)).toEqual(properties);
});
```

- [ ] **Step 3: 运行模型测试，确认新断言失败**

```bash
npm test -- apps/web/app/components/landing-property-picker.test.ts
```

预期：新增拼音、混输和所有者断言失败；既有中文名称测试仍通过。

- [ ] **Step 4: 实现最小筛选逻辑**

在 `apps/web/app/components/landing-property-picker.ts` 导入 `pinyin-pro` 的 `match`，规范化查询后先按 `ownerId` 过滤，再用中文子串或拼音匹配过滤：

```ts
import { match } from 'pinyin-pro';

function normalizedLandingQuery(query: string) {
  return query.replaceAll(/\s/g, '').toLocaleLowerCase('en-US');
}

function matchesLandingName(name: string, query: string) {
  return !query || name.includes(query) || Boolean(match(name, query));
}

export function filterLandingProperties<T extends LandingProperty>(
  properties: T[],
  query: string,
  ownerId: string | null = null,
): T[] {
  const term = normalizedLandingQuery(query);
  return properties.filter(
    (property) =>
      (ownerId === null || property.ownerId === ownerId) &&
      matchesLandingName(property.name, term),
  );
}
```

若 `pinyin-pro` 的 `match` 对连续全拼片段不返回匹配，保留接口，在 `matchesLandingName` 中补充以每个名称后缀调用 `match(name.slice(index), query)` 的检查，使 `ren` 匹配“景仁宫”；不得修改测试期望。

- [ ] **Step 5: 运行模型测试，确认通过**

```bash
npm test -- apps/web/app/components/landing-property-picker.test.ts
```

预期：测试文件内全部断言通过。

- [ ] **Step 6: 提交模型变更**

```bash
git add apps/web/package.json package-lock.json apps/web/app/components/landing-property-picker.ts apps/web/app/components/landing-property-picker.test.ts
git commit -m "feat: filter landings by pinyin and owner"
```

### Task 2: 角色标签筛选界面

**Files:**
- Create: `apps/web/app/components/landing-property-card-picker.test.tsx`
- Modify: `apps/web/app/components/landing-property-card-picker.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `filterLandingProperties(properties, query, ownerId)` from `landing-property-picker.ts` and `players: LandingPlayer[]` from the room snapshot.
- Produces: “全部”与每位玩家的可访问标签按钮，持有 `selectedOwnerId: string | null`；所有可见卡片均由 Task 1 的筛选函数决定。

- [ ] **Step 1: 写出失败的默认标签渲染测试**

创建 `apps/web/app/components/landing-property-card-picker.test.tsx`：

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingPropertyCardPicker } from './landing-property-card-picker';

describe('LandingPropertyCardPicker', () => {
  it('renders an active all-properties tag and a tag for each player', () => {
    const html = renderToStaticMarkup(
      <LandingPropertyCardPicker
        properties={[{ name: '景仁宫', ownerId: 'p1', level: 0, mortgaged: false, mortgage: 0, purchasePrice: 3000, build: 2000, buildingSell: 1200, tolls: [800] }]}
        players={[{ id: 'p1', name: '皇后' }, { id: 'p2', name: '甄嬛' }]}
        value=""
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('全部');
    expect(html).toContain('皇后');
    expect(html).toContain('甄嬛');
    expect(html).toContain('aria-pressed="true"');
  });
});
```

- [ ] **Step 2: 运行标签测试，确认失败**

```bash
npm test -- apps/web/app/components/landing-property-card-picker.test.tsx
```

预期：因尚未渲染筛选标签，断言找不到“全部”而失败。

- [ ] **Step 3: 接入选中所有者状态与标签按钮**

在 `LandingPropertyCardPicker` 中添加选中所有者状态，并更新 memo：

```tsx
const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
const visibleProperties = useMemo(
  () => filterLandingProperties(properties, query, selectedOwnerId),
  [properties, query, selectedOwnerId],
);
```

在搜索标签下、已选状态上添加：

```tsx
<div className="landing-property-owner-filters" aria-label="按地产所有者筛选">
  <button type="button" className={`landing-owner-filter${selectedOwnerId === null ? ' selected' : ''}`} aria-pressed={selectedOwnerId === null} onClick={() => setSelectedOwnerId(null)}>
    全部
  </button>
  {players.map((player) => (
    <button type="button" key={player.id} className={`landing-owner-filter${selectedOwnerId === player.id ? ' selected' : ''}`} aria-pressed={selectedOwnerId === player.id} onClick={() => setSelectedOwnerId(player.id)}>
      {player.name}
    </button>
  ))}
</div>
```

保留当前地产卡片选择 `value`，切换标签不得清空已选择的地产。

- [ ] **Step 4: 添加稳定的圆角标签样式**

在 `apps/web/app/globals.css` 的 `.landing-property-search` 规则后添加：

```css
.landing-property-owner-filters { display: flex; flex-wrap: wrap; gap: 8px; }
.landing-owner-filter { min-height: 34px; border: 1px solid #cdb990; border-radius: 999px; background: #fffdf7; color: #604744; padding: 6px 12px; font-size: 13px; font-weight: 700; }
.landing-owner-filter.selected { border-color: var(--red); background: #fff1f1; color: var(--red); }
.landing-owner-filter:focus-visible { outline: 3px solid var(--blue); outline-offset: 2px; }
```

标签在窄屏自然换行，不产生横向滚动。

- [ ] **Step 5: 运行组件测试，确认通过**

```bash
npm test -- apps/web/app/components/landing-property-card-picker.test.tsx
```

预期：测试通过，表明默认“全部”标签按下且所有玩家标签已渲染。

- [ ] **Step 6: 提交界面变更**

```bash
git add apps/web/app/components/landing-property-card-picker.test.tsx apps/web/app/components/landing-property-card-picker.tsx apps/web/app/globals.css
git commit -m "feat: add landing owner filter tags"
```

### Task 3: 全量静态验证

**Files:**
- Modify: none

**Interfaces:**
- Consumes: Tasks 1 和 2 的完成代码。
- Produces: 类型检查、静态规则和完整单元测试的验证记录。

- [ ] **Step 1: 运行相关组件测试**

```bash
npm test -- apps/web/app/components/landing-property-picker.test.ts apps/web/app/components/landing-property-card-picker.test.tsx
```

预期：两个测试文件全部通过。

- [ ] **Step 2: 运行类型检查**

```bash
npm run typecheck
```

预期：退出码为 0。

- [ ] **Step 3: 运行 ESLint**

```bash
npm run lint
```

预期：退出码为 0 且没有警告。

- [ ] **Step 4: 运行全量单元测试**

```bash
npm test
```

预期：Vitest 报告零失败。
