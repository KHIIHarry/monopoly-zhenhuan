# Task 8 delivery preflight

Read-only audit performed against the V2.1 product authority and corrected goal objective.

## Critical gates

- Replace the obsolete README rather than retaining legacy device-token, room-code, exclusive-role, localStorage identity, bearer, or MVP compatibility instructions.
- Document and verify an HTTPS path for mobile/LAN use because authenticated Cookies are always `Secure`. Do not claim plain HTTP LAN support.
- Restrict credentialed CORS to configured trusted origins for production; never reflect arbitrary origins with credentials.
- Run real Cookie-backed browser acceptance against the API and PostgreSQL on desktop and mobile. Mock-only Playwright coverage is not final acceptance.

## Important gates

- Publish a current API reference for auth, devices, room lobby/passwords/seats, capability selection, takeover, swaps, game writes, settlement, admin surfaces, Cookie use, idempotency, events, and stable errors.
- `.env.example` must not provide a usable known bootstrap password. Document an operator-generated one-time secret and removal of bootstrap values after initialization.
- Clearly label the current source-mounted `docker-compose.yml` as development-only or add a production deployment path.
- Link `MIGRATION_NOTES_V2.md`, document backup plus restore rehearsal, and state irreversible migration/status consequences before production rollout.
- Replace old test claims with exact prerequisites, commands, and fresh V2 results.
- State the additive V2.1 wealth formula and bank-only/dual ranking behavior correctly.
- Rewrite `KNOWN_LIMITATIONS.md` to contain only limitations that remain after Tasks 1-7.

## Final browser acceptance

- Real login, two-device replacement/revocation, room-password join, both dual-capability acquisition orders, takeover, swaps, finish, immutable settlement read, and post-finish rejection.
- Desktop and mobile viewports with no overlap or clipped controls.
- No spectator/read-only mode and no legacy identity entry points, copy, headers, storage, or APIs.
- WebSocket notification followed by REST refetch and reconnect refetch behavior.

## Final command evidence

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run test:e2e`

Record exit codes, pass counts, environment prerequisites, and any remaining limitations. Do not check off delivery tasks before fresh evidence exists.
