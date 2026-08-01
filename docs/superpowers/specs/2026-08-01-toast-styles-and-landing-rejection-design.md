# Toast Styles and Landing Rejection Design

## Goal

Polish realtime Toasts with the approved responsive green/red presentation and notify the declaring player when the bank cancels a pending landing's property actions.

## Confirmed Visual Design

- Success and fund Toasts use the existing pale-green background and dark-green text, a `1px` dark-jade border, and an `8px` radius.
- Rejection Toasts use a pale-red background, dark-red text, a `1px` dark-red border, and the same radius and shadow.
- Every queued Toast enters with a `260ms ease-out` animation from `12px` above while fading from transparent to opaque.
- The Toast DOM is keyed by event ID so every FIFO item replays the entry animation.
- Desktop Toasts remain top-right and expand to at most `680px`, with one-line text for normal messages.
- Mobile Toasts remain top-center, use nearly the full viewport width, `12px` text, a `13px` icon, compact gaps and padding, and keep normal messages on one line.
- `prefers-reduced-motion: reduce` disables the entry animation.
- Toasts remain passive, focus-free, and visible for exactly 3 seconds through the existing queue.

## Notification Semantics

The bank's existing "取消地产操作" action is the product's landing rejection action. A freshly committed cancellation sends only the declaring player's active Session a red Toast:

`你的落点申请已被银行拒绝：<银行填写的原因>`

The landing is a `LandingEvent`, not a `GameRequest`, so this path needs a dedicated persisted-data builder and post-commit notifier callback. It must not be forced through the `GameRequest` rejection builder.

The event uses the existing `REQUEST_REJECTED` wire kind, `PLAYER` audience, the landing room ID, and a stable ID derived from landing and player IDs. The client maps `REQUEST_REJECTED` to the red tone; all other realtime and local Toasts default to green.

## Data Flow

1. Bank submits the existing landing cancellation endpoint with a non-empty reason and idempotency key.
2. `cancelLandingPropertyActions` commits the landing flag, linked request cancellation, audit record, state version, and idempotency record.
3. Only a fresh commit invokes `landingRejected(roomId, landingId, reason)` after the transaction resolves.
4. The notifier reloads the landing, verifies `propertyActionsCancelled`, resolves `player.member.activeSessionId`, builds the player-only event, and emits `room.toast` to that Session channel.
5. The client validates room and audience, maps the event kind to the rejected tone, and enqueues it in the existing FIFO queue.

Notification failures remain best-effort after commit and cannot roll back the landing decision. Replaying the same idempotency key does not invoke the notifier again.

## Testing

- Builder unit coverage for exact player Session targeting, message, stable ID, inactive Session, and non-cancelled landing.
- PostgreSQL integration coverage proving one callback after the first cancellation and none after idempotent replay.
- Socket coverage proving the new callback emits to the declaring player's Session channel.
- Queue and render contract coverage proving rejected tone preservation, keyed nodes, correct icon, and event-kind mapping.
- Static style coverage for both color variants, radius, animation, desktop width, mobile single-line sizing, passive input, and reduced motion.
- Docker-backed Playwright coverage for landing cancellation delivery and responsive Toast computed styles.

## Scope Boundaries

- Do not change the landing database state model or add a new endpoint.
- Do not notify unrelated players or the bank about its own rejection action.
- Do not change the 3-second queue timing, ledger behavior, approval behavior, or existing fund wording.
- Preserve and isolate all pre-existing uncommitted edits in shared frontend files.

