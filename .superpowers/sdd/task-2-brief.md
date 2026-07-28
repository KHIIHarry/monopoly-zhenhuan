# Task 2: Passwords, Cookie sessions, and the two-device limit

## Product requirements

- Accounts are created only by super administrators; no registration, guest login, or self-service password recovery.
- Login accepts only username and password. Device metadata is derived server-side from the request; users do not type a device name.
- Passwords use the repository's scrypt format with random salt and timing-safe verification.
- The login cookie lasts 30 days and is `HttpOnly`, `Secure`, and `SameSite=Lax`. Only a random token is sent to the client; only its hash is stored.
- Authentication checks account ACTIVE status, session expiry, and revocation on every request.
- One account may have at most two active Sessions. A third normal login creates no Session and returns safe summaries of the two active devices.
- `replaceOldestSession` re-verifies the password and, in one Serializable transaction, revokes the oldest active Session, creates the replacement Session, updates login state, and writes a security log.
- Password reset and account disable revoke every Session. Revoked devices fail on their next request.
- Users may list devices, revoke a named Session, log out other Sessions, and log out the current Session.
- IPs returned by profile/device endpoints are masked by default.
- No response may expose `passwordHash`, `sessionTokenHash`, or raw server token values except the one new token conveyed via the HttpOnly cookie.

## Public API

- `POST /api/auth/login`
- `POST /api/auth/login/replace-oldest-session`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/sessions`
- `DELETE /api/auth/sessions/:id`
- `POST /api/auth/sessions/logout-others`

## Files in scope

- `apps/api/src/auth-domain.ts`
- `apps/api/src/auth-domain.test.ts`
- `apps/api/src/account-room-service.ts`
- `apps/api/src/account-room-service.integration.test.ts`
- `apps/api/src/server.ts`
- `apps/api/src/api-error.ts`

Keep room/seat/swap/settlement behavior for later tasks except for compilation-preserving compatibility changes that are strictly required by the V2.1 schema.

## Acceptance tests

- Password round-trip and tamper rejection.
- Cookie attributes and 30-day lifetime.
- First and second device logins succeed; third returns `SESSION_LIMIT_REACHED` with two sanitized summaries and creates nothing.
- Replacement revokes the oldest active Session and creates one new Session atomically.
- Revoked, expired, disabled-account, and password-reset Sessions authenticate as invalid.
- `/auth/me` and Session responses never contain password or token hashes.
- Session list masks IP addresses and marks the current device.
- Logout, named revoke, and logout-others behave correctly.

## Test environment

Use `TEST_DATABASE_URL=postgresql://zhenhuan_test_runner:zhenhuan_test_runner@127.0.0.1:55432/zhenhuan_test?schema=public` for PostgreSQL integration tests. Tests must be opt-in when the variable is absent and must not destroy immutable settlement history or unrelated schemas.

