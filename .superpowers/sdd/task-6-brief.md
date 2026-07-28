# Task 6: Transactional super-admin accounts, devices, rooms, logs, and dashboard

## Product authority

Read `/Users/harry/Documents/甄嬛传大富翁/甄嬛传大富翁_新版账号房间开发文档.md`, especially sections 2-4, 7, 12-14, 16, and 18. It is the sole product authority. Also read `.superpowers/sdd/task-6-preflight.md` and the approved Task 2-5 reports before editing.

## Scope

- Modify `apps/api/src/account-room-service.ts`, `server.ts`, and `api-error.ts`.
- Add focused route/contract tests and PostgreSQL integration coverage.
- Modify schema/migrations only if an indexed, immutable audit query or explicit admin operation needs a forward-only database constraint. Never weaken ledger, audit, history, or settlement triggers.
- Do not implement the web admin UI; Task 7 consumes the safe APIs from this task.
- Task 5 must have an approved GREEN report first. Admin forced finish and nonmember settlement read delegate to Task 5 unchanged; Task 6 must not duplicate settlement logic.

## Shared privileged-write contract

Every admin write receives an `Idempotency-Key` and uses an Account-scoped operation/resource scope plus canonical payload. Inside one room-locked or account-serialized Serializable transaction, in this order:

1. Re-read the acting Account and Session and require ACTIVE, unexpired, unrevoked, matching identity, and `isSuperAdmin=true`.
2. Authorize lifecycle/target state before idempotency replay.
3. Replay only the same Account/scope/key/payload; changed payload is `IDEMPOTENCY_KEY_REUSED`.
4. Apply the mutation and its `SecurityLog`/`AuditLog` row atomically.
5. Return an explicit allowlisted DTO with no password hash, token hash, raw IP, Session secret, or unrestricted relation.

Retry only serialization/deadlock conflicts. Recover an exact persisted winner; otherwise return a stable public `TRANSACTION_CONFLICT`, never a Prisma error. Same-key concurrency creates one mutation and one audit. A revoked Session cannot replay a cached privileged result.

Implement this as one shared `executeAdminWrite`-style primitive. It locks the target Account or Room first using a stable lock order, then performs actor/target authorization, replay, mutation/audit, and response persistence. Password plaintext is never persisted in canonical JSON/response/logs; its canonical intent is represented only by the salted request hash comparison required for idempotency.

Map `ADMIN_REQUIRED` to HTTP 403, duplicate usernames to stable HTTP 409 `USERNAME_TAKEN`, missing resources to safe 404 codes, and invalid lifecycle changes to stable 409 codes.

## Account and device administration

Implement/finish allowlisted admin APIs for:

- create Account;
- list/search Accounts;
- edit `displayName`, `note`, `isSuperAdmin`, and `canCreateRoom` independently;
- reset password and atomically revoke every active target Session;
- disable/enable Account, with disable atomically revoking every active target Session;
- list a target Account's active/recent devices using the same masked device DTO as self-service;
- force revoke one target Session, writing actor/target/reason and notifying that Session only after commit.

Use one `AdminAccountDto`: `id`, `username`, `displayName`, `note`, `status`, `isSuperAdmin`, `canCreateRoom`, `lastLoginAt`, `createdAt`, `updatedAt`. Username is immutable after creation. Account list/search uses `(createdAt DESC, id DESC)` cursor pagination, maximum limit 100, and reviewed query/status/permission filters.

Also extend the authenticated self/login Account DTO with allowlisted `lastLoginAt` so Task 7's profile can render recent login from authoritative Account state; never infer it from client storage.

Target-device routes are:

```text
GET  /api/admin/accounts/:accountId/sessions?state=&cursor=&limit=
POST /api/admin/accounts/:accountId/sessions/:sessionId/revoke
```

Revocation body is `{ reason }` and requires Idempotency-Key. The DTO reuses masked login/last IP and safe device/timestamp/current-state fields; it may return `active`, `revokedAt`, and reviewed `revokeReason`, but never a token hash or controller Session id. Emit `account.session.revoked` only after a creating commit, never for replay/failure.

Passwords are hashed before persistence, never returned, never included in an idempotency response/audit payload, and never logged. Username remains immutable after creation unless the sole authority is amended. Account list/search has bounded pagination and deterministic ordering.

## Room administration

Add authenticated super-admin REST surfaces to list/search all rooms and inspect one room's allowlisted configuration, creator, active memberships, independent `characterId`/`isBank` capabilities, controller presence (boolean only, never Session ID), Player/settlement summary, blockers, and lifecycle.

Exact routes:

```text
GET   /api/admin/rooms?query=&status=&cursor=&limit=
GET   /api/admin/rooms/:id
PATCH /api/admin/rooms/:id
POST  /api/admin/rooms/:id/password
POST  /api/admin/rooms/:id/members/:memberId/remove
POST  /api/admin/rooms/:id/bank/reassign
POST  /api/admin/rooms/:id/finish
GET   /api/admin/rooms/:id/settlement
GET   /api/admin/rooms/:id/audit-logs
```

Lists use `(createdAt DESC, id DESC)` cursor pagination with limit at most 100. Detail DTO exposes `controllerActive: boolean`, never `activeSessionId`.

Privileged writes:

- Update configuration with this exact lifecycle matrix: `name` and `visibility` are mutable in `LOBBY`/`PLAYING`; `diceMode`, `skillEnabled`, `startReward`, `allowMidgameJoin`, `transferApprovalRequired`, and `autoSkipTurn` are LOBBY-only; `initialBalance` is LOBBY-only and only before any Player/initial ledger exists; `playerLimit` stays 5 and master/historical values are never mutable. PATCH never accepts a password. All `ENDED`/`FINISHED`/`CLOSED` changes reject.
- Reset/clear the optional room password only through `POST /api/admin/rooms/:id/password` with exact body `{ password: string | null }`: null clears it; a trimmed nonempty value of at most 100 characters resets it through the shared hash helper; empty strings reject. The canonical intent distinguishes clear/reset while only the salted request hash persists plaintext-derived input. Never return/log the password or hash.
- Remove an ACTIVE membership atomically without deleting history under the exact policy below.
- Reassign the unique bank capability atomically from the current ACTIVE bank membership to one target ACTIVE membership. Preserve both memberships' character bindings, Players, balances, assets, and shared controllers. Database uniqueness remains the final guard.
- Force finish through Task 5's exact settlement transaction with a required nonblank reason and idempotency, not a second finish implementation.

Every room mutation locks the room before reading mutable state. Do not expose or recreate a second membership/Player/asset set when changing the bank.

Member-removal policy:

- Always capture one timestamp, set membership `LEFT`, clear `characterId`/`isBank`/controller, set `leftAt`, and set a retained Player to `LEFT` with only its character binding cleared. Never delete Player, ledger, transaction, debt, settlement, or audit rows.
- Reject terminal rooms. Reject removal whenever the Player owns the ACTIVE/current turn; do not silently end or advance it.
- In PLAYING, reject an ACTIVE solvent character Player. Only an unseated/bank-only membership or an already `BANKRUPT`/`LEFT` Player with no owned property, open debt, pending request, or active turn is removable. The operator must use the game bankruptcy workflow or forced finish first.
- In LOBBY, removal is allowed only when owned properties are unbuilt, unmortgaged, and there is no debt/pending game state. Release those clean starting properties to the bank (`ownerPlayerId=null`, version increment) so later selection can grant the palace; preserve balance/initial ledger history on the retained LEFT Player.
- Cancel/terminalize pending requests and role swaps involving the membership with stable `ADMIN_MEMBER_REMOVED` reason, resolve timestamps, reviewed audits, and release every matching property lock. Settlement/gameplay exclude LEFT membership/Player under Task 4/5 predicates.
- In PLAYING, removing the sole bank is rejected with `BANK_REPLACEMENT_REQUIRED`; reassign first. LOBBY may temporarily have no bank.
- Admin removal is permanent for this V2.1 scope: because there is no voluntary leave or restore workflow, `joinRoom` must detect an existing `LEFT` membership and return stable `ROOM_MEMBERSHIP_REMOVED` without reactivating the membership/Player or reissuing assets. An explicit admin restore is out of scope and must not be implied by the UI. Cover remove -> attempted join/select in LOBBY and PLAYING.

Bank reassignment body is `{ targetMembershipId }`. Under the room lock, accept zero or one current ACTIVE bank: zero assigns the ACTIVE target (recovering a vacant LOBBY bank); one transfers it; more than one returns stable `BANK_STATE_INVALID`. Same-target is an idempotent no-op result with no second audit; otherwise clear only old `isBank`, set only target `isBank`, preserve characters/Players/assets/controllers, and write one before/after room AuditLog plus SecurityLog. Concurrent different targets serialize; a loser receives stable `TRANSACTION_CONFLICT` unless it is an exact replay.

## Logs and dashboard

Add bounded, deterministic, allowlisted read APIs for global `SecurityLog` and per-room `AuditLog`. The global route is `GET /api/admin/security-logs?action=&actorAccountId=&accountId=&from=&to=&cursor=&limit=`; the room route is `GET /api/admin/rooms/:id/audit-logs?action=&actorMemberId=&from=&to=&cursor=&limit=`. Support only these reviewed filters without returning password/session hashes, raw nested JSON secrets, or unbounded result sets. Preserve append-only behavior.

Add a forward migration that rejects `SecurityLog` UPDATE, DELETE, and TRUNCATE and adds `(actorAccountId, createdAt, id)` support for cursor queries. Both log APIs order `(createdAt DESC, id DESC)`, cap limits at 100, mask IPs, and map each supported action to a reviewed detail DTO. Unknown actions return metadata only, never arbitrary `detailsJson`.

Dashboard returns explicit aggregate DTOs for:

- total and ACTIVE Accounts;
- current valid Sessions;
- LOBBY/PLAYING/FINISHED rooms and total settled games;
- average settled duration;
- per-character selection counts;
- per-character win counts;
- recent finished games with safe snapshot labels.

Exact shape:

```text
accounts { total, active }
sessions { valid }
rooms { lobby, playing, finished }
games { settledTotal, averageDurationSeconds }
characterSelections [{ characterId, characterNameSnapshot, count }]
characterWins [{ characterNameSnapshot, count }]
recentGames [{ roomId, roomNameSnapshot, endedAt, durationSeconds, forced, winners }]
```

Valid Sessions also require an ACTIVE Account. Selection counts mean successful direct `CHARACTER_SELECTED` acquisitions only, not swaps; ensure the append-only event stores reviewed `characterId` and `characterNameSnapshot`, using current Character name only as fallback for older events. Win counts use immutable winner SettlementPlayer snapshots, counting every tied winner once. Recent games may use current `Room.name` because terminal room renaming is forbidden; return it explicitly as `roomNameSnapshot` in the DTO.

Selection and win counts must be based on durable history/snapshots, not only current memberships. Character name changes after a settlement must not rewrite historical win labels.

## Required RED-first PostgreSQL coverage

Before production edits, add and run tests that fail for the missing behavior. Record each expected failure in `.superpowers/sdd/task-6-report.md`.

- Real Cookie-authenticated admin succeeds and ordinary/disabled/revoked/non-admin actors fail for every route family; do not fabricate an admin auth object that bypasses Session checks.
- Create/update/reset/status/device/room writes: same-key replay, changed-payload rejection, cross-Account key isolation, and concurrent same-key behavior.
- Duplicate username maps to `USERNAME_TAKEN`; password/hash never appears in DTO, idempotency response, or logs.
- Reset and disable revoke all active target Sessions atomically; the next target request fails. Enable does not revive old Sessions.
- Target device listing masks both IPs; forced revocation affects only the target Session and writes exactly one security event.
- `isSuperAdmin` and `canCreateRoom` change independently.
- Admin room listing includes private/unjoined rooms without requiring bank membership; details expose dual capabilities without Session IDs.
- LOBBY configuration/password changes work; forbidden PLAYING rule changes and all terminal changes fail without mutation.
- Member removal preserves immutable history/assets, clears capabilities/control, terminalizes pending swaps, and cannot leave a dormant current turn.
- Bank reassignment keeps one bank, both character bindings, and one Player/assets set per membership, including concurrent attempts.
- Forced finish uses Task 5, requires a reason, produces one immutable settlement, and logs the actor/reason.
- Log APIs enforce admin authorization, pagination, filtering, and secret allowlisting.
- PostgreSQL rejects SecurityLog UPDATE, DELETE, and TRUNCATE with stored rows unchanged.
- Dashboard aggregate fixtures prove character selections, wins, ties, duration, active Session filtering, and recent-game ordering.
- Refactor server startup behind an exported Fastify application factory so Task 6 route tests use `app.inject()` without listening. Use real Cookie login/authentication and PostgreSQL-backed positive/negative authorization; source-regex tests alone are not acceptance evidence.
- Public mappings are explicit: authentication failures 401; `ADMIN_REQUIRED` and authenticated permission failures 403; account/session/room/membership not found 404; username/idempotency/lifecycle/member/bank/terminal conflicts 409; throttling only 429. Expected P2002/P2025 errors are translated in the transaction.

## Verification and report

Run the focused RED cases, full AccountRoomService PostgreSQL suite, Task 5 settlement suite, route/error tests, API-local tests, focused ESLint, Prisma generation if schema changed, and API build. Use the randomized migrated-schema fixture and drop only that schema.

Write `.superpowers/sdd/task-6-report.md` with exact RED/GREEN commands and counts, changed files, public API/DTO inventory, transaction/idempotency self-review, and concerns. Return `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED` with a short summary.
