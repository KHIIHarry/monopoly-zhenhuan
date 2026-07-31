# Fund Flow Toast Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push every committed balance change and every bank rejection to the correct online player and bank views through a non-blocking three-second Toast queue.

**Architecture:** The database ledger remains authoritative. Fresh committed mutations invoke a post-commit callback with a transaction or request ID; a dedicated API notification builder reloads persisted data, creates audience-specific messages, and emits only to authorized active Session channels. The web client validates the event envelope, filters by the current workbench role, deduplicates stable IDs, and feeds both realtime and local success messages into one FIFO queue.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Fastify, Socket.IO, Next.js/React, Zod, Vitest, Playwright, Docker Compose.

## Global Constraints

- Cover every persisted non-zero `LedgerEntry` effect, including initial balance, transfers, bank payments, property operations, tolls, skills, rewards, deductions, plot fines, and reversals.
- A pending approval and a rejected approval do not create a funds event; a first successful rejection creates one targeted request-status Toast for the applying player.
- Idempotency replay must not emit a second funds or rejection notification.
- Player Sessions receive only their own player-audience payloads; the active bank Session receives all bank-audience fund payloads.
- A dual-role Session receives role-tagged payloads and displays only the payload matching the current workbench view.
- Each Toast remains visible for exactly 3,000 ms, then the next queued Toast appears.
- Toasts have no close control, do not take focus, and use `pointer-events: none`.
- Existing uncommitted user changes in `app.ts`, `prisma-game-service.ts`, `app-router-client.tsx`, `globals.css`, and tests must be preserved. Do not stage whole dirty files; inspect and isolate only feature hunks before any implementation commit.
- Start runtime services only through Docker Compose and keep browser testing on port 3000.

---

### Task 1: Shared realtime Toast contract

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/rules.test.ts`

**Interfaces:**
- Produces: `realtimeToastEventSchema`, `RealtimeToastEvent`, and `RealtimeToastAudience`.
- Consumes: Zod already declared by `@zhenhuan/shared`.

- [ ] **Step 1: Write the failing schema tests**

Add tests that accept the exact wire envelope and reject malformed IDs, empty messages, unknown roles, and unknown event kinds:

```ts
expect(realtimeToastEventSchema.parse({
  eventId: 'transaction-1:PLAYER:player-1',
  roomId: 'room-1',
  audience: 'PLAYER',
  kind: 'FUNDS',
  message: '银行向你发放起点奖励 1000 两',
})).toMatchObject({ audience: 'PLAYER', kind: 'FUNDS' });

expect(() => realtimeToastEventSchema.parse({
  eventId: '', roomId: 'room-1', audience: 'OTHER', kind: 'FUNDS', message: '',
})).toThrow();
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- packages/shared/src/rules.test.ts`

Expected: FAIL because `realtimeToastEventSchema` is not exported.

- [ ] **Step 3: Add the minimal shared schema**

Add this contract to `packages/shared/src/index.ts`:

```ts
import { z } from 'zod';

export const realtimeToastEventSchema = z.object({
  eventId: z.string().min(1),
  roomId: z.string().min(1),
  audience: z.enum(['PLAYER', 'BANK']),
  kind: z.enum(['FUNDS', 'REQUEST_REJECTED']),
  message: z.string().trim().min(1).max(240),
}).strict();

export type RealtimeToastEvent = z.infer<typeof realtimeToastEventSchema>;
export type RealtimeToastAudience = RealtimeToastEvent['audience'];
```

- [ ] **Step 4: Run the focused test and shared build**

Run: `npm test -- packages/shared/src/rules.test.ts && npm run build -w @zhenhuan/shared`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Isolate the task diff**

Run: `git diff --check -- packages/shared/src/index.ts packages/shared/src/rules.test.ts`

Expected: no output. Do not stage unrelated pre-existing hunks.

---

### Task 2: Build audience-safe fund and rejection deliveries

**Files:**
- Create: `apps/api/src/realtime-toast-notifications.ts`
- Create: `apps/api/src/realtime-toast-notifications.test.ts`

**Interfaces:**
- Consumes: a Prisma client, committed `transactionId` or rejected `requestId`.
- Produces: `buildFundToastDeliveries(database, transactionId)` and `buildRejectionToastDelivery(database, requestId)` returning `{ sessionId, event: RealtimeToastEvent }` records.

- [ ] **Step 1: Write failing delivery-builder tests**

Use a small typed fake database to cover these exact cases:

```ts
const deliveries = await buildFundToastDeliveries(database, 'tx-transfer');
expect(deliveries).toEqual(expect.arrayContaining([
  { sessionId: 'payer-session', event: expect.objectContaining({
    audience: 'PLAYER', message: '你向沈眉庄支付 500 两',
  }) },
  { sessionId: 'receiver-session', event: expect.objectContaining({
    audience: 'PLAYER', message: '钮祜禄·甄嬛向你转入 500 两',
  }) },
  { sessionId: 'bank-session', event: expect.objectContaining({
    audience: 'BANK', message: '钮祜禄·甄嬛向沈眉庄支付 500 两',
  }) },
]));
```

Add cases for one positive effect (`银行向你发放起点奖励 1000 两`), one negative effect (`银行扣除你 300 两（剧情罚款）`), player-to-bank payment, bank messages, reversal wording, zero-effect transactions, missing active Sessions, and unrelated members receiving nothing.

Add a rejection case:

```ts
await expect(buildRejectionToastDelivery(database, 'request-1')).resolves.toEqual({
  sessionId: 'payer-session',
  event: {
    eventId: 'request-1:rejected:PLAYER:player-1',
    roomId: 'room-1',
    audience: 'PLAYER',
    kind: 'REQUEST_REJECTED',
    message: '你的转帐申请已被银行拒绝：金额有误',
  },
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- apps/api/src/realtime-toast-notifications.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement persisted-data loading and wording**

Implement focused helpers with these signatures:

```ts
export type ToastDelivery = { sessionId: string; event: RealtimeToastEvent };

export async function buildFundToastDeliveries(
  database: Pick<PrismaClient, 'gameTransaction' | 'roomMembership'>,
  transactionId: string,
): Promise<ToastDelivery[]>;

export async function buildRejectionToastDelivery(
  database: Pick<PrismaClient, 'gameRequest'>,
  requestId: string,
): Promise<ToastDelivery | null>;
```

Load the transaction with ledger entries and each entry's player/member display name and active Session. Load the active bank membership separately. Pair one negative and one positive effect as player-to-player flow; treat a single positive effect as bank-to-player and a single negative effect as player-to-bank. Ignore zero amounts and transactions with no ledger entries.

Use stable IDs:

```ts
const playerEventId = `${transaction.id}:PLAYER:${entry.playerId}`;
const bankEventId = `${transaction.id}:BANK`;
```

Map request types to readable labels with a closed record containing at least `PLAYER_TRANSFER: '转帐'`, `BANK_PAYMENT: '银行付款'`, `BUY_PROPERTY: '购买地产'`, `BUILD_PROPERTY: '升级地产'`, `TRADE_PROPERTY: '地产交易'`, and a generic `操作` fallback.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- apps/api/src/realtime-toast-notifications.test.ts && npm run typecheck`

Expected: PASS with no payload containing another player's transaction unless its audience is `BANK` or that player is a transaction participant.

- [ ] **Step 5: Isolate the task diff**

Run: `git diff --check -- apps/api/src/realtime-toast-notifications.ts apps/api/src/realtime-toast-notifications.test.ts`

Expected: no output.

---

### Task 3: Invoke realtime callbacks only after fresh committed mutations

**Files:**
- Modify: `apps/api/src/prisma-game-service.ts`
- Modify: `apps/api/src/prisma-game-service.contract.test.ts`
- Modify: `apps/api/src/prisma-game-service.integration.test.ts`
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/api/src/account-room-service.integration.test.ts`

**Interfaces:**
- Produces: optional `PostCommitToastNotifier` constructor dependency with `fundsCommitted(roomId, transactionId)` and `requestRejected(roomId, requestId)` methods.
- Consumes: callbacks supplied by `buildApiApp`; existing callers may omit them.

- [ ] **Step 1: Write failing post-commit and idempotency tests**

Add service tests that assert:

```ts
expect(notifier.fundsCommitted).toHaveBeenCalledWith(room.id, transaction.id);
expect(notifier.fundsCommitted).toHaveBeenCalledTimes(1);
```

Call each command twice with the same idempotency key and verify the second call does not notify. Cover immediate transfer, approved transfer, bank adjustment, toll, plot fine, a cash-bearing skill event, reversal, initial character balance, and initial balance created during a role swap.

For rejection, assert the first successful rejection calls `requestRejected(room.id, request.id)` once and an idempotency replay does not call it again.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- apps/api/src/prisma-game-service.contract.test.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/account-room-service.integration.test.ts`

Expected: FAIL because neither service accepts or invokes the notifier.

- [ ] **Step 3: Add the notifier interface and post-commit hook**

Define the shared API-side interface in `realtime-toast-notifications.ts`:

```ts
export type PostCommitToastNotifier = {
  fundsCommitted: (roomId: string, transactionId: string) => void | Promise<void>;
  requestRejected: (roomId: string, requestId: string) => void | Promise<void>;
};
```

Extend both service constructors with an optional notifier. Extend each internal idempotency executor with an `afterCommit` callback that runs only when its transaction returned `{ created: true }`. Await it after the Prisma transaction resolves; catch notification errors so a committed money mutation remains successful.

For `PrismaGameService`, pass result-aware callbacks from:

- `approve` using `transactionId` when `mutationCreated` is true;
- immediate `transfer` using the transaction `id` only when status is `EXECUTED`;
- `payToll`, `adjustBalance`, and `plotFine` using result `id`;
- cash-bearing `addSkipTurns` using a returned optional `transactionId`;
- `reverseLatest` using `reversalTransactionId`;
- `reject` using the rejected request ID.

For `AccountRoomService`, capture the initial-balance transaction ID inside `selectCharacter` and role-swap execution, then use the existing `afterCreate` or an equivalent fresh-commit callback. Reset captured IDs at the start of every serialization retry.

- [ ] **Step 4: Verify approvals without effects do not emit funds events**

Add an assertion that approving a non-cash request may create a `GameTransaction` with zero ledger effects but the builder yields no deliveries. Do not special-case approval mode in the client.

- [ ] **Step 5: Run the focused service suite**

Run: `npm test -- apps/api/src/prisma-game-service.contract.test.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/account-room-service.integration.test.ts`

Expected: PASS; each fresh committed money transaction notifies once and every replay notifies zero additional times.

- [ ] **Step 6: Inspect dirty-file boundaries**

Run: `git diff --check -- apps/api/src/prisma-game-service.ts apps/api/src/account-room-service.ts apps/api/src/prisma-game-service.contract.test.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/account-room-service.integration.test.ts`

Expected: no output. Compare against the pre-task diff and do not stage pre-existing changes.

---

### Task 4: Wire Session-targeted Socket delivery

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app-socket.test.ts`
- Modify: `apps/api/src/server-room-routes.test.ts`

**Interfaces:**
- Consumes: `PostCommitToastNotifier` callbacks and `ToastDelivery` records.
- Produces: Socket event `room.toast` sent only to `session:<sessionId>`.

- [ ] **Step 1: Write failing Socket isolation tests**

Create connected bank, payer, recipient, unrelated-player, and other-room clients. Trigger dispatcher callbacks and assert:

```ts
await expect(event(payer, 'room.toast')).resolves.toMatchObject({
  audience: 'PLAYER', kind: 'FUNDS', roomId: 'room-a',
});
await expect(event(bank, 'room.toast')).resolves.toMatchObject({ audience: 'BANK' });
expect(unrelatedEvents).toEqual([]);
expect(otherRoomEvents).toEqual([]);
```

Add a rejection test where only the applying player's Session receives `REQUEST_REJECTED`.

- [ ] **Step 2: Run the Socket tests and verify RED**

Run: `npm test -- apps/api/src/app-socket.test.ts apps/api/src/server-room-routes.test.ts`

Expected: FAIL because `room.toast` is not emitted.

- [ ] **Step 3: Construct and inject the notifier in `buildApiApp`**

Reorder default service construction until after `io` exists. Create callbacks that load deliveries and emit:

```ts
for (const delivery of deliveries) {
  io.to(sessionChannel(delivery.sessionId)).emit('room.toast', delivery.event);
}
```

Instantiate default services with this notifier while keeping injected test doubles compatible. Keep the existing `room.snapshot-required` invalidation unchanged; Toast events supplement rather than replace snapshot refresh.

Catch and log delivery-builder failures without changing the already committed HTTP response.

- [ ] **Step 4: Run API Socket and route tests**

Run: `npm test -- apps/api/src/app-socket.test.ts apps/api/src/server-room-routes.test.ts`

Expected: PASS with no room-wide `room.toast` broadcast.

- [ ] **Step 5: Run API typecheck**

Run: `npm run typecheck`

Expected: PASS.

---

### Task 5: Implement the three-second FIFO Toast queue

**Files:**
- Create: `apps/web/app/components/toast-queue.ts`
- Create: `apps/web/app/components/toast-queue.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx`
- Modify: `apps/web/app/components/app-router-client.test.ts`

**Interfaces:**
- Produces: `enqueueToast`, `currentToast`, and `clearToasts` behavior with stable-ID deduplication.
- Consumes: validated `room.toast` payloads plus local action messages.

- [ ] **Step 1: Write failing queue tests with fake timers**

Test the pure queue state helper and timer contract:

```ts
vi.useFakeTimers();
queue.enqueue({ id: 'one', message: '第一条' });
queue.enqueue({ id: 'two', message: '第二条' });
expect(queue.current()).toMatchObject({ message: '第一条' });
vi.advanceTimersByTime(2_999);
expect(queue.current()).toMatchObject({ message: '第一条' });
vi.advanceTimersByTime(1);
expect(queue.current()).toMatchObject({ message: '第二条' });
```

Also test duplicate IDs, FIFO ordering, local messages receiving generated IDs, `clear()` cancelling pending timers, and disposal preventing later callbacks.

- [ ] **Step 2: Run the queue test and verify RED**

Run: `npm test -- apps/web/app/components/toast-queue.test.ts apps/web/app/components/app-router-client.test.ts`

Expected: FAIL because the queue module and Socket handler do not exist.

- [ ] **Step 3: Implement the minimal queue controller**

Implement a controller with injected timer functions so tests stay in the Node environment:

```ts
export function createToastQueue(
  onChange: (toast: ToastItem | null) => void,
  schedule = window.setTimeout.bind(window),
  cancel = window.clearTimeout.bind(window),
) {
  // enqueue, clear, dispose; one 3000 ms timer per visible item
}
```

Keep a `Set` of seen stable event IDs for the life of the room queue. `clear()` empties pending items, current item, timer, and seen IDs.

- [ ] **Step 4: Integrate the queue at `AppRouterClient` scope**

Create the queue once per mounted authenticated client, expose a stable `showNotice(message)` for local actions, and pass `currentToast` plus `showNotice` into `Workbench`. Remove Workbench's single-string state and 3,500 ms timer.

Register:

```ts
socket.on('room.toast', (payload: unknown) => {
  const parsed = realtimeToastEventSchema.safeParse(payload);
  if (!parsed.success) return;
  const runtime = roomRuntime.current;
  if (parsed.data.roomId !== runtime.roomId) return;
  if (parsed.data.audience !== runtime.workbench?.view) return;
  enqueueToast({ id: parsed.data.eventId, message: parsed.data.message });
});
```

Clear the queue in `clearRoomState`, room transitions, logout, control loss, and component cleanup. Do not interfere with the existing room snapshot listener.

- [ ] **Step 5: Render a single passive live-region Toast**

Render only the current item:

```tsx
{toast && (
  <div className="toast" role="status" aria-live="polite" aria-atomic="true">
    <Check aria-hidden="true" />
    <span>{toast.message}</span>
  </div>
)}
```

There is no close button and no click handler.

- [ ] **Step 6: Run frontend tests**

Run: `npm test -- apps/web/app/components/toast-queue.test.ts apps/web/app/components/app-router-client.test.ts`

Expected: PASS; the first item remains for exactly 3,000 ms and role/room mismatches are ignored.

---

### Task 6: Responsive Toast styling and end-to-end verification

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `tests/style-device-spacing.test.mjs`
- Create: `tests/e2e/fund-flow-toast.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: one `.toast` element rendered by the queue.
- Produces: mobile top-center and desktop top-right passive notification placement.

- [ ] **Step 1: Write failing style contract tests**

Assert `.toast` contains `pointer-events: none`, a safe-area-aware top offset, bounded width, and a desktop media rule that switches to right alignment without covering the 300 px sidebar.

- [ ] **Step 2: Run style tests and verify RED**

Run: `node --test tests/style-device-spacing.test.mjs`

Expected: FAIL because the current Toast lacks passive pointer handling and desktop right placement.

- [ ] **Step 3: Update the existing Toast style**

Use the current green paper treatment and add these behavioral constraints:

```css
.toast {
  position: fixed;
  top: calc(86px + env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  width: min(calc(100% - 32px), 500px);
  pointer-events: none;
}

@media (min-width: 900px) {
  .toast {
    top: 24px;
    right: 24px;
    left: auto;
    transform: none;
    width: min(420px, calc(100vw - 348px));
  }
}
```

Keep text wrapping with `overflow-wrap: anywhere`; do not add rounded pills or a close control.

- [ ] **Step 4: Add real-stack Playwright coverage**

Through the normal authenticated flows, verify:

- immediate player-to-player transfer shows payer, receiver, and bank copy on the correct devices;
- approval-required transfer shows no funds Toast before approval and does after approval;
- bank rejection shows only the applying player `已被银行拒绝` with its reason;
- two rapid fund events display sequentially and each disappears after 3 seconds;
- unrelated players receive no Toast;
- a page control located behind the Toast region remains clickable;
- desktop 1440 x 900 and mobile 390 x 844 screenshots have no overlaps.

- [ ] **Step 5: Document the realtime reminder contract**

Add a concise README section stating that `room.toast` is an online-only reminder, role-scoped through Session channels, while REST snapshots and the ledger remain authoritative.

- [ ] **Step 6: Run the focused browser test through Docker Compose**

First inspect and stop only stale host-side Node/Next processes belonging to this project. Then run:

```bash
docker compose up -d
npx playwright test tests/e2e/fund-flow-toast.spec.ts --project=desktop-chromium
npx playwright test tests/e2e/fund-flow-toast.spec.ts --project=iphone-webkit
```

Expected: both projects PASS on port 3000.

- [ ] **Step 7: Run the full verification gate**

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
node --test tests/style-device-spacing.test.mjs
git diff --check
```

Expected: every command exits 0 with no failed tests, lint errors, type errors, build errors, or whitespace errors.

- [ ] **Step 8: Audit the original requirements**

Confirm with source, automated tests, and browser evidence that all actual balance effects notify; player privacy and bank completeness hold; approval mode changes timing but not eventual notifications; rejection alerts the applicant; the queue is FIFO at 3 seconds per item; and the Toast is passive, responsive, and not a ledger replacement.
