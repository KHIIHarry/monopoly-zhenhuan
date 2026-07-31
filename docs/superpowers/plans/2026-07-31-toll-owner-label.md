# Toll Owner Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display “国库” for unowned properties and standard character names for owned properties in the toll sheet.

**Architecture:** Keep the confirmed-landing and toll calculation logic unchanged. Derive one display-only `tollOwnerLabel` in `PlayerView` from the existing owner ID, player snapshot, and `characterName()` helper.

**Tech Stack:** Next.js, React, TypeScript, Playwright.

## Global Constraints

- No `ownerId` displays “国库”.
- A resolved owner displays the character name from `characterId`, never the account nickname.
- Missing player or character data displays “角色信息缺失”.
- Do not change toll eligibility, amount, endpoint, or 沈眉庄 plot-fine behavior.

---

### Task 1: Derive And Render The Toll Owner Label

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:4796-4819,5535-5567`
- Modify: `tests/e2e/task7-workflows.spec.ts:280-341`

**Interfaces:**
- Consumes: `landingProperty.ownerId`, `tollOwner?: Player`, `Player.characterId`, and `characterName(id)`.
- Produces: `tollOwnerLabel: string`, rendered only in the toll sheet’s “地产主人” row.

- [ ] **Step 1: Write the failing test**

Replace the payable-owner assertion and add an unowned assertion in `landing-bound toll payment uses the confirmed landing and explains disabled states`:

```ts
await expect(tollSheet.getByText('乌拉那拉·宜修', { exact: true })).toBeVisible();
await expect(tollSheet.getByText('皇后', { exact: true })).toHaveCount(0);

tollCase = 'unowned';
await page.reload();
await page.getByRole('button', { name: '支付过路费' }).click();
const unownedSheet = page.getByRole('dialog', { name: '支付过路费' });
await expect(unownedSheet.getByText('国库', { exact: true })).toBeVisible();
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run `npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium --grep="landing-bound toll payment"`.

Expected: FAIL because the sheet renders `tollOwner?.name ?? "未知玩家"`.

- [ ] **Step 3: Write minimal implementation**

Derive the label after `tollOwner`:

```ts
const tollOwnerLabel = !landingProperty?.ownerId
  ? "国库"
  : tollOwner?.characterId
    ? characterName(tollOwner.characterId)
    : "角色信息缺失";
```

Replace the sheet value with `<strong>{tollOwnerLabel}</strong>`.

- [ ] **Step 4: Run focused regression tests**

Run `npx playwright test tests/e2e/task7-workflows.spec.ts --project=desktop-chromium --grep="landing-bound toll payment"` and `npx playwright test tests/e2e/task7-contract.spec.ts --project=desktop-chromium --grep="meizhuang plot fine transfer sends the original amount"`.

Expected: both PASS; the first proves labels and the unchanged endpoint, the second protects 沈眉庄’s original transfer amount.

- [ ] **Step 5: Run static verification and commit**

Run `npm run typecheck`, `npm run lint`, and `git diff --check`. Then stage only `apps/web/app/components/app-router-client.tsx` and `tests/e2e/task7-workflows.spec.ts`, and commit `fix: label toll property owners`.
