# Landing Poster Task 1 Report

## Scope

Added the test-first Playwright regression coverage for the landing poster. No production React, CSS, or asset files were changed.

## Changed Files

- `tests/e2e/workbench.spec.ts`
  - Added `首页以分层宫廷海报展示且加入游戏组仍进入登录页`.
  - Requires the landing poster root and six visual layers through stable test IDs.
  - Checks horizontal and vertical document overflow with a one-pixel tolerance.
  - Preserves the existing `加入游戏组` button behavior by asserting the login username field becomes visible.
  - Rechecks poster visibility and overflow at `360x800`, `768x1024`, and `1440x900`.
- `.superpowers/sdd/landing-poster-task-1-report.md`
  - This delivery report.

## TDD RED Evidence

The initial test was written without the viewport loop and run first. It failed as expected because the implementation does not expose the required poster root:

```text
Running 1 test using 1 worker
[desktop-chromium] ... 首页以分层宫廷海报展示且加入游戏组仍进入登录页
Error: expect(locator).toBeVisible() failed
Locator: getByTestId('landing-poster')
Expected: visible
Error: element(s) not found
tests/e2e/workbench.spec.ts:40:52
1 failed
```

The viewport loop was then added and the same command was run again. The final run failed at the same locator and line, confirming the failure is caused by the missing landing-poster implementation rather than test syntax or fixture setup.

Command used for both RED runs:

```sh
npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium --grep '首页以分层宫廷海报' --reporter=line
```

The first sandboxed attempt could not bind the local Next.js test server to `127.0.0.1:3000` (`listen EPERM`); the recorded RED runs used the required elevated local-server permission and reached the browser assertion.

## Test Status

- Targeted landing-poster test: RED as expected, 1 failed due to missing `landing-poster`.
- Existing tests: preserved and not run as part of this intentionally failing, test-first task.
- Production code: not modified.

## Self-Review

- The test uses the existing unauthenticated `/api/auth/me` route stub and existing accessible button name.
- It asserts behavior rather than component internals: required visual-layer contract, viewport fit, and existing login navigation.
- The responsive checks reset the page after each viewport resize so every assertion observes the landing state.
- No production files, styling, or static assets were edited.

## Concerns

- The responsive checks cannot execute until `landing-poster` exists; they are deliberately blocked by the first missing contract assertion during RED.
- This workspace has no Git metadata (`fatal: not a git repository`), so no commit was attempted.
