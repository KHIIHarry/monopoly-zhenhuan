# Task 3: Room lobby, passwords, dual-capability seats, control, and idempotency

## Product requirements

- Room lists expose public fields only and group `我参与的游戏`, joinable rooms, and history. Member count counts unique active accounts once; player count counts non-null `characterId`; a dual member never counts twice.
- Only `canCreateRoom=true` accounts can create rooms. Optional room passwords are hashed, lists expose only `hasPassword`, wrong attempts are rate-limited, and an already joined account is never asked for the password again.
- Joining creates or returns exactly one `(roomId, accountId)` active membership using `Account.displayName`; it does not create a Player until a character is first acquired.
- `RoomMembership.characterId` and `isBank` are independent capabilities. A member may have at most one character and may also be the unique active bank.
- Selecting a character preserves `isBank`. Selecting bank sets only `isBank=true` and preserves `characterId` and the existing Player/assets.
- Character-first-then-bank and bank-first-then-character both retain one membership, one Session controller, at most one Player, one initial balance grant, and one initial palace assignment.
- A bank-only member has no Player, cash, property, turn order, or settlement assets.
- Initial palace assignment is independent of whether initial cash is zero. Initial cash creates at most one auditable ledger transaction when nonzero.
- Existing character selection is idempotent for the same character. Direct selection of a second character returns `ACCOUNT_CHARACTER_LIMIT_REACHED`.
- Concurrent claims are database-backed: a taken character returns `ROLE_ALREADY_TAKEN`; a taken bank returns `BANK_ALREADY_TAKEN`; no fallback seat is assigned. Concurrent different-character attempts by one account leave exactly one character.
- Seat snapshots always reflect current DB state and expose occupation nickname, character skill/initial palace, bank occupation, the caller's `characterId`, `isBank`, `playerId`, and whether this Session controls the membership. The caller's own occupied character must not offer a swap-to-self action.
- Both capabilities share one `activeSessionId`. A new membership starts controlled by the joining Session. A second Session does not silently take control; `takeControl` atomically changes the single controller and reports the previous Session.
- Critical room/seat/control writes use persisted idempotency with a canonical request hash: the same account + route/operation + key + same payload replays the stored result without duplicate rows/assets/logs; reuse with a different payload returns `IDEMPOTENCY_KEY_REUSED`.
- No room response exposes `passwordHash` or other database-only secrets.

## Public methods and routes

- `listRooms`, `createRoom`, `joinRoom`, `seats`, `selectCharacter`, `selectBank`, `takeControl`
- `GET /api/rooms`, `/api/rooms/mine`, `/api/rooms/history`
- `POST /api/rooms`, `/api/rooms/:id/join`, `/select-character`, `/select-bank`, `/take-control`

## Files in scope

- `apps/api/src/account-room-service.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/server.ts`
- `apps/api/src/api-error.ts`
- `packages/database/prisma/schema.prisma` and a new migration only if the existing idempotency schema cannot safely represent V2 operations

Do not implement role swaps, game-engine authorization, settlement, or admin dashboard in this task.

## PostgreSQL acceptance coverage

- create permission; password correct/wrong/rate-limited/already-member bypass; no secret response fields;
- both capability acquisition orders and bank-only state;
- initial balance/property exactly once, including zero-balance palace assignment;
- second-character rejection with exact code;
- two-account same-character race, two-account bank race, and one-account different-character race;
- shared controller and takeover behavior;
- idempotent replay and conflicting-key reuse without duplicate Membership/Player/ledger/property/security-log rows.

Use `TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public`. Reuse the scoped Task-2 cleanup approach and never weaken history/settlement immutability.

