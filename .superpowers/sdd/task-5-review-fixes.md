# Task 5 final-review fix brief

## Authority and scope

Read these first:

- `.superpowers/sdd/task-5-brief.md`
- `.superpowers/sdd/task-5-report.md`
- `/Users/harry/.codex/attachments/95e233ec-47e3-46c8-b8ce-0f31bad63941/goal-objective.md`
- `/Users/harry/Documents/甄嬛传大富翁/甄嬛传大富翁_新版账号房间开发文档.md`, especially sections 7-13 and 16

Fix every item below in one coherent RED-first pass. Do not broaden into Task 6 admin business behavior or Task 7 UI. Preserve the forward-only migration chain and all existing ledger, history, audit, settlement, and idempotency guarantees.

## Corrected-role findings

The retained-Player model changed an old assumption: a `Player` row in the room is not necessarily a current gameplay participant. The one binding predicate is an ACTIVE Player whose ACTIVE same-room membership has a non-null `characterId` matching `Player.characterId`.

1. `PrismaGameService` currently accepts raw same-room Player rows as gameplay targets. A post-replacement characterless retained Player can receive a transfer, collect toll through retained property, receive bank balance/property/skip/fine mutations, or otherwise participate through target lookups. Centralize/reuse the playable predicate for every current-participant source or target path, including transfer, trade buyer/confirmation where applicable, toll owner, balance adjustment, property owner assignment, add/consume skip turns, and plot fine. Actor authorization already proves the acting Player; do not add redundant behavior or delete retained assets. Reject non-playable targets with a stable existing public error and guarantee zero business/idempotency mutation.

2. Settlement `INVALID_PLAYER_BALANCE` currently scans every room Player. Restrict it to the same ACTIVE matching character-bound participant predicate. A retained characterless Player, including one with a negative balance and owned assets, must neither block nor appear in settlement; forced/normal finish must leave that retained Player and assets unchanged.

Add real PostgreSQL regression coverage that creates the state through the public replacement flow. Prove target gameplay mutations/toll cannot affect the retained Player, settlement preview/finish excludes it without `SETTLEMENT_DATA_INVALID` or `INVALID_PLAYER_BALANCE`, and retained balances/properties/history remain byte-equivalent where relevant. Also keep a matching active dual-capability Player usable and included exactly once.

## Task 5 reviewer findings

1. Finish clears `currentTurnPlayerId` but leaves `Room.turnNumber`. Clear every current-turn field, including `turnNumber`, for normal and forced finish. Use the one captured `endedAt` explicitly as `createdAt` for both terminal AuditLog and SecurityLog rows. Add assertions for exact timestamp equality.

2. For normal finish, when there is no valid participant, return stable `SETTLEMENT_DATA_INVALID` before generic `SETTLEMENT_BLOCKED`, including the all-invalid-binding case. Preserve blocker DTOs for forced overrides.

3. `settlementDto` must not cast stored JSON into public output. Validate and explicitly project allowlisted `winnersJson`, `rankingJson`, `overriddenBlockersJson`, and every `propertyDetailsJson` item. Malformed or extra-field legacy JSON must not leak fields; malformed required shapes return `SETTLEMENT_INCONSISTENT`. Add focused tests for projection and corruption.

4. Replace source-regex-only route evidence with behavioral Fastify injection tests. Export an application builder without listening on import, inject Cookie-authenticated member/admin preview/finish/read requests, assert actual `Idempotency-Key` forwarding, public status/error mapping, safe DTOs, and create-only notifier emission on creating commit versus replay/failure. Keep startup behavior for the production entry point. This refactor is infrastructure only; do not implement Task 6 admin account/room behavior.

5. Strengthen unique-settlement recovery evidence so the tested `P2002` originates from a real Prisma/PostgreSQL unique violation, not a manually constructed error. Use a controlled hook/race that exercises the production recovery boundary and proves exact-winner replay after fresh authorization; prove non-exact recovery returns `TRANSACTION_CONFLICT`. If the room lock makes a natural two-finisher P2002 impossible, retain the correct lock and use the narrowest controlled real-constraint hook rather than weakening concurrency.

6. Add settlement acceptance coverage for a post-replacement retained characterless Player and assets, overlapping the corrected-role regression above.

7. Correct the route inventory in `.superpowers/sdd/task-5-report.md`: the implementation/product route is `/finish`, not `/settlement/finish`.

## TDD and verification contract

- Write focused tests first and run them RED before changing production code. Record the exact failing commands/output and expected reason in `.superpowers/sdd/task-5-report.md`.
- Cover changes in `apps/api/src/prisma-game-service.integration.test.ts`, `apps/api/src/account-room-service.integration.test.ts`, settlement/route/error unit or integration tests, and database migration/immutability tests if the migration changes.
- Run focused GREEN tests, then the full AccountRoom PostgreSQL suite, full PrismaGame PostgreSQL suite, complete API directory with PostgreSQL enabled, database/delivery contracts, Prisma generation if needed, focused ESLint, and a clean API build/artifact check.
- Append changed files, exact commands/counts, self-review, and any concern to `.superpowers/sdd/task-5-report.md`.
- Return `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. Do not claim DONE while any Important finding remains.
