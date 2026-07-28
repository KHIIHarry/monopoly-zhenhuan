# 数据看板删除一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除房间后，数据看板不再统计该房间遗留的人物选择记录。

**Architecture:** 看板继续从数据库直接聚合。将房间关联 `SecurityLog` 的物理删除纳入 `AccountRoomService.deleteRoom` 的既有事务，使统计源与房间删除边界一致；管理端现有 `mutateAndReload` 负责删除成功后的重新读取。

**Tech Stack:** TypeScript、Vitest、Fastify、Prisma、PostgreSQL。

## Global Constraints

- 仅变更目标房间 `detailsJson.roomId` 完全匹配的安全日志。
- 日志清理必须与房间删除在同一数据库事务中完成，并沿用既有 `allowPhysicalHistoryDelete` 能力开关。
- 不修改 `/api/admin/dashboard` 接口结构、统计口径或前端刷新流程。
- 使用测试先行：先执行新增用例并确认失败，再写最小修复。
- 当前目录不含 Git 元数据；不执行提交命令。

---

### Task 1: 让房间物理删除清除看板统计源

**Files:**
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts`
- Modify: `apps/api/src/account-room-service.ts`

**Interfaces:**
- Consumes: `DELETE /api/admin/rooms/:id` 现有幂等删除接口。
- Consumes: `GET /api/admin/dashboard` 返回的 `characterSelections`。
- Produces: `deleteRoom` 在事务中删除 `SecurityLog.detailsJson.roomId` 为目标 ID 的记录。

- [ ] **Step 1: 写入失败的 API 集成回归测试。**

在现有“physically deletes the target room”用例中，在 DELETE 请求前创建两条人物选择日志：一条 `roomId: target.id`、一条 `roomId: unrelated.id`；两条均使用相同人物 ID 和 `characterNameSnapshot: 'Deleted room character'`。删除 `target` 后请求 `/api/admin/dashboard`，加入以下断言：

```ts
expect(await db.securityLog.count({
  where: { action: 'CHARACTER_SELECTED', detailsJson: { path: ['roomId'], equals: target.id } },
})).toBe(0);
expect(await db.securityLog.count({
  where: { action: 'CHARACTER_SELECTED', detailsJson: { path: ['roomId'], equals: unrelated.id } },
})).toBe(1);

const dashboard = await app.inject({
  method: 'GET', url: '/api/admin/dashboard', headers: { cookie: cookie.header },
});
expect(dashboard.statusCode).toBe(200);
expect(dashboard.json().characterSelections).not.toContainEqual({
  characterId,
  characterNameSnapshot: 'Deleted room character',
  count: 2,
});
expect(dashboard.json().characterSelections).toContainEqual({
  characterId,
  characterNameSnapshot: 'Deleted room character',
  count: 1,
});
```

创建日志前在测试数据库插入对应的 `PropertyDefinition` 与 `Character`，使看板查询的 `Character` 关联有效。人物 ID 使用 `dashboard-delete-${randomUUID()}`，断言中引用该局部变量，避免跨测试冲突。

- [ ] **Step 2: 运行单个测试，确认失败原因是目标房间的选择日志仍被保留。**

Run: `npm test -- admin-account-room-service.integration.test.ts -t "physically deletes only the selected room"`

Expected: FAIL，目标房间的 `SecurityLog` 计数仍为 `1`，或看板人物选择数仍为 `2`。

- [ ] **Step 3: 在房间删除事务中加入最小日志清理。**

在 `apps/api/src/account-room-service.ts` 的 `deleteRoom` 方法中，紧接 `await this.allowPhysicalHistoryDelete(tx);` 后加入：

```ts
await tx.securityLog.deleteMany({
  where: { detailsJson: { path: ['roomId'], equals: roomId } },
});
```

该操作位于 `Room` 删除之前，与已有结算、账本和成员的删除共享同一个 `executeAdminWrite` 事务。

- [ ] **Step 4: 重跑单个回归测试，确认通过。**

Run: `npm test -- admin-account-room-service.integration.test.ts -t "physically deletes only the selected room"`

Expected: PASS，目标日志和其选择统计为零，无关房间日志与选择统计保留。

- [ ] **Step 5: 执行受影响 API 测试与类型检查。**

Run: `npm test -- admin-account-room-service.integration.test.ts && npm run typecheck`

Expected: 两个命令均以退出码 `0` 完成。
