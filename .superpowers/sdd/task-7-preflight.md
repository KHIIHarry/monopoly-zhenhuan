# Task 7 corrected-role preflight

Read-only audit performed against the V2.1 product authority and corrected goal objective.

## Critical gates

- Replace the client's exclusive `membership.role` / `Session.role` model with one membership exposing nullable `characterId`, optional `playerId`, `isBank`, and shared control state.
- A dual member must explicitly select `PLAYER` or `BANK` snapshot/workbench view. Switching view must not create another Session, membership, Player, balance, or asset set.
- Replace the legacy `/api/rooms/:id/end` call with settlement preview, exact `确认结束游戏` confirmation, finish, and settlement display.

## Important gates

- Automatic recovery must work for player-only, bank-only, and dual members. Lost control goes to takeover, never spectator/read-only.
- The seat flow must remain reachable so a player can add bank and a bank-only member can select a first character. Selecting either capability preserves the other.
- Room and seat cards must show character, bank, and dual states; do not offer self-swap.
- Implement request, accept, reject, cancel, pending-bank, and distinct bank approval views for swaps.
- Remove Bearer/device-token headers and legacy identity error copy. Cookie requests use `credentials: 'include'`.
- Socket events only trigger REST re-fetches; manual refresh must call the snapshot endpoint.
- Replace E2E mocks of the old `role` contract with the real V2 payload and cover mobile plus desktop.

## Required E2E scenarios

- Both capability acquisition orders and preservation of the existing capability.
- Dual workbench switching with one Session, Player, and asset set.
- Occupied seats and all swap decision states.
- Player-only, bank-only, and dual automatic recovery.
- Control takeover with no spectator/read-only path.
- Bank finish/settlement flow.
- Absence of all legacy identity entry points and text.

## Evidence hotspots

- `apps/web/app/page.tsx`: legacy exclusive role state, Bearer headers, incomplete swaps, legacy end route.
- `apps/api/src/account-room-service.ts`: authoritative seats payload already exposes `characterId` and `isBank`.
- `apps/api/src/server.ts`: snapshot contract must accept explicit view for dual members.
- `tests/e2e/workbench.spec.ts`: obsolete role mocks and missing mobile/real-contract coverage.
