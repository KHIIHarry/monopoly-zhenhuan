# Toll Entry Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a bank-confirmed, plot-resolved property landing before the toll quick action can be opened.

**Architecture:** Reuse `landingConfirmed`, the exact existing gate for “购买 / 建造”, in the “支付过路费” `Quick` button. Keep the action sheet’s `tollDisabledReason` and `canPayToll` logic so confirmed-but-unpayable landings still explain their state.

**Tech Stack:** Next.js, React, TypeScript, Playwright.

## Global Constraints

- The toll quick action stays visible but is disabled until `landingConfirmed` is true.
- The existing `busy`, `canAct`, and `mustSkipCurrentTurn` restrictions remain applied.
- Confirmed unowned, self-owned, mortgaged, blocked, settled, zero-amount, or inconsistent landings still open the sheet and display their existing reason.
- Do not change toll payment amounts, endpoint, server-side validation, asset actions, or 沈眉庄 plot-fine behavior.

---

### Task 1: Gate The Toll Quick Action By Approved Landing

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:5524-5529`
- Modify: `tests/e2e/task7-workflows.spec.ts:280-341`

**Interfaces:**
- Consumes: `landingConfirmed: boolean`, `busy: boolean`, `canAct: boolean`, and `mustSkipCurrentTurn: boolean` in `PlayerView`.
- Produces: a disabled `Quick` button until the approved landing prerequisite is met.

- [ ] **Step 1: Write the failing test**

In the existing `landing-bound toll payment uses the confirmed landing and explains disabled states` test, change the no-landing branch to assert the quick action is unavailable, then leave the payable landing assertion unchanged:

```ts
tollCase = 'no-landing';
await page.reload();
await expect(page.getByRole('button', { name: '支付过路费' })).toBeDisabled();

tollCase = 'payable';
await page.reload();
await expect(page.getByRole('button', { name: '支付过路费' })).toBeEnabled();
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run `npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium --grep="landing-bound toll payment"`.

Expected: FAIL because the quick action currently omits `!landingConfirmed` from its disabled condition.

- [ ] **Step 3: Write minimal implementation**

Change the toll `Quick` component to use the same prerequisite as purchase/build:

```tsx
<Quick
  icon={<CircleDollarSign />}
  label="支付过路费"
  disabled={busy || !canAct || mustSkipCurrentTurn || !landingConfirmed}
  onClick={() => setPanel("TOLL")}
/>
```

- [ ] **Step 4: Run focused regression tests**

Run `npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium --grep="landing-bound toll payment"` and `npx playwright test tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep="meizhuang plot fine transfer sends the original amount"`.

Expected: both PASS. The workflow test verifies the approval gate and existing landing-bound payment, while the contract test protects 沈眉庄’s transfer calculation.

- [ ] **Step 5: Run static verification and commit**

Run `npm run typecheck`, `npx eslint apps/web/app/components/app-router-client.tsx tests/e2e/task7-workflows.spec.ts --max-warnings=0`, and `git diff --check`. Stage only the two task files, then commit `fix: gate toll action on confirmed landing`.
