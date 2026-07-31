# H5 Pull-to-Refresh Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent browser pull-to-refresh on every H5 page while keeping page, modal, form, slider, and drag interactions working normally.

**Architecture:** Lock the document root and transfer vertical scrolling to the existing page-level containers. A pure decision function determines whether a gesture is a top-edge downward overscroll, while a small client component observes touch events, resolves main and nested scroll containers, and only cancels the qualifying legacy-iOS fallback gesture.

**Tech Stack:** Next.js App Router, React, TypeScript, CSS, Vitest, Playwright

## Global Constraints

- Do not change business requests, routing destinations, authentication, realtime behavior, or game actions.
- `body` must not be a page scrolling container.
- `html`, `body`, and `#root` must use `height: 100%`, `overflow: hidden`, and `overscroll-behavior: none`.
- Main scrolling containers must use `height: 100%`, `overflow-y: auto`, `overscroll-behavior-y: contain`, and `-webkit-overflow-scrolling: touch`.
- The `touchmove` listener must use `{ passive: false }`.
- Never globally cancel all touch movement.
- Preserve page scrolling, nested modal scrolling, form controls, sliders, draggable elements, and multi-touch gestures.
- Do not add user-agent detection; Android Chrome, iOS Safari, WeChat, and standalone PWA use the same behavior-based implementation.
- Preserve all pre-existing uncommitted workspace changes.

---

## File Structure

- Create `apps/web/app/components/pull-to-refresh.ts`: pure gesture-decision types and function.
- Create `apps/web/app/components/pull-to-refresh.test.ts`: exhaustive unit tests for the decision function.
- Create `apps/web/app/components/pull-to-refresh-guard.tsx`: DOM integration, touch listeners, nested-scroll lookup, interaction exemptions, and route reset.
- Create `apps/web/app/components/pull-to-refresh-guard.test.ts`: source-level integration contract for listener options, cleanup, selectors, and route reset.
- Modify `apps/web/app/layout.tsx`: add a real `#root` and mount the guard once.
- Modify `apps/web/app/globals.css`: lock document roots and make all page roots explicit internal scrollers.
- Modify `apps/web/app/globals.css.test.ts`: assert the scroll ownership CSS contract.
- Create `tests/e2e/pull-to-refresh.spec.ts`: verify root locking and internal scrolling in rendered mobile pages.

### Task 1: Pure Pull Gesture Decision

**Files:**
- Create: `apps/web/app/components/pull-to-refresh.ts`
- Create: `apps/web/app/components/pull-to-refresh.test.ts`

**Interfaces:**
- Produces: `PullGestureDecisionInput`
- Produces: `shouldPreventPullToRefresh(input: PullGestureDecisionInput): boolean`
- Uses no browser globals and can execute in Vitest's Node environment.

- [ ] **Step 1: Write the failing decision tests**

Create tests covering the only permitted cancellation case and every required escape path:

```ts
import { describe, expect, test } from "vitest";
import { shouldPreventPullToRefresh } from "./pull-to-refresh";

const qualifyingGesture = {
  touchCount: 1,
  startX: 20,
  startY: 100,
  currentX: 21,
  currentY: 120,
  mainScrollTop: 0,
  nestedScrollTop: null,
  cancelable: true,
  interactive: false,
};

describe("pull-to-refresh gesture decision", () => {
  test("prevents a single-finger downward overscroll at the main top edge", () => {
    expect(shouldPreventPullToRefresh(qualifyingGesture)).toBe(true);
  });

  test.each([
    ["main content is not at the top", { mainScrollTop: 1 }],
    ["a nested scroller can consume the drag", { nestedScrollTop: 1 }],
    ["the gesture moves upward", { currentY: 80 }],
    ["horizontal movement dominates", { currentX: 60, currentY: 110 }],
    ["movement is below the threshold", { currentY: 104 }],
    ["the gesture has multiple touches", { touchCount: 2 }],
    ["the target is interactive", { interactive: true }],
    ["the event cannot be canceled", { cancelable: false }],
  ])("allows touch movement when %s", (_name, change) => {
    expect(shouldPreventPullToRefresh({ ...qualifyingGesture, ...change })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- apps/web/app/components/pull-to-refresh.test.ts`

Expected: FAIL because `./pull-to-refresh` does not exist.

- [ ] **Step 3: Implement the minimal pure decision function**

```ts
export type PullGestureDecisionInput = {
  touchCount: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  mainScrollTop: number;
  nestedScrollTop: number | null;
  cancelable: boolean;
  interactive: boolean;
};

const MOVEMENT_THRESHOLD = 5;

export function shouldPreventPullToRefresh(input: PullGestureDecisionInput) {
  const deltaX = input.currentX - input.startX;
  const deltaY = input.currentY - input.startY;

  return (
    input.touchCount === 1 &&
    input.cancelable &&
    !input.interactive &&
    input.mainScrollTop <= 0 &&
    (input.nestedScrollTop === null || input.nestedScrollTop <= 0) &&
    deltaY > MOVEMENT_THRESHOLD &&
    deltaY > Math.abs(deltaX)
  );
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- apps/web/app/components/pull-to-refresh.test.ts`

Expected: PASS with 9 cases and zero failures.

### Task 2: Client Guard and Real Root

**Files:**
- Create: `apps/web/app/components/pull-to-refresh-guard.tsx`
- Create: `apps/web/app/components/pull-to-refresh-guard.test.ts`
- Modify: `apps/web/app/layout.tsx`

**Interfaces:**
- Consumes: `shouldPreventPullToRefresh(input)` from Task 1.
- Produces: `MAIN_SCROLL_CONTAINER_SELECTOR` containing `.v2-page`, `.landing-page`, `.center`, and `.workbench-scroll`.
- Produces: default React component `PullToRefreshGuard` that renders `null`.

- [ ] **Step 1: Write the failing integration contract test**

Read the guard and layout sources and assert:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const guardUrl = new URL("./pull-to-refresh-guard.tsx", import.meta.url);
const layoutUrl = new URL("../layout.tsx", import.meta.url);

describe("pull-to-refresh guard integration", () => {
  test("mounts once inside a real application root", async () => {
    const layout = await readFile(layoutUrl, "utf8");
    expect(layout).toContain('id="root"');
    expect(layout).toContain("<PullToRefreshGuard />");
  });

  test("observes touch movement non-passively and cleans up listeners", async () => {
    const guard = await readFile(guardUrl, "utf8");
    expect(guard).toContain('document.addEventListener("touchmove", onTouchMove, { passive: false })');
    expect(guard).toContain('document.removeEventListener("touchmove", onTouchMove)');
    expect(guard).toContain('document.addEventListener("touchcancel", clearGesture)');
    expect(guard).toContain('document.addEventListener("touchend", clearGesture)');
  });

  test("covers every page root, nested scroll, interactive exemptions, and route reset", async () => {
    const guard = await readFile(guardUrl, "utf8");
    expect(guard).toContain(".v2-page, .landing-page, .center, .workbench-scroll");
    expect(guard).toContain("nestedScrollContainer");
    expect(guard).toContain('[role="slider"]');
    expect(guard).toContain('[draggable="true"]');
    expect(guard).toContain("usePathname()");
    expect(guard).toContain("scrollContainer.scrollTop = 0");
    expect(guard).not.toMatch(/userAgent|navigator\.platform/);
  });
});
```

- [ ] **Step 2: Run the focused integration test and verify RED**

Run: `npm test -- apps/web/app/components/pull-to-refresh-guard.test.ts`

Expected: FAIL because the guard file and root integration do not exist.

- [ ] **Step 3: Implement the guard**

Implement a client component with these exact behaviors:

```tsx
"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { shouldPreventPullToRefresh } from "./pull-to-refresh";

export const MAIN_SCROLL_CONTAINER_SELECTOR =
  ".v2-page, .landing-page, .center, .workbench-scroll";

const INTERACTIVE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [draggable="true"], [data-allow-touch-move]';

type GestureState = {
  startX: number;
  startY: number;
  mainScrollContainer: HTMLElement;
  nestedScrollContainer: HTMLElement | null;
  interactive: boolean;
};

function findNestedScrollContainer(target: Element, main: HTMLElement) {
  let current = target instanceof HTMLElement ? target : target.parentElement;
  while (current && current !== main) {
    const overflowY = getComputedStyle(current).overflowY;
    if (/auto|scroll/.test(overflowY) && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export default function PullToRefreshGuard() {
  const pathname = usePathname();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const scrollContainer = document.querySelector<HTMLElement>(MAIN_SCROLL_CONTAINER_SELECTOR);
      if (scrollContainer) scrollContainer.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    let gesture: GestureState | null = null;
    const clearGesture = () => { gesture = null; };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !(event.target instanceof Element)) {
        clearGesture();
        return;
      }
      const touch = event.touches[0];
      const mainScrollContainer =
        event.target.closest<HTMLElement>(MAIN_SCROLL_CONTAINER_SELECTOR) ??
        document.querySelector<HTMLElement>(MAIN_SCROLL_CONTAINER_SELECTOR);
      if (!mainScrollContainer) return clearGesture();
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        mainScrollContainer,
        nestedScrollContainer: findNestedScrollContainer(event.target, mainScrollContainer),
        interactive: Boolean(event.target.closest(INTERACTIVE_SELECTOR)),
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (shouldPreventPullToRefresh({
        touchCount: event.touches.length,
        startX: gesture.startX,
        startY: gesture.startY,
        currentX: touch.clientX,
        currentY: touch.clientY,
        mainScrollTop: gesture.mainScrollContainer.scrollTop,
        nestedScrollTop: gesture.nestedScrollContainer?.scrollTop ?? null,
        cancelable: event.cancelable,
        interactive: gesture.interactive,
      })) event.preventDefault();
    };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", clearGesture);
    document.addEventListener("touchcancel", clearGesture);
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", clearGesture);
      document.removeEventListener("touchcancel", clearGesture);
    };
  }, []);

  return null;
}
```

- [ ] **Step 4: Mount the guard through the root layout**

Update the layout without changing metadata or viewport behavior:

```tsx
import PullToRefreshGuard from "./components/pull-to-refresh-guard";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div id="root">{children}</div>
        <PullToRefreshGuard />
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Run focused tests and type checking**

Run: `npm test -- apps/web/app/components/pull-to-refresh.test.ts apps/web/app/components/pull-to-refresh-guard.test.ts`

Expected: PASS with zero failures.

Run: `npm run typecheck`

Expected: exit code 0.

### Task 3: Scroll Ownership CSS and Browser Verification

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.css.test.ts`
- Create: `tests/e2e/pull-to-refresh.spec.ts`

**Interfaces:**
- Consumes: page selectors exported by the guard.
- Produces: a non-scrolling document and one vertically scrolling page container per route.

- [ ] **Step 1: Write failing CSS contract tests**

Append tests that assert the exact root and main-scroll declarations:

```ts
describe("H5 scroll ownership", () => {
  test("locks the document roots", async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), "utf8");
    expect(stylesheet).toMatch(/html,\s*body,\s*#root\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;[^}]*overscroll-behavior:\s*none;/s);
  });

  test("moves vertical scrolling to every page container", async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), "utf8");
    expect(stylesheet).toMatch(/\.v2-page,\s*\.landing-page,\s*\.center,\s*\.workbench-scroll\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;[^}]*-webkit-overflow-scrolling:\s*touch;/s);
    expect(stylesheet).toMatch(/\.app-shell\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
  });
});
```

- [ ] **Step 2: Run the CSS tests and verify RED**

Run: `npm test -- apps/web/app/globals.css.test.ts`

Expected: FAIL because the required root lock and unified main-scroll rules are absent.

- [ ] **Step 3: Implement the CSS scroll ownership model**

Replace root minimum-height behavior with:

```css
html,
body,
#root {
  width: 100%;
  height: 100%;
  overflow: hidden;
  overscroll-behavior: none;
}

html,
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Noto Sans SC", "PingFang SC", system-ui, sans-serif;
  letter-spacing: 0;
}
```

Change `.app-shell` from `height: 100dvh` to `height: 100%`, then add after the existing `.workbench-scroll` rule:

```css
.v2-page,
.landing-page,
.center,
.workbench-scroll {
  height: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
}
```

This later rule intentionally overrides earlier `.landing-page`, `.v2-page`, and `.center` minimum-height/overflow declarations without changing their layout, padding, or visual styles.

- [ ] **Step 4: Run CSS and unit tests and verify GREEN**

Run: `npm test -- apps/web/app/globals.css.test.ts apps/web/app/components/pull-to-refresh.test.ts apps/web/app/components/pull-to-refresh-guard.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Write the browser regression test**

Create a Playwright test that mocks authentication and room lists, then verifies the landing page and a long lobby page:

```ts
import { expect, test } from "@playwright/test";

test("document is locked while the active page container scrolls", async ({ page }) => {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, json: { error: "AUTH_REQUIRED" } }),
  );
  await page.goto("/");

  const rootMetrics = await page.evaluate(() => {
    const root = document.getElementById("root")!;
    const pageScroller = document.querySelector<HTMLElement>(".landing-page")!;
    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      rootOverflow: getComputedStyle(root).overflow,
      rootHeight: root.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      pageOverflowY: getComputedStyle(pageScroller).overflowY,
      overscrollY: getComputedStyle(pageScroller).overscrollBehaviorY,
    };
  });

  expect(rootMetrics.bodyOverflow).toBe("hidden");
  expect(rootMetrics.rootOverflow).toBe("hidden");
  expect(rootMetrics.rootHeight).toBeCloseTo(rootMetrics.viewportHeight, 0);
  expect(rootMetrics.pageOverflowY).toBe("auto");
  expect(rootMetrics.overscrollY).toBe("contain");
});

test("long route content scrolls inside the page container", async ({ page }) => {
  const account = {
    id: "a1",
    username: "zhenhuan",
    displayName: "甄嬛",
    isSuperAdmin: false,
    canCreateRoom: true,
    lastLoginAt: "2026-07-31T08:00:00.000Z",
  };
  const rooms = Array.from({ length: 24 }, (_, index) => ({
    id: `room-${index}`,
    name: `测试房间 ${index + 1}`,
    status: "LOBBY",
    creator: "甄嬛",
    memberCount: 1,
    playerCount: 1,
    playerLimit: 5,
    hasPassword: false,
    mine: true,
    characterId: null,
    myCharacter: null,
    isBank: false,
  }));

  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { account, sessions: [] } }),
  );
  await page.route("**/api/rooms/mine", (route) => route.fulfill({ json: rooms }));
  await page.route("**/api/rooms/history", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/rooms", (route) => route.fulfill({ json: [] }));
  await page.goto("/rooms");
  await expect(page.getByRole("heading", { name: "甄嬛" })).toBeVisible();

  const metrics = await page.locator(".v2-page").evaluate((scrollContainer) => {
    scrollContainer.scrollTop = 160;
    return {
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight,
      scrollTop: scrollContainer.scrollTop,
      windowScrollY: window.scrollY,
      bodyScrollTop: document.body.scrollTop,
      documentScrollTop: document.documentElement.scrollTop,
    };
  });

  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.scrollTop).toBeGreaterThan(0);
  expect(metrics.windowScrollY).toBe(0);
  expect(metrics.bodyScrollTop).toBe(0);
  expect(metrics.documentScrollTop).toBe(0);
});
```

- [ ] **Step 6: Run mobile browser verification**

Run: `npx playwright test tests/e2e/pull-to-refresh.spec.ts --project=android-chromium --project=iphone-webkit --project=short-mobile-webkit`

Expected: all tests PASS; the document remains fixed and the internal container scrolls.

- [ ] **Step 7: Run full verification**

Run: `npm test`

Expected: all Vitest tests PASS.

Run: `npm run typecheck`

Expected: exit code 0.

Run: `npm run lint`

Expected: exit code 0 with no warnings.

Run: `npm run build -w @zhenhuan/web`

Expected: Next.js production build exits with code 0.

- [ ] **Step 8: Inspect the final scoped diff**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git diff -- apps/web/app/layout.tsx apps/web/app/components/pull-to-refresh.ts apps/web/app/components/pull-to-refresh.test.ts apps/web/app/components/pull-to-refresh-guard.tsx apps/web/app/components/pull-to-refresh-guard.test.ts apps/web/app/globals.css apps/web/app/globals.css.test.ts tests/e2e/pull-to-refresh.spec.ts`

Expected: only the root scroll ownership, conditional touch guard, tests, and route reset described in this plan.

## Manual Acceptance Boundary

Playwright WebKit uses a browser engine with a mobile viewport but cannot display or assert native Safari/WeChat/PWA browser chrome refresh UI. Record Android Chrome, iOS Safari, WeChat, and installed-PWA pull-to-refresh checks as required manual acceptance rather than claiming automation proves native browser chrome behavior.
