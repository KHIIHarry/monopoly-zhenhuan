# Task 3 Report: Room Lobby, Dual Capabilities, Control, and Idempotency

## Status

GREEN for Task 3. After the review fixes, the controller ran the isolated-schema PostgreSQL suite: 26/26 tests passed, including all 9 prior Task 2 cases and 17 Task 3 cases. The route contract, auth/error unit tests, focused ESLint, and focused strict compilation also pass.

No `.git` metadata exists, so no commit was attempted. No Task 4 game-engine authorization, swaps, settlement, or admin-dashboard work was included.

## Implemented Behavior

- Room creation requires `canCreateRoom`, hashes optional passwords with the existing hardened scrypt helper, creates exactly 26 RoomProperty rows, and returns an allowlisted DTO containing `hasPassword` rather than `passwordHash`.
- Room summaries count unique active member Accounts separately from character-bearing players and expose independent caller `characterId`/`isBank` fields rather than exclusive `myRole`.
- Joining uses `Account.displayName`, creates one unseated Membership controlled by the joining Session, creates no Player/assets, bypasses password checks for an existing member, records failed password attempts, and rate-limits the sixth attempt.
- Character and bank acquisition are independent. Either order preserves one Membership, one controller, and at most one Player/asset set. Seat selection validates `activeSessionId` and never changes it.
- First character acquisition creates the one Player, grants one initial-balance transaction/ledger entry only when balance is positive, and assigns the character's initial palace regardless of cash amount.
- Same-character selection is idempotent even with a new key. A second direct character returns `ACCOUNT_CHARACTER_LIMIT_REACHED`; occupied characters return `ROLE_ALREADY_TAKEN`; the occupied bank returns `BANK_ALREADY_TAKEN`.
- Bank-only membership creates no Player, cash, property, turn order, ledger, or settlement asset state.
- Seat snapshots expose current occupation nickname, skill, initial palace, bank occupation, caller `characterId`, `isBank`, `playerId`, and `activeHere`. Occupied characters, including the caller's own, have `canSelect: false`.
- `takeControl` atomically moves the Membership's one shared controller and returns the prior Session to the service caller. Replays preserve that original response and do not add another audit.
- Room write responses are explicit DTOs; no included Prisma Room/Account relation, password hash, Session token hash, or raw token is serialized.
- `ROOM_CREATE_FORBIDDEN` maps to HTTP 403 and `RATE_LIMITED` maps to HTTP 429; state and concurrency errors remain HTTP 409.

## Persistence And Concurrency

`createRoom`, `joinRoom`, `selectCharacter`, `selectBank`, and `takeControl` now require an idempotency key. Their scopes begin with the authenticated Account ID and include the operation/resource, for example `account:<accountId>:room:<roomId>:select-character`. Canonically sorted payloads are fingerprinted with salted scrypt hashes. A matching record is verified with the same constant-time password helper and replays its canonical stored JSON response; a changed payload returns `IDEMPOTENCY_KEY_REUSED`.

The business write and IdempotencyRecord insert share one Serializable transaction. P2034 serialization failures retry. A concurrent P2002 first checks for an idempotency winner; otherwise it remains a domain uniqueness error. Room-scoped joins and seat/control changes acquire a PostgreSQL `FOR UPDATE` lock on the Room row before reading membership/seat state. Migration 007 already supplies the partial unique index for one active bank, so no schema or migration change was needed.

## TDD Evidence

### Clean PostgreSQL RED (Controller)

Command:

```sh
TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public npx vitest run apps/api/src/account-room-service.integration.test.ts
```

Result before production edits: the prior Task 2 suite passed 9/9 and Task 3 failed 9/9 on intended behavior. Observed failures included duplicate room creation instead of replay, missing join audit, `MEMBERSHIP_ALREADY_SEATED` blocking both dual-capability orders, zero-cash palace remaining unowned, same-character retry changing control state, and bank conflict mapping to stale `ROLE_ALREADY_TAKEN`.

The corrected controller contract was also observed RED: a second Session could select a seat instead of receiving `ROOM_CONTROL_LOST`, and the returned included Membership exposed its nested Room and `passwordHash`.

### Route RED

```sh
npx vitest run apps/api/src/server-room-routes.test.ts
```

Result before route changes: 1/1 failed because all five critical routes only checked header presence and did not forward the key to AccountRoomService.

### HTTP Mapping RED/GREEN

```sh
npx vitest run apps/api/src/api-error.test.ts
```

RED: 1 failed / 9 passed because `ROOM_CREATE_FORBIDDEN` returned 409 instead of 403. GREEN: 10/10 passed after explicit permission/rate-limit mapping.

### PostgreSQL GREEN (Controller)

```text
Test Files  1 passed (1)
Tests       18 passed (18)
Duration    5.58s
```

The nine Task 3 PostgreSQL cases cover creation permission/password secrecy/replay isolation; password failure/rate limit/member bypass; both capability orders; bank-only and zero-cash palace state; direct character limit and replay; all three required races through independent Prisma clients; shared controller/takeover; current seat/list DTOs; and critical-write replay without duplicate Membership, Player, ledger, property, IdempotencyRecord, or SecurityLog rows.

## Local Verification

```sh
npx vitest run apps/api/src/server-room-routes.test.ts apps/api/src/auth-domain.test.ts apps/api/src/api-error.test.ts apps/api/src/account-room-service.integration.test.ts
```

Without `TEST_DATABASE_URL`: 17 passed and 18 PostgreSQL tests skipped as intended.

```sh
npx eslint apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/server.ts apps/api/src/server-room-routes.test.ts apps/api/src/api-error.ts apps/api/src/api-error.test.ts --max-warnings=0
```

Result: exit 0.

```sh
npx tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node apps/api/src/account-room-service.ts apps/api/src/api-error.ts apps/api/src/auth-domain.ts
```

Result: exit 0.

The full API project typecheck still fails only in `prisma-game-service.ts` on removed V1 fields such as `deviceTokenHash`, `role`, `onlineStatus`, and `bankControlGrantedAt`. That is the explicit Task 4 migration boundary; there are no diagnostics in the Task 3 production files.

## Test Isolation And Safety

The integration file validates that TEST_DATABASE_URL is PostgreSQL, targets a database ending in `_test`, and is not the configured application database. It creates a randomized schema, applies the complete migration chain, seeds exactly 26 properties and five characters from Master Data, points every Prisma client at that schema, and drops only that schema in `afterAll`. It performs no per-test deletion or truncation and does not weaken or bypass immutable ledger, audit, or settlement triggers.

## Self-Review

- **Race/error mapping:** Room locking serializes same-account and same-seat decisions. The database character constraints and active-bank partial unique index remain final backstops. P2002 is replayed only when an Account-scoped IdempotencyRecord exists; otherwise character and bank handlers map it to their distinct public codes.
- **Replay serialization:** Fresh and replayed success responses both pass through the same canonical JSON conversion, including ISO serialization of Date values. The operation and payload hash are checked before replay, and Account ID in scope prevents cross-account result disclosure.
- **Controller integrity:** Join alone establishes control. Both seat methods check current control before entering replay logic and again inside the locked transaction. Capability acquisition never updates `activeSessionId` or `controlClaimedAt`.
- **Secret leakage:** Public room/list/write/seat objects are assembled field by field. Password material is used only for verification/hash input and never stored in IdempotencyRecord responses or returned.
- **Asset cardinality:** Player creation, positive initial cash ledger, and initial palace assignment occur in one transaction and only on first character acquisition. Bank selection never executes those branches.

## Changed Files

- `apps/api/src/account-room-service.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/server.ts`
- `apps/api/src/server-room-routes.test.ts` (new)
- `apps/api/src/api-error.ts`
- `apps/api/src/api-error.test.ts`
- `.superpowers/sdd/task-3-report.md`

## Remaining Concern

The application cannot fully compile or exercise game writes until Task 4 replaces the legacy PrismaGameService device-token/role authorization boundary. Task 3 deliberately stops before that work.

Room-list classification remains a Minor deferred to Task 7: the lobby currently receives the public/mine flags and groups client-side, while the final H5 task may make `/api/rooms`, `/mine`, and `/history` return strictly classified bands. This review did not change that contract.

## Review Fixes

### Findings Addressed

- Joining now treats `ENDED`, `FINISHED`, and `CLOSED` as terminal. A new or LEFT-member admission while `PLAYING` requires `allowMidgameJoin=true`; an existing ACTIVE member still bypasses the password prompt.
- Character/bank acquisition has a seat-specific lifecycle guard. All terminal states reject, while a missing capability during PLAYING requires midgame admission. Existing capability replay is preserved during non-terminal play. The ordinary `authorizeRoomSession` game-write boundary remains untouched for Task 4.
- `takeControl` uses the shared AccountRoomService terminal-state guard, so ENDED/FINISHED/CLOSED rooms reject takeover. Its HTTP route now returns the complete safe `{ membership, previousSessionId }` result.
- Join password verification, account+room failure counting, SecurityLog creation, error-marker persistence, LEFT restoration, and Membership creation now execute after the Room `FOR UPDATE` lock in one Serializable transaction.
- Failed joins persist only `{ ok: false, error: <public code> }`. Same key/same payload rethrows that stored code without another attempt/log; changed payload returns `IDEMPOTENCY_KEY_REUSED`.
- Six concurrent bad attempts through independent Prisma clients serialize to exactly five `ROOM_PASSWORD_INVALID` results and one `RATE_LIMITED`, with exactly five SecurityLog rows. Failures in one room do not consume another room's budget.
- Only ACTIVE memberships bypass admission. A LEFT row must pass lifecycle/password checks, then the same row is restored with `status=ACTIVE`, `leftAt=null`, current Account display name, and the joining Session controller. A retained bank conflict returns `BANK_ALREADY_TAKEN` rather than violating the partial index.
- Player capacity and slot allocation inspect every retained Player row, not just ACTIVE rows. The first unused configured color and turn order are selected deterministically, matching the database uniqueness domain.
- All new AccountRoomService request fingerprints are salted scrypt encodings. No plain SHA fallback remains. PostgreSQL coverage rejects plaintext, the plain password SHA-256, and the canonical payload SHA-256 in both requestHash and response.

### Review RED Evidence

Focused PostgreSQL command:

```sh
TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public npx vitest run apps/api/src/account-room-service.integration.test.ts --testNamePattern 'terminal and midgame|failed-join replay|concurrent fresh password|retained Player|LEFT membership'
```

Controller result before fixes: 5 failed / 18 skipped. ENDED/midgame joins resolved, repeated wrong-key requests logged twice, six concurrent failures all returned `ROOM_PASSWORD_INVALID`, a retained inactive slot raised `ROLE_ALREADY_TAKEN`, and a LEFT membership bypassed its password and returned inactive.

Takeover route contract:

```sh
npx vitest run apps/api/src/server-room-routes.test.ts
```

Local RED: 1 failed / 1 passed because the route returned `result.membership` and discarded `previousSessionId`.

Final lifecycle RED:

```sh
TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public npx vitest run apps/api/src/account-room-service.integration.test.ts --testNamePattern 'terminal and midgame admission'
```

Controller RED: 1 failed / 22 skipped because `takeControl` still resolved in an ENDED room.

### Review GREEN Evidence

Focused lifecycle after the shared guard fix:

```text
Test Files  1 passed (1)
Tests       1 passed | 22 skipped (23)
```

Intermediate full PostgreSQL run before the final join-race review:

```text
Test Files  1 passed (1)
Tests       23 passed (23)
Duration    9.29s
```

Intermediate local non-database verification before the final join-race review:

```text
Test Files  3 passed | 1 skipped (4)
Tests       18 passed | 23 skipped (41)
```

Focused ESLint and strict AccountRoomService/auth/api-error compilation both exited 0 after the review changes. Full API compilation remains blocked only by the unchanged Task 4 PrismaGameService legacy identity fields documented above.

### Join P2002 Recovery Review

Two natural independent-client races were added first: same account/room/key/same password returns identical Membership DTOs with one Membership, ROOM_JOINED log, and IdempotencyRecord; conflicting passwords under one key produce one persisted public outcome and a losing `IDEMPOTENCY_KEY_REUSED` without duplicate join/password side effects. They passed 2/2 on unchanged production, proving the normal Room-lock serialization path but not the missing P2002 catch branch.

A deterministic regression then created a persisted join winner and wrapped a real PrismaClient so its first `$transaction` attempted a duplicate `(scope,key)` IdempotencyRecord insert. PostgreSQL produced a real Prisma `P2002` while winner reads still delegated to the database.

RED command:

```sh
TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public npx vitest run apps/api/src/account-room-service.integration.test.ts --testNamePattern 'real P2002 at the custom transaction boundary'
```

Controller RED: 1 failed / 25 skipped. The matching replay leaked the raw IdempotencyRecord unique-constraint P2002 at the integration assertion instead of resolving the stored winner.

The custom join catch now polls the exact Account/room/join scope and key up to five times. A winner is accepted only after salted-scrypt verification of the canonical request. Stored success DTOs are returned, stored safe error markers rethrow their public RuleError, changed payloads return `IDEMPOTENCY_KEY_REUSED`, and absence of a winner becomes deliberate `TRANSACTION_CONFLICT` rather than a raw database error. Unrelated uniqueness errors cannot replay another scope/key.

Focused GREEN command:

```sh
TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public npx vitest run apps/api/src/account-room-service.integration.test.ts --testNamePattern 'real P2002 at the custom transaction boundary|concurrent join winner|conflicting concurrent join payloads'
```

Controller result: 3/3 passed.

Final verification after this fix:

```text
PostgreSQL integration: 26/26 passed (9.84s)
Route/auth/api-error:   18/18 passed
Local combined:         18 passed / 26 DB skipped
Focused ESLint:         exit 0
Focused strict compile: exit 0
```
