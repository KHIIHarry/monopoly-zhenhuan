# Task 6 admin preflight review

Date: 2026-07-27  
Mode: read-only audit; PostgreSQL and the dev server were not run  
Authority: V2.1 account/room development document

## Readiness verdict

**NOT READY.** The Task 6 brief is directionally correct, but implementation must not start until Task 5 is GREEN and the P0 contract amendments below are incorporated. There is no `.superpowers/sdd/task-5-report.md`, and the current code still has the pre-Task-5 settlement implementation: no `Room.startedAt`, no immutable overridden-blocker snapshot, no finish idempotency argument, stale preview outside the finish transaction, incomplete blocker/forced-resolution behavior, and unconditional finish events.

The current Task 6 implementation surface is only a partial scaffold:

- Account list/create/update/reset/enable/disable routes exist, but admin writes do not share persisted idempotency or fresh in-transaction authorization.
- Create/update mutations and their `SecurityLog` rows are not atomic.
- Target-account device administration, all-room administration, room detail/config/password/member/bank operations, safe log reads, and durable dashboard character aggregates are absent.
- Existing admin PostgreSQL coverage uses a fabricated `AuthenticatedSession` (`account-room-service.integration.test.ts:183-187`) instead of a real Cookie-created Session.

## P0 amendments

### P0.1 Make Task 5 a hard prerequisite

Task 6 force finish must call Task 5's finalized transaction, not the current `finishRoom()` implementation at `account-room-service.ts:770-825`.

Before Task 6 RED tests are written, require a Task 5 report proving:

- Normal and forced finish accept an Account-scoped idempotency key and authorize before replay.
- The Room is locked and Account/Session/capability/lifecycle/blockers/assets are re-read inside one Serializable transaction.
- Forced resolution, immutable overridden blockers, audit/security rows, create-versus-replay result, and event behavior match the Task 5 brief.
- The dedicated nonmember admin settlement read contract exists.

The Task 6 admin finish route must only validate/forward `{ roomId, mode: 'FORCED', reason }` plus the actual key. Do not duplicate settlement logic in an admin service method.

### P0.2 Define one shared privileged-write transaction

Current problems:

- `requireAdmin(auth)` trusts the request-time object (`account-room-service.ts:365`) and does not re-read the acting Account or Session.
- `createAccount()` and `updateAccount()` commit the business mutation before a separate security-log insert (`367-380`).
- Reset merely validates the header in the route and discards it; create discards it at the service boundary; update/status routes do not require it (`server.ts:90-106`).
- `ADMIN_REQUIRED` maps to 401 (`api-error.ts:3-13`), not 403.

Amend the brief with a reusable primitive such as:

```ts
executeAdminWrite({
  actor,
  scope,           // account:<actorId>:admin:<operation>:<targetId>
  key,
  canonicalInput,  // no raw Session/token; password only influences requestHash
  lockTarget,
  authorizeState,
  mutateAndAudit,
})
```

Binding order inside one Serializable transaction:

1. Lock the target Account or Room using a stable lock order.
2. Re-read actor Account and Session; require matching identity, ACTIVE Account, current `isSuperAdmin=true`, unrevoked/unexpired Session.
3. Re-read and authorize target lifecycle before replay.
4. Verify/replay only the exact actor/scope/key/canonical payload.
5. Apply the mutation plus `SecurityLog` and, for room writes, `AuditLog` atomically.
6. Persist an allowlisted response and idempotency record in that transaction.

Retry only PostgreSQL serialization/deadlock conflicts. A P2002 without an exact authorized persisted winner becomes `TRANSACTION_CONFLICT`. A revoked actor cannot replay. Every write family needs same-key replay, changed-payload rejection, cross-actor isolation, and concurrent same-key coverage.

### P0.3 Complete account and target-device contracts

Use one explicit account DTO for create/list/update responses:

```text
AdminAccountDto
id, username, displayName, note, status,
isSuperAdmin, canCreateRoom,
lastLoginAt, createdAt, updatedAt
```

Required amendments:

- Username is immutable after creation.
- List/search is bounded (`limit` max 100), ordered by `(createdAt DESC, id DESC)`, and cursor-based; filter by query/status/permission.
- `isSuperAdmin` and `canCreateRoom` remain independently optional in PATCH and receive independent tests.
- Create maps duplicate username to 409 `USERNAME_TAKEN`; missing accounts use `ACCOUNT_NOT_FOUND`; invalid/repeated lifecycle changes use stable 409 codes instead of Prisma P2025/P2002 leakage.
- Reset and disable revoke every valid target Session in the same transaction as the Account mutation/log. Enable never revives them.
- Password/reset responses, idempotency responses, and logs contain neither plaintext nor `passwordHash`.

Add target-device APIs using the existing masked `sessionSummary()` fields, plus safe lifecycle fields (`active`, `revokedAt`, `revokeReason`) for recent rows:

```text
GET  /api/admin/accounts/:accountId/sessions?state=&cursor=&limit=
POST /api/admin/accounts/:accountId/sessions/:sessionId/revoke
     body { reason }, Idempotency-Key required
```

The revoke transaction verifies the Session belongs to the target Account, records actor/target/reason once, revokes only that Session, and returns `{ sessionId, revokedAt }`. Emit `account.session.revoked` to that Session only after commit and only for the creating call, never for replay/failure.

### P0.4 Specify room-admin lifecycle and removal semantics

Add these explicit routes; every write requires an idempotency key:

```text
GET   /api/admin/rooms?query=&status=&cursor=&limit=
GET   /api/admin/rooms/:id
PATCH /api/admin/rooms/:id
POST  /api/admin/rooms/:id/password       body { password: string | null }
POST  /api/admin/rooms/:id/members/:memberId/remove
POST  /api/admin/rooms/:id/bank/reassign  body { targetMembershipId }
POST  /api/admin/rooms/:id/finish          body { reason } (Task 5 delegate)
GET   /api/admin/rooms/:id/settlement      (Task 5 admin read)
```

Room list/detail DTOs must expose configuration, creator label, lifecycle, blockers, settlement summary, and ACTIVE memberships with independent `characterId`/`isBank`, Player summary, and `controllerActive: boolean`. Never return `activeSessionId`, Session rows, password hash, raw relation graphs, or unrestricted JSON.

Define the configuration matrix rather than “supported fields”:

| Field | LOBBY | PLAYING | ENDED/FINISHED/CLOSED |
|---|---|---|---|
| `name`, `visibility`, password | allow | allow | reject |
| `diceMode`, skills, start reward, midgame join, transfer approval, auto-skip | allow before start | reject | reject |
| `initialBalance` | allow only before any Player/initial ledger exists | reject | reject |
| `playerLimit`, master data, historical values | never mutable; fixed at 5 | never | never |

Member removal remains underspecified and is a P0 decision. “Preserve assets” can leave a LEFT Player owning property/debt while “no unauthorized actionable Player” requires game behavior to exclude that Player. Amend the brief with an exact policy for snapshots, toll ownership, pending game requests/locks, debt, settlement eligibility, and continuing play.

At minimum, one room-locked transaction must:

- Require an ACTIVE membership and reject terminal rooms.
- Capture one timestamp; set membership `LEFT`, clear `characterId`, `isBank`, `activeSessionId`, and set `leftAt`.
- Set its retained Player to `LEFT` and clear only the Player character binding; never delete Player, ledger, transaction, property, debt, or audit history.
- Cancel/terminalize actor/target pending game requests and role swaps and release their property locks with stable admin-removal reasons.
- Reject removal when that Player owns the current ACTIVE turn unless the brief defines and reuses one exact Task 4 turn-resolution operation. Do not silently clear a dangling current turn.
- Define what happens when removing the only bank. Recommended: in PLAYING require an ACTIVE replacement membership in the same request/transaction; in LOBBY the bank may become vacant.

Bank reassignment must lock the Room, require an ACTIVE target, clear only the old `isBank`, set only the target `isBank`, preserve both character bindings/Players/assets/controllers, and write one before/after room audit. The existing partial unique index remains the final guard. Same-target behavior and concurrent reassignments need stable replay/conflict semantics.

### P0.5 Make SecurityLog safely append-only and queryable

`AuditLog` has UPDATE/DELETE/TRUNCATE guards, but `SecurityLog` has no append-only database guard. Task 6's “preserve append-only behavior” therefore requires a forward migration, not only service discipline.

Migration/DTO amendments:

- Reject SecurityLog UPDATE, DELETE, and TRUNCATE.
- Add the index required by actor/date cursor queries, e.g. `(actorAccountId, createdAt, id)`; retain account/action indexes.
- Use deterministic `(createdAt DESC, id DESC)` cursors and max limit 100.
- Add `GET /api/admin/security-logs` and `GET /api/admin/rooms/:id/audit-logs` with allowlisted action/actor/target/date filters.
- Mask stored IP before returning it. Do not expose Session IDs from `detailsJson`, raw IP, token/hash/password material, or arbitrary nested JSON. Map each supported action to a reviewed detail DTO; unknown actions return metadata only.
- Admin room mutation writes both a room `AuditLog` and appropriate Account-level `SecurityLog` inside the business transaction.

### P0.6 Define durable dashboard aggregate sources

Current `dashboard()` (`account-room-service.ts:833-841`) omits LOBBY rooms and both character aggregates, loads all settlements into memory, and returns raw recent settlement rows with nested Players.

Required DTO:

```text
accounts { total, active }
sessions { valid }
rooms { lobby, playing, finished }
games { settledTotal, averageDurationSeconds }
characterSelections [{ characterId, characterNameSnapshot, count }]
characterWins [{ characterNameSnapshot, count }]
recentGames [{ roomId, roomNameSnapshot, endedAt, durationSeconds, forced, winners }]
```

Amendments:

- Use database aggregation and bounded recent rows, not all-settlement loading.
- Valid Session count also requires ACTIVE Account, `revokedAt=null`, and `expiresAt>now`.
- Win counts come from immutable `SettlementPlayer.characterNameSnapshot`; tied winners each count once.
- Define selection count as successful initial/direct character acquisition only, or explicitly include executed swaps. The current durable source is ambiguous: `CHARACTER_SELECTED` is a mutable SecurityLog JSON event while swaps are room AuditLogs.
- If `CHARACTER_SELECTED` is the source, make SecurityLog append-only and store a reviewed `characterId` plus `characterNameSnapshot` event. Do not aggregate current memberships, because removals/swaps erase current bindings.
- Recent-game room/winner labels must be snapshots. Task 5 currently snapshots player/character labels but not room name; either add `roomNameSnapshot` to settlement or explicitly accept current Room name and prevent terminal rename.

## P1 route, error, and test amendments

### Public error contract

Map at least:

- 401: `AUTH_REQUIRED`, `INVALID_CREDENTIALS`, `SESSION_INVALID`.
- 403: `ADMIN_REQUIRED`, authenticated capability/room permission failures.
- 404: `ACCOUNT_NOT_FOUND`, `SESSION_NOT_FOUND`, `ROOM_NOT_FOUND`, `MEMBERSHIP_NOT_FOUND`.
- 409: `USERNAME_TAKEN`, idempotency conflict, invalid Account/Room/membership lifecycle, bank/member/current-turn conflicts, terminal Room.
- 429: rate limiting only.

Do not handle Prisma errors generically at the route boundary; translate expected P2002/P2025 outcomes in the transactional service and keep unknown errors at safe 500.

### Route testability

The current `server-room-routes.test.ts` checks source text with regular expressions. Task 6 needs an exported Fastify application factory so route tests can use `app.inject()` without listening. Inject real Cookie authentication and the PostgreSQL-backed service for positive/negative authorization; use focused fakes only for event-after-commit assertions.

Events must be emitted after service success, to the exact affected session/room, and only when the service says the mutation was created rather than replayed.

## Required RED-first coverage

Add Task 6-focused tests before production edits. The minimum matrix is:

1. **Actor validity:** real admin login succeeds; ordinary, disabled, expired, revoked, and privilege-revoked actors fail for every route family before replay.
2. **Shared idempotency:** create/update/reset/status/device/config/password/remove/reassign/force-finish cover replay, changed payload, cross-admin isolation, concurrent same key, exactly one business mutation, and exactly one audit/security row.
3. **Accounts:** duplicate username 409; bounded search/order/cursor; independent permission toggles; missing/invalid lifecycle errors; no password/hash/secret in DTO, idempotency response, or logs.
4. **Session lifecycle:** reset/disable revoke all valid target Sessions atomically; enable revives none; target list masks both IPs; force revoke affects one Session and notifies only it after commit.
5. **Room reads/config:** private/unjoined rooms are visible to admin without bank membership; DTO exposes dual capabilities and controller boolean but no Session ID/hash; exact lifecycle field matrix is enforced without partial mutation.
6. **Member removal:** history row counts/bytes preserved; membership/Player become inactive; capabilities/control clear; pending requests/swaps/locks terminalize; current-turn and sole-bank policy is proven; replay cannot repeat side effects.
7. **Bank reassignment:** one bank after commit; both character/Player/asset/controller identities unchanged; same-target and two-admin concurrent attempts return stable results.
8. **Task 5 delegate:** nonblank reason, ordinary-user rejection, actor revalidation, one immutable settlement, forced blocker matrix, create-only events, and idempotent replay.
9. **Logs:** append-only database guards; admin-only reads; max limits/cursors/filter ordering; IP/detail redaction; no unrestricted JSON or secrets.
10. **Dashboard:** total/active Accounts; only valid Sessions; all three Room states; duration; durable selections; wins and tied winners; renamed characters retain historical win labels; recent ordering/limit and safe exact keys.
11. **Failure atomicity:** force an audit/log insert failure and prove the Account/Room mutation and idempotency record also roll back.

Do not reuse `adminAuth()`. Create the administrator Account, log in, and call `authenticate()` to obtain the actor used by each service/route test. Use independent Prisma clients for concurrency and the existing randomized migrated schema; do not truncate guarded history.

## Implementation-ready gates

Task 6 becomes ready only when:

- Task 5 has a GREEN report and Task 6 consumes its finish/admin-read contracts unchanged.
- The shared privileged-write order, canonical scopes, replay authorization, and stable conflict recovery are binding.
- Account/device/room/log/dashboard routes and exact allowlisted DTOs are listed in the brief.
- The room configuration matrix and member-removal/current-turn/sole-bank/economic policy are resolved.
- SecurityLog append-only/index migration and durable selection/recent-game snapshot sources are chosen.
- Real Cookie-authenticated RED tests replace fabricated admin actors and regex-only route assertions for Task 6.

## Amended Task 6 brief re-audit

The amended brief resolves the original Task 6 authorization, transaction/idempotency, Account/device DTO, room configuration, conservative removal, SecurityLog, dashboard, application-factory, public-error, and RED-first test findings. Task 5's approved GREEN report is now correctly a **Task 6 execution prerequisite**, not a remaining Task 6 specification ambiguity.

Task 6 is not yet implementation-ready after Task 5 because four concrete contracts still admit incompatible implementations:

1. **Zero-bank LOBBY recovery is undefined.** The removal policy explicitly permits a LOBBY to have no bank, while bank reassignment is defined only as moving capability “from the current ACTIVE bank” to a target. Define `POST /api/admin/rooms/:id/bank/reassign` to accept zero or one current bank: with zero, it assigns the ACTIVE target; with one, it transfers; with more than one, it returns a stable corruption/conflict error. Preserve the same room lock, uniqueness guard, DTO, idempotency, and audit rules.
2. **Admin-removed membership rejoin/reactivation is undefined.** Task 3 allows a `LEFT` membership to join again, but removal sets both membership and retained Player to `LEFT`. The current join/select flow does not reactivate `Player.status`, so a removed Account can immediately rejoin into contradictory membership/Player state. Choose one binding policy: either admin removal blocks re-admission until an explicit admin restore, or normal join may restore it and must atomically reactivate the retained Player only when its capability is reacquired, without reissuing cash/palace/assets. Add removal -> join -> seat tests for LOBBY and the permitted PLAYING cases.
3. **Password mutation has two owners and no exact body.** The lifecycle matrix says password is PATCH-mutable, while a dedicated `POST /api/admin/rooms/:id/password` is also required. Make PATCH reject/omit password and define the dedicated body as `{ password: string | null }`, where null clears it and a nonempty bounded string resets it. The canonical idempotency payload must distinguish clear from reset without persisting plaintext.
4. **The global SecurityLog route is still unnamed.** The brief specifies an exact per-room AuditLog route but only says to “add” a global SecurityLog API. Bind it as `GET /api/admin/security-logs?action=&actorAccountId=&accountId=&from=&to=&cursor=&limit=` (or an equally explicit final path/query schema) so Task 7 and route tests share one contract.

After these four amendments, Task 6 is **implementation-ready after Task 5 GREEN**.

## Final amended Task 6 brief verdict

No remaining Task 6 specification blockers. The amended brief resolves the final bank reassignment, permanent removal, password mutation, and log-route contracts. Task 6 is implementation-ready once Task 5 has an approved GREEN report.
