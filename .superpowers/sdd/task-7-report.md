# Task 7 implementation report

## Status

`DONE`

Task 7 delivers the Cookie-authenticated account H5, room/capability recovery, PLAYER and BANK workbenches, settlement, device/profile, and super-admin surfaces required by the brief. The post-implementation review findings were corrected and the final application passed static, real PostgreSQL, functional, responsive, keyboard, and six-browser visual gates. Task 8 HTTPS/LAN deployment was not started.

There is no `.git` metadata in this workspace, so no commit was created or claimed. `.superpowers/sdd/progress.md` and `.superpowers/sdd/task-7-review.md` were not edited.

## Review fixes

All nine Important and four Minor findings in `.superpowers/sdd/task-7-review.md` were addressed:

- `RunResult<T>` separates successful `void` actions from failure, so a successful landing declaration closes, announces, and refreshes correctly.
- One account-lifetime Socket.IO connection now keeps account revocation active in the lobby while room subscription/invalidation is scoped to active room screens. Leaving clears room, seat, workbench, snapshot, preview, and settlement state.
- Snapshot generations prevent a stale PLAYER read from replacing a later BANK view. `ROOM_CONTROL_LOST` from a write centrally clears stale game data, refetches seats, and routes to takeover.
- Stable per-intent idempotency keys cover room create/join, seat acquisition, swaps, takeover, gameplay, finish, and admin mutations. Keys survive uncertain failures and clear only after confirmed success.
- Plaintext password state clears after successful login/replacement, cancellation, logout, auth invalidation, and socket revocation.
- Finish performs `POST /finish` followed immediately by authoritative `GET /settlement`; the finish key remains pending until the immutable read succeeds.
- Seat skill text comes from allowlisted server skill fields, including disabled state and non-default values such as `companionCashReward: 777`.
- Admin lists traverse cursors with repeated-cursor protection. Tabs expose roving focus, ArrowLeft/ArrowRight/Home/End behavior, and tab/panel relationships.
- Join failures use `role="alert"`; swaps render once under `我的申请`, `待我处理`, or `银行确认`.
- Gameplay trust is memory-only. Production `localStorage`/`sessionStorage` identity and landing persistence was removed.
- The visual suite now uses genuine sequential Tab/Enter navigation on desktop Chromium, keyboard-opens/closes a player action sheet, switches PLAYER/BANK, completes BANK `事务` -> finish -> settlement without a mouse, and exercises admin arrow navigation at 200%.
- The real-stack gate has no committed credential defaults, creates a unique disposable Account with the application `hashPassword` implementation, validates isolation, and cleans the whole disposable schema without bypassing append-only audit protections.

## RED and debugging evidence

### Review regressions

Before the visual fixture correction, desktop Chromium produced 2 passed / 1 failed: the finish screen never reached settlement because production now performs the required immediate GET and the fixture only mocked POST. The corrected fixture serves both routes and asserts the exact sequence `POST /finish`, `GET /settlement`.

Before the database guard, this discovery command incorrectly exited 0 and listed the real-stack test against a production-shaped database:

```bash
TASK7_REAL_STACK=1 TASK7_REAL_USERNAME=task7-guard \
TASK7_REAL_PASSWORD='<redacted>' \
DATABASE_URL='postgresql://user:password@127.0.0.1:5432/production?schema=public' \
NEXT_PUBLIC_API_URL='http://localhost:4000' \
npx playwright test tests/e2e/task7-real-stack.spec.ts --project=desktop-chromium --list
```

After hardening, it exits 1 with `the database name must end in _test`; invalid schemas are independently rejected unless they match `^task7_real_[a-z0-9_]+$`.

The first cleanup attempt correctly exposed migration `011` with PostgreSQL `P0001: SecurityLog is append-only`. Row deletion was removed. Cleanup now closes the browser/socket, disconnects the actor client, reconnects through `public`, drops only the already validated and quoted disposable schema with `CASCADE`, and verifies its absence in `pg_namespace`. No audit-log trigger is bypassed.

The next real run proved schema cleanup on failure but exposed the H5/API 40-character room-name contract: the DOM submitted a truncated name while the test searched for the longer source string. The unique prefix is now bounded so the complete room name fits 40 characters.

The first expanded six-project visual run produced cross-project `tabTo` failures because WebKit touch projects and macOS WebKit's default full-keyboard-access model do not expose Chromium's button Tab order. Coverage was corrected, not production behavior: genuine keyboard-only interaction runs on desktop Chromium; Firefox/WebKit and touch projects use native pointer interaction while retaining semantics, dialog, geometry, 200% desktop, and orientation assertions.

## Real-stack isolation

The gate requires all of these variables explicitly when `TASK7_REAL_STACK=1`:

- `TASK7_REAL_USERNAME` (used as a prefix for a unique disposable actor)
- `TASK7_REAL_PASSWORD` (no source default; report value redacted)
- `DATABASE_URL` using PostgreSQL, a database pathname ending `_test`, and `schema=task7_real_[a-z0-9_]+`
- `NEXT_PUBLIC_API_URL=http://localhost:4000`, matching the `http://localhost:3000` page origin required for the Secure Cookie

The test creates its own Account and application-compatible scrypt hash, one uniquely named room, one Session, one membership, and one Player. It asserts those rows and the real API responses before dropping the entire validated schema. Both the test's internal query and an independent post-run PostgreSQL query returned schema existence `false`.

The isolated verification schema was prepared with all 11 migrations and seeded with 26 properties and 5 characters. The passing invocation was:

```bash
TASK7_REAL_STACK=1 \
TASK7_REAL_USERNAME=task7-real \
TASK7_REAL_PASSWORD='<explicit redacted test password>' \
DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=task7_real_h5_019f9f20' \
NEXT_PUBLIC_API_URL='http://localhost:4000' \
npx playwright test tests/e2e/task7-real-stack.spec.ts \
  --project=desktop-chromium --reporter=line
```

Result: **1/1 passed in 4.6s**. The Secure Cookie was HttpOnly, Secure, SameSite=Lax, and longer than 29 days; login, create, join, character acquisition, bank acquisition, PLAYER/BANK reads, membership/Player identity, and zero unexpected API errors were verified against the real API and PostgreSQL.

## Final verification

### Static gate

```bash
npx tsc -p tests/e2e/tsconfig.json --noEmit --pretty false
npm run typecheck
npx eslint apps/web/app/page.tsx apps/web/next.config.ts playwright.config.ts \
  tests/e2e/task7-contract.spec.ts tests/e2e/task7-management.spec.ts \
  tests/e2e/task7-real-stack.spec.ts tests/e2e/task7-visual.spec.ts \
  tests/e2e/task7-workflows.spec.ts tests/e2e/workbench.spec.ts \
  --max-warnings=0
npm run build -w @zhenhuan/web
```

All commands exited 0. Next.js 16.2.11 compiled, typechecked, generated 3/3 static pages, and emitted `/` plus `/_not-found`.

### Functional matrix

```bash
npx playwright test \
  tests/e2e/workbench.spec.ts \
  tests/e2e/task7-contract.spec.ts \
  tests/e2e/task7-management.spec.ts \
  tests/e2e/task7-workflows.spec.ts \
  --project=desktop-chromium \
  --project=android-chromium \
  --project=iphone-webkit \
  --reporter=line
```

Result: **99/99 passed in 23.3s**, 33 cases on each project.

### Visual/accessibility matrix

The final Playwright invocation was deliberately the visual spec so screenshot evidence remains present:

```bash
npx playwright test tests/e2e/task7-visual.spec.ts --reporter=line
```

Result: **18/18 passed in 39.1s** across desktop Chromium, desktop Firefox, desktop WebKit, Android Chromium, iPhone WebKit, and short-mobile WebKit.

Every state asserts horizontal containment, minimum 44x44 controls, fixed-navigation separation, stable workbench tools, and absence of the Next development indicator. All three desktop engines cover 200% containment on lobby, seats, admin, PLAYER, BANK, finish, and settlement. Desktop Chromium additionally covers real sequential keyboard login, dialogs/action sheets, PLAYER/BANK switching, BANK finish confirmation, settlement details, and admin ArrowLeft/ArrowRight/Home/End. Mobile projects cover 360x800, 390x844, 375x667, and workbench/finish/settlement orientation changes.

## Screenshot evidence

The final run left exactly eight non-empty PNGs. File inspection confirmed valid RGB PNG dimensions, and desktop/mobile contact-sheet review found no blank state, clipped text, incoherent overlap, or fixed-navigation obstruction.

- `test-results/task7-screenshots/desktop-chromium-lobby.png`
- `test-results/task7-screenshots/desktop-chromium-player-workbench.png`
- `test-results/task7-screenshots/desktop-chromium-bank-workbench.png`
- `test-results/task7-screenshots/desktop-chromium-settlement.png`
- `test-results/task7-screenshots/android-chromium-lobby.png`
- `test-results/task7-screenshots/android-chromium-player-workbench.png`
- `test-results/task7-screenshots/android-chromium-bank-workbench.png`
- `test-results/task7-screenshots/android-chromium-settlement.png`

## Route and DTO assumptions

- Authentication uses only the HttpOnly Cookie: `GET /api/auth/me`, login/replace, logout, session list/revoke, and logout-others. No Bearer or JavaScript token path exists.
- Room recovery always starts from authoritative `/rooms/:id/seats`. `characterId`/`playerId` and `isBank` are independent capabilities; switching uses `snapshot?view=PLAYER|BANK` and never mutates membership.
- Gameplay uses Task 3/5 routes and stable `Idempotency-Key`; `/turn/end` is the current valid route.
- Settlement uses `POST /settlement/preview`, `POST /finish`, then `GET /settlement` for the immutable read model.
- Admin list routes use `{ items, nextCursor }`; dashboard, account/device/room/log mutations use the reviewed Task 6 DTOs.
- Socket events contain no auth token and only invalidate authoritative REST state.

## Legacy/security scan

The final scan found no production `Authorization`, Bearer token, token storage, `localStorage`, `sessionStorage`, `myRole`, `membership.role`, legacy login fields/copy, watcher/read-only surface, or obsolete room-end route. Reviewed matches are current device DTOs, negative tests for forbidden storage/copy, and the valid `/api/rooms/:id/turn/end` route.

## Changed files

- `.superpowers/sdd/task-7-report.md`
- `apps/web/app/page.tsx`
- `apps/web/app/globals.css`
- `apps/web/next.config.ts`
- `playwright.config.ts`
- `tests/e2e/task7-contract.spec.ts`
- `tests/e2e/task7-management.spec.ts`
- `tests/e2e/task7-real-stack.spec.ts`
- `tests/e2e/task7-visual.spec.ts`
- `tests/e2e/task7-workflows.spec.ts`
- `tests/e2e/workbench.spec.ts`

Generated review evidence remains under `test-results/task7-screenshots/` and is not application source.

## Final self-review

- Spec compliance: PASS. The Task 7 brief's account/Cookie, lobby, dual-capability, operational, admin, realtime, responsive, keyboard, real-stack, and reporting requirements are represented in code and verification.
- Code quality: PASS. Shared request/error/idempotency/snapshot patterns are centralized; stale async state and socket lifecycle are generation/scoping guarded; no alternate browser authorization model was introduced.
- Security/isolation: PASS. The real gate fails closed, touches only a disposable account inside a validated test schema, preserves append-only history rules, and proves schema removal.
- Review closure: PASS. No Critical, Important, or Minor item from the Task 7 review remains open.
- Residual deployment note: authenticated local use must keep both page and API on `localhost` because the Cookie is Secure. HTTPS/LAN origin deployment remains Task 8.

## Second review-fix wave - 2026-07-27

### Status and scope

`DONE`

This dated section supersedes the earlier final-verification counts. The second review exercised every fresh room-seat response, async room ownership, socket invalidation, stable-write confirmation, admin target reconciliation, skill/start-reward DTOs, and mobile synchronization. Task 8 was not started. There is still no `.git` metadata in the workspace, so no commit is claimed.

`.superpowers/sdd/progress.md` and `.superpowers/sdd/task-7-review.md` remained byte-for-byte unchanged throughout this wave.

### Root causes and corrections

- Room, seat, and settlement reads originally had separate routing side effects. They now share `roomGeneration` and `routeFromSeats`, so stale room A reads cannot replace room B and every accepted seat DTO deterministically selects settlement, takeover, seat management, workbench selection, PLAYER, or BANK.
- A socket seat event could start a newer MANAGE refresh while an explicit AUTO acquisition was still opening PLAYER, making the notification supersede the user's successful action. `activeRoomTransition` now owns explicit transitions and defers invalidation until that work releases routing.
- `ROOM_CONTROL_LOST` still contained the final direct routing bypass: after a successful seat refresh it always forced `CONTROL`. The handler now sends successful seat DTOs through `routeFromSeats(..., 'AUTO')`; only failure to read seats falls back to takeover. A room that finishes concurrently now loads immutable settlement.
- Stable room/admin writes confirmed their idempotency key before the authoritative follow-up read. Room creation and account creation now defer confirmation until the refresh succeeds, retaining the same key after an uncertain post-write refresh failure.
- Admin account mutation refreshes could leave the selected-account panel and password draft attached to stale data. Successful target changes now reconcile selection against the refreshed account list and clear target-specific draft state.
- The browser previously could not present server-configured skill state and start reward authoritatively. Seats now include `room.skillEnabled`; snapshots include `startReward`; the H5 renders disabled skills and non-default configured values without local constants.
- Role-swap terminal and dual-capability cases could appear in the wrong group. Grouping now derives from requester/target membership plus independent BANK authority, keeping one rendered request in `我的申请`, `待我处理`, or `银行确认`.
- Socket room membership is now replaceable rather than additive. The API leaves the prior room before joining a replacement and handles explicit unsubscribe; the client filters payload room IDs, unsubscribes on room replacement/cleanup, and continues to authenticate only from the Cookie.

Independent `characterId` and `isBank` capabilities, one membership/Player identity, shared `activeSessionId`, Cookie-only auth, and memory-only workbench identity remain intact. No spectator or local identity-recovery path was introduced.

### RED/GREEN evidence

The explicit-action/socket race reproduced before the transition ownership fix:

```bash
npx playwright test tests/e2e/task7-workflows.spec.ts \
  --project=desktop-chromium \
  --grep 'preserve explicit seat routing' --reporter=line
```

RED: **1/1 failed** because the expected PLAYER heading never appeared after selection; a later socket MANAGE refresh had superseded the explicit AUTO transition. GREEN after transition ownership and deferred invalidation: the focused routing set passed, and the complete current functional matrix passed.

The final direct-seat-routing gap reproduced independently:

```bash
npx playwright test tests/e2e/task7-workflows.spec.ts \
  --project=desktop-chromium \
  --grep 'ROOM_CONTROL_LOST routes a freshly finished room to settlement' \
  --reporter=line
```

RED: **1/1 failed** on the `对局结算` heading; Playwright's DOM snapshot contained only `该房间已在另一台设备打开`. GREEN after routing the successful seat response through `routeFromSeats`: both control-loss branches passed **2/2** - inactive PLAYING rooms route to takeover and FINISHED rooms route to settlement.

### Fresh final verification

- E2E TypeScript, repository typecheck, scoped ESLint, and the Next.js web production build all exited **0**.
- The serial relevant API suite passed **193/193** across account-room integration, admin integration, Prisma game integration, socket helper, and snapshot contract files.
- The functional matrix passed **135/135**: desktop Chromium **45/45**, Android Chromium **45/45**, and iPhone WebKit **45/45**.
- The real Cookie/API/PostgreSQL gate passed **1/1 in 4.9s** against `zhenhuan_test` using the disposable schema `task7_real_final_20260727`.
- The final six-project visual/accessibility matrix passed **18/18 in 10.1s**.

The functional projects ran sequentially because the real Socket.IO workflow intentionally binds one fixed port. This keeps desktop and mobile invalidation/reconnect coverage identical without cross-project port races; it is test synchronization, not a mobile behavior exception.

### Real-stack cleanup proof

The disposable schema received all 11 migrations and the canonical seed of 26 properties and 5 characters. The real gate verified Secure HttpOnly SameSite=Lax Cookie auth, room create/join, independent character and bank acquisition, explicit PLAYER/BANK reads, one membership, and one Player. Its `finally` cleanup dropped only the validated `task7_real_final_20260727` schema. A separate parameterized `pg_namespace` query returned `false` afterward.

### Screenshot and production scan

The final visual run left exactly eight non-empty RGB PNGs: four 1440x900 desktop states and four Android lobby/PLAYER/BANK/settlement states. Direct inspection found every image nonblank and contained, with readable long fixture text, coherent controls, and no fixed-navigation obstruction.

The production-only scan excluded tests, build output, and `*.tsbuildinfo`. It found no Authorization/Bearer path, browser auth or identity storage, `myRole`, `membership.role`, spectator/watcher surface, or obsolete room-end route. Reviewed regex matches were TypeScript `readonly` declarations and the valid `/turn/end` route. Exactly two production `SeatSnapshot` reads remain; both pass accepted responses through `routeFromSeats`.

### Second-wave changed files

- `.superpowers/sdd/task-7-report.md`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/account-room-service.ts`
- `apps/api/src/app-socket.test.ts`
- `apps/api/src/app.ts`
- `apps/api/src/prisma-game-service.integration.test.ts`
- `apps/api/src/prisma-game-service.ts`
- `apps/web/app/page.tsx`
- `tests/e2e/task7-contract.spec.ts`
- `tests/e2e/task7-management.spec.ts`
- `tests/e2e/task7-real-stack.spec.ts`
- `tests/e2e/task7-workflows.spec.ts`
- `tests/e2e/workbench.spec.ts`

### Concerns

No blocking Task 7 concern remains. Authenticated local development still requires matching `localhost` page/API origins for the Secure Cookie; HTTPS/LAN deployment remains explicitly deferred to Task 8.
