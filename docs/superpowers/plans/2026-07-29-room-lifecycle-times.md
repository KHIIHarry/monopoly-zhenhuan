# 房间生命周期时间展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在用户房间列表和超管房间管理列表展示创建、开始、结束时间，并为尚未发生的时间提供中文占位文案。

**Architecture:** 房间查询服务直接返回数据库中已有的创建与开始时间，以及关联结算记录中的结束时间。前端将所有生命周期时间通过单一格式化函数渲染，确保两个列表显示一致；该函数用本地日历字段组合为 `YYYY年MM月DD日 星期X H:mm`。

**Tech Stack:** TypeScript、Fastify、Prisma、Next.js/React、Vitest、Playwright。

## Global Constraints

- 不变更 Prisma schema 或新增数据库迁移。
- `startedAt: null` 显示“未开始”，`endedAt: null` 显示“未结束”。
- 日期固定显示为 `xxxx年xx月xx日 星期x 0:00` 样式，其中最后一段为实际本地时分。
- 工作目录不含 Git 元数据，计划中的提交步骤记录为跳过。

---

## File Structure

- `apps/api/src/account-room-service.ts`：为用户和超管房间列表序列化生命周期时间。
- `apps/api/src/account-room-service.integration.test.ts`：验证普通房间列表接口的字段。
- `apps/api/src/admin-account-room-service.integration.test.ts`：验证超管房间列表接口的字段。
- `apps/web/app/components/app-router-client.tsx`：声明新字段、统一格式化时间并渲染两个列表。
- `tests/e2e/browser-fixture-types.ts`：将生命周期字段加到浏览器测试用的房间摘要类型。
- `tests/e2e/task7-visual.spec.ts`：覆盖房间列表及超管房间管理的日期和空值展示。

### Task 1: 公开与超管房间列表契约

**Files:**
- Modify: `apps/api/src/account-room-service.ts:823-875`
- Modify: `apps/api/src/account-room-service.ts:881-923`
- Modify: `apps/api/src/account-room-service.integration.test.ts`
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts:594-604`

**Interfaces:**
- Produces user summary fields: `createdAt: Date`, `startedAt: Date | null`, `endedAt: Date | null`.
- Produces admin summary fields: `createdAt: Date`, `startedAt: Date | null`, `settlement: { id: string; endedAt: Date; forced: boolean } | null`.

- [ ] **Step 1: Write failing API contract tests**

Add an ordinary room-list test that creates one lobby room and one finished room, calls `GET /api/rooms`, and asserts:

```ts
expect(room).toMatchObject({
  createdAt: expect.any(String),
  startedAt: null,
  endedAt: null,
});
expect(finished).toMatchObject({
  createdAt: expect.any(String),
  startedAt: expect.any(String),
  endedAt: expect.any(String),
});
```

Extend the existing admin list test with the equivalent lobby assertion:

```ts
const listed = list.json().items.find((room: { id: string }) => room.id === lobby.id);
expect(listed).toMatchObject({
  createdAt: expect.any(String),
  startedAt: null,
  settlement: null,
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- apps/api/src/account-room-service.integration.test.ts apps/api/src/admin-account-room-service.integration.test.ts`

Expected: the new ordinary summary expectations fail because `createdAt`, `startedAt`, and `endedAt` are absent; the admin expectation fails because `startedAt` is absent.

- [ ] **Step 3: Add the smallest query and serializer changes**

In `listRooms`, include the settlement relation and append these fields to each returned object:

```ts
createdAt: room.createdAt,
startedAt: room.startedAt,
endedAt: room.settlement?.endedAt ?? null,
```

Use this relation shape:

```ts
settlement: { select: { endedAt: true } },
```

In `listAdminRooms`, append `startedAt: room.startedAt` to the existing serialized item. Do not change the existing `settlement` object, since it already supplies the ended time.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- apps/api/src/account-room-service.integration.test.ts apps/api/src/admin-account-room-service.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Skip: this workspace has no `.git` directory.

### Task 2: 统一的前端时间渲染

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:406-451`
- Modify: `apps/web/app/components/app-router-client.tsx:1056-1060`
- Modify: `apps/web/app/components/app-router-client.tsx:1232`
- Modify: `tests/e2e/browser-fixture-types.ts:3-18`
- Modify: `tests/e2e/task7-visual.spec.ts:9-15`

**Interfaces:**
- Consumes the Task 1 user summary fields and existing admin `createdAt`/`settlement.endedAt` fields.
- Produces `formatRoomLifecycleTime(value: string | null, emptyLabel: string): string`.

- [ ] **Step 1: Write failing browser assertions**

Update the shared room fixture with fixed local-time-safe strings:

```ts
createdAt: '2026-07-29T00:05:00.000Z',
startedAt: null,
endedAt: null,
```

Add a lobby assertion after navigation:

```ts
await expect(page.getByText('创建时间：2026年07月29日 星期三 8:05')).toBeVisible();
await expect(page.getByText('开始时间：未开始')).toBeVisible();
await expect(page.getByText('结束时间：未结束')).toBeVisible();
```

Add an admin rooms fixture with a started room and settlement, open the `房间管理` tab, and assert the three labels render with the supplied timestamps.

- [ ] **Step 2: Run the browser test to verify it fails**

Run: `npm run test:e2e -- tests/e2e/task7-visual.spec.ts --project=desktop-chromium`

Expected: FAIL because no lifecycle labels exist in either list.

- [ ] **Step 3: Implement the smallest shared formatter and renderers**

Extend the `RoomSummary` type:

```ts
createdAt: string; startedAt: string | null; endedAt: string | null;
```

Extend `AdminRoom` with `startedAt: string | null`.

Add a formatter adjacent to the existing room helpers:

```ts
const formatRoomLifecycleTime = (value: string | null, emptyLabel: string) => {
  if (!value) return emptyLabel;
  const date = new Date(value);
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日 ${weekday} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
};
```

Under each current room status summary render:

```tsx
<span>{`创建时间：${formatRoomLifecycleTime(room.createdAt, '')} · 开始时间：${formatRoomLifecycleTime(room.startedAt, '未开始')} · 结束时间：${formatRoomLifecycleTime(room.endedAt, '未结束')}`}</span>
```

For the admin list, pass `room.settlement?.endedAt ?? null` as the end-time input. Retain all current status, visibility, password, and bank indicators.

- [ ] **Step 4: Run the browser test to verify it passes**

Run: `npm run test:e2e -- tests/e2e/task7-visual.spec.ts --project=desktop-chromium`

Expected: PASS, including the existing no-overflow and control-size checks.

- [ ] **Step 5: Run the project verification set**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

Run: `npm run lint`

Expected: PASS with no warnings.

- [ ] **Step 6: Commit**

Skip: this workspace has no `.git` directory.
