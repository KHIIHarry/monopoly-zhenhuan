# 落点绑定的过路费支付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move toll payment into a dedicated high-frequency player action that automatically settles only the confirmed property landing and explains every disabled state.

**Architecture:** Extend the existing room snapshot with a derived `Landing.tollSettled` value so the UI remains correct after a refresh or reversal. `PlayerView` derives its toll target and eligibility exclusively from the confirmed landing, while the asset sheet drops its toll mode. The existing toll endpoint and `PrismaGameService.payToll` validation remain the authority for payment correctness.

**Tech Stack:** TypeScript, Next.js, React, Prisma, Vitest, Playwright.

## Global Constraints

- Keep `POST /api/rooms/:id/properties/:name/toll`, `PrismaGameService.payToll`, its idempotency scope, and its confirmed-landing validation unchanged.
- `tollSettled` is true only for a committed toll transaction for that exact landing; it must become false after the transaction is reversed.
- The quick-action order is “购买 / 建造”, “支付过路费”, “资产操作”; all following actions retain their relative order.
- The toll sheet has no property selector. It shows the confirmed landing property, owner, building level, and amount when those values exist.
- The toll entry remains available when ineligible. Its submit button is disabled with one deterministic reason.
- Remove `PAY_TOLL` from the asset-mode type, select options, target filtering, settlement preview, submit branch, and asset-sheet title.
- Do not alter `transferIsPlotFine`, `estimatedTransferAmount`, `plotFineReduction`, the transfer request body, or any 沈眉庄剧情罚款 UI and behavior.

---

## File Structure

- Modify: `apps/api/src/prisma-game-service.ts` - expose a derived, read-only toll settlement flag with each snapshot landing.
- Modify: `apps/api/src/prisma-game-service.integration.test.ts` - prove snapshot settlement state follows a payment and its reversal.
- Modify: `apps/web/app/components/app-router-client.tsx` - render and submit the dedicated landing-bound toll action; remove the asset-sheet toll mode.
- Modify: `tests/e2e/task7-workflows.spec.ts` - prove the player workflow is landing-bound, ordered, and disabled correctly.
- Reuse: `tests/e2e/task7-contract.spec.ts` - retain the existing 沈眉庄剧情罚款 transfer regression unchanged and run it as part of validation.

### Task 1: Expose Committed Toll State in Snapshots

**Files:**
- Modify: `apps/api/src/prisma-game-service.integration.test.ts:1886-1896`
- Modify: `apps/api/src/prisma-game-service.ts:119-194`

**Interfaces:**
- Consumes: visible `room.landingEvents`, `tollSettlementState(tx, roomId, landingId)`, and the existing `GameTransaction` status.
- Produces: each snapshot landing has `tollSettled: boolean`; true means only `tollSettlementState(...).status === 'COMMITTED'`.

- [ ] **Step 1: Write the failing integration regression**

Add this test immediately before `it('derives the active build discount in snapshots', ...)`:

```ts
it('derives committed toll settlement state for each visible landing', async () => {
  const { room, a, b, bank } = await physicalRoom();
  await firstDb.roomProperty.updateMany({
    where: { roomId: room.id, definition: { name: '甘露寺' } },
    data: { ownerPlayerId: b.playerId },
  });
  const landing = await firstDb.landingEvent.findFirstOrThrow({
    where: { roomId: room.id, playerId: a.playerId, property: { definition: { name: '甘露寺' } } },
  });

  expect((await first.snapshot(room.id)).landings.find((item) => item.id === landing.id)).toMatchObject({
    tollSettled: false,
  });
  const payment = await first.payToll(room.id, a.playerId, '甘露寺', 'snapshot-toll-payment');
  expect((await first.snapshot(room.id)).landings.find((item) => item.id === landing.id)).toMatchObject({
    tollSettled: true,
  });
  await first.reverseLatest(room.id, payment.id, bank.token, '测试冲正', 'reverse-snapshot-toll');
  expect((await first.snapshot(room.id)).landings.find((item) => item.id === landing.id)).toMatchObject({
    tollSettled: false,
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing field fails**

Run:

```bash
npx vitest run apps/api/src/prisma-game-service.integration.test.ts --testNamePattern="derives committed toll settlement state"
```

Expected: FAIL because snapshot landing objects do not contain `tollSettled`.

- [ ] **Step 3: Derive `tollSettled` in the snapshot transaction**

After `const tollBlockedPlayerIds = ...` in `PrismaGameService.snapshot`, add a map for confirmed visible landings:

```ts
const tollSettlementStates = new Map(
  await Promise.all(
    room.landingEvents
      .filter((landing) => landing.status === 'CONFIRMED')
      .map(async (landing) => [
        landing.id,
        (await this.tollSettlementState(tx, roomId, landing.id)).status,
      ] as const),
  ),
);
```

Then extend the existing `landings` mapping only:

```ts
landings: room.landingEvents.map((landing) => ({
  id: landing.id,
  turnId: landing.turnId ?? undefined,
  playerId: landing.playerId,
  propertyName: landing.property?.definition.name,
  spaceType: landing.spaceType,
  status: landing.status,
  plotResolved: landing.plotResolved,
  propertyActionsCancelled: landing.propertyActionsCancelled,
  tollSettled: tollSettlementStates.get(landing.id) === 'COMMITTED',
})),
```

Do not add a database column or touch `payToll`; `tollSettlementState` already correctly distinguishes committed and reversed transactions.

- [ ] **Step 4: Run the focused test and its adjacent snapshot regressions**

Run:

```bash
npx vitest run apps/api/src/prisma-game-service.integration.test.ts --testNamePattern="committed toll settlement state|active build discount|configured toll bonus"
```

Expected: PASS; the new snapshot field changes from false to true after payment and returns false after reversal.

- [ ] **Step 5: Commit the server contract change**

```bash
git add apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts
git commit -m "feat: expose settled toll landings in snapshots"
```

Expected: one commit containing only the snapshot response extension and its integration regression.

### Task 2: Replace the Asset Toll Mode with a Landing-Bound Toll Sheet

**Files:**
- Modify: `tests/e2e/task7-workflows.spec.ts:189-307`
- Modify: `apps/web/app/components/app-router-client.tsx:117-126,4660-5033,5270-5315,5513-5627`

**Interfaces:**
- Consumes: `currentLanding`, `landingConfirmed`, `landingProperty`, `Landing.tollSettled`, `snapshot.players`, `currentPropertyToll`, and `booleanRoomAction(action)`.
- Produces: panel value `'TOLL'`, `tollDisabledReason: string | null`, `canPayToll: boolean`, and `payLandingToll(): Promise<void>`.

- [ ] **Step 1: Write failing browser regressions for the dedicated action**

In `tests/e2e/task7-workflows.spec.ts`, add a workflow test after the existing confirmed-landing property-action test. Mock an electronic turn for `player-1`, one confirmed property landing named `甘露寺`, and a separate property `景仁宫`. Let `甘露寺` be owned by `player-2` at level two with tolls `[300, 700, 1_800, 5_000, 7_000, 9_000]`; include `{ id: 'player-2', name: '皇后', characterId: 'yixiu', balance: 5_000, remainingSkipTurns: 0 }` in `players`.

Use these assertions and request capture:

```ts
await openRoom(page);
const quickLabels = await page.locator('.quick-grid .quick').evaluateAll((buttons) =>
  buttons.map((button) => button.textContent?.trim()),
);
expect(quickLabels.indexOf('支付过路费')).toBe(quickLabels.indexOf('资产操作') - 1);

await page.getByRole('button', { name: '资产操作' }).click();
const assetSheet = page.getByRole('dialog', { name: '资产操作' });
await expect(assetSheet.getByRole('option', { name: '支付过路费' })).toHaveCount(0);
await assetSheet.getByRole('button', { name: '关闭' }).click();

await page.getByRole('button', { name: '支付过路费' }).click();
const tollSheet = page.getByRole('dialog', { name: '支付过路费' });
await expect(tollSheet.getByLabel('目标地产')).toHaveCount(0);
await expect(tollSheet.getByText('甘露寺', { exact: true })).toBeVisible();
await expect(tollSheet.getByText('皇后', { exact: true })).toBeVisible();
await expect(tollSheet.getByText('1,800 两', { exact: true })).toBeVisible();
await tollSheet.getByRole('button', { name: '确认支付过路费' }).click();
expect(tollRequests).toEqual(['/api/rooms/room-1/properties/%E7%94%98%E9%9C%B2%E5%AF%BA/toll']);
```

Make the snapshot route read `let tollCase = 'payable'` and return the matching entries from the following complete fixture. For each disabled case, reload, open “支付过路费”, and assert the panel remains open, the listed message is visible, and the payment button is disabled:

```ts
const disabledCases = {
  'no-landing': { landings: [], property: payableProperty, players: payablePlayers, reason: '请先声明该地产落点，并由银行确认剧情已结算。' },
  unowned: { landings: [{ ...landing, tollSettled: false }], property: { ...payableProperty, ownerId: null }, players: payablePlayers, reason: '当前落点为无主地产，无需支付过路费。' },
  'self-owned': { landings: [{ ...landing, tollSettled: false }], property: { ...payableProperty, ownerId: 'player-1' }, players: payablePlayers, reason: '当前落点归你所有，无需支付过路费。' },
  mortgaged: { landings: [{ ...landing, tollSettled: false }], property: { ...payableProperty, mortgaged: true }, players: payablePlayers, reason: '当前落点地产已抵押，无需支付过路费。' },
  'owner-blocked': { landings: [{ ...landing, tollSettled: false }], property: payableProperty, players: [{ ...payablePlayers[0] }, { ...payablePlayers[1], tollCollectionBlocked: true }], reason: '地主正在冷宫中，本次免过路费。' },
  settled: { landings: [{ ...landing, tollSettled: true }], property: payableProperty, players: payablePlayers, reason: '本次过路费已经结算。' },
} as const;

for (const [name, fixture] of Object.entries(disabledCases)) {
  tollCase = name;
  await page.reload();
  await page.getByRole('button', { name: '支付过路费' }).click();
  const sheet = page.getByRole('dialog', { name: '支付过路费' });
  await expect(sheet.getByText(fixture.reason, { exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: '确认支付过路费' })).toBeDisabled();
}
```

The snapshot route must build `properties` as `[fixture.property, otherProperty]`, use `fixture.players`, and use `fixture.landings` for the active `tollCase`. This test proves there is no manual target selection and that refresh-derived `tollSettled` disables payment.

- [ ] **Step 2: Run the new Playwright test to verify current behavior fails**

Run:

```bash
npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium --grep="landing-bound toll payment"
```

Expected: FAIL because no “支付过路费” quick action exists and the asset sheet still contains the toll option and property selector.

- [ ] **Step 3: Add landing-derived toll eligibility and submission**

Extend `Landing` with an optional backward-compatible field so existing mocks remain valid:

```ts
tollSettled?: boolean;
```

Add `'TOLL'` to the `panel` union. After the existing `landingProperty` calculation, derive the owner, amount, deterministic reason, and boolean in this priority order:

```ts
const tollOwner = landingProperty?.ownerId
  ? snapshot.players.find((player) => player.id === landingProperty.ownerId)
  : undefined;
const tollAmount = landingProperty && tollOwner
  ? currentPropertyToll(landingProperty, snapshot.players)
  : 0;
const tollDisabledReason = !landingConfirmed
  ? '请先声明该地产落点，并由银行确认剧情已结算。'
  : !landingProperty
    ? '当前落点地产不存在，请刷新后重试。'
    : !landingProperty.ownerId
      ? '当前落点为无主地产，无需支付过路费。'
      : landingProperty.ownerId === me?.id
        ? '当前落点归你所有，无需支付过路费。'
        : landingProperty.mortgaged
          ? '当前落点地产已抵押，无需支付过路费。'
          : tollOwner?.tollCollectionBlocked
            ? '地主正在冷宫中，本次免过路费。'
            : currentLanding?.tollSettled
              ? '本次过路费已经结算。'
              : tollAmount <= 0
                ? '当前无需支付过路费。'
                : null;
const canPayToll = tollDisabledReason === null;
```

Add the dedicated submitter; it must use the derived landing name, never a mutable property state:

```ts
async function payLandingToll() {
  if (!landingProperty || !canPayToll) return;
  const ok = await idempotentAction(
    `/api/rooms/${snapshot.id}/properties/${encodeURIComponent(landingProperty.name)}/toll`,
    { playerId },
  );
  if (ok) {
    setPanel(null);
    showNotice('过路费已结算');
  }
}
```

- [ ] **Step 4: Remove toll from the asset state machine and render the new sheet**

Make these exact structural changes in `PlayerView`:

```tsx
const [assetMode, setAssetMode] = useState<
  | 'SELL_BUILDING'
  | 'MORTGAGE_PROPERTY'
  | 'REDEEM_PROPERTY'
  | 'SELL_PROPERTY_TO_BANK'
  | 'TRADE_PROPERTY'
>('SELL_BUILDING');
```

Delete the `assetMode === 'PAY_TOLL'` branch from `assetProperties`, delete the final toll fallback from `assetSettlement`, and simplify `submitAssetAction()` to always send the existing `/requests` payload. It must no longer call `clearTrustedProperty()` or use toll-specific completion copy.

Insert the quick action directly before “资产操作”:

```tsx
<Quick
  icon={<CircleDollarSign />}
  label="支付过路费"
  disabled={busy || !canAct}
  onClick={() => setPanel('TOLL')}
/>
```

Rename the asset `ActionSheet` to `title="资产操作"` and remove its `PAY_TOLL` option, mismatch warning, and toll-specific disabled condition. Then add this new sheet before it:

```tsx
{panel === 'TOLL' && (
  <ActionSheet title="支付过路费" onClose={() => setPanel(null)}>
    {landingProperty && (
      <>
        <p className="cost-line"><span>落点地产</span><strong>{landingProperty.name}</strong></p>
        <p className="cost-line"><span>地产主人</span><strong>{tollOwner?.name ?? '未知玩家'}</strong></p>
        <p className="cost-line"><span>建筑等级</span><strong>{landingProperty.level} 级</strong></p>
        <p className="cost-line"><span>本次应付过路费</span><strong>{formatMoney(tollAmount)} 两</strong></p>
      </>
    )}
    {tollDisabledReason && <p className="error">{tollDisabledReason}</p>}
    <button className="primary" disabled={busy || !canPayToll} onClick={() => void payLandingToll()}>
      {busy ? <LoaderCircle className="spin" /> : <CircleDollarSign />}
      确认支付过路费
    </button>
  </ActionSheet>
)}
```

Keep the transfer state and JSX unchanged, including the 沈眉庄 checkbox, `estimatedTransferAmount`, and `{ isPlotFine: isMeizhuang && transferIsPlotFine }` request payload.

- [ ] **Step 5: Run browser tests for the new workflow and 沈眉庄 regression**

Run:

```bash
npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium --grep="landing-bound toll payment|property actions use only the confirmed landing"
npx playwright test tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep="meizhuang plot fine transfer sends the original amount"
```

Expected: PASS. The toll request targets only `甘露寺`; all ineligible cases retain a disabled module; the 沈眉庄 test still submits original amount `500` with `isPlotFine: true` and displays its `200`-two reduction.

- [ ] **Step 6: Commit the player workflow change**

```bash
git add apps/web/app/components/app-router-client.tsx tests/e2e/task7-workflows.spec.ts
git commit -m "feat: add landing-bound toll payment action"
```

Expected: one commit containing only the dedicated UI, removal of the asset toll mode, and the workflow regressions.

### Task 3: Run Full Relevant Verification

**Files:**
- Verify only; no source changes expected.

**Interfaces:**
- Consumes: committed server snapshot field and player action behavior from Tasks 1 and 2.
- Produces: evidence that the UI workflow, API integration behavior, static checks, and 沈眉庄 transfer behavior all remain valid.

- [ ] **Step 1: Run the complete touched API integration suite**

```bash
npm run test:integration
```

Expected: PASS, including existing toll payment, reversal, mortgage, and character-skill coverage.

- [ ] **Step 2: Run full workflows and the protected transfer contract on desktop and mobile**

```bash
npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium
npx playwright test tests/e2e/task7-contract.spec.ts --project=desktop-chromium --project=iphone-webkit --grep="meizhuang plot fine transfer sends the original amount"
```

Expected: PASS. The mobile run confirms the unmodified 沈眉庄 payment form remains usable at a narrow viewport.

- [ ] **Step 3: Run static checks**

```bash
npm run typecheck
npm run lint
```

Expected: both commands exit `0` with no TypeScript or ESLint errors.

- [ ] **Step 4: Inspect the final scoped diff**

```bash
git diff --check HEAD~2..HEAD
git log --oneline -2
```

Expected: no whitespace errors; the two implementation commits are `feat: expose settled toll landings in snapshots` and `feat: add landing-bound toll payment action`. Do not stage or alter unrelated worktree changes.
