# Task 5: Transactional finish-game flow and immutable settlement

## Product authority

Read `/Users/harry/Documents/甄嬛传大富翁/甄嬛传大富翁_新版账号房间开发文档.md`, especially sections 4, 11-13, 17-18. It is the sole product authority. The corrected goal objective's minus-sign wealth block is stale; V2.1's additive formula governs.

## Scope

- Modify `apps/api/src/settlement.ts` and `settlement.test.ts`.
- Modify `apps/api/src/account-room-service.ts` and its PostgreSQL integration test.
- Modify `apps/api/src/server.ts`, focused route/contract tests, and public error mapping as needed.
- Modify settlement migrations/tests only if required to preserve or strengthen the existing immutable snapshot triggers. Never weaken existing ledger, audit, history, or settlement guards.
- Do not implement the Task 6 admin dashboard/account manager or Task 7 frontend in this task. The super-admin forced-finish service/route is in scope because it shares the settlement transaction.

## Binding lifecycle and migration decisions

These decisions close the ambiguities identified by the independent Task 5 preflight and govern the implementation:

| Current Room state | Normal bank finish | Super-admin forced finish | Settlement read |
| --- | --- | --- | --- |
| `LOBBY` | reject `ROOM_NOT_PLAYING` | allowed with nonblank reason | not available before finish |
| `PLAYING` | allowed when blocker-free | allowed with nonblank reason | not available before finish |
| legacy `ENDED` | reject `LEGACY_SETTLEMENT_UNAVAILABLE` | allowed with nonblank reason | `LEGACY_SETTLEMENT_UNAVAILABLE` until forced finalization |
| `FINISHED` plus settlement | only an already-authorized exact idempotency replay may return the stored result; another key returns `ROOM_FINISHED` | same | return immutable DTO |
| `FINISHED` without settlement | corruption error; no fabricated result | corruption error | `SETTLEMENT_INCONSISTENT` |
| `CLOSED` | reject `ROOM_FINISHED` | reject `ROOM_FINISHED` | return an existing settlement only |

- Add a forward migration after the latest Task 4 migration that reclassifies existing `FINISHED` Rooms without `GameSettlement` to legacy `ENDED`. Update populated-legacy migration coverage. Do not fabricate/backfill an empty ranking.
- Remove the public `PrismaGameService.end()` bypass and its legacy tests/contracts. Every new product end path uses this Task 5 settlement transaction; `ENDED` remains only as a legacy marker.
- Add nullable `Room.startedAt`. `start()` sets it exactly once when claiming `LOBBY -> PLAYING`; migration uses `createdAt` for already-PLAYING legacy rows when needed. `durationSeconds` is `endedAt - (startedAt ?? createdAt)`, clamped at zero.
- Normal finish with no valid character-bound participant is blocked by `SETTLEMENT_DATA_INVALID`. Forced administrative closure may record the blocker and create an empty player/ranking snapshot; it must not invent a winner.

## Ranking and snapshot contract

- Total wealth is `cash + unmortgagedPropertyValue + mortgagedPropertyNetValue + buildingSellValue`.
- For every owned property, land sale value is `mortgagePrice * 2`. An unmortgaged property contributes that full land sale value. A mortgaged property contributes `landSaleValue - mortgagePrice`. Buildings contribute `buildingLevel * buildingSellPrice` according to the persisted property definition snapshot.
- Never use `purchasePrice` as the settlement land value. Add a regression fixture where `purchasePrice` differs from `mortgagePrice * 2`.
- Rank descending by total wealth, then cash, then unmortgaged property value. Exact remaining ties share the same rank and every rank-1 row is a winner; never randomize.
- Create exactly one `SettlementPlayer` for each ACTIVE membership with a non-null `characterId` and its matching Player. Exclude bank-only members. Include a dual-capability member exactly once.
- Snapshot `RoomMembership.displayNameSnapshot`, current `Character.name`, all four value components, total, rank/winner, and per-property details containing the exact definition/value inputs. Later Account/Character/Master Data changes must not affect reads.
- `GameSettlement` records ender Account, end time, total turns, duration, forced flag/reason, winners, and ranking. Return explicit allowlisted preview/settlement DTOs; do not return raw Prisma relations, Session ids, password hashes, or internal secrets.
- Ranking uses competition ranks (`1, 1, 3`), never dense ranks. A full product tie remains a shared rank/win; `accountId` is only a deterministic output-order key and never a tie-break.
- `winnersJson` is a deterministic array of winner Account ids. `rankingJson` is a deterministic array of `{ accountId, rank }`; all financial detail remains in `SettlementPlayer`.
- `totalTurns` is the maximum assigned `Turn.turnNumber`, or zero when no Turn exists. Capture one `endedAt` and reuse it for every snapshot, cancellation, closure, and audit row.
- Each `propertyDetailsJson` item contains an allowlisted room-property id and name snapshot, `mortgaged`, `mortgagePriceSnapshot`, `landSaleValue`, `landSettlementValue`, `buildingLevel`, `buildingSellPriceSnapshot`, and `buildingSellValue`. Never use `purchasePrice` in valuation.

## Preview and blockers

- Normal preview requires a freshly valid ACTIVE Account/Session, ACTIVE membership, current shared `activeSessionId`, and `isBank=true`.
- Preview reads a coherent database snapshot and returns both the blockers and the current computed ranking/details. It does not mutate game state or persist a settlement.
- Detect exact stable blockers: `PENDING_GAME_REQUEST` for a non-trade `GameRequest.status=PENDING`; `INCOMPLETE_PROPERTY_TRADE` instead of the generic code for pending `TRADE_PROPERTY`, including its safe buyer-confirmation state; `PROPERTY_ACTION_LOCKED` for non-null `RoomProperty.lockedByRequestId`; `PENDING_ROLE_SWAP` for `PENDING_TARGET`/`PENDING_BANK`; `INVALID_PLAYER_BALANCE` for `Player.balance < 0`; `OPEN_DEBT` for `OPEN`/`PARTIALLY_PAID` with positive outstanding amount; `UNRESOLVED_LANDING` for `DECLARED` or `CONFIRMED` with `plotResolved=false` and `propertyActionsCancelled=false`; `ACTIVE_TURN` for an ACTIVE Turn that has a roll/dice, any landing, or any pending request; and `SETTLEMENT_DATA_INVALID` for a character membership without the same-room Player/matching character binding.
- Report blockers as stable allowlisted codes with safe resource identifiers/details so the UI can explain what must be resolved.
- Blocker DTOs are a discriminated allowlist. Do not return arbitrary request payloads or raw Prisma rows.
- A pristine ACTIVE electronic turn with no roll/dice, landing, or pending request represents the not-yet-started next turn and is not a blocker. Normal finish may end that pristine turn at `endedAt` without creating a successor. Add an end-to-end public workflow test that ends one turn, receives the pristine next turn, and then completes normal finish.

Forced finish applies this exact row-level resolution matrix at the captured `endedAt`:

- every PENDING `GameRequest` becomes `CANCELLED` with `resolvedAt=endedAt` and stable reason `FORCED_ROOM_FINISH`;
- after snapshotting blockers, every property with non-null `lockedByRequestId` clears that field and increments its version, including stale/orphaned/non-PENDING locks, without changing owner/mortgage/building state;
- every `PENDING_TARGET`/`PENDING_BANK` RoleSwapRequest becomes `CANCELLED`, gets `resolvedAt=endedAt` and rejection reason `FORCED_ROOM_FINISH`, without changing characters or Players;
- every ACTIVE Turn becomes `ENDED` with `endedAt`, and Room current-turn fields clear;
- every unresolved LandingEvent becomes `INVALIDATED` with `invalidatedAt=endedAt` and `propertyActionsCancelled=true`;
- open debt, negative balances, and invalid participant bindings are not rewritten or fabricated. Their blocker snapshots are retained as forced overrides; invalid participants are omitted according to the product's matching Player rule.

Forced finish never rewrites prior ledger entries, committed transactions, ownership, debt history, or audit rows. After forced completion, no pending request/swap, property lock, actionable landing, or active turn may remain.

## Finish transaction

- Normal bank finish requires the exact phrase `确认结束游戏`, current controller, BANK capability, and an Account-scoped `Idempotency-Key`.
- Super-admin forced finish requires a nonblank reason and an Account-scoped `Idempotency-Key`; it does not require room membership/bank capability.
- Inside one Serializable transaction, in this exact order: lock the Room using the shared game/swap lock order; re-read and validate ACTIVE Account plus unrevoked/unexpired matching Session; revalidate bank membership/controller or current super-admin capability; authorize the lifecycle matrix; only then read/verify the Account-scoped idempotency record; handle an existing settlement; re-read all blocker/asset inputs; reject blockers for normal finish or apply the exact forced matrix; recompute ranking/details; insert the settlement and child rows; set Room to `FINISHED`; write audit/security rows; and persist the idempotency response atomically.
- Normal finish rejects any blocker without mutation. Forced finish still collects blockers, requires its reason, records the overridden blocker list in the immutable/audit output, and may close pending operational state so the Room can become terminal. It must never rewrite prior ledger, transaction, audit, or ownership history.
- A concurrent game write and finish must serialize to one defensible ordering. No game/swap mutation may commit after Room becomes terminal.
- A concurrent second finish must replay the same completed result when Account/key/payload match, reject changed payload with `IDEMPOTENCY_KEY_REUSED`, and never create a second settlement.
- Authorization occurs before any idempotency replay, so a revoked Session or controller that lost control cannot replay a prior finish result.
- Canonical finish payload includes `roomId`, mode (`NORMAL`/`FORCED`), exact normal confirmation or normalized force reason, and no Session/token fields. Retry only serialization/deadlock errors. A unique settlement race re-authorizes before replay/recovery; otherwise it returns stable `TRANSACTION_CONFLICT`.
- Normal finish writes a BANK `AuditLog` plus Account-level `SecurityLog`. Forced finish writes an ADMIN `AuditLog` with nullable membership actor plus `SecurityLog`, both including the reason and allowlisted overridden-blocker summary.

## Terminal behavior and reads

- Every game-write and role-swap action rejects `ENDED`, `FINISHED`, and `CLOSED` without mutation. Cover representative members of every game route family and all five swap actions.
- All authenticated room members can read the final settlement, including bank-only members. Nonmembers cannot read it unless an explicitly authorized super-admin endpoint is used.
- Settlement UPDATE, DELETE, and TRUNCATE remain rejected by database triggers. Add real PostgreSQL tests proving all three operations fail and the stored rows remain unchanged.
- Add `GameSettlement.overriddenBlockersJson Json` (empty array for normal finish) in a forward migration and expose it in the immutable DTO.
- Close post-finalization INSERT holes: reject `GameSettlement` or `SettlementPlayer` INSERT when the parent Room is already `FINISHED`/`CLOSED`; the finish transaction inserts parent/children before its final Room update. Also reject reopening/changing a terminal Room that owns a settlement. Prove post-commit parent/child INSERT, UPDATE, DELETE, and TRUNCATE all fail without changing stored bytes.
- Emit `room.finished` and `settlement.created` only after successful service completion. WebSocket events carry safe invalidation identifiers only; clients refetch REST state.
- The service returns whether this call created or replayed the settlement. Routes emit `room.finished`/`settlement.created` only for the creating commit, never for replay or failure.
- Member read allows any existing room membership, including historical `LEFT`, and returns only the shared allowlisted DTO. Add a distinct current-super-admin read route for nonmember inspection. Native `FINISHED` without a settlement returns `SETTLEMENT_INCONSISTENT`; legacy `ENDED` returns `LEGACY_SETTLEMENT_UNAVAILABLE`.
- Map capability/permission failures to 403; controller, blocker, idempotency, and terminal conflicts to 409; missing settlement to 404. Do not leak Prisma/Zod internals.
- Normal bank preview is available only for `PLAYING`. `LOBBY` returns `ROOM_NOT_PLAYING` (409), legacy `ENDED` returns `LEGACY_SETTLEMENT_UNAVAILABLE` (409), and `FINISHED`/`CLOSED` returns `ROOM_FINISHED` (409) after distinguishing a native `FINISHED` row without a settlement as `SETTLEMENT_INCONSISTENT` (500).
- Add `POST /api/admin/rooms/:id/settlement/preview` as a current-super-admin read-only preview for `LOBBY`, `PLAYING`, or legacy `ENDED`. It requires no membership/controller and performs no forced resolution; actual forced finish still requires a nonblank reason and Idempotency-Key. Its terminal/corruption behavior matches normal preview. Both preview modes use a coherent transaction snapshot and never persist an idempotency record.

## PostgreSQL acceptance coverage

- Use randomized isolated schemas, apply every migration, seed the real five characters and 26 properties, and drop only the test schema.
- Preserve Task 4 actor/capability/controller conventions; do not reintroduce raw tokens or legacy role/device APIs.
- Cover formula components, property detail snapshots, rank tie-breaks, joint winners, bank-only exclusion, and dual-member single inclusion.
- Cover each blocker, normal rejection without mutation, forced finish with reason/audit, wrong capability, stale controller, revoked Session, ordinary user attempting force, nonmember reads, and terminal write rejection.
- Cover concurrent finish/game write and finish/role-swap ordering, preview/asset drift, same-key replay, changed payload, cross-Account key isolation, different-key-after-finish, and unique settlement recovery.
- Prove later Master Data edits do not change the stored DTO and prove immutable trigger enforcement.
- Cover every lifecycle matrix cell, including migration/read behavior for legacy `FINISHED`-without-snapshot data reclassified to `ENDED`.
- Cover representative methods from every game-write family for `ENDED`, `FINISHED`, and `CLOSED`, plus all five role-swap actions, asserting zero business/idempotency mutation.
- Route tests prove both finish routes forward the actual Idempotency-Key, member/admin reads are distinct, event emission follows the create-only rule, and safe error/DTO contracts are preserved.

## TDD, verification, and report

- Capture targeted RED failures before production edits. A passing test written after implementation is not RED evidence.
- Run pure settlement tests, the focused real-PostgreSQL settlement/AccountRoomService integration cases, the full AccountRoomService suite, representative PrismaGameService terminal-write cases, focused route tests, ESLint, and strict API compilation.
- Write `.superpowers/sdd/task-5-report.md` with exact RED/GREEN commands, pass counts, changed files, self-review, and concerns.
