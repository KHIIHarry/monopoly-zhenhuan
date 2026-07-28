# Task 8: Delivery documentation, secure runtime, full verification, and browser acceptance

## Product authority and prerequisites

Read `/Users/harry/Documents/甄嬛传大富翁/甄嬛传大富翁_新版账号房间开发文档.md`, the corrected objective, `.superpowers/sdd/task-8-preflight.md`, and approved Task 1-7 reports. V2.1 is the sole product authority; wealth is additive. Do not start this task until Tasks 1-7 have clean task reviews.

## Deliverables

Update or create:

- `README.md`
- `.env.example`
- `docker-compose.yml`
- `MIGRATION_NOTES_V2.md`
- `KNOWN_LIMITATIONS.md`
- a current V2 API reference under `docs/`
- a current testing/acceptance guide under `docs/` if README would otherwise become unwieldy
- any narrowly scoped runtime/CORS/startup configuration or scripts required for the documented deployment to be true

The documentation must include:

- prerequisites and exact local startup commands;
- database migration and five-character/26-property seed commands;
- one-time bootstrap super-admin initialization using operator-generated secrets, verification of the created Account, and removal of bootstrap values afterward;
- secure Cookie behavior, trusted origins, proxy/HTTPS requirements, and why plain HTTP LAN/mobile access is unsupported when `Secure` Cookies are required;
- login and two-device replacement behavior;
- room list/password/create permission, independent character/bank capabilities, shared room controller, swap workflow, game writes, settlement, admin APIs, and notification-only WebSocket events;
- `Idempotency-Key` requirements and stable public errors;
- backup, restore rehearsal, forward-only migration order, legacy data cleanup, and rollback limitations;
- exact test prerequisites and commands;
- additive settlement formula, tie-breaks, bank-only exclusion, and dual-member single inclusion;
- only limitations that genuinely remain after Tasks 1-7.

Do not publish a usable default password/token. `.env.example` uses placeholders and explains how to generate secrets. Credentialed CORS is restricted to explicitly configured trusted origins in production; never reflect arbitrary origins with credentials.

`docker-compose.yml` must either provide a coherent deployable topology or be clearly labeled and configured as development-only. Documentation and actual ports/health checks/environment variables must agree.

## Legacy-surface removal gate

Search production source, built artifacts, tests, docs, and browser-visible copy for the removed model:

- homepage player/bank/super-admin identity switch;
- direct room-code entry;
- per-entry nickname;
- bank authorization code and super-admin token;
- restore-identity button;
- guest/self-registration/self-service password recovery;
- spectator/read-only mode;
- role recovery from localStorage;
- exclusive membership `role` DTOs;
- Bearer/device-token game authentication;
- deleted join/reconnect game service APIs or stale deployable output.

Do not delete legitimate localStorage used only for non-identity UI convenience unless it violates current behavior. The final report must list every legacy hit and its adjudication; production/deployable legacy hits block completion.

## Fresh verification

Start from a clean generated/build state and a real PostgreSQL test database. Record command, exit code, counts, duration, and prerequisites for:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

Also run the dedicated migrated PostgreSQL API suites if the root `npm run test` intentionally skips them. Apply every migration in randomized schemas and drop only those schemas. Never truncate guarded immutable history or weaken triggers.

After a clean build, assert deployable output contains no deleted legacy module/API and starts successfully using the documented command.

## Real browser acceptance

Use the `browser:control-in-app-browser` skill. Start the real API and H5 with PostgreSQL; provide the local URL. Test with Cookie authentication against the live API, not route mocks, at desktop and mobile viewports.

Cover at minimum:

1. bootstrap/admin-created Account login;
2. first and second device Sessions, third-device block, replace-oldest, and revoked-device failure;
3. room creation permission, optional password failure/success, and already-joined recovery;
4. character then bank and bank then character capability acquisition, with one membership/controller/Player/assets set;
5. explicit PLAYER/BANK workbench switching for a dual member;
6. second-device room takeover with no spectator/read-only fallback;
7. occupied role display plus request/accept/reject/cancel/pending-bank/bank-approve swap states;
8. normal bank settlement preview, exact `确认结束游戏`, immutable settlement read, and post-finish write rejection;
9. super-admin accounts/devices/rooms/logs/dashboard workflows;
10. WebSocket notification followed by REST refetch and reconnect refetch;
11. absence of every legacy identity entry point and message.

Capture desktop and mobile screenshots for the main lobby, seats, player workbench, bank workbench, settlement, and admin surfaces. Inspect them for overlap, clipping, unreadable text, unreachable controls, horizontal overflow, loading/error/empty states, and responsive navigation. Any incoherent overlap or blocked common workflow is a defect to fix and rerun, not a documented limitation.

## Final review and report

Write `.superpowers/sdd/task-8-report.md` with:

- changed documentation/runtime files;
- migration/seed/bootstrap evidence;
- all verification commands/results;
- real browser scenarios and screenshot paths;
- legacy scan results;
- exact startup URL/steps;
- remaining limitations;
- self-review against all corrected objective deliverables.

After the Task 8 review is clean, dispatch one broad final code/product review over the whole workspace. Fix every Critical/Important finding in one fix pass and re-review. Only then may the active goal be marked complete.
