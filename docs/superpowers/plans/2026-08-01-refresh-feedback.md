# Refresh Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every manual refresh button a two-rotation local loading state and a success toast after authoritative data has been refreshed.

**Architecture:** Add a small client-side `RefreshButton` in the existing router module. It owns the 800 ms visual state, disables only itself, calls its supplied asynchronous refresh operation, and emits a supplied success notice only when that operation succeeds. Adapt the workbench, seats, and administrator routes so their existing requests return an explicit success value for the control.

**Tech Stack:** Next.js client component, React hooks, lucide-react, Vitest, Playwright, CSS keyframes.

## Global Constraints

- No API, database, server, or toast-queue contract changes.
- Each manual refresh icon completes exactly two rotations over 800 ms.
- Success notices are exactly `房间快照已刷新`, `席位信息已刷新`, and `后台数据已刷新`.
- A failed request preserves existing error handling and emits no success toast.
- Only the clicked refresh button is disabled by this feature.

---

### Task 1: Specify Refresh Feedback in Tests

**Files:**

- Modify: `apps/web/app/components/app-router-client.test.ts`
- Modify: `tests/e2e/workbench.spec.ts`
- Modify: `tests/e2e/task7-contract.spec.ts`

**Interfaces:**

- Consumes: `RefreshButton` source in `apps/web/app/components/app-router-client.tsx`.
- Produces: structural coverage for the reusable refresh control and browser coverage for a completed workbench refresh.

- [ ] **Step 1: Write the failing component-structure test**

Add this test to `apps/web/app/components/app-router-client.test.ts`:

```ts
describe('manual refresh feedback', () => {
  test('uses a local two-turn refresh control with success notices', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('function RefreshButton(');
    expect(component).toContain('className="refresh-two-turns"');
    expect(component).toContain('notice="房间快照已刷新"');
    expect(component).toContain('notice="席位信息已刷新"');
    expect(component).toContain('notice="后台数据已刷新"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `npm run test --workspace @zhenhuan/web -- app/components/app-router-client.test.ts`.

Expected: FAIL because `RefreshButton` and its notice wiring do not exist.

- [ ] **Step 3: Write failing browser assertions**

Add the following assertion after a successful click of `刷新房间快照` in `tests/e2e/workbench.spec.ts`:

```ts
await expect(page.getByRole('status')).toContainText('房间快照已刷新');
```

Add equivalent assertions to the existing seat and administrator refresh flows in `tests/e2e/task7-contract.spec.ts`, using `席位信息已刷新` and `后台数据已刷新`.

- [ ] **Step 4: Run browser test to verify it fails**

Run `PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/workbench.spec.ts --grep "refresh"`.

Expected: FAIL because no refresh success toast is emitted.

- [ ] **Step 5: Commit failing tests**

Run `git add apps/web/app/components/app-router-client.test.ts tests/e2e/workbench.spec.ts tests/e2e/task7-contract.spec.ts && git commit -m "test: cover refresh feedback"`.

### Task 2: Implement Local Refresh Feedback

**Files:**

- Modify: `apps/web/app/components/app-router-client.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/app/components/app-router-client.test.ts`

**Interfaces:**

- Consumes: `onRefresh: () => Promise<boolean>`, `notice: string`, and `showNotice: (message: string) => void`.
- Produces: `RefreshButton`, which has accessible label/title props and renders `<RefreshCw className="refresh-two-turns" />` while refreshing.

- [ ] **Step 1: Add local refresh control**

Add this component before `Workbench` in `apps/web/app/components/app-router-client.tsx`:

```tsx
const REFRESH_FEEDBACK_MS = 800;

function RefreshButton({ label, refresh, notice, showNotice }: {
  label: string;
  refresh: () => Promise<boolean>;
  notice: string;
  showNotice: (message: string) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  async function handleRefresh() {
    if (refreshing) return;
    const startedAt = performance.now();
    setRefreshing(true);
    const refreshed = await refresh();
    const remaining = REFRESH_FEEDBACK_MS - (performance.now() - startedAt);
    if (remaining > 0)
      await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
    setRefreshing(false);
    if (refreshed) showNotice(notice);
  }
  return <button className="icon" aria-label={label} title={label} disabled={refreshing} onClick={() => void handleRefresh()}><RefreshCw className={refreshing ? "refresh-two-turns" : undefined} /></button>;
}
```

- [ ] **Step 2: Add two-rotation CSS**

Add this beside the existing `.spin` rule in `apps/web/app/globals.css`:

```css
.refresh-two-turns { animation: refresh-two-turns 800ms linear both; }
@keyframes refresh-two-turns { to { transform: rotate(720deg); } }
```

- [ ] **Step 3: Return a boolean from seat refresh**

Make `runRoomTransition` return the task's result and `false` from its failure path. Then make `loadSeats` return the value from `runRoomTransition`, preserving all existing callers:

```tsx
async function loadSeats(roomId: string, preferredView?: "PLAYER" | "BANK", intent: SeatsRouteIntent = "AUTO"): Promise<boolean> {
  const owner = beginRoomTransition(roomId, preferredView ?? null);
  return (await runRoomTransition(owner, () => fetchSeats(owner, preferredView, intent))) ?? false;
}
```

- [ ] **Step 4: Replace the three refresh icons**

Use `RefreshButton` in the workbench, seats, and admin headers. Pass the existing callbacks and these values:

```tsx
label="刷新房间快照" notice="房间快照已刷新"
label="刷新页面" notice="席位信息已刷新"
label="刷新后台" notice="后台数据已刷新"
```

Pass `showNotice` from `AppRouterClient` to `SeatsView` and `AdminView`. In the admin header convert the existing result without changing mutation callers: `refresh={async () => (await onReload()).ok}`.

- [ ] **Step 5: Run component test to verify it passes**

Run `npm run test --workspace @zhenhuan/web -- app/components/app-router-client.test.ts`.

Expected: PASS.

- [ ] **Step 6: Commit implementation**

Run `git add apps/web/app/components/app-router-client.tsx apps/web/app/globals.css apps/web/app/components/app-router-client.test.ts && git commit -m "feat: add refresh feedback"`.

### Task 3: Verify Browser Behavior and Regressions

**Files:**

- Test: `tests/e2e/workbench.spec.ts`
- Test: `tests/e2e/task7-contract.spec.ts`
- Test: `tests/e2e/task7-management.spec.ts`

**Interfaces:**

- Consumes: the three `RefreshButton` instances and their success notices.
- Produces: regression proof that refresh requests reach authoritative endpoints and report completed refreshes.

- [ ] **Step 1: Run targeted browser tests**

Run `PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/workbench.spec.ts tests/e2e/task7-contract.spec.ts tests/e2e/task7-management.spec.ts --grep "refresh|刷新"`.

Expected: PASS, with each successful manual refresh displaying its scoped success toast.

- [ ] **Step 2: Run full relevant web checks**

Run:

```bash
npm run test --workspace @zhenhuan/web
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/workbench.spec.ts tests/e2e/task7-contract.spec.ts tests/e2e/task7-management.spec.ts
```

Expected: PASS with no stale-snapshot, routing, or administrator refresh regression.

- [ ] **Step 3: Commit verified browser coverage**

Run `git add tests/e2e/workbench.spec.ts tests/e2e/task7-contract.spec.ts tests/e2e/task7-management.spec.ts && git commit -m "test: verify refresh feedback in browser"`.
