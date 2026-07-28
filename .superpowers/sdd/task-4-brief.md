# Task 4: Cookie-authorized game writes and character-only role swaps

## Product authority

Read `/Users/harry/Documents/甄嬛传大富翁/甄嬛传大富翁_新版账号房间开发文档.md`, especially sections 4, 7-11, 15-18. `RoomMembership.characterId` and `RoomMembership.isBank` are independent capabilities on one membership and share one `activeSessionId`.

## Scope

- Modify `apps/api/src/prisma-game-service.ts`.
- Modify `apps/api/src/prisma-game-service.integration.test.ts`.
- Modify `apps/api/src/account-room-service.ts` and its integration test for role swaps.
- Modify `apps/api/src/server.ts` and focused route-contract tests.
- Delete the unused legacy `apps/api/src/game-service.ts`, `game-service.test.ts`, and `game-service-mvp.test.ts` if no production import remains.
- Add a shared isolated PostgreSQL test helper only if it reduces the existing Task 2/3/4 setup without weakening safety.
- Do not implement settlement, admin dashboard, or frontend work.

## Game actor and authorization contract

- Replace raw device/bearer token arguments with an explicit authenticated actor derived from the secure Cookie, containing only the Account and Session identifiers needed by the service.
- Remove `PrismaGameService.createRoom`, `joinPlayer`, `joinBank`, `reconnect`, legacy player/bank/member authorizers, `matchesBearerToken`, and all reads of removed `RoomMembership.role`, `deviceTokenHash`, `onlineStatus`, `bankControlGrantedAt`, or `lastSeenAt` fields.
- Remove `AuthenticatedSession.rawToken` once no backend consumer needs it. Never pass the raw Cookie token into game-domain methods or store it in audit/idempotency data.
- Every game write route must authenticate the Cookie and perform an early membership/controller/capability check so stale devices cannot replay cached results.
- Every game-domain mutation must repeat authorization inside the same Serializable/idempotent database transaction as the business write. It must verify:
  - the Account is ACTIVE;
  - the Session is not revoked or expired;
  - the membership is ACTIVE and belongs to the Account and room;
  - `activeSessionId` equals the current Session;
  - the room is not `ENDED`, `FINISHED`, or `CLOSED`;
  - PLAYER operations have `characterId` and the same membership's Player, and the requested player id matches it;
  - BANK operations have `isBank=true`.
- Authorization must run before returning an idempotency replay. A Session that lost room control must receive `ROOM_CONTROL_LOST`, even when reusing an old successful key.
- Game-write idempotency scopes must include the authenticated Account and operation/resource. Same key/same canonical payload replays once; changed payload returns `IDEMPOTENCY_KEY_REUSED`; another Account cannot observe or replay the result.
- A takeover racing a write must serialize to one defensible result: either the old controller's transaction commits before takeover, or it fails authorization/serialization and cannot mutate after takeover.
- A dual member uses the same actor, membership, Session controller, audit identity, and Player for PLAYER and BANK operations.

## Snapshot and real-time boundary

- Snapshot reads and Socket.IO room subscriptions use Cookie authentication and the shared `activeSessionId`; the noncontrolling Session cannot open the live room.
- Support an explicit PLAYER/BANK snapshot view for a dual member. Validate the requested capability; default only when the membership has exactly one capability. Switching view does not create a Session, membership, Player, cash, or assets.
- WebSocket events remain notifications only and cause clients to refetch REST snapshots.

## Role-swap workflow

- Public methods/routes: request, accept, reject, bank approve, and cancel. Every mutation receives and persists `Idempotency-Key` with Account-scoped canonical replay semantics.
- All five actions require the caller's current `activeSessionId` and reject terminal rooms.
- A requester may have no character (replacement) or one character (mutual character swap). The target is an ACTIVE membership currently holding the requested character and cannot be the requester.
- LOBBY: target acceptance executes the swap atomically.
- PLAYING: target acceptance moves the request to `PENDING_BANK`; the unique bank must submit a separate bank-capability request to execute it.
- A dual bank who is also requester or target may perform the target decision and bank confirmation, but these remain distinct requests and distinct audit rows.
- Reject is target-only, cancel is requester-only, and bank approval is bank-only. State transitions are compare-and-set/serialized; stale or repeated transitions cannot execute twice.
- Lock the room and re-read request, memberships, Players, room status, and current characters before execution. Conflicts become `CONFLICTED` or the documented public conflict code without partial changes.
- Swap only character/skill binding state (`RoomMembership.characterId` and matching `Player.characterId`). Preserve each membership's `isBank`, `activeSessionId`, control timestamp, Player identity, balance, properties, buildings, skip turns, partner cards, turn order, pawn color, ledger, requests, transactions, and audit history.
- Use temporary null character bindings within the transaction so the membership and Player unique constraints remain valid.
- A characterless requester acquiring a first Player before play may receive the normal one-time initial cash ledger and initial palace. During PLAYING, never issue initial cash or an initial palace. Existing Players are always reused and never receive a second grant.
- When a former target has a retained Player but no character and later selects a free character, reuse that Player/slot/assets without creating or reissuing anything.
- Do not modify `isBank` during any swap. Bank-only initial selection still creates no Player/assets; a retained Player from an agreed replacement remains attached to its original membership/assets and is excluded from player authorization until that membership has a character again.
- Produce allowlisted role-swap DTOs. Do not return included Room rows, `passwordHash`, Session identifiers, Account secrets, or nested Prisma relations.
- Write separate immutable `AuditLog` rows for request, target accept/reject, requester cancel, bank confirmation, and final execution as applicable. The bank confirmation has actor role BANK even when the same Account previously acted as PLAYER.
- Emit `role.swap.requested`, `role.swap.updated`, and `room.seats.updated` notifications only after successful service completion.

## PostgreSQL acceptance coverage

- Replace legacy join/device-token test setup with V2 Account/Session/RoomMembership fixtures or a test-only facade over `AccountRoomService`; production must not retain compatibility join methods.
- Use randomized isolated schemas, apply every migration, seed 26 properties/five characters, and drop only that schema. Never disable, drop, or weaken immutable history/settlement triggers.
- Preserve the existing money/property/dice/turn/landing/reversal assertions while migrating authorization inputs.
- Prove a representative operation from every player-write and bank-write route family rejects wrong capability, wrong player, stale controller, revoked Session, and terminal room without mutation.
- Prove controller takeover and a racing write cannot allow the old Session to mutate afterward; replay from the old Session is also rejected.
- Prove two Accounts cannot share an idempotency result even with the same key/payload.
- Prove a dual member can perform both player and bank operations through one membership/Session and one Player/asset set.
- Prove LOBBY replacement, LOBBY mutual swap, PLAYING target acceptance plus separate bank confirmation, rejection, cancellation, same-account dual-bank confirmation, conflict/concurrency handling, and idempotent replay.
- Snapshot complete before/after rows to prove swaps preserve `isBank`, controller, Player IDs, cash, property ownership/buildings, skip turns, pawn/turn allocation, ledger, and transactions.
- Prove no-character PLAYING replacement gets no initial cash/palace and a retained Player is reused if its member later selects a character.
- Add a production-source contract asserting legacy join/reconnect/bearer/device-token APIs and fields are absent.

## Verification and report

- Capture targeted RED failures before production edits.
- Run the migrated full PostgreSQL game integration suite and AccountRoomService integration suite.
- Run route/unit tests, focused ESLint, and full API TypeScript compilation. Task 4 is not complete while `prisma-game-service.ts` has legacy-field diagnostics.
- Write `.superpowers/sdd/task-4-report.md` with RED/GREEN evidence, changed files, self-review, and any concerns.

