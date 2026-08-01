# Physical Landing Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the current physical landing across reloads and workbench navigation, allow several legal events to share one landing, and close the previous confirmed landing only when the player declares the next physical move.

**Architecture:** Add `CLOSED` as the non-destructive terminal state for a normally superseded physical landing. The API continues to accept new actions only from `CONFIRMED` landings, but it may finish an already-created request whose landing later became `CLOSED`; explicit correction or bank invalidation uses `INVALIDATED` and cancels dependent pending requests. The player UI derives its current landing entirely from the authoritative snapshot instead of component memory.

**Tech Stack:** TypeScript, Prisma 6.19, PostgreSQL, Fastify, React 19, Next.js, Vitest, Playwright, Docker Compose

## Global Constraints

- One landing declaration represents one physical board move, not one downstream event.
- Several legal event types may share one `landingId`; completing the first event must not close the landing.
- Reload, reconnect, seat management, and player/bank workbench switching must not mutate landing state.
- A new declaration replaces an unconfirmed `DECLARED` landing with `INVALIDATED`, but normally supersedes a `CONFIRMED` landing with `CLOSED`.
- `CLOSED` prevents new landing-bound actions while preserving requests submitted before closure; `INVALIDATED` cancels dependent pending requests.
- Electronic dice mode continues to use `turnId` and existing turn invalidation rules.
- Do not add a mandatory “结束本次落点” action or browser storage.
- Preserve unrelated worktree changes and do not rewrite the large router component beyond the landing lifecycle paths.
- Start the application only through Docker Compose; npm commands remain permitted for tests, type checking, builds, and Prisma generation.

---

### Task 1: Add the Non-Destructive `CLOSED` Database State

**Files:**
- Modify: `packages/database/prisma/schema.prisma:129-133`
- Create: `packages/database/prisma/migrations/202608010017_physical_landing_lifecycle/migration.sql`
- Modify: `packages/database/src/database-contract.test.ts`

**Interfaces:**
- Consumes: existing Prisma enum `LandingEventStatus` with `DECLARED`, `CONFIRMED`, and `INVALIDATED`.
- Produces: Prisma enum member `LandingEventStatus.CLOSED` and an additive PostgreSQL migration.

- [ ] **Step 1: Add a failing database delivery contract**

Append this test to `packages/database/src/database-contract.test.ts`:

```ts
it('adds a non-destructive closed state for completed physical landing contexts', async () => {
  const [schema, migration] = await Promise.all([
    readDatabaseFile('prisma/schema.prisma'),
    readDatabaseFile(
      'prisma/migrations/202608010017_physical_landing_lifecycle/migration.sql',
    ),
  ]);

  expect(schema).toMatch(
    /enum LandingEventStatus \{[\s\S]*?DECLARED[\s\S]*?CONFIRMED[\s\S]*?CLOSED[\s\S]*?INVALIDATED[\s\S]*?\}/,
  );
  expect(migration).toContain(
    `ALTER TYPE "LandingEventStatus" ADD VALUE 'CLOSED' BEFORE 'INVALIDATED';`,
  );
});
```

- [ ] **Step 2: Run the contract and verify RED**

Run:

```bash
npm test -- packages/database/src/database-contract.test.ts
```

Expected: FAIL because the migration file does not exist and the Prisma enum has no `CLOSED` member.

- [ ] **Step 3: Add the schema member and additive migration**

Update the enum without changing the existing values:

```prisma
enum LandingEventStatus {
  DECLARED
  CONFIRMED
  CLOSED
  INVALIDATED
}
```

Create `packages/database/prisma/migrations/202608010017_physical_landing_lifecycle/migration.sql`:

```sql
ALTER TYPE "LandingEventStatus" ADD VALUE 'CLOSED' BEFORE 'INVALIDATED';
```

- [ ] **Step 4: Regenerate Prisma and verify the database contract**

Run:

```bash
npm run db:generate
npm test -- packages/database/src/database-contract.test.ts
npm run build -w @zhenhuan/database
```

Expected: Prisma generation succeeds, the database contract passes, and the database package builds with the new enum member.

- [ ] **Step 5: Commit the schema boundary**

```bash
git add packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/202608010017_physical_landing_lifecycle/migration.sql \
  packages/database/src/database-contract.test.ts
git commit -m "feat(database): add closed landing state"
```

---

### Task 2: Separate Physical Landing Closure from Invalidation

**Files:**
- Modify: `apps/api/src/prisma-game-service.integration.test.ts:475-490, 2039-2062`
- Modify: `apps/api/src/prisma-game-service.ts:313-355, 505-515, 991-996`

**Interfaces:**
- Consumes: `LandingEventStatus.CLOSED` from Task 1; existing `declareLanding`, `declareStartLanding`, `createRequest`, `payToll`, `approve`, and `cancelLandingPropertyActions` service methods.
- Produces: `advancePhysicalLanding(tx, roomId, playerId): Promise<void>`; normally superseded confirmed landings become `CLOSED`, corrected declarations and bank-invalidated landings become `INVALIDATED`, and approvals accept pre-existing physical requests linked to `CONFIRMED | CLOSED`.

- [ ] **Step 1: Replace the old destructive replacement test with the desired lifecycle test**

Replace `invalidates a player physical landing and its pending request when a new landing is declared` with:

```ts
it('closes a confirmed physical landing without cancelling its submitted request', async () => {
  const { room, a, bank } = await physicalRoom();
  const oldLanding = await firstDb.landingEvent.findFirstOrThrow({
    where: {
      roomId: room.id,
      playerId: a.playerId,
      status: 'CONFIRMED',
      property: { definition: { name: '甘露寺' } },
    },
  });
  const pending = await first.createRequest(
    room.id,
    a.playerId,
    { type: 'BUY_PROPERTY', propertyName: '甘露寺' },
    'buy-before-next-physical-move',
  );

  const nextLanding = await first.declareLanding(
    room.id,
    a.playerId,
    '景仁宫',
    a.token,
    'next-physical-move',
  );

  expect(await firstDb.landingEvent.findUniqueOrThrow({
    where: { id: oldLanding.id },
  })).toMatchObject({ status: 'CLOSED', propertyActionsCancelled: false });
  expect(await firstDb.landingEvent.findUniqueOrThrow({
    where: { id: nextLanding.id },
  })).toMatchObject({ status: 'DECLARED' });
  expect(await firstDb.gameRequest.findUniqueOrThrow({
    where: { id: pending.id },
  })).toMatchObject({ status: 'PENDING', landingEventId: oldLanding.id });

  await expect(
    first.approve(room.id, pending.id, bank.token, 'approve-closed-landing-request'),
  ).resolves.toMatchObject({ status: 'EXECUTED' });
});
```

Add focused tests for correction, stale action rejection, and bank invalidation:

```ts
it('invalidates an unconfirmed physical declaration when the player corrects it', async () => {
  const { room, a } = await physicalRoom();
  const confirmed = await firstDb.landingEvent.findFirstOrThrow({
    where: { roomId: room.id, playerId: a.playerId, status: 'CONFIRMED' },
  });
  await firstDb.landingEvent.update({
    where: { id: confirmed.id },
    data: { status: 'INVALIDATED', invalidatedAt: new Date() },
  });

  const firstDeclaration = await first.declareLanding(
    room.id, a.playerId, '甘露寺', a.token, 'physical-correction-first',
  );
  const corrected = await first.declareLanding(
    room.id, a.playerId, '景仁宫', a.token, 'physical-correction-second',
  );

  expect(await firstDb.landingEvent.findUniqueOrThrow({
    where: { id: firstDeclaration.id },
  })).toMatchObject({ status: 'INVALIDATED' });
  expect(corrected).toMatchObject({ status: 'DECLARED' });
});

it('does not use a closed physical landing for a new toll payment', async () => {
  const { room, a, b } = await physicalRoom();
  await firstDb.roomProperty.updateMany({
    where: { roomId: room.id, definition: { name: '甘露寺' } },
    data: { ownerPlayerId: b.playerId },
  });
  const oldLanding = await firstDb.landingEvent.findFirstOrThrow({
    where: { roomId: room.id, playerId: a.playerId, status: 'CONFIRMED' },
  });
  await first.declareLanding(
    room.id, a.playerId, '景仁宫', a.token, 'close-before-toll',
  );

  await expect(
    first.payToll(room.id, a.playerId, '甘露寺', 'late-physical-toll'),
  ).rejects.toThrow('CONFIRMED_LANDING_REQUIRED');
  expect(await firstDb.landingEvent.findUniqueOrThrow({
    where: { id: oldLanding.id },
  })).toMatchObject({ status: 'CLOSED' });
});

it('invalidates a bank-cancelled landing and cancels its pending request', async () => {
  const { room, a, bank } = await physicalRoom();
  const landing = await firstDb.landingEvent.findFirstOrThrow({
    where: { roomId: room.id, playerId: a.playerId, status: 'CONFIRMED' },
  });
  const request = await first.createRequest(
    room.id,
    a.playerId,
    { type: 'BUY_PROPERTY', propertyName: '甘露寺' },
    'buy-before-bank-invalidation',
  );

  await first.cancelLandingPropertyActions(
    room.id, landing.id, bank.token, '现场落点有误', 'invalidate-landing',
  );

  expect(await firstDb.landingEvent.findUniqueOrThrow({
    where: { id: landing.id },
  })).toMatchObject({
    status: 'INVALIDATED',
    propertyActionsCancelled: true,
    invalidatedAt: expect.any(Date),
  });
  expect(await firstDb.gameRequest.findUniqueOrThrow({
    where: { id: request.id },
  })).toMatchObject({ status: 'CANCELLED' });
});

it('keeps a confirmed physical landing active after one landing event', async () => {
  const { room, a, b } = await physicalRoom();
  await firstDb.roomProperty.updateMany({
    where: { roomId: room.id, definition: { name: '甘露寺' } },
    data: { ownerPlayerId: b.playerId },
  });
  const landing = await firstDb.landingEvent.findFirstOrThrow({
    where: { roomId: room.id, playerId: a.playerId, status: 'CONFIRMED' },
  });

  await first.payToll(room.id, a.playerId, '甘露寺', 'first-shared-landing-event');

  expect(await firstDb.landingEvent.findUniqueOrThrow({
    where: { id: landing.id },
  })).toMatchObject({ status: 'CONFIRMED' });
  expect((await first.snapshot(room.id)).landings).toContainEqual(
    expect.objectContaining({ id: landing.id, status: 'CONFIRMED', tollSettled: true }),
  );
});

it('serializes physical landing confirmation against the next declaration', async () => {
  const { room, a, bank } = await physicalRoom();
  const pending = await first.declareLanding(
    room.id, a.playerId, '景仁宫', a.token, 'physical-race-pending',
  );

  const attempts = await Promise.allSettled([
    first.confirmLanding(
      room.id, pending.id, bank.token, true, 'physical-race-confirm',
    ),
    second.declareLanding(
      room.id, a.playerId, '永寿宫', a.token, 'physical-race-next',
    ),
  ]);
  if (attempts[1].status === 'rejected') {
    await second.declareLanding(
      room.id, a.playerId, '永寿宫', a.token, 'physical-race-next-retry',
    );
  }

  expect(await firstDb.landingEvent.count({
    where: {
      roomId: room.id,
      playerId: a.playerId,
      turnId: null,
      status: { in: ['DECLARED', 'CONFIRMED'] },
    },
  })).toBe(1);
});
```

- [ ] **Step 2: Run the focused integration tests and verify RED**

Run:

```bash
npm run test:integration -- -t "closes a confirmed physical landing|invalidates an unconfirmed physical declaration|does not use a closed physical landing|invalidates a bank-cancelled landing|keeps a confirmed physical landing active|serializes physical landing confirmation"
```

Expected: FAIL because confirmed physical landings are currently invalidated, their pending requests are cancelled, and bank cancellation does not set the lifecycle status to `INVALIDATED`.

- [ ] **Step 3: Replace destructive physical invalidation with a state-aware transition**

Replace `invalidatePhysicalLandings` with:

```ts
private async advancePhysicalLanding(
  tx: Prisma.TransactionClient,
  roomId: string,
  playerId: string,
) {
  const active = await tx.landingEvent.findMany({
    where: {
      roomId,
      playerId,
      turnId: null,
      status: { in: ['DECLARED', 'CONFIRMED'] },
    },
    select: { id: true, status: true },
  });
  const declaredIds = active
    .filter((landing) => landing.status === 'DECLARED')
    .map((landing) => landing.id);
  const confirmedIds = active
    .filter((landing) => landing.status === 'CONFIRMED')
    .map((landing) => landing.id);

  for (const landingId of declaredIds) {
    await this.cancelPendingRequests(
      tx,
      roomId,
      { landingEventId: landingId },
      'PHYSICAL_LANDING_CORRECTED',
    );
  }
  if (declaredIds.length) {
    await tx.landingEvent.updateMany({
      where: { id: { in: declaredIds }, status: 'DECLARED' },
      data: { status: 'INVALIDATED', invalidatedAt: new Date() },
    });
  }
  if (confirmedIds.length) {
    await tx.landingEvent.updateMany({
      where: { id: { in: confirmedIds }, status: 'CONFIRMED' },
      data: { status: 'CLOSED' },
    });
  }
}
```

Call `advancePhysicalLanding` from both `declareLanding` and `declareStartLanding`. Do not call `cancelPendingRequests` for `confirmedIds`.

- [ ] **Step 4: Make explicit bank cancellation destructive**

In `cancelLandingPropertyActions`, keep the existing reason, audit, request cancellation, property unlock, and Toast behavior, but change the landing update to:

```ts
const after = await tx.landingEvent.update({
  where: { id: landingId },
  data: {
    status: 'INVALIDATED',
    invalidatedAt: new Date(),
    propertyActionsCancelled: true,
    plotResolved: true,
  },
});
```

Update the existing idempotent cancellation assertion to include `status: 'INVALIDATED'`.

- [ ] **Step 5: Allow approval of requests created before normal closure**

In the `BUY_PROPERTY` / `BUILD_PROPERTY` approval guard, calculate the allowed status by dice mode:

```ts
const landing = request.landingEvent;
const landingStatusAccepted = request.room.diceMode === 'PHYSICAL'
  ? landing?.status === 'CONFIRMED' || landing?.status === 'CLOSED'
  : landing?.status === 'CONFIRMED';
if (
  !landing ||
  landing.roomId !== roomId ||
  landing.playerId !== request.actorPlayerId ||
  landing.propertyId !== request.propertyId ||
  !landingStatusAccepted ||
  !landing.plotResolved ||
  landing.propertyActionsCancelled ||
  (request.room.diceMode === 'ELECTRONIC'
    ? landing.turnId !== activeTurn?.id
    : landing.turnId !== null)
) fail('CONFIRMED_LANDING_REQUIRED');
```

Do not broaden `createRequest` or `payToll`: both must continue querying only `status: 'CONFIRMED'`, which prevents new operations on `CLOSED` evidence. Do not change electronic approval to accept `CLOSED`.

- [ ] **Step 6: Verify the service lifecycle and full integration suite**

Run:

```bash
npm run test:integration -- -t "physical landing|bank-cancelled landing|landing confirmation and cancellation"
npm run test:integration
npm run typecheck
```

Expected: focused tests and the full integration suite pass; type checking accepts the generated `CLOSED` enum. Existing electronic landing, reroll, end-turn, toll idempotency, and request cancellation tests remain green.

- [ ] **Step 7: Commit the service lifecycle**

```bash
git add apps/api/src/prisma-game-service.ts \
  apps/api/src/prisma-game-service.integration.test.ts
git commit -m "fix(api): preserve closed physical landings"
```

---

### Task 3: Restore the Player Landing from the Authoritative Snapshot

**Files:**
- Create: `apps/web/app/components/landing-lifecycle.ts`
- Create: `apps/web/app/components/landing-lifecycle.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx:140-150, 4887-4893, 4987-5109, 5160-5232, 5507-5523`
- Modify: `apps/web/app/components/app-router-client.test.ts:67-73`
- Modify: `tests/e2e/task7-workflows.spec.ts:189-233`
- Modify: `tests/e2e/workbench.spec.ts:307-385`

**Interfaces:**
- Consumes: player snapshots containing active `DECLARED | CONFIRMED` landings ordered newest first; `snapshot.turn?.id` for electronic mode.
- Produces: `selectCurrentLanding<T extends LandingLifecycleCandidate>(landings, options): T | undefined`; player UI that restores physical property and start landings without `trustedLandings`.

- [ ] **Step 1: Add failing unit tests for current-landing selection**

Create `apps/web/app/components/landing-lifecycle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { selectCurrentLanding } from './landing-lifecycle';

const base = {
  playerId: 'player-1',
  spaceType: 'PROPERTY',
  propertyActionsCancelled: false,
};

describe('selectCurrentLanding', () => {
  it('restores a null-turn physical landing directly from the snapshot', () => {
    const declared = { ...base, id: 'physical-declared', status: 'DECLARED' as const };
    const confirmed = { ...base, id: 'physical-confirmed', status: 'CONFIRMED' as const };

    expect(selectCurrentLanding([declared], {
      playerId: 'player-1',
      spaceType: 'PROPERTY',
    })).toEqual(declared);
    expect(selectCurrentLanding([confirmed], {
      playerId: 'player-1',
      spaceType: 'PROPERTY',
    })).toEqual(confirmed);
  });

  it('restores a physical start landing with the same selector', () => {
    const start = {
      ...base,
      id: 'physical-start',
      spaceType: 'START',
      status: 'CONFIRMED' as const,
    };

    expect(selectCurrentLanding([start], {
      playerId: 'player-1',
      spaceType: 'START',
    })).toEqual(start);
  });

  it('uses only the active turn landing in electronic mode', () => {
    const stale = { ...base, id: 'stale', turnId: 'turn-1', status: 'CONFIRMED' as const };
    const current = { ...base, id: 'current', turnId: 'turn-2', status: 'CONFIRMED' as const };

    expect(selectCurrentLanding([stale, current], {
      playerId: 'player-1',
      spaceType: 'PROPERTY',
      activeTurnId: 'turn-2',
    })).toEqual(current);
  });

  it('rejects closed, invalidated, cancelled, wrong-player, and wrong-space entries', () => {
    const candidates = [
      { ...base, id: 'closed', status: 'CLOSED' as const },
      { ...base, id: 'invalid', status: 'INVALIDATED' as const },
      { ...base, id: 'cancelled', status: 'CONFIRMED' as const, propertyActionsCancelled: true },
      { ...base, id: 'other-player', status: 'CONFIRMED' as const, playerId: 'player-2' },
      { ...base, id: 'start', status: 'CONFIRMED' as const, spaceType: 'START' },
    ];

    expect(selectCurrentLanding(candidates, {
      playerId: 'player-1',
      spaceType: 'PROPERTY',
    })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the selector test and verify RED**

Run:

```bash
npm test -- apps/web/app/components/landing-lifecycle.test.ts
```

Expected: FAIL because `landing-lifecycle.ts` and `selectCurrentLanding` do not exist.

- [ ] **Step 3: Implement the focused selector**

Create `apps/web/app/components/landing-lifecycle.ts`:

```ts
export type LandingLifecycleCandidate = {
  playerId: string;
  spaceType: string;
  status: 'DECLARED' | 'CONFIRMED' | 'CLOSED' | 'INVALIDATED';
  propertyActionsCancelled: boolean;
  turnId?: string;
};

export function selectCurrentLanding<T extends LandingLifecycleCandidate>(
  landings: readonly T[] | undefined,
  options: {
    playerId: string;
    spaceType: string;
    activeTurnId?: string;
  },
): T | undefined {
  return landings?.find((landing) =>
    landing.playerId === options.playerId &&
    landing.spaceType === options.spaceType &&
    (landing.status === 'DECLARED' || landing.status === 'CONFIRMED') &&
    !landing.propertyActionsCancelled &&
    (landing.turnId === undefined || landing.turnId === options.activeTurnId),
  );
}
```

Run:

```bash
npm test -- apps/web/app/components/landing-lifecycle.test.ts
```

Expected: PASS for physical restoration, electronic turn scoping, and excluded terminal/cancelled candidates.

- [ ] **Step 4: Remove component-memory landing trust from `PlayerView`**

Import the selector and expand the local `Landing.status` union so terminal values remain type-safe if a request-linked historical landing appears:

```ts
import { selectCurrentLanding } from './landing-lifecycle';

type Landing = {
  id: string;
  playerId: string;
  propertyName?: string;
  spaceType: string;
  status: 'DECLARED' | 'CONFIRMED' | 'CLOSED' | 'INVALIDATED';
  plotResolved: boolean;
  propertyActionsCancelled: boolean;
  tollSettled?: boolean;
  turnId?: string;
  createdAt?: string;
};
```

Delete the `trustedLandings` `useState` declaration, its `turnKey` reset effect, and the complete `trustLanding`, `clearTrustedStart`, and `clearTrustedProperty` function declarations. After replacing the two selectors below, remove `turnKey` as well because no remaining player-view expression may depend on it.

Replace the property and start selection with:

```ts
const currentLanding = selectCurrentLanding(snapshot.landings, {
  playerId,
  spaceType: 'PROPERTY',
  activeTurnId: snapshot.turn?.id,
});
const startLanding = selectCurrentLanding(snapshot.landings, {
  playerId,
  spaceType: 'START',
  activeTurnId: snapshot.turn?.id,
});
```

In `confirmLanding` and `declareStartLanding`, close the panel and show the existing success notice after the authoritative `action` refresh, but do not remember the returned ID in local state. Remove `clearTrustedProperty()` after a purchase/build request and `clearTrustedStart()` after a start reward request: submitting one event must not hide the shared landing context.

Render the status only from `currentLanding`. Use the existing toll decision to distinguish required work from a completed/optional landing:

```ts
const landingNeedsAttention = currentLanding?.status === 'CONFIRMED' && (
  !currentLanding.plotResolved || tollDisabledReason === null
);
const landingStatusLabel = currentLanding?.status === 'DECLARED'
  ? '落点待银行确认'
  : landingNeedsAttention
    ? '本次落点'
    : '上次确认落点';
```

Render `landingStatusLabel` with `currentLanding.propertyName`. Keep `landingConfirmed` as the capability gate for legal downstream actions; the weaker “上次确认落点” copy must not disable optional purchase, build, or event operations.

- [ ] **Step 5: Update source-contract assertions**

Replace the old fixed confirmation-copy test in `app-router-client.test.ts` with assertions that lock the authoritative selector and forbid browser-only trust:

```ts
test('restores the current landing from the room snapshot', async () => {
  const component = await readFile(fileURLToPath(componentUrl), 'utf8');

  expect(component).toContain('selectCurrentLanding(snapshot.landings');
  expect(component).toContain('? "落点待银行确认"');
  expect(component).toContain('? "本次落点"');
  expect(component).toContain(': "上次确认落点"');
  expect(component).not.toContain('trustedLandings');
  expect(component).not.toContain('setTrustedLandings');
});
```

- [ ] **Step 6: Add a reload regression to the mocked player workflow**

In `tests/e2e/task7-workflows.spec.ts`, add:

```ts
test('physical landing survives a full page reload without browser storage', async ({ page }) => {
  const properties = [{
    name: '碎玉轩', ownerId: null, level: 0, mortgaged: false,
    mortgage: 800, purchasePrice: 1600, build: 1000,
    buildingSell: 600, tolls: [300, 700, 1800, 5000, 7000, 9000],
  }];
  const landing = {
    id: 'persisted-physical-landing',
    playerId: 'player-1',
    propertyName: '碎玉轩',
    spaceType: 'PROPERTY',
    status: 'DECLARED',
    plotResolved: false,
    propertyActionsCancelled: false,
    tollSettled: false,
  };
  await mockBase(page, { ...baseRoom, isBank: false });
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({
    json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }),
  }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({
    json: { ...snapshot, properties, landings: [landing] },
  }));

  await openRoom(page);
  await expect(page.getByText('落点待银行确认：碎玉轩')).toBeVisible();
  await page.reload();
  await expect(page.getByText('落点待银行确认：碎玉轩')).toBeVisible();
  expect(await page.evaluate(() => [
    ...Object.entries(localStorage),
    ...Object.entries(sessionStorage),
  ].filter(([key, value]) => /landing/i.test(`${key}:${value}`)))).toEqual([]);
});
```

- [ ] **Step 7: Extend dual-workbench and seat-management coverage**

In the existing `兼任成员可切换玩家端和银行端且快照请求显式携带视图` test, return a physical player snapshot containing the same confirmed null-turn landing whenever `view=PLAYER`. Assert the landing before switching to bank and after switching back:

```ts
const playerSnapshot = {
  ...snapshot,
  diceMode: 'PHYSICAL' as const,
  properties: [{
    name: '碎玉轩', ownerId: null, level: 0, mortgaged: false,
    mortgage: 800, purchasePrice: 1600, build: 1000,
    buildingSell: 600, tolls: [300, 700, 1800, 5000, 7000, 9000],
  }],
  landings: [{
    id: 'dual-role-landing', playerId: 'p1', propertyName: '碎玉轩',
    spaceType: 'PROPERTY', status: 'CONFIRMED', plotResolved: true,
    propertyActionsCancelled: false, tollSettled: false,
  }],
};
```

Use `view === 'PLAYER' ? playerSnapshot : snapshot` in the route response, then assert:

```ts
await expect(page.getByText('上次确认落点：碎玉轩')).toBeVisible();
await bankView.click();
// retain the existing bank snapshot assertions
await playerView.click();
await expect(page.getByText('上次确认落点：碎玉轩')).toBeVisible();
```

Add the same player snapshot to the existing “从玩家端管理席位后返回原工作台” fixture and assert the status before opening seat management and after “返回当前房间”. This proves component unmount/remount no longer erases the landing.

- [ ] **Step 8: Run unit, source-contract, and browser regressions**

Start or refresh the project only through Docker Compose, then run Playwright against port 3000:

```bash
npm test -- \
  apps/web/app/components/landing-lifecycle.test.ts \
  apps/web/app/components/app-router-client.test.ts
docker compose up -d --build
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test \
  tests/e2e/task7-workflows.spec.ts \
  tests/e2e/workbench.spec.ts
npm run typecheck
```

Expected: selector and source-contract tests pass; reload, player/bank/player switching, and seat-management return all restore the same physical landing; the full TypeScript build has no lifecycle union errors.

- [ ] **Step 9: Commit the player restoration behavior**

```bash
git add apps/web/app/components/landing-lifecycle.ts \
  apps/web/app/components/landing-lifecycle.test.ts \
  apps/web/app/components/app-router-client.tsx \
  apps/web/app/components/app-router-client.test.ts \
  tests/e2e/task7-workflows.spec.ts \
  tests/e2e/workbench.spec.ts
git commit -m "fix(web): restore physical landing from snapshot"
```

---

## Final Verification

- [ ] Apply the migration to the test stack and confirm all services are healthy:

```bash
docker compose up -d --build
docker compose ps
```

Expected: database, API, and Web services are running or healthy on the configured ports; Web remains on port 3000.

- [ ] Run the complete relevant verification set:

```bash
npm test -- \
  packages/database/src/database-contract.test.ts \
  apps/web/app/components/landing-lifecycle.test.ts \
  apps/web/app/components/app-router-client.test.ts
npm run test:integration
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test \
  tests/e2e/task7-workflows.spec.ts \
  tests/e2e/workbench.spec.ts
npm run lint
npm run typecheck
git diff --check
```

Expected: every command exits zero; no electronic landing, request approval, toll, refresh recovery, or workbench navigation regression remains.

- [ ] Inspect the final diff for scope and lifecycle invariants:

```bash
git diff --stat HEAD~3
git diff HEAD~3 -- \
  packages/database/prisma/schema.prisma \
  packages/database/prisma/migrations/202608010017_physical_landing_lifecycle/migration.sql \
  packages/database/src/database-contract.test.ts \
  apps/api/src/prisma-game-service.ts \
  apps/api/src/prisma-game-service.integration.test.ts \
  apps/web/app/components/landing-lifecycle.ts \
  apps/web/app/components/landing-lifecycle.test.ts \
  apps/web/app/components/app-router-client.tsx \
  apps/web/app/components/app-router-client.test.ts \
  tests/e2e/task7-workflows.spec.ts \
  tests/e2e/workbench.spec.ts
```

Expected: only the schema/migration, focused service lifecycle, player selector, and targeted regressions changed; no browser persistence or mandatory close action was introduced.
