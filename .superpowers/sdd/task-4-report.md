# Task 4 implementation report

## RED evidence

1. Baseline API compilation:

   ```bash
   npm run build -w @zhenhuan/api
   ```

   Failed with 15 legacy-field diagnostics in `prisma-game-service.ts` for removed `RoomMembership` fields including `deviceTokenHash`, `role`, `onlineStatus`, and `bankControlGrantedAt`.

2. Targeted boundary/route RED, before production edits:

   ```bash
   npx vitest run apps/api/src/server-room-routes.test.ts apps/api/src/prisma-game-service.contract.test.ts
   ```

   Result: 2 files failed; 4 tests failed and 2 existing tests passed. The failures proved missing swap idempotency forwarding, raw Cookie token passage to game methods, legacy admission/reconnect APIs and fields, and the absent explicit game actor.

3. First isolated PostgreSQL game run:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
   ```

   Result: 81 failed / 4 passed. Every failure came from the leftover `TRUNCATE Room CASCADE`, which correctly raised `P0001 settlement history is immutable`. The trigger was not changed or bypassed. The reset was removed; tests use unique data inside one randomized migrated schema and teardown drops only that schema.

4. Subsequent PostgreSQL RED iterations:

   - 71 passed / 14 failed: stale legacy terminal/replay assertions plus one real `P2010`/SQLSTATE `40001` serialization escape.
   - 84 passed / 1 failed: one remaining stale end-replay assertion.

   The implementation now narrowly retries Prisma `P2034` and raw-query `P2010` only when PostgreSQL reports `40001` or `40P01`.

## GREEN evidence

1. Full migrated game PostgreSQL suite:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
   ```

   Final result after snapshot authorization/read transaction tightening: 1 file passed, 87/87 tests passed, 32.75s.

2. AccountRoom PostgreSQL suite, including Task 4 swap coverage:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
   ```

   Result: 1 file passed, 29/29 tests passed, 11.51s.

3. Focused boundary/route GREEN:

   ```bash
   npx vitest run apps/api/src/server-room-routes.test.ts apps/api/src/prisma-game-service.contract.test.ts
   ```

   Result: 2 files passed, 6/6 tests passed.

4. API unit/route/non-DB integration discovery:

   ```bash
   npx vitest run apps/api/src --reporter=dot
   ```

   Result: 7 files passed, 1 DB-only file skipped; 39 passed / 112 skipped.

5. Focused lint:

   ```bash
   npx eslint apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/prisma-game-service.contract.test.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/server.ts apps/api/src/server-room-routes.test.ts --max-warnings=0
   ```

   Result: exit 0, no warnings or errors.

6. Full API TypeScript compilation:

   ```bash
   npm run build -w @zhenhuan/api
   ```

   Result: exit 0.

## Implementation summary

- Replaced the game-domain token boundary with `GameActor { accountId, sessionId }`.
- Removed legacy game room creation/admission/reconnect/authorizer APIs and every removed membership-field read.
- Removed `AuthenticatedSession.rawToken`; login still returns a newly issued token only to the Cookie response path.
- Every game mutation locks the room and revalidates Account, Session, membership, controller, terminal status, capability, and Player identity inside its Serializable write/idempotency transaction before replay.
- Game idempotency scopes include Account, room, operation/resource, and canonical payload. `GameRequest.idempotencyKey` is Account-prefixed.
- Snapshot and Socket.IO subscription authorization use the Cookie Session/controller. Snapshot accepts explicit `PLAYER`/`BANK` views, requires one for dual members, and now performs authorization plus all reads in one locked Serializable transaction.
- Added all five idempotent role-swap actions with controller/terminal checks, compare-and-set state transitions, allowlisted DTOs, separate action/execution audits, and post-success notifications.
- Added a test-only V2 fixture facade over `AccountRoomService`; production has no compatibility join/reconnect methods.
- The game suite creates a randomized schema, applies every migration, seeds 26 properties and five characters, never truncates guarded history/settlement tables, and drops only its own schema.

## Changed files

- `.superpowers/sdd/task-4-report.md`
- `apps/api/src/account-room-service.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/prisma-game-service.ts`
- `apps/api/src/prisma-game-service.integration.test.ts`
- `apps/api/src/prisma-game-service.contract.test.ts` (new)
- `apps/api/src/server.ts`
- `apps/api/src/server-room-routes.test.ts`

## Deleted files

- `apps/api/src/game-service.ts`
- `apps/api/src/game-service.test.ts`
- `apps/api/src/game-service-mvp.test.ts`

## Authorization and idempotency self-review

- Authorization precedes idempotency replay in the same room-locking transaction, including conflict replay paths.
- A revoked/expired Session, disabled Account, stale controller, inactive/wrong-room membership, wrong capability, wrong Player, or terminal room cannot mutate or observe a cached write result.
- Room takeover and game writes serialize on the same Room row. Confirmed `40001`/`40P01` races retry narrowly; unrelated raw-query errors are not swallowed.
- Cross-Account keys cannot collide or replay because scopes/`GameRequest` keys contain Account identity, while Session identifiers and Cookie tokens are excluded from canonical payloads and stored responses.
- A dual member uses one membership, controller Session, audit membership, Player, and asset set for both capabilities.

## Swap asset-invariance review

- Execution temporarily nulls membership and Player character bindings, then writes only the new bindings and request status.
- `isBank`, `activeSessionId`, `controlClaimedAt`, Player IDs, balances, properties/buildings, skip turns, partner cards, pawn colors, turn order, ledger, transactions, requests, and audit history are preserved.
- Mutual swaps reuse both Players. Replacement keeps the former target's retained Player/assets attached but unauthorized while characterless.
- A retained Player selecting a later free character reuses its slot/assets and receives no second initial ledger or palace.
- A first Player created in LOBBY receives the normal one-time initial balance/ledger and unowned initial palace. A first Player created during PLAYING starts with zero and receives neither grant.
- Bank confirmation is a distinct `BANK` audit even when the same dual Account made the target decision; final execution is also a separate immutable audit row.

## Concerns and product reconciliation

- The corrected goal attachment contains a stale subtraction-form wealth equation, while the designated V2.1 product authority and controller direction require additive wealth. Task 4 did not alter settlement calculation and follows the V2.1 authority.
- No immutable history or settlement trigger was disabled, dropped, or weakened.

## Task 4 review-fix pass

### Binding scope

- `.superpowers/sdd/task-4-fix-brief.md` is the review-fix contract.
- `.superpowers/sdd/task-4-brief.md:15` excludes settlement implementation and frontend work from Task 4.
- `IMPLEMENTATION_PLAN_V2.md:107-124` and `.superpowers/sdd/task-5-brief.md:49-76` assign coherent settlement preview, fresh Account/Session/controller authorization, blocker and asset rechecks, idempotency, and the single Serializable finish transaction to Task 5.
- Task 4 therefore changes only dormant/mismatched Player settlement eligibility. It does not redesign `previewSettlement`/`finishRoom` orchestration.

### Review-fix RED evidence

1. Retained Players, full-capacity replacement, durable conflicts, role-swap replay, and seats state:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
   ```

   Result before production fixes: 8 failed / 30 passed. The expected failures covered full-capacity replacement allocation, retained PLAYING reselection, zero-grant PLAYING creation, current-target durable conflict, character drift terminalization, missing-key ordering, `P2002` without a persisted winner, and missing seats role-swap state.

2. Playable roster filtering and turn rotation:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
   ```

   Result before production fixes: 4 failed / 87 passed. The expected failures covered dormant snapshot exposure, dormant start counts, an empty force-next roster, and replacement allocation drift.

3. Forward partial-index migration:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run packages/database/src/migration-v21.integration.test.ts --reporter=dot
   ```

   Result: 1/1 failed while `202607270008_playable_player_allocations` was absent.

4. Clean build contract:

   ```bash
   npx vitest run packages/database/src/production-delivery.test.ts --reporter=dot
   ```

   Result: the clean-output contract failed while the API build was only `tsc -b`. A first `rm -rf dist && tsc -b` experiment exited 0 but emitted no `dist/server.js` because `tsconfig.tsbuildinfo` survived; the RED assertion was tightened to require `server.js`, and the build gained `--force`.

5. Independent-review follow-up RED for the four in-scope findings:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts -t 'ACTIVE target Turn disagrees|does not reveal whether|keeps actionable role swaps|disables role-swap actions' --reporter=dot
   ```

   Result: 4 failed / 40 skipped. An ACTIVE target Turn with a drifted room pointer approved incorrectly; a foreign request leaked `ROOM_MEMBERSHIP_REQUIRED`; 101 newer terminal rows hid an actionable request; and stale-controller action flags remained true.

   ```bash
   npx vitest run packages/database/src/database-contract.test.ts -t 'scopes Player pawn and turn uniqueness' --reporter=dot
   ```

   Result: 1 failed / 11 skipped because inactive-membership Player normalization was absent.

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run packages/database/src/migration-v21.integration.test.ts --reporter=dot
   ```

   Result: 1/1 failed because the migrated LEFT membership's Player remained ACTIVE and reserved its pawn/turn allocation.

6. Migration-history correction RED:

   The normalization was moved out of immutable migration `008`. With tests pointed at the required new forward migration, the database contract failed 1/1 because `009` read as empty, and the populated migration fixture failed 1/1 because `202607270009_inactive_player_allocations/migration.sql` did not exist. Only then was `009` added.

### Production changes

- `AccountRoomService` allocates only among playable Players and reuses a replacement target's vacated active allocation without moving either member's assets.
- Retained Players can reselect in PLAYING even when new midgame admission is disabled. Genuinely new PLAYING Players start at zero and receive no initial ledger or palace.
- Role-swap lookup, room lock, current Session/controller/capability authorization, replay, and mutation share the controlled Serializable flow. Session validation precedes lookup, and request-to-room lookup is actor-scoped so missing and foreign-room request IDs are indistinguishable.
- `P2002` recovery reauthorizes under the room lock and replays only an exact Account/scope/key/payload winner; otherwise it returns `TRANSACTION_CONFLICT`.
- Character drift and current-target conflicts persist one terminal `CONFLICTED` request, `resolvedAt`, and one `ROLE_SWAP_CONFLICTED` audit. Current-target detection checks both `Room.currentTurnPlayerId` and the authoritative ACTIVE `Turn` row.
- `seats()` fetches all actionable actor-relevant swap requests separately from the capped terminal history. Action flags require the current `activeSessionId` and a nonterminal room.
- `PrismaGameService` uses one playable-Player predicate for snapshot, start, end-turn, force-next, and next-turn revalidation. Empty rosters are rejected explicitly and start uses `room.playerLimit`.
- Settlement eligibility defensively excludes dormant and mismatched Players. Settlement orchestration remains unchanged for Task 5.
- The API build is `rm -rf dist && tsc -b --force`, so deleted production modules cannot survive incremental build metadata.

### Migration behavior

- `202607270008_playable_player_allocations` is unchanged after its introduction: it only drops the global pawn/turn unique indexes and creates partial unique indexes for ACTIVE Players with non-null character bindings.
- New forward migration `202607270009_inactive_player_allocations` marks Players attached to non-ACTIVE memberships `LEFT`. This releases their pawn/turn allocations without deleting or moving Player rows, balances, properties/buildings, skip state, partner cards, ledger, requests, transactions, or audit history.
- ACTIVE characterless replacement Players remain ACTIVE and retain all assets. They are excluded from partial indexes and every playable-roster query until rebound.
- No prior migration was rewritten. No immutable history or settlement trigger was disabled, dropped, weakened, or bypassed.

### Changed files in the review-fix pass

- `apps/api/package.json`
- `apps/api/src/account-room-service.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/prisma-game-service.ts`
- `apps/api/src/prisma-game-service.integration.test.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/202607270008_playable_player_allocations/migration.sql`
- `packages/database/prisma/migrations/202607270009_inactive_player_allocations/migration.sql`
- `packages/database/src/database-contract.test.ts`
- `packages/database/src/migration-v21.integration.test.ts`
- `packages/database/src/production-delivery.test.ts`
- `.superpowers/sdd/task-4-report.md`

No `apps/web` file was changed.

### Final GREEN verification

1. Prisma generation:

   ```bash
   npm run db:generate
   ```

   Result: exit 0; Prisma Client 6.19.0 generated from the current schema.

2. Populated migration chain through `009`:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run packages/database/src/migration-v21.integration.test.ts --reporter=dot
   ```

   Result: 1/1 passed, 4.13s.

3. Full AccountRoom PostgreSQL suite:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/account-room-service.integration.test.ts --reporter=dot
   ```

   Result: 44/44 passed, 17.65s.

4. Full PrismaGame PostgreSQL suite:

   ```bash
   TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npx vitest run apps/api/src/prisma-game-service.integration.test.ts --reporter=dot
   ```

   Result: 91/91 passed, 34.81s.

5. API-local discovery without a database URL:

   ```bash
   npx vitest run apps/api/src --reporter=dot
   ```

   Result: 7 files passed / 1 skipped; 39 passed / 131 skipped.

6. Database, delivery, game-boundary, and route contracts:

   ```bash
   npx vitest run packages/database/src/database-contract.test.ts packages/database/src/production-delivery.test.ts apps/api/src/prisma-game-service.contract.test.ts apps/api/src/server-room-routes.test.ts --reporter=dot
   ```

   Result: 4 files passed; 24/24 tests passed.

7. Focused lint:

   ```bash
   npx eslint apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/prisma-game-service.contract.test.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/server.ts apps/api/src/server-room-routes.test.ts packages/database/src/database-contract.test.ts packages/database/src/migration-v21.integration.test.ts packages/database/src/production-delivery.test.ts --max-warnings=0
   ```

   Result: exit 0, no warnings or errors.

8. Clean API build and deployable artifact assertions:

   ```bash
   npm run build -w @zhenhuan/api
   test -f apps/api/dist/server.js
   test ! -e apps/api/dist/game-service.js
   test ! -e apps/api/dist/game-service.d.ts
   ```

   Result: all four commands exited 0. `dist/server.js` exists; both legacy artifacts are absent.

### Ten-item self-review

1. Full-capacity LOBBY replacement leaves exactly five playable Players; target identity/assets/controller/bank state remain attached, and requester receives the vacated allocation.
2. Electronic start and all turn paths count/rotate only playable Players; dormant Players cannot become current or next.
3. PLAYING replacement of a target identified by either current-turn representation becomes one durable, replayable `CONFLICTED` request without seat or asset mutation.
4. Retained PLAYING reselection reuses the exact Player/assets with no grant; new admission still honors `allowMidgameJoin`, and an allowed new Player starts at zero without ledger/palace.
5. Membership/Player character drift terminalizes once with an allowlisted DTO and no partial membership, Player, property, ledger, or request execution mutation.
6. Stale controller, revoked Session, terminal room, cross-Account key reuse, changed payload, concurrent request/decision, and no-winner `P2002` behavior are covered. Prisma uniqueness errors do not escape publicly.
7. Missing keys fail before lookup. Session validation and actor-scoped request resolution prevent foreign request probing; lock, authorization, replay, and decision remain one controlled Serializable flow.
8. `seats()` exposes only allowlisted actor-relevant swap state, never hides actionable rows behind terminal history, and derives flags from current control plus room lifecycle.
9. Game snapshots and settlement eligibility exclude dormant/mismatched Players and cannot expose them as current/actionable.
10. A real clean API build produces `server.js` and leaves no `game-service.js` or `game-service.d.ts`.

### Hard Task 5 carry

The independent review correctly identified that current settlement preview/finish authorization and snapshot creation are not yet one atomic operation. This is not implemented in Task 4 because `.superpowers/sdd/task-4-brief.md:15` explicitly excludes settlement, while `IMPLEMENTATION_PLAN_V2.md:107-124` and `.superpowers/sdd/task-5-brief.md:49-76` require Task 5 to add fresh Account/Session/controller authorization, coherent preview, in-transaction blocker/asset rechecks, Account-scoped idempotency, and one room-locking Serializable finish transaction. Task 5 must treat this as a hard preflight item before approval.

### Fresh independent re-review

- Critical in-scope issues: none.
- Important in-scope issues: none.
- Minor in-scope issues: none.
- Spec-compliance verdict: **PASS**.
- Code-quality verdict: **PASS**.
- Ready to close Task 4: **YES**.
- The reviewer explicitly classified settlement atomicity as the Task 5 carry owned by `.superpowers/sdd/task-5-brief.md:49-76`, because `.superpowers/sdd/task-4-brief.md:15` excludes settlement implementation. The reviewer separately confirmed that Task 4's dormant/character-mismatch eligibility change is present and covered.
