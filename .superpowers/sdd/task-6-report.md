# Task 6 implementation report

## Status

`DONE`

Task 6 implements transactional super-admin account, target-device, room, log, and dashboard APIs. Task 5 settlement behavior remains the only forced-finish implementation and is delegated unchanged. No Task 7 UI was added, migrations `001` through `010` were not edited, and the progress ledger was not edited.

There is no `.git` metadata in this workspace, so no commit was created or claimed.

## RED-first evidence

The managed sandbox initially could not reach localhost PostgreSQL:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts --reporter=dot
```

Initial sandbox result: suite setup failed with Prisma `P1001`; 1 test was skipped. This was a setup failure and was not counted as RED evidence. The identical command was rerun with approved localhost access.

### First valid behavioral RED

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts --reporter=dot
```

Result: 1 failed / 1 total. Real password login and Cookie extraction succeeded in a randomized fully migrated schema; `GET /api/admin/security-logs?limit=10` returned 404 instead of 200.

### Major-family RED partition

The test file was expanded while production remained untouched, then the same command was rerun.

Result: 8 failed / 8 total, 5.20s. Expected missing-behavior failures covered missing SecurityLog/all-room/target-device/member-removal/bank-reassignment routes, stale account replay returning 500, unbounded account-list shape, and the legacy dashboard shape.

### Complete pre-production RED partition

Production was restored after a premature migration/DTO edit, the remaining focused contracts were added, and the same command was rerun before production implementation.

Result: 17 failed / 17 total, 6.78s. Relevant expected output included:

- login `lastLoginAt` was absent;
- account same-key concurrency returned `[200, 500]` rather than `[200, 200]`;
- a forced `ACCOUNT_UPDATED` SecurityLog insert failure left the Account mutation committed;
- LEFT membership join returned 200 rather than `ROOM_MEMBERSHIP_REMOVED`;
- room/device/admin routes returned 404;
- SecurityLog UPDATE, DELETE, and TRUNCATE all fulfilled;
- dashboard returned the legacy flat/raw keys.

### Focused follow-up RED cases

Dashboard/log history:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts -t 'aggregates durable|filters and paginates|delegates forced' --reporter=dot
```

Result: 2 failed / 1 passed / 17 skipped. Durable dashboard returned 500 and the log route returned 404. The existing Task 5 forced-finish delegate passed before Task 6 changes.

Bank different-target contention:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts --reporter=dot
```

First implementation result: 19 passed / 1 failed. Concurrent different-target reassignment returned `[200, 200]` rather than `[200, 409]`.

Create scope and exact bank winner:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts -t 'different username|exact concurrent same-key bank' --reporter=dot
```

Result: 2 failed / 2 selected. A changed create username incorrectly succeeded under the same actor/key, and exact same-key bank contention returned `[200, 409]` instead of `[200, 200]`.

After binding the create scope to actor + `admin:account:create`, the final bank fixture used a third current bank so both target requests represented real transfers. The exact-winner case remained RED once more at 1 failed / 2 other selected passes: `[200, 409]` versus `[200, 200]`. Recovery was then moved into the non-retried serialization-conflict path.

Each production correction above followed its observed focused RED. Later matrix additions exercised already-implemented shared behavior and passed without further production changes.

## Implementation summary

- Added one `executeAdminWrite` primitive for Task 6 writes. It locks the target Account or Room first, rereads the actor Session and Account, authorizes current actor/target state, checks exact Account/scope/key/payload replay, performs the business mutation and SecurityLog/AuditLog atomically, then persists an allowlisted response.
- Retries only serialization/deadlock conflicts. Expected P2002 outcomes recover an exact authorized winner or map to `USERNAME_TAKEN`/`TRANSACTION_CONFLICT`; raw Prisma errors are not returned.
- Account creation, updates, password reset, status changes, and target-session revocation now use the shared primitive. Password reset and disable revoke valid target Sessions atomically. Enable does not revive them.
- Added deterministic bounded account/session lists and explicit `AdminAccountDto`/masked target-device DTOs.
- Added all-room list/detail/config/password/member/bank administration. Private and unjoined rooms are visible to a current super-admin without room membership.
- Permanent member removal retains RoomMembership, Player, properties/history/ledgers/debts/transactions/audits; clears active capabilities/controller; terminalizes matching pending requests/swaps; releases matching locks; and applies the conservative LOBBY/PLAYING/current-turn/sole-bank policies.
- Bank reassignment changes only `isBank`. Exact same-key concurrency recovers one winner; genuine concurrent different-target transfers expose one stable `TRANSACTION_CONFLICT` without retrying the loser into another transfer.
- `joinRoom` and character selection now return `ROOM_MEMBERSHIP_REMOVED` for retained LEFT memberships in LOBBY and PLAYING.
- Added forward migration `011` to reject SecurityLog UPDATE, DELETE, and TRUNCATE and add the actor/date/id cursor index.
- Added bounded, filtered, allowlisted SecurityLog and room AuditLog reads. IPs are masked and unknown actions return metadata without arbitrary JSON.
- Added explicit dashboard aggregates using valid ACTIVE-account Sessions, durable `CHARACTER_SELECTED` snapshots with Character fallback, immutable tied-winner SettlementPlayer snapshots, bounded recent settlements, and current terminal Room name as the explicit room-name snapshot.
- Extended login/self Account DTOs with authoritative `lastLoginAt`.
- Kept forced finish and admin settlement reads delegated to Task 5 `finishRoom()`/`getSettlement()` unchanged. Events remain create-only.

## API and DTO inventory

### Accounts and devices

- `POST /api/admin/accounts`: Idempotency-Key; returns `AdminAccountDto`.
- `GET /api/admin/accounts?query=&status=&permission=&cursor=&limit=`: returns `{ items: AdminAccountDto[], nextCursor }`, ordered `(createdAt DESC, id DESC)`, limit at most 100.
- `PATCH /api/admin/accounts/:id`: independently edits `displayName`, `note`, `isSuperAdmin`, `canCreateRoom`; Idempotency-Key.
- `POST /api/admin/accounts/:id/reset-password`: Idempotency-Key; returns safe Account plus revoked count.
- `POST /api/admin/accounts/:id/disable` and `/enable`: Idempotency-Key; return safe Account plus revoked count.
- `GET /api/admin/accounts/:accountId/sessions?state=&cursor=&limit=`: masked login/last IP, device/browser/OS/timestamps, active/revoked state and reviewed reason; no token hash.
- `POST /api/admin/accounts/:accountId/sessions/:sessionId/revoke`: body `{ reason }`, Idempotency-Key; emits `account.session.revoked` only to `session:<id>` after a creating commit.

`AdminAccountDto` exact keys: `id`, `username`, `displayName`, `note`, `status`, `isSuperAdmin`, `canCreateRoom`, `lastLoginAt`, `createdAt`, `updatedAt`.

Authenticated login/self Account DTO exact keys: `id`, `username`, `displayName`, `isSuperAdmin`, `canCreateRoom`, `lastLoginAt`.

### Rooms

- `GET /api/admin/rooms?query=&status=&cursor=&limit=`
- `GET /api/admin/rooms/:id`
- `PATCH /api/admin/rooms/:id`
- `POST /api/admin/rooms/:id/password`, exact body `{ password: string | null }`
- `POST /api/admin/rooms/:id/members/:memberId/remove`
- `POST /api/admin/rooms/:id/bank/reassign`, exact body `{ targetMembershipId }`
- `POST /api/admin/rooms/:id/finish`, existing Task 5 forced delegate
- `GET /api/admin/rooms/:id/settlement`, existing Task 5 nonmember read
- `GET /api/admin/rooms/:id/audit-logs?action=&actorMemberId=&from=&to=&cursor=&limit=`

Room detail exposes configuration, creator, lifecycle, active memberships, independent `characterId`/`isBank`, `controllerActive` boolean, safe Player/asset counts, blockers, and settlement summary. It never returns `activeSessionId`, password hash, Session relation, or unrestricted JSON.

### Logs and dashboard

- `GET /api/admin/security-logs?action=&actorAccountId=&accountId=&from=&to=&cursor=&limit=`
- `GET /api/admin/dashboard`

Dashboard exact top-level shape:

```text
accounts { total, active }
sessions { valid }
rooms { lobby, playing, finished }
games { settledTotal, averageDurationSeconds }
characterSelections [{ characterId, characterNameSnapshot, count }]
characterWins [{ characterNameSnapshot, count }]
recentGames [{ roomId, roomNameSnapshot, endedAt, durationSeconds, forced, winners }]
```

## Transaction and idempotency self-review

- Target lock precedes actor authorization in every `executeAdminWrite` transaction. Account create locks the actor Account because the target row does not yet exist.
- Actor validation matches Session id/account id, requires unrevoked/unexpired Session, ACTIVE Account, and current `isSuperAdmin=true` before replay.
- Target existence/lifecycle authorization runs before replay; stale, disabled, revoked, expired, or privilege-revoked actors cannot replay cached privileged results.
- Scopes are Account actor + operation + resource. Account create uses one actor-scoped create resource; changed username/display/password under the same key is reuse. Cross-admin keys remain isolated.
- Canonical request hashes are salted scrypt values. Raw passwords exist only in request memory and are absent from responses, SecurityLog/AuditLog detail, and IdempotencyRecord JSON.
- Business changes, SecurityLog/AuditLog, and idempotency response share one transaction. Forced insert-failure tests prove Account and Room changes, audit rows, and idempotency rows roll back.
- P2034/40001/40P01 are the only retry classes. Bank different-target contention deliberately does not retry; it reauthorizes and recovers only an exact persisted key/payload winner.
- Same-target bank assignment is a no-op response with no second audit. Zero-bank LOBBY assignment works; multiple active banks map to `BANK_STATE_INVALID`.
- Expected username uniqueness maps to `USERNAME_TAKEN`; target P2025 paths are pre-read and mapped to safe not-found/conflict codes.
- Task 5 forced finish retains its independently approved Room-locking Account-scoped implementation rather than duplicating settlement logic.

## Safe DTO and policy self-review

- No DTO returns `passwordHash`, `sessionTokenHash`, raw Cookie/token, `activeSessionId`, raw IP, or raw relation graphs.
- Supported log actions project reviewed scalar fields. Unknown actions omit `details`; AuditLog before/after values are restricted to reviewed state keys.
- Account/room/log lists cap at 100 and use deterministic `(createdAt DESC, id DESC)` cursors.
- Username is creation-only. PATCH schemas are strict and do not accept username/password/playerLimit/master/historical fields.
- Password is owned only by the dedicated Room password route; null clears, trimmed nonempty maximum-100 resets, and empty rejects.
- ENDED/FINISHED/CLOSED room mutations reject. PLAYING only permits name/visibility; initialBalance additionally requires no Player/initial ledger.
- Removal never deletes retained Player/assets/history. PLAYING active character Players, assets, debt, current turns, and sole-bank removal are rejected. Matching pending requests/swaps/locks are terminalized/released only for an otherwise eligible removal.
- Dashboard selections and wins come from durable SecurityLog/SettlementPlayer snapshots. Character renames do not rewrite historical winner labels; older selection events use current Character name only as fallback.

## Changed files

- `.superpowers/sdd/task-6-report.md` (new)
- `apps/api/src/account-room-service.ts`
- `apps/api/src/app.ts`
- `apps/api/src/auth-domain.ts`
- `apps/api/src/auth-domain.test.ts`
- `apps/api/src/admin-account-room-service.integration.test.ts` (new)
- `apps/api/src/account-room-service.integration.test.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/202607270011_security_log_append_only/migration.sql` (new)
- `packages/database/src/database-contract.test.ts`
- `packages/database/src/migration-v21.integration.test.ts`

No `apps/web` source file changed.

## Final GREEN verification

### Focused Task 6 PostgreSQL matrix

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts --reporter=dot
```

Result: 1 file passed; 34/34 tests passed, 13.57s.

### Full AccountRoom PostgreSQL suite

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
```

Result: 1 file passed; 60/60 tests passed, 25.46s.

### Task 5/gameplay PostgreSQL regressions

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
```

Result: 1 file passed; 91/91 tests passed, 36.63s.

### Complete API directory with PostgreSQL

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src --reporter=dot
```

Result: 10 files passed; 232/232 tests passed, 41.19s.

### Route/error/settlement/auth contracts

```bash
npx vitest run apps/api/src/settlement.test.ts apps/api/src/settlement-service.contract.test.ts apps/api/src/server-room-routes.test.ts apps/api/src/api-error.test.ts apps/api/src/prisma-game-service.contract.test.ts apps/api/src/auth-domain.test.ts --reporter=dot
```

Result: 6 files passed; 37/37 tests passed.

### Populated migration chain through 011

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run packages/database/src/migration-v21.integration.test.ts --reporter=dot
```

Result: 1/1 test passed, 5.04s.

### Database and delivery contracts

```bash
npx vitest run packages/database/src/database-contract.test.ts packages/database/src/production-delivery.test.ts --reporter=dot
```

Result: 2 files passed; 20/20 tests passed.

### Prisma generation

```bash
npm run db:generate
```

Result: exit 0; Prisma Client 6.19.0 generated from the current schema.

### Focused ESLint

```bash
npx eslint apps/api/src/account-room-service.ts apps/api/src/app.ts apps/api/src/auth-domain.ts apps/api/src/auth-domain.test.ts apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/account-room-service.integration.test.ts packages/database/src/database-contract.test.ts packages/database/src/migration-v21.integration.test.ts --max-warnings=0
```

Result: exit 0; no warnings or errors.

### Clean API build and artifacts

```bash
npm run build -w @zhenhuan/api
test -f apps/api/dist/app.js && test -f apps/api/dist/server.js && test ! -e apps/api/dist/game-service.js && test ! -e apps/api/dist/game-service.d.ts
```

Result: build and all artifact assertions exited 0.

## Concerns

- No unresolved Task 6 implementation concern is known.
- This task intentionally does not add the Task 7 admin UI.
- The first PostgreSQL attempt was blocked by managed-sandbox localhost isolation; every reported RED/GREEN database count comes from the approved rerun using a randomized schema that the fixture alone dropped.

## Task 6 review fixes

### Status

`DONE`

The review correction preserves the explicit removal eligibility rules: a matching pending `GameRequest` now returns stable HTTP 409 `MEMBER_HAS_PENDING_REQUEST` in both `LOBBY` and `PLAYING`, before any membership, Player, request, property lock, audit, security-log, or idempotency mutation. Pending role swaps are still terminalized for an otherwise eligible removal.

Actor-scoped membership responses now expose `activeHere` and never `activeSessionId`. Fresh and replayed join, character selection, bank selection, and take-control responses and their `IdempotencyRecord.response` JSON are allowlisted accordingly. Take-control delivers the displaced Session ID only through a one-shot post-commit callback; replay does not call it. Login, replacement, self-revoke, and take-control SecurityLogs retain their events without storing raw Session IDs in `detailsJson`.

### RED evidence

The first sandboxed PostgreSQL attempt failed setup with Prisma `P1001` and was not counted as RED.

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/account-room-service.integration.test.ts -t 'pending game request|without raw Session identifiers|preserves the joining controller|persists replay for join|correct room password' --reporter=dot
```

Approved localhost rerun: 5 valid behavioral failures plus 1 test-helper scope error / 97 selected-or-skipped tests. Both pending-request removals returned 200 instead of 409; login/replacement/revoke logs contained Session IDs; join lacked `activeHere`; and take-control exposed `activeSessionId`/`previousSessionId`. Production was untouched.

After moving only the test helper to shared scope, the replay/idempotency partition produced valid RED:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts -t 'persists replay for join' --reporter=dot
```

Result: 1 failed / 1 selected / 60 skipped. Fresh and replayed join/select/take-control responses plus all four stored idempotency responses contained raw controller Session IDs.

### Changed files

- `apps/api/src/account-room-service.ts`
- `apps/api/src/app.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/admin-account-room-service.integration.test.ts`
- `apps/api/src/server-room-routes.test.ts`
- `.superpowers/sdd/task-6-report.md`

`.superpowers/sdd/progress.md` was not edited.

### GREEN verification

Exact RED partition after implementation:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/account-room-service.integration.test.ts -t 'pending game request|without raw Session identifiers|preserves the joining controller|persists replay for join|correct room password' --reporter=dot
```

Result: 2 files passed; 6/6 selected tests passed; 91 skipped.

Focused/full Task 6 admin PostgreSQL suite:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/admin-account-room-service.integration.test.ts --reporter=dot
```

Result: 1 file passed; 36/36 tests passed.

Full AccountRoom PostgreSQL suite:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
```

Result: 1 file passed; 61/61 tests passed.

PrismaGame shared auth/control regressions:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
```

Result: 1 file passed; 91/91 tests passed.

API-local tests:

```bash
npx vitest run apps/api/src --reporter=dot
```

Result: 8 files passed / 2 PostgreSQL files skipped; 51/51 local tests passed / 184 database tests skipped.

Focused route contract:

```bash
npx vitest run apps/api/src/server-room-routes.test.ts --reporter=dot
```

Result: 1 file passed; 7/7 tests passed.

Focused ESLint:

```bash
npx eslint apps/api/src/account-room-service.ts apps/api/src/app.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/admin-account-room-service.integration.test.ts apps/api/src/server-room-routes.test.ts --max-warnings=0
```

Result: exit 0; no warnings or errors.

API build:

```bash
npm run build -w @zhenhuan/api
```

Result: exit 0 (`tsc -b --force`).

### Concerns

- No unresolved review-fix concern is known.

## Task 6 review fixes - second wave

### Status

`DONE`

Take-control notification capture is now reset inside every `executeIdempotent` work attempt. A rolled-back attempt cannot leave a displaced Session ID for a later successful creating attempt, while P2002/replay paths remain create-only and cannot emit the callback.

### RED evidence

The focused PostgreSQL test runs the real transaction callback, deliberately throws inside the first transaction after membership/log/idempotency work so PostgreSQL rolls it all back, then injects Prisma `P2034` at the boundary. It covers two retry outcomes independently: the durable controller is already current before retry, and the successful retry actually displaces the old controller.

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts -t 'notification state local to the successful serialization retry' --reporter=dot
```

Result before production edit: 1 passed / 1 failed / 61 skipped. The ordinary retry case emitted exactly once with the old controller from the successful attempt. The already-current retry case incorrectly emitted the rolled-back attempt's stale controller ID instead of emitting nothing.

### Changed files

- `apps/api/src/account-room-service.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `.superpowers/sdd/task-6-report.md`

`.superpowers/sdd/progress.md` was not edited.

### GREEN verification

Focused retry matrix:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts -t 'notification state local to the successful serialization retry' --reporter=dot
```

Result: 1 file passed; 2/2 selected tests passed; 61 skipped.

Full AccountRoom PostgreSQL suite:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
```

Result: 1 file passed; 63/63 tests passed.

Route contract:

```bash
npx vitest run apps/api/src/server-room-routes.test.ts --reporter=dot
```

Result: 1 file passed; 7/7 tests passed.

Focused ESLint:

```bash
npx eslint apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/app.ts apps/api/src/server-room-routes.test.ts --max-warnings=0
```

Result: exit 0; no warnings or errors.

API build:

```bash
npm run build -w @zhenhuan/api
```

Result: exit 0 (`tsc -b --force`).

### Concerns

- No unresolved second-wave concern is known.
