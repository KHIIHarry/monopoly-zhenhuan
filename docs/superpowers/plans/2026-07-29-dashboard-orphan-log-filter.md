# 数据看板孤儿日志过滤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让人物选择看板忽略已删除房间遗留的安全日志。

**Architecture:** 看板 SQL 以 `Room` 为统计边界，将人物选择日志的 JSON `roomId` 内连接到仍存在的房间；房间删除事务中的日志清理保持不变。

**Tech Stack:** TypeScript、Vitest、Fastify、Prisma、PostgreSQL。

## Global Constraints

- 只影响 `/api/admin/dashboard` 的 `characterSelections` 聚合。
- 只统计 `SecurityLog.detailsJson.roomId` 指向现存 `Room.id` 的 `CHARACTER_SELECTED` 日志。
- 保持人物名称快照回退、排序和响应结构不变。
- 先观察新增回归测试失败，再修改生产 SQL。
- 当前目录没有 Git 元数据；不执行提交。

---

### Task 1: 在看板查询中排除孤儿房间日志

**Files:**
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts`
- Modify: `apps/api/src/account-room-service.ts`

**Interfaces:**
- Consumes: `GET /api/admin/dashboard` 的 `characterSelections` 数组。
- Produces: 每个数组项目仅由现存房间的选择日志计数。

- [ ] **Step 1: 写入失败的 API 集成测试。**

在 `Task 6 real-Cookie admin routes` 描述块中新增测试。创建管理员、普通创建者、一个现存房间、地产定义和人物；为同一人物写入两条 `CHARACTER_SELECTED` 日志：

```ts
const activeRoom = await createRoom(creator.account.id);
const orphanRoomId = `deleted-room-${randomUUID()}`;
await db.securityLog.createMany({ data: [
  { accountId: creator.account.id, action: 'CHARACTER_SELECTED', detailsJson: { roomId: activeRoom.id, characterId, characterNameSnapshot: 'Existing room character' } },
  { accountId: creator.account.id, action: 'CHARACTER_SELECTED', detailsJson: { roomId: orphanRoomId, characterId, characterNameSnapshot: 'Existing room character' } },
] });

const dashboard = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: cookie.header } });
expect(dashboard.statusCode).toBe(200);
expect(dashboard.json().characterSelections).toContainEqual({
  characterId,
  characterNameSnapshot: 'Existing room character',
  count: 1,
});
```

- [ ] **Step 2: 运行单个测试并确认失败。**

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@localhost:5432/zhenhuan_test?schema=public' npm test -- admin-account-room-service.integration.test.ts -t "excludes character selections from deleted rooms"`

Expected: FAIL，因为旧 SQL 聚合两条日志并返回 `count: 2`。

- [ ] **Step 3: 让看板 SQL 内连接现存房间。**

在 `AccountRoomService.dashboard` 的人物选择查询中，替换 `FROM` 与 `WHERE` 开头为：

```sql
FROM "SecurityLog" AS log
INNER JOIN "Room" AS room ON room."id" = log."detailsJson"->>'roomId'
LEFT JOIN "Character" AS character ON character."id" = log."detailsJson"->>'characterId'
WHERE log."action" = 'CHARACTER_SELECTED'
  AND log."detailsJson"->>'roomId' IS NOT NULL
  AND log."detailsJson"->>'characterId' IS NOT NULL
```

保留现有 SELECT、GROUP BY 与 ORDER BY 子句。

- [ ] **Step 4: 重跑单个测试并确认通过。**

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@localhost:5432/zhenhuan_test?schema=public' npm test -- admin-account-room-service.integration.test.ts -t "excludes character selections from deleted rooms"`

Expected: PASS，现存房间人物计数为 `1`，孤儿日志不出现在统计中。

- [ ] **Step 5: 回归删除场景和类型检查。**

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@localhost:5432/zhenhuan_test?schema=public' npm test -- admin-account-room-service.integration.test.ts -t "physically deletes only the selected room|excludes character selections from deleted rooms" && npm run typecheck`

Expected: 这两个回归测试通过；类型检查报告当前仓库的无关类型问题时不得将其归因于此 SQL 变更。
