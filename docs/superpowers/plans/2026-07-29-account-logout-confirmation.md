# Account Logout Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require confirmation before a user signs out from the room lobby.

**Architecture:** Keep logout ownership in `AppRouterClient`. Add local dialog-open state to `Lobby` and render the existing accessible `ConfirmDialog`; only the dialog's confirm action invokes the already-wired logout callback. Cover the complete interaction through the browser fixture that already supplies an authenticated lobby.

**Tech Stack:** Next.js, React, TypeScript, Vitest, Playwright, lucide-react.

## Global Constraints

- Reuse `ConfirmDialog`; retain its focus handling, Escape cancellation, and busy-state behavior.
- Keep the existing `POST /api/auth/logout` request and post-logout local cleanup unchanged.
- Do not change authentication/session APIs or add server-side confirmation.
- Use Chinese product copy: title `确认退出账号`, confirmation label `确认退出`, and a message that says a new login is required to return to the game.

---

### Task 1: Confirm Account Logout From The Lobby

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:1088-1094`
- Modify: `tests/e2e/workbench.spec.ts` after the authenticated lobby tests

**Interfaces:**
- Consumes: `Lobby` receives `busy: boolean` and `onLogout: () => void` from `AppRouterClient`; `ConfirmDialog` receives `title`, `confirmLabel`, `busy`, `onCancel`, and `onConfirm`.
- Produces: A lobby logout click opens confirmation first; only `onConfirm` invokes `onLogout`.

- [x] **Step 1: Write the failing end-to-end test**

  Add this test to `tests/e2e/workbench.spec.ts`, which owns the reusable
  `authenticated(page)` lobby fixture:

  ```ts
  test('退出账号需要确认后才结束当前会话', async ({ page }) => {
    await authenticated(page);
    let logoutRequests = 0;
    await page.route('**/api/auth/logout', async (route) => {
      logoutRequests += 1;
      await route.fulfill({ json: {} });
    });

    await page.goto('/rooms');
    await page.getByRole('button', { name: '退出', exact: true }).click();

    await expect(page.getByRole('dialog', { name: '确认退出账号' })).toBeVisible();
    expect(logoutRequests).toBe(0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '确认退出账号' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '甄嬛' })).toBeVisible();
    expect(logoutRequests).toBe(0);

    await page.getByRole('button', { name: '退出', exact: true }).click();
    await page.getByRole('button', { name: '确认退出', exact: true }).click();
    await expect.poll(() => logoutRequests).toBe(1);
    await expect(page).toHaveURL('/login?next=%2Frooms');
  });
  ```

- [x] **Step 2: Run the test to verify it fails**

  Run: `npm run test:e2e -- tests/e2e/workbench.spec.ts -g '退出账号需要确认后才结束当前会话'`

  Expected: FAIL because the first click currently sends `POST /api/auth/logout` and no dialog with the accessible name `确认退出账号` exists.

- [x] **Step 3: Add the minimal lobby dialog state and rendering**

  In `Lobby`, add a `useState(false)` value named `logoutOpen`. Change the logout button and add the existing dialog after the header:

  ```tsx
  <button disabled={busy} onClick={() => setLogoutOpen(true)}>退出</button>
  {logoutOpen && (
    <ConfirmDialog
      title="确认退出账号"
      confirmLabel="确认退出"
      busy={busy}
      onCancel={() => setLogoutOpen(false)}
      onConfirm={() => void onLogout()}
    >
      <p>退出后需要重新登录才能继续游戏。</p>
    </ConfirmDialog>
  )}
  ```

  Retain all other `Lobby` markup and the existing `logout()` function unchanged.

- [x] **Step 4: Run the focused test to verify it passes**

  Run: `npm run test:e2e -- tests/e2e/workbench.spec.ts -g '退出账号需要确认后才结束当前会话'`

  Expected: PASS; the route sees no logout request before confirmation or after cancellation, then exactly one after confirmation and the browser returns to the login page.

- [x] **Step 5: Run static verification**

  Run: `npm run typecheck && npm run lint`

  Expected: both commands exit 0 with no TypeScript or ESLint errors.

- [x] **Step 6: Commit the implementation**

  ```bash
  git add apps/web/app/components/app-router-client.tsx tests/e2e/workbench.spec.ts
  git commit -m "feat: confirm account logout"
  ```
