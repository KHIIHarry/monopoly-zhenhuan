# 房间列表状态徽标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在每个房间名称后显示成员身份与房间阶段的彩色圆角状态徽标。

**Architecture:** 前端从既有 `RoomSummary.mine` 和 `RoomSummary.status` 派生徽标，不扩展 API、Socket 或数据库契约。`Lobby` 在每行房间标题旁渲染身份和阶段标签；CSS 提供稳定的颜色、尺寸和窄屏换行规则。

**Tech Stack:** TypeScript、React、Next.js、CSS、Playwright。

## Global Constraints

- 未加入的未结束房间显示“可加入”及“准备中”或“游戏中”。
- 已加入的未结束房间显示“已加入”及“准备中”或“游戏中”。
- `ENDED`、`FINISHED`、`CLOSED` 仅显示“已结束”。
- 颜色固定为：已加入绿、可加入蓝、准备中金、游戏中红、已结束灰。
- 状态从已有 `mine` 与 `status` 派生，不新增接口、持久化字段或 Socket 订阅。
- 工作目录不含 `.git`，提交步骤记录为跳过。

---

## File Structure

- `apps/web/app/components/app-router-client.tsx`：在 `Lobby` 中计算并渲染房间身份与阶段徽标。
- `apps/web/app/globals.css`：定义标题行及状态徽标的颜色、圆角、间距和窄屏换行。
- `tests/e2e/task7-visual.spec.ts`：使用现有房间摘要夹具验证所有状态组合、样式类和无水平溢出。

### Task 1: 房间列表状态徽标

**Files:**
- Modify: `tests/e2e/task7-visual.spec.ts:48-56`
- Modify: `tests/e2e/task7-visual.spec.ts:401-450`
- Modify: `apps/web/app/components/app-router-client.tsx:448-450`
- Modify: `apps/web/app/components/app-router-client.tsx:1068-1074`
- Modify: `apps/web/app/globals.css:170-181`

**Interfaces:**
- Consumes: `RoomSummary = { mine: boolean; status: 'LOBBY' | 'PLAYING' | 'ENDED' | 'FINISHED' | 'CLOSED'; ... }`.
- Produces: `roomStatusBadges(room: RoomSummary): Array<{ label: '已加入' | '可加入' | '准备中' | '游戏中' | '已结束'; tone: 'joined' | 'joinable' | 'lobby' | 'playing' | 'ended' }>`.
- Renders: `.room-title` containing `.room-status-badges` and `.room-status-badge.room-status-{tone}`.

- [ ] **Step 1: Write the failing browser regression test**

Replace the single-room lobby fixture invocation in the lifecycle test with distinct public and member rooms, then add the following test adjacent to it:

```ts
test('room list renders membership and lifecycle status badges', async ({ page }) => {
  const joinedLobby = room({ id: 'joined-lobby', name: '已加入的准备房间', status: 'LOBBY', mine: true });
  const joinedPlaying = room({ id: 'joined-playing', name: '已加入的对局', status: 'PLAYING', mine: true });
  const joinableLobby = room({ id: 'joinable-lobby', name: '可加入的准备房间', status: 'LOBBY', mine: false, characterId: null, myCharacter: null, isBank: false });
  const joinablePlaying = room({ id: 'joinable-playing', name: '可加入的对局', status: 'PLAYING', mine: false, characterId: null, myCharacter: null, isBank: false });
  const finished = room({ id: 'finished', name: '已结束的对局', status: 'FINISHED', mine: true });

  await mockAuthenticated(page, [joinedLobby, joinedPlaying, joinableLobby, joinablePlaying, finished]);
  await page.goto('/rooms');

  for (const [name, badges] of [
    ['已加入的准备房间', ['已加入', '准备中']],
    ['已加入的对局', ['已加入', '游戏中']],
    ['可加入的准备房间', ['可加入', '准备中']],
    ['可加入的对局', ['可加入', '游戏中']],
    ['已结束的对局', ['已结束']],
  ] as const) {
    const item = page.getByRole('button', { name: new RegExp(name) });
    await expect(item.locator('.room-status-badge')).toHaveText(badges);
  }

  await expect(page.locator('.room-status-joined')).toHaveCSS('background-color', 'rgb(36, 104, 72)');
  await expect(page.locator('.room-status-joinable')).toHaveCSS('background-color', 'rgb(54, 95, 113)');
  await expect(page.locator('.room-status-lobby')).toHaveCSS('background-color', 'rgb(184, 137, 47)');
  await expect(page.locator('.room-status-playing')).toHaveCSS('background-color', 'rgb(116, 31, 40)');
  await expect(page.locator('.room-status-ended')).toHaveCSS('background-color', 'rgb(98, 105, 99)');
  await assertSurface(page);
});
```

- [ ] **Step 2: Run the browser test to verify it fails**

Run: `npm run test:e2e -- tests/e2e/task7-visual.spec.ts --project=desktop-chromium --grep "room list renders membership"`

Expected: FAIL because `.room-status-badge` is absent.

- [ ] **Step 3: Implement the minimal status derivation and rendering**

Add the pure helper beside `terminalRoom`:

```tsx
type RoomStatusBadge = { label: '已加入' | '可加入' | '准备中' | '游戏中' | '已结束'; tone: 'joined' | 'joinable' | 'lobby' | 'playing' | 'ended' };

const roomStatusBadges = (room: RoomSummary): RoomStatusBadge[] => {
  if (terminalRoom(room.status)) return [{ label: '已结束', tone: 'ended' }];
  return [
    { label: room.mine ? '已加入' : '可加入', tone: room.mine ? 'joined' : 'joinable' },
    { label: room.status === 'PLAYING' ? '游戏中' : '准备中', tone: room.status === 'PLAYING' ? 'playing' : 'lobby' },
  ];
};
```

Replace the bare title inside the room row with:

```tsx
<div className="room-title">
  <strong>{room.name}</strong>
  <span className="room-status-badges">
    {roomStatusBadges(room).map((badge) => (
      <span className={`room-status-badge room-status-${badge.tone}`} key={badge.tone}>{badge.label}</span>
    ))}
  </span>
</div>
```

- [ ] **Step 4: Add the scoped styling**

Append the following selectors next to `.room-row` styles:

```css
.room-title { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.room-status-badges { display: inline-flex; flex-wrap: wrap; gap: 5px; }
.room-status-badge { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px; border-radius: 6px; color: #fff; font-size: 12px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
.room-status-joined { background: #246848; }
.room-status-joinable { background: #365f71; }
.room-status-lobby { background: #b8892f; }
.room-status-playing { background: #741f28; }
.room-status-ended { background: #626963; }
```

- [ ] **Step 5: Run the browser test to verify it passes**

Run: `npm run test:e2e -- tests/e2e/task7-visual.spec.ts --project=desktop-chromium --grep "room list renders membership"`

Expected: PASS with all five labels, the five expected fill colors, and no horizontal overflow.

- [ ] **Step 6: Run related visual coverage**

Run: `npm run test:e2e -- tests/e2e/task7-visual.spec.ts --project=desktop-chromium`

Expected: PASS with existing lifecycle and responsive visual checks intact.

- [ ] **Step 7: Run static verification**

Run: `npm run typecheck && npm run lint`

Expected: both commands exit with code 0 and no TypeScript or ESLint errors.

- [ ] **Step 8: Commit**

Skip: this workspace has no `.git` directory.
