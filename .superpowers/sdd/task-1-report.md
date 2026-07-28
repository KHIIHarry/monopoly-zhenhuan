# Task 1 implementation report

## Changes

- Replaced exclusive membership role state with nullable `characterId`, independent `isBank`, and shared `activeSessionId`.
- Added migration 007 to convert legacy bank roles, remove obsolete device/role columns, and recreate the active-bank partial unique index.
- Split the RoomStatus data update from migration 006 so PostgreSQL does not consume `FINISHED` in the same transaction that adds the enum value.
- Retained five-character and 26-property seed behavior with optional bootstrap administrator creation.

## Verification

- `npm run test -- packages/database/src/database-contract.test.ts`: 10/10 passed.
- `npm run db:generate`: passed with Prisma Client 6.19.0.
- Clean `zhenhuan_test` database: all seven migrations applied successfully.
- Seed on clean database: 26 properties and five characters seeded successfully.

## Environment constraint

This project directory has no `.git` metadata, so no commit range or Git diff package exists. Review must inspect the scoped files directly.

## Review fixes: bootstrap conflict and populated migration coverage

- Bootstrap seeding now accepts an existing username only when that account is `ACTIVE`, `isSuperAdmin=true`, and `canCreateRoom=true`. That rerun is idempotent.
- Any configured bootstrap username owned by an ordinary, disabled, or room-creation-disabled account throws `BOOTSTRAP_ADMIN_USERNAME_CONFLICT`. The account is neither created over nor updated/elevated.
- Added a strict PostgreSQL integration test that creates a random schema in the dedicated `zhenhuan_test` database, applies migrations 001-005, inserts populated legacy player/bank/history data, applies 006-007, verifies data and database constraints, then drops only that random schema.

### TDD RED: unsafe bootstrap account was silently accepted

Command:

```text
npm run test -- packages/database/src/seed-bootstrap.test.ts
```

Output:

```text
> test
> vitest run packages/database/src/seed-bootstrap.test.ts

 RUN  v4.1.10 /Users/harry/Documents/甄嬛传大富翁/monopoly-zhenhuan

 ❯ packages/database/src/seed-bootstrap.test.ts (4 tests | 3 failed) 79ms
     × rejects a configured username owned by an ordinary account 21ms
     × rejects a configured username owned by an disabled super-admin 18ms
     × rejects a configured username owned by an super-admin without room creation 18ms

 FAIL  packages/database/src/seed-bootstrap.test.ts > bootstrap administrator seed behavior > rejects a configured username owned by an ordinary account
 FAIL  packages/database/src/seed-bootstrap.test.ts > bootstrap administrator seed behavior > rejects a configured username owned by an disabled super-admin
 FAIL  packages/database/src/seed-bootstrap.test.ts > bootstrap administrator seed behavior > rejects a configured username owned by an super-admin without room creation
AssertionError: promise resolved "{ properties: 26, characters: 5, …(1) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "bootstrapAdmin": true,
+   "characters": 5,
+   "properties": 26,
  }

 Test Files  1 failed (1)
      Tests  3 failed | 1 passed (4)
```

### TDD GREEN: bootstrap conflict contract

Command:

```text
npm run test -- packages/database/src/seed-bootstrap.test.ts
```

Output:

```text
> test
> vitest run packages/database/src/seed-bootstrap.test.ts

 RUN  v4.1.10 /Users/harry/Documents/甄嬛传大富翁/monopoly-zhenhuan

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  153ms (transform 18ms, setup 0ms, import 27ms, tests 75ms, environment 0ms)
```

### Database contract GREEN

Command:

```text
npm run test -- packages/database/src/database-contract.test.ts
```

Output:

```text
> test
> vitest run packages/database/src/database-contract.test.ts

 RUN  v4.1.10 /Users/harry/Documents/甄嬛传大富翁/monopoly-zhenhuan

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  85ms (transform 12ms, setup 0ms, import 18ms, tests 5ms, environment 0ms)
```

### Prisma generation GREEN

Command:

```text
npm run db:generate
```

Output:

```text
> db:generate
> prisma generate --schema packages/database/prisma/schema.prisma

Prisma schema loaded from packages/database/prisma/schema.prisma

✔ Generated Prisma Client (v6.19.0) to ./node_modules/@prisma/client in 88ms
```

### Initial populated migration attempt: sandbox blocked (superseded)

Before the suite was aligned with the repository's `TEST_DATABASE_URL` opt-in convention, the initial sandboxed connection attempt used this command:

```text
npm run test -- packages/database/src/migration-v21.integration.test.ts
```

Current output:

```text
> test
> vitest run packages/database/src/migration-v21.integration.test.ts

 RUN  v4.1.10 /Users/harry/Documents/甄嬛传大富翁/monopoly-zhenhuan

 ❯ packages/database/src/migration-v21.integration.test.ts (1 test | 1 failed) 300ms
     × preserves legacy identities and history while replacing device role control 299ms

 FAIL  packages/database/src/migration-v21.integration.test.ts > V2.1 populated legacy migration > preserves legacy identities and history while replacing device role control
Error: Error: P1001

Can't reach database server at `127.0.0.1:55432`

Please make sure your database server is running at `127.0.0.1:55432`.

 ❯ executeSql packages/database/src/migration-v21.integration.test.ts:32:11
 ❯ packages/database/src/migration-v21.integration.test.ts:134:7

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Duration  380ms (transform 12ms, setup 0ms, import 26ms, tests 300ms, environment 0ms)
```

This initial P1001 result is superseded by the successful opt-in PostgreSQL executions recorded below. The test never reads from, migrates, truncates, or drops the existing `public` schema; it uses a randomized schema and scoped teardown.

### Focused lint GREEN

Command:

```text
npx eslint packages/database/src/seed.ts packages/database/src/seed-bootstrap.test.ts packages/database/src/migration-v21.integration.test.ts --max-warnings=0
```

Output: exit 0 with no diagnostics.

## Populated migration review cycle

The first PostgreSQL execution reached migration 006 and exposed a real ordering defect. The migration attempted to set the populated legacy member's `deviceTokenHash` to `NULL` while the initial schema's `NOT NULL` constraint was still active. PostgreSQL rejected this representative row before migration 007 could run:

```text
(legacy-player-member, legacy-room, PLAYER, null, Legacy Player, null, OFFLINE, ... accountId ..., LEFT, ...)
```

The fix moves this statement ahead of the invalidating update:

```sql
ALTER TABLE "RoomMember" ALTER COLUMN "deviceTokenHash" DROP NOT NULL;
```

### Source-order regression RED

Command:

```text
npm run test -- packages/database/src/database-contract.test.ts
```

Output:

```text
> test
> vitest run packages/database/src/database-contract.test.ts

 RUN  v4.1.10 /Users/harry/Documents/甄嬛传大富翁/monopoly-zhenhuan

 ❯ packages/database/src/database-contract.test.ts (11 tests | 1 failed) 6ms
     × relaxes legacy device token nullability before invalidating device control 1ms

 FAIL  packages/database/src/database-contract.test.ts > database delivery contract > relaxes legacy device token nullability before invalidating device control
AssertionError: expected 3301 to be greater than 3557

 Test Files  1 failed (1)
      Tests  1 failed | 10 passed (11)
   Duration  76ms (transform 11ms, setup 0ms, import 16ms, tests 6ms, environment 0ms)
```

### Source-order regression GREEN

Command:

```text
npm run test -- packages/database/src/database-contract.test.ts
```

Output:

```text
> test
> vitest run packages/database/src/database-contract.test.ts

 RUN  v4.1.10 /Users/harry/Documents/甄嬛传大富翁/monopoly-zhenhuan

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  74ms (transform 11ms, setup 0ms, import 16ms, tests 5ms, environment 0ms)
```

### PostgreSQL populated migration GREEN

The suite follows the repository integration convention: it is skipped when `TEST_DATABASE_URL` is absent, rejects non-PostgreSQL URLs and database names not ending in `_test`, and creates/drops only a randomized schema. Exact opt-in command:

```text
TEST_DATABASE_URL='postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public' npm run test -- packages/database/src/migration-v21.integration.test.ts
```

Output:

```text
> test
> vitest run packages/database/src/migration-v21.integration.test.ts

 RUN  v4.1.10 /Users/harry/Documents/甄嬛传大富翁/monopoly-zhenhuan

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  3.57s (transform 14ms, setup 0ms, import 28ms, tests 3.49s, environment 0ms)
```

Without `TEST_DATABASE_URL`, the same test reports one skipped test and performs no database operation. The controller independently reran the opt-in command and reported 1/1 passed in 3.84s.

### Final focused checks

```text
npm run test -- packages/database/src/seed-bootstrap.test.ts
Test Files  1 passed (1)
Tests       4 passed (4)

npm run db:generate
Generated Prisma Client v6.19.0 successfully.

npx eslint packages/database/src/seed.ts packages/database/src/seed-bootstrap.test.ts packages/database/src/migration-v21.integration.test.ts packages/database/src/database-contract.test.ts --max-warnings=0
Exit 0 with no diagnostics.
```
