# Reference Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the root landing page visual design with the supplied palace-paper reference on desktop and mobile while retaining the existing join callback.

**Architecture:** Keep `LandingPoster` as the boundary between the presentation layer and `AppRouterClient`. Replace its image-layer children with semantic markup and scoped CSS; the only interactive element remains the existing join button. Remove image components and assets after the new markup no longer references them.

**Tech Stack:** Next.js, React, TypeScript, CSS, Vitest, Playwright.

## Global Constraints

- Preserve `LandingPoster`'s `onJoin: () => void` interface.
- Keep `data-testid="landing-poster"` and `data-testid="landing-join-button"`.
- Support desktop and mobile layouts without horizontal overflow.
- Respect `prefers-reduced-motion`.
- Delete only assets proven to be exclusive to the previous landing page.

---

### Task 1: Define and implement the new landing-page contract

**Files:**

- Create: `apps/web/app/components/landing/landing-poster.test.ts`
- Modify: `apps/web/app/components/landing/landing-poster.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.css.test.ts`

**Interfaces:**

- Consumes: `LandingPoster({ onJoin }: { onJoin: () => void })`.
- Produces: semantic reference-page markup and CSS coverage for decorative elements, button identity, mobile layout, and reduced motion.

- [ ] Write tests that require the two lantern classes, main heading, `data-testid="landing-join-button"`, a `max-width: 600px` media query, and a reduced-motion query.
- [ ] Run `npm test -- apps/web/app/components/landing/landing-poster.test.ts apps/web/app/globals.css.test.ts` and confirm the assertions fail because the reference-page structure does not exist.
- [ ] Replace the old image-layer imports with semantic reference-page markup; wire the existing `onJoin` directly to the button.
- [ ] Replace the existing landing poster CSS with scoped responsive reference-page CSS, avoiding asset URLs.
- [ ] Re-run the two tests and confirm they pass.

### Task 2: Remove superseded illustration layers

**Files:**

- Delete: `apps/web/app/components/landing/poster-background.tsx`
- Delete: `apps/web/app/components/landing/poster-characters.tsx`
- Delete: `apps/web/app/components/landing/poster-decorations.tsx`
- Delete: `apps/web/app/components/landing/poster-frame.tsx`
- Delete: `apps/web/app/components/landing/poster-join-button.tsx`
- Delete: `apps/web/app/components/landing/poster-title.tsx`
- Delete: `apps/web/public/assets/landing/background-texture.png`
- Delete: `apps/web/public/assets/landing/characters.png`
- Delete: `apps/web/public/assets/landing/foreground-flora.png`
- Delete: `apps/web/public/assets/landing/game-subtitle.png`
- Delete: `apps/web/public/assets/landing/game-title.png`
- Delete: `apps/web/public/assets/landing/gold-frame.png`
- Delete: `apps/web/public/assets/landing/join-button.png`
- Delete: `apps/web/public/assets/landing/palace-sky.png`

**Interfaces:**

- Consumes: Task 1's inline semantic structure.
- Produces: no runtime import or CSS URL targeting the removed image layers.

- [ ] Extend the static test to reject old poster imports and `/assets/landing/` CSS URLs.
- [ ] Run it to confirm the old code fails the assertions.
- [ ] After `rg -n "assets/landing|poster-(background|characters|decorations|frame|join-button|title)" apps/web tests` finds no runtime references, delete only the listed components and assets.
- [ ] Re-run the landing tests and web build.

### Task 3: Validate rendering and preserved interaction

**Files:**

- Verify: `tests/e2e/workbench.spec.ts`

**Interfaces:**

- Consumes: `data-testid="landing-poster"`, `data-testid="landing-join-button"`, and the original `onJoin` callback.
- Produces: desktop and mobile browser evidence that the new UI is visible and the join workflow remains reachable.

- [ ] Run `npx playwright test tests/e2e/workbench.spec.ts --project=desktop-chromium --project=android-chromium` and inspect any failure screenshots for clipping or overflow.
- [ ] Run `npm run lint`, `npm run typecheck`, and `npm run build -w @zhenhuan/web`; all must exit 0 before completion.
