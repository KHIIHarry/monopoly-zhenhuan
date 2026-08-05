# Global Route Transition Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stale-page flashes on every authenticated route transition with one stable, accessible skeleton until authentication and the target page's first data load complete.

**Architecture:** Add a presentation-only `RouteSkeleton` with an isolated CSS Module, a small framework-neutral route transition helper for same-route detection and timeout cleanup, and integrate both into the existing centralized `AppRouterClient.go()` path. A root `loading.tsx` handles framework and history navigation, while `pageReady` keeps protected routes on the same skeleton through their initial API load.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, CSS Modules, Vitest, Playwright, Docker Compose.

## Global Constraints

- Cover all authenticated pages: room list, room creation, room identity and game pages, profile, and super-admin pages.
- Do not change API authentication, authorization, Cookie, device-token, database, idempotency, or Socket.IO behavior.
- Direct visits to `/login` must still render the login form immediately.
- A failed client navigation must leave the skeleton after exactly 10 seconds and show `页面加载较慢，请重试`.
- Use a stable mobile-first skeleton with `role="status"`, `aria-busy="true"`, and reduced-motion support.
- Do not add a state-management or UI dependency.
- Do not modify `apps/web/app/globals.css` or its current user-owned dirty changes; use a new CSS Module.
- Start Web/API only with Docker Compose on ports `3000/4000`; Playwright must use `PLAYWRIGHT_EXTERNAL_STACK=1`.
- Never stage or commit `.superpowers/sdd/*`.

---

## File Structure

- Create `apps/web/app/components/route-skeleton.tsx`: stable skeleton markup and accessible loading state.
- Create `apps/web/app/components/route-skeleton.module.css`: isolated responsive and reduced-motion styles.
- Create `apps/web/app/components/route-skeleton.test.tsx`: rendered markup and CSS contract tests.
- Create `apps/web/app/components/route-transition.ts`: same-route comparison and one-shot 10-second watchdog.
- Create `apps/web/app/components/route-transition.test.ts`: fake-timer unit tests for route matching and timeout lifecycle.
- Create `apps/web/app/loading.tsx`: root App Router loading fallback using `RouteSkeleton`.
- Modify `apps/web/app/components/app-router-client.tsx`: immediate route masking, protected-page readiness, and removal of the login page's duplicate room request.
- Modify `apps/web/app/components/app-router-client.test.ts`: source contracts for skeleton precedence and page readiness branches.
- Modify `tests/e2e/routing.spec.ts`: observable login-to-rooms and protected-route skeleton behavior.

---

### Task 1: Accessible Route Skeleton

**Files:**
- Create: `apps/web/app/components/route-skeleton.tsx`
- Create: `apps/web/app/components/route-skeleton.module.css`
- Create: `apps/web/app/components/route-skeleton.test.tsx`
- Create: `apps/web/app/loading.tsx`

**Interfaces:**
- Produces: `RouteSkeleton(): ReactElement`, used by `loading.tsx` and `AppRouterClient`.
- Consumes: no application state and no browser APIs.

- [ ] **Step 1: Write the failing component and style contract test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import RouteSkeleton from "./route-skeleton";

describe("RouteSkeleton", () => {
  it("renders one accessible and stable application skeleton", () => {
    const markup = renderToStaticMarkup(<RouteSkeleton />);
    expect(markup).toContain('data-testid="route-skeleton"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("页面加载中");
    expect(markup.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("uses fixed mobile-first geometry and disables motion when requested", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./route-skeleton.module.css", import.meta.url)),
      "utf8",
    );
    expect(css).toContain("min-height: 100dvh");
    expect(css).toContain("@media (min-width: 760px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/animation:\s*none/);
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm exec vitest run -- apps/web/app/components/route-skeleton.test.tsx`

Expected: FAIL because `./route-skeleton` does not exist.

- [ ] **Step 3: Implement the minimal skeleton and root loading fallback**

`route-skeleton.tsx` must render a single full-screen `main` with `data-testid="route-skeleton"`, `role="status"`, `aria-live="polite"`, and `aria-busy="true"`. Include one visually hidden `页面加载中`, a header group, one summary block, and four list-row blocks. Mark decorative blocks `aria-hidden="true"`.

```tsx
import styles from "./route-skeleton.module.css";

export default function RouteSkeleton() {
  return (
    <main className={styles.page} data-testid="route-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className={styles.srOnly}>页面加载中</span>
      <header className={styles.header} aria-hidden="true">
        <span className={styles.avatar} />
        <span className={styles.title} />
        <span className={styles.amount} />
      </header>
      <section className={styles.summary} aria-hidden="true">
        <span className={styles.heading} />
        <span className={styles.action} />
      </section>
      <section className={styles.list} aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <span className={styles.row} key={index} />)}
      </section>
    </main>
  );
}
```

`loading.tsx` must contain only:

```tsx
import RouteSkeleton from "./components/route-skeleton";

export default function Loading() {
  return <RouteSkeleton />;
}
```

The CSS Module must use existing palette-compatible literal colors, fixed block heights, `max-width: 760px`, responsive padding at `760px`, a subtle opacity animation, and `animation: none` under reduced motion. It must not use viewport-scaled font sizes or modify global selectors.

- [ ] **Step 4: Verify GREEN**

Run: `npm exec vitest run -- apps/web/app/components/route-skeleton.test.tsx`

Expected: 2 tests passed.

- [ ] **Step 5: Commit Task 1 only**

```bash
git add apps/web/app/components/route-skeleton.tsx apps/web/app/components/route-skeleton.module.css apps/web/app/components/route-skeleton.test.tsx apps/web/app/loading.tsx
git commit -m "feat(web): add route loading skeleton"
```

---

### Task 2: Route Transition Watchdog

**Files:**
- Create: `apps/web/app/components/route-transition.ts`
- Create: `apps/web/app/components/route-transition.test.ts`

**Interfaces:**
- Produces: `ROUTE_TRANSITION_TIMEOUT_MS = 10_000`.
- Produces: `isSameClientRoute(target: string, current: Pick<Location, "href">): boolean`.
- Produces: `createRouteTransitionWatchdog(onTimeout, schedule?, cancel?)` returning `{ arm(): void; clear(): void }`.

- [ ] **Step 1: Write failing unit tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROUTE_TRANSITION_TIMEOUT_MS,
  createRouteTransitionWatchdog,
  isSameClientRoute,
} from "./route-transition";

afterEach(() => vi.useRealTimers());

describe("route transition", () => {
  it("compares pathname and search while ignoring the hash", () => {
    const current = { href: "http://localhost:3000/rooms?tab=mine#top" };
    expect(isSameClientRoute("/rooms?tab=mine", current)).toBe(true);
    expect(isSameClientRoute("/rooms?tab=all", current)).toBe(false);
  });

  it("fires one timeout after ten seconds and can be cleared", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = createRouteTransitionWatchdog(onTimeout);
    watchdog.arm();
    vi.advanceTimersByTime(ROUTE_TRANSITION_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.arm();
    vi.advanceTimersByTime(ROUTE_TRANSITION_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    watchdog.clear();
    vi.runAllTimers();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `npm exec vitest run -- apps/web/app/components/route-transition.test.ts`

Expected: FAIL because `./route-transition` does not exist.

- [ ] **Step 3: Implement the helper**

```ts
export const ROUTE_TRANSITION_TIMEOUT_MS = 10_000;

export function isSameClientRoute(target: string, current: Pick<Location, "href">) {
  const targetUrl = new URL(target, current.href);
  const currentUrl = new URL(current.href);
  return targetUrl.pathname === currentUrl.pathname && targetUrl.search === currentUrl.search;
}

export function createRouteTransitionWatchdog(
  onTimeout: () => void,
  schedule: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  return {
    arm() {
      clear();
      timer = schedule(() => {
        timer = null;
        onTimeout();
      }, ROUTE_TRANSITION_TIMEOUT_MS);
    },
    clear,
  };
}
```

- [ ] **Step 4: Verify GREEN and focused type safety**

Run: `npm exec vitest run -- apps/web/app/components/route-transition.test.ts && npm run typecheck`

Expected: 2 tests passed; typecheck exits 0.

- [ ] **Step 5: Commit Task 2 only**

```bash
git add apps/web/app/components/route-transition.ts apps/web/app/components/route-transition.test.ts
git commit -m "feat(web): add route transition watchdog"
```

---

### Task 3: Integrate Immediate Masking and Page Readiness

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:1-30,1145-1345,1524-1540,2173-2280`
- Modify: `apps/web/app/components/app-router-client.test.ts`
- Modify: `tests/e2e/routing.spec.ts`

**Interfaces:**
- Consumes: `RouteSkeleton`, `isSameClientRoute`, and `createRouteTransitionWatchdog` from Tasks 1-2.
- Produces: centralized `go(path, replace?)` behavior that hides the current screen before navigation.
- Produces: `pageReady` gate that opens only after the target protected page's initial loader settles.

- [ ] **Step 1: Add failing source-contract and browser tests**

Add one test that reads `app-router-client.tsx` and asserts these concrete contracts:

```ts
expect(component).toContain('const [routePending, setRoutePending] = useState(false)');
expect(component).toContain('const [pageReady, setPageReady] = useState(false)');
expect(component).toMatch(/const go = \(path: string, replace = false\) => \{[\s\S]*?isSameClientRoute\(path, window\.location\)[\s\S]*?setRoutePending\(true\)[\s\S]*?routeWatchdog\.current\?\.arm\(\)[\s\S]*?router\.(?:replace|push)/);
expect(component).toMatch(/if \(routePending \|\|[\s\S]*?!pageReady[\s\S]*?return <RouteSkeleton/);
expect(component.indexOf('return <RouteSkeleton')).toBeLessThan(component.indexOf('if (screen === "LOGIN"'));
expect(component).not.toMatch(/go\(loginDestination\(\), true\);\s*await loadRooms\(\)/);
```

Add branch assertions that the promises returned by `loadRooms`, `loadSeats`, `loadProfile`, `loadAdmin`, and `fetchSettlement` settle through a shared `finishPageLoad` callback, while immediate protected screens call `finishPageLoad()` directly.

In `routing.spec.ts`, add a `route skeleton` test. Mock the first `/api/auth/me` as unauthenticated, fulfill `/api/auth/login`, hold the destination `/api/auth/me` behind a controllable promise, and fulfill all three room list APIs. After clicking `登录`, assert before releasing the destination auth response:

```ts
await expect(page.getByTestId("route-skeleton")).toBeVisible();
await expect(page.getByRole("heading", { name: "账号登录" })).toHaveCount(0);
```

Release the destination auth response, then assert `/rooms`, `创建房间`, and no skeleton. Add a second test that delays `/api/auth/me` on a direct protected route and asserts the skeleton is the only page shell before target content appears.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `npm exec vitest run -- apps/web/app/components/app-router-client.test.ts`

Expected: FAIL on the missing route and page readiness states.

Run against the existing Docker stack:

`PLAYWRIGHT_EXTERNAL_STACK=1 npm exec playwright test -- tests/e2e/routing.spec.ts --project=desktop-chromium --grep "route skeleton"`

Expected: FAIL because the route skeleton test id does not exist and the login heading remains visible during the delayed transition.

- [ ] **Step 3: Add transition state and watchdog lifecycle**

Import the Task 1-2 APIs. Add `routePending` and `pageReady` state, plus:

```tsx
const routeWatchdog = useRef<ReturnType<typeof createRouteTransitionWatchdog> | null>(null);

useEffect(() => {
  const watchdog = createRouteTransitionWatchdog(() => {
    setRoutePending(false);
    showNotice("页面加载较慢，请重试");
  });
  routeWatchdog.current = watchdog;
  return () => {
    watchdog.clear();
    if (routeWatchdog.current === watchdog) routeWatchdog.current = null;
  };
}, [showNotice]);

const go = (path: string, replace = false) => {
  if (typeof window !== "undefined" && isSameClientRoute(path, window.location)) return;
  setRoutePending(true);
  routeWatchdog.current?.arm();
  try {
    replace ? router.replace(path as Route) : router.push(path as Route);
  } catch (caught) {
    routeWatchdog.current?.clear();
    setRoutePending(false);
    throw caught;
  }
};
```

- [ ] **Step 4: Gate protected content through the initial loader**

In the existing auth-and-page effect, create an `active` flag and `finishPageLoad()` callback. Set `pageReady(false)` before each protected route load. Attach `.finally(finishPageLoad)` to room list, join-room, seats/game, settlement, profile, and admin loads. Call `finishPageLoad()` immediately for authenticated protected pages with no initial request, such as create-room. Cleanup sets `active = false`.

Before the `LANDING` and `LOGIN` render branches, add:

```tsx
const publicScreen = screen === "LANDING" || screen === "LOGIN" || screen === "FORBIDDEN";
if (
  routePending ||
  (!publicScreen && (!authChecked || !account || !pageReady))
) return <RouteSkeleton />;
```

Replace the later full-screen spinner fallback with `RouteSkeleton`. Preserve direct login rendering by keeping unauthenticated `LOGIN` out of the protected-screen gate.

- [ ] **Step 5: Remove the old login component's duplicate room request**

Both successful login flows must end after `go(loginDestination(), true)`; remove the following `await loadRooms()` because the destination page owns its initial load.

- [ ] **Step 6: Verify GREEN and focused lint/type safety**

Run: `npm exec vitest run -- apps/web/app/components/app-router-client.test.ts apps/web/app/components/route-transition.test.ts apps/web/app/components/route-skeleton.test.tsx && npm run lint && npm run typecheck`

Expected: focused tests pass; lint and typecheck exit 0.

- [ ] **Step 7: Commit Task 3 only**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts tests/e2e/routing.spec.ts
git commit -m "fix(web): mask authenticated route transitions"
```

---

### Task 4: Browser Regression and Delivery Verification

**Files:**
- Modify if generated by build, then restore: `apps/web/next-env.d.ts`

**Interfaces:**
- Consumes: final route transition behavior from Tasks 1-3.
- Produces: complete delivery evidence that stale login and protected-page contents are hidden without regressions.

- [ ] **Step 1: Rebuild only through Docker and verify focused browser behavior**

Run:

```bash
docker compose up -d
PLAYWRIGHT_EXTERNAL_STACK=1 npm exec playwright test -- tests/e2e/routing.spec.ts --grep "route skeleton"
```

Expected: all route skeleton tests pass across the configured desktop and mobile projects.

- [ ] **Step 2: Run the complete delivery gates**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
PLAYWRIGHT_EXTERNAL_STACK=1 npm run test:e2e
```

Expected: every command exits 0. Restore only the build-generated `apps/web/next-env.d.ts` import path with `apply_patch` if Next.js rewrites it. Do not touch `.superpowers/sdd/*` or pre-existing `globals.css` changes.

- [ ] **Step 3: Verify Docker runtime and responsive presentation**

Confirm `docker compose ps`, `http://localhost:4000/health`, and `http://localhost:3000/`. Use Playwright screenshots at desktop `1440x900`, iPhone `390x844`, and short mobile `375x667`; verify the skeleton is nonblank, has no horizontal overflow, uses stable block geometry, and does not expose stale page headings.

- [ ] **Step 4: Confirm repository scope and record the final evidence**

Run `git status --short`, `git diff --check`, and `git log --oneline` for the feature range. Expected: only the planned commits plus pre-existing user-owned files; no generated build diff and no staged files.

---

## Final Review Checklist

- The login form disappears immediately after a successful login response.
- All authenticated routes use the same skeleton through auth and initial data loading.
- Direct `/login` remains immediately usable.
- Same-route navigation does not activate the watchdog.
- A stalled route clears after 10 seconds with the exact configured notice.
- Browser back/forward and root route loading use `app/loading.tsx`.
- No auth, permission, room, idempotency, database, or Socket contract changed.
- Existing user-owned `.superpowers/sdd/*`, `globals.css`, and `globals.css.test.ts` changes remain unstaged and unchanged.
