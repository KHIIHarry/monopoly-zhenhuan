# Task 2 Report: Passwords, Cookie Sessions, and Two-Device Authentication

## Status

GREEN for Task 2. After review fixes, the final PostgreSQL integration suite passes 9/9 against the dedicated test database and the auth-domain suite passes 6/6. Focused ESLint and compilation of the auth domain/service pass; the nearest project typecheck remains blocked only by known out-of-scope V2.1 migration errors in `prisma-game-service.ts` (and the full workspace also has duplicate generated `.next` declarations).

No `.git` metadata was present, so no commit was attempted.

## Implemented Behavior

- Kept the existing random-salt scrypt password format and timing-safe verification, and added encoded-hash tamper coverage.
- Added a strict login input schema that accepts only `username` and `password`; `deviceName` is rejected.
- Derive device name, browser, operating system, and user agent only from request metadata.
- Always issue the 30-day auth cookie with `HttpOnly`, `Secure`, and `SameSite=Lax`; only the random raw token is written to the cookie, while only its SHA-256 hash is stored.
- Rebuilt Account and Session response DTOs from allowlisted fields. `/api/auth/me`, login account responses, Session lists, and third-device summaries cannot inherit `passwordHash`, `sessionTokenHash`, `rawToken`, user-agent, or other database-only fields through object spread.
- Authenticate every request against token hash, revocation, expiry, and current Account `ACTIVE` status. The returned authenticated Account and Session objects are also allowlisted.
- Moved active-Session reading, the two-device decision, Session creation, login-state update, and security log into one retrying Serializable transaction.
- Added an in-transaction Account status/password-hash consistency check so concurrent disable/password-reset operations cannot mint a Session after the outer password verification.
- Re-verifies replacement credentials, then revokes the deterministically oldest active Session, creates its replacement, updates login state, and records the security log in one Serializable transaction.
- Password reset and account disable revoke all Sessions. Named revoke, logout-others, and current logout are account-scoped and take effect on the next authentication.
- Session list and limit summaries mask IPv4/IPv6 addresses and mark the current Session.
- Applied only compilation-preserving V2.1 capability substitutions in touched room sections (`characterId`/`isBank` in place of removed membership `role`/legacy control fields). Task 3 seat semantics and Task 4 game authorization were not implemented.

## TDD Evidence

### RED: Pure Auth Contracts

Command:

```sh
npx vitest run apps/api/src/auth-domain.test.ts apps/api/src/account-room-service.integration.test.ts
```

Observed before DTO/schema implementation:

```text
Test Files  1 failed | 1 skipped (2)
Tests       2 failed | 3 passed | 7 skipped (12)

FAIL auth domain > accepts only username and password as login input
TypeError: Cannot read properties of undefined (reading 'parse')

FAIL auth domain > builds auth response DTOs from allowlisted fields only
TypeError: accountSummary is not a function
```

These RED tests used adversarial Account/Session objects containing `passwordHash`, `sessionTokenHash`, and `rawToken`, and required exact safe key sets.

### RED Attempt: PostgreSQL Integration

Command:

```sh
TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public npx vitest run apps/api/src/account-room-service.integration.test.ts
```

The worker sandbox could not reach localhost, so this did not produce behavioral RED evidence:

```text
PrismaClientInitializationError: Can't reach database server at 127.0.0.1:55432
Test Files  1 failed (1)
Tests       8 skipped (8)
```

The controller had database access. The suite was strengthened with three independent Prisma clients for simultaneous login admission. Final controller verification is recorded below. No claim is made that a database behavioral RED run was observed in this sandbox.

### GREEN: PostgreSQL Integration (Controller)

Command:

```sh
TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public npx vitest run apps/api/src/account-room-service.integration.test.ts
```

Fresh post-hardening controller result:

```text
Test Files  1 passed (1)
Tests       8 passed (8)
Duration    1.08s
```

The real PostgreSQL cases cover:

- first, second, and third sequential login;
- three simultaneous logins through independent Prisma clients, with exactly two `OK`, one `LIMIT`, and exactly two active rows;
- no raw token stored and no hash returned;
- server-derived device metadata and sanitized/masked summaries;
- password re-verification and atomic oldest replacement;
- revoked, expired, disabled-account, and password-reset invalidation;
- safe authenticated Account/Session shapes corresponding to `/auth/me` inputs;
- named revoke, cross-account revoke rejection, logout-others, and current logout.

### GREEN: Local Unit Tests

Command:

```sh
npx vitest run apps/api/src/auth-domain.test.ts apps/api/src/api-error.test.ts apps/api/src/account-room-service.integration.test.ts
```

Result without `TEST_DATABASE_URL`:

```text
Test Files  2 passed | 1 skipped (3)
Tests       14 passed | 8 skipped (22)
```

The integration suite is intentionally opt-in when the variable is absent.

### GREEN: Focused Lint

Command:

```sh
npx eslint apps/api/src/auth-domain.ts apps/api/src/auth-domain.test.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/server.ts apps/api/src/api-error.ts --max-warnings=0
```

Result: exit 0, no warnings or errors (confirmed locally and by the controller).

### Compilation

Focused auth compilation:

```sh
npx tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node apps/api/src/auth-domain.ts apps/api/src/account-room-service.ts apps/api/src/api-error.ts
```

Result: exit 0.

Nearest API project check:

```sh
npx tsc -p apps/api/tsconfig.json --noEmit --pretty false
```

Result: exit 2 only for pre-existing/out-of-scope V2.1 migration errors in `apps/api/src/prisma-game-service.ts`, including removed `deviceTokenHash`, `onlineStatus`, `role`, and `bankControlGrantedAt` fields. There are no diagnostics in `auth-domain.ts`, `account-room-service.ts`, `server.ts`, or `api-error.ts`. The controller also confirmed the full workspace check additionally encounters duplicate generated declarations under `apps/web/.next`.

## Reset Safety

The new integration suite validates that `TEST_DATABASE_URL` is PostgreSQL, targets a database whose name ends in `_test`, and does not resolve to the same host/port/database as `DATABASE_URL`. Each test deletes only Task-2-created lobby Rooms, Accounts whose username starts with `task2-auth-`, and their related SecurityLog rows. It does not truncate any table, touch other schemas, disable triggers, or modify settlement/history immutability controls.

## Security Self-Review

- **Secret leakage:** Account and Session DTO functions enumerate every returned field. The prior `sessionSummary({ ...session })` spread is gone. Authentication selects only required fields and reconstructs safe objects. Unit and PostgreSQL tests serialize results and reject `passwordHash`, `sessionTokenHash`, and `rawToken` keys.
- **Transaction races:** admission uses Serializable isolation with `P2034` retry, performs the active-row read and Session create in one transaction, and rechecks Account status/password hash inside it. The three-client concurrency test proves the two-row limit. Replacement orders by `createdAt` and `id`, and its revoke/create/update/log operations share one transaction.
- **Authorization boundaries:** named Session revocation filters by both Session ID and authenticated Account ID. PostgreSQL coverage proves a Session from another Account cannot be revoked. Logout-others excludes the current Session and is account-scoped.
- **Test realism:** all persistence assertions use Prisma against PostgreSQL, inspect actual Session/security-log rows, and use independent clients for the concurrency boundary. No database mocks are used.

## Changed Files

- `apps/api/src/account-room-service.integration.test.ts` (new)
- `apps/api/src/auth-domain.ts`
- `apps/api/src/auth-domain.test.ts`
- `apps/api/src/account-room-service.ts`
- `apps/api/src/server.ts`
- `.superpowers/sdd/task-2-report.md` (new)

## Remaining Concerns

- The legacy `PrismaGameService` still references V1 membership/device fields. Fixing it belongs to the later game-authorization migration and was deliberately not broadened into Task 2.
- The current web source still contains a device-name login field/payload. The strict API now rejects that obsolete field as required; the frontend task must remove it before browser login works end to end.
- The worker sandbox cannot reach the dedicated localhost PostgreSQL instance. The final database evidence above comes from the controller's fresh run using the exact requested URL.

## Review Fixes

### Findings Addressed

- `AccountRoomService.createRoom` previously returned the complete Prisma Room, which let `POST /api/rooms` serialize `passwordHash`. It now returns a field-by-field creation DTO containing generated identifiers/timestamps, the submitted public room settings, and `hasPassword` only.
- `verifyPassword` previously trusted encoded N/r/p values and decoded lengths, ignored extra segments, accepted noncanonical base64url, and could reject its Promise when `scrypt` threw. It now accepts only the application's exact six-segment format, fixed `16384/8/1` parameters, canonical 16-byte salt, canonical 64-byte derived key, and resolves `false` on every malformed input or crypto error.

### Review RED Evidence

Auth command:

```sh
npm run test -- apps/api/src/auth-domain.test.ts
```

Observed before the verifier fix:

```text
Test Files  1 failed (1)
Tests       1 failed | 5 passed (6)
AssertionError: extra segment: expected true to be false
```

The table also covers missing/extra segments, malformed or padded base64url, altered N/r/p with correctly recomputed hashes, short salt, short/oversized derived keys, noncanonical numeric parameters, and values that previously made Node `scrypt` throw.

PostgreSQL room command:

```sh
TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public npx vitest run apps/api/src/account-room-service.integration.test.ts --testNamePattern 'allowlisted room creation response'
```

Controller RED result:

```text
Test Files  1 failed (1)
Tests       1 failed | 8 skipped (9)
```

The exact-key assertion received the full Prisma Room key set, including `passwordHash`, proving the route leak before the fix.

### Review GREEN Evidence

Fresh controller results after both fixes:

```text
auth-domain focused:       6 passed (6)
room DTO focused:          1 passed (1)
full PostgreSQL suite:     9 passed (9)
focused ESLint:            exit 0
```

Local focused compilation also passed:

```sh
npx tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node apps/api/src/auth-domain.ts apps/api/src/account-room-service.ts apps/api/src/api-error.ts
```

Result: exit 0.

### Review Self-Review

- The room DTO is an allowlist; it neither spreads the Prisma record nor adds `passwordHash: undefined`. Its exact serialized keys are asserted, `hasPassword` is `true`, and the same test confirms the database still stores a scrypt hash.
- Password verification checks segment and encoded lengths before base64 decoding, preventing oversized decoded buffers. It compares parameter strings exactly, confirms canonical decode/re-encode and fixed byte lengths, derives only with application constants, and catches crypto failures.
- The room integration cleanup remains scoped to Task-2-created lobby data. It does not truncate tables or alter settlement/history triggers.
