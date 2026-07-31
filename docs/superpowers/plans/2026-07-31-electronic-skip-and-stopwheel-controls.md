# Electronic Skip And Stopwheel Controls Implementation Plan

**Goal:** Let an electronic-dice player reliably skip a blocked turn and let the bank manage stopwheel counts through one explicit add/remove form.

**Architecture:** Add a dedicated player skip-turn command that consumes exactly one outstanding stopwheel entry before advancing the active electronic turn. Replace the bank's two simultaneous actions with an `ADD` or `REMOVE` mode; the selected mode exclusively determines fields, validation, confirmation, and API request.

## Tasks

### Task 1: Prove and implement electronic skip-turn behavior

**Files:**
- Modify: `apps/api/src/prisma-game-service.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/prisma-game-service.integration.test.ts`

1. Add a failing integration test for a current player with one stopwheel count and no dice result; it calls `skipTurn`, expects the count to become zero, the active turn to end, and the next actionable player to receive the new turn.
2. Add `skipTurn(actor, roomId, playerId, key)`. It requires an active electronic turn owned by the player, no dice result, and at least one remaining stopwheel count. It consumes one record FIFO, ends the active turn, creates the next actionable turn, and writes an audit event.
3. Add `POST /api/rooms/:id/turn/skip` with the same player authorization and notification behavior as roll/end routes.
4. Remove the electronic-mode rejection for `CONSUME_SKIP_TURNS`, so every supported stopwheel deduction path follows the same count and reason validation.

### Task 2: Make bank stopwheel adjustment a single-mode form

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `tests/e2e/task7-contract.spec.ts`

1. Add failing browser tests for a green filled `扣减` mode, a red filled `增加` mode, one `提交` form action, and electronic-mode submission to the matching add/remove API.
2. Introduce `skipAdjustmentMode: 'ADD' | 'REMOVE'`. The segmented controls set the mode and clear the inactive mode's validation fields.
3. Render only the selected mode's fields: add shows count, source, and explanation; remove shows a 1-to-remaining-count selector and reason. Disable remove with a zero-count player.
4. Submit one dynamic form action. It opens the existing confirmation dialog with add/remove-specific text and calls only the selected endpoint after confirmation.
5. Style the selected add control red and selected remove control jade green, with non-selected controls neutral.

### Task 3: Wire the player UI and deploy the API build

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx`
- Test: `tests/e2e/task7-contract.spec.ts`

1. Add a failing browser test that a blocked electronic player sees `跳过回合`, not `掷骰` or ordinary `结束回合`, and posts to `/turn/skip`.
2. Invoke the new endpoint from the player action. Keep normal end-turn behavior unchanged for an unblocked player.
3. Rebuild and restart the API Compose service so `apps/api/dist` includes the service changes; verify the live compiled service contains the new skip command.
4. Run typecheck, lint, unit tests, relevant browser tests, and the database integration test when the test database is available.
