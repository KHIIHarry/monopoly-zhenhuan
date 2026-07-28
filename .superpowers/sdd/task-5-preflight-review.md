# Task 5 settlement preflight review

Date: 2026-07-27

## Verdict

**Not implementation-ready.** The brief has the right overall direction, and the V2.1 additive wealth formula is unambiguous, but several P0 contracts are still underspecified or conflict with the current lifecycle and migration state. Implementing the current text would allow materially different authorization, forced-close, idempotency, and immutability behaviors to all claim compliance.

No PostgreSQL suite was run for this review, as requested. This is a read-only architecture/spec audit of the product authority, Task 5 brief/preflight, Task 5 in `IMPLEMENTATION_PLAN_V2.md`, current schema/migrations, settlement/service/routes, and related tests.

## Confirmed foundations

- V2.1 is authoritative: `totalWealth = cash + unmortgagedPropertyValue + mortgagedPropertyNetValue + buildingSellValue`. The stale subtraction text must not be implemented.
- `rankSettlementPlayers` already adds the four components and implements the three product tie-break keys, with exact remaining ties sharing a rank.
- `GameSettlement.roomId` and `SettlementPlayer(settlementId, accountId)` are unique.
- Migration `202607260006_account_room_v2` has UPDATE, DELETE, and TRUNCATE rejection triggers for both settlement tables.
- `PrismaGameService` game mutations and `AccountRoomService` role-swap mutations already converge on a Room row lock plus fresh Session/controller/capability authorization. Task 5 should reuse this lock ordering.
- The `AccountRoomService` PostgreSQL harness already creates a randomized schema, applies all migrations, seeds the real 5 characters and 26 properties, and drops only that schema.

## P0 amendments required before implementation

### P0.1 Define one authoritative finish state machine and retire the legacy bypass

Current conflicts:

- The product says ending a game creates an immutable settlement and changes the Room to `FINISHED`.
- `PrismaGameService.end()` still moves `PLAYING -> ENDED` without a settlement, and its integration tests preserve that path. It is not currently routed, but it remains a public service operation.
- Migration `202607270007_dual_role_capabilities` moves every legacy `LOBBY`, `PLAYING`, and `ENDED` Room to `FINISHED` without creating `GameSettlement`. Consequently, `previewSettlement()` reports `alreadyFinished`, while `getSettlement()` returns `SETTLEMENT_NOT_FOUND`.
- Current `finishRoom()` rejects only `FINISHED`; it can attempt to finish `LOBBY`, `ENDED`, or `CLOSED` Rooms.

Amend the brief with an explicit matrix:

| Source status | Normal bank finish | Super-admin forced finish | Existing settlement |
| --- | --- | --- | --- |
| `LOBBY` | reject | explicitly allow or reject | must be absent |
| `PLAYING` | allow, subject to blockers | allow | must be absent |
| `ENDED` | explicitly allow finalization or reject as legacy terminal | explicitly define | must be absent |
| `FINISHED` | replay only for the same authorized Account/key/payload; otherwise terminal error | same rule | must exist for native V2.1 games |
| `CLOSED` | reject | reject unless product explicitly says otherwise | no new settlement |

Also require one of these migration policies before Task 5 GREEN:

1. Add a forward migration that moves legacy `FINISHED` Rooms lacking `GameSettlement` to an explicitly non-settled legacy status and expose a stable `LEGACY_SETTLEMENT_UNAVAILABLE` read result; or
2. Backfill valid immutable settlements and document how candidates and values are reconstructed.

Do not fabricate an empty ranking for legacy games. Remove/private/deprecate `PrismaGameService.end()` or make every reachable end-game path delegate to the settlement transaction. `ENDED` may remain as a legacy terminal state, but no new product flow may reach it without the specified finalization policy.

### P0.2 Specify the finish transaction algorithm, including authorization-before-replay

The current implementation computes preview candidates outside the transaction, then persists those stale values. It does not lock the Room, re-read blockers/assets, or revalidate Account/Session/controller in the finish transaction.

Require this exact order in one retried Serializable transaction:

1. `SELECT Room ... FOR UPDATE` using the same lock order as every game/swap mutation.
2. Re-read Account and AccountSession; require ACTIVE account, unrevoked/unexpired Session, and Account/Session identity match.
3. For normal finish, re-read ACTIVE membership, require matching `activeSessionId`, `isBank=true`, and the allowed source lifecycle state. For forced finish, re-read `Account.isSuperAdmin=true`; no membership/controller is required.
4. Only after authorization, read the Account-scoped idempotency record and verify a canonical hash containing `roomId`, mode (`NORMAL`/`FORCED`), exact confirmation or normalized reason, and any future override input.
5. Handle existing settlement/lifecycle according to P0.1. A same-key replay returns the stored allowlisted DTO; a changed payload returns `IDEMPOTENCY_KEY_REUSED`; a different key on an already finished Room does not create or silently claim a second finish.
6. Re-read all blocker and asset inputs in the transaction. Never pass preview candidates into persistence.
7. Normal finish rejects blockers with zero mutations. Forced finish applies only the explicit resolution matrix in P0.3.
8. Recompute details/ranking, persist parent and child snapshots, terminalize the Room and active turn, write audit/security records, and persist the idempotency response atomically.

Add a bounded retry/recovery rule for serialization failure and unique `GameSettlement.roomId` conflicts. Recovery must re-authorize before replaying. A revoked Session or stale controller must never replay a prior response.

### P0.3 Define exact blocker predicates and a forced-resolution matrix

The brief names blocker families but does not define their database predicates or what forced finish may mutate. Current forced finish only cancels PENDING `GameRequest` rows and ends ACTIVE turns; it leaves role swaps, property locks, debts, and unresolved landings inconsistent.

Add stable blocker codes and exact predicates. At minimum:

- `PENDING_GAME_REQUEST`: `GameRequest.status = PENDING`, with request id/type.
- `INCOMPLETE_PROPERTY_TRADE`: a pending `TRADE_PROPERTY`, including buyer-confirmation state from its payload.
- `PROPERTY_ACTION_LOCKED`: `RoomProperty.lockedByRequestId IS NOT NULL`, with property and request ids.
- `PENDING_ROLE_SWAP`: status in `PENDING_TARGET`, `PENDING_BANK`.
- `INVALID_PLAYER_BALANCE`: define invalid precisely; at least `Player.balance < 0`. Do not leave “otherwise invalid” open-ended.
- `OPEN_DEBT`: status in `OPEN`, `PARTIALLY_PAID` with positive outstanding amount.
- `UNRESOLVED_LANDING`: define `DECLARED`, and define which `CONFIRMED` combinations of `plotResolved` and `propertyActionsCancelled` are unresolved.
- `ACTIVE_TURN`: `Turn.status = ACTIVE`, with turn/player ids.
- `SETTLEMENT_DATA_INVALID`: character membership without a same-room Player, or mismatched `membership.characterId`/`player.characterId`; do not silently omit that participant.

Blocker DTOs must be a discriminated allowlist, not raw Prisma rows or arbitrary payload JSON.

Add an explicit forced-resolution table. A defensible default is:

- PENDING GameRequests -> `CANCELLED`, `resolvedAt=endedAt`, stable forced-finish reason; release every matching `RoomProperty.lockedByRequestId`.
- PENDING role swaps -> `CANCELLED`, `resolvedAt=endedAt`, stable forced-finish reason; do not alter characters/assets.
- ACTIVE turn -> `ENDED`, `endedAt=endedAt`; clear `Room.currentTurnPlayerId`.
- DECLARED/unresolved landing -> `INVALIDATED`, `invalidatedAt=endedAt`; cancel only its pending requests and release locks.
- Open/partially paid debt and invalid balance -> do not rewrite ledger, balance, ownership, or debt history merely to make the Room terminal. Record the override in the settlement and audit unless product authority explicitly approves `WRITTEN_OFF` semantics.

Whatever matrix is chosen must be normative and tested row-for-row. “May close pending operational state” is not sufficient.

### P0.4 Store forced overrides in the immutable settlement

The brief requires forced finish to record overridden blockers in immutable/audit output, but the current `GameSettlement` schema has no field for them. `SecurityLog.detailsJson` is not the immutable settlement snapshot and has no append-only database guard.

Add a migration/schema field such as `overriddenBlockersJson Json` (empty array for normal finish), populate it from the in-transaction blocker snapshot, expose it through an allowlisted DTO, and duplicate the summary in the finish audit record. Preserve `forceReason` as a separate nonblank snapshot field.

### P0.5 Close the settlement INSERT immutability hole

The existing triggers reject UPDATE, DELETE, and TRUNCATE, but they do not reject a later INSERT into `SettlementPlayer`. A new account row can therefore be appended after finalization, changing the historical participant set while the parent ranking JSON remains unchanged.

Strengthen the database contract so child rows can be inserted only during settlement creation and never after the Room becomes terminal. One minimal design is a `SettlementPlayer` INSERT trigger that resolves the parent Room and rejects when the Room is already `FINISHED`/`CLOSED`; the finish transaction inserts children before its final Room status update. Also prohibit reopening or changing the terminal status of a Room that has a settlement.

PostgreSQL acceptance must attempt post-commit INSERT as well as UPDATE, DELETE, and TRUNCATE. Verify both settlement tables and prove every stored row remains byte-for-byte unchanged after each rejected operation.

### P0.6 Define valuation inputs and the immutable property detail schema

Current `previewSettlement()` incorrectly uses `purchasePrice` for land value and stores too few inputs to audit the calculation.

Require this per-property DTO shape (names may vary, semantics may not):

- safe room-property identifier and property name snapshot;
- `mortgaged`;
- `mortgagePriceSnapshot`;
- `landSaleValue = mortgagePriceSnapshot * 2`;
- `landSettlementValue = mortgaged ? landSaleValue - mortgagePriceSnapshot : landSaleValue`;
- `buildingLevel`/building count;
- `buildingSellPriceSnapshot`;
- `buildingSellValue = buildingLevel * buildingSellPriceSnapshot`.

`purchasePrice` must never feed settlement valuation. Add a fixture where `purchasePrice != mortgagePrice * 2`. Use `RoomMembership.displayNameSnapshot` as the participant name source and `Character.name` as the character snapshot source, unless product explicitly chooses current `Account.displayName`; the current brief's “Account.displayName/membership display name” wording must pick exactly one.

## P1 contract amendments

### P1.1 Make ranking semantics deterministic and explicit

- Specify competition ranking after ties (`1, 1, 3`), or explicitly choose dense ranking (`1, 1, 2`). Current code implements competition ranking.
- `accountId` may be used only as a deterministic output ordering key after a complete product tie; it must not break the shared rank or winner state.
- Define `winnersJson` and `rankingJson` schemas and ordering. Recommended: winner account ids in deterministic ranking order, and ranking entries containing settlement-player id/account id/rank only; the detailed immutable values remain in `SettlementPlayer`.
- Define the zero-candidate case. A Room with no valid character players should normally be blocked rather than produce a winnerless settlement.

### P1.2 Define time/count snapshots

- Capture one `endedAt` value and reuse it for settlement, duration, resolved/cancelled records, turn closure, and audit.
- Define `totalTurns` as either count, maximum turn number, or completed turns; current code counts every Turn including invalidated/auto-ended rows.
- Define duration origin. The current schema only supports `Room.createdAt -> endedAt`; if product means actual play duration, add/persist `startedAt` rather than guessing.

### P1.3 Require audit records with stable actors and immutable evidence

Current finish writes only `SecurityLog`. Require:

- normal finish `AuditLog` with bank membership actor and `actorRole=BANK`;
- forced finish `AuditLog` with `actorRole=ADMIN`, force reason, and overridden blocker summary;
- `SecurityLog` for the Account-level security/admin action as required by the product;
- no update/delete/rewrite of prior ledger, transaction, ownership, debt, or audit rows.

### P1.4 Separate member and admin settlement reads and return DTOs only

Current `getSettlement()` returns raw Prisma records and allows a super-admin through the member route.

- `GET /api/rooms/:id/settlement`: require a freshly authenticated Account with a RoomMembership (ACTIVE or historical LEFT must be explicitly chosen); bank-only and dual members are allowed.
- `GET /api/admin/rooms/:id/settlement`: explicitly authorize current super-admin status and permit nonmember reads.
- Return a shared allowlisted DTO. Do not expose raw relations, Session/controller ids, password material, arbitrary audit payloads, or unreviewed internal fields.
- Define read behavior for native FINISHED-without-settlement corruption separately from the legacy policy in P0.1.

### P1.5 Define event behavior on replay/recovery

Routes currently emit `room.finished` and `settlement.created` after every returned result, including an eventual idempotent replay. Decide and test one rule:

- preferred: the service returns `created/replayed`, and the route emits both invalidation events only for the creating commit; or
- explicitly permit duplicate invalidation events and assert payloads contain only `roomId`/`settlementId`.

In either case, no event may be emitted on blocker, authorization, serialization, or persistence failure. WebSocket payloads must remain safe invalidation identifiers, and REST remains authoritative.

### P1.6 Define public errors/statuses

Add stable mappings for at least `FINISH_CONFIRMATION_REQUIRED`, `SETTLEMENT_BLOCKED`, `IDEMPOTENCY_KEY_REUSED`, `ROOM_FINISHED`, `ROOM_CONTROL_LOST`, `BANK_REQUIRED`, `ADMIN_REQUIRED`, `SESSION_INVALID`, `SETTLEMENT_NOT_FOUND`, and the legacy result. Authenticated lack of capability/nonmembership/admin permission should be 403 rather than being conflated with invalid authentication; controller conflict and idempotency/blocker conflicts should be 409.

## Required test amendments

### Pure settlement tests

1. Additive four-component total, including zero and large integer values.
2. Unmortgaged and mortgaged formulas with `purchasePrice != mortgagePrice * 2`.
3. Building level/count and building sell-price snapshot.
4. Total wealth, then cash, then unmortgaged land tie-breaks.
5. Exact joint winners and the chosen post-tie rank sequence.
6. Deterministic order without converting an exact tie into a loss.
7. Exact allowlisted property detail DTO shape.

### PostgreSQL AccountRoomService tests

1. Preview is coherent and mutation-free; validates ACTIVE Account/Session, ACTIVE membership, controller, and BANK capability.
2. One focused fixture per blocker predicate, with stable safe details and no state mutation after normal rejection.
3. Formula/components/details, bank-only exclusion, dual-member single inclusion, and invalid membership/Player mismatch handling.
4. Normal success writes one parent, exactly one row per eligible participant, one audit/security trail, and `FINISHED` atomically.
5. Forced finish rejects blank reason and ordinary users; captures all blockers, applies the chosen resolution matrix, releases locks, and preserves ledger/transaction/ownership history.
6. Stale controller, revoked/expired Session, disabled Account, wrong capability, nonmember, and privilege revoked between request authentication and transaction authorization.
7. Same Account/key/payload replay, changed payload conflict, cross-Account key isolation, different key after finish, and unique-settlement conflict recovery.
8. Two-client finish/game-write and finish/role-swap races. Assert one serial order: either the write commits before snapshot and is reflected, or finish commits first and the write returns terminal error; never permit a committed post-snapshot mutation.
9. Concurrent asset mutation versus preview/finish proves finish re-reads assets and never persists preview values.
10. Master Data name/value edits after finish do not change the returned settlement DTO.
11. Real PostgreSQL rejection of UPDATE, DELETE, TRUNCATE, and post-finalization INSERT, with unchanged rows afterward.
12. Every P0.1 lifecycle cell, including legacy `FINISHED` without settlement.

### Terminal-write coverage

Cover representative methods from every game mutation family for each of `ENDED`, `FINISHED`, and `CLOSED`: start/lifecycle, landing declaration/confirmation/cancellation, request/property lock, direct transfer, roll/end-turn, trade confirmation, bank approve/reject, balance/property adjustments, skip-turn controls, roll invalidation/force-next, plot/companion/cold-palace events, and reversal. Cover all five role-swap actions: request, accept, reject, bank approve, cancel. Assert no ledger, transaction, property, player, request, swap, audit, or idempotency mutation occurs.

### Route/contract tests

1. Both finish routes forward the actual `Idempotency-Key` and mode-specific canonical payload to the service; current routes only validate the header and discard it.
2. Exact normal confirmation and nonblank forced reason schemas.
3. Member settlement read versus dedicated admin read authorization.
4. Safe preview/final DTOs and safe blocker/event payloads.
5. No finish events on failure; chosen replay event behavior.
6. Public error status/body mappings without internal Prisma/Zod leakage.

## Implementation-ready gate

Task 5 becomes implementation-ready only after all P0 items are incorporated into the brief/preflight (especially lifecycle/legacy policy and the forced-resolution matrix), the immutable override field/INSERT guard design is chosen, and ranking/time/read/event semantics are fixed. The existing randomized PostgreSQL harness is sufficient infrastructure once these contracts are explicit.

## Amended brief re-audit

The amended brief resolves the original lifecycle/legacy migration, transaction ordering, authorization-before-replay, forced override snapshot, settlement INSERT guard, valuation/property detail, competition rank, time/count, audit, member/admin read, event, and PostgreSQL coverage findings. It is **not yet implementation-ready** because one reachability contradiction and three smaller contract gaps remain:

1. **P0 - Normal electronic-dice finish is unreachable.** The brief defines every `Turn.status=ACTIVE` as `ACTIVE_TURN`, normal finish rejects every blocker, `endTurn()` always creates the next ACTIVE turn, and the legacy no-successor `end()` path must be removed. Therefore a normal `PLAYING` electronic Room can never become blocker-free. Define a reachable boundary, for example: a pristine not-yet-started ACTIVE turn (no dice/roll, landing, or pending request) is not an unfinished-turn blocker and normal finish ends it without creating a successor; all other ACTIVE turns remain blockers. Add an end-to-end PostgreSQL test proving normal electronic finish can succeed through the public workflow.
2. **P0 - Forced property-lock cleanup contradicts its terminal postcondition.** The matrix clears only locks belonging to requests changed from PENDING to CANCELLED, while `PROPERTY_ACTION_LOCKED` covers every non-null lock and the postcondition requires no lock to remain. State whether a lock owned by a non-PENDING/orphaned request is `SETTLEMENT_DATA_INVALID` and retained, or, preferably for forced closure, clear every non-null `lockedByRequestId` after snapshotting it and increment each property version without changing ownership/mortgage/buildings. Test both ordinary pending and stale/non-PENDING lock fixtures.
3. **P1 - Pending trades currently produce two blocker codes ambiguously.** A pending `TRADE_PROPERTY` matches both `PENDING_GAME_REQUEST` and `INCOMPLETE_PROPERTY_TRADE`. Specify whether both entries are intentionally emitted or the trade-specific code replaces the generic code. This must be deterministic because the list is persisted in `overriddenBlockersJson` and idempotent responses.
4. **P1 - Complete preview/error lifecycle semantics.** Specify normal preview results for `LOBBY`, legacy `ENDED`, `FINISHED` with/without settlement, and `CLOSED`, and state whether forced admin preview has a route or is finish-internal only. Assign explicit HTTP statuses to `LEGACY_SETTLEMENT_UNAVAILABLE` and `SETTLEMENT_INCONSISTENT` rather than leaving them outside the otherwise binding error map.

After these four amendments, the brief is sufficiently unambiguous to implement with the listed TDD/PostgreSQL gates.

## Final amended-brief readiness verdict

**Implementation-ready.** The final brief resolves all remaining blockers from the amended-brief re-audit: normal electronic-dice finish has a reachable pristine-turn boundary, pending property trades replace rather than duplicate the generic request blocker, forced finish clears every snapshotted property lock, and normal/admin preview plus legacy/corruption HTTP behavior are binding. The P0/P1 lifecycle, migration, authorization/idempotency, forced-resolution, immutability, valuation/ranking, time/count, read, audit, event, and PostgreSQL acceptance contracts are now internally consistent and sufficiently testable. No true implementation blocker remains; this verdict supersedes the two earlier not-ready verdicts above.
