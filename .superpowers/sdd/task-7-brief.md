# Task 7: Cookie-authenticated H5 flow, dual workbenches, realtime refetch, and responsive UI

## Product authority and prerequisites

Read first:

- `/Users/harry/Documents/甄嬛传大富翁/甄嬛传大富翁_新版账号房间开发文档.md`
- `.superpowers/sdd/task-7-preflight.md`
- `.superpowers/sdd/task-7-preflight-review.md`
- approved Task 2-6 reports and their final public DTO/route inventories

V2.1 is the approved design and sole product authority. Do not begin until Tasks 4-6 are GREEN and reviewed; this client must consume their actual allowlisted contracts rather than invent compatibility fields.

## Scope and file boundaries

- Refactor `apps/web/app/page.tsx`; it is already over 1,600 lines, so extract only cohesive API/types/realtime/dialog or screen units where that makes the corrected state model testable.
- Modify `apps/web/app/globals.css` and reuse `apps/web/public/assets/character-standees.png` as the domain visual asset.
- Modify `playwright.config.ts`, `tests/e2e/workbench.spec.ts`, and add focused E2E helpers/specs when separation improves clarity.
- Use existing `lucide-react`, `socket.io-client`, React, and Next.js. Do not add a design-system, state-machine, or form dependency unless current tools demonstrably cannot satisfy a tested requirement.

## Binding client model

Authentication is Cookie-only. Delete tokens from React state, props, localStorage/sessionStorage, socket payloads, and headers.

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

There is one membership and one shared room controller. Capabilities are independent: non-null `characterId` enables PLAYER, `isBank=true` enables BANK. Workbench view is transient UI state only.

Delete `Session.token`, `Session.role`, `membership.role`, `myRole`, Bearer/device-token logic, and every exclusive-role branch. Every REST call uses `credentials:'include'`; every write retains one Idempotency-Key per user intent.

After every fresh seats response, route deterministically:

1. `FINISHED` -> settlement read.
2. Any existing membership with `activeHere=false` -> takeover screen, even if unseated.
3. Both capabilities -> explicit PLAYER/BANK selector unless a current valid view is already chosen.
4. Player only -> `GET snapshot?view=PLAYER`.
5. Bank only -> `GET snapshot?view=BANK`.
6. Neither -> seats/capability management.

Always include an explicit `view` query for snapshots. Switching workbench only changes view and refetches; it never joins, selects a role, takes control, creates a Session, or changes assets. Both workbenches provide a route back to capability management.

## RED-first browser contract tests

Before production edits, update route fixtures to exact Task 2-6 DTOs and add Playwright tests that fail for the current client:

- login and replacement send exactly `{ username, password }`; no deviceName or Authorization header exists;
- player-only, bank-only, dual, unseated, displaced-control, and finished recovery routes;
- character -> bank and bank -> character preserve the first capability and one Player id;
- dual switching calls snapshot views PLAYER/BANK/PLAYER without join/select/control calls;
- target/requester/bank swap inbox/outbox actions and every terminal state;
- Cookie socket invalidation/refetch, takeover displacement, Session revocation, and reconnect;
- settlement preview/blockers/exact confirmation/final details;
- complete profile/admin route contracts;
- old identity entry points/copy/storage are absent.

Run each focused test and capture the expected failure before modifying production UI. Pure route mocks remain useful for deterministic states, but add at least one PostgreSQL/API-backed flow before Task 7 review.

## Screens and workflows

### Landing, login, and device replacement

- First screen is the actual poster/join experience, using the existing character standee asset. It is not a marketing page or explanatory hero.
- Login has username/password only. No register, guest, password recovery, identity switch, room code, nickname, bank code, admin token, or device-name input.
- Third-device response renders the two masked device summaries with `退出最早登录设备并继续` and `取消登录`; replacement reuses the exact two-field credentials.

### Lobby, join, create, and recovery

- Render `我参与的游戏`, `可加入房间`, and `历史对局` from server categories. Cards show unique member count, character count/5, password state, localized lifecycle, and player's character/bank/dual state.
- Create button exists only for `canCreateRoom=true`. Creation exposes all supported settings: name, optional password, initial balance, dice mode, character skills, start reward, midgame join, visibility, transfer approval, and auto-skip. Use toggles/checks for binary settings and a menu/segmented control for enumerations; show a scannable confirmation before submit.
- Password join handles wrong-password throttling and already-joined recovery. Never ask for room code or nickname.
- Automatic recovery always starts with seats REST. No “恢复身份” button and no local identity persistence.

### Seats, dual capabilities, and control

- Character cards show actual name, skill, initial palace, occupied marker, occupant display name, and server `canSelect`. Own character never offers self-swap; occupied other characters offer swap.
- Free bank action says `兼任银行` for an existing player and preserves character. A bank-only member may still select a first character. A seated player cannot directly choose a second character.
- Handle `ROLE_ALREADY_TAKEN`, `BANK_ALREADY_TAKEN`, and `ACCOUNT_CHARACTER_LIMIT_REACHED` without entering the game; show refresh and room-list commands.
- Displaced control renders no snapshot/read-only/spectator game data. It offers only take-control and room-list actions. Takeover refetches seats before routing.

### Role swaps

- Consume the actor-relevant Task 4 REST read model; do not derive permission from display names.
- Show requester outbox, target inbox, and bank pending confirmations with names/characters/timestamps and server-derived `canAccept`, `canReject`, `canCancel`, `canApproveBank`.
- Render `PENDING_TARGET`, `PENDING_BANK`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`, and `CONFLICTED`. Reject requires a nonblank reason.
- A dual target/bank performs target decision and bank confirmation as two visibly distinct actions/requests.
- Every action refetches seats/swap state. Conflict displays preserved authoritative state rather than optimistic character reassignment.

### Player and bank workbenches

- Preserve the migrated money/property/dice/turn capabilities and existing validated business copy.
- Dual members get a labeled PLAYER/BANK segmented control with accessible selected state. PLAYER controls never appear in BANK view and vice versa.
- All game writes are Cookie-only, include Player id only where the API requires it, and keep retry keys stable per intent.
- Manual refresh performs REST refetch. Do not apply WebSocket payloads as business state.

### Settlement

- Bank first loads preview. Render discriminated blockers and current ranking; disable normal finish while blockers remain.
- Require exact `确认结束游戏`, submit one idempotent finish request, and immediately fetch the immutable settlement on success.
- Show cash, unmortgaged land, mortgaged net, building sale value, total, rank/winner, and each immutable property detail/input. Bank-only is absent; dual appears once; ties are visible.
- Replace every legacy `/end` call/copy.

### Profile and super-admin

- Profile shows username, display name, create-room permission, authoritative recent login, masked devices, login/last-active timestamps, current marker, revoke-one, and logout-others with confirmation.
- Admin consumes Task 6 for account create/edit/reset/enable/disable, independent admin/create-room permissions, target devices/revocation, all-room detail/config/password/member/bank actions, forced finish reason, logs, and complete dashboard aggregates.
- Do not render a control until its API exists and is covered. Destructive actions identify the target and consequence in confirmation dialogs.

## Realtime invalidation

Connect Socket.IO with Cookie credentials, join the active room through `room.subscribe`, and never send auth tokens.

- `room.snapshot-required`, seats/character/bank/control events -> refetch seats and active snapshot as applicable.
- `role.swap.*` -> refetch seats plus swaps.
- `room.finished`/`settlement.created` -> refetch seats and settlement.
- `room.control.changed` -> refetch seats; displaced controller moves to takeover message.
- `account.session.revoked` -> clear account/room state and show login immediately.
- reconnect -> reauthenticate Cookie, resubscribe, and refetch all authoritative REST state.

Clean up listeners/subscriptions on room/view/account changes. Coalesce bursts so notifications do not create unbounded duplicate fetches.

## Visual, responsive, and accessibility requirements

- Keep the established palace-game character, but use a balanced imperial red, ink, jade, gold-accent, and neutral surface palette rather than a beige/brown or single-hue screen. Use the actual standee image where characters are being chosen/inspected.
- Operational screens stay compact and scannable. No nested cards or card-wrapped page sections. Individual room/seat/device/request rows may be cards with radius at most 8px.
- Use Lucide icons for familiar actions, tooltips/titles for unfamiliar icon buttons, swatches for colors, segmented controls for views, toggles for booleans, and explicit text only for commands.
- Stable grid/control dimensions prevent loading/badges/labels from shifting layout. Text wraps at 200% zoom; no viewport-width font scaling or negative letter spacing.
- Fixed navigation honors safe-area insets and never covers content. All touch targets are at least 44x44 CSS px. Long Chinese account/room/device names and error text cannot clip or overflow.
- Dialogs/action sheets manage initial focus, Tab containment, Escape where safe, focus restoration, inert background, unique labels/descriptions, and destructive consequences. Async screen changes focus the new heading; errors use `role=alert`; loading/status changes are announced.
- `prefers-reduced-motion: reduce` disables nonessential motion.

## Playwright matrix and acceptance

Configure these projects:

```text
desktop-chromium  Chromium 1440x900 DPR1 mouse/keyboard
desktop-firefox   Firefox  1366x768 DPR1 mouse/keyboard
desktop-webkit    WebKit   1440x900 DPR1 mouse/keyboard
android-chromium  Chromium 360x800 DPR3 touch
iphone-webkit     WebKit   390x844 DPR3 touch
short-mobile-webkit WebKit 375x667 DPR2 touch
```

Full corrected flow runs on desktop Chromium, Android Chromium, and iPhone WebKit; all six run visual/accessibility smoke. Assert no horizontal overflow, fixed-control overlap, clipped localized text, or inaccessible common action on landing, login, lobby with long names, seats, takeover, two-device profile, both workbenches, swaps, finish preview, settlement, and admin.

Add desktop keyboard-only and 200% zoom checks plus mobile portrait/landscape checks for bank navigation, sheets, and finish confirmation. Retain failure screenshots/traces and capture clean desktop/mobile screenshots for review.

## Verification and report

Run focused RED/GREEN E2E, web TypeScript/build/lint, the complete corrected E2E matrix, and at least one real API/PostgreSQL Cookie flow. Start the API and H5 and report the usable local URL.

Write `.superpowers/sdd/task-7-report.md` with RED evidence, changed files, exact route/DTO assumptions, legacy scan, command/count results, screenshot paths, browser matrix, accessibility/responsive self-review, and concerns. Return `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED` with a short summary.
