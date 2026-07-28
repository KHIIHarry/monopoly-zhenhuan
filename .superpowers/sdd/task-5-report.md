# Task 5 implementation report

## RED evidence

1. Pure settlement and route contracts, before production edits:

   ```bash
   npx vitest run apps/api/src/settlement.test.ts apps/api/src/server-room-routes.test.ts --reporter=dot
   ```

   Result: 4 failed / 9 passed. The failures established the additive `mortgagePrice * 2` valuation/detail contract, actual finish idempotency-key forwarding, create-only WebSocket invalidation, and the required confirmation error.

2. Database contract, before migration `010`:

   ```bash
   npx vitest run packages/database/src/database-contract.test.ts --reporter=dot
   ```

   Result: 1 failed / 12 passed. The failure proved that the forward transactional-settlement migration and its post-finalization guards were absent.

3. Focused real-PostgreSQL settlement cases, before the transactional implementation:

   ```bash
   TEST_DATABASE_URL='<isolated PostgreSQL *_test URL>' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
   ```

   Result for the focused settlement selection: 4 failed / 43 skipped. The failures covered stale/non-atomic preview-to-finish data, blocker handling, authorization/idempotency ordering, and immutable settlement persistence.

4. Populated forward migration, before migration `010` existed:

   ```bash
   TEST_DATABASE_URL='<isolated PostgreSQL *_test URL>' npx vitest run packages/database/src/migration-v21.integration.test.ts --reporter=dot
   ```

   Result: 1/1 failed because `202607270010_transactional_settlement` was absent.

5. Follow-up gap contracts, after the first implementation pass:

   ```bash
   npx vitest run apps/api/src/settlement.test.ts apps/api/src/settlement-service.contract.test.ts apps/api/src/server-room-routes.test.ts apps/api/src/api-error.test.ts --reporter=dot
   ```

   Result: 4 failed / 13 passed. A separate focused cross-room participant-binding PostgreSQL case failed 1/1. The failures established the true blocker discriminated union, behavioral `P2002` recovery boundary, public error mapping, complete pristine-turn detection, and same-room membership/Player validation.

## Implementation summary

- Replaced preview-then-persist settlement with one Room-locking Serializable finish transaction. It freshly validates Account, Session, current controller, bank capability or super-admin authority before idempotency replay; rereads blockers and assets; creates settlement/children, terminalizes the Room, writes audit/security logs, and persists the response atomically.
- Added narrow retry for PostgreSQL serialization/deadlock conflicts. Behavioral `P2002` recovery reauthorizes under the Room lock and replays only an exact persisted Account/key/payload winner; otherwise it returns `TRANSACTION_CONFLICT`.
- Normal finish is limited to blocker-free `PLAYING` Rooms and exact confirmation `确认结束游戏`. Forced super-admin finish requires a normalized nonblank reason and applies the exact request/swap/lock/landing/turn cleanup matrix without rewriting financial or audit history.
- Added coherent member-bank and super-admin previews, member and super-admin settlement reads, separate normal/admin finish routes, allowlisted DTOs, create-only `room.finished` and `settlement.created` invalidations, and stable public error/status mapping.
- Removed the production `PrismaGameService.end()` bypass. `start()` now sets `Room.startedAt` once, and every representative game-write family and all role-swap actions reject `ENDED`, `FINISHED`, and `CLOSED`.
- Settlement valuation uses `cash + unmortgagedPropertyValue + mortgagedPropertyNetValue + buildingSellValue`. Land sale value is always `mortgagePrice * 2`; purchase price is never used. Ranking uses total wealth, cash, and unmortgaged value, then competition ranks and shared winners for exact ties.
- Each property detail snapshots its allowlisted identity/name, mortgage inputs, land values, building level/sell price/value. Master Data changes cannot affect stored settlement reads.

## Membership and Player binding review

- The corrected product authority permits exactly one `RoomMembership` per Account/Room, a nullable `characterId` independent of `isBank`, one shared `activeSessionId`, and at most one durable Player/assets set per membership.
- Settlement creates exactly one row for each ACTIVE membership with a non-null character and its ACTIVE, same-room Player bound to that same character.
- Bank-only membership is excluded. A dual-capability membership is included exactly once.
- A characterless replacement target's retained Player/assets remain attached and untouched but are not a settlement participant until rebound to a matching character.
- Cross-room or mismatched bindings produce `SETTLEMENT_DATA_INVALID`; forced closure records the blocker and omits the invalid participant rather than inventing data.

## Lifecycle and migration behavior

- Normal finish: `PLAYING` only. `LOBBY` returns `ROOM_NOT_PLAYING`; legacy `ENDED` returns `LEGACY_SETTLEMENT_UNAVAILABLE`; terminal Rooms reject new completion.
- Forced finish: super-admin may finalize `LOBBY`, `PLAYING`, or legacy `ENDED` with a reason. `CLOSED` rejects. Native `FINISHED` without a settlement is treated as `SETTLEMENT_INCONSISTENT` corruption.
- An already-authorized exact Account/key/payload replay may return the stored `FINISHED` result; a changed payload returns `IDEMPOTENCY_KEY_REUSED`, another key returns `ROOM_FINISHED`, and revoked/stale authorization cannot replay.
- Migration `202607270010_transactional_settlement` adds `Room.startedAt` and `GameSettlement.overriddenBlockersJson`, initializes legacy PLAYING start time, reclassifies legacy `FINISHED` Rooms without settlements to `ENDED`, closes post-finalization parent/child INSERT holes, and prevents changing/reopening a terminal Room that owns a settlement.
- Existing immutable settlement UPDATE, DELETE, and TRUNCATE triggers remain in force. PostgreSQL coverage proves parent and child INSERT/UPDATE/DELETE/TRUNCATE rejection and byte stability after attempted mutation.
- Migrations `001` through `009` were not edited in Task 5; `010` is forward-only.

## Route and DTO inventory

- `POST /api/rooms/:id/settlement/preview`: current ACTIVE bank controller, `PLAYING` only.
- `POST /api/admin/rooms/:id/settlement/preview`: current super-admin coherent preview for `LOBBY`, `PLAYING`, or legacy `ENDED`.
- `POST /api/rooms/:id/finish`: normal bank finish with actual `Idempotency-Key` and exact confirmation.
- `POST /api/admin/rooms/:id/finish`: forced super-admin finish with actual `Idempotency-Key` and reason.
- `GET /api/rooms/:id/settlement`: allowlisted read for any existing room membership, including historical `LEFT`.
- `GET /api/admin/rooms/:id/settlement`: allowlisted super-admin nonmember read.
- Preview/settlement responses expose only safe blocker, ranking, value, property-detail, lifecycle, and forced-override fields. They do not expose raw Prisma relations, Session ids, tokens, request payloads, password fields, or internal database errors.

## Changed files

- `.superpowers/sdd/task-5-report.md` (new)
- `apps/api/src/settlement.ts`
- `apps/api/src/settlement.test.ts`
- `apps/api/src/account-room-service.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/prisma-game-service.ts`
- `apps/api/src/prisma-game-service.integration.test.ts`
- `apps/api/src/server.ts`
- `apps/api/src/server-room-routes.test.ts`
- `apps/api/src/settlement-service.contract.test.ts` (new)
- `apps/api/src/api-error.ts`
- `apps/api/src/api-error.test.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/202607270010_transactional_settlement/migration.sql` (new)
- `packages/database/src/database-contract.test.ts`
- `packages/database/src/migration-v21.integration.test.ts`

No `apps/web` source file was changed.

## Final GREEN verification

1. Prisma generation:

   ```bash
   npm run db:generate
   ```

   Result: exit 0; Prisma Client 6.19.0 generated from the current schema.

2. Populated migration chain through `010`:

   ```bash
   TEST_DATABASE_URL='<isolated PostgreSQL *_test URL>' npx vitest run packages/database/src/migration-v21.integration.test.ts --reporter=dot
   ```

   Result: 1/1 passed, 4.99s.

3. Full AccountRoom PostgreSQL suite:

   ```bash
   TEST_DATABASE_URL='<isolated PostgreSQL *_test URL>' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
   ```

   Result: 58/58 passed, 24.55s.

4. Full PrismaGame PostgreSQL suite:

   ```bash
   TEST_DATABASE_URL='<isolated PostgreSQL *_test URL>' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
   ```

   Result: 90/90 passed, 36.70s.

5. Focused settlement, route, error, game-boundary, and database contracts:

   ```bash
   npx vitest run apps/api/src/settlement.test.ts apps/api/src/settlement-service.contract.test.ts apps/api/src/server-room-routes.test.ts apps/api/src/api-error.test.ts apps/api/src/prisma-game-service.contract.test.ts packages/database/src/database-contract.test.ts --reporter=dot
   ```

   Result: 6 files passed; 44/44 tests passed.

6. Complete API directory with PostgreSQL enabled:

   ```bash
   TEST_DATABASE_URL='<isolated PostgreSQL *_test URL>' npx vitest run apps/api/src --reporter=dot
   ```

   Result: 9 files passed; 195/195 tests passed, 36.04s.

7. Database and production-delivery contracts:

   ```bash
   npx vitest run packages/database/src/database-contract.test.ts packages/database/src/production-delivery.test.ts --reporter=dot
   ```

   Result: 2 files passed; 19/19 tests passed.

8. Focused lint:

   ```bash
   npx eslint apps/api/src/settlement.ts apps/api/src/settlement.test.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/server.ts apps/api/src/server-room-routes.test.ts apps/api/src/settlement-service.contract.test.ts apps/api/src/api-error.ts apps/api/src/api-error.test.ts packages/database/src/database-contract.test.ts packages/database/src/migration-v21.integration.test.ts packages/database/src/production-delivery.test.ts --max-warnings=0
   ```

   Result: exit 0, no warnings or errors.

9. Clean API build and deployable artifact assertions:

   ```bash
   npm run build -w @zhenhuan/api
   test -f apps/api/dist/server.js
   test ! -e apps/api/dist/game-service.js
   test ! -e apps/api/dist/game-service.d.ts
   ```

   Result: all four commands exited 0. `dist/server.js` exists; both legacy artifacts are absent.

## Self-review and concerns

- Authorization precedes every idempotency replay, including conflict recovery. Account identity scopes the key; Session/token data is excluded from canonical payloads and persisted DTOs.
- Preview and finish reread participants, properties, definitions, blockers, and current authorization in coherent Room-locking Serializable transactions. Preview drift therefore cannot become a stale persisted snapshot.
- Forced cleanup is limited to pending operational state and lock release. It does not alter balances, debts, ownership, ledgers, committed transactions, prior audit rows, or historical values.
- Settlement parent/child writes occur before the final Room transition so the new post-finalization INSERT guards do not create a bypass or block the legitimate transaction.
- Create-only event tests prevent duplicate `room.finished`/`settlement.created` notifications on replay or failure; clients refetch the REST snapshot.
- The first database verification attempt in the managed sandbox could not reach localhost and was rerun with approved local-network access. All reported PostgreSQL counts are from executed tests, not skips.
- No unresolved Task 5 implementation concern remains.

## Final-review correction pass

### Review-fix RED evidence

1. Import-safe application builder and behavioral routes:

   ```bash
   npx vitest run apps/api/src/server-room-routes.test.ts --reporter=dot
   ```

   Result before production changes: the suite failed during import because `./app.js` did not exist. This established the missing application builder that can be imported without listening.

2. Focused AccountRoom PostgreSQL findings:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts -t 'different rooms|finishes atomically|behaviorally recovers|forces closure|public-replacement retained|projects allowlisted' --reporter=dot
   ```

   Result before production changes: 5 failed / 1 passed / 54 skipped. The failures proved the empty-valid-roster error precedence, uncleared `Room.turnNumber`, missing shared terminal timestamps, retained-player negative-balance leakage into settlement, and unsafe stored-JSON projection. The one passing case proved the controlled real-PostgreSQL `P2002` recovery boundary.

3. Retained replacement settlement isolation:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts -t 'public-replacement retained Player' --reporter=dot
   ```

   Result before production changes: 1 failed / 59 skipped because the retained characterless Player's negative balance still blocked preview.

4. Retained replacement gameplay targets:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts -t 'non-current PLAYING replacement|every gameplay target mutation' --reporter=dot
   ```

   Result before production changes: 2 failed / 89 skipped. Toll still reached balance charging instead of `NO_TOLL_DUE`, and transfer, balance/property/skip/fine, trade creation, trade confirmation, and approval paths still accepted retained gameplay targets.

### Review-fix implementation

- Centralized the current gameplay-participant predicate as an ACTIVE Player with an ACTIVE same-room membership whose non-null `characterId` exactly matches `Player.characterId`.
- Validated transfer recipients, toll owners, balance/property/skip/fine targets, landing Players, and both trade participants under the Room lock after actor authorization and before ordinary or conflict idempotency replay. Explicit invalid targets return `PLAYER_NOT_FOUND`; a dormant toll owner returns `NO_TOLL_DUE`; a replaced Player acting directly returns `PLAYER_IDENTITY_MISMATCH`.
- Kept request rejection, landing cancellation, historical `reverseLatest`, and its unfiltered `changeBalance` compensation behavior available. Retained Player rows, balances, properties, ledgers, transactions, and audit history are not deleted or rewritten.
- Restricted settlement candidates and `INVALID_PLAYER_BALANCE` to the same corrected participant predicate. An empty valid normal roster now returns `SETTLEMENT_DATA_INVALID` before generic blockers.
- Cleared both `Room.currentTurnPlayerId` and `Room.turnNumber`, and used one captured `endedAt` for the settlement, active Turns, terminal AuditLog, and terminal SecurityLog.
- Replaced stored settlement JSON casts with Zod validation plus explicit allowlisted projection for winners, ranking, blockers, and every property detail. Extra fields are stripped; malformed required shapes return `SETTLEMENT_INCONSISTENT`.
- Added `buildApiApp()` in `apps/api/src/app.ts`; `server.ts` is now a listening-only production entry point. Fastify injection tests cover Cookie authentication, member/admin route separation, actual `Idempotency-Key` forwarding, public errors, safe DTOs, and create-only notifier emission.
- Kept the Room lock for settlement concurrency. The controlled uniqueness test now throws an actual Prisma `P2002` produced by PostgreSQL and exercises exact-winner recovery with fresh authorization.
- Corrected the product route inventory to `POST /api/rooms/:id/finish` and `POST /api/admin/rooms/:id/finish`. No `/settlement/finish` route is implemented.

### Review-fix changed files

- `.superpowers/sdd/task-5-report.md`
- `apps/api/src/app.ts` (new import-safe application builder)
- `apps/api/src/server.ts`
- `apps/api/src/server-room-routes.test.ts`
- `apps/api/src/account-room-service.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/prisma-game-service.ts`
- `apps/api/src/prisma-game-service.integration.test.ts`
- `apps/api/src/settlement-service.contract.test.ts`

No Prisma schema or migration changed during this correction pass; the forward-only migration chain through `010` remains unchanged.

### Review-fix GREEN verification

1. Behavioral application builder/routes:

   ```bash
   npx vitest run apps/api/src/server-room-routes.test.ts --reporter=dot
   ```

   Result: 1 file passed; 7/7 tests passed.

2. Focused AccountRoom PostgreSQL corrections:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts -t 'different rooms|finishes atomically|behaviorally recovers|forces closure|public-replacement retained|projects allowlisted' --reporter=dot
   ```

   Result: 6/6 selected tests passed; 54 skipped.

3. Focused retained gameplay targets:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts -t 'non-current PLAYING replacement|every gameplay target mutation' --reporter=dot
   ```

   Result: 2/2 selected tests passed; 89 skipped.

4. Full AccountRoom PostgreSQL suite:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
   ```

   Result: 60/60 tests passed, 24.39s.

5. Full PrismaGame PostgreSQL suite:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
   ```

   Result: 91/91 tests passed, 36.22s.

6. Complete API directory with PostgreSQL enabled:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src --reporter=dot
   ```

   The first run found one stale source contract after the runtime Zod union became the blocker source of truth: 197 passed / 1 failed. The contract was corrected to assert all nine runtime discriminator variants, required resource fields, and the derived TypeScript type. The fresh rerun passed 9 files and 198/198 tests in 36.46s.

7. Pure settlement, route, error, and game contracts:

   ```bash
   npx vitest run apps/api/src/settlement.test.ts apps/api/src/settlement-service.contract.test.ts apps/api/src/server-room-routes.test.ts apps/api/src/api-error.test.ts apps/api/src/prisma-game-service.contract.test.ts --reporter=dot
   ```

   Result: 5 files passed; 31/31 tests passed.

8. Database and production-delivery contracts:

   ```bash
   npx vitest run packages/database/src/database-contract.test.ts packages/database/src/production-delivery.test.ts --reporter=dot
   ```

   Result: 2 files passed; 19/19 tests passed.

9. Populated forward migration chain:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run packages/database/src/migration-v21.integration.test.ts --reporter=dot
   ```

   Result: 1/1 test passed, 4.71s.

10. Prisma generation:

    ```bash
    npm run db:generate
    ```

    Result: exit 0; Prisma Client 6.19.0 generated from the current schema.

11. Focused lint:

    ```bash
    npx eslint apps/api/src/settlement.ts apps/api/src/settlement.test.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/src/server-room-routes.test.ts apps/api/src/settlement-service.contract.test.ts apps/api/src/api-error.ts apps/api/src/api-error.test.ts packages/database/src/database-contract.test.ts packages/database/src/migration-v21.integration.test.ts packages/database/src/production-delivery.test.ts --max-warnings=0
    ```

    Result: exit 0, no warnings or errors.

12. Clean API build and artifacts:

    ```bash
    npm run build -w @zhenhuan/api
    test -f apps/api/dist/app.js
    test -f apps/api/dist/server.js
    test ! -e apps/api/dist/game-service.js
    test ! -e apps/api/dist/game-service.d.ts
    ```

    Result: all five commands exited 0. Both application artifacts exist and both legacy artifacts are absent.

### Review-fix self-review and concerns

- Every invalid current-participant validator is read-only and runs before idempotency lookup, so failure persists zero business or idempotency mutation. Conflict replay repeats authorization and participant validation.
- The comprehensive public-replacement test covers assignment to a retained owner and an omitted-owner property patch, both sides of a pending trade, a stale landing Player, and byte/count invariance for retained Player/assets/history and all business tables in scope.
- Settlement excludes a characterless retained Player without producing `SETTLEMENT_DATA_INVALID` or `INVALID_PLAYER_BALANCE`, while the matching active replacement with dual player/bank capability is included exactly once.
- The initial managed-sandbox PostgreSQL attempt failed during connection setup with `P1001`. Every reported PostgreSQL pass count above comes from the same commands rerun with approved localhost access, not from skipped tests.
- No forward migration, ledger/history/audit guard, settlement immutability trigger, or Task 6/7 behavior was broadened or weakened.

## Final independent re-review correction

### Remaining Important finding and RED evidence

The independent reviewer found no Critical or Minor issue and one Important issue: `requirePlayableAdjustedPropertyOwner()` validated only the requested/resulting owner. An explicit `ownerPlayerId: null` or reassignment to a playable Player could therefore remove a property from a dormant retained Player and persist business, audit, and idempotency mutation.

Focused public-replacement coverage now seeds a second property onto the Player before replacement, then attempts both an explicit clear and reassignment to an active playable Player after replacement. Both operations must return `PLAYER_NOT_FOUND`, and the existing full Player/property/request/landing/skip/transaction/ledger/audit/idempotency snapshot must remain equal.

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts -t 'every gameplay target mutation' --reporter=dot
```

Result before the production correction: 1 selected test failed and 90 were skipped. The error-code vector received `FULFILLED` for exactly the explicit clear and reassignment cases where `PLAYER_NOT_FOUND` was expected. This proved the missing current-owner validation rather than a setup or assertion failure.

### Minimal production correction

- `requirePlayableAdjustedPropertyOwner()` now collects both the property's current `ownerPlayerId` and the requested `ownerPlayerId`, removes null/undefined values, and passes them to the existing deduplicating `requirePlayablePlayers()` predicate.
- The validator remains under the Room lock and before ordinary/conflict idempotency replay. Cleanup, rejection, cancellation, historical reversal, and settlement behavior are unchanged.
- Explicit clear or reassignment from a dormant retained owner now returns `PLAYER_NOT_FOUND` before any property, audit, or idempotency write. Assignment to a dormant requested owner and omitted-owner mutation of a dormant-owned property remain rejected as before.

Changed in this final correction:

- `.superpowers/sdd/task-5-report.md`
- `apps/api/src/prisma-game-service.ts`
- `apps/api/src/prisma-game-service.integration.test.ts`

### Final-correction GREEN verification

1. Focused dormant-owner property guard:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts -t 'every gameplay target mutation' --reporter=dot
   ```

   Result: 1/1 selected test passed; 90 skipped, 5.03s.

2. Full PrismaGame PostgreSQL suite:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
   ```

   Result: 91/91 tests passed, 37.52s.

3. Complete API directory with PostgreSQL enabled:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src --reporter=dot
   ```

   Result: 9 files passed; 198/198 tests passed, 37.24s.

4. Focused lint:

   ```bash
   npx eslint apps/api/src/settlement.ts apps/api/src/settlement.test.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/src/server-room-routes.test.ts apps/api/src/settlement-service.contract.test.ts apps/api/src/api-error.ts apps/api/src/api-error.test.ts packages/database/src/database-contract.test.ts packages/database/src/migration-v21.integration.test.ts packages/database/src/production-delivery.test.ts --max-warnings=0
   ```

   Result: exit 0, no warnings or errors.

5. Clean API build and artifact assertions:

   ```bash
   npm run build -w @zhenhuan/api
   test -f apps/api/dist/app.js
   test -f apps/api/dist/server.js
   test ! -e apps/api/dist/game-service.js
   test ! -e apps/api/dist/game-service.d.ts
   ```

   Result: the build and all four assertions exited 0. The build script removed `dist` before compiling; both application artifacts exist and both legacy artifacts are absent.

### Final-correction self-review

- The test was observed RED for the exact two bypasses before the production helper changed, then GREEN with the same database-backed test.
- The batch validator deduplicates the current/requested IDs, so an unchanged active owner is checked once and behavior is otherwise unchanged.
- The post-attempt snapshot proves the dormant Player, every room property, pending requests, landing event, skip entries, transactions, ledgers, audits, request count, and global idempotency count remain unchanged.
- No remaining implementation concern is known pending the mandatory independent re-review.

### Mandatory independent re-review verdict

The independent reviewer inspected the live implementation and tests read-only after the final correction and returned:

- Critical: none.
- Important: none.
- Minor: none.
- Spec-compliance verdict: PASS.
- Code-quality verdict: PASS.
- Ready to close Task 5: YES.

The reviewer independently verified the focused retained-owner PostgreSQL regression at 1 passed / 90 skipped and the complete API suite at 9 files and 198/198 tests passed. It specifically confirmed that both current and requested property owners use the centralized playable predicate before replay or mutation, and that explicit clearing/reassignment preserves property, audit, ledger, request, and idempotency state for the dormant retained Player.

Task 5 result: `DONE`. No implementation concern remains.
