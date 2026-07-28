# Task 5 settlement preflight

Read-only audit performed against the V2.1 product authority and corrected goal objective.

## Critical gates

- Compute land sale value as `mortgagePrice * 2`, mortgaged net value as sale value minus mortgage price, and total wealth by adding cash, unmortgaged land value, mortgaged net value, and building sell value. Do not substitute `purchasePrice`.
- Lock the Room and re-check blockers, re-read all assets, recompute rankings, persist the immutable snapshot, and set `FINISHED` in one Serializable transaction. Do not persist a preview computed outside the transaction.
- Preview and finish require an ACTIVE membership, current `activeSessionId`, and BANK capability unless the actor is an authorized super-admin forced-finisher.
- Every game and role-swap write must reject `ENDED`, `FINISHED`, and `CLOSED` rooms.

## Important gates

- Blockers cover pending approvals, incomplete transfers/property trades, pending role swaps, abnormal balances, open debts, unresolved landings/property locks, and an active turn.
- The product requires blocker inspection even for forced finish. Specify and test whether an admin may acknowledge/resolve blockers; do not silently bypass them.
- Finish requires account-scoped persisted idempotency with a canonical request hash and replay/conflict behavior.
- Settlement reads return explicit allowlisted DTOs rather than raw Prisma entities.

## Existing foundations to preserve

- Candidate direction is correct when it includes only ACTIVE memberships with both `characterId` and their matching Player. This excludes bank-only members and includes a dual member once.
- Existing settlement UPDATE/DELETE/TRUNCATE rejection triggers are present in migration `202607260006_account_room_v2`; retain and integration-test them.
- Existing uniqueness on membership, Player member binding, and settlement account rows supports one ranking row per account.

## Required integration coverage

- Formula with deliberately different `purchasePrice` and `mortgagePrice`.
- Bank-only excluded and dual-capability member included exactly once.
- All blockers, including debt, negative/abnormal balance, unresolved landing, property lock, transaction/trade, swap, and active turn.
- Controller loss, revoked Session, wrong capability, and terminal room.
- Concurrent finish, replay, and changed-payload idempotency conflict.
- Snapshot/ranking recomputed after a concurrent asset change or serialized defensibly.
- Immutable trigger rejection for UPDATE, DELETE, and TRUNCATE.
- Safe response DTOs and all post-finish game/swap write families.
