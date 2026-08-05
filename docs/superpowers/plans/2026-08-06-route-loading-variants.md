# Route Loading Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single generic route skeleton with four page-specific structural skeletons and one shared palace-red loader while enforcing 600ms and 300ms minimum durations by route type.

**Architecture:** `AppRouterClient` classifies the target `AppPage` into a loading variant and passes that variant to `RouteSkeleton`. The existing transition gate accepts a per-navigation minimum duration so dedicated skeletons use 600ms and generic full-screen loaders use 300ms without affecting button-level busy states.

**Tech Stack:** Next.js, React, TypeScript, CSS Modules, Lucide React, Vitest, Playwright, Docker Compose.

## Global Constraints

- Dedicated skeleton routes: `rooms`, `player`, `bank`, and `workbench`.
- Dedicated skeleton minimum duration: `600ms`.
- All other full-page route loaders minimum duration: `300ms`.
- Button submissions, transfers, and approvals keep their existing inline loaders and gain no artificial delay.
- Ordinary player and bank pages never render a player/bank switch row.
- Mobile navigation skeletons contain no item boxes or active gold segment.
- Loader icon uses palace red `#741f28`, `46px` dimensions, `3px` stroke, and visible `加载中...` text on both mobile and desktop.
- Services and browser tests use Docker Compose on ports `3000` and `4000`; no alternate test port is permitted.
- Do not push changes without explicit user confirmation.

---

### Task 1: Route Loading Policy And Timing

**Files:**
- Modify: `apps/web/app/components/route-transition.ts`
- Modify: `apps/web/app/components/route-transition-presentation.ts`
- Modify: `apps/web/app/components/route-transition.test.ts`
- Modify: `apps/web/app/components/route-transition-presentation.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx`
- Modify: `apps/web/app/components/app-router-client.test.ts`

**Interfaces:**
- Produces: `RouteSkeletonVariant`, `routeSkeletonVariant(page)`, `routeLoadingMinimumMs(page)`, `MIN_ROUTE_LOADER_MS`.
- Changes: `createMinimumRouteSkeletonGate().begin(minimumMs?)` and `useRouteTransitionPresentation(loading, minimumMs)`.

- [x] **Step 1: Write failing unit and source-contract tests**

Add assertions that `rooms/player/bank/workbench` map to dedicated variants and `600`, while profile, administration, room creation/join, seats, finish, and settlement map to `loader` and `300`. Add a fake-timer test that begins the existing gate with `MIN_ROUTE_LOADER_MS` and releases at 300ms.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
docker compose exec -T web npm exec vitest run apps/web/app/components/route-transition.test.ts apps/web/app/components/route-transition-presentation.test.ts apps/web/app/components/app-router-client.test.ts
```

Expected: failures for the missing loader constant, per-navigation duration, and route variant mapping.

- [x] **Step 3: Implement the minimum policy**

Add:

```ts
export const MIN_ROUTE_LOADER_MS = 300;

begin(minimumMs = defaultMinimumMs) {
  activeMinimumMs = minimumMs;
  // existing generation and start-time logic
}
```

Pass the page-specific duration into `useRouteTransitionPresentation`, and pass the selected variant into `RouteSkeleton` without touching local `busy` button state.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same Vitest command and require zero failures.

### Task 2: Structural Skeletons And Shared Loader

**Files:**
- Modify: `apps/web/app/components/route-skeleton.tsx`
- Modify: `apps/web/app/components/route-skeleton.module.css`
- Modify: `apps/web/app/components/route-skeleton.test.ts`
- Modify: `apps/web/app/loading.tsx`

**Interfaces:**
- Consumes: `RouteSkeletonVariant` from Task 1.
- Produces: `<RouteSkeleton variant={variant} />` with `data-variant`, `route-skeleton` for dedicated variants, and `route-loader` for generic loading.

- [x] **Step 1: Write failing component and CSS tests**

Render every variant and assert:

```ts
expect(markup).toContain('data-variant="rooms"');
expect(markup).toContain('data-variant="player"');
expect(markup).toContain('data-variant="bank"');
expect(markup).toContain('data-variant="workbench"');
expect(loaderMarkup).toContain('data-testid="route-loader"');
expect(loaderMarkup).toContain('加载中...');
```

Assert CSS contains `#741f28`, `46px`, `stroke-width: 3`, one `1.6s` shimmer, desktop breakpoint `900px`, reduced-motion handling, and no mobile navigation item placeholder or active gold segment.

- [x] **Step 2: Run component tests and verify RED**

```bash
docker compose exec -T web npm exec vitest run apps/web/app/components/route-skeleton.test.ts
```

Expected: failures because variants and the new loader do not exist.

- [x] **Step 3: Implement the approved structures**

Build stable region-level markup only:

- Rooms: red account header and three room-list regions.
- Player: navigation, red header, identity strip, turn strip, operation region, and property region.
- Bank: navigation, red header, three-column summary, current-turn region, player overview, and approvals region.
- Workbench: centered title area, two identity choices, and two command regions.
- Loader: `LoaderCircle` plus `加载中...`, identical mobile and desktop sizing.

Use a single synchronized shimmer layer on large regions. Do not add per-label or per-icon placeholders.

- [x] **Step 4: Run component tests and verify GREEN**

Run the focused component test and require zero failures.

### Task 3: Browser Timing, Responsive Verification, And Docker Deployment

**Files:**
- Modify: `tests/e2e/routing.spec.ts`
- Update only if commands or behavior changed: `README.md`
- Delete after implementation verification: the thread visualization preview file outside the project.

**Interfaces:**
- Consumes: route variants and minimum timings from Tasks 1-2.
- Verifies: final browser behavior on the existing Docker stack.

- [x] **Step 1: Write failing Playwright assertions**

Cover a fast dedicated transition lasting at least 550ms, a fast generic loader transition lasting at least 250ms and less than 1000ms, the correct `data-variant`, no player/bank switch row for ordinary identities, and responsive visibility at `360x800` and `1440x900`.

- [x] **Step 2: Run the focused Docker-backed browser test and verify RED**

```bash
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/routing.spec.ts --project=desktop-chromium
```

Expected: failures until the new test IDs and 300ms generic policy are active in the Docker-hosted application.

- [x] **Step 3: Rebuild the Docker web service**

```bash
docker compose up -d --build --force-recreate web
docker compose ps
```

Require Web on `3000`, API on `4000`, and PostgreSQL healthy.

- [x] **Step 4: Run the complete quality gates**

```bash
docker compose exec -T web npm run lint
docker compose exec -T web npm run typecheck
docker compose exec -T web npm run test
docker compose stop web
docker compose run --rm --no-deps web npm run build
docker compose start web
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/routing.spec.ts --project=desktop-chromium
```

All commands must exit `0`.

- [x] **Step 5: Perform visual browser checks**

Use the Docker-hosted app at `http://localhost:3000` and verify all four dedicated skeletons plus the generic loader at `360x800` and `1440x900`. Confirm loader icon/text sizing, absence of mobile navigation boxes and the left gold segment, no unexpected workbench switch row, no clipping, and no white fade overlay in the settled page.

- [x] **Step 6: Remove temporary previews and inspect the final diff**

Delete the visualization HTML created for approval, keep `/tmp` captures outside Git, run `git status --short` and `git diff --check`, and do not push.
