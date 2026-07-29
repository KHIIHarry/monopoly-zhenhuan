# 落点绑定的购买与建造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure purchase and build requests can only target the player's confirmed property landing, and render that target as read-only information.

**Architecture:** Derive the sole property-action target from `currentLanding.propertyName` and the snapshot property list. Keep API request construction and server validation aligned with that derived property; eligibility is mode-specific and local to the player panel. The backend already rejects requests whose property is not the confirmed landing, so no API or database change is required.

**Tech Stack:** Next.js, React, TypeScript, Vitest, Playwright.

## Global Constraints

- Purchase requires a confirmed, plot-resolved, unowned property landing.
- Build requires a confirmed, plot-resolved landing owned by the current player, not mortgaged, and below level five.
- The purchase/build panel must not render a target-property selection control.
- Asset-operation property selection remains unchanged.
- Preserve the backend `LandingEvent.propertyId` validation for direct API calls.

---

## File Structure

- Modify: `apps/web/app/components/app-router-client.tsx` - derive the fixed landing target, apply per-mode eligibility, and build the request from that target.
- Modify: `tests/e2e/task7-workflows.spec.ts` - prove the player UI cannot select a non-landing property and sends requests only for the confirmed landing.

### Task 1: Bind Property Actions to the Confirmed Landing

**Files:**
- Modify: `tests/e2e/task7-workflows.spec.ts`
- Modify: `apps/web/app/components/app-router-client.tsx:1407-1491,1568-1575,1729-1743`

**Interfaces:**
- Consumes: `currentLanding?.propertyName`, `landingConfirmed`, `snapshot.properties`, `me?.id`, and `propertyMode` from `PlayerView`.
- Produces: `landingProperty: Property | undefined`, `canSubmitPropertyAction: boolean`, and a request URL whose encoded property name comes only from `landingProperty`.

- [ ] **Step 1: Write the failing Playwright regression test**

Add this test after the existing landing-card workflow in `tests/e2e/task7-workflows.spec.ts`. It uses one confirmed landing (`碎玉轩`) and a second eligible property (`景仁宫`) to prove the UI cannot drift to the second property.

```ts
test('property actions use only the confirmed landing and never offer another property as a target', async ({ page }) => {
  const purchaseProperties = [
    { name: '碎玉轩', ownerId: null, level: 0, mortgaged: false, mortgage: 800, purchasePrice: 1600, build: 1000, buildingSell: 600, tolls: [300, 700, 1800, 5000, 7000, 9000] },
    { name: '景仁宫', ownerId: null, level: 0, mortgaged: false, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1200, tolls: [800, 2000, 3900, 9000, 11000, 13000] },
  ];
  const buildProperties = [
    { ...purchaseProperties[0], ownerId: 'player-1', level: 1 },
    { ...purchaseProperties[1], ownerId: 'player-1', level: 1 },
  ];
  let mode: 'BUY' | 'BUILD' = 'BUY';
  const requests: string[] = [];
  await mockBase(page, { ...baseRoom, isBank: false });
  await page.route('**/api/rooms/room-1/seats', (route) => route.fulfill({ json: seats({ characterId: 'zhenhuan', playerId: 'player-1', isBank: false, activeHere: true }) }));
  await page.route('**/api/rooms/room-1/snapshot*', (route) => route.fulfill({ json: {
    ...snapshot,
    properties: mode === 'BUY' ? purchaseProperties : buildProperties,
    landings: [{ id: 'landing-1', playerId: 'player-1', propertyName: '碎玉轩', spaceType: 'PROPERTY', status: 'CONFIRMED', plotResolved: true, propertyActionsCancelled: false }],
  } }));
  await page.route('**/api/rooms/room-1/properties/**', (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { id: `request-${requests.length}` } });
  });

  await openRoom(page);
  await page.getByRole('button', { name: '购买 / 建造' }).click();
  await expect(page.getByLabel('目标地产')).toHaveCount(0);
  await expect(page.getByText('碎玉轩', { exact: true })).toBeVisible();
  await expect(page.getByText('景仁宫', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '提交购买申请' }).click();
  expect(requests).toEqual(['/api/rooms/room-1/properties/%E7%A2%8E%E7%8E%89%E8%BD%A9/buy']);

  mode = 'BUILD';
  await page.reload();
  await page.getByRole('button', { name: '购买 / 建造' }).click();
  await page.getByRole('button', { name: '建造升级' }).click();
  await expect(page.getByLabel('目标地产')).toHaveCount(0);
  await expect(page.getByText('碎玉轩', { exact: true })).toBeVisible();
  await expect(page.getByText('景仁宫', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '提交建造申请' }).click();
  expect(requests).toEqual([
    '/api/rooms/room-1/properties/%E7%A2%8E%E7%8E%89%E8%BD%A9/buy',
    '/api/rooms/room-1/properties/%E7%A2%8E%E7%8E%89%E8%BD%A9/build',
  ]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium --grep "property actions use only the confirmed landing"`

Expected: FAIL because the current UI renders `label` text “目标地产” containing a `select`, lists both eligible properties, and initializes the request from selectable `targetProperty` state.

- [ ] **Step 3: Replace the mutable target with the landing-derived property**

In `apps/web/app/components/app-router-client.tsx`, remove `availableProperties`, `targetProperty`, and their synchronization effect. Immediately after `landingConfirmed`, derive the sole target and action eligibility:

```tsx
  const landingProperty = snapshot.properties.find((property) => property.name === currentLanding?.propertyName);
  const canSubmitPropertyAction = Boolean(
    landingConfirmed
    && landingProperty
    && (propertyMode === 'BUY'
      ? !landingProperty.ownerId
      : landingProperty.ownerId === me?.id && !landingProperty.mortgaged && landingProperty.level < 5)
  );
```

Change `propertyAction` so it returns without sending a request when the derived property is absent or ineligible, and otherwise encodes its name:

```tsx
  async function propertyAction() {
    if (!landingProperty || !canSubmitPropertyAction) return;
    const route = propertyMode === 'BUY' ? 'buy' : 'build';
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/properties/${encodeURIComponent(landingProperty.name)}/${route}`, { playerId });
    if (ok) {
      clearTrustedProperty();
      setPanel(null);
      showNotice('操作已提交');
    }
  }
```

Replace the `availableProperties.length` conditional in the property panel with a fixed target block. It deliberately uses non-form text so `目标地产` is no longer selectable:

```tsx
          {landingProperty ? (
            <>
              <p className="cost-line"><span>目标地产</span><strong>{landingProperty.name}</strong></p>
              <PropertyCost property={landingProperty} mode={propertyMode} buildDiscount={me.buildDiscount ?? 0} />
              {!canSubmitPropertyAction && <p className="error">{propertyMode === 'BUY' ? '仅可购买当前确认落点的无主地产。' : '仅可建造当前确认且归自己的未抵押地产。'}</p>}
              <button className="primary" disabled={busy || !canSubmitPropertyAction} onClick={() => void propertyAction()}>{busy ? <LoaderCircle className="spin" /> : <Building2 />}{propertyMode === 'BUY' ? '提交购买申请' : '提交建造申请'}</button>
            </>
          ) : <div className="empty no-margin">请先声明该地产落点，并由银行确认剧情已结算。</div>}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium --grep "property actions use only the confirmed landing"`

Expected: PASS with both request URLs targeting `碎玉轩`; no `目标地产` form label exists and `景仁宫` is absent from the action sheet.

- [ ] **Step 5: Run all workflows and static checks**

Run:

```bash
npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium
npm run typecheck
npm run lint
```

Expected: every command exits `0`.

- [ ] **Step 6: Commit the implementation**

```bash
git add apps/web/app/components/app-router-client.tsx tests/e2e/task7-workflows.spec.ts
git commit -m "fix: bind property actions to confirmed landing"
```

Expected: the commit contains only the player-panel behavior change and its regression test.
