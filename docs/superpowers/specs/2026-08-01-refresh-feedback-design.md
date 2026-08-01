# Refresh Feedback Design

## Scope

All manual refresh buttons provide visible, local feedback:

- Workbench room snapshot refresh.
- Seat management refresh.
- Administrator dashboard refresh.

## Interaction

Each button owns a short-lived refresh state. Clicking it immediately disables
that button and applies an icon animation that completes exactly two rotations
(approximately 800 ms). The rest of the page remains usable.

The underlying request continues normally. Once it succeeds, the existing toast
queue displays one of these messages:

- `房间快照已刷新`
- `席位信息已刷新`
- `后台数据已刷新`

Failed requests retain the existing error handling and do not display a success
toast. A refresh request that completes sooner than the animation remains in
the refreshing visual state until the two rotations complete.

## Implementation Boundaries

The client router supplies per-operation refresh callbacks and success notices.
The Workbench, SeatsView, and AdminView render their own disabled state and
animated refresh icon. The shared stylesheet defines the two-rotation animation.
No API, server, persistence, or toast-queue contract changes are required.

## Verification

Tests cover each refresh button's callback wiring and visual refresh state.
End-to-end coverage verifies the related data request remains made and that a
successful request presents the expected toast message.
