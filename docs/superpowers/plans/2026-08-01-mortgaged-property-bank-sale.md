# Mortgaged Property Bank Sale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow bank-approved sale of mortgaged properties at their remaining value minus the room redemption fee, and expose that non-negative fee in room creation and lobby-only administration.

**Architecture:** Put the sale-price formula in `@zhenhuan/shared` so the API remains authoritative while the Web preview uses the same calculation. Extend the existing `Room.redemptionFee` field through account-room DTOs and forms without a migration. Reuse `SELL_PROPERTY_TO_BANK`, property locking, approval transactions, reversal metadata, and the existing Toast notifier.

**Tech Stack:** TypeScript, React/Next.js, Fastify, Zod, Prisma/PostgreSQL, Vitest, Playwright, Docker Compose.

## Global Constraints

- `redemptionFee` is a non-negative integer, defaults to `200`, and supports `0`.
- The fee is editable during room creation and while the room is `LOBBY`; it is locked after play starts.
- Mortgaged sale amount is `max(0, purchasePrice - mortgagePrice - redemptionFee)`.
- Unmortgaged sale amount remains `purchasePrice`.
- Mortgaged and built properties remain ineligible for player-to-player trade.
- Built properties remain ineligible for sale to the bank.
- The API computes and persists the authoritative amount; the client never submits a sale amount.
- Approval clears owner, mortgage, and request lock atomically and continues through the existing ledger, reversal, realtime snapshot, and Toast systems.
- Zero-value approvals do not emit a funds Toast, matching current Toast behavior.
- Start and run the app only through Docker Compose; Playwright uses `PLAYWRIGHT_EXTERNAL_STACK=1` on port `3000`.
- Preserve unrelated changes already present in the dirty worktree.
- Before every commit step, inspect `git diff --cached --name-only`; stage only task-owned hunks. If an overlapping file contains pre-existing user edits that cannot be isolated non-interactively, leave the task changes uncommitted instead of committing the user's edits.

---

### Task 1: Shared Bank-Sale Formula

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/rules.test.ts`

**Interfaces:**
- Consumes: `{ purchasePrice: number; mortgagePrice: number; mortgaged: boolean; redemptionFee: number }`.
- Produces: `calculatePropertyBankSaleAmount(input): number` for both API request creation and Web settlement preview.

- [ ] **Step 1: Write the failing formula tests**

Add the import and cases:

```ts
import { calculatePropertyBankSaleAmount } from './index.js';

describe('property bank sale amount', () => {
  it.each([
    [{ purchasePrice: 1000, mortgagePrice: 500, mortgaged: false, redemptionFee: 200 }, 1000],
    [{ purchasePrice: 1000, mortgagePrice: 500, mortgaged: true, redemptionFee: 200 }, 300],
    [{ purchasePrice: 1000, mortgagePrice: 500, mortgaged: true, redemptionFee: 0 }, 500],
    [{ purchasePrice: 1000, mortgagePrice: 500, mortgaged: true, redemptionFee: 800 }, 0],
  ])('calculates %#', (input, expected) => {
    expect(calculatePropertyBankSaleAmount(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- packages/shared/src/rules.test.ts`

Expected: FAIL because `calculatePropertyBankSaleAmount` is not exported.

- [ ] **Step 3: Implement the minimal shared formula**

Add to `packages/shared/src/index.ts`:

```ts
export function calculatePropertyBankSaleAmount(input: {
  purchasePrice: number;
  mortgagePrice: number;
  mortgaged: boolean;
  redemptionFee: number;
}) {
  const amount = input.mortgaged
    ? input.purchasePrice - input.mortgagePrice - input.redemptionFee
    : input.purchasePrice;
  return Math.max(0, amount);
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run: `npm test -- packages/shared/src/rules.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/src/rules.test.ts
git commit -m "feat(shared): calculate mortgaged property bank sale"
```

---

### Task 2: Room Redemption-Fee Configuration Contract

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/account-room-service.ts`
- Test: `apps/api/src/account-room-service.integration.test.ts`
- Test: `apps/api/src/admin-account-room-service.integration.test.ts`
- Test: `apps/api/src/server-room-routes.test.ts`

**Interfaces:**
- Consumes: `redemptionFee: number` in `POST /api/rooms` and optional `redemptionFee?: number` in `PATCH /api/admin/rooms/:id`.
- Produces: persisted `Room.redemptionFee` and `configuration.redemptionFee` in admin room detail.

- [ ] **Step 1: Write failing creation and lifecycle tests**

Extend the account-room test `roomInput` override type/default with `redemptionFee`, then assert persistence:

```ts
const zeroFeeRoom = await createRoom(creator.auth, 'Zero redemption fee', randomUUID(), { redemptionFee: 0 });
expect(await db.room.findUniqueOrThrow({ where: { id: zeroFeeRoom.id } }))
  .toMatchObject({ redemptionFee: 0 });
```

In the admin route lifecycle test, require detail projection, lobby update, and playing rejection:

```ts
expect(detail.json().configuration).toMatchObject({ redemptionFee: 200 });

const feeUpdated = await app.inject({
  method: 'PATCH',
  url: `/api/admin/rooms/${lobby.id}`,
  headers: { cookie: cookie.header, 'idempotency-key': 'room-redemption-fee' },
  payload: { redemptionFee: 0 },
});
expect(feeUpdated.statusCode).toBe(200);
expect((await db.room.findUniqueOrThrow({ where: { id: lobby.id } })).redemptionFee).toBe(0);

const lockedFee = await app.inject({
  method: 'PATCH',
  url: `/api/admin/rooms/${playing.id}`,
  headers: { cookie: cookie.header, 'idempotency-key': 'playing-redemption-fee' },
  payload: { redemptionFee: 300 },
});
expect(lockedFee.json()).toEqual({ error: 'ROOM_CONFIG_LIFECYCLE_CONFLICT' });
```

In `server-room-routes.test.ts`, add a route-schema test that fails before either service method is called:

```ts
it.each([
  ['create negative', 'POST', '/api/rooms', { name: '测试', initialBalance: 5000, diceMode: 'PHYSICAL', redemptionFee: -1 }],
  ['create fractional', 'POST', '/api/rooms', { name: '测试', initialBalance: 5000, diceMode: 'PHYSICAL', redemptionFee: 1.5 }],
  ['update negative', 'PATCH', '/api/admin/rooms/room-1', { redemptionFee: -1 }],
  ['update fractional', 'PATCH', '/api/admin/rooms/room-1', { redemptionFee: 1.5 }],
])('rejects %s redemption fee', async (_name, method, url, payload) => {
  const { app, headers } = await routeHarness();
  const response = await app.inject({ method: method as 'POST' | 'PATCH', url, headers: { ...headers, 'idempotency-key': 'invalid-fee' }, payload });
  expect(response.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- apps/api/src/server-room-routes.test.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/admin-account-room-service.integration.test.ts`

Expected: FAIL because the service types, route schemas, persistence, projection, and lifecycle lock do not include `redemptionFee`.

- [ ] **Step 3: Extend API schemas and account-room types**

In `apps/api/src/app.ts`, add:

```ts
redemptionFee: z.number().int().nonnegative().default(200)
```

to the room-create body, and:

```ts
redemptionFee: z.number().int().nonnegative().optional()
```

to the admin room patch body.

In `apps/api/src/account-room-service.ts`:

- add `redemptionFee` to the create input type and room create `data`;
- add `redemptionFee?: number` to `updateAdminRoom` input;
- add `redemptionFee` to admin detail `configuration`;
- add `'redemptionFee'` to the existing `lobbyOnly` list.

The essential persistence changes are:

```ts
redemptionFee: input.redemptionFee,
```

and:

```ts
const lobbyOnly = ['diceMode', 'skillEnabled', 'startReward', 'redemptionFee', 'initialBalance'];
```

- [ ] **Step 4: Run integration tests and typecheck**

Run: `npm test -- apps/api/src/server-room-routes.test.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/admin-account-room-service.integration.test.ts && npm run typecheck`

Expected: PASS when the configured PostgreSQL test database is available; otherwise the integration suites must report their explicit environment skip while typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/server-room-routes.test.ts
git commit -m "feat(api): configure room redemption fee"
```

---

### Task 3: Authoritative Mortgaged Sale Approval

**Files:**
- Modify: `apps/api/src/prisma-game-service.ts`
- Test: `apps/api/src/prisma-game-service.integration.test.ts`

**Interfaces:**
- Consumes: `calculatePropertyBankSaleAmount` from Task 1, locked `RoomProperty`, and persisted `GameRequest.amount`.
- Produces: a pending `SELL_PROPERTY_TO_BANK` request for mortgaged level-zero property and an approved transaction whose property state is `{ ownerPlayerId: null, buildingLevel: 0, mortgaged: false }`.

- [ ] **Step 1: Write failing request/approval/reversal tests**

Add one table-driven test for fees `200`, `0`, and an amount exceeding remaining value. For each case, set a physical room fee and a mortgaged owned `甘露寺`, create the request, approve it, and assert:

```ts
expect(request).toMatchObject({ amount: expectedAmount, status: 'PENDING' });
expect(await firstDb.roomProperty.findFirstOrThrow({
  where: { roomId: room.id, definition: { name: '甘露寺' } },
})).toMatchObject({ ownerPlayerId: a.playerId, mortgaged: true, lockedByRequestId: request.id });

await first.approve(room.id, request.id, bank.token, `approve-${fee}`);

expect(await firstDb.player.findUniqueOrThrow({ where: { id: a.playerId } }))
  .toMatchObject({ balance: balanceBefore + expectedAmount });
expect(await firstDb.roomProperty.findFirstOrThrow({
  where: { roomId: room.id, definition: { name: '甘露寺' } },
})).toMatchObject({ ownerPlayerId: null, buildingLevel: 0, mortgaged: false, lockedByRequestId: null });
```

For the `200` case, reverse the transaction and assert balance, owner, and `mortgaged: true` are restored. Keep the existing building rejection test and add an explicit assertion that `TRADE_PROPERTY` still throws `MORTGAGED_PROPERTY`.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `npm run test:integration`

Expected: FAIL with `MORTGAGED_PROPERTY` when creating the bank-sale request.

- [ ] **Step 3: Compute the request amount and allow mortgaged state through approval**

Import the shared helper:

```ts
import { calculatePropertyBankSaleAmount, roll2d6 } from '@zhenhuan/shared';
```

Replace the bank-sale request calculation with:

```ts
if (action.type === 'SELL_PROPERTY_TO_BANK') {
  if (property.ownerPlayerId !== playerId) fail('NOT_PROPERTY_OWNER');
  if (property.buildingLevel > 0) fail('BUILDINGS_MUST_BE_SOLD');
  computedAmount = calculatePropertyBankSaleAmount({
    purchasePrice: property.definition.purchasePrice,
    mortgagePrice: property.definition.mortgagePrice,
    mortgaged: property.mortgaged,
    redemptionFee: room.redemptionFee,
  });
}
```

In the approval branch, remove the `request.property.mortgaged` rejection, require the current mortgage state to match the request payload, and update the property with:

```ts
data: {
  ownerPlayerId: null,
  mortgaged: false,
  lockedByRequestId: null,
  version: { increment: 1 },
}
```

Persist the creation-time mortgage flag in the request payload alongside `propertyVersion`:

```ts
propertyMortgaged: property?.mortgaged ?? null,
```

At approval compare `request.property.mortgaged` with `asObject(request.payload).propertyMortgaged` before applying the stored amount.

- [ ] **Step 4: Verify API behavior and regressions**

Run: `npm run test:integration && npm test -- apps/api/src/realtime-toast-notifications.test.ts && npm run typecheck`

Expected: PASS. Existing Toast tests confirm positive ledger effects still notify and zero effects remain silent.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts
git commit -m "feat(api): approve mortgaged property bank sales"
```

---

### Task 4: Redemption-Fee Forms

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx`
- Test: `tests/e2e/task7-management.spec.ts`
- Test: `tests/e2e/create-room-layout.spec.ts`

**Interfaces:**
- Consumes: create/admin `redemptionFee` API contract from Task 2.
- Produces: labeled non-negative integer inputs with default `200`, confirmation summary, lobby editing, and playing-room disabled state.

- [ ] **Step 1: Write failing browser tests**

Extend the room-creation workflow:

```ts
await expect(page.getByLabel('赎回手续费')).toHaveValue('200');
await page.getByLabel('赎回手续费').fill('0');
// after confirmation and submission
expect(submitted).toMatchObject({ redemptionFee: 0 });
```

Extend the admin configuration fixture and save assertion:

```ts
const configuration = {
  initialBalance: 5000,
  diceMode: 'ELECTRONIC',
  skillEnabled: true,
  startReward: 1000,
  redemptionFee: 200,
  allowMidgameJoin: false,
  visibility: 'PUBLIC',
  transferApprovalRequired: false,
  playerLimit: 5,
  hasPassword: false,
};

await page.getByLabel('赎回手续费').fill('0');
await page.getByRole('button', { name: '保存房间配置' }).click();
expect(submitted).toEqual({ redemptionFee: 0 });
```

For a fixture whose detail has `status: 'PLAYING'`, assert:

```ts
await expect(page.getByLabel('赎回手续费')).toBeDisabled();
```

In `create-room-layout.spec.ts`, include `page.getByLabel('赎回手续费').boundingBox()` beside the existing initial-balance/start-reward boxes and assert it is non-null, contained by `.create-room-settings-grid`, and does not overlap the next control at both configured projects.

- [ ] **Step 2: Start/reuse Docker and verify RED**

Run:

```bash
docker compose up -d
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-management.spec.ts tests/e2e/create-room-layout.spec.ts --project=desktop-chromium
```

Expected: FAIL because the inputs and payload fields do not exist.

- [ ] **Step 3: Add create and admin form fields**

In the create-room state and payload, add:

```ts
redemptionFee: '200',
// payload conversion
redemptionFee: Number(value.redemptionFee),
```

Render this create form control and include `赎回手续费 {formatMoney(Number(value.redemptionFee))} 两` in the confirmation summary:

```tsx
<label>
  赎回手续费
  <input
    required
    type="number"
    min="0"
    step="1"
    value={value.redemptionFee}
    onChange={(event) => update('redemptionFee', event.target.value)}
  />
  <small className="field-lock-note">开局后锁定</small>
</label>
```

In `AdminRoomDetail.configuration` and `roomDraft`, add `redemptionFee`. Include it in:

- detail hydration;
- numeric payload conversion;
- dirty-state comparison;
- the `lockedKeys` and locked-field lists;
- the configuration form with this exact control:

```tsx
<label>
  赎回手续费
  <input
    disabled={selectedRoom.status !== 'LOBBY'}
    type="number"
    min="0"
    step="1"
    value={roomDraft.redemptionFee}
    onChange={(event) => setRoomDraft({ ...roomDraft, redemptionFee: event.target.value })}
  />
</label>
```

- [ ] **Step 4: Run browser tests and typecheck**

Run:

```bash
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-management.spec.ts tests/e2e/create-room-layout.spec.ts --project=desktop-chromium
npm run typecheck
```

Expected: PASS with no text overflow or field overlap at tested desktop/mobile widths.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/app-router-client.tsx tests/e2e/task7-management.spec.ts tests/e2e/create-room-layout.spec.ts
git commit -m "feat(web): configure redemption fee"
```

---

### Task 5: Mortgaged Sale Preview and Confirmation

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx`
- Test: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- Consumes: `calculatePropertyBankSaleAmount`, room snapshot `redemptionFee`, and existing `ConfirmDialog`/`showNotice` APIs.
- Produces: mortgaged properties in bank-sale candidates, correct preview, dynamic warning dialog, and unchanged trade candidates.

- [ ] **Step 1: Write failing player-workbench tests**

Create a snapshot fixture with one owned level-zero mortgaged property and intercept `POST /api/rooms/room-1/requests`. Assert:

```ts
await page.getByRole('button', { name: '资产操作' }).click();
await page.getByLabel('操作类型').selectOption('SELL_PROPERTY_TO_BANK');
await expect(page.getByLabel('目标地产')).toContainText('甘露寺');
await expect(page.getByText('300 两', { exact: true })).toBeVisible();
await page.getByRole('button', { name: '确认提交' }).click();
await expect(page.getByRole('dialog', { name: '确认出售抵押地产' })).toContainText(
  '该地产处于抵押状态，按照游戏规则，直接出售将扣除 200 两赎回费用，是否继续？',
);
expect(requests).toHaveLength(0);
await page.getByRole('button', { name: '取消' }).click();
expect(requests).toHaveLength(0);
```

Reopen and confirm; assert the request body is exactly:

```ts
{ playerId: 'p1', type: 'SELL_PROPERTY_TO_BANK', propertyName: '甘露寺' }
```

Then select `TRADE_PROPERTY` and assert the mortgaged property is absent:

```ts
await page.getByLabel('操作类型').selectOption('TRADE_PROPERTY');
await expect(page.getByLabel('目标地产')).not.toContainText('甘露寺');
```

Repeat the same fixture with `redemptionFee: 0` and assert the zero-fee preview and warning:

```ts
await expect(page.getByText('500 两', { exact: true })).toBeVisible();
await page.getByRole('button', { name: '确认提交' }).click();
await expect(page.getByRole('dialog', { name: '确认出售抵押地产' }))
  .toContainText('扣除 0 两赎回费用');
```

- [ ] **Step 2: Run the focused browser test and verify RED**

Run: `PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium`

Expected: FAIL because mortgaged properties are filtered out of bank-sale candidates.

- [ ] **Step 3: Implement candidate rules, preview, and confirmation**

Import the shared helper in `app-router-client.tsx`.

Change asset filtering so:

```ts
if (assetMode === 'SELL_PROPERTY_TO_BANK') return property.level === 0;
if (assetMode === 'MORTGAGE_PROPERTY' || assetMode === 'TRADE_PROPERTY')
  return property.level === 0 && !property.mortgaged;
```

Use the shared helper for the bank-sale preview:

```ts
amount: calculatePropertyBankSaleAmount({
  purchasePrice: selectedAssetProperty.purchasePrice,
  mortgagePrice: selectedAssetProperty.mortgage ?? 0,
  mortgaged: selectedAssetProperty.mortgaged,
  redemptionFee: snapshot.redemptionFee,
}),
```

Add `saleConfirmProperty` state. Split request submission into an internal function that performs the existing API call and a click handler that opens confirmation only when the selected sale property is mortgaged. Render:

```tsx
<ConfirmDialog
  title="确认出售抵押地产"
  confirmLabel="确认继续"
  busy={busy}
  onCancel={() => setSaleConfirmProperty(null)}
  onConfirm={() => void submitConfirmedAssetAction()}
>
  <p>该地产处于抵押状态，按照游戏规则，直接出售将扣除 {formatMoney(snapshot.redemptionFee)} 两赎回费用，是否继续？</p>
</ConfirmDialog>
```

On successful submission, close both the sheet and dialog and retain `showNotice('资产操作已提交银行审批')`.

- [ ] **Step 4: Run browser, unit, and type checks**

Run:

```bash
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium
npm test -- apps/web/app/components/app-router-client.test.ts packages/shared/src/rules.test.ts
npm run typecheck
```

Expected: PASS. Trade confirmation, local Toast queue, and unrelated asset operations remain green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/app-router-client.tsx tests/e2e/workbench.spec.ts
git commit -m "feat(web): confirm mortgaged property bank sale"
```

---

### Task 6: Full Verification and Documentation Consistency

**Files:**
- Modify: `README.md`
- Verify: all files changed by Tasks 1-5

**Interfaces:**
- Consumes: completed rule, configuration, API, UI, approval, reversal, and Toast behavior.
- Produces: documented rule and clean verification evidence.

- [ ] **Step 1: Update the rule documentation**

Add this paragraph in the README game-rule section without changing player-trade wording:

```markdown
房间的赎回手续费默认为 200 两，支持设置为 0，仅可在创建房间和大厅阶段修改。赎回地产需支付“抵押价 + 赎回手续费”；抵押地产也可无需先赎回而申请卖给银行，卖回金额为 `max(0, 购买价 - 抵押价 - 赎回手续费)`。抵押地产卖回仍需银行审批，批准后恢复无主并清除抵押状态。
```

- [ ] **Step 2: Run complete static and unit verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
git diff --check
```

Expected: all commands PASS with no warnings or whitespace errors.

- [ ] **Step 3: Run integration verification**

Run: `npm run test:integration`

Expected: PASS against the configured isolated PostgreSQL test database.

- [ ] **Step 4: Run targeted desktop and mobile workflows**

Run:

```bash
docker compose up -d
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-management.spec.ts tests/e2e/create-room-layout.spec.ts tests/e2e/workbench.spec.ts --project=desktop-chromium
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/create-room-layout.spec.ts tests/e2e/workbench.spec.ts --project=iphone-webkit
```

Expected: PASS; the new inputs, settlement preview, and confirmation dialog fit without overlap on desktop and mobile.

- [ ] **Step 5: Inspect the final diff for scope and regressions**

Run:

```bash
git status --short
git diff --stat
git diff -- packages/shared/src/index.ts packages/shared/src/rules.test.ts apps/api/src/app.ts apps/api/src/account-room-service.ts apps/api/src/prisma-game-service.ts apps/web/app/components/app-router-client.tsx README.md
```

Expected: only requested rule/configuration changes plus their focused tests and documentation; unrelated dirty-worktree changes remain preserved.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain mortgaged property bank sale"
```
