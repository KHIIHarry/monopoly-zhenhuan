# Task 4 fix brief: retained Players, durable swap conflicts, and authoritative swap state

Read first:

- `.superpowers/sdd/task-4-brief.md`
- `.superpowers/sdd/task-4-report.md`
- `/Users/harry/Documents/甄嬛传大富翁/甄嬛传大富翁_新版账号房间开发文档.md`, especially sections 4 and 7-12

The V2.1 development document is the sole product authority. It defines one active
`RoomMembership` per Account/room, nullable `characterId`, independent `isBank`, one
shared `activeSessionId`, and at most one durable `Player`/asset set per membership.
Only character-bound members participate as players. A replacement target retains
their Player and assets while characterless and can later select a free character.

## Root cause and binding reconciliation

`Player` currently combines durable financial identity with an always-active pawn/turn
seat. Global pawn/turn uniqueness and roster queries over every `ACTIVE` Player make a
retained characterless Player both unschedulable and impossible to coexist with a new
fifth active Player.

Treat character binding as active-seat membership:

- A playable Player is `Player.status = ACTIVE`, has non-null `Player.characterId`, has
  an ACTIVE membership in the same room, and that membership has the same non-null
  `characterId`.
- Retained characterless Players remain durable asset rows but are not in snapshots,
  start counts, turn rotation, current/next turn selection, or settlement ranking.
- Pawn-color and turn-order uniqueness applies only to playable, character-bound
  Players. Add a new forward migration after `202607270007_dual_role_capabilities` that
  replaces the two global Player unique indexes with PostgreSQL partial unique indexes
  for non-null active character bindings. Do not rewrite an existing migration.
- Remove the corresponding global `@@unique` declarations from Prisma schema. Keep the
  database partial indexes and add migration/contract coverage for them.
- For a replacement requester with no Player, clear the target character bindings first
  and create the requester's Player using the target's just-vacated pawn color and turn
  order. The dormant target retains its stored values and all financial/game assets.
- On later retained-Player re-selection, reuse the same Player/assets. Reuse its stored
  pawn/turn allocation if it is free among playable Players; otherwise assign the free
  active pawn/turn allocation inside the locked transaction. This is seat allocation,
  not an asset swap. Never create a second Player or reissue grants.
- Mutual swaps keep both existing Players and their pawn/turn allocations unchanged.

## Required RED tests before production changes

Add focused PostgreSQL tests and run them to demonstrate expected failures. Record the
commands, failing assertions, and why each failure is correct in the Task 4 report.

1. Five occupied characters plus a sixth characterless requester can complete a LOBBY
   replacement. Exactly five Players are playable; the former target's same Player,
   balance, properties/buildings, skip state, ledger, bank capability, and controller
   remain intact; the requester gets one Player and the vacated active allocation.
2. Starting an electronic game after a replacement counts only playable Players, needs
   at least two playable Players, never selects the dormant Player, and subsequent end
   turn/force-next rotation skips it.
3. In PLAYING, replacing the current target must produce a durable `CONFLICTED` request
   with `resolvedAt`, one `ROLE_SWAP_CONFLICTED` audit, no asset/seat mutation, and an
   idempotent terminal replay. Replacing a non-current target succeeds and later turns
   skip the dormant target.
4. A retained Player can select a free character in PLAYING even when
   `allowMidgameJoin=false`; it reuses the exact Player/assets and receives no cash,
   ledger entry, or initial palace. A genuinely new Player is still rejected in that
   room. When `allowMidgameJoin=true`, a genuinely new PLAYING Player starts at zero and
   receives neither initial ledger nor palace.
5. A stale target/requester character drift terminalizes the request as `CONFLICTED`,
   with exactly one conflict audit and no partial membership, Player, property, ledger,
   or request mutation. Same-key replay returns the same allowlisted DTO.
6. Role-swap idempotency covers: stale controller replay, revoked Session, terminal
   room, two Accounts using the same key, changed payload using the same key,
   concurrent same-key request, and concurrent same-key decision. A successful winner
   is replayed only for the exact Account/scope/payload; all other uniqueness failures
   become a stable public `TRANSACTION_CONFLICT`, never a raw Prisma error.
7. Missing/empty idempotency keys are rejected before request lookup. Accept/resolve
   authorization and request lookup occur inside the controlled transaction; a caller
   cannot probe a foreign request before membership/controller/capability validation.
8. The seats REST snapshot returns actor-relevant, allowlisted role-swap state for the
   requester, target, and current bank so WebSocket notifications can be followed by an
   authoritative refetch. It must expose no password hash, Account secret, Session ID,
   or unrestricted nested Prisma object.
9. A game snapshot excludes dormant retained Players and cannot expose them as current
   or actionable. Settlement continues to exclude them until re-bound.
10. A clean API build leaves no deployable `dist/game-service.js` or
    `dist/game-service.d.ts` legacy artifact.

## Production fixes

- Centralize the playable-Player predicate and use it consistently in snapshot, start,
  end-turn, force-next, and `createNextActionableTurn` inputs. Defensively reject an
  empty candidate list instead of modulo-by-zero or creating a dangling turn.
- Start requires 2 through `room.playerLimit` playable Players.
- Fix `selectCharacter` admission to treat an existing retained Player as re-selection,
  not new midgame admission. New LOBBY Players get one-time initial grants; new PLAYING
  Players always start at zero with no ledger or palace.
- Before executing a PLAYING replacement, if the target Player owns the active turn,
  terminalize the swap as `CONFLICTED`; do not end or transfer that turn implicitly.
  Mutual swaps remain valid because both Player identities stay playable.
- Replace thrown stale `SWAP_CONFLICT` drift with an in-transaction helper that writes
  `CONFLICTED`, `resolvedAt`, and one `ROLE_SWAP_CONFLICTED` audit, then returns the
  allowlisted terminal DTO so the same idempotency record persists it.
- Validate the key before any request lookup. Refactor accept/reject/cancel/bank approval
  so request resolution, room locking, current Session/controller/capability checks,
  idempotency replay, and the decision all occur in one Serializable control flow.
- Retry only serialization/deadlock conflicts. On `P2002`, re-authorize under the room
  lock and replay the exact persisted idempotency winner if present and hash-compatible;
  otherwise return `TRANSACTION_CONFLICT`. Never leak a Prisma error.
- Add actor-relevant `roleSwapRequests` to `seats`, with explicit allowlisted fields and
  derived action flags suitable for Task 7. Keep WebSocket as notification-only.
- Remove stale legacy dist artifacts and make the API build clean its own output before
  compiling so deleted production modules cannot survive deployment.

## Scope adjudication from the review

The current web client still uses `membership.role` and Bearer headers. That is a real
product defect, but `IMPLEMENTATION_PLAN_V2.md` assigns all web migration to Task 7 and
the original Task 4 brief explicitly excludes frontend work. Do not edit the web app in
this Task 4 fix. Preserve the finding in the progress ledger/Task 7 preflight so it is
implemented and browser-tested before final completion.

## Verification and report contract

Run and record:

- the focused RED cases before production edits;
- database schema/migration contract coverage;
- the full migrated PostgreSQL AccountRoomService suite;
- the full migrated PostgreSQL PrismaGameService suite;
- route/contract/API-local tests;
- focused ESLint;
- Prisma generation and API TypeScript build;
- a clean-build assertion that stale game-service output is absent.

Use the existing randomized-schema fixture and immutable trigger policy. Apply every
migration and drop only the test schema. Do not truncate guarded history, weaken a
trigger, or alter verified master data.

Append a `Task 4 review-fix pass` section to `.superpowers/sdd/task-4-report.md` with RED
evidence, changed files, migration behavior, full command/results, and a self-review
against every item above. Return `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or
`BLOCKED` with only a short summary; the report file is the durable handoff.
