# 管理端物理删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让超级管理员能安全地物理删除目标房间或符合隔离条件的目标账号。

**Architecture:** `AccountRoomService` 负责 Serializable 事务、幂等记录和关联删除；`app.ts` 仅负责路由、会话断开和房间失效通知。后台页面复用既有 `ConfirmDialog`，通过精确名称确认将危险 DELETE 请求限制在明确目标上。

**Tech Stack:** TypeScript、Fastify、Prisma/PostgreSQL、React/Next.js、Vitest、Playwright。

## Global Constraints

- 仅超级管理员可删除；无 `Idempotency-Key` 必须保持既有 `IDEMPOTENCY_KEY_REQUIRED` 行为。
- 所有删除必须在一个 Serializable 事务中，且所有 `deleteMany` 必须带精确 `roomId` 或 `accountId` 条件。
- 删除房间只清除该 `roomId` 的专属数据；共享账号、Character 与 PropertyDefinition 永不删除。
- 删除账号不得影响保留房间；自身与任意超级管理员不可删除。
- UI 使用现有 `danger-button`、`ConfirmDialog` 和错误显示，不引入新的视觉体系或依赖。
- 当前目录不包含 `.git`；每个任务的提交在恢复仓库元数据后执行。

---

### Task 1: 定义删除路由契约并建立失败测试

**Files:**
- Modify: `apps/api/src/server-room-routes.test.ts`
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/account-room-service.ts`

**Interfaces:**
- Produces: `deleteAccount(auth, id, key): Promise<{ deleted: true; id: string; revokedSessionIds: string[] }>`。
- Produces: `deleteRoom(auth, id, key): Promise<{ deleted: true; id: string; stateVersion: number }>`。
- Consumes: `idempotencyKey`, `revokeSocketSession`, `notifyVersion` 的现有约定。

- [ ] **Step 1: 在路由单元测试中增加服务桩和 DELETE 断言。**

```ts
deleteAccount: vi.fn(async (_auth: AuthenticatedSession, id: string, key: string) => ({
  deleted: true, id, revokedSessionIds: ['target-session'],
})),
deleteRoom: vi.fn(async (_auth: AuthenticatedSession, id: string, key: string) => ({
  deleted: true, id, stateVersion: 13,
})),

const deletedAccount = await app.inject({
  method: 'DELETE', url: '/api/admin/accounts/account-target',
  headers: { ...headers, 'idempotency-key': 'delete-account-key' },
});
const deletedRoom = await app.inject({
  method: 'DELETE', url: '/api/admin/rooms/room-1',
  headers: { ...headers, 'idempotency-key': 'delete-room-key' },
});
expect(accounts.deleteAccount).toHaveBeenCalledWith(auth, 'account-target', 'delete-account-key');
expect(accounts.deleteRoom).toHaveBeenCalledWith(auth, 'room-1', 'delete-room-key');
expect(notifications).toContainEqual({ roomId: 'session:target-session', event: 'account.session.revoked', payload: {} });
expect(notifications).toContainEqual({ roomId: 'room-1', event: 'room.updated', payload: { stateVersion: 13 } });
```

- [ ] **Step 2: 运行路由测试，确认因服务方法和路由不存在而失败。**

Run: `npm test --workspace=@zhenhuan/api -- server-room-routes.test.ts`

Expected: FAIL，错误指向未调用或未定义的 `deleteAccount` / `deleteRoom`。

- [ ] **Step 3: 增加最小路由实现。**

```ts
app.delete('/api/admin/accounts/:id', async (request) => {
  const auth = await authenticate(request);
  const { id } = z.object({ id: z.string() }).parse(request.params);
  const result = await accounts.deleteAccount(auth, id, idempotencyKey(request.headers['idempotency-key']));
  for (const sessionId of result.revokedSessionIds) revokeSocketSession(sessionId, 'ACCOUNT_DELETED');
  return { deleted: true, id: result.id };
});
app.delete('/api/admin/rooms/:id', async (request) => {
  const auth = await authenticate(request);
  const { id } = z.object({ id: z.string() }).parse(request.params);
  const result = await accounts.deleteRoom(auth, id, idempotencyKey(request.headers['idempotency-key']));
  notifyVersion(id, result);
  return { deleted: true, id: result.id };
});
```

- [ ] **Step 4: 重跑路由测试，确认新路由通过且现有路由仍通过。**

Run: `npm test --workspace=@zhenhuan/api -- server-room-routes.test.ts`

Expected: PASS。

- [ ] **Step 5: 在 Git 元数据可用后提交。**

```bash
git add apps/api/src/app.ts apps/api/src/server-room-routes.test.ts
git commit -m "test: define admin deletion routes"
```

### Task 2: 以事务实现隔离的账号和房间物理删除

**Files:**
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `deleteAccount` 与 `deleteRoom` 路由调用。
- Produces: 成功响应与 `ACCOUNT_DELETE_BLOCKED`、`CANNOT_DELETE_CURRENT_ACCOUNT`、`CANNOT_DELETE_SUPER_ADMIN` 规则错误。

- [ ] **Step 1: 写入隔离、回滚、权限和幂等的集成测试。**

```ts
const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/rooms/${targetRoom.id}`, headers: { cookie: adminCookie.header, 'idempotency-key': 'delete-room' } });
expect(deleted.statusCode).toBe(200);
expect(await db.room.findUnique({ where: { id: targetRoom.id } })).toBeNull();
expect(await db.room.findUnique({ where: { id: unrelatedRoom.id } })).not.toBeNull();
expect(await db.account.findUnique({ where: { id: creator.account.id } })).not.toBeNull();

const blocked = await app.inject({ method: 'DELETE', url: `/api/admin/accounts/${sharedMember.account.id}`, headers: { cookie: adminCookie.header, 'idempotency-key': 'delete-shared' } });
expect(blocked.json()).toEqual({ error: 'ACCOUNT_DELETE_BLOCKED' });
expect(await db.account.findUnique({ where: { id: sharedMember.account.id } })).not.toBeNull();
```

另加用例断言：删除无引用普通账号后其 `Account` 与 `AccountSession` 均不存在；当前管理员和另一个超级管理员分别返回对应错误；同 key 同 payload 返回相同结果且不会影响无关记录。

- [ ] **Step 2: 运行集成测试，确认新 DELETE 接口尚未实现而失败。**

Run: `npm test --workspace=@zhenhuan/api -- admin-account-room-service.integration.test.ts`

Expected: FAIL，DELETE 返回 404 或断言 `deleted` 失败。

- [ ] **Step 3: 在 `AccountRoomService` 中实现最小事务删除。**

```ts
async deleteAccount(auth: AuthenticatedSession, id: string, key: string) {
  const result = await this.executeAdminWrite({
    auth, operation: 'account:delete', resourceId: id, key, input: { id },
    lock: (tx) => this.lockAccount(tx, id),
    authorize: async (tx) => {
      const target = required(await tx.account.findUnique({ where: { id } }), 'ACCOUNT_NOT_FOUND');
      if (id === auth.account.id) fail('CANNOT_DELETE_CURRENT_ACCOUNT');
      if (target.isSuperAdmin) fail('CANNOT_DELETE_SUPER_ADMIN');
      const referenced = await tx.roomMembership.count({ where: { accountId: id } });
      if (referenced) fail('ACCOUNT_DELETE_BLOCKED');
    },
    mutate: async (tx) => {
      const sessions = await tx.accountSession.findMany({ where: { accountId: id }, select: { id: true } });
      await tx.account.delete({ where: { id } });
      return { value: { deleted: true as const, id, revokedSessionIds: sessions.map(({ id: sessionId }) => sessionId) } };
    },
  });
  return result.value;
}
```

`deleteRoom` 采用相同 `executeAdminWrite` 包装并锁定房间。先删除依赖于 RoomMember、Player、GameRequest、Turn、LandingEvent、RoomProperty、GameSettlement 及 `IdempotencyRecord` 的行，再删除 `Room`；每个调用使用 `{ roomId }` 过滤。删除前读取 `stateVersion` 并在返回值中保留它，供路由在提交后通知。

- [ ] **Step 4: 运行集成测试和 API 类型检查。**

Run: `npm test --workspace=@zhenhuan/api -- admin-account-room-service.integration.test.ts && npm run typecheck --workspace=@zhenhuan/api`

Expected: PASS。

- [ ] **Step 5: 在 Git 元数据可用后提交。**

```bash
git add apps/api/src/account-room-service.ts apps/api/src/admin-account-room-service.integration.test.ts
git commit -m "feat: add isolated admin physical deletion"
```

### Task 3: 将名称确认删除操作接入后台页面

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `tests/e2e/task7-management.spec.ts`

**Interfaces:**
- Consumes: Task 1 的两个 DELETE 路由。
- Produces: 账号和房间详情中的 `删除账号`、`删除房间` 确认流程。

- [ ] **Step 1: 写入 Playwright 失败测试。**

```ts
await page.getByRole('button', { name: '删除账号' }).click();
await expect(page.getByRole('button', { name: '确认删除' })).toBeDisabled();
await page.getByLabel('确认删除账号').fill('meizhuang');
await page.getByRole('button', { name: '确认删除' }).click();
await expect.poll(() => writes.some(({ method, path }) => method === 'DELETE' && path === '/api/admin/accounts/account-active')).toBe(true);

await page.getByRole('button', { name: '删除房间' }).click();
await page.getByLabel('确认删除房间').fill('碎玉轩新夜局');
await page.getByRole('button', { name: '确认删除' }).click();
await expect.poll(() => writes.some(({ method, path }) => method === 'DELETE' && path === '/api/admin/rooms/room-1')).toBe(true);
```

- [ ] **Step 2: 运行测试，确认按钮与确认输入尚不存在而失败。**

Run: `npm run test:e2e --workspace=@zhenhuan/web -- tests/e2e/task7-management.spec.ts`

Expected: FAIL，找不到 `删除账号` 或 `删除房间`。

- [ ] **Step 3: 扩展 `AdminView` 的确认状态并渲染操作。**

```tsx
const [confirm, setConfirm] = useState<{ title: string; copy: string; expectedName?: string; fieldLabel?: string; run: () => Promise<void> } | null>(null);
const [confirmName, setConfirmName] = useState('');

<button className="danger-button" onClick={() => {
  setConfirmName('');
  setConfirm({ title: '删除账号', fieldLabel: '确认删除账号', expectedName: selectedAccount.username,
    copy: `${selectedAccount.displayName} 的可删除数据将被永久清除，且无法恢复。`,
    run: async () => { await mutateAndReload(`/api/admin/accounts/${selectedAccount.id}`, {}, 'DELETE'); setSelectedAccount(null); },
  });
}}>删除账号</button>
```

对房间使用同样模式，但 `expectedName: selectedRoom.name`、`fieldLabel: '确认删除房间'` 和 `/api/admin/rooms/${selectedRoom.id}`。在 `ConfirmDialog` 内渲染带该 label 的 input；`confirmLabel` 为 `确认删除`，且当名称不相等时禁用。确认成功后清空输入、关闭对应详情；错误时不关闭详情。

- [ ] **Step 4: 重跑管理端 E2E 测试。**

Run: `npm run test:e2e --workspace=@zhenhuan/web -- tests/e2e/task7-management.spec.ts`

Expected: PASS。

- [ ] **Step 5: 在 Git 元数据可用后提交。**

```bash
git add apps/web/app/page.tsx tests/e2e/task7-management.spec.ts
git commit -m "feat: add confirmed admin deletion controls"
```

### Task 4: 完整验证

**Files:**
- Verify only: `apps/api/src/account-room-service.ts`
- Verify only: `apps/api/src/app.ts`
- Verify only: `apps/web/app/page.tsx`

- [ ] **Step 1: 运行全量相关测试。**

Run: `npm test --workspace=@zhenhuan/api && npm run test:e2e --workspace=@zhenhuan/web -- tests/e2e/task7-management.spec.ts`

Expected: PASS，没有失败用例。

- [ ] **Step 2: 运行构建与静态检查。**

Run: `npm run lint && npm run typecheck`

Expected: 两个命令退出码均为 0。

- [ ] **Step 3: 检查删除范围。**

Run: `rg -n "delete(Many)?\(" apps/api/src/account-room-service.ts`

Expected: 新增的每个批量删除调用带有精确 `roomId` 或 `accountId` 条件；不存在裸 `deleteMany()`。

- [ ] **Step 4: 在 Git 元数据可用后提交最终状态。**

```bash
git add apps/api/src apps/web/app/page.tsx tests/e2e/task7-management.spec.ts
git commit -m "test: verify admin physical deletion"
```
