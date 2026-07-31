# H5 Pull-to-Refresh Prevention Design

## Goal

Prevent browser pull-to-refresh when a user drags downward from the top of any H5 page, while preserving normal page scrolling, modal scrolling, form controls, sliders, and drag interactions. The change must not alter application business behavior.

## Current State

- The Next.js root layout renders route content directly into `body`; there is no `#root` element.
- Most non-game pages use `.v2-page` as their page root.
- The game workbench uses `.app-shell`, with `.workbench-scroll` as its vertical content scroller.
- The landing page uses `.landing-page`, and loading/error states use `.center`.
- Action sheets, property lists, and confirmation dialogs have their own nested vertical scrolling.
- No application code reads or writes `window`, `document`, or `body` scroll positions. The two `document.body` references are portal fallback targets, not scroll dependencies.
- Next.js navigation implicitly manages window scrolling, so an internal scrolling model needs an explicit route-change reset.

## Architecture

### Root Scroll Lock

Add a real `<div id="root">` inside the root layout and place all route content inside it. Apply the following fixed root model to `html`, `body`, and `#root`:

- `height: 100%`
- `overflow: hidden`
- `overscroll-behavior: none`

`body` remains a valid React portal host but is no longer a page scroller.

### Main Scroll Containers

Treat the following elements as page-level scroll containers:

- `.v2-page` for login, lobby, room, profile, admin, settlement, and related pages
- `.landing-page` for the public landing page
- `.center` for loading and recovery states
- `.workbench-scroll` for the game workbench

Each main scroll container receives:

- `height: 100%`
- `min-height: 0`
- `overflow-x: hidden`
- `overflow-y: auto`
- `overscroll-behavior-y: contain`
- `-webkit-overflow-scrolling: touch`

The outer `.app-shell` uses `height: 100%` and remains non-scrolling so the workbench navigation keeps its existing fixed layout. Existing `100dvh` or minimum-height rules on page roots are normalized where they would conflict with the fixed root model.

### Legacy iOS Touch Guard

Add one client-side touch guard mounted by the root layout. It installs a `touchmove` listener with `{ passive: false }` and removes all listeners during cleanup.

On `touchstart`, the guard records the initial single-touch coordinates and resolves the active main scroll container. On each `touchmove`, it calls `preventDefault()` only when all conditions are true:

1. The gesture still has exactly one touch.
2. The downward displacement exceeds a small movement threshold.
3. Vertical displacement is greater than horizontal displacement.
4. The active main scroll container is at its top edge.
5. No nested scroll container can still consume the downward movement.
6. The gesture did not start from an exempt interactive target such as an input, textarea, select, content-editable element, slider, or draggable element.
7. The event is cancelable.

The guard never cancels `touchstart`, upward movement, horizontal movement, multi-touch gestures, or ordinary scrolling. `touchend` and `touchcancel` clear gesture state.

For a nested scroll container, downward dragging is allowed while its `scrollTop` is greater than zero. Once both the nested container and main container are at the top and the user continues downward, the guard prevents browser-level overscroll. This preserves modal and property-grid scrolling without allowing the gesture to chain into pull-to-refresh.

### Navigation Scroll Reset

When the pathname changes, reset the newly active main scroll container to `scrollTop = 0` after it is mounted. This preserves the scroll-to-top behavior previously supplied by window-based Next.js navigation and does not affect scrolling within a page.

## Compatibility

- Android Chrome uses `overscroll-behavior` as the primary prevention mechanism.
- Modern iOS Safari uses the same CSS behavior.
- Older iOS Safari and WKWebView variants use the conditional touch guard as a fallback.
- WeChat browsers use the CSS path where supported and the touch guard otherwise.
- Standalone PWA mode uses the same fixed root and internal scroll model without user-agent-specific branches.

No browser sniffing is introduced.

## Behavioral Safety

- Business requests, routing destinations, authentication, realtime updates, game actions, and portal behavior remain unchanged.
- Forms remain focusable and editable, including iOS input behavior.
- Action sheets, property grids, and confirmation dialogs retain independent scrolling.
- Horizontal controls and future sliders or draggable elements are not intercepted by the vertical edge guard.
- The guard is global only as an event observer; cancellation is limited to the exact top-edge downward overscroll case.

## Testing

### Unit and Static Tests

- Assert that the layout contains a real `#root` and mounts the touch guard.
- Assert the required root and main-container CSS declarations.
- Test the touch-decision logic for top/non-top, downward/upward, vertical/horizontal, single/multi-touch, threshold, cancelability, nested scrolling, and exempt interactive targets.
- Verify listener registration uses `{ passive: false }` and cleanup removes matching listeners.
- Verify pathname changes reset only the active main container.

### Browser Tests

- Confirm the document itself never exceeds the viewport vertically.
- Confirm long `.v2-page` content scrolls through the internal container.
- Confirm `.workbench-scroll` remains scrollable and workbench navigation remains fixed.
- Confirm action sheets, property grids, and confirmation dialogs scroll normally.
- Confirm text inputs remain usable and horizontal interactions are not canceled.
- Run the existing desktop Chromium/Firefox/WebKit, Android Chromium, and iPhone/short-mobile WebKit projects.

### Real-Device Acceptance

Because browser chrome pull-to-refresh is not fully represented by Playwright device emulation, perform a final manual check on:

- Android Chrome
- iOS Safari
- WeChat on iOS or Android
- An installed standalone PWA

For each environment, verify that a downward drag at the main container top does not refresh, while normal scrolling and nested interactions remain functional.

## Out of Scope

- Changing page content, game behavior, API calls, or navigation destinations
- Globally disabling all touch movement
- Replacing existing modal or property-picker scrolling
- Adding user-agent detection or platform-specific business branches
