# Task 7 Second Review Fixes Implementation Plan

> **For agentic workers:** Execute inline with strict RED/GREEN TDD. This workspace has no Git metadata, so no commit steps apply.

**Goal:** Close all six Important and both Minor findings from the independent Task 7 re-review without changing the independent-capability membership model.

**Architecture:** A single room-transition generation owns seats, snapshot, and settlement commits. Every accepted seats response goes through one deterministic router, while explicit capability management is represented as a router intent that still gives FINISHED and displaced control priority. Socket.IO subscriptions are replaced and removed explicitly, and mutation idempotency keys remain pending until the user-visible intent, including required refreshes, completes.

**Tech Stack:** React 19, Next.js 16, TypeScript, Fastify, Socket.IO, Prisma, Vitest, Playwright.

## Global Constraints

- `characterId` and `isBank` remain independent capabilities on one membership.
- Selecting either capability preserves the other and never creates a second Player/assets set.
- PLAYER and BANK use the same `activeSessionId`.
- Authentication remains HttpOnly Cookie-only; no spectator, read-only, Bearer, or local identity recovery path may be introduced.
- Do not edit `.superpowers/sdd/progress.md` or `.superpowers/sdd/task-7-review.md`.
- Before each production edit, run the focused regression and capture its expected failure.

---

### Task 1: Room transition ownership and deterministic seat routing

**Files:**
- Modify: `tests/e2e/task7-contract.spec.ts`
- Modify: `tests/e2e/task7-workflows.spec.ts`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Produce one room transition generation shared by seats, snapshots, and settlements.
- Produce one `routeFromSeats` path with a capability-management intent that never bypasses FINISHED or `activeHere=false` routing.

- [ ] Add browser tests for room A delayed seats after room B, delayed settlement after leaving/opening another room, manual refresh to CONTROL, and manage-seats refresh to SETTLEMENT.
- [ ] Run each new test with `npx playwright test ... --project=desktop-chromium --grep '<name>' --reporter=line`; confirm the current client fails on stale or incorrect screen state.
- [ ] Implement generation checks before every seats/settlement commit and route every fresh seats response through the deterministic router.
- [ ] Re-run the focused cases and confirm they pass.

### Task 2: Real seat DTO skill state

**Files:**
- Modify: `apps/api/src/account-room-service.integration.test.ts`
- Modify: `tests/e2e/workbench.spec.ts`
- Modify: `apps/api/src/account-room-service.ts`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Seats `room` exposes `skillEnabled: boolean`; character `skill` remains the raw allowlisted `skillConfig`.
- UI formats the character skill from `room.skillEnabled` plus the real skill config.

- [ ] Extend the API integration assertion and browser fixture with `room.skillEnabled=false`, expecting `人物技能已停用` despite an active-looking config.
- [ ] Run the API/browser focused tests and observe the missing field/active copy failures.
- [ ] Add `skillEnabled` to the server seats room DTO and use it in the client formatter.
- [ ] Re-run both focused tests to GREEN.

### Task 3: Configured start reward end to end

**Files:**
- Modify: `apps/api/src/prisma-game-service.integration.test.ts`
- Modify: `tests/e2e/workbench.spec.ts`
- Modify: `apps/api/src/prisma-game-service.ts`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Game snapshot exposes `startReward: number` from the room row.
- Player start-reward text and notices use only `snapshot.startReward`.

- [ ] Change the integration fixture to a non-default `startReward=1200`, assert snapshot DTO and request amount, and add a browser assertion that the sheet/button/notice say `1,200`.
- [ ] Run the focused integration/browser cases and observe the missing DTO/hardcoded-copy failures.
- [ ] Return `room.startReward` from snapshot and replace all three hardcoded `1000` strings.
- [ ] Re-run both focused tests to GREEN.

### Task 4: Realtime subscription replacement and payload filtering

**Files:**
- Modify: `tests/e2e/task7-workflows.spec.ts`
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- `room.subscribe` replaces any previous room membership on the socket.
- `room.unsubscribe` leaves the current room; client emits it on room exit/replacement.
- Every room event with a `roomId` is ignored unless it matches the current runtime room.

- [ ] Extend the fake-socket browser test to visit two rooms, assert replacement/unsubscribe, and emit an old-room payload without causing a current-room REST read.
- [ ] Add an API socket test proving a second subscription leaves the first room and explicit unsubscribe leaves the second.
- [ ] Run focused tests and observe accumulated subscription and unfiltered-event failures.
- [ ] Implement server replacement/unsubscribe and client cleanup/filtering.
- [ ] Re-run focused tests to GREEN.

### Task 5: Mutation intent completion and stable keys

**Files:**
- Modify: `tests/e2e/task7-management.spec.ts`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Deferred stable-write results expose an idempotency-key confirmation callback.
- Room/account creation confirms the key only after the required list refresh succeeds.

- [ ] Add room-creation and account-creation tests where POST succeeds, the first follow-up GET fails, and retry sends the same key.
- [ ] Run both focused tests and observe different keys.
- [ ] Add deferred key confirmation and use it around creation plus refresh.
- [ ] Re-run both focused tests to GREEN.

### Task 6: Swap grouping

**Files:**
- Modify: `tests/e2e/task7-workflows.spec.ts`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Requester identity wins for outbox classification; target identity applies to target-phase inbox; bank-phase and bank-only history use bank confirmation/history.

- [ ] Add a player-only `PENDING_BANK` requester and bank-only terminal-history browser fixture with exact group assertions.
- [ ] Run the focused test and observe both misclassifications.
- [ ] Reorder classification using membership identity and phase.
- [ ] Re-run to GREEN.

### Task 7: Selected admin account reconciliation and password cleanup

**Files:**
- Modify: `tests/e2e/task7-management.spec.ts`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Admin reload returns the new `AdminData` to the mutation workflow.
- Account-targeted mutations refresh the selected account/devices and reset password/revoke drafts after success.

- [ ] Add a browser test that disables then enables the selected account and resets its password, asserting the selected action label/status and empty password draft after each mutation.
- [ ] Run it and observe stale status/populated password failures.
- [ ] Reconcile the selected account from refreshed global data and call `refreshAccount` after targeted mutations.
- [ ] Re-run to GREEN.

### Task 8: Verification, report, and self-review

**Files:**
- Modify: `.superpowers/sdd/task-7-report.md`

- [ ] Run focused tests, API integration tests, Task 7 functional matrix, six-project visual matrix, E2E TypeScript, repository typecheck, scoped ESLint, and web build.
- [ ] Run the isolated real Cookie/API/PostgreSQL flow if its validated test database remains available; verify disposable schema removal.
- [ ] Confirm eight non-empty final screenshots remain and inspect desktop/mobile evidence.
- [ ] Scan production for forbidden auth/storage/exclusive-role paths and re-read every latest review finding against code/tests.
- [ ] Append a dated `Second review-fix wave` section with root causes, exact RED/GREEN commands and counts, production changes, concerns, and protected-file hashes.
