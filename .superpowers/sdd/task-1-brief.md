# Task 1: V2.1 data model and migration

## Product constraints

- `RoomMembership.characterId` and `RoomMembership.isBank` are independent capabilities on one `(roomId, accountId)` membership.
- Selecting either capability must preserve the other. A bank-only member has no Player or assets; a dual member has exactly one Player and one asset set.
- Preserve historical ledger, audit, transaction, property, and Player data while invalidating legacy device-token control.
- Enforce unique `(roomId, accountId)`, unique `(roomId, characterId)`, and one active bank per room with a PostgreSQL partial unique index.
- Existing RoomMember table identity and foreign keys must remain usable.
- Seed exactly the five configured characters and 26 verified properties. Create a bootstrap super-admin only when all bootstrap environment variables are supplied.

## Files in scope

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/202607260006_account_room_v2/migration.sql`
- `packages/database/prisma/migrations/202607270007_dual_role_capabilities/migration.sql`
- `packages/database/src/seed.ts`
- `packages/database/src/database-contract.test.ts`

## Acceptance evidence

- Database contract tests pass.
- Prisma client generation succeeds.
- A clean PostgreSQL database applies all migrations in order.
- Seed succeeds against the clean migrated database.
- Migration does not use a newly added PostgreSQL enum value in the same transaction that introduces it.

