# Landing Property Picker Responsive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the landing-location property picker show an unclipped selected state, two desktop cards per row, and a compact edge-safe mobile layout at 375px, 390px, and 430px without changing behavior or data.

**Architecture:** Keep `LandingPropertyCardPicker` markup and state unchanged. Add responsive rules scoped by `.landing-action-sheet` so the declaration modal gets an outline-safe grid, a wider two-column desktop layout, and individually compacted mobile controls and cards while browse-mode property cards retain their existing dimensions.

**Tech Stack:** Next.js, React, CSS, Vitest, Docker Compose

## Global Constraints

- Preserve existing functionality, component reuse, data structures, and interaction logic.
- Do not use global scaling or `transform: scale()`; adjust component dimensions, spacing, typography, and element positions individually.
- Keep the search input at `16px` on mobile to prevent iOS focus zoom.
- Keep mobile controls near `40px` high so the denser layout remains touchable.
- Scope compact sizing to `.landing-action-sheet`; do not change browse-mode property card sizing.
- Start and restart the application only through Docker Compose and verify the running Web app at `http://localhost:3000`.
- Preserve unrelated dirty-worktree changes and stage only task-specific hunks.

---

### Task 1: Define the responsive visual contract

**Files:**
- Modify: `apps/web/app/components/landing-property-card-picker.styles.test.ts:33-37`

**Interfaces:**
- Consumes: the stylesheet text loaded from `apps/web/app/globals.css`.
- Produces: regression assertions for the declaration modal width, safe grid padding, desktop columns, and mobile card/control dimensions.

- [ ] **Step 1: Replace the narrow-screen-only test with failing declaration-layout contracts**

Add these tests inside the existing `describe('property explorer visual contract', ...)` block:

```ts
  it('keeps the landing selection outline inside a wider two-column desktop sheet', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/\.landing-action-sheet\s*\{[^}]*width:\s*min\(840px,\s*calc\(100% - 40px\)\)/s);
    expect(stylesheet).toMatch(/\.landing-action-sheet \.landing-property-grid\s*\{[^}]*padding:\s*6px/s);
    expect(stylesheet).toMatch(/@media\s*\(min-width:\s*700px\)[\s\S]*?\.landing-action-sheet \.landing-property-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  });

  it('uses compact edge-safe declaration cards through the 430px mobile range', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet\s*\{[^}]*width:\s*calc\(100% - 16px\)[^}]*padding:\s*10px 12px 0/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet \.landing-property-card\.collapsed\s*\{[^}]*height:\s*174px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet \.landing-property-empty\s*\{[^}]*height:\s*174px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet \.landing-property-search input\s*\{[^}]*min-height:\s*40px[^}]*font-size:\s*16px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.landing-action-sheet \.landing-owner-filter\s*\{[^}]*min-height:\s*40px/s);
  });
```

- [ ] **Step 2: Run the focused style test and verify RED**

Run:

```bash
npm test -- apps/web/app/components/landing-property-card-picker.styles.test.ts
```

Expected: FAIL in the two new tests because the declaration sheet is still `760px`, the grid padding is `3px`, there is no fixed desktop two-column rule, and there is no `430px` compact declaration rule.

---

### Task 2: Implement scoped desktop and mobile sizing

**Files:**
- Modify: `apps/web/app/globals.css:838-848`
- Test: `apps/web/app/components/landing-property-card-picker.styles.test.ts`

**Interfaces:**
- Consumes: existing `.landing-action-sheet`, `.landing-property-grid`, `.landing-property-card`, search, filter, badge, title, metadata, mortgage, and empty-state classes.
- Produces: declaration-only responsive layout rules; no React or TypeScript API changes.

- [ ] **Step 1: Add the outline-safe base declaration layout**

Update the declaration sheet and grid rules to include these properties while preserving the existing height, overflow, row, and confirmation-button behavior:

```css
.landing-action-sheet {
  width: min(840px, calc(100% - 40px));
  height: min(780px, calc(100dvh - 32px));
  max-height: calc(100dvh - 32px);
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  padding: 12px 18px 0;
}
.landing-action-sheet .landing-property-grid {
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  padding: 6px;
  grid-template-columns: minmax(0, 1fr);
}
```

- [ ] **Step 2: Add the desktop two-column declaration rule**

Place the declaration-specific desktop rule after the base rule:

```css
@media (min-width: 700px) {
  .landing-action-sheet .landing-property-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

- [ ] **Step 3: Add compact declaration-only mobile rules**

Add a `430px` media query after the desktop rule. Keep every selector scoped to `.landing-action-sheet`:

```css
@media (max-width: 430px) {
  .landing-action-sheet {
    width: calc(100% - 16px);
    height: min(760px, calc(100dvh - 16px));
    max-height: calc(100dvh - 16px);
    padding: 10px 12px 0;
  }
  .landing-action-sheet .modal-heading { min-height: 38px; }
  .landing-action-sheet .modal-heading h2 { font-size: 19px; }
  .landing-action-sheet .sheet-copy { margin: 3px 0 5px; font-size: 11px; line-height: 1.4; }
  .landing-action-sheet .landing-property-picker { gap: 6px; }
  .landing-action-sheet .landing-property-search input { min-height: 40px; padding-left: 36px; font-size: 16px; }
  .landing-action-sheet .landing-property-search svg { left: 11px; width: 16px; height: 16px; }
  .landing-action-sheet .landing-property-owner-filters { gap: 5px; }
  .landing-action-sheet .landing-owner-filter { min-height: 40px; padding: 4px 10px; font-size: 11px; }
  .landing-action-sheet .landing-property-grid { gap: 10px; }
  .landing-action-sheet .landing-property-card { min-height: 174px; padding: 12px 10px 12px 14px; gap: 8px; }
  .landing-action-sheet .landing-property-card.collapsed { height: 174px; }
  .landing-action-sheet .landing-property-badge { min-width: 40px; padding: 5px 7px; font-size: 10px; }
  .landing-action-sheet .landing-property-title-line { gap: 5px; max-width: calc(100% - 58px); margin: 3px 0 0; }
  .landing-action-sheet .landing-property-card-title { font-size: 18px; }
  .landing-action-sheet .property-cold-palace-hint { padding: 2px 4px; font-size: 9px; }
  .landing-action-sheet .landing-property-card-meta { column-gap: 10px; row-gap: 8px; font-size: 11px; }
  .landing-action-sheet .landing-property-card-meta strong { margin-top: 2px; font-size: 13px; }
  .landing-action-sheet .property-owner-nickname { margin-top: 2px; font-size: 10px; }
  .landing-action-sheet .property-selected-mark { top: 39px; right: 9px; font-size: 18px; }
  .landing-action-sheet .property-mortgage-stamp { top: 104px; width: 92px; height: 31px; font-size: 15px; }
  .landing-action-sheet .landing-property-empty { max-width: none; height: 174px; padding: 14px; }
  .landing-action-sheet .landing-confirm { width: calc(100% + 24px); min-height: 46px; margin: 8px -12px; }
}
```

- [ ] **Step 4: Run the focused style test and verify GREEN**

Run:

```bash
npm test -- apps/web/app/components/landing-property-card-picker.styles.test.ts
```

Expected: PASS with all visual-contract tests green.

- [ ] **Step 5: Run the shared component tests**

Run:

```bash
npm test -- apps/web/app/components/landing-property-card-picker.test.ts apps/web/app/components/landing-property-card-picker.styles.test.ts
```

Expected: PASS; selection, browse expansion, ownership, mortgage, cold-palace, and responsive style contracts remain green.

- [ ] **Step 6: Commit only the task-specific test and CSS hunks**

Review the existing dirty CSS and stage only the lines belonging to this task. Then commit:

```bash
git add -p apps/web/app/globals.css
git add apps/web/app/components/landing-property-card-picker.styles.test.ts
git diff --cached --check
git commit -m "style: compact landing property picker"
```

Expected: the commit contains only the responsive declaration-picker test and CSS changes; unrelated `globals.css` edits remain unstaged.

---

### Task 3: Verify builds and real responsive rendering

**Files:**
- Verify: `apps/web/app/globals.css`
- Verify: `apps/web/app/components/landing-property-card-picker.styles.test.ts`

**Interfaces:**
- Consumes: the responsive stylesheet implementation from Task 2 and the Docker Web service on port 3000.
- Produces: fresh automated and visual evidence for the selected outline, desktop two-column layout, and 375px/390px/430px mobile layouts.

- [ ] **Step 1: Run the complete Vitest suite**

Run:

```bash
npm test
```

Expected: exit code `0` with no failed tests.

- [ ] **Step 2: Run TypeScript validation**

Run:

```bash
npm run typecheck
```

Expected: exit code `0` with no TypeScript errors.

- [ ] **Step 3: Run the Web production build**

Run:

```bash
npm run build -w @zhenhuan/web
```

Expected: exit code `0` and a successful Next.js production build.

- [ ] **Step 4: Restart only the Docker Web service and confirm port 3000**

Run:

```bash
docker compose restart web
docker compose ps web
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

Expected: the Web service is `Up` and the HTTP status is `200`.

- [ ] **Step 5: Inspect the declaration modal at desktop and mobile widths**

Open `http://localhost:3000`, enter the existing room workflow, and inspect the declaration modal at desktop width plus `375x812`, `390x844`, and `430x932`.

Verify at every mobile width:

- the action sheet has visible space on both screen edges;
- selected owned and treasury cards both show their complete outline and border;
- cards, empty state, search field, filters, title, badge, nickname, mortgage stamp, and selected mark stay inside their containers;
- filter buttons remain single-line and wrap only between buttons;
- there is no horizontal page or grid overflow;
- the first viewport contains more card content than before without reducing touch targets below the planned size.

Verify on desktop:

- exactly two cards fit per row;
- a single filtered result occupies one column instead of stretching across the sheet;
- scrolling does not clip the red selected outline.

- [ ] **Step 6: Review the final diff and repository state**

Run:

```bash
git status --short
git show --stat --oneline HEAD
git diff --check
```

Expected: the implementation commit contains only task-specific responsive CSS and style tests; unrelated pre-existing worktree changes remain untouched.
