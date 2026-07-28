# Task 7 independent final review

The following is the independent reviewer output, preserved verbatim before the review-fix wave.

## Strengths

- Cookie authentication is centralized in `call()` with `credentials: 'include'`; no Bearer/token path remains.
- The membership model correctly separates `characterId`, `playerId`, `isBank`, and transient `PLAYER | BANK` view.
- Fresh-seat routing prioritizes finished/control-loss states before snapshot reads.
- Dual-capability selection and workbench switching use explicit snapshot views and do not mutate membership.
- Settlement preview, exact confirmation, immutable property details, control takeover, device management, and admin operations have broad deterministic coverage.
- Dialog focus trapping/restoration, reduced motion, safe-area navigation, touch sizing, overflow checks, and six-browser viewport coverage are materially stronger than the previous client.

## Critical

None.

## Important

1. `apps/web/app/page.tsx:536` and `apps/web/app/page.tsx:984` misclassify a successful landing declaration as failure. `gameAction()` uses `result !== undefined` as its success signal, but the callback at line 984 intentionally returns `void`. The server write succeeds while the sheet stays open, the trusted landing is not recorded, no notice appears, and no refresh runs. Return `declared` from the callback or make `run/gameAction` return a discriminated `{ ok, value }` result independent of the task value. Add an E2E assertion covering this exact write.

2. `apps/web/app/page.tsx:588` and `apps/web/app/page.tsx:648` leave the last `selectedRoom` active after returning to the lobby. The socket effect therefore reconnects while the user is in lobby/profile/admin, and a later control/finish event can unexpectedly redirect those screens. In-flight invalidation snapshot reads are also neither aborted nor generation-checked, so an old `PLAYER` request can overwrite a completed `BANK` switch. Scope the socket to active room screens, clear room state on leave/back, and guard commits with room/view generations or `AbortController`.

3. `apps/web/app/page.tsx:391` and `apps/web/app/page.tsx:530` do not route authoritative `ROOM_CONTROL_LOST` responses to takeover. A write rejected after another device takes control remains on the stale game UI unless a socket event or manual refresh subsequently arrives. Handle `ROOM_CONTROL_LOST` centrally by clearing snapshot data and refetching seats before routing to `CONTROL`.

4. `apps/web/app/page.tsx:449`, `:494`, `:506`, `:515`, `:525`, `:640`, and `:698` generate a new idempotency key on every retry. A response-lost retry can duplicate room creation, swap requests, or admin operations. Use the existing per-intent key mechanism for all writes and release the key only after a confirmed successful response. Tests currently check key presence, not stability across an uncertain retry.

5. `apps/web/app/page.tsx:367`, `:418`, `:431`, `:437`, and `:604` retain the plaintext password in React state after successful login, logout, and session revocation. Returning to login can reveal the previous password value and keeps credentials resident for the whole session. Clear the password after success, cancellation, logout, and revocation; retain it only while the third-device replacement decision is active.

6. `tests/e2e/task7-real-stack.spec.ts:4` and `:14` rely on an operator comment rather than enforcing database isolation. With `TASK7_REAL_STACK=1`, the test accepts any `DATABASE_URL`, uses a committed default credential, revokes all active sessions for the named account, and leaves a room behind. A misconfigured run can modify a shared environment. Require explicit credentials, validate an allowlisted test database/schema name at runtime, create a unique disposable account/schema, and clean up in `finally`.

7. `apps/web/app/page.tsx:575` trusts the settlement embedded in the finish response and never performs the required immediate `GET /settlement`. `tests/e2e/task7-workflows.spec.ts:97` and `task7-visual.spec.ts:258` reinforce this by returning the complete settlement from the mutation. Fetch the immutable read model after successful finish and assert the POST-then-GET sequence.

8. `apps/web/app/page.tsx:34` and `:679` ignore the server-provided `character.skill` and display a hardcoded local description. Disabled or reconfigured skills will be presented incorrectly. Render the allowlisted server skill read model, including the disabled state, and test a fixture whose server value differs from the defaults.

9. `tests/e2e/task7-visual.spec.ts:216` and `:254` do not meet the stated accessibility matrix despite the 18 passing cases. The 200% check covers only the lobby; “keyboard-only” uses programmatic focus/click except for one profile dialog; no player action sheet or finish workflow is completed from the keyboard. Add real sequential keyboard navigation at 200% for seats, both workbenches, action sheets, finish, and admin tabs.

## Minor

1. `apps/web/app/page.tsx:917` persists keys containing room and Player IDs in `localStorage`, while `tests/e2e/task7-contract.spec.ts:119` checks for identity-like storage only immediately after login. It does not drive recovery, but it contradicts the test’s stated absence rule and leaves room/player identifiers behind. Prefer server `turnId` data or in-memory state; at minimum scan storage after gameplay.

2. `apps/web/app/page.tsx:552` discards every admin `nextCursor`, so accounts, rooms, and logs beyond the first 100 cannot be managed. Add pagination or cursor-driven loading; management fixtures always return `nextCursor: null`.

3. `apps/web/app/page.tsx:662` renders join failures without `role="alert"`, and the admin tablist at `:725` lacks tab keyboard behavior/relationships. These are missed by the current geometry-focused smoke tests.

4. `apps/web/app/page.tsx:679` renders all role swaps in one undifferentiated list rather than explicit requester outbox, target inbox, and bank-confirmation groups. Actions work, but actor semantics are harder to scan than required.

## Recommendations

- Replace the global boolean runner with a ref-backed mutex plus typed success/error result.
- Add request generations or cancellation to every seats/snapshot/settlement transition.
- Add regression tests for stale WebSocket snapshot ordering, control loss returned by a write, response-lost idempotent retries, post-login credential clearing, and post-game storage.
- Make the real-stack test self-provision and self-clean an isolated schema rather than relying on invocation discipline.

## Assessment

**Ready to merge: With fixes.**

The architecture and coverage are strong, but the landing mutation defect, stale realtime transitions, incomplete control-loss routing, retry-key behavior, credential retention, and unenforced real-test isolation should be fixed before merge. Review was read-only; I did not rerun the reported verification commands.

---

# Task 7 independent re-review after the first fix wave

## Spec-Compliance Verdict

**FAIL for closure.** No Critical defect was found, but six Important gaps remain against the binding Task 7 contract.

## Strengths

- Cookie-only REST/socket authentication and explicit `PLAYER`/`BANK` snapshot views are correctly implemented.
- Snapshot generation protects view-switch races, and `ROOM_CONTROL_LOST` handling clears game state.
- Core domain writes use stable retry keys; finish correctly performs `POST /finish` then authoritative `GET /settlement`.
- Password clearing, admin cursor traversal, dialog focus management, responsive CSS, and real-stack isolation are materially improved.
- Reported 99/99 functional, 18/18 visual, and 1/1 real-stack results are useful evidence, though not proof of the gaps below.

## Critical

None.

## Important

1. **Room-level async transitions remain race-prone.** Only snapshot reads are generation-guarded at `apps/web/app/page.tsx:598`; seats and settlement reads at `:594` and `:688` are not. `openRoom()` changes `selectedRoom` before entering the busy runner at `:556`, while lobby room buttons remain enabled at `:812`. Clicking room A then B while A's seats request is delayed drops B's request but lets A later open, with `selectedRoom` already B. Delayed settlement reads can similarly return after leaving or choosing another room and force `SETTLEMENT`.

2. **Not every fresh seats response uses the required deterministic router.** The correct router exists at `apps/web/app/page.tsx:571`, but management and manual refresh bypass it at `:709` and `:797`. A refresh returning `activeHere=false` can leave the full seats UI visible, and a room finishing between GAME and "manage seats" can route to seats instead of settlement. The contract requires routing after every fresh seats response.

3. **Disabled room skills are presented as active.** The UI tests `skill.enabled` at `apps/web/app/page.tsx:337`, but the actual seats DTO returns only `character.skillConfig` at `apps/api/src/account-room-service.ts:1180`; room `skillEnabled` is absent. Consequently a skills-disabled room still displays each active skill at `page.tsx:843`. No revised browser fixture covers the report's claimed disabled state.

4. **Configurable start reward is hardcoded as 1000.** Player notices and controls use `1000` at `apps/web/app/page.tsx:1194`, `:1327`, and `:1333`, although room creation permits arbitrary values. The server awards `room.startReward` at `apps/api/src/prisma-game-service.ts:328`, while its snapshot DTO omits that field at `:149`. A 1200-room therefore tells players they are requesting 1000 while awarding 1200.

5. **Realtime room subscriptions are never cleaned up.** The client only emits `room.subscribe` at `apps/web/app/page.tsx:740` and `:762`; room changes or lobby return emit no unsubscribe or reconnect. The server only joins rooms at `apps/api/src/app.ts:247`. Because the callback at `page.tsx:723` also ignores event `roomId`, events from any previously visited room refetch the current room. This directly violates the subscription-cleanup requirement.

6. **A confirmed mutation followed by refresh failure can still duplicate the user intent.** `useStableWrite()` deletes the key immediately after the mutation response at `apps/web/app/page.tsx:326`; room and admin creation then perform separate reads at `:796` and `:878`. If the POST succeeds but those reads fail, the same confirmation form remains and retry uses a new key, permitting duplicate rooms/accounts. The tests only abort the mutation response itself at `tests/e2e/task7-management.spec.ts:21`.

## Minor

1. Role-swap grouping at `apps/web/app/page.tsx:835` puts every `PENDING_BANK` request under "bank confirmation" before checking requester identity. A player-only requester's cancellable outbox item is therefore mislabeled; bank-only terminal history can likewise appear under "my inbox".

2. Successful account-admin mutations reload global lists but not the selected account at `apps/web/app/page.tsx:878`. Disable/enable state remains stale, and the reset password draft created at `:859` remains populated after success.

## Code-Quality Verdict

**NOT PASS.** Helpers, accessibility work, and focused tests are generally strong, but duplicated seat-routing logic and incomplete async ownership inside the 2,032-line page have already produced inconsistent invariants and untested race paths.

## Readiness

**Task 7 is not ready to close.** Resolve the Important findings and add focused tests for cross-room stale seats/settlement, manual-refresh routing, disabled skills against the real DTO, non-default start rewards, room subscription replacement, and post-success refresh failure. No files were edited and no broad suite was rerun.
