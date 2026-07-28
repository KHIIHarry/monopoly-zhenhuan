# Task 7 H5 migration preflight review

Date: 2026-07-27  
Mode: read-only product/UI audit; no production code, tests, or server state changed  
Authority: `../甄嬛传大富翁_新版账号房间开发文档.md` V2.1

## Readiness verdict

**NOT READY for Task 7 implementation as a UI-only change.** The current H5 cannot complete the corrected account/room flow against the existing API. Five P0 issues must be resolved in the implementation plan before browser acceptance can pass:

1. Login sends an extra `deviceName` field that the strict API schema rejects.
2. The client still models one exclusive `role` plus a token, while the API returns one membership with independent `characterId` and `isBank` capabilities.
3. Role swaps have mutation routes but no read model/list route, so target, requester, and bank decision screens cannot be built.
4. The bank still calls the removed `/end` workflow and has no preview, exact confirmation, finish, or immediate settlement transition.
5. The client does not subscribe to session/control/room events, so revoked sessions and control takeover are not reflected immediately.

Task 7 can begin after the API dependencies in this review are assigned and the client state model is amended. It is not acceptable to preserve `role`, synthesize a second membership/session, add a spectator fallback, or use a local token as a bridge.

## Corrected client model

The client must treat the following as separate concepts:

- Authentication: Cookie only; no token in React state, localStorage, request headers, or recovery copy.
- Membership: exactly one active membership per account/room.
- Capabilities: `characterId !== null` enables player operations; `isBank === true` enables bank operations. They are independent and may both be true.
- Workbench view: transient explicit `PLAYER | BANK` selection. It changes only `GET /snapshot?view=...` and rendered controls.
- Room control: the membership's single `activeSessionId`, represented publicly by `activeHere`. Both capabilities share it.

Recommended client context:

```ts
type RoomMembershipView = {
  id: string;
  characterId: string | null;
  playerId: string | null;
  isBank: boolean;
  activeHere: boolean;
};

type WorkbenchContext = {
  roomId: string;
  membership: RoomMembershipView;
  view: 'PLAYER' | 'BANK';
};
```

Do not retain `Session.token`, `Session.role`, `membership.role`, `myRole`, legacy identity error strings, or any spectator/read-only branch.

## Prioritized amendments

### P0 - contract and workflow blockers

#### P0.1 Make login match the strict Cookie API

Evidence:

- `apps/web/app/page.tsx:349` stores `deviceName`; lines 379 and 392 send it for normal and replacement login; line 509 renders it.
- `apps/api/src/auth-domain.ts:13-16` accepts exactly `username` and `password` via a strict Zod object.
- `tests/e2e/workbench.spec.ts:44-54` already requires two inputs only.

Amendment:

- Remove `deviceName` from state, UI, and both login request bodies.
- Keep `credentials: 'include'` on every request.
- Assert the login and replacement bodies equal, rather than merely contain, `{ username, password }`.
- Remove legacy error copy for admin tokens, bank authorization codes, invalid device tokens, room-code re-entry, and identity recovery (`page.tsx:165-182`, fallback at 245).

#### P0.2 Replace exclusive role/token state with capability plus explicit view

Evidence:

- `page.tsx:115-120`, 326-332 define obsolete `Session.role`, token, `RoomSummary.myRole`, and `membership.role` contracts.
- `page.tsx:421-431` gates takeover/recovery on the nonexistent `membership.role`, then requests `/snapshot` without a view.
- The actual seats DTO at `account-room-service.ts:527-540` returns `characterId`, `isBank`, `playerId`, and `activeHere`, with no role.
- `prisma-game-service.ts:53-60` requires an explicit view for a dual member.
- `page.tsx:283-299`, 691, 793, 809, and 1064 still add `Authorization: Bearer`.

Amendment:

- Align `RoomSummary` to the actual DTO: `memberCount`, `playerCount`, `playerLimit`, `characterId`, `myCharacter`, and `isBank`.
- Align `SeatSnapshot.membership` exactly to the seats DTO; do not add a derived exclusive role.
- Route from a fresh seats snapshot in this order:
  1. `FINISHED` -> settlement.
  2. Any membership with `activeHere === false` -> takeover screen, including a membership that has not chosen a seat yet.
  3. Both capabilities -> explicit player/bank workbench selector.
  4. Player only -> `view=PLAYER`.
  5. Bank only -> `view=BANK`.
  6. Neither capability -> seat selection.
- Always request `/api/rooms/:id/snapshot?view=PLAYER|BANK`; never rely on server inference.
- Switching workbenches only changes `view` and refetches the snapshot. It must not call join, select-character, select-bank, login, or take-control.
- Delete all Authorization headers and token parameters while retaining idempotency keys on writes.
- Add a visible route from either workbench back to seat/capability management so a player can add bank and a bank-only member can add a first character.

#### P0.3 Add a readable role-swap inbox/outbox contract

Evidence:

- `server.ts:135-139` exposes request/accept/reject/approve-bank/cancel mutations only.
- `account-room-service.ts:139-164` returns IDs and status but not the display data needed by decision UI.
- `page.tsx:448-453` can only create a request; no current component can display or resolve one.

API dependency:

- Add `GET /api/rooms/:id/role-swap-requests` or include a `roleSwapRequests` collection in the seats snapshot.
- Return public, decision-ready rows: request ID/status, requester and target membership IDs, display-name snapshots, current/requested character IDs and names, timestamps, rejection reason, and booleans such as `canAccept`, `canReject`, `canCancel`, and `canApproveBank` computed for the authenticated membership.
- Do not make the browser reconstruct authorization from account names. The same account may be both a player participant and bank approver, and those are distinct actions.

UI amendment:

- Add requester outbox, target inbox, and bank pending-confirmation views.
- Render all states: `PENDING_TARGET`, `PENDING_BANK`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`, and `CONFLICTED`.
- Require a rejection reason because the current API schema does.
- Refetch seats and swap rows after every action and every swap event.

#### P0.4 Replace legacy room end with settlement preview and finish

Evidence:

- `page.tsx:1172-1181` maps end to `POST /api/rooms/:id/end` with a reason.
- The supported flow is `POST /settlement/preview`, exact text confirmation to `POST /finish`, then `GET /settlement` (`server.ts:141-143`).
- The current settlement DTO/UI omits `propertyDetailsJson`, so it cannot show each property's value and building details.

Amendment:

- The bank action first loads a preview and visibly lists blockers and ranked player totals.
- Disable finish while blockers exist; provide direct navigation to pending approval/swap/turn work where possible.
- Require the exact phrase `确认结束游戏`; send `{ confirmation: '确认结束游戏' }` plus an idempotency key.
- On success, fetch/render the immutable settlement immediately; do not show only a toast.
- Extend the settlement UI to display each property's land value, mortgage state/net value, building count, and building sell value from the immutable property details.
- Preserve the rule that bank-only members are absent and dual members appear exactly once.

#### P0.5 Wire Cookie-authenticated realtime invalidation

Evidence:

- The web package already includes `socket.io-client`, but `page.tsx` has no socket lifecycle.
- `server.ts:174-185` authenticates the socket by Cookie, joins a session room, and supports `room.subscribe`.

Amendment:

- Connect with credentials and subscribe to the active room; never send a token in socket auth/payload.
- Treat events only as invalidation. On `room.snapshot-required`, seat/role events, or `room.finished`, refetch the authoritative REST resource.
- On `role.swap.*`, refetch both seats and swap rows.
- On `room.control.changed`, refetch seats; an old controller must transition to “已被其他设备接管”, with only takeover and room-list actions.
- On `account.session.revoked`, clear client account/room state and show login immediately.
- Reconnect by re-authenticating the Cookie, resubscribing, and refetching; never restore a token or spectator state.

### P1 - required product workflows

#### P1.1 Room lobby and seat management

- Room cards must display unique `memberCount`, `playerCount/playerLimit`, password state, localized room status, and the current member's character/bank/dual state. Current cards show only `playerCount/5` and character (`page.tsx:535-540`).
- Preserve seat capability on acquisition: selecting character must not clear bank; selecting bank must not clear character.
- If the member already has a character, label the free bank action `兼任银行`; if bank-only, keep `选择角色` available.
- Do not offer “申请交换” for the member's own character. This is derivable from `membership.characterId`; no display-name comparison is allowed.
- Honor server `canSelect` and handle `ROLE_ALREADY_TAKEN`, `BANK_ALREADY_TAKEN`, and `ACCOUNT_CHARACTER_LIMIT_REACHED` with refresh and room-list actions.
- Always fetch seats on entry, manual refresh, capability acquisition, and relevant socket invalidation.

#### P1.2 Full room creation settings

`page.tsx:548-550` exposes only name, password, initial funds, and dice mode, then silently hardcodes the other settings. Add controls for:

- Character skills.
- Start reward.
- Mid-game join.
- Public/private visibility.
- Player-transfer approval.
- Automatic skipping of stopped players.

Show a review/confirmation step or an equivalent scannable summary before creation; retain one idempotency key per intent.

#### P1.3 Device profile

- Show username, display name, create-room permission, recent login, and both login/last-active times.
- `GET /api/auth/me` currently omits account `lastLoginAt`; add it to the account DTO or define “recent login” from a documented session field.
- Confirm destructive device logout actions. If the current device is revoked through another session/event, redirect to login immediately.
- Verify `DELETE /sessions/:id` and logout-others affect only the expected sessions and never create a replacement identity path.

#### P1.4 Admin surface and API ownership

The current UI only creates accounts and shows four totals (`page.tsx:561-564`). Task 7 and the authority also require edit, disable/enable, reset password, independent super-admin/create-room permissions, device inspection/revocation, room management, force finish with reason, and audit visibility.

Existing usable API: account list/create/patch/reset/disable/enable and the partial dashboard.

Missing API dependencies that must be assigned outside the H5 file:

- Admin list/revoke sessions for a selected account. Current session routes only operate on the authenticated account (`account-room-service.ts:346-360`).
- Admin room list/detail, configuration edit, password reset, member removal, bank reassignment, and logs.
- Security/audit log query endpoint.
- Dashboard character-selection counts, character-win counts, and recent-game DTO suitable for display. Current dashboard returns counts, average duration, and raw recent settlements only (`account-room-service.ts:833-841`).

Do not imply these operations exist by rendering nonfunctional controls.

### P2 - accessibility and responsive hardening

- Dialogs (`page.tsx:1595-1619`) need initial focus, Tab containment, Escape close where safe, focus restoration, and background inertness. Avoid duplicate static IDs when an action sheet and confirmation dialog can coexist.
- View/workbench selectors should be a labeled segmented control with `aria-pressed` or tabs with correct tab semantics; selected state cannot be color-only.
- Async route changes need a focus target (normally the new `h1`) and loading/status announcements. Banner errors need `role="alert"` consistently.
- Confirm dialogs must expose the destructive object and consequence in their accessible description.
- At 200% text zoom, long room/account/device names must wrap without clipping. `seat-card { overflow: hidden }`, unwrapped headers, two-column device rows, and the six-item bank navigation are specific stress points.
- The fixed bottom navigation must not cover content at short heights and must honor `env(safe-area-inset-bottom)` in portrait and landscape. The lobby create button must not cover the last room row.
- Keep all targets at least 44x44 CSS px; validate keyboard focus visibility and touch targets after responsive changes.
- Under `prefers-reduced-motion: reduce`, stop nonessential animation rather than merely slowing the spinner.

## Required E2E amendments

The current suite is mocked, mobile-Chromium-only, and does not exercise the complete contract. Keep focused route mocks for UI states, but update every fixture to the real V2 DTO and add at least the following:

1. **Strict Cookie login:** exact two-field request body for normal and replacement login; no Authorization header on any request; no auth/session token in localStorage/sessionStorage.
2. **Lobby contract:** unique member count and distinct player count; player-only, bank-only, and dual badges; password and history states; create action gated only by `canCreateRoom`.
3. **Acquisition order A:** character -> bank, refetched membership preserves character/player and gains bank.
4. **Acquisition order B:** bank -> first character, refetched membership preserves bank and gains exactly one player identity.
5. **Second character limit:** no direct second-character action for a seated player; API conflict leaves current character/workbench unchanged.
6. **Automatic recovery matrix:** parameterize player-only, bank-only, and dual. Single capability opens its workbench; dual requires explicit view selection; none shows seats.
7. **Dual switching:** snapshot URLs are exactly `view=PLAYER`, `view=BANK`, `view=PLAYER`; no join/select/take-control calls; stable membership/player IDs and asset data across switches.
8. **Takeover:** any inactive membership, including no-seat membership, sees no game/read-only data; takeover POST refetches seats and enters the proper next screen. A `room.control.changed` event moves the old controller to the displaced message.
9. **Occupied/self seats:** occupied marker and nickname, no direct selection, other-member swap action present, own-character swap action absent, and bank CTA says `兼任银行` for a player.
10. **Concurrent seat conflicts:** `ROLE_ALREADY_TAKEN` and `BANK_ALREADY_TAKEN` keep the user out of the game and expose refresh plus room-list actions.
11. **Swap lifecycle:** requester cancel; target accept/reject; playing-game accept -> `PENDING_BANK`; distinct bank approval; dual player/bank account performs target action and bank action as two network requests; approved/rejected/cancelled/conflicted display.
12. **Realtime refetch:** room events cause REST refetch rather than applying event payload as state; reconnect resubscribes/refetches; session revoke returns to login.
13. **Finish:** preview blockers, blocked finish, exact phrase validation, finish request, immediate settlement, bank-only excluded, dual member listed once, tie winners, and immutable property details.
14. **Creation/profile/admin:** all room settings submitted; IP masking and both device timestamps; revoke-one/logout-others; account create/edit/permissions/reset/disable; complete dashboard and force-finish reason once APIs exist.
15. **Legacy absence:** landing/login/lobby/control/workbench must not contain room-code entry, nickname entry, device-name entry, role login switches, bank authorization code, super-admin token, restore-identity copy, guest/register/password-recovery, spectator/read-only copy, or “返回加入页”.

At least one integration-backed browser flow should cover login -> lobby -> join -> acquire dual capabilities -> switch both workbenches -> take control -> finish -> settlement. Pure route mocks cannot prove Cookie persistence, shared `activeSessionId`, or the absence of duplicate database records.

## Exact browser QA matrix

Add these Playwright projects; do not keep `mobile-chromium` as the only project:

| Project | Engine/browser | Viewport | DPR/input | Purpose |
|---|---|---:|---|---|
| `desktop-chromium` | Chromium | 1440x900 | 1, mouse + keyboard | Primary desktop workflow and keyboard accessibility |
| `desktop-firefox` | Firefox | 1366x768 | 1, mouse + keyboard | Layout/form semantics and Firefox behavior |
| `desktop-webkit` | WebKit | 1440x900 | 1, mouse + keyboard | Desktop Safari-equivalent Cookie/modal behavior |
| `android-chromium` | Chromium mobile | 360x800 | 3, touch | Narrow Android Chrome, wrapping and touch targets |
| `iphone-webkit` | WebKit mobile | 390x844 | 3, touch | Primary iPhone Safari, safe-area and keyboard behavior |
| `short-mobile-webkit` | WebKit mobile | 375x667 | 2, touch | Short viewport, modal/bottom-nav overlap and scrolling |

For every project, assert `document.documentElement.scrollWidth <= window.innerWidth`, no fixed-control/content overlap, and no clipped localized text on landing, login, lobby with long names, occupied seats, takeover, profile with two devices, player workbench, bank workbench, swap decisions, finish preview, settlement, and admin screens. Capture failure screenshots and retain traces.

Run the full corrected-role workflow on `desktop-chromium`, `android-chromium`, and `iphone-webkit`; run the complete visual/accessibility smoke set on all six projects. Add keyboard-only traversal and 200% text zoom checks to all desktop projects. Add portrait plus landscape spot checks for bank navigation, action sheets, and finish confirmation on both mobile engines.

## Exit gates for Task 7

Task 7 is ready for acceptance only when all of the following are true:

- The TypeScript client contains no membership/session `role` field and no token/Bearer auth path.
- Every dual snapshot request carries an explicit view and both workbenches share one membership/control session.
- Player-only, bank-only, dual, unseated, inactive-control, and finished memberships each route deterministically from a fresh seats snapshot.
- Swap read DTO and all decision states are implemented.
- Finish preview, exact confirmation, settlement details, and realtime invalidation work end to end.
- No spectator, legacy identity, room-code login, token recovery, or “恢复身份” surface remains.
- The six-project QA matrix passes without horizontal overflow, clipped text, inaccessible dialogs, or fixed-navigation overlap.

