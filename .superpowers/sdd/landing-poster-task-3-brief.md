# Task 3: implement the landing poster and responsive layout

Read `.superpowers/sdd/landing-poster-task-1-brief.md` and the implementation plan section “Task 3” in `docs/superpowers/plans/2026-07-28-landing-poster.md` first.

Implement the landing poster as independent components:

- `apps/web/app/components/landing/poster-background.tsx`
- `apps/web/app/components/landing/poster-frame.tsx`
- `apps/web/app/components/landing/poster-characters.tsx`
- `apps/web/app/components/landing/poster-title.tsx`
- `apps/web/app/components/landing/poster-decorations.tsx`
- `apps/web/app/components/landing/poster-join-button.tsx`
- `apps/web/app/components/landing/landing-poster.tsx`

Modify only `apps/web/app/page.tsx` and `apps/web/app/globals.css` in addition to these component files. Use the eight static files under `apps/web/public/assets/landing/`; do not refer to the original design images at runtime. Replace the current `screen === 'LANDING'` markup with `<LandingPoster onJoin={() => setScreen('LOGIN')} />` and preserve the exact button name and behavior.

Each visual component root must expose one stable test ID: `landing-background`, `landing-frame`, `landing-characters`, `landing-title`, `landing-decorations`, `landing-join-button`. The combined poster root uses `landing-poster`. Render an accessible native button with `type="button"` and visible text `加入游戏组`.

This task includes the responsive CSS because the existing RED test's no-overflow requirement depends on it. The landing page must use `100dvh`, safe-area padding, `overflow: clip`, Grid layer stacking, and a centered vertical `aspect-ratio: 2 / 3` poster. On iPad and desktop, keep that vertical poster centered while the red texture background covers the remaining sides. Use `cover` for outer texture and palace backgrounds; `contain` for characters, title and button. Use `clamp()`, percentages, Flex/Grid and aspect ratio rather than large fixed-pixel positioning. Images must not distort. Decorations/frame must be `pointer-events: none`, and the join button must be above every visual layer and remain keyboard-focusable.

Follow TDD: first run the focused test from Task 1 to observe its current RED result. Then implement and rerun it to GREEN. Use the browser screenshot result to inspect 360x800, 768x1024 and 1440x900; do not leave generated screenshot files tracked. Run `npm run lint --workspace=@zhenhuan/web` if the repository supports it, otherwise run the focused ESLint command you can identify. Do not edit extraction assets or tests.

Write a detailed report to `.superpowers/sdd/landing-poster-task-3-report.md`, including RED/GREEN evidence, screenshot viewports, files changed, test output, self-review and concerns. There is no Git metadata; do not attempt a commit.
