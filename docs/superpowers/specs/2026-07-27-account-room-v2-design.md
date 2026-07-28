# Account and Room V2.1 Design

## Product Source

`甄嬛传大富翁_新版账号房间开发文档.md` version 2.1 is the sole product authority. The existing V2 files are partial implementation work and do not override that document.

## Approach

Three implementation shapes were considered:

1. Rewrite the API and game engine around new account models. This gives clean boundaries but needlessly reimplements the already-tested money, property, dice, ledger, and audit transactions.
2. Keep a parallel legacy identity API beside the new account API. This lowers short-term edit volume but directly violates the requirement to remove room-code, device-token, bank-code, and admin-token identity flows.
3. Keep the proven `PrismaGameService` game rules and replace its identity boundary with account Sessions and membership capabilities. Complete the partial `AccountRoomService`, remove legacy join/reconnect code, and adapt the H5 shell around authoritative REST snapshots.

Approach 3 is selected. It preserves the highest-risk business rules while removing the conflicting identity model rather than maintaining two systems.

## Membership And Capabilities

Each `(roomId, accountId)` has one active `RoomMembership`. The membership contains one nullable `characterId`, one `isBank` boolean, and one shared `activeSessionId`.

- `characterId != null` grants the player capability and has exactly one associated `Player` record.
- `isBank = true` grants the bank capability.
- Both may be present on the same membership.
- Selecting a character never clears `isBank`; selecting bank never clears `characterId` or creates a `Player`.
- A bank-only member receives no balance, property, turn order, or settlement row.
- A dual-capability member keeps one `Player`, one balance, one asset set, and one settlement row.

Database guarantees are `UNIQUE(roomId, accountId)`, `UNIQUE(roomId, characterId)`, and a PostgreSQL partial unique index on active `isBank=true` memberships. `Player.characterId` remains mirrored for compatibility with the game engine and is updated in the same transaction.

## Authentication And Device Control

Login creates a random 30-day server Session. Only its SHA-256 hash is stored. Cookies are HttpOnly, Secure, and SameSite=Lax. Passwords use Node.js scrypt with a random salt as an Argon2id-equivalent memory-hard construction already supported by the repository runtime.

Session creation and third-device replacement run at Serializable isolation. A third login returns the two existing summaries without creating a Session. Confirmation revokes the oldest active Session, creates the replacement, and records a security log atomically. Password reset and account disable revoke every Session.

The membership's one `activeSessionId` controls both player and bank capabilities. Taking control changes that single value, so another device immediately loses both workbenches.

## API And Game Authorization

REST remains authoritative. Every game write first authenticates the Cookie Session and checks `activeSessionId`. Player writes additionally require `characterId` plus the linked `Player`; bank writes require `isBank=true`.

A dual-capability member requests snapshots with an explicit `view=PLAYER` or `view=BANK` query. Switching workbenches changes only that view. It does not create a Session, membership, or asset record.

All critical V2 writes use persisted idempotency records with canonical request hashes. WebSocket events only invalidate client state; connection and reconnection trigger a fresh REST snapshot.

## Character Selection And Swaps

Character selection is a Serializable transaction that verifies the membership has no character, assigns the unique character, creates the one `Player` if needed, and grants initial balance/property exactly once. A unique conflict maps to `ROLE_ALREADY_TAKEN`. Concurrent attempts by one account to select different characters are serialized and the slower request returns `ACCOUNT_CHARACTER_LIMIT_REACHED`.

Swaps remain character-only. They update both memberships' and players' character IDs atomically and never modify `isBank`, balances, properties, buildings, skip turns, or transaction history. Before play, target acceptance executes the swap. During play, target acceptance moves it to bank approval. A dual-capability participant may separately perform the bank confirmation from the bank workbench.

## Settlement

Preview and finish share one settlement builder. Finish rechecks blockers and computes the snapshot inside the same Serializable transaction that creates `GameSettlement`, creates one `SettlementPlayer` per character-bearing member, and sets the room to `FINISHED`.

Total wealth is cash plus unmortgaged sale value plus mortgaged net value plus building sell value. Ranking uses total wealth, then cash, then unmortgaged property value; exact remaining ties share a rank and winner state. Stored property details contain all values needed for history, so later Master Data edits cannot alter results.

## H5 Flow

The first screen is the poster and `加入游戏组`. Login contains only username and password. The authenticated shell contains room lobby, optional password join, seat management, profile/devices, game workbenches, settlement, and super-admin management.

Seat management always fetches a current snapshot. It shows occupied characters, character swaps, the unique bank state, and dual-capability actions. The game header exposes a stable `玩家端` / `银行端` segmented control only when both capabilities exist. No spectator or read-only game surface exists.

## Errors And Tests

Rule errors are stable public codes. Authentication failures are 401, permission failures are 403, missing resources are 404, rate limits are 429, and state/concurrency conflicts are 409.

Pure tests cover password/cookie behavior and settlement ranking. PostgreSQL integration tests cover the two-Session limit, atomic replacement, revocation, room passwords, dual-capability selection, concurrent character/bank claims, control takeover, swaps, settlement immutability, and post-finish write rejection. Playwright covers the complete mobile navigation and confirms all legacy entry points are absent.

## Self-Review

The design contains no placeholder behavior. Character and bank capabilities are independent throughout schema, authorization, UI, and settlement. Bank-only members are excluded from wealth ranking, dual-capability members appear once, and all capability changes share one membership and one controlling Session.
