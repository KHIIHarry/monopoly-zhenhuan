# Room Configuration Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep room management available throughout a game while locking only rule-defining fields after start and removing the misleading automatic-skip setting.

**Architecture:** Remove `autoSkipTurn` from the persistent/API/UI contract; electronic turn advancement remains the sole automatic skip implementation. The admin route and management form share an explicit lobby-only field set, while runtime switches are evaluated only when a new join or transfer is created.

**Tech Stack:** Next.js/React, Fastify, Prisma/PostgreSQL, Vitest, Playwright

## Global Constraints

- A non-lobby room rejects `diceMode`, `initialBalance`, `startReward`, and `skillEnabled` with `ROOM_CONFIG_LIFECYCLE_CONFLICT`.
- Name, visibility, password, `allowMidgameJoin`, and `transferApprovalRequired` remain editable until terminal state.
- Disabled-rule copy is `开局后锁定`; start-race copy is `房间已开始，部分规则已锁定`.
- Runtime switches affect future operations only. Electronic dice continues to consume skips; physical dice does not advance turns.
- Do not include unrelated dirty files in commits.

---

## File Structure

- `packages/database/prisma/schema.prisma`: removes `Room.autoSkipTurn`.
- `packages/database/prisma/migrations/202607290015_remove_auto_skip_turn/migration.sql`: drops the column.
- `apps/api/src/account-room-service.ts` and `apps/api/src/app.ts`: boundary contract and lifecycle guard.
- `apps/api/src/*integration.test.ts`: lifecycle and future-operation tests.
- `apps/web/app/components/app-router-client.tsx`, `apps/web/app/globals.css`, and `tests/e2e/task7-management.spec.ts`: administrator UI and browser proof.

### Task 1: Remove The Automatic-Skip Configuration Contract

**Files:**
- Modify: `packages/database/prisma/schema.prisma:150-185`
- Create: `packages/database/prisma/migrations/202607290015_remove_auto_skip_turn/migration.sql`
- Modify: `apps/api/src/account-room-service.ts:156-185,960-1018,1177-1189`
- Modify: `apps/api/src/app.ts:235-270`
- Modify: `apps/web/app/components/app-router-client.tsx:444,1103-1108`
- Test: `apps/api/src/account-room-service.integration.test.ts:180-240`

**Interfaces:**
- Produces: `Room`, room creation, update, and detail contracts have no `autoSkipTurn`.
- Preserves: `PrismaGameService.createNextActionableTurn()` consumes electronic skipped turns; `consumeSkip()` stays physical-only.

- [ ] **Step 1: Write the failing contract test**

Remove `autoSkipTurn` from the room creation test input, then assert:

```ts
expect(Object.keys(created).sort()).not.toContain('autoSkipTurn');
expect(JSON.stringify(created)).not.toContain('autoSkipTurn');
```

- [ ] **Step 2: Run red**

Run: `npm test -- apps/api/src/account-room-service.integration.test.ts`

Expected: FAIL because the current typed input and response require or return `autoSkipTurn`.

- [ ] **Step 3: Implement the minimal contract removal**

Delete the Prisma property and add:

```sql
ALTER TABLE "Room" DROP COLUMN "autoSkipTurn";
```

Remove `autoSkipTurn` from `roomCreationSummary`, admin detail output, `updateAdminRoom` and `createRoom` input/data, both Zod schemas, all room drafts, admin-detail types, review text, toggle unions, save payloads, and test fixtures. Retain `createNextActionableTurn` and `consumeSkip` unchanged.

- [ ] **Step 4: Regenerate and verify green**

Run: `npm run db:generate && npm test -- apps/api/src/account-room-service.integration.test.ts`

Expected: client generation and focused test exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/202607290015_remove_auto_skip_turn/migration.sql apps/api/src/account-room-service.ts apps/api/src/app.ts apps/web/app/components/app-router-client.tsx apps/api/src/account-room-service.integration.test.ts
git commit -m "refactor: remove automatic skip room setting"
```

### Task 2: Enforce The Field Lifecycle On The Admin API

**Files:**
- Modify: `apps/api/src/account-room-service.ts:991-1036`
- Test: `apps/api/src/admin-account-room-service.integration.test.ts:663-691`

**Interfaces:**
- Consumes: `updateAdminRoom(auth, roomId, input, key)`.
- Produces: running rooms accept runtime fields and reject only the four lobby-only fields.

- [ ] **Step 1: Write the failing lifecycle test**

After creating a PLAYING room, send a runtime update and four independent locked updates:

```ts
const runtime = await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${playing.id}`, headers: { cookie: cookie.header, 'idempotency-key': 'playing-runtime' }, payload: { allowMidgameJoin: true, transferApprovalRequired: true, visibility: 'PRIVATE', name: 'Running room' } });
expect(runtime.statusCode).toBe(200);
for (const [field, value] of [['diceMode', 'PHYSICAL'], ['initialBalance', 7_000], ['startReward', 2_000], ['skillEnabled', false]] as const) {
  const response = await app.inject({ method: 'PATCH', url: `/api/admin/rooms/${playing.id}`, headers: { cookie: cookie.header, 'idempotency-key': `locked-${field}` }, payload: { [field]: value } });
  expect(response.json()).toEqual({ error: 'ROOM_CONFIG_LIFECYCLE_CONFLICT' });
}
```

- [ ] **Step 2: Run red**

Run: `npm test -- apps/api/src/admin-account-room-service.integration.test.ts`

Expected: FAIL because the old array locks both runtime switches.

- [ ] **Step 3: Implement the narrowed lock set**

Use:

```ts
const lobbyOnly = ['diceMode', 'skillEnabled', 'startReward', 'initialBalance'];
if (room.status !== 'LOBBY' && keys.some((field) => lobbyOnly.includes(field))) {
  fail('ROOM_CONFIG_LIFECYCLE_CONFLICT');
}
```

Keep the terminal-state guard and initial-balance ledger guard.

- [ ] **Step 4: Run green and commit**

Run: `npm test -- apps/api/src/admin-account-room-service.integration.test.ts`

Expected: exit 0.

```bash
git add apps/api/src/account-room-service.ts apps/api/src/admin-account-room-service.integration.test.ts
git commit -m "feat: allow runtime room configuration updates"
```

### Task 3: Prove Runtime Switches Affect Only New Operations

**Files:**
- Test: `apps/api/src/account-room-service.integration.test.ts:946-980`
- Test: `apps/api/src/prisma-game-service.integration.test.ts:1110-1158`

**Interfaces:**
- Consumes: `joinRoom`, seat acquisition, and `PrismaGameService.transfer`.
- Produces: regression proof that settings are evaluated at creation time rather than retrospectively.

- [ ] **Step 1: Write the failing future-join test**

Create a PLAYING room with joining off, verify a new account gets `MIDGAME_JOIN_DISABLED`, set the database flag true, join another new account, reset it false, and verify that member remains active:

```ts
await expect(service.joinRoom(blocked.auth, room.id, undefined, 'before-enable')).rejects.toThrow('MIDGAME_JOIN_DISABLED');
await db.room.update({ where: { id: room.id }, data: { allowMidgameJoin: true } });
await expect(service.joinRoom(admitted.auth, room.id, undefined, 'after-enable')).resolves.toMatchObject({ status: 'ACTIVE' });
await db.room.update({ where: { id: room.id }, data: { allowMidgameJoin: false } });
expect(await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: admitted.auth.account.id } } })).toMatchObject({ status: 'ACTIVE' });
```

- [ ] **Step 2: Run red**

Run: `npm test -- apps/api/src/account-room-service.integration.test.ts`

Expected: FAIL until the scenario is added with valid running-room fixtures.

- [ ] **Step 3: Write the failing future-transfer test**

Submit a transfer while approval is enabled, turn it off, then submit a new transfer:

```ts
expect(firstRequest.status).toBe('PENDING');
await db.room.update({ where: { id: room.id }, data: { transferApprovalRequired: false } });
const secondTransfer = await first.transfer(room.id, input, 'approval-disabled-after-pending');
expect(secondTransfer.status).toBe('EXECUTED');
expect((await db.gameRequest.findUniqueOrThrow({ where: { id: firstRequest.id } })).status).toBe('PENDING');
```

- [ ] **Step 4: Verify the service boundary**

Run: `npm test -- apps/api/src/account-room-service.integration.test.ts apps/api/src/prisma-game-service.integration.test.ts`

Expected: exit 0. No production change is expected: admission and transfer already read the current setting when each operation is created and do not update existing records.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/account-room-service.integration.test.ts apps/api/src/prisma-game-service.integration.test.ts
git commit -m "test: cover future runtime room settings"
```

### Task 4: Render And Refresh Lifecycle-Aware Management Controls

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:444,1146-1210,1262`
- Modify: `apps/web/app/globals.css`
- Test: `tests/e2e/task7-management.spec.ts:180-245`

**Interfaces:**
- Consumes: `AdminRoomDetail.status` and `configuration`.
- Produces: native disabled controls, dirty-only saving, and start-race refresh notification.

- [ ] **Step 1: Write the failing browser test**

Use a PLAYING room detail fixture without `autoSkipTurn` and assert:

```ts
await expect(page.getByLabel('骰子')).toBeDisabled();
await expect(page.getByLabel('初始资金')).toBeDisabled();
await expect(page.getByLabel('起点奖励')).toBeDisabled();
await expect(page.getByRole('switch', { name: '人物技能' })).toBeDisabled();
await expect(page.getByText('开局后锁定')).toHaveCount(4);
await expect(page.getByRole('switch', { name: '中途加入' })).toBeEnabled();
await expect(page.getByRole('switch', { name: '转帐审批' })).toBeEnabled();
await expect(page.getByRole('button', { name: '保存房间配置' })).toBeDisabled();
```

Toggle `中途加入`, save, and assert its PATCH body is exactly `{ allowMidgameJoin: true }`. In a second scenario, return a LOBBY detail first and a PLAYING detail on the save reload; assert `房间已开始，部分规则已锁定` and disabled locked controls.

- [ ] **Step 2: Run red**

Run: `npm run test:e2e -- tests/e2e/task7-management.spec.ts`

Expected: FAIL because fields are interactive, auto-skip remains rendered, and no-change save is enabled.

- [ ] **Step 3: Implement a local lifecycle view model**

Use this explicit state and filter before saving:

```ts
const roomRulesLocked = selectedRoom?.status !== 'LOBBY';
const lockedKeys = new Set(['diceMode', 'initialBalance', 'startReward', 'skillEnabled']);
const submitChanges = Object.fromEntries(Object.entries(roomChanges).filter(([key]) => !roomRulesLocked || !lockedKeys.has(key)));
```

Add native `disabled={roomRulesLocked}` to the four lobby-only inputs, render `<small className="field-lock-note">开局后锁定</small>` beside each, and remove the automatic-skip switch. Keep `allowMidgameJoin` and `transferApprovalRequired` active. Disable save for saving/busy state or an empty `submitChanges`.

Make `refreshRoom` compare the previous status with the returned detail. On LOBBY to non-LOBBY, replace the draft from the response and set a `role="status"` message to `房间已开始，部分规则已锁定`. Add scoped muted disabled-control and lock-note CSS.

- [ ] **Step 4: Run green and full verification**

Run: `npm run test:e2e -- tests/e2e/task7-management.spec.ts && npm run db:generate && npm run typecheck && npm test`

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/globals.css tests/e2e/task7-management.spec.ts
git commit -m "feat: clarify room configuration lifecycle"
```
