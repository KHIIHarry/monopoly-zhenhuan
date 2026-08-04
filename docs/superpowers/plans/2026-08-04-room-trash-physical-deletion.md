# 房间垃圾桶与物理删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将超管“归档房间”替换为 24 小时垃圾桶、可恢复、可立即删除且到期自动彻底清除的房间删除生命周期。

**Architecture:** `AccountRoomService` 继续负责超管鉴权、行锁、幂等和房间可见性；新增 `room-trash-cleaner.ts` 只负责调度 API 启动扫描与每分钟扫描。手动永久删除和自动清理在各自持有房间行锁的 PostgreSQL 事务内共用同一个 `deleteLockedRoom()` 删除步骤，前端则用独立纯函数计算倒计时，并在 `AdminView` 的 `ROOMS` 页渲染固定入口和响应式面板。

**Tech Stack:** Next.js、React、TypeScript、Fastify、Prisma 6、PostgreSQL 16、Socket.IO、lucide-react、Vitest、Playwright、Docker Compose。

## Global Constraints

- `PLAYING` 房间必须先正常结束或由超管强制结束，删除接口返回 `ROOM_MUST_END_BEFORE_DELETE` 且不得写入任何数据。
- `LOBBY`、`ENDED`、`FINISHED`、`CLOSED` 可进入垃圾桶；进入垃圾桶和恢复均不得修改原 `status`。
- 垃圾桶保留期固定为 24 小时；重复删除不得延长 `purgeAfter`。
- 恢复不恢复进行中回合、待审批请求或玩家控制权，终态房间恢复后仍为只读历史房间。
- 所有房间生命周期写操作必须使用 PostgreSQL 事务、行锁和 `Idempotency-Key`。
- 普通事务仍禁止更新或删除 `LedgerEntry`、`AuditLog`、`SecurityLog`、`GameSettlement`、`SettlementPlayer`；仅当前事务 ID 匹配 `zhenhuan.physical_delete_txid` 时允许 `DELETE`，`UPDATE` 与 `TRUNCATE` 永远禁止。
- 物理删除必须清除房间全部数据库数据，保留共享账号、账号会话、人物、地产主数据和其他房间。
- 垃圾桶房间不得出现在普通列表、历史列表、后台普通列表和统计中，也不得通过直接 API、房间码或 Socket 访问。
- 垃圾桶入口仅在 `tab === "ROOMS"` 渲染，固定在视口右下角、不可拖动，使用 `lucide-react` 的 `Trash2`，触控区域至少 44px。
- 倒计时小时数向上取整；不足 1 小时显示“剩余不足 1 小时”，同时显示精确自动删除时间，每分钟刷新。
- Web/API 只能通过 Docker Compose 启动，固定使用 `3000/4000`；Playwright 必须设置 `PLAYWRIGHT_EXTERNAL_STACK=1`，不得另开测试端口。
- 不暂存或提交 `.superpowers/sdd/*` 用户草稿；禁止 `git add .`、`git add -A` 和 `git commit -a`。

---

## File Structure

- `packages/database/prisma/schema.prisma`：定义垃圾桶字段、删除操作者关系和到期扫描索引。
- `packages/database/prisma/migrations/202608040021_room_trash_lifecycle/migration.sql`：新增字段/FK/索引，并统一五张不可变表的事务级物理删除能力。
- `packages/database/src/database-contract.test.ts`：静态校验 schema、迁移和不可变边界。
- `packages/database/src/migration-v21.integration.test.ts`：在真实 PostgreSQL 中验证授权删除和普通事务阻断。
- `apps/api/src/account-room-service.ts`：实现移入垃圾桶、列表、恢复、永久删除、到期批量清理和所有非垃圾桶查询约束。
- `apps/api/src/room-trash-cleaner.ts`：API 启动立即扫描、每分钟扫描、停止时清理定时器。
- `apps/api/src/room-trash-cleaner.test.ts`：使用假时钟验证调度和错误隔离。
- `apps/api/src/app.ts`：注册四个管理 API、Socket 逐出和清理器生命周期。
- `apps/api/src/server.ts`：生产启动时显式启用清理器。
- `apps/api/src/admin-account-room-service.integration.test.ts`：覆盖真实数据库生命周期、隔离、删除范围、并发和回滚。
- `apps/api/src/server-room-routes.test.ts`：覆盖路由、幂等键转发和 Socket 通知。
- `apps/api/src/app-socket.test.ts`：覆盖垃圾桶房间拒绝订阅和移入垃圾桶后的连接失效。
- `apps/api/src/api-error.ts`、`apps/api/src/api-error.test.ts`：新增稳定错误码映射。
- `apps/web/app/components/room-trash.ts`：纯函数倒计时与时间格式化。
- `apps/web/app/components/room-trash.test.ts`：倒计时边界测试。
- `apps/web/app/components/app-router-client.tsx`：垃圾桶数据类型、加载、面板、恢复和永久删除交互。
- `apps/web/app/components/app-router-client.test.ts`：静态 UI 契约和错误文案回归。
- `apps/web/app/globals.css`、`apps/web/app/globals.css.test.ts`：固定入口、桌面抽屉、移动端底部面板和触控尺寸。
- `tests/e2e/task7-management.spec.ts`：管理端完整交互和响应式行为。
- `README.md`、`KNOWN_LIMITATIONS.md`：API、删除语义、Docker 与已知限制。

---

### Task 1: 建立数据库垃圾桶字段与不可变删除能力

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/202608040021_room_trash_lifecycle/migration.sql`
- Modify: `packages/database/src/database-contract.test.ts`
- Modify: `packages/database/src/migration-v21.integration.test.ts`

**Interfaces:**
- Produces: `Room.deletedAt: Date | null`、`Room.purgeAfter: Date | null`、`Room.deletedByAccountId: string | null`。
- Produces: `Account.deletedRooms` 反向关系和 `Room_deletedAt_purgeAfter_idx`。
- Produces: 五张不可变表统一使用事务级 `zhenhuan.physical_delete_txid` 的 `DELETE` 例外。

- [ ] **Step 1: 写 schema 与迁移契约失败测试。**

在 `database-contract.test.ts` 增加：

```ts
it('defines the room trash lifecycle and transaction-bound physical deletion', async () => {
  const schema = await readDatabaseFile('prisma/schema.prisma');
  const migration = await readDatabaseFile(
    'prisma/migrations/202608040021_room_trash_lifecycle/migration.sql',
  ).catch(() => '');

  expect(schema).toMatch(/model Room \{[\s\S]*?deletedAt\s+DateTime\?[\s\S]*?purgeAfter\s+DateTime\?[\s\S]*?deletedByAccountId\s+String\?/);
  expect(schema).toContain('@@index([deletedAt, purgeAfter])');
  expect(schema).toMatch(/deletedByAccount\s+Account\?[\s\S]*?onDelete: SetNull/);
  expect(schema).toMatch(/model Account \{[\s\S]*?deletedRooms\s+Room\[\]/);
  for (const functionName of [
    'reject_ledger_entry_mutation',
    'reject_audit_log_mutation',
    'reject_security_log_mutation',
    'zhenhuan_reject_settlement_mutation',
  ]) {
    expect(migration).toContain(`CREATE OR REPLACE FUNCTION ${functionName}`);
  }
  expect(migration).toContain("current_setting('zhenhuan.physical_delete_txid', true)");
  expect(migration).toContain('pg_current_xact_id()::text');
  expect(migration).toMatch(/IF TG_OP = 'DELETE'[\s\S]*?RETURN OLD/);
  expect(migration).not.toMatch(/TG_OP = 'UPDATE'[\s\S]*?RETURN OLD/);
  expect(migration).not.toMatch(/TG_OP = 'TRUNCATE'[\s\S]*?RETURN OLD/);
});
```

在 `migration-v21.integration.test.ts` 增加真实 PostgreSQL 用例：迁移全部应用后创建一套含结算、结算玩家、账本、审计、安全日志的数据；普通 `DELETE` 全部失败，事务内设置正确 txid 后按目标 ID 的 `DELETE` 成功；另一个事务与同一连接后续事务仍失败。

- [ ] **Step 2: 运行数据库契约测试并确认失败。**

Run: `npm exec vitest run -- packages/database/src/database-contract.test.ts`

Expected: FAIL，缺少迁移文件和 `Room` 垃圾桶字段。

- [ ] **Step 3: 修改 Prisma schema 并创建前向迁移。**

`Room` 与 `Account` 使用以下字段和关系：

```prisma
model Room {
  deletedAt          DateTime?
  purgeAfter         DateTime?
  deletedByAccountId String?
  deletedByAccount   Account?  @relation("RoomDeletedBy", fields: [deletedByAccountId], references: [id], onDelete: SetNull)

  @@index([status, expiresAt])
  @@index([deletedAt, purgeAfter])
}

model Account {
  deletedRooms Room[] @relation("RoomDeletedBy")
}
```

迁移必须：

```sql
ALTER TABLE "Room"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "purgeAfter" TIMESTAMP(3),
  ADD COLUMN "deletedByAccountId" TEXT;

CREATE INDEX "Room_deletedAt_purgeAfter_idx"
  ON "Room"("deletedAt", "purgeAfter");

ALTER TABLE "Room" ADD CONSTRAINT "Room_deletedByAccountId_fkey"
  FOREIGN KEY ("deletedByAccountId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
```

同一迁移重新定义四个 trigger function，其中结算函数同时服务 `GameSettlement` 和 `SettlementPlayer`。每个函数只包含以下放行分支，其余路径抛出原表对应的 immutable/append-only 异常：

```sql
IF TG_OP = 'DELETE'
   AND current_setting('zhenhuan.physical_delete_txid', true)
     = pg_current_xact_id()::text THEN
  RETURN OLD;
END IF;
```

- [ ] **Step 4: 生成 Prisma Client 并运行数据库测试。**

Run: `npm run db:generate`

Expected: exit 0，Prisma Client 包含三个新字段。

Run: `npm exec vitest run -- packages/database/src/database-contract.test.ts`

Expected: PASS。

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- packages/database/src/migration-v21.integration.test.ts`

Expected: PASS；普通事务拒绝删除，授权事务只删除目标行。

- [ ] **Step 5: 提交数据库契约。**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/202608040021_room_trash_lifecycle/migration.sql packages/database/src/database-contract.test.ts packages/database/src/migration-v21.integration.test.ts
git commit -m "feat(db): add room trash lifecycle"
```

### Task 2: 实现移入垃圾桶、垃圾桶列表与恢复

**Files:**
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server-room-routes.test.ts`
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts`
- Modify: `apps/api/src/api-error.ts`
- Modify: `apps/api/src/api-error.test.ts`

**Interfaces:**
- Produces: `deleteRoom(auth, roomId, key): Promise<{ deleted: true; id: string; status: RoomStatus; deletedAt: Date; purgeAfter: Date; stateVersion: number; created: boolean }>`，语义改为移入垃圾桶。
- Produces: `listDeletedRooms(auth): Promise<{ items: AdminTrashRoom[] }>`。
- Produces: `restoreRoom(auth, roomId, key): Promise<{ restored: true; id: string; status: RoomStatus; stateVersion: number; created: boolean }>`。
- Produces: `ROOM_MUST_END_BEFORE_DELETE` 和 `ROOM_NOT_IN_TRASH` 的稳定 409 映射。

- [ ] **Step 1: 写路由与集成失败测试。**

在 `server-room-routes.test.ts` 的服务桩加入：

```ts
listDeletedRooms: vi.fn(async () => ({ items: [{
  id: 'room-trash', name: '待删房间', code: 'TRASH1', status: 'FINISHED',
  deletedAt: '2026-08-04T00:00:00.000Z', purgeAfter: '2026-08-05T00:00:00.000Z',
  deletedBy: { id: 'account-1', displayName: '结算银行' },
}] })),
restoreRoom: vi.fn(async (_auth, id) => ({ restored: true as const, id, status: 'FINISHED', stateVersion: 14, created: true })),
deleteRoom: vi.fn(async (_auth, id) => ({ deleted: true as const, id, status: 'LOBBY', deletedAt: new Date(), purgeAfter: new Date(), stateVersion: 13, created: true })),
```

断言 `GET /api/admin/rooms/trash`、`POST /api/admin/rooms/:id/restore` 和原 DELETE 正确调用服务并转发 `Idempotency-Key`。

在 `admin-account-room-service.integration.test.ts` 增加四组用例：

```ts
expect((await moveToTrash(playing.id, 'playing-delete')).json())
  .toEqual({ error: 'ROOM_MUST_END_BEFORE_DELETE' });
expect(await db.room.findUnique({ where: { id: playing.id } }))
  .toMatchObject({ status: 'PLAYING', deletedAt: null, purgeAfter: null });

for (const status of ['LOBBY', 'ENDED', 'FINISHED', 'CLOSED'] as const) {
  const target = await createRoom(creator.account.id, status);
  const response = await moveToTrash(target.id, `trash-${status}`);
  expect(response.statusCode).toBe(200);
  const stored = await db.room.findUniqueOrThrow({ where: { id: target.id } });
  expect(stored.status).toBe(status);
  expect(stored.purgeAfter!.getTime() - stored.deletedAt!.getTime()).toBe(86_400_000);
}
```

继续在同一测试文件增加以下精确断言：

```ts
const firstStored = await db.room.findUniqueOrThrow({ where: { id: lobby.id } });
await moveToTrash(lobby.id, 'trash-lobby');
await moveToTrash(lobby.id, 'trash-lobby-new-key');
const repeatedStored = await db.room.findUniqueOrThrow({ where: { id: lobby.id } });
expect(repeatedStored.deletedAt).toEqual(firstStored.deletedAt);
expect(repeatedStored.purgeAfter).toEqual(firstStored.purgeAfter);

const trash = await app.inject({ method: 'GET', url: '/api/admin/rooms/trash', headers: adminHeaders });
expect(trash.statusCode).toBe(200);
expect(trash.json().items.map((item: { purgeAfter: string }) => item.purgeAfter))
  .toEqual([...trash.json().items.map((item: { purgeAfter: string }) => item.purgeAfter)].sort());

const restored = await app.inject({
  method: 'POST', url: `/api/admin/rooms/${lobby.id}/restore`,
  headers: { ...adminHeaders, 'idempotency-key': 'restore-lobby' },
});
expect(restored.statusCode).toBe(200);
const restoredRoom = await db.room.findUniqueOrThrow({ where: { id: lobby.id } });
expect(restoredRoom).toMatchObject({ status: 'LOBBY', deletedAt: null, purgeAfter: null, deletedByAccountId: null });
```

- [ ] **Step 2: 运行失败测试。**

Run: `npm exec vitest run -- apps/api/src/server-room-routes.test.ts apps/api/src/api-error.test.ts`

Expected: FAIL，垃圾桶列表和恢复路由不存在。

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- apps/api/src/admin-account-room-service.integration.test.ts`

Expected: FAIL，现有 DELETE 会把房间归档为 `CLOSED`。

- [ ] **Step 3: 增加独立的“包含垃圾桶”行锁并实现生命周期。**

保留 `lockRoom()` 给普通操作，并新增：

```ts
private async lockRoomIncludingTrash(tx: Prisma.TransactionClient, roomId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Room" WHERE "id" = ${roomId} FOR UPDATE
  `;
  if (!rows.length) fail('ROOM_NOT_FOUND');
}
```

`deleteRoom()` 在 Serializable 管理事务中锁行并实现：

```ts
if (room.status === 'PLAYING') fail('ROOM_MUST_END_BEFORE_DELETE');
if (room.deletedAt && room.purgeAfter) return existingTrashResult(room, false);
const deletedAt = new Date();
const purgeAfter = new Date(deletedAt.getTime() + 86_400_000);
const updated = await tx.room.update({
  where: { id: roomId },
  data: {
    deletedAt,
    purgeAfter,
    deletedByAccountId: auth.account.id,
    stateVersion: { increment: 1 },
  },
});
await tx.securityLog.create({ data: {
  actorAccountId: auth.account.id,
  action: 'ADMIN_ROOM_MOVED_TO_TRASH',
  detailsJson: { roomId, roomName: room.name, status: room.status, deletedAt, purgeAfter },
} });
```

`listDeletedRooms()` 查询 `deletedAt: { not: null }`，包含删除操作者展示名，按 `purgeAfter asc, id asc` 返回。`restoreRoom()` 锁行后清空三个字段、递增版本并写 `ADMIN_ROOM_RESTORED` 安全日志；已恢复的新 key 重试返回当前状态且不再递增。

- [ ] **Step 4: 注册三个路由并增加错误映射。**

静态 `/trash` 路由放在 `/:id` 之前：

```ts
app.get('/api/admin/rooms/trash', async (request) =>
  accounts.listDeletedRooms(await authenticate(request)));

app.post('/api/admin/rooms/:id/restore', async (request) => {
  const auth = await authenticate(request);
  const { id } = z.object({ id: z.string() }).parse(request.params);
  const result = await accounts.restoreRoom(auth, id, idempotencyKey(request.headers['idempotency-key']));
  return result;
});
```

原 `DELETE /api/admin/rooms/:id` 返回服务的删除时间和版本。`api-error.ts` 将 `ROOM_MUST_END_BEFORE_DELETE`、`ROOM_NOT_IN_TRASH` 映射为 409 并在 `api-error.test.ts` 锁定响应。

- [ ] **Step 5: 重跑 API 测试并提交。**

Run: `npm exec vitest run -- apps/api/src/server-room-routes.test.ts apps/api/src/api-error.test.ts`

Expected: PASS。

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- apps/api/src/admin-account-room-service.integration.test.ts`

Expected: PASS。

```bash
git add apps/api/src/account-room-service.ts apps/api/src/app.ts apps/api/src/server-room-routes.test.ts apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/api-error.ts apps/api/src/api-error.test.ts
git commit -m "feat(api): add room trash lifecycle"
```

### Task 3: 隔离垃圾桶房间的列表、API、统计与 Socket

**Files:**
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts`
- Modify: `apps/api/src/app-socket.test.ts`
- Modify: `apps/api/src/server-room-routes.test.ts`

**Interfaces:**
- Produces: `lockRoom()`、`ensureMembership()`、`authorizeRoomSession()` 和房间读取统一把 `deletedAt != null` 视为不可用。
- Produces: 普通列表、后台列表、统计、结算聚合只计算 `deletedAt = null` 房间。
- Produces: `evictRoomSubscriptions(roomId, reason)` 在移入垃圾桶提交后拒绝并移除现有 Socket 订阅。

- [ ] **Step 1: 写隔离失败测试。**

在真实数据库集成测试中将一个含成员、结算和 `CHARACTER_SELECTED` 安全日志的房间移入垃圾桶，然后断言：

```ts
expect((await app.inject({ method: 'GET', url: '/api/rooms', headers: playerHeaders })).json())
  .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: trashed.id })]));
expect((await app.inject({ method: 'GET', url: '/api/admin/rooms', headers: adminHeaders })).json().items)
  .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: trashed.id })]));

for (const request of [
  { method: 'GET', url: `/api/rooms/${trashed.id}/seats` },
  { method: 'GET', url: `/api/rooms/${trashed.id}/snapshot?view=PLAYER` },
  { method: 'GET', url: `/api/rooms/${trashed.id}/settlement` },
  { method: 'POST', url: `/api/rooms/${trashed.id}/join`, payload: {} },
] as const) {
  const response = await app.inject({ ...request, headers: playerHeaders });
  expect([403, 404]).toContain(response.statusCode);
}
```

断言 dashboard 的 lobby/playing/finished、settledTotal、人物选择/胜场和 recentGames 全部排除该房间。`app-socket.test.ts` 增加两个用例：`authorizeRoomSession` 抛出 `ROOM_NOT_FOUND` 时只收到 `room.subscription-rejected`、不会收到 snapshot；已订阅连接在超管移入垃圾桶后收到 `{ roomId, reason: 'ROOM_MOVED_TO_TRASH' }`，离开 `room:${roomId}` 且 `socket.data.subscribedRoomId` 被清空。

- [ ] **Step 2: 运行隔离测试并确认失败。**

Run: `npm exec vitest run -- apps/api/src/app-socket.test.ts`

Expected: 新 Socket 隔离用例 FAIL。

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- apps/api/src/admin-account-room-service.integration.test.ts`

Expected: 垃圾桶房间仍出现在列表或统计中。

- [ ] **Step 3: 为所有非垃圾桶读取增加数据库条件。**

将普通行锁改为：

```ts
SELECT "id" FROM "Room"
WHERE "id" = ${roomId} AND "deletedAt" IS NULL
FOR UPDATE
```

并应用以下明确规则：

```ts
// listRooms
where: {
  deletedAt: null,
  OR: [
    { visibility: 'PUBLIC' },
    { members: { some: { accountId: auth.account.id } } },
  ],
}

// listAdminRooms
const filters: Prisma.RoomWhereInput[] = [{ deletedAt: null }];
// 保留现有 query/status/cursor push；最终仍使用：
where: { AND: filters }

// getAdminRoom / seats / settlement lookup
where: { id: roomId, deletedAt: null }

// authorizeRoomSession
if (membership.room.deletedAt) fail('ROOM_NOT_FOUND');

// dashboard counts and settlement queries
where: { room: { deletedAt: null } }
```

dashboard 的人物选择原始 SQL在 `INNER JOIN "Room"` 后增加 `AND room."deletedAt" IS NULL`；胜场 groupBy、结算 aggregate 和 recentGames 使用 `room: { deletedAt: null }`。通过 request ID 执行的角色交换方法在锁定关联房间后复用新的 `lockRoom()`，不得绕过隔离。

在 `app.ts` 增加并复用房间级逐出函数：

```ts
const evictRoomSubscriptions = (roomId: string, reason: string) => {
  const channel = roomChannel(roomId);
  io.to(channel).emit('room.subscription-rejected', { roomId, reason });
  io.in(channel).socketsLeave(channel);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.subscribedRoomId === roomId) delete socket.data.subscribedRoomId;
  }
};
```

`DELETE /api/admin/rooms/:id` 仅在 `result.created === true` 时于事务提交后调用 `evictRoomSubscriptions(id, 'ROOM_MOVED_TO_TRASH')`；幂等重放不重复通知。`server-room-routes.test.ts` 锁定删除路由仍返回垃圾桶 DTO，且只有首次创建时触发通知路径。

- [ ] **Step 4: 重跑隔离与现有账号房间测试。**

Run: `npm exec vitest run -- apps/api/src/app-socket.test.ts apps/api/src/server-room-routes.test.ts apps/api/src/account-room-service.integration.test.ts`

Expected: 单元测试 PASS；无测试数据库时集成 suite 明确显示 skipped。

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/account-room-service.integration.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交访问隔离。**

```bash
git add apps/api/src/account-room-service.ts apps/api/src/app.ts apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/app-socket.test.ts apps/api/src/server-room-routes.test.ts
git commit -m "fix(api): isolate trashed rooms"
```

### Task 4: 实现完整、幂等且竞态安全的物理删除事务

**Files:**
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server-room-routes.test.ts`
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts`

**Interfaces:**
- Produces: `permanentlyDeleteRoom(auth, roomId, key): Promise<{ deleted: true; id: string }>`。
- Produces: `purgeRoom(roomId, source): Promise<{ deleted: boolean; id: string }>`，并由它与 Task 5 共用私有 `deleteLockedRoom(tx, room, source)` 删除步骤。
- Produces: `DELETE /api/admin/rooms/:id/permanent`。

- [ ] **Step 1: 写删除范围、回滚、幂等与竞态失败测试。**

在集成测试构造一间包含成员、玩家、地产、请求、交易、账本、回合、落点、停轮、债务、换角请求、游戏结果、结算、结算玩家、审计、安全日志及房间幂等记录的垃圾桶房间，同时创建共享账号/主数据和另一房间。调用永久删除后逐表断言目标计数为 0，另一房间和共享数据仍存在。

增加以下用例：

```ts
const [first, second] = await Promise.all([
  permanentDelete(room.id, 'permanent-a'),
  permanentDelete(room.id, 'permanent-b'),
]);
expect(first.statusCode).toBe(200);
expect(second.statusCode).toBe(200);
expect(first.json()).toEqual({ deleted: true, id: room.id });
expect(second.json()).toEqual(first.json());
```

同一 suite 增加以下失败和收敛断言：

```ts
expect((await permanentDelete(activeRoom.id, 'not-trashed')).json())
  .toEqual({ error: 'ROOM_NOT_IN_TRASH' });

await permanentDelete(trashed.id, 'first-delete');
expect((await permanentDelete(trashed.id, 'first-delete')).json())
  .toEqual({ deleted: true, id: trashed.id });
expect((await permanentDelete(trashed.id, 'new-delete-key')).json())
  .toEqual({ deleted: true, id: trashed.id });

await db.$executeRawUnsafe(`
  CREATE FUNCTION "${failureFunction}"() RETURNS TRIGGER AS $$
  BEGIN RAISE EXCEPTION 'INJECTED_PURGE_FAILURE'; END;
  $$ LANGUAGE plpgsql
`);
await db.$executeRawUnsafe(`
  CREATE TRIGGER "${failureTrigger}"
  BEFORE DELETE ON "GameTransaction"
  FOR EACH ROW EXECUTE FUNCTION "${failureFunction}"()
`);
await expect(service.purgeRoom(rollbackRoom.id, { kind: 'AUTO' }))
  .rejects.toThrow('INJECTED_PURGE_FAILURE');
expect(await db.room.findUnique({ where: { id: rollbackRoom.id } })).not.toBeNull();
expect(await db.gameSettlement.findUnique({ where: { roomId: rollbackRoom.id } })).not.toBeNull();
await db.$executeRawUnsafe(`DROP TRIGGER "${failureTrigger}" ON "GameTransaction"`);
await db.$executeRawUnsafe(`DROP FUNCTION "${failureFunction}"()`);

const race = await Promise.allSettled([
  restore(trashedForRace.id, 'race-restore'),
  permanentDelete(trashedForRace.id, 'race-delete'),
]);
expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
const roomAfterRace = await db.room.findUnique({ where: { id: trashedForRace.id } });
if (roomAfterRace) expect(roomAfterRace.deletedAt).toBeNull();
```

`failureFunction` 和 `failureTrigger` 使用 `randomUUID()` 生成只含字母数字下划线的隔离 schema 名称，并放在 `try/finally` 中确保测试失败时也删除 trigger/function。生产服务不增加任何测试专用接口。五张不可变表的普通事务断言沿用 Task 1 的真实 PostgreSQL 测试，并在此处额外确认 purge 成功后目标行全部为 0。

- [ ] **Step 2: 运行集成测试确认失败。**

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- apps/api/src/admin-account-room-service.integration.test.ts`

Expected: FAIL，永久删除方法和路由不存在。

- [ ] **Step 3: 实现共用的物理删除事务。**

`purgeRoom()` 使用 Serializable 事务、`lockRoomIncludingTrash()` 和锁内重检。房间不存在直接返回 `{ deleted: false, id }`；房间存在但未进垃圾桶时抛 `ROOM_NOT_IN_TRASH`。它随后调用私有 `deleteLockedRoom()`；该方法调用 `allowPhysicalHistoryDelete(tx)`，按以下顺序和精确 `roomId` 条件删除：

```ts
await tx.settlementPlayer.deleteMany({ where: { settlement: { roomId } } });
await tx.gameSettlement.deleteMany({ where: { roomId } });
await tx.ledgerEntry.deleteMany({ where: { roomId } });
await tx.auditLog.deleteMany({ where: { roomId } });
await tx.securityLog.deleteMany({
  where: { detailsJson: { path: ['roomId'], equals: roomId } },
});
await tx.gameResult.deleteMany({ where: { roomId } });
await tx.roleSwapRequest.deleteMany({ where: { roomId } });
await tx.debtRecord.deleteMany({ where: { roomId } });
await tx.skipTurnEntry.deleteMany({ where: { roomId } });
await tx.roomProperty.updateMany({
  where: { roomId }, data: { lockedByRequestId: null },
});
await tx.landingEvent.deleteMany({ where: { roomId } });
await tx.gameRequest.deleteMany({ where: { roomId } });
await tx.gameTransaction.deleteMany({ where: { roomId } });
await tx.turn.deleteMany({ where: { roomId } });
await tx.roomProperty.deleteMany({ where: { roomId } });
await tx.player.deleteMany({ where: { roomId } });
await tx.roomMembership.deleteMany({ where: { roomId } });
await tx.idempotencyRecord.deleteMany({ where: { OR: [
  { scope: { contains: `:room:${roomId}:` } },
  { scope: { contains: ':admin:room:', endsWith: `:${roomId}` } },
] } });
await tx.room.delete({ where: { id: roomId } });
```

如果 Prisma 不接受同一字符串过滤器同时使用 `contains` 和 `endsWith`，拆成嵌套 `AND`；不得扩大为只按 `contains: roomId`。事务提交后使用注入 logger 输出 `{ roomId, roomName, source, actorAccountId }`，不再写数据库墓碑或安全日志。

`permanentlyDeleteRoom()` 先验证当前超管，再调用同一 `purgeRoom()`；不存在按成功返回。实际删除时清除该房间此前的幂等记录，因此重试收敛依靠确定性的“不存在即成功”。

- [ ] **Step 4: 注册永久删除路由和路由契约。**

```ts
app.delete('/api/admin/rooms/:id/permanent', async (request) => {
  const auth = await authenticate(request);
  const { id } = z.object({ id: z.string() }).parse(request.params);
  return accounts.permanentlyDeleteRoom(
    auth,
    id,
    idempotencyKey(request.headers['idempotency-key']),
  );
});
```

路由测试断言无 key 返回 `IDEMPOTENCY_KEY_REQUIRED`，有 key 传给服务并返回 `{ deleted: true, id }`。

- [ ] **Step 5: 重跑测试并提交。**

Run: `npm exec vitest run -- apps/api/src/server-room-routes.test.ts`

Expected: PASS。

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- apps/api/src/admin-account-room-service.integration.test.ts`

Expected: PASS，删除范围、回滚、并发与不可变门禁全部通过。

```bash
git add apps/api/src/account-room-service.ts apps/api/src/app.ts apps/api/src/server-room-routes.test.ts apps/api/src/admin-account-room-service.integration.test.ts
git commit -m "feat(api): permanently purge trashed rooms"
```

### Task 5: 增加 API 内置到期清理器

**Files:**
- Create: `apps/api/src/room-trash-cleaner.ts`
- Create: `apps/api/src/room-trash-cleaner.test.ts`
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Produces: `purgeExpiredRooms(now?: Date, limit?: number): Promise<Array<{ id: string; deleted: boolean }>>`。
- Produces: `startRoomTrashCleaner(options): { stop(): void; runNow(): Promise<void> }`。
- Consumes: Task 4 的私有 `deleteLockedRoom(tx, room, { kind: 'AUTO' })` 删除步骤，确保手动和自动路径使用完全相同的删除顺序。

- [ ] **Step 1: 写清理器假时钟失败测试。**

```ts
it('runs immediately, then every minute, and stops cleanly', async () => {
  vi.useFakeTimers();
  const purgeExpiredRooms = vi.fn().mockResolvedValue([]);
  const cleaner = startRoomTrashCleaner({
    purgeExpiredRooms,
    intervalMs: 60_000,
    onError: vi.fn(),
  });
  await cleaner.runNow();
  expect(purgeExpiredRooms).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(purgeExpiredRooms).toHaveBeenCalledTimes(2);
  cleaner.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(purgeExpiredRooms).toHaveBeenCalledTimes(2);
});
```

再增加不重入和失败恢复用例：第一次 `purgeExpiredRooms` 返回 deferred promise，推进一个 tick 后调用次数仍为 1；resolve 后再推进一个 tick 变为 2。将第一次调用设为 `mockRejectedValueOnce(new Error('scan failed'))`，断言 `onError` 收到错误，下一 tick 的第二次调用仍成功。

在集成测试中用固定 `now` 覆盖到期前不删、到期后删除、重启补清理语义；并发调用两次 `purgeExpiredRooms(now)` 时每个房间只出现一次成功删除结果。

- [ ] **Step 2: 运行失败测试。**

Run: `npm exec vitest run -- apps/api/src/room-trash-cleaner.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现清理器与数据库领取循环。**

`purgeExpiredRooms()` 每次最多处理 20 个房间。每个循环开启一个 Serializable 事务，并在事务内使用：

```sql
SELECT "id"
FROM "Room"
WHERE "deletedAt" IS NOT NULL
  AND "purgeAfter" <= ${now}
ORDER BY "purgeAfter" ASC, "id" ASC
FOR UPDATE SKIP LOCKED
LIMIT 1
```

锁保持到 Task 4 的重检和 `deleteLockedRoom()` 整房删除完成后才释放。没有候选或达到 limit 时结束；维护本轮 `failedRoomIds`，使用 Prisma SQL 片段安全排除本轮失败目标：

```ts
const exclusion = failedRoomIds.length
  ? Prisma.sql`AND "id" NOT IN (${Prisma.join(failedRoomIds)})`
  : Prisma.empty;
const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
  SELECT "id" FROM "Room"
  WHERE "deletedAt" IS NOT NULL AND "purgeAfter" <= ${now}
  ${exclusion}
  ORDER BY "purgeAfter" ASC, "id" ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
`);
```

单房间失败加入集合并记录错误，下一轮定时扫描才重试该房间，避免它在同一批中反复占满领取次数并阻塞其他房间。

`room-trash-cleaner.ts` 使用一个 `running` 布尔值阻止重入，构造后立即 `void runNow()`，并以 `setInterval(runNow, 60_000)` 调度。`stop()` 幂等清理 timer。

- [ ] **Step 4: 接入 API 生命周期。**

扩展 `BuildApiAppOptions`：

```ts
startRoomTrashCleaner?: boolean;
trashCleanupIntervalMs?: number;
```

只有 `startRoomTrashCleaner === true` 时创建清理器；在 `app.addHook('onClose', ...)` 调用 `stop()`。`server.ts` 必须显式：

```ts
const app = await buildApiApp({ startRoomTrashCleaner: true });
```

测试构建默认不启动后台 timer，避免 suite 串扰。生产启动立即扫描，API 停机期间过期房间在重启后第一次扫描清除。

- [ ] **Step 5: 重跑清理器与集成测试并提交。**

Run: `npm exec vitest run -- apps/api/src/room-trash-cleaner.test.ts apps/api/src/server-room-routes.test.ts`

Expected: PASS。

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- apps/api/src/admin-account-room-service.integration.test.ts`

Expected: PASS。

```bash
git add apps/api/src/room-trash-cleaner.ts apps/api/src/room-trash-cleaner.test.ts apps/api/src/account-room-service.ts apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/app.ts apps/api/src/server.ts
git commit -m "feat(api): purge expired trashed rooms"
```

### Task 6: 建立前端垃圾桶时间模型与数据加载

**Files:**
- Create: `apps/web/app/components/room-trash.ts`
- Create: `apps/web/app/components/room-trash.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx`
- Modify: `apps/web/app/components/app-router-client.test.ts`

**Interfaces:**
- Produces: `type AdminTrashRoom`。
- Produces: `formatTrashCountdown(purgeAfter: string, nowMs: number): string`。
- Produces: `formatTrashDeadline(purgeAfter: string): string`。
- Produces: `AdminView` 内的 `trashRooms`、`trashOpen`、`trashNowMs` 状态及 `loadTrashRooms()`。

- [ ] **Step 1: 写倒计时与组件契约失败测试。**

```ts
describe('formatTrashCountdown', () => {
  const now = Date.parse('2026-08-04T00:00:00.000Z');
  expect(formatTrashCountdown('2026-08-05T00:00:00.000Z', now)).toBe('剩余 24 小时');
  expect(formatTrashCountdown('2026-08-04T23:01:00.000Z', now)).toBe('剩余 24 小时');
  expect(formatTrashCountdown('2026-08-04T00:59:00.000Z', now)).toBe('剩余不足 1 小时');
  expect(formatTrashCountdown('2026-08-04T00:00:00.000Z', now)).toBe('等待自动删除');
});
```

`app-router-client.test.ts` 断言组件请求 `/api/admin/rooms/trash`，切离 `ROOMS` 时执行 `setTrashOpen(false)`，恢复与永久删除使用 `POST`/`DELETE` 和现有 `writeAction` 幂等机制。

- [ ] **Step 2: 运行失败测试。**

Run: `npm exec vitest run -- apps/web/app/components/room-trash.test.ts apps/web/app/components/app-router-client.test.ts`

Expected: FAIL，时间模块和垃圾桶状态不存在。

- [ ] **Step 3: 实现纯函数与管理页状态。**

```ts
export type AdminTrashRoom = {
  id: string;
  name: string;
  code: string;
  status: 'LOBBY' | 'ENDED' | 'FINISHED' | 'CLOSED';
  deletedAt: string;
  purgeAfter: string;
  deletedBy: { id: string; displayName: string } | null;
};

export function formatTrashCountdown(purgeAfter: string, nowMs: number) {
  const remaining = Date.parse(purgeAfter) - nowMs;
  if (remaining <= 0) return '等待自动删除';
  if (remaining < 3_600_000) return '剩余不足 1 小时';
  return `剩余 ${Math.ceil(remaining / 3_600_000)} 小时`;
}

export function formatTrashDeadline(purgeAfter: string) {
  return new Date(purgeAfter).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
```

`AdminView` 初次进入 `ROOMS` 和每次后台 reload 后调用 `loadTrashRooms()`；每 60 秒更新 `trashNowMs`。effect 依赖 `tab`，当 `tab !== 'ROOMS'` 时立即关闭面板并停止该页的计时器。

- [ ] **Step 4: 重跑前端单元测试并提交。**

Run: `npm exec vitest run -- apps/web/app/components/room-trash.test.ts apps/web/app/components/app-router-client.test.ts`

Expected: PASS。

```bash
git add apps/web/app/components/room-trash.ts apps/web/app/components/room-trash.test.ts apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts
git commit -m "feat(web): load room trash state"
```

### Task 7: 实现固定垃圾桶入口、响应式面板与危险操作

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx`
- Modify: `apps/web/app/components/app-router-client.test.ts`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.css.test.ts`
- Modify: `tests/e2e/task7-management.spec.ts`

**Interfaces:**
- Consumes: Task 6 的 `AdminTrashRoom`、`formatTrashCountdown()`、`formatTrashDeadline()` 和加载状态。
- Produces: `Trash2` 固定入口、桌面右侧抽屉、移动端底部面板、恢复确认和完整房间名永久删除确认。

- [ ] **Step 1: 写 UI、样式和 E2E 失败测试。**

组件契约测试断言：

```ts
expect(component).toContain('import {');
expect(component).toContain('Trash2');
expect(component).toMatch(/tab === "ROOMS"[\s\S]*?className="room-trash-trigger"/);
expect(component).toContain('aria-label="待删除房间"');
expect(component).toContain('className="room-trash-count"');
expect(component).toContain('className="room-trash-panel"');
expect(component).toContain('确认立即删除房间');
```

样式测试读取 `globals.css` 并断言 `.room-trash-trigger` 有 `position: fixed`、`right`、`bottom`、`width/height: 52px`；桌面 `.room-trash-panel` 固定右侧，`max-width: 899px` 下固定底部；不存在 `draggable` 或拖动 cursor。

Playwright 路由桩返回两项垃圾桶数据，覆盖：入口只在房间 tab；角标为 2；桌面从右侧打开、移动端从底部打开；每项显示房间名/码/状态/倒计时/准确时间；恢复发送 POST；立即删除必须输入完整名称并发送 DELETE；操作时按钮禁用；成功后列表、角标和后台数据刷新。

- [ ] **Step 2: 运行失败测试。**

Run: `npm exec vitest run -- apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css.test.ts`

Expected: FAIL，垃圾桶 DOM 与样式不存在。

- [ ] **Step 3: 修改房间详情删除入口。**

将“归档房间”改为“删除房间”。`selectedRoom.status === 'PLAYING'` 时：

```tsx
<button
  className="danger-button"
  disabled={busy || selectedRoom.status === 'PLAYING'}
  title={selectedRoom.status === 'PLAYING' ? '请先结束对局后删除' : undefined}
>
  删除房间
</button>
```

可删除房间的确认弹窗说明“进入垃圾桶，24 小时后自动永久删除，期间可恢复”，要求输入完整 `selectedRoom.name`，确认文案为“移入垃圾桶”。成功后关闭详情、调用 `onReload()` 和 `loadTrashRooms()`。

同时在现有 API 错误文案表加入：

```ts
ROOM_MUST_END_BEFORE_DELETE: '请先结束对局，再删除房间',
ROOM_NOT_IN_TRASH: '该房间不在垃圾桶中，请刷新后重试',
```

- [ ] **Step 4: 渲染固定入口和垃圾桶面板。**

在 `AdminView` 返回值的 `ROOMS` tab 内容之后、确认弹窗之前渲染：

```tsx
{tab === 'ROOMS' && (
  <>
    <button
      type="button"
      className="room-trash-trigger"
      aria-label="待删除房间"
      title="待删除房间"
      onClick={() => setTrashOpen(true)}
    >
      <Trash2 />
      {trashRooms.length > 0 && <span className="room-trash-count">{trashRooms.length}</span>}
    </button>
    {trashOpen && (
      <div className="room-trash-backdrop" onClick={() => setTrashOpen(false)}>
        <aside
          className="room-trash-panel"
          role="dialog"
          aria-modal="true"
          aria-label="待删除房间"
          onClick={(event) => event.stopPropagation()}
        >
          <header>
            <h2>待删除房间</h2>
            <button aria-label="关闭垃圾桶" onClick={() => setTrashOpen(false)}><X /></button>
          </header>
          <div className="room-trash-list">
            {trashRooms.length === 0 ? <p className="room-trash-empty">垃圾桶为空</p> : trashRooms.map((room) => (
              <article className="room-trash-row" key={room.id}>
                <div>
                  <strong>{room.name}</strong>
                  <span>{room.code} · {localizedRoomStatus(room.status)}</span>
                  <small>删除时间：{new Date(room.deletedAt).toLocaleString('zh-CN')}</small>
                  <small>{formatTrashCountdown(room.purgeAfter, trashNowMs)}</small>
                  <small>自动删除：{formatTrashDeadline(room.purgeAfter)}</small>
                </div>
                <div className="room-trash-actions">
                  <button disabled={busy} onClick={() => confirmRestore(room)}>恢复</button>
                  <button className="danger-button" disabled={busy} onClick={() => confirmPermanentDelete(room)}>立即删除</button>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </div>
    )}
  </>
)}
```

`confirmRestore(room)` 打开普通确认并调用 `POST /api/admin/rooms/:id/restore`；`confirmPermanentDelete(room)` 打开危险确认，`fieldLabel` 为“确认立即删除房间”，`expectedValues` 只含完整房间名，调用 `DELETE /api/admin/rooms/:id/permanent`。两者成功后依次执行 `loadTrashRooms()` 与 `onReload()`，永久删除确认成功后清空 `confirmName`。

- [ ] **Step 5: 增加响应式样式。**

```css
.room-trash-trigger {
  position: fixed;
  right: 18px;
  bottom: calc(18px + env(safe-area-inset-bottom));
  z-index: 35;
  width: 52px;
  min-width: 52px;
  height: 52px;
  min-height: 52px;
  padding: 0;
  border: 1px solid var(--gold);
  border-radius: 50%;
  background: var(--paper-2);
  color: var(--red);
  display: grid;
  place-items: center;
  box-shadow: 0 6px 18px rgb(33 25 26 / 18%);
}
.room-trash-trigger svg { width: 22px; height: 22px; }
.room-trash-count { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; border-radius: 10px; }
.room-trash-backdrop { position: fixed; inset: 0; z-index: 50; background: rgb(33 25 26 / 42%); }
.room-trash-panel { position: fixed; top: 0; right: 0; width: min(420px, 100%); height: 100dvh; overflow-y: auto; background: var(--paper); }
@media (max-width: 899px) {
  .room-trash-trigger { bottom: calc(76px + env(safe-area-inset-bottom)); }
  .room-trash-panel { top: auto; bottom: 0; width: 100%; height: auto; max-height: min(78dvh, 680px); }
}
```

补齐列表、操作按钮、空状态和安全区样式；不使用拖动属性、Emoji、嵌套卡片或小于 44px 的按钮。

- [ ] **Step 6: 运行单元和 Docker 外部栈 E2E。**

Run: `npm exec vitest run -- apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css.test.ts apps/web/app/components/room-trash.test.ts`

Expected: PASS。

Run: `PLAYWRIGHT_EXTERNAL_STACK=1 npm exec playwright test -- tests/e2e/task7-management.spec.ts`

Expected: PASS；测试复用 Docker 的 `http://localhost:3000`，不会启动新 Web 服务。

- [ ] **Step 7: 提交 UI。**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css apps/web/app/globals.css.test.ts tests/e2e/task7-management.spec.ts
git commit -m "feat(web): add room trash controls"
```

### Task 8: 更新文档并完成全量 Docker 验证

**Files:**
- Modify: `README.md`
- Modify: `KNOWN_LIMITATIONS.md`
- Verify: all files changed in Tasks 1-7

**Interfaces:**
- Produces: 面向维护者的四个 API、24 小时规则、Docker 启动和测试说明。

- [ ] **Step 1: 更新 README 与已知限制。**

README 的超管 API 增加：

```text
DELETE /api/admin/rooms/:id             移入垃圾桶；PLAYING 必须先结束
GET    /api/admin/rooms/trash           查询 24 小时保留期内的房间
POST   /api/admin/rooms/:id/restore     恢复并保留原状态/结算
DELETE /api/admin/rooms/:id/permanent   立即彻底删除全部房间数据
```

明确 API 启动立即补清理、此后每分钟扫描、恢复不复活对局运行态、永久删除不可恢复。删除 `KNOWN_LIMITATIONS.md` 中任何“房间删除实际为归档”或“历史永远无法整房删除”的旧说明；保留当前没有房间附件存储、清理器依赖 API 至少运行一个实例的真实限制。

- [ ] **Step 2: 检查迁移和删除范围。**

Run: `rg -n "ADMIN_ROOM_ARCHIVED|归档房间|保留不可删除" apps README.md KNOWN_LIMITATIONS.md packages/database/src`

Expected: 不再存在把房间删除描述为归档的运行时代码或用户文案；历史设计文档不在本检查范围。

Run: `rg -n "deleteMany\(\{\s*\}\)|TRUNCATE.*(LedgerEntry|AuditLog|SecurityLog|GameSettlement|SettlementPlayer)" apps packages/database/prisma/migrations/202608040021_room_trash_lifecycle`

Expected: 无裸 `deleteMany({})`，无放行 immutable 表 `TRUNCATE` 的代码。

- [ ] **Step 3: 运行静态检查、单元测试和构建。**

Run: `npm run lint`

Expected: exit 0，0 warnings。

Run: `npm run typecheck`

Expected: exit 0。

Run: `npm run test`

Expected: 所有 Vitest 与 Node 测试 PASS；数据库集成 suite 未配置时只能显示 skipped，不能失败。

Run: `npm run build`

Expected: API、Web 和 packages 全部构建成功。

- [ ] **Step 4: 使用独立测试数据库运行真实 PostgreSQL 集成测试。**

Run: `TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm exec vitest run -- packages/database/src/migration-v21.integration.test.ts apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/account-room-service.integration.test.ts`

Expected: PASS；若本机测试数据库端口不同，只允许调整 `TEST_DATABASE_URL`，数据库名仍必须以 `_test` 结尾且不得指向开发/生产库。

- [ ] **Step 5: 只通过 Docker 重建并启动系统。**

Run: `docker compose up -d --build`

Expected: `postgres` healthy，`api` 和 `web` running；Web 使用 `3000`，API 使用 `4000`。

Run: `docker compose ps`

Expected: 不存在额外测试端口或 npm 启动的 Web/API 进程。

- [ ] **Step 6: 在 Docker 外部栈运行全量 Playwright。**

Run: `PLAYWRIGHT_EXTERNAL_STACK=1 npm run test:e2e`

Expected: PASS；桌面和移动端垃圾桶 UI 均通过，浏览器连接 `http://localhost:3000`。

- [ ] **Step 7: 做最终 Git 范围检查并提交文档。**

Run: `git diff --check`

Expected: 无空白错误。

Run: `git status --short`

Expected: 只显示本任务文件和用户既有 `.superpowers/sdd/*` 修改；后者不暂存。

```bash
git add README.md KNOWN_LIMITATIONS.md
git commit -m "docs: document room trash deletion"
```

- [ ] **Step 8: 核对最终提交。**

Run: `git log --oneline --decorate -10`

Expected: Tasks 1-8 的提交按顺序存在；`git diff --cached --name-only` 为空，`.superpowers/sdd/*` 用户草稿仍保持未提交状态。
