# Create Room Desktop Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay out room creation settings in desktop rows of three while preserving a single-column mobile form and a consistent outlined room-list return action.

**Architecture:** Keep the form's data flow and control order unchanged. Add a targeted class to the create-room return action and use CSS grid only on `.create-form`, making its existing two-field wrapper transparent to that grid at desktop widths. A focused Playwright check observes the rendered layout at desktop and mobile widths.

**Tech Stack:** Next.js, React, CSS, Playwright.

## Global Constraints

- Desktop layout uses exactly three setting columns.
- Mobile layout remains one column in the existing source order.
- The return action label is exactly `🔙 房间列表` and has a visible single outline with no default fill.
- No API payload, validation, or control behavior changes.

---

## File Structure

- `apps/web/app/components/app-router-client.tsx`: adds the return-action class and revised visible label.
- `apps/web/app/globals.css`: defines the one-column base form and the desktop three-column override.
- `tests/e2e/create-room-layout.spec.ts`: mocks authenticated room creation and asserts the responsive layout contract.

### Task 1: Add the Failing Layout Regression Test

**Files:**
- Create: `tests/e2e/create-room-layout.spec.ts`

**Interfaces:**
- Consumes: the `/rooms/create` route, authenticated account response, and the `CreateRoom` form labels.
- Produces: Playwright assertions for the `room-list-back` selector and `.create-form` computed grid columns.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from '@playwright/test';

const account = { id: 'account-1', username: 'zhenhuan', displayName: '甄嬛', isSuperAdmin: false, canCreateRoom: true, lastLoginAt: null };

async function openCreateRoom(page: import('@playwright/test').Page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { account, sessions: [] } }));
  await page.route('**/api/rooms/mine', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms/history', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rooms', (route) => route.fulfill({ json: [] }));
  await page.goto('/rooms/create');
  await expect(page.getByRole('heading', { name: '创建房间' })).toBeVisible();
}

test('create-room form uses three desktop columns and one mobile column', async ({ page }, testInfo) => {
  await openCreateRoom(page);
  const back = page.getByRole('button', { name: '🔙 房间列表', exact: true });
  await expect(back).toBeVisible();
  await expect(back).toHaveClass(/room-list-back/);
  await expect(back).toHaveCSS('border-top-width', '1px');

  const columns = await page.locator('.create-form').evaluate((form) => getComputedStyle(form).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(testInfo.project.name.startsWith('desktop-') ? 3 : 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec playwright test tests/e2e/create-room-layout.spec.ts`

Expected: FAIL because the return action is still labelled `返回房间列表` and has no `room-list-back` class.

- [ ] **Step 3: Commit the test**

The workspace has no Git repository metadata, so leave this file unstaged and record the limitation in the handoff.

### Task 2: Implement the Responsive Form and Return Action

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:1075-1082`
- Modify: `apps/web/app/globals.css:126-136`

**Interfaces:**
- Consumes: the `CreateRoom` `onBack` callback and the existing setting controls.
- Produces: `.room-list-back` return action and a `.create-form` that passes the Task 1 layout assertions.

- [ ] **Step 1: Change the create-room action markup**

```tsx
<button type="button" className="text-back room-list-back" onClick={onBack}>🔙 房间列表</button>
```

Keep the rest of the form's inputs, source order, handlers, and payload unchanged.

- [ ] **Step 2: Add the minimal base and desktop CSS**

```css
.create-form { display: grid; grid-template-columns: minmax(0, 1fr); }
.create-form .form-grid { display: contents; }
.room-list-back { min-height: 44px; padding: 0 12px; border: 1px solid #b8aaa8; background: transparent; color: #812936; }
.room-list-back:hover { background: #f7eeee; }

@media (min-width: 900px) {
  .create-form { width: min(100%, 1080px); grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; }
  .create-form > .room-list-back,
  .create-form > h1,
  .create-form > .error,
  .create-form > .primary { grid-column: 1 / -1; }
}
```

- [ ] **Step 3: Run the focused browser test to verify it passes**

Run: `pnpm exec playwright test tests/e2e/create-room-layout.spec.ts`

Expected: PASS across all configured desktop and mobile browser projects.

- [ ] **Step 4: Commit the implementation**

The workspace has no Git repository metadata, so leave these changes unstaged and record the limitation in the handoff.

### Task 3: Verify Type Safety and Rendered Geometry

**Files:**
- Verify: `apps/web/app/components/app-router-client.tsx`
- Verify: `apps/web/app/globals.css`
- Verify: `tests/e2e/create-room-layout.spec.ts`

**Interfaces:**
- Consumes: the completed responsive form and browser regression test.
- Produces: fresh type-check, browser-test, and screenshot evidence.

- [ ] **Step 1: Run the type check**

Run: `pnpm typecheck`

Expected: exit code 0.

- [ ] **Step 2: Capture desktop and mobile visual evidence**

```ts
await page.screenshot({ path: 'test-results/create-room-desktop.png', fullPage: true });
await page.screenshot({ path: 'test-results/create-room-mobile.png', fullPage: true });
```

Run this after the Playwright assertions with a desktop viewport and a 390px-wide mobile viewport, then inspect both screenshots for three-column desktop rows, one-column mobile rows, and the outlined return action.

- [ ] **Step 3: Re-run the focused browser test after visual inspection**

Run: `pnpm exec playwright test tests/e2e/create-room-layout.spec.ts`

Expected: PASS across all configured browser projects.
