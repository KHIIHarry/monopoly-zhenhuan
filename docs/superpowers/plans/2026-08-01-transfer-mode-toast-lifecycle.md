# Transfer Mode Toast Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transfer submission, approval, rejection, and failure Toasts follow the server-authoritative transfer mode, including mode changes made while a room is already playing.

**Architecture:** Keep the transfer transaction as the authority: `EXECUTED` produces an immediate local success Toast and `PENDING` produces a submitted Toast plus a Session-targeted bank event. Add persisted realtime delivery builders for request, approval, rejection, and server-observed failure phases; preserve the API error and committed response through the client action pipeline so a refresh failure cannot be mislabeled as a transfer failure.

**Tech Stack:** TypeScript, Zod, Prisma/PostgreSQL, Fastify, Socket.IO, React/Next.js, Vitest, Playwright, Docker Compose

## Global Constraints

- Approval-disabled success copy is exactly `转账已成功，结果已同步至账本`.
- Approval-enabled submission copy is exactly `转账已提交，请等待银行审批`.
- Approval success copy is exactly `银行审批通过，转账已成功，结果已同步至账本`.
- Explicit rejection copy is `转账申请已被银行拒绝：{reason}`.
- Failure Toasts use the existing red `REJECTED` tone and safe bounded Chinese reasons; never expose stack traces, SQL text, or raw internal exception messages.
- Player recipients receive only events related to their own Session; the active bank Session receives all committed fund movement plus transfer-request/failure events that the server can actually observe.
- A request that never reaches the server can only notify the initiating player.
- Success events run only after a fresh commit; idempotent replay must not emit them again.
- Notification delivery is best-effort and must not roll back committed funds, requests, or decisions.
- The current Toast queue remains passive, FIFO, deduplicated, and exactly `3_000ms`; do not change its approved responsive presentation.
- Runtime mode changes must be tested in one `PLAYING` room through `PATCH /api/admin/rooms/:id`, toggling false -> true -> false.
- Run the application only with Docker Compose, use port 3000, and set `PLAYWRIGHT_EXTERNAL_STACK=1` for browser tests.
- Preserve all unrelated dirty-worktree changes and stage only task-owned hunks.

---

## File Structure

- Modify `packages/shared/src/index.ts`: realtime lifecycle kinds and safe transfer reason mapping.
- Modify `packages/shared/src/rules.test.ts`: event schema and reason mapping contracts.
- Modify `apps/api/src/realtime-toast-notifications.ts`: persisted request/approval/failure builders and payer fund-Toast suppression.
- Modify `apps/api/src/realtime-toast-notifications.test.ts`: exact delivery, privacy, stable ID, and duplicate-payer tests.
- Modify `apps/api/src/api-error.ts`: mode-aware transfer rule error response.
- Modify `apps/api/src/api-error.test.ts`: error body/status coverage.
- Modify `apps/api/src/prisma-game-service.ts`: authoritative mode capture and post-commit/failure callbacks.
- Modify `apps/api/src/prisma-game-service.contract.test.ts`: transfer route preserves `EXECUTED/PENDING` response status.
- Modify `apps/api/src/prisma-game-service.integration.test.ts`: lifecycle, replay, failure, rejection, and runtime-toggle coverage.
- Modify `apps/api/src/app.ts`: Socket notifier builder wiring.
- Modify `apps/api/src/app-socket.test.ts`: Session-channel lifecycle event coverage.
- Create `apps/web/app/components/transfer-toast-feedback.ts`: pure result/error-to-Toast mapping.
- Create `apps/web/app/components/transfer-toast-feedback.test.ts`: exact copy, stable ID, and tone tests.
- Modify `apps/web/app/components/app-router-client.tsx`: rich action results, local lifecycle Toasts, and realtime tone mapping.
- Modify `apps/web/app/components/app-router-client.test.ts`: committed/uncommitted action and render wiring contracts.
- Modify `tests/e2e/fund-flow-toast.spec.ts`: player-UI submission, active-room mode toggle, approval/failure/rejection delivery, desktop/mobile assertions.

### Task 1: Shared Lifecycle Contract And Persisted Deliveries

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/rules.test.ts`
- Modify: `apps/api/src/realtime-toast-notifications.ts`
- Modify: `apps/api/src/realtime-toast-notifications.test.ts`

**Interfaces:**
- Produce: `RealtimeToastEvent.kind = 'FUNDS' | 'REQUEST_REJECTED' | 'TRANSFER_REQUESTED' | 'TRANSFER_APPROVED' | 'TRANSFER_FAILED'`.
- Produce: `transferFailureReason(code: string): string`.
- Produce: `TransferFailureNotice` with `phase: 'SUBMISSION' | 'APPROVAL'`.
- Produce: `buildTransferRequestedToastDelivery(database, requestId)`.
- Produce: `buildTransferApprovedToastDelivery(database, requestId)`.
- Produce: `buildTransferFailureToastDelivery(database, notice)`.
- Preserve: `buildFundToastDeliveries()` receiver/bank delivery while suppressing the payer's negative ledger Toast for lifecycle transfers.

- [ ] **Step 1: Write failing shared-contract tests**

Extend the shared tests with exact accepted kinds and safe reason cases:

```ts
expect(realtimeToastEventSchema.parse({
  eventId: 'request-1:requested:BANK',
  roomId: 'room-1',
  audience: 'BANK',
  kind: 'TRANSFER_REQUESTED',
  message: '收到张三的转账申请：向李四支付 500 两',
}).kind).toBe('TRANSFER_REQUESTED');

expect(transferFailureReason('INSUFFICIENT_BALANCE')).toBe('余额不足');
expect(transferFailureReason('INVALID_TRANSFER')).toBe('收款对象或金额无效');
expect(transferFailureReason('ROOM_NOT_PLAYING')).toBe('房间当前不在游戏中');
expect(transferFailureReason('PLAYER_STATE_CHANGED')).toBe('玩家状态已变化，请刷新后重试');
expect(transferFailureReason('REQUEST_ALREADY_RESOLVED')).toBe('转账申请已处理');
expect(transferFailureReason('untrusted raw database text')).toBe('服务暂时不可用，请稍后重试');
```

- [ ] **Step 2: Verify RED for the shared contract**

Run:

```bash
npm test -- packages/shared/src/rules.test.ts
```

Expected: FAIL because the three event kinds and `transferFailureReason` do not exist.

- [ ] **Step 3: Implement the bounded shared mapping**

Extend the Zod enum and export a fixed mapping; unknown values must return only the generic fallback:

```ts
const transferFailureReasons: Record<string, string> = {
  INSUFFICIENT_BALANCE: '余额不足',
  INVALID_AMOUNT: '收款对象或金额无效',
  INVALID_TRANSFER: '收款对象或金额无效',
  SAME_PLAYER_TRANSFER: '收款对象或金额无效',
  ROOM_NOT_PLAYING: '房间当前不在游戏中',
  PLAYER_STATE_CHANGED: '玩家状态已变化，请刷新后重试',
  PLAYER_NOT_FOUND: '玩家状态已变化，请刷新后重试',
  REQUEST_NOT_FOUND: '转账申请不存在',
  REQUEST_ALREADY_RESOLVED: '转账申请已处理',
  IDEMPOTENCY_KEY_REUSED: '提交内容已变化，请重新确认',
  TRANSACTION_RETRY_EXHAUSTED: '多人同时操作，请刷新后重试',
};

export function transferFailureReason(code: string) {
  return transferFailureReasons[code] ?? '服务暂时不可用，请稍后重试';
}
```

- [ ] **Step 4: Write failing delivery-builder tests**

Add builder fixtures for player and bank recipients and assert these exact outputs:

```ts
expect(await buildTransferRequestedToastDelivery(database, 'request-player')).toEqual({
  sessionId: 'bank-session',
  event: {
    eventId: 'request-player:requested:BANK',
    roomId: 'room-1',
    audience: 'BANK',
    kind: 'TRANSFER_REQUESTED',
    message: '收到张三的转账申请：向李四支付 500 两',
  },
});

expect(await buildTransferRequestedToastDelivery(database, 'request-bank')).toMatchObject({
  event: { message: '收到张三的转账申请：向银行支付 500 两' },
});

expect(await buildTransferApprovedToastDelivery(database, 'request-player')).toEqual({
  sessionId: 'payer-session',
  event: {
    eventId: 'request-player:approved:PLAYER:payer',
    roomId: 'room-1',
    audience: 'PLAYER',
    kind: 'TRANSFER_APPROVED',
    message: '银行审批通过，转账已成功，结果已同步至账本',
  },
});
```

Also assert:

```ts
await expect(buildTransferFailureToastDelivery(database, {
  phase: 'SUBMISSION', roomId: 'room-1', playerId: 'payer',
  attemptId: 'attempt-submit-1', reasonCode: 'INSUFFICIENT_BALANCE',
})).resolves.toMatchObject({
  sessionId: 'bank-session',
  event: {
    eventId: 'attempt-submit-1:submission-failed:BANK',
    audience: 'BANK',
    kind: 'TRANSFER_FAILED',
    message: '张三的转账申请提交失败：余额不足',
  },
});

await expect(buildTransferFailureToastDelivery(database, {
  phase: 'APPROVAL', roomId: 'room-1', requestId: 'request-player',
  attemptId: 'attempt-approve-1', reasonCode: 'INSUFFICIENT_BALANCE',
})).resolves.toMatchObject({
  sessionId: 'payer-session',
  event: {
    eventId: 'request-player:approval-failed:attempt-approve-1',
    audience: 'PLAYER',
    kind: 'TRANSFER_FAILED',
    message: '银行审批执行失败：余额不足',
  },
});
```

Cover missing/inactive Sessions, non-`PLAYER_TRANSFER` requests, non-`PENDING` approval failures, wire length, and unrelated members. Change the `PLAYER_TRANSFER` rejection expectation to `转账申请已被银行拒绝：金额有误`; retain existing wording for every other request type.

- [ ] **Step 5: Verify delivery tests fail**

Run:

```bash
npm test -- apps/api/src/realtime-toast-notifications.test.ts
```

Expected: FAIL on missing lifecycle builders, old transfer rejection copy, and payer ledger delivery.

- [ ] **Step 6: Implement persisted builders and suppress duplicate payer feedback**

Add this notifier-facing union:

```ts
export type TransferFailureNotice =
  | { phase: 'SUBMISSION'; roomId: string; playerId: string; attemptId: string; reasonCode: string }
  | { phase: 'APPROVAL'; roomId: string; requestId: string; attemptId: string; reasonCode: string };
```

The request builder queries `GameRequest` with actor/target display-name snapshots plus the active bank membership. The approval builder requires an executed `PLAYER_TRANSFER` and targets its actor's active Session. The failure builder queries persisted membership/request state and uses only `transferFailureReason()`.

`attemptId` is an opaque server-generated SHA-256 prefix derived from account/room/operation/idempotency data. It is stable for deduplication but must never contain the raw idempotency key, account ID, or request body on the wire.

In `buildFundToastDeliveries()`, identify a transfer created through the unified transfer route from `type` plus `metadata.recipientType`; skip only its payer's negative entry. Keep a receiving player's positive Toast and every bank Toast. Add tests for player-to-player, player-to-bank, and plot-fine variants so ordinary balance adjustments and bank payments are unchanged.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```bash
npm test -- packages/shared/src/rules.test.ts apps/api/src/realtime-toast-notifications.test.ts
git diff --check -- packages/shared/src/index.ts packages/shared/src/rules.test.ts apps/api/src/realtime-toast-notifications.ts apps/api/src/realtime-toast-notifications.test.ts
```

Expected: all focused tests pass and diff check exits 0.

Stage only Task 1 hunks and commit:

```bash
git commit -m "feat(api): define transfer Toast lifecycle deliveries"
```

### Task 2: Authoritative Service Lifecycle And Socket Wiring

**Files:**
- Modify: `apps/api/src/api-error.ts`
- Modify: `apps/api/src/api-error.test.ts`
- Modify: `apps/api/src/prisma-game-service.ts`
- Modify: `apps/api/src/prisma-game-service.contract.test.ts`
- Modify: `apps/api/src/prisma-game-service.integration.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app-socket.test.ts`

**Interfaces:**
- Produce: `TransferRuleError extends RuleError` with `transferApprovalRequired: boolean`.
- Extend: `PostCommitToastNotifier.transferRequested(roomId, requestId)`.
- Extend: `PostCommitToastNotifier.transferApproved(roomId, requestId)`.
- Extend: `PostCommitToastNotifier.transferFailed(notice)`.
- Consume: all Task 1 builders and `TransferFailureNotice`.

- [ ] **Step 1: Write failing API-error tests**

Add:

```ts
expect(mapApiError(new TransferRuleError('INSUFFICIENT_BALANCE', true))).toEqual({
  status: 409,
  body: { error: 'INSUFFICIENT_BALANCE', transferApprovalRequired: true },
  expose: true,
});

expect(mapApiError(new RuleError('INSUFFICIENT_BALANCE')).body).toEqual({
  error: 'INSUFFICIENT_BALANCE',
});
```

- [ ] **Step 2: Verify API-error RED and implement the narrow error type**

Run `npm test -- apps/api/src/api-error.test.ts` and expect missing export failure. Then add:

```ts
export class TransferRuleError extends RuleError {
  constructor(code: string, readonly transferApprovalRequired: boolean) {
    super(code);
    this.name = 'TransferRuleError';
  }
}
```

Handle it before the generic `RuleError` branch so only this error body includes `transferApprovalRequired`. Unknown failures continue mapping to HTTP 500 / `INTERNAL_ERROR` without internal text.

- [ ] **Step 3: Write failing service lifecycle tests**

Create a focused PostgreSQL test block named `transfer lifecycle Toasts` with a notifier spy implementing all callbacks. Assert:

```ts
expect(immediate).toMatchObject({ status: 'EXECUTED' });
expect(notifier.fundsCommitted).toHaveBeenCalledTimes(1);
expect(notifier.transferRequested).not.toHaveBeenCalled();

expect(pending).toMatchObject({ status: 'PENDING' });
expect(notifier.transferRequested).toHaveBeenCalledWith(room.id, pending.id);

await game.approve(bankActor, room.id, pending.id, 'approve-transfer');
expect(notifier.transferApproved).toHaveBeenCalledWith(room.id, pending.id);
expect(notifier.fundsCommitted).toHaveBeenCalledWith(room.id, expect.any(String));
```

Replay the same transfer and approval keys and assert the callback counts do not increase. Force insufficient funds during approval, assert the request remains `PENDING`, and assert:

```ts
expect(notifier.transferFailed).toHaveBeenCalledWith({
  phase: 'APPROVAL',
  roomId: room.id,
  requestId: pending.id,
  attemptId: expect.stringMatching(/^[a-f0-9]{24}$/),
  reasonCode: 'INSUFFICIENT_BALANCE',
});
```

For submission failure in approval mode, assert `TransferRuleError.transferApprovalRequired === true` and a bank failure callback. Repeat in immediate mode and assert the flag is false and no bank failure callback occurs.

- [ ] **Step 4: Add the same-room runtime mode-switch integration**

In one `PLAYING` room, call the real admin service/API path between transfers:

```ts
const first = await game.transfer(playerActor, room.id, transferInput, 'mode-off-1');
expect(first.status).toBe('EXECUTED');

await accounts.updateAdminRoom(adminAuth, room.id, { transferApprovalRequired: true }, 'mode-on');
const second = await game.transfer(playerActor, room.id, transferInput, 'mode-on-1');
expect(second.status).toBe('PENDING');

await accounts.updateAdminRoom(adminAuth, room.id, { transferApprovalRequired: false }, 'mode-off');
const third = await game.transfer(playerActor, room.id, transferInput, 'mode-off-2');
expect(third.status).toBe('EXECUTED');
```

Also assert the persisted room remains `PLAYING` throughout and that each result follows the setting read under the serialized room lock.

Extend `prisma-game-service.contract.test.ts` so the Fastify transfer route returns both stubbed results without rewriting status:

```ts
games.transfer.mockResolvedValueOnce({ id: 'tx-1', status: 'EXECUTED', stateVersion: 2 });
expect(await executedResponse.json()).toMatchObject({ status: 'EXECUTED' });

games.transfer.mockResolvedValueOnce({ id: 'request-1', status: 'PENDING', stateVersion: 3 });
expect(await pendingResponse.json()).toMatchObject({ status: 'PENDING' });
```

- [ ] **Step 5: Verify service RED**

Run:

```bash
npm test -- apps/api/src/prisma-game-service.contract.test.ts
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm run test:integration -- -t "transfer lifecycle Toasts|uses live transfer approval mode"
```

Expected: FAIL because the callbacks, mode-aware error, and runtime lifecycle assertions are not implemented.

- [ ] **Step 6: Implement authoritative mode capture and callbacks**

Inside `transfer()`, capture `room.transferApprovalRequired` only after the room row is locked and read in the serialized transaction. On a caught `RuleError`, rethrow `new TransferRuleError(error.code, observedMode)` when the mode was observed. If `observedMode === true`, best-effort call:

```ts
await this.toastNotifier?.transferFailed({
  phase: 'SUBMISSION',
  roomId,
  playerId: input.fromPlayerId,
  attemptId: hash(`${actor.accountId}:${roomId}:transfer:${key}`).slice(0, 24),
  reasonCode: error instanceof RuleError ? error.code : 'INTERNAL_ERROR',
});
```

Do not notify the bank when authorization/network handling fails before the server observes approval mode. In the fresh `afterCommit` callback, call `fundsCommitted` for `EXECUTED` or `transferRequested` for `PENDING`.

Wrap `approve()` so any failed attempt best-effort calls `transferFailed` with phase `APPROVAL`; the persisted builder itself must reject non-transfer or non-pending requests. On a fresh successful `PLAYER_TRANSFER` approval, call both `fundsCommitted(roomId, transactionId)` and `transferApproved(roomId, requestId)`.

The outer transfer/approval catch runs only after `executeIdempotent()` has exhausted/reconciled serializable retries, so no failure is emitted for an internal retry that later succeeds. Use opaque hashed attempt IDs for both phases. Run approval success callbacks independently with `Promise.allSettled()` (or equivalent per-callback guards), so a throwing custom `fundsCommitted` implementation cannot prevent `transferApproved`, and vice versa.

- [ ] **Step 7: Wire all Socket builders and write failing Socket assertions**

Extend `ToastBuilders`, `createPostCommitToastNotifier`, and its error context kinds. In `app-socket.test.ts`, inject deterministic builders and assert:

```ts
await notifier.transferRequested('room-a', 'request-1');
await notifier.transferApproved('room-a', 'request-1');
await notifier.transferFailed(submissionFailure);

expect(emitted).toContainEqual({
  channel: 'session:bank-session',
  name: 'room.toast',
  event: expect.objectContaining({ kind: 'TRANSFER_REQUESTED', audience: 'BANK' }),
});
expect(emitted).toContainEqual({
  channel: 'session:payer-session',
  name: 'room.toast',
  event: expect.objectContaining({ kind: 'TRANSFER_APPROVED', audience: 'PLAYER' }),
});
```

Assert a builder exception reaches `onError` and never rejects the already-committed service call.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
npm test -- apps/api/src/api-error.test.ts apps/api/src/app-socket.test.ts apps/api/src/prisma-game-service.contract.test.ts
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm run test:integration -- -t "transfer lifecycle Toasts|uses live transfer approval mode"
npm run typecheck
git diff --check -- apps/api/src/api-error.ts apps/api/src/api-error.test.ts apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.contract.test.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/app.ts apps/api/src/app-socket.test.ts
```

Stage only Task 2 hunks and commit:

```bash
git commit -m "feat(api): emit authoritative transfer lifecycle Toasts"
```

### Task 3: Client Result, Error, And Local Toast Feedback

**Files:**
- Create: `apps/web/app/components/transfer-toast-feedback.ts`
- Create: `apps/web/app/components/transfer-toast-feedback.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx`
- Modify: `apps/web/app/components/app-router-client.test.ts`

**Interfaces:**
- Produce: `TransferResult = { id: string; status: 'EXECUTED' | 'PENDING' }`.
- Produce: `transferSuccessToast(result, playerId): ToastInput`.
- Produce: `transferFailureToast(code, transferApprovalRequired): ToastInput`.
- Produce: `bankApprovalFailureToast(code, requestId): ToastInput`.
- Produce: `toastToneForRealtimeKind(kind): ToastTone`.
- Extend: action failures to retain `error` and distinguish `committed: true` from uncommitted failure.

- [ ] **Step 1: Write failing pure feedback tests**

Create tests with exact outputs:

```ts
expect(transferSuccessToast({ id: 'tx-1', status: 'EXECUTED' }, 'payer')).toEqual({
  id: 'tx-1:transfer-result:PLAYER:payer',
  message: '转账已成功，结果已同步至账本',
  tone: 'SUCCESS',
});

expect(transferSuccessToast({ id: 'request-1', status: 'PENDING' }, 'payer')).toEqual({
  id: 'request-1:submitted:PLAYER:payer',
  message: '转账已提交，请等待银行审批',
  tone: 'SUCCESS',
});

expect(transferFailureToast('INSUFFICIENT_BALANCE', false)).toMatchObject({
  message: '转账失败：余额不足', tone: 'REJECTED',
});
expect(transferFailureToast('INSUFFICIENT_BALANCE', true)).toMatchObject({
  message: '转账申请提交失败：余额不足', tone: 'REJECTED',
});
expect(transferFailureToast('INTERNAL_ERROR', undefined)).toMatchObject({
  message: '转账失败：服务暂时不可用，请稍后重试', tone: 'REJECTED',
});
expect(bankApprovalFailureToast('INSUFFICIENT_BALANCE', 'request-1')).toMatchObject({
  message: '银行审批执行失败：余额不足', tone: 'REJECTED',
});
expect(toastToneForRealtimeKind('TRANSFER_FAILED')).toBe('REJECTED');
expect(toastToneForRealtimeKind('REQUEST_REJECTED')).toBe('REJECTED');
expect(toastToneForRealtimeKind('TRANSFER_APPROVED')).toBe('SUCCESS');
```

- [ ] **Step 2: Verify helper RED and implement the pure mapping**

Run `npm test -- apps/web/app/components/transfer-toast-feedback.test.ts`; expect missing-module failure. Implement the exports using `transferFailureReason()` and stable IDs. No React state or network access belongs in this file.

- [ ] **Step 3: Write failing action-result tests**

Extend the client contract tests to require these unions:

```ts
type RunResult<T> = { ok: true; value: T } | { ok: false; error?: unknown };
type RoomActionResult<T, B extends WriteBody> =
  | { ok: true; value: T; body: B; committed: true }
  | { ok: false; committed: true; value: T; body: B }
  | { ok: false; committed: false; error?: unknown };
```

Assert `run()` returns the caught error after `handleFailure()`. Assert `gameAction()` returns `committed: false` for a failed API write, but returns the authoritative `value/body` with `committed: true` when the API call succeeded and ownership/snapshot refresh then failed. The latter path must call `confirm()` so the completed mutation is not retried as an unknown write.

- [ ] **Step 4: Verify action-result RED**

Run:

```bash
npm test -- apps/web/app/components/app-router-client.test.ts
```

Expected: FAIL because failures lose their error and committed response.

- [ ] **Step 5: Implement rich results without changing other action behavior**

Propagate `error` from `run()` through `useStableWrite()`. In `gameAction()`, treat a returned API response as committed before refreshing. Existing callers that only read `.ok` continue behaving as before; transfer and approval handlers inspect `committed` and `error`.

Add a root `showToast(toast: ToastInput)` callback next to `showNotice()` and pass it through `Workbench` to `PlayerView` and `BankView`. Keep all existing one-argument `showNotice()` callers unchanged.

- [ ] **Step 6: Replace the hard-coded transfer message**

Call `action<TransferResult, typeof body>()` directly from `submitTransfer()`. For both `{ ok: true }` and `{ committed: true }`, clear the form/panel and enqueue `transferSuccessToast(result.value, playerId)`. For an uncommitted failure, derive the code and optional authoritative flag from `ApiError`:

```ts
const details = result.error instanceof ApiError
  ? result.error.data as { error?: string; transferApprovalRequired?: boolean }
  : {};
showToast(transferFailureToast(
  details.error ?? (result.error instanceof ApiError ? result.error.code : 'INTERNAL_ERROR'),
  details.transferApprovalRequired,
));
```

Retain the existing inline error set by `handleFailure()`. Delete the historical `转帐已提交，结果已同步至账本或审批队列` message.

- [ ] **Step 7: Add bank approval failure feedback and realtime tone mapping**

When `approveTarget.type === 'PLAYER_TRANSFER'`, use the full action result. A committed approval keeps the existing local bank success notice; an uncommitted failure enqueues `bankApprovalFailureToast(code, approveTarget.id)` and leaves the request/panel available for retry. Other approval types retain current behavior.

Replace both direct and buffered checks:

```ts
tone: toastToneForRealtimeKind(parsed.data.kind)
```

This maps `TRANSFER_FAILED` and `REQUEST_REJECTED` to red and every success lifecycle/fund event to green.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
npm test -- apps/web/app/components/transfer-toast-feedback.test.ts apps/web/app/components/app-router-client.test.ts apps/web/app/components/toast-queue.test.ts
npm run typecheck
git diff --check -- apps/web/app/components/transfer-toast-feedback.ts apps/web/app/components/transfer-toast-feedback.test.ts apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts
```

Stage only Task 3 hunks and commit:

```bash
git commit -m "fix(web): report authoritative transfer outcomes"
```

### Task 4: Real-Stack Mode Switching And Audience Coverage

**Files:**
- Modify: `tests/e2e/fund-flow-toast.spec.ts`

**Interfaces:**
- Consumes: all Tasks 1-3 server/client lifecycle contracts.
- Produces: desktop Chromium and iPhone WebKit evidence using one active room and player-facing UI actions.

- [ ] **Step 1: Replace separate-mode setup with one active-room toggle flow**

Keep one `PLAYING` room initially configured with `transferApprovalRequired: false`. Add an admin-authenticated context using the configured bootstrap/super-admin account, and toggle with:

```ts
await adminContext.request.patch(`${apiUrl}/api/admin/rooms/${room.id}`, {
  data: { transferApprovalRequired: true },
  headers: { 'idempotency-key': `mode-on-${runId}` },
});
```

Assert the PATCH response is OK, then toggle back to false later with a new key. Do not mutate Prisma directly for this scenario.

- [ ] **Step 2: Submit transfers through the player UI**

Add a helper that opens `转帐`, chooses the named recipient or bank option, fills `转帐金额`, and clicks `确认转帐`. Use accessible labels/roles already rendered by the transfer panel; do not call `/transfers` directly for success-copy assertions.

Verify this sequence in the same room:

```text
mode false -> player: 转账已成功，结果已同步至账本
mode false -> receiver/bank: existing committed fund-flow Toasts
mode true  -> player: 转账已提交，请等待银行审批
mode true  -> bank: 收到张三的转账申请：向李四支付 300 两
approval   -> player: 银行审批通过，转账已成功，结果已同步至账本
approval   -> receiver/bank: existing committed fund-flow Toasts
rejection  -> player red: 转账申请已被银行拒绝：金额有误
mode false -> next player transfer immediately shows the immediate-success copy again
```

Repeat the pending-request bank copy with recipient `银行` and assert `收到张三的转账申请：向银行支付 120 两`.

- [ ] **Step 3: Cover player and bank failure Toasts**

Create deterministic failure attempts. In immediate mode submit more than the payer balance and assert only the player receives red `转账失败：余额不足`. In approval mode, after the player page has loaded, use the test database only as a controlled fault injector to mark the payer non-playable; submit through the still-open player UI and assert player red `转账申请提交失败：玩家状态已变化，请刷新后重试` plus bank red `张三的转账申请提交失败：玩家状态已变化，请刷新后重试`. Restore the player state before subsequent scenarios. The false -> true -> false mode switch itself must still use only the admin PATCH API.

For approval execution failure, submit a valid pending transfer, reduce the payer balance before approval, click the bank approval control, and assert bank plus payer receive red `银行审批执行失败：余额不足`; query the API/database to confirm the request remains `PENDING`.

- [ ] **Step 4: Retain privacy, queue, and presentation assertions**

For each realtime event, assert unrelated players see no Toast. Retain current checks for `3_000ms` FIFO, pointer-passive responsive presentation, desktop top-right/mobile top-center positioning, `8px` radius, green/red variants, no wrapping for representative messages, and screenshots.

- [ ] **Step 5: Start/reuse Docker correctly and verify E2E GREEN**

Before startup, inspect stale project Node/Next processes and port 3000. Reuse an existing healthy Docker stack where possible; otherwise run:

```bash
docker compose up -d
```

Then run:

```bash
FUND_TOAST_REAL_STACK=1 PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/fund-flow-toast.spec.ts --project=desktop-chromium --project=iphone-webkit
```

Expected: both projects pass with the same-room false -> true -> false lifecycle and exact audience assertions.

- [ ] **Step 6: Commit the E2E coverage**

Run `git diff --check -- tests/e2e/fund-flow-toast.spec.ts`, stage only that file's task-owned hunks, and commit:

```bash
git commit -m "test(e2e): cover live transfer mode Toasts"
```

### Task 5: Whole-Feature Verification And Independent Review

**Files:**
- Verify every file changed in Tasks 1-4.

**Interfaces:**
- Consumes the complete transfer lifecycle.
- Produces verification evidence and review findings only; no new production interface.

- [ ] **Step 1: Run all unit and focused integration tests**

```bash
npm test
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:5432/zhenhuan_test?schema=public' npm run test:integration -- -t "transfer lifecycle Toasts|uses live transfer approval mode"
node --test tests/style-device-spacing.test.mjs
```

Expected: zero task-related failures. If unrelated dirty-worktree tests fail, record the exact pre-existing failure and still run every focused task test to completion.

- [ ] **Step 2: Run real-stack desktop/mobile verification**

```bash
FUND_TOAST_REAL_STACK=1 PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/fund-flow-toast.spec.ts --project=desktop-chromium --project=iphone-webkit
```

Expected: both projects pass on Docker port 3000.

- [ ] **Step 3: Run static/build checks**

```bash
npm run lint
npm run typecheck
npm run build
git diff --check
```

If `npm run build` rewrites `apps/web/next-env.d.ts`, restore only that generated path change without touching user edits elsewhere.

- [ ] **Step 4: Dispatch independent review**

Have a fresh reviewer inspect exact copy, server-authoritative mode selection, false -> true -> false runtime switching, Session privacy, bank/player audience matrix, idempotent replay, post-commit ordering, unknown-error sanitization, committed-refresh failure behavior, duplicate payer suppression, and dirty-file boundaries. Fix and re-review every Critical or Important finding before declaring completion.

- [ ] **Step 5: Final scope audit**

Confirm the diff adds no Modal, durable outbox, acknowledgement protocol, queue-duration change, accounting change, raw-error exposure, or bank notification for an unobserved network request. Confirm all task commits stage only owned hunks.
