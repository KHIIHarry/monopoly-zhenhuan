# Start Reward Single Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one player click on “声明停留起点” create the only bank approval needed for the configured start reward.

**Architecture:** Keep `POST /api/rooms/:id/landings/start` as the player-facing command, but make it atomically create a server-internal confirmed `START` landing and its pending `START_REWARD` request. The existing bank request approval path remains the sole money mutation, while the player UI keeps its current entry point and removes the now-unreachable second submission step.

**Tech Stack:** TypeScript, Prisma 6, Fastify, React 19, Next.js, Vitest, Playwright

## Global Constraints

- Keep the player-facing “精确停留起点” sheet and “声明停留起点” button unchanged.
- One click must create one pending `START_REWARD` request; the bank must not confirm a `START` landing.
- The bank approval checkmark must display `+<Room.startReward>`, including `+1,000` for the default configuration.
- Create the landing evidence and reward request in one transaction and increment room state once.
- Preserve idempotent replay: the same key creates neither a second landing nor a second reward request.
- Preserve approval-time electronic-turn expiry validation and the legacy request path for already-confirmed start landings.
- Do not modify the database schema or the property landing flow.
- Preserve unrelated worktree changes.
- Use Docker Compose only when starting the application; npm commands are allowed for tests and checks.

---

### Task 1: Atomically Create the Start Reward Approval

**Files:**
- Modify: `apps/api/src/prisma-game-service.integration.test.ts:508-522,2366-2394`
- Modify: `apps/api/src/prisma-game-service.ts:322-330`

**Interfaces:**
- Consumes: `PrismaGameService.declareStartLanding(actor, roomId, playerId, landingId, key)` and `Room.startReward`.
- Produces: the existing landing-shaped response plus `requestId: string`, `amount: number`, and `requestStatus: 'PENDING'`; a persisted `LandingEvent(status='CONFIRMED', spaceType='START')` linked to one pending `GameRequest(type='START_REWARD')`.

- [ ] **Step 1: Replace the start declaration integration assertions with the desired atomic behavior**

Update the start half of `replays property and start landing declarations without invalidating the original landing` so it proves status, linked request, configured amount, and replay deduplication:

```ts
await firstDb.room.update({ where: { id: room.id }, data: { startReward: 1_200 } });
const start = await first.declareStartLanding(
  room.id,
  a.playerId,
  'start-landing-keyed',
  a.token,
  'start-landing-key',
);
const startReplay = await second.declareStartLanding(
  room.id,
  a.playerId,
  'start-landing-keyed',
  a.token,
  'start-landing-key',
);

expect(startReplay).toMatchObject({
  id: start.id,
  requestId: start.requestId,
  requestStatus: 'PENDING',
  amount: 1_200,
  declaredAt: start.declaredAt.toISOString(),
});
expect(start).toMatchObject({
  id: 'start-landing-keyed',
  requestStatus: 'PENDING',
  amount: 1_200,
});
expect(await firstDb.landingEvent.findUniqueOrThrow({ where: { id: start.id } })).toMatchObject({
  status: 'CONFIRMED',
  spaceType: 'START',
  plotResolved: true,
});
expect(await firstDb.gameRequest.findMany({
  where: { roomId: room.id, landingEventId: start.id, type: 'START_REWARD' },
})).toEqual([
  expect.objectContaining({
    id: start.requestId,
    actorPlayerId: a.playerId,
    status: 'PENDING',
    amount: 1_200,
  }),
]);
await expect(
  first.declareStartLanding(
    room.id,
    a.playerId,
    'different-start-landing',
    a.token,
    'start-landing-key',
  ),
).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
```

Replace `stores the configured start reward amount on its pending request` with a bank snapshot assertion proving that the new start landing is not pending confirmation while its request is visible:

```ts
it('submits one configured start reward approval without a bank landing confirmation', async () => {
  const { room, a } = await physicalRoom();
  await firstDb.room.update({ where: { id: room.id }, data: { startReward: 1_200 } });

  const submitted = await first.declareStartLanding(
    room.id,
    a.playerId,
    'start-reward-landing',
    a.token,
    'start-reward-landing-key',
  );
  const bankSnapshot = await first.snapshot(room.id);

  expect(bankSnapshot.landings).not.toContainEqual(
    expect.objectContaining({ id: submitted.id, status: 'DECLARED' }),
  );
  expect(bankSnapshot.requests).toContainEqual(
    expect.objectContaining({
      id: submitted.requestId,
      type: 'START_REWARD',
      status: 'PENDING',
      amount: 1_200,
    }),
  );
  expect(await firstDb.gameRequest.findUniqueOrThrow({
    where: { id: submitted.requestId },
  })).toMatchObject({ landingEventId: submitted.id });
});
```

- [ ] **Step 2: Run the focused integration tests and verify RED**

Run:

```bash
npm run test:integration -- -t "replays property and start landing declarations|submits one configured start reward approval"
```

Expected: FAIL because start declarations currently persist a `DECLARED` landing and create no `START_REWARD` request.

- [ ] **Step 3: Implement the atomic landing evidence and request creation**

In `declareStartLanding`, retain the existing room/turn checks and invalidation calls, load the player in the same transaction, then replace the final landing creation with:

```ts
const landing = await tx.landingEvent.create({
  data: {
    id: landingId,
    roomId,
    turnId: turn?.id,
    playerId,
    spaceType: 'START',
    status: 'CONFIRMED',
    declaredBy: member.id,
    confirmedAt: new Date(),
    plotResolved: true,
  },
});
const player = await tx.player.findFirst({ where: { id: playerId, roomId } });
if (!player) fail('PLAYER_NOT_FOUND');
const requestHash = requestFingerprint({
  roomId,
  playerId,
  type: 'START_REWARD',
  landingId,
});
const request = await tx.gameRequest.create({
  data: {
    roomId,
    type: 'START_REWARD',
    actorPlayerId: playerId,
    landingEventId: landing.id,
    turnId: turn?.id,
    amount: room.startReward,
    payload: { playerVersion: player.version },
    idempotencyKey: `${actor.accountId}:${key}:start-reward`,
    requestHash,
  },
});
return {
  ...landing,
  requestId: request.id,
  amount: request.amount ?? room.startReward,
  requestStatus: request.status,
};
```

The outer `executeIdempotent` remains responsible for the single state-version increment and full transaction rollback. Do not call `createRequest`, because that method starts a second transaction.

- [ ] **Step 4: Keep legacy and expiry tests valid under the new automatic request**

In the electronic expiry test, use the request created by `declareStartLanding`, end the turn, and approve it through the bank path:

```ts
const submitted = await first.declareStartLanding(
  room.id,
  a.playerId,
  'stale-start-landing',
  a.token,
  'stale-start-landing-key',
);
await first.endTurn(room.id, a.playerId, 'end-start-landing-turn');

await expect(
  first.approve(room.id, submitted.requestId, bank.token, 'approve-stale-start-reward'),
).rejects.toThrow('START_LANDING_TURN_EXPIRED');
```

Retain `createRequest` support for historical `START + CONFIRMED` landings. Where older tests intentionally exercise that path, create the confirmed landing directly as fixture data rather than calling the now-automatic start command.

- [ ] **Step 5: Run the complete service integration suite**

Run:

```bash
npm run test:integration -- apps/api/src/prisma-game-service.integration.test.ts
```

Expected: PASS with no duplicate request, landing confirmation, start reward, or expiry regressions.

- [ ] **Step 6: Commit the service behavior**

```bash
git add apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts
git commit -m "fix(api): submit start reward in one step"
```

---

### Task 2: Collapse the Player Flow and Lock the Bank Amount Label

**Files:**
- Modify: `apps/web/app/components/app-router-client.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx:5048-5057,5177-5207,5657-5696`
- Modify: `tests/e2e/workbench.spec.ts:214-252`

**Interfaces:**
- Consumes: `POST /api/rooms/:id/landings/start` response containing the existing landing ID plus the pending start reward metadata.
- Produces: one player action with the existing button and direct “已提交银行审批” feedback; no reachable second `POST /requests` action for a newly declared start landing.

- [ ] **Step 1: Add failing source-contract assertions for the one-click player flow and bank amount label**

Add a focused test to `app-router-client.test.ts`:

```ts
test('submits the start reward from the existing declaration button and labels its bank approval amount', async () => {
  const component = await readFile(fileURLToPath(componentUrl), 'utf8');
  const startFlow = component.slice(
    component.indexOf('async function declareStartLanding'),
    component.indexOf('async function confirmTrade'),
  );
  const startSheet = component.slice(
    component.indexOf('{panel === "START"'),
    component.indexOf('{panel === "PROPERTY"'),
  );
  const approvalSection = component.slice(
    component.indexOf('function PendingApprovalSection'),
    component.indexOf('function approvalDetails'),
  );

  expect(startFlow).toContain('起点 ${formatMoney(snapshot.startReward)} 两申请已提交银行审批');
  expect(startFlow).not.toContain('async function requestStartReward');
  expect(startSheet).toContain('声明停留起点');
  expect(startSheet).not.toContain('等待银行确认起点落点');
  expect(startSheet).not.toContain('银行已确认本轮精确停留起点');
  expect(approvalSection).toMatch(/<Check \/>[\s\S]*?\+\{formatMoney\(request\.actualAmount \?\? request\.amount\)\}/);
});
```

- [ ] **Step 2: Rewrite the Playwright request contract for one click**

In `tests/e2e/workbench.spec.ts`, keep the snapshot and sheet assertions, but make the start endpoint return the atomic result and remove the `/requests` route:

```ts
let startWrites = 0;
let startBody: Record<string, unknown> | null = null;
await page.route('**/api/rooms/r1/landings/start', async (route) => {
  startWrites += 1;
  startBody = await body(route);
  return route.fulfill({
    json: {
      id: String(startBody.landingId),
      requestId: 'request-start-reward',
      amount: 1_200,
      requestStatus: 'PENDING',
    },
  });
});

await page.goto('/');
await page.getByRole('button', { name: /碎玉轩夜局/ }).click();
await page.getByRole('button', { name: '起点奖励' }).click();
await expect(page.getByText('仅棋子精确停留起点可领取 1,200 两')).toBeVisible();
await page.getByRole('button', { name: '声明停留起点' }).click();

await expect.poll(() => startWrites).toBe(1);
expect(startBody).toMatchObject({ playerId: 'p1' });
expect(startBody?.landingId).toBeTruthy();
await expect(page.getByText('起点 1,200 两申请已提交银行审批')).toBeVisible();
```

- [ ] **Step 3: Run the focused web tests and verify RED**

Run:

```bash
npm test -- apps/web/app/components/app-router-client.test.ts
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/workbench.spec.ts -g "玩家端从快照展示并申请非默认"
```

Expected: the source-contract test fails because the old second-step function and waiting states remain; the Playwright test fails because the success notice still says the bank must confirm the landing.

- [ ] **Step 4: Remove the second player submission step while keeping the initial sheet unchanged**

Delete the `startLanding` and `startLandingConfirmed` derivations, the `startId` field from the `trustedLandings` state shape and `trustLanding` input, and the `clearTrustedStart` and `requestStartReward` functions. Then change the success branch of `declareStartLanding` to:

```ts
if (result.ok) {
  setPanel(null);
  showNotice(
    `起点 ${formatMoney(snapshot.startReward)} 两申请已提交银行审批`,
  );
}
```

Delete `startLandingConfirmed` and `requestStartReward`. Render the start sheet with the same copy and button whenever it opens; do not render the old confirmed or waiting branches:

```tsx
{panel === "START" && (
  <ActionSheet title="精确停留起点" onClose={() => setPanel(null)}>
    <p className="sheet-copy">
      仅棋子精确停留起点可领取 {formatMoney(snapshot.startReward)} 两；经过起点或初始摆放不能申请。
    </p>
    <button
      className="primary"
      disabled={
        busy ||
        (snapshot.diceMode === "ELECTRONIC" && snapshot.turn?.total === undefined)
      }
      onClick={() => void declareStartLanding()}
    >
      {busy ? <LoaderCircle className="spin" /> : <MapPin />}
      声明停留起点
    </button>
  </ActionSheet>
)}
```

Keep the existing bank request-card expression unchanged:

```tsx
{(request.actualAmount ?? request.amount) !== 0 && (
  <small className="approval-action-amount">
    +{formatMoney(request.actualAmount ?? request.amount)}
  </small>
)}
```

This produces `+1,000` for a default `START_REWARD` request and uses the configured value for custom rooms.

- [ ] **Step 5: Run focused and regression tests**

Run:

```bash
npm test -- apps/web/app/components/app-router-client.test.ts apps/web/app/components/bank-pending-approvals.test.ts
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/workbench.spec.ts -g "玩家端从快照展示并申请非默认"
npm run typecheck
```

Expected: all commands PASS; the player makes one start request and the bank renderer retains the amount label under the checkmark.

- [ ] **Step 6: Commit the player and bank regression coverage**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts tests/e2e/workbench.spec.ts
git commit -m "fix(web): collapse start reward submission"
```

---

### Task 3: Final Cross-Layer Verification

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes: the atomic start command and existing bank request approval path.
- Produces: evidence that API, web, types, and formatting remain valid together.

- [ ] **Step 1: Run all focused tests together**

```bash
npm run test:integration -- -t "start landing|start reward|起点"
npm test -- apps/web/app/components/app-router-client.test.ts apps/web/app/components/bank-pending-approvals.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository static checks**

```bash
npm run typecheck
npm run lint
git diff --check
```

Expected: PASS with no type, lint, or whitespace errors introduced by this change.

- [ ] **Step 3: Inspect the scoped diff**

```bash
git diff HEAD~2 -- apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts tests/e2e/workbench.spec.ts
```

Expected: only the start-reward state flow, its UI success state, and focused tests changed; unrelated dirty-worktree edits remain intact.
