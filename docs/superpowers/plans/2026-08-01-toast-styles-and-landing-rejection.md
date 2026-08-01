# Toast Styles and Landing Rejection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved responsive green/red Toast presentation and notify only the declaring player after a fresh committed landing cancellation.

**Architecture:** Extend the existing post-commit notifier with a landing-specific callback backed by persisted `LandingEvent` data and Session-targeted Socket emission. Carry a small success/rejected tone through the existing FIFO queue and select CSS/icon presentation from that tone without changing queue timing.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Fastify, Socket.IO, React/Next.js, CSS, Vitest, Playwright, Docker Compose

## Global Constraints

- Success/fund Toast: pale-green background, dark-green text, `1px solid var(--jade)` border, `8px` radius.
- Rejection Toast: pale-red background, dark-red text, `1px` dark-red border, `8px` radius.
- Entry animation: `260ms ease-out`, opacity `0` to `1`, vertical translation `-12px` to `0`.
- Desktop: top-right, maximum width `680px`, normal messages stay on one line.
- Mobile: top-center, width `calc(100% - 8px)`, text `12px`, icon `13px`, compact spacing, normal messages stay on one line.
- `prefers-reduced-motion: reduce` disables animation.
- Existing FIFO duration remains exactly `3_000ms`; no close control, focus capture, or pointer interception.
- A freshly committed "取消地产操作" emits `你的落点申请已被银行拒绝：<原因>` only to the declaring player's active Session.
- Replaying the same idempotency key emits no additional notification.
- Notification delivery failure cannot roll back the committed landing cancellation.
- Preserve all pre-existing uncommitted changes and stage only task-owned hunks.
- Runtime and Playwright must use Docker Compose and port 3000.

---

## File Structure

- Modify `apps/api/src/realtime-toast-notifications.ts`: landing rejection builder and notifier interface.
- Modify `apps/api/src/realtime-toast-notifications.test.ts`: focused delivery-builder cases.
- Modify `apps/api/src/prisma-game-service.ts`: fresh-commit callback for landing cancellation.
- Modify `apps/api/src/prisma-game-service.integration.test.ts`: post-commit/replay regression.
- Modify `apps/api/src/app.ts`: Socket notifier wiring.
- Modify `apps/api/src/app-socket.test.ts`: Session-channel emission contract.
- Modify `apps/web/app/components/toast-queue.ts`: preserve Toast tone.
- Modify `apps/web/app/components/toast-queue.test.ts`: FIFO tone coverage.
- Modify `apps/web/app/components/app-router-client.tsx`: kind-to-tone mapping, keyed Toast, red icon.
- Modify `apps/web/app/components/app-router-client.test.ts`: render and realtime mapping contract.
- Modify `apps/web/app/globals.css`: approved green/red responsive styles and entry animation.
- Modify `tests/style-device-spacing.test.mjs`: exact CSS contract.
- Modify `tests/e2e/fund-flow-toast.spec.ts`: real-stack landing rejection and responsive style assertions.

### Task 1: Landing Cancellation Notification Pipeline

**Files:**
- Modify: `apps/api/src/realtime-toast-notifications.ts`
- Modify: `apps/api/src/realtime-toast-notifications.test.ts`
- Modify: `apps/api/src/prisma-game-service.ts`
- Modify: `apps/api/src/prisma-game-service.integration.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app-socket.test.ts`

**Interfaces:**
- Produce: `buildLandingRejectionToastDelivery(database, landingId, reason): Promise<ToastDelivery | null>`
- Extend: `PostCommitToastNotifier.landingRejected(roomId, landingId, reason)`
- Reuse: `RealtimeToastEvent.kind = 'REQUEST_REJECTED'` and `audience = 'PLAYER'`

- [ ] **Step 1: Write failing builder tests**

Assert a cancelled landing with an active player Session returns:

```ts
{
  sessionId: 'player-session',
  event: {
    eventId: 'landing-1:rejected:PLAYER:player-1',
    roomId: 'room-1',
    audience: 'PLAYER',
    kind: 'REQUEST_REJECTED',
    message: '你的落点申请已被银行拒绝：现场落点有误',
  },
}
```

Also assert `null` for a missing landing, a landing without `propertyActionsCancelled`, and a player without an active Session.

- [ ] **Step 2: Verify RED**

Run: `npm test -- apps/api/src/realtime-toast-notifications.test.ts`

Expected: FAIL because the landing builder is not exported.

- [ ] **Step 3: Implement the persisted landing builder**

Query `landingEvent` by ID including `player.member.activeSessionId`. Require `propertyActionsCancelled === true`, trim the supplied reason, cap the final message with the existing `wireMessage`, and return the exact stable event above.

- [ ] **Step 4: Write failing service and Socket tests**

Add a PostgreSQL integration test that cancels one landing twice with the same key and expects:

```ts
expect(rejected).toEqual([{ roomId: room.id, landingId: landing.id, reason: '现场落点有误' }]);
```

Extend the Socket notifier test so `landingRejected()` emits the builder result to `session:player-session` as `room.toast`.

- [ ] **Step 5: Verify RED**

Run: `npm test -- apps/api/src/app-socket.test.ts`

Run: `npm run test:integration -- -t "notifies the player once when landing property actions are cancelled"`

Expected: FAIL because the notifier has no landing callback.

- [ ] **Step 6: Add the fresh post-commit callback**

Extend `PostCommitToastNotifier`, `createPostCommitToastNotifier`, and `cancelLandingPropertyActions`. Pass the callback through `executeIdempotent`'s existing `afterCommit` slot so it runs only when `execution.created` is true and remains inside the existing best-effort error boundary.

- [ ] **Step 7: Verify GREEN and commit**

Run the builder, Socket, and filtered PostgreSQL integration tests, then `npm run typecheck` and `git diff --check` for the six task files. Stage only Task 1 hunks and commit:

```bash
git commit -m "fix(api): notify players of rejected landings"
```

### Task 2: Responsive Success and Rejection Toast Presentation

**Files:**
- Modify: `apps/web/app/components/toast-queue.ts`
- Modify: `apps/web/app/components/toast-queue.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx`
- Modify: `apps/web/app/components/app-router-client.test.ts`
- Modify: `apps/web/app/globals.css`
- Modify: `tests/style-device-spacing.test.mjs`
- Modify: `tests/e2e/fund-flow-toast.spec.ts`

**Interfaces:**
- Produce: `ToastTone = 'SUCCESS' | 'REJECTED'`
- Extend: `ToastInput.tone?: ToastTone` and `ToastItem.tone: ToastTone`
- Map: realtime `REQUEST_REJECTED` to `REJECTED`; all other realtime/local Toasts to `SUCCESS`

- [ ] **Step 1: Write failing queue and render tests**

Assert the queue preserves an explicit rejected tone and defaults omitted tone to success. Assert the client enqueues `tone: parsed.data.kind === "REQUEST_REJECTED" ? "REJECTED" : "SUCCESS"`, renders a root keyed by `toast.id`, applies `toast-rejected`/`toast-success`, and uses `CircleX` for rejection and `Check` for success.

- [ ] **Step 2: Write failing CSS contract tests**

Assert the exact global constraints: both variants, `8px` radius, `toast-enter 260ms ease-out both`, opacity/translate keyframes, desktop `680px` maximum width and nowrap, mobile `calc(100% - 8px)`, `12px` text, `13px` icon, compact padding/gap, and reduced-motion override.

- [ ] **Step 3: Verify RED**

Run:

```bash
npm test -- apps/web/app/components/toast-queue.test.ts apps/web/app/components/app-router-client.test.ts
node --test tests/style-device-spacing.test.mjs
```

Expected: FAIL on missing tone, keyed variant markup, and approved CSS.

- [ ] **Step 4: Implement minimal queue, render, and CSS changes**

Preserve the existing timer/deduplication logic. Use the Toast event ID as the React key so each FIFO replacement mounts a new node. Use `translate` in keyframes rather than animating `transform`, preserving mobile `translateX(-50%)` centering.

- [ ] **Step 5: Verify focused GREEN**

Re-run the focused queue, component, and static style tests. Expected: all pass with no snapshots or timing changes.

- [ ] **Step 6: Extend real-stack Playwright coverage**

In the existing Docker-backed Toast test, assert desktop and iPhone computed styles for success and rejection variants and confirm landing cancellation shows the exact red Toast only to the declaring player. Verify no wrapping for the representative messages and capture responsive screenshots.

- [ ] **Step 7: Run E2E, quality checks, and commit**

Run Playwright with `PLAYWRIGHT_EXTERNAL_STACK=1` on port 3000, then focused tests, `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check`. Restore any generated `next-env.d.ts` path change. Stage only Task 2 hunks and commit:

```bash
git commit -m "feat(web): style success and rejection toasts"
```

### Task 3: Whole-Feature Verification

**Files:**
- Verify all Task 1 and Task 2 files.

**Interfaces:**
- Consumes the landing rejection pipeline and responsive tone presentation from Tasks 1-2.
- Produces final review evidence only; no new production API.

- [ ] **Step 1: Run the complete non-database test suite**

Run: `npm test`

Expected: zero failures.

- [ ] **Step 2: Run focused PostgreSQL integration and real-stack E2E**

Run: `npm run test:integration -- -t "notifies the player once when landing property actions are cancelled"`

Run: `PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/fund-flow-toast.spec.ts --project=desktop-chromium --project=iphone-webkit`

Expected: landing rejection, transfer rejection, success Toast, responsive positioning, and queue timing all pass.

- [ ] **Step 3: Run static verification**

Run `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check`. Expected: all exit 0.

- [ ] **Step 4: Independent review**

Review exact spec compliance, Session privacy, idempotency, post-commit ordering, mobile single-line fit, reduced motion, dirty-file boundaries, and regression coverage. Fix and re-review every Critical or Important finding before completion.
