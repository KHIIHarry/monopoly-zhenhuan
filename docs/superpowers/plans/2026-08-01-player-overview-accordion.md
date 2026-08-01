# 玩家端房间资产概览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 为玩家端新增实时只读的房间资产“概览”，并让玩家端与银行端通过同一个 Accordion 查看每位玩家持有的地产。

**Architecture:** 新建 PlayerAssetAccordion 作为唯一的玩家资产列表边界，在组件内从现有 players 与 properties 快照派生现金、地产数、普通建筑数和大宫殿数。玩家端和银行端只负责传入同一份快照；Accordion 展开区直接调用现有 LandingPropertyCardPicker mode="browse"，不实现或复制任何地产展示 UI。

**Tech Stack:** Next.js、React、TypeScript、Vitest、Playwright、Socket.IO 现有失效通知与 REST 快照同步、Docker Compose。

## Global Constraints

- 玩家资产概览只显示现金、地产数量、普通建筑数量和大宫殿数量，不计算货币化总资产。
- 普通建筑数量只累加等级 1-4 的地产 level；每块等级 5 地产单独计为 1 座大宫殿。
- 玩家端和银行端必须调用同一个玩家资产 Accordion。
- 展开区必须直接调用现有 LandingPropertyCardPicker mode="browse"，只传入对应玩家的地产数据。
- 不新增、复制或重写地产卡片、地产详情和地产空状态 UI。
- 概览只读，不添加任何编辑回调或跳转页面。
- 继续使用现有 room stateVersion、Socket.IO 失效通知和 REST 完整快照刷新，不新增 API、数据库字段或轮询。
- 当前 checkout 含有用户未提交改动。不得回退、覆盖或顺带提交这些改动；修改重叠文件时先阅读现状，并在每个任务后检查精确 diff。
- 项目服务只能通过 Docker Compose 启动；Playwright 必须设置 PLAYWRIGHT_EXTERNAL_STACK=1 并使用端口 3000。

---

### Task 1: 共享玩家资产 Accordion

**Files:**
- Create: apps/web/app/components/player-asset-overview.tsx
- Create: apps/web/app/components/player-asset-overview.test.ts

**Interfaces:**
- Consumes: LandingPlayer 与 LandingProperty；现有 LandingPropertyCardPicker。
- Produces: summarizePlayerAssets(playerId, properties) -> PlayerAssetSummary；PlayerAssetAccordion({ players, properties })。

- [ ] **Step 1: 写出资产口径与统一地产组件复用的失败测试**

创建 apps/web/app/components/player-asset-overview.test.ts：

~~~ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { LandingProperty } from './landing-property-picker';
import {
  nextExpandedPlayerId,
  PlayerAssetAccordion,
  summarizePlayerAssets,
} from './player-asset-overview';

const property = (
  name: string,
  ownerId: string | null,
  level: number,
  mortgaged = false,
): LandingProperty => ({
  name,
  ownerId,
  level,
  mortgaged,
  mortgage: 1_000,
  purchasePrice: 2_000,
  build: 500,
  buildingSell: 300,
  tolls: [100, 200, 300, 400, 500, 600],
});

const players = [
  { id: 'p1', name: '甄嬛', characterId: 'zhenhuan', balance: 5_000 },
  { id: 'p2', name: '眉庄', characterId: 'meizhuang', balance: 3_200 },
];

const properties = [
  property('碎玉轩', 'p1', 1),
  property('永寿宫', 'p1', 4, true),
  property('寿康宫', 'p1', 5),
  property('咸福宫', 'p2', 2),
  property('甘露寺', null, 0),
];

describe('player asset overview model', () => {
  test('combines levels 1-4 and counts level 5 as a separate palace', () => {
    expect(summarizePlayerAssets('p1', properties)).toEqual({
      ownedProperties: properties.slice(0, 3),
      propertyCount: 3,
      regularBuildingCount: 5,
      palaceCount: 1,
    });
  });

  test('returns zero counts for a player without properties', () => {
    expect(summarizePlayerAssets('missing', properties)).toEqual({
      ownedProperties: [],
      propertyCount: 0,
      regularBuildingCount: 0,
      palaceCount: 0,
    });
  });
});

describe('PlayerAssetAccordion', () => {
  test('keeps at most one player open and collapses the active player', () => {
    expect(nextExpandedPlayerId(null, 'p1')).toBe('p1');
    expect(nextExpandedPlayerId('p1', 'p2')).toBe('p2');
    expect(nextExpandedPlayerId('p2', 'p2')).toBeNull();
  });

  test('renders every player as a collapsed, read-only asset trigger', () => {
    const html = renderToStaticMarkup(
      createElement(PlayerAssetAccordion, { players, properties }),
    );

    expect(html).toContain('甄嬛');
    expect(html).toContain('5,000 两');
    expect(html).toContain('3 块');
    expect(html).toContain('5 栋');
    expect(html).toContain('1 座');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  });

  test('delegates expanded property rendering to the existing shared picker', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./player-asset-overview.tsx', import.meta.url)),
      'utf8',
    );

    expect(source).toMatch(
      /<LandingPropertyCardPicker\s+mode="browse"\s+properties=\{summary\.ownedProperties\}\s+players=\{\[player\]\}/,
    );
    expect(source).not.toContain('PropertyCardDetails');
    expect(source).not.toMatch(/function\s+PropertyCard/);
  });
});
~~~

- [ ] **Step 2: 运行测试并确认因共享组件不存在而失败**

Run:

~~~bash
npm test -- apps/web/app/components/player-asset-overview.test.ts
~~~

Expected: FAIL，错误包含 Cannot find module './player-asset-overview'。

- [ ] **Step 3: 实现最小共享 Accordion**

创建 apps/web/app/components/player-asset-overview.tsx：

~~~tsx
'use client';

import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { LandingPropertyCardPicker } from './landing-property-card-picker';
import type {
  LandingPlayer,
  LandingProperty,
} from './landing-property-picker';

export type PlayerAssetOverviewPlayer = LandingPlayer & {
  balance: number;
};

export type PlayerAssetSummary = {
  ownedProperties: LandingProperty[];
  propertyCount: number;
  regularBuildingCount: number;
  palaceCount: number;
};

export function nextExpandedPlayerId(
  currentPlayerId: string | null,
  requestedPlayerId: string,
) {
  return currentPlayerId === requestedPlayerId ? null : requestedPlayerId;
}

export function summarizePlayerAssets(
  playerId: string,
  properties: LandingProperty[],
): PlayerAssetSummary {
  const ownedProperties = properties.filter(
    (property) => property.ownerId === playerId,
  );

  return {
    ownedProperties,
    propertyCount: ownedProperties.length,
    regularBuildingCount: ownedProperties.reduce(
      (total, property) =>
        property.level >= 1 && property.level <= 4
          ? total + property.level
          : total,
      0,
    ),
    palaceCount: ownedProperties.filter((property) => property.level === 5)
      .length,
  };
}

export function PlayerAssetAccordion({
  players,
  properties,
}: {
  players: PlayerAssetOverviewPlayer[];
  properties: LandingProperty[];
}) {
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null);
  const accordionId = useId();

  useEffect(() => {
    if (
      expandedPlayerId &&
      !players.some((player) => player.id === expandedPlayerId)
    ) {
      setExpandedPlayerId(null);
    }
  }, [expandedPlayerId, players]);

  if (!players.length) return <div className="empty">暂无玩家</div>;

  return (
    <div className="player-asset-accordion">
      {players.map((player) => {
        const summary = summarizePlayerAssets(player.id, properties);
        const expanded = expandedPlayerId === player.id;
        const triggerId = [accordionId, player.id, 'trigger'].join('-');
        const panelId = [accordionId, player.id, 'panel'].join('-');

        return (
          <section
            className={[
              'player-asset-item',
              expanded ? 'expanded' : '',
            ].filter(Boolean).join(' ')}
            key={player.id}
          >
            <button
              id={triggerId}
              type="button"
              className="player-asset-trigger"
              aria-label={player.name + '资产详情'}
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() =>
                setExpandedPlayerId((current) =>
                  nextExpandedPlayerId(current, player.id),
                )
              }
            >
              <span className="avatar player-asset-avatar">
                {player.name[0]}
              </span>
              <span className="player-asset-heading">
                <strong>{player.name}</strong>
                <small>资产概况</small>
              </span>
              <span className="player-asset-metrics">
                <span>
                  <small>现金</small>
                  <strong>{player.balance.toLocaleString('zh-CN')} 两</strong>
                </span>
                <span>
                  <small>地产</small>
                  <strong>{summary.propertyCount} 块</strong>
                </span>
                <span>
                  <small>普通建筑</small>
                  <strong>{summary.regularBuildingCount} 栋</strong>
                </span>
                <span>
                  <small>大宫殿</small>
                  <strong>{summary.palaceCount} 座</strong>
                </span>
              </span>
              <ChevronDown className="player-asset-chevron" aria-hidden="true" />
            </button>
            {expanded && (
              <div
                id={panelId}
                className="player-asset-panel"
                role="region"
                aria-labelledby={triggerId}
              >
                <LandingPropertyCardPicker
                  mode="browse"
                  properties={summary.ownedProperties}
                  players={[player]}
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
~~~

- [ ] **Step 4: 运行组件测试并确认通过**

Run:

~~~bash
npm test -- apps/web/app/components/player-asset-overview.test.ts
~~~

Expected: PASS，5 tests passed。

- [ ] **Step 5: 检查本任务差异**

Run:

~~~bash
git diff --check -- apps/web/app/components/player-asset-overview.tsx apps/web/app/components/player-asset-overview.test.ts
git diff -- apps/web/app/components/player-asset-overview.tsx apps/web/app/components/player-asset-overview.test.ts
~~~

Expected: 无 whitespace error；新组件中唯一地产展示调用为 LandingPropertyCardPicker。

### Task 2: 玩家端导航与双端概览接入

**Files:**
- Modify: apps/web/app/components/app-router-client.tsx
- Modify: apps/web/app/components/app-router-client.test.ts
- Create: tests/e2e/player-asset-overview.spec.ts

**Interfaces:**
- Consumes: Task 1 的 PlayerAssetAccordion。
- Produces: PLAYER 的 OVERVIEW tab；玩家端与银行端各一个共享 Accordion 调用。

- [ ] **Step 1: 写出双端接入的失败契约测试**

在 apps/web/app/components/app-router-client.test.ts 添加：

~~~ts
describe('shared player asset overview', () => {
  test('adds the player overview tab and shares one accordion across both views', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain(
      'import { PlayerAssetAccordion } from "./player-asset-overview";',
    );
    expect(component).toMatch(
      /useState<\s*"HOME" \| "OVERVIEW" \| "PROPERTY" \| "LEDGER"\s*>/,
    );
    expect(component).toContain('active={playerTab === "OVERVIEW"}');
    expect(component).toContain('label="概览"');
    expect(component).toContain('onClick={() => setPlayerTab("OVERVIEW")}');
    expect(component).toContain('tab === "OVERVIEW"');
    expect(component.match(/<PlayerAssetAccordion/g)).toHaveLength(2);
    expect(component).not.toContain('function PlayerList(');
  });
});
~~~

- [ ] **Step 2: 写出玩家端与银行端 Accordion 行为的失败浏览器测试**

创建 tests/e2e/player-asset-overview.spec.ts：

~~~ts
import { expect, test, type Page } from '@playwright/test';
import type {
  BrowserRoomSummary,
  BrowserSeatSnapshot,
  BrowserSnapshot,
} from './browser-fixture-types';

const account = {
  id: 'a1',
  username: 'zhenhuan',
  displayName: '甄嬛',
  isSuperAdmin: false,
  canCreateRoom: false,
  lastLoginAt: '2026-08-01T08:00:00.000Z',
};

const room: BrowserRoomSummary = {
  id: 'r1',
  name: '碎玉轩夜局',
  status: 'PLAYING',
  creator: '甄嬛',
  memberCount: 2,
  playerCount: 2,
  playerLimit: 5,
  hasPassword: false,
  mine: true,
  characterId: 'zhenhuan',
  myCharacter: '钮祜禄·甄嬛',
  isBank: true,
};

const snapshot: BrowserSnapshot = {
  id: 'r1',
  stateVersion: 1,
  code: 'SYX',
  name: room.name,
  status: 'PLAYING',
  diceMode: 'PHYSICAL',
  redemptionFee: 500,
  startReward: 1_000,
  currentPlayerId: 'p1',
  turn: null,
  players: [
    {
      id: 'p1',
      name: '甄嬛',
      characterId: 'zhenhuan',
      balance: 5_000,
      remainingSkipTurns: 0,
    },
    {
      id: 'p2',
      name: '眉庄',
      characterId: 'meizhuang',
      balance: 3_200,
      remainingSkipTurns: 0,
    },
  ],
  properties: [
    {
      name: '碎玉轩',
      ownerId: 'p1',
      level: 1,
      mortgaged: false,
      mortgage: 1_000,
      purchasePrice: 2_000,
      build: 500,
      buildingSell: 300,
      tolls: [100, 200, 300, 400, 500, 600],
    },
    {
      name: '永寿宫',
      ownerId: 'p1',
      level: 4,
      mortgaged: true,
      mortgage: 1_000,
      purchasePrice: 2_000,
      build: 500,
      buildingSell: 300,
      tolls: [100, 200, 300, 400, 500, 600],
    },
    {
      name: '寿康宫',
      ownerId: 'p1',
      level: 5,
      mortgaged: false,
      mortgage: 1_000,
      purchasePrice: 2_000,
      build: 500,
      buildingSell: 300,
      tolls: [100, 200, 300, 400, 500, 600],
    },
  ],
  ledger: [],
  requests: [],
  landings: [],
  audit: [],
  reversalCandidate: null,
};

async function mockOverviewRoom(page: Page) {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { account, sessions: [] } }),
  );
  await page.route('**/api/rooms/mine', (route) =>
    route.fulfill({ json: [room] }),
  );
  await page.route('**/api/rooms/history', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/rooms', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/rooms/r1/seats', (route) => {
    const seats: BrowserSeatSnapshot = {
      stateVersion: 1,
      room: {
        id: 'r1',
        name: room.name,
        status: 'PLAYING',
        skillEnabled: true,
      },
      membership: {
        id: 'm1',
        characterId: 'zhenhuan',
        playerId: 'p1',
        isBank: true,
        activeHere: true,
      },
      characters: [],
      bank: { occupiedBy: '甄嬛' },
      roleSwapRequests: [],
    };
    return route.fulfill({ json: seats });
  });
  await page.route('**/api/rooms/r1/snapshot*', (route) =>
    route.fulfill({ json: snapshot }),
  );
}

test('玩家与银行概览共享只读资产 Accordion 和地产组件', async ({ page }) => {
  await mockOverviewRoom(page);
  await page.goto('/');
  await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
  await page.getByRole('button', { name: '玩家端', exact: true }).click();

  await page.getByRole('button', { name: '概览', exact: true }).click();
  await expect(page.getByText('玩家资产概览', { exact: true })).toBeVisible();
  await expect(page.getByText('2 人', { exact: true })).toBeVisible();

  const zhenhuan = page.getByRole('button', { name: '甄嬛资产详情' });
  const meizhuang = page.getByRole('button', { name: '眉庄资产详情' });
  await expect(zhenhuan).toHaveAttribute('aria-expanded', 'false');
  await expect(zhenhuan).toContainText('5,000 两');
  await expect(zhenhuan).toContainText('3 块');
  await expect(zhenhuan).toContainText('5 栋');
  await expect(zhenhuan).toContainText('1 座');

  await zhenhuan.click();
  await expect(zhenhuan).toHaveAttribute('aria-expanded', 'true');
  const playerRegion = page.getByRole('region', { name: '甄嬛资产详情' });
  await expect(playerRegion.locator('.landing-property-card')).toHaveCount(3);
  await playerRegion.getByRole('button', { name: /碎玉轩/ }).click();
  await expect(playerRegion.getByText('价格信息')).toBeVisible();
  await expect(playerRegion.getByText('确认地产修正')).toHaveCount(0);

  await meizhuang.click();
  await expect(zhenhuan).toHaveAttribute('aria-expanded', 'false');
  await expect(meizhuang).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('region', { name: '眉庄资产详情' })
      .getByText('没有找到匹配的地产'),
  ).toBeVisible();

  await page.getByRole('button', { name: '银行端', exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/r1\/bank$/);
  const bankZhenhuan = page.getByRole('button', { name: '甄嬛资产详情' });
  await bankZhenhuan.click();
  const bankRegion = page.getByRole('region', { name: '甄嬛资产详情' });
  await expect(bankRegion.locator('.landing-property-card')).toHaveCount(3);
  await expect(bankRegion.getByText('确认地产修正')).toHaveCount(0);
});
~~~

- [ ] **Step 3: 运行接入测试并确认缺少 OVERVIEW 与 Accordion**

Run:

~~~bash
npm test -- apps/web/app/components/app-router-client.test.ts
~~~

Expected: FAIL，缺少 player-asset-overview import、OVERVIEW tab 与两个 PlayerAssetAccordion 调用。

在 Docker 栈可用时运行：

~~~bash
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/player-asset-overview.spec.ts --project=desktop-chromium
~~~

Expected: FAIL，玩家导航中找不到“概览”按钮。

- [ ] **Step 4: 接入玩家端导航和两个概览**

在 apps/web/app/components/app-router-client.tsx 的 LandingPropertyCardPicker import 后加入：

~~~tsx
import { PlayerAssetAccordion } from "./player-asset-overview";
~~~

将 Workbench 的玩家 tab 状态改为：

~~~tsx
const [playerTab, setPlayerTab] = useState<
  "HOME" | "OVERVIEW" | "PROPERTY" | "LEDGER"
>("HOME");
~~~

在玩家端“首页”和“地产”导航之间加入：

~~~tsx
<Nav
  active={playerTab === "OVERVIEW"}
  icon={<Users />}
  label="概览"
  onClick={() => setPlayerTab("OVERVIEW")}
/>
~~~

将 PlayerView 的 tab 类型改为：

~~~tsx
tab: "HOME" | "OVERVIEW" | "PROPERTY" | "LEDGER";
~~~

在 PlayerView 的 HOME 内容之后、PROPERTY 内容之前加入：

~~~tsx
{tab === "OVERVIEW" && (
  <>
    <SectionTitle
      title="玩家资产概览"
      action={snapshot.players.length + " 人"}
    />
    <PlayerAssetAccordion
      players={snapshot.players}
      properties={snapshot.properties}
    />
  </>
)}
~~~

将银行端现有：

~~~tsx
<PlayerList players={snapshot.players} />
~~~

替换为：

~~~tsx
<PlayerAssetAccordion
  players={snapshot.players}
  properties={snapshot.properties}
/>
~~~

删除 app-router-client.tsx 中完整的 PlayerList 函数。不要更改玩家端和银行端原有地产页的 LandingPropertyCardPicker 调用。

- [ ] **Step 5: 运行单元与浏览器测试并确认通过**

Run:

~~~bash
npm test -- apps/web/app/components/player-asset-overview.test.ts apps/web/app/components/app-router-client.test.ts
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/player-asset-overview.spec.ts --project=desktop-chromium
~~~

Expected: Vitest PASS；Playwright 1 passed。

- [ ] **Step 6: 检查本任务差异且不暂存用户原有改动**

Run:

~~~bash
git diff --check -- apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts tests/e2e/player-asset-overview.spec.ts
git diff -- apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts tests/e2e/player-asset-overview.spec.ts
~~~

Expected: 仅出现 OVERVIEW 导航、共享 Accordion 双端调用、旧 PlayerList 删除和新 E2E 测试；不得回退文件中已有修改。

### Task 3: Accordion 响应式样式

**Files:**
- Modify: apps/web/app/globals.css
- Create: apps/web/app/components/player-asset-overview.styles.test.ts

**Interfaces:**
- Consumes: Task 1 的 player-asset-* class names。
- Produces: 与现有工作台风格一致、移动端不溢出、桌面端可扫描的 Accordion 布局。

- [ ] **Step 1: 写出失败的样式契约测试**

创建 apps/web/app/components/player-asset-overview.styles.test.ts：

~~~ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const stylesheetUrl = new URL('../globals.css', import.meta.url);

describe('player asset accordion styles', () => {
  test('uses stable rows and a four-column desktop asset grid', async () => {
    const stylesheet = await readFile(
      fileURLToPath(stylesheetUrl),
      'utf8',
    );

    expect(stylesheet).toMatch(
      /\.player-asset-accordion\s*\{[^}]*margin:\s*0 16px;[^}]*border:\s*1px solid var\(--line\);/s,
    );
    expect(stylesheet).toMatch(
      /\.player-asset-trigger\s*\{[^}]*grid-template-areas:\s*"avatar heading chevron" "metrics metrics metrics";/s,
    );
    expect(stylesheet).toMatch(
      /\.player-asset-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(stylesheet).toMatch(
      /\.player-asset-panel \.browse-property-picker\s*\{[^}]*margin-inline:\s*0;/s,
    );
  });

  test('uses a two-column asset grid on narrow phones', async () => {
    const stylesheet = await readFile(
      fileURLToPath(stylesheetUrl),
      'utf8',
    );

    expect(stylesheet).toMatch(
      /@media\s*\(max-width:\s*430px\)[\s\S]*?\.player-asset-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
  });
});
~~~

- [ ] **Step 2: 运行样式测试并确认失败**

Run:

~~~bash
npm test -- apps/web/app/components/player-asset-overview.styles.test.ts
~~~

Expected: FAIL，缺少 player-asset-* CSS。

- [ ] **Step 3: 用 Accordion 样式替换已废弃的 PlayerList 样式**

在 apps/web/app/globals.css 中删除 .player-list 规则和 max-width: 390px 内对应的 .player-list 规则，保留现有 .avatar 规则，并在原位置加入：

~~~css
.player-asset-accordion {
  margin: 0 16px;
  border: 1px solid var(--line);
  background: var(--paper-2);
}
.player-asset-item + .player-asset-item { border-top: 1px solid #eee4d6; }
.player-asset-trigger {
  width: 100%;
  min-height: 92px;
  padding: 11px 12px;
  border: 0;
  background: transparent;
  color: var(--ink);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas: "avatar heading chevron" "metrics metrics metrics";
  gap: 9px 10px;
  align-items: center;
  text-align: left;
}
.player-asset-trigger:hover { background: #faf7f0; }
.player-asset-trigger:focus-visible {
  position: relative;
  z-index: 1;
  outline: 3px solid var(--blue);
  outline-offset: -3px;
}
.player-asset-avatar { grid-area: avatar; }
.player-asset-heading {
  grid-area: heading;
  min-width: 0;
}
.player-asset-heading strong,
.player-asset-heading small { display: block; }
.player-asset-heading strong {
  overflow-wrap: anywhere;
  font-size: 15px;
}
.player-asset-heading small {
  margin-top: 2px;
  color: var(--muted);
  font-size: 11px;
}
.player-asset-metrics {
  grid-area: metrics;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: var(--line);
}
.player-asset-metrics > span {
  min-width: 0;
  padding: 7px 8px;
  background: #faf7f0;
}
.player-asset-metrics small,
.player-asset-metrics strong { display: block; }
.player-asset-metrics small {
  color: var(--muted);
  font-size: 10px;
}
.player-asset-metrics strong {
  margin-top: 3px;
  color: var(--red);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.player-asset-chevron {
  grid-area: chevron;
  width: 18px;
  color: var(--muted);
  transition: transform 160ms ease;
}
.player-asset-trigger[aria-expanded="true"] .player-asset-chevron {
  transform: rotate(180deg);
}
.player-asset-panel {
  padding: 12px;
  border-top: 1px solid var(--line);
  background: #f7f3eb;
}
.player-asset-panel .browse-property-picker { margin-inline: 0; }

@media (max-width: 430px) {
  .player-asset-trigger { min-height: 132px; padding: 10px; }
  .player-asset-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .player-asset-panel { padding: 10px 8px; }
}
~~~

- [ ] **Step 4: 运行样式与共享组件测试**

Run:

~~~bash
npm test -- apps/web/app/components/player-asset-overview.styles.test.ts apps/web/app/components/player-asset-overview.test.ts
~~~

Expected: PASS，7 tests passed。

- [ ] **Step 5: 检查 CSS 差异**

Run:

~~~bash
git diff --check -- apps/web/app/globals.css apps/web/app/components/player-asset-overview.styles.test.ts
git diff -- apps/web/app/globals.css apps/web/app/components/player-asset-overview.styles.test.ts
~~~

Expected: 旧 PlayerList 样式被删除；新增样式不改变 LandingPropertyCardPicker 自身的卡片或详情样式。

### Task 4: 全量验证与视觉检查

**Files:**
- Verify only; no production file changes.

**Interfaces:**
- Consumes: Tasks 1-3 的完整实现。
- Produces: 单元、类型、Lint、构建、桌面和移动浏览器验证证据。

- [ ] **Step 1: 运行相关测试**

Run:

~~~bash
npm test -- apps/web/app/components/player-asset-overview.test.ts apps/web/app/components/player-asset-overview.styles.test.ts apps/web/app/components/app-router-client.test.ts apps/web/app/components/landing-property-card-picker.test.ts apps/web/app/components/landing-property-card-picker.styles.test.ts
~~~

Expected: 所有相关测试 PASS。

- [ ] **Step 2: 运行全量静态验证**

Run:

~~~bash
npm run typecheck
npm run lint
npm test
npm run build
~~~

Expected: 四条命令均 exit 0，无 TypeScript、ESLint、Vitest 或 Next.js 构建失败。

- [ ] **Step 3: 检查并启动 Docker Compose 栈**

先执行只读检查：

~~~bash
docker compose ps
ps -axo pid=,command= | rg '/monopoly-zhenhuan/.*(next|node)' || true
~~~

若服务未运行，确认没有本项目宿主机 Node/Next 进程后执行：

~~~bash
docker compose up -d
docker compose ps
~~~

Expected: postgres、api、web 均 healthy/running；Web 使用 http://localhost:3000。

- [ ] **Step 4: 运行桌面与移动端 Playwright**

Run:

~~~bash
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/player-asset-overview.spec.ts --project=desktop-chromium --project=iphone-webkit
~~~

Expected: 2 passed；两种视口均可展开玩家与地产详情，没有横向溢出或编辑入口。

- [ ] **Step 5: 视觉检查**

使用浏览器在 1440x900 与 390x844 检查：

- 玩家导航中的“概览”文字和图标完整可见。
- 玩家状态条无文字重叠；现金、地产、普通建筑和大宫殿在移动端按 2x2 排列。
- 一次只展开一个玩家。
- 展开内容仍是现有地产搜索、筛选、卡片和详情视觉。
- 银行端与玩家端同一玩家的资产计数和地产内容一致。

- [ ] **Step 6: 最终差异与要求核对**

Run:

~~~bash
git diff --check
git status --short
git diff -- apps/web/app/components/player-asset-overview.tsx apps/web/app/components/player-asset-overview.test.ts apps/web/app/components/player-asset-overview.styles.test.ts apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css tests/e2e/player-asset-overview.spec.ts
~~~

逐条核对规格：玩家人数、全员列表、现金、地产数量、普通建筑、大宫殿、Accordion、统一地产组件、银行端同步、只读与实时快照同步全部有实现或既有机制证据。
