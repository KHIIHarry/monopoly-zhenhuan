# Property Browser Mobile Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all mobile property-browser surfaces consistent page margins, smaller controls, and compact cards without changing shared component behavior or the landing-location picker.

**Architecture:** Keep `LandingPropertyCardPicker` markup, props, and state unchanged. Add a `max-width: 430px` CSS block scoped to `.browse-property-picker`, so player-home properties, the player property tab, and the bank property tab share the compact layout while desktop and `.landing-action-sheet` rules remain independent.

**Tech Stack:** Next.js, React, CSS, Vitest, Docker Compose

## Global Constraints

- Apply the same compact browse layout to player home “我的地产”, player “全局地产”, and bank “全地图地产”.
- Preserve search, filtering, sorting, expansion, keyboard interaction, component reuse, and data structures.
- Do not use `transform: scale()` or create a second property component.
- Keep the mobile search input at `16px` to avoid iOS focus zoom.
- Keep mobile filter controls near `40px` high for touch use.
- Scope every new production rule to `.browse-property-picker` and `max-width: 430px`.
- Do not change desktop card dimensions or `.landing-action-sheet` declaration-picker dimensions.
- Start and restart the Web application only through Docker Compose on `http://localhost:3000`.
- Preserve unrelated dirty-worktree changes and stage only task-specific CSS hunks.

---

### Task 1: Define the compact browse-mode contract

**Files:**
- Modify: `apps/web/app/components/landing-property-card-picker.styles.test.ts:50`

**Interfaces:**
- Consumes: stylesheet text loaded from `apps/web/app/globals.css`.
- Produces: regression assertions for mobile browse margins, controls, cards, empty state, typography, and mortgage stamp sizing.

- [ ] **Step 1: Add the failing mobile browse visual-contract test**

Append this test to the existing `describe('property explorer visual contract', ...)` block:

```ts
  it('keeps all mobile browse property surfaces inset and compact', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker\s*\{[^}]*margin-inline:\s*16px[^}]*gap:\s*8px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-search input\s*\{[^}]*min-height:\s*40px[^}]*font-size:\s*16px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-owner-filter\s*\{[^}]*min-height:\s*40px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-grid\s*\{[^}]*gap:\s*10px[^}]*padding:\s*0/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-card\.collapsed\s*\{[^}]*height:\s*184px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-empty\s*\{[^}]*height:\s*184px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.landing-property-card-title\s*\{[^}]*font-size:\s*19px/s);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*430px\)[\s\S]*?\.browse-property-picker \.property-mortgage-stamp\s*\{[^}]*width:\s*94px[^}]*height:\s*32px/s);
  });
```

- [ ] **Step 2: Run the style contract and verify RED**

Run:

```bash
npm test -- apps/web/app/components/landing-property-card-picker.styles.test.ts
```

Expected: FAIL only in the new browse-mode test because no scoped mobile browse rules exist.

---

### Task 2: Implement mobile browse margins and compact sizing

**Files:**
- Modify: `apps/web/app/globals.css:847-876`
- Test: `apps/web/app/components/landing-property-card-picker.styles.test.ts`

**Interfaces:**
- Consumes: existing `.browse-property-picker` class emitted by `LandingPropertyCardPicker` when `mode="browse"`.
- Produces: declaration-independent mobile browse styles; no component or TypeScript API change.

- [ ] **Step 1: Add the scoped `430px` browse rules**

Place this media query after the existing `.landing-action-sheet` `430px` block and before the generic `420px` fallback:

```css
@media (max-width: 430px) {
  .browse-property-picker { margin-inline: 16px; gap: 8px; }
  .browse-property-picker .property-expand-hint { padding: 5px 8px; font-size: 11px; }
  .browse-property-picker .landing-property-search input { min-height: 40px; padding-left: 36px; font-size: 16px; }
  .browse-property-picker .landing-property-search svg { left: 11px; width: 16px; height: 16px; }
  .browse-property-picker .landing-property-owner-filters { gap: 5px; }
  .browse-property-picker .landing-owner-filter { min-height: 40px; padding: 4px 10px; font-size: 11px; }
  .browse-property-picker .landing-property-grid { grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 0; }
  .browse-property-picker .landing-property-card { min-height: 184px; padding: 12px 10px 12px 14px; gap: 8px; }
  .browse-property-picker .landing-property-card.collapsed { height: 184px; }
  .browse-property-picker .landing-property-badge { min-width: 40px; padding: 5px 7px; font-size: 10px; }
  .browse-property-picker .landing-property-title-line { gap: 5px; max-width: calc(100% - 58px); margin: 3px 0 0; }
  .browse-property-picker .landing-property-card-title { font-size: 19px; }
  .browse-property-picker .property-cold-palace-hint { padding: 2px 4px; font-size: 9px; }
  .browse-property-picker .landing-property-card-meta { column-gap: 10px; row-gap: 8px; font-size: 11px; }
  .browse-property-picker .landing-property-card-meta strong { margin-top: 2px; font-size: 13px; }
  .browse-property-picker .property-owner-nickname { margin-top: 2px; font-size: 10px; }
  .browse-property-picker .property-mortgage-stamp { top: 110px; width: 94px; height: 32px; font-size: 15px; }
  .browse-property-picker .landing-property-empty { max-width: none; height: 184px; padding: 14px; }
}
```

- [ ] **Step 2: Run the focused style test and verify GREEN**

Run:

```bash
npm test -- apps/web/app/components/landing-property-card-picker.styles.test.ts
```

Expected: PASS with all visual-contract tests green.

- [ ] **Step 3: Run shared property component tests**

Run:

```bash
npm test -- apps/web/app/components/landing-property-card-picker.test.ts apps/web/app/components/landing-property-card-picker.styles.test.ts apps/web/app/components/app-router-client.test.ts
```

Expected: PASS; all three browse render sites remain present, and landing selection behavior remains unchanged.

- [ ] **Step 4: Stage only task-specific hunks and commit**

Review the existing dirty CSS before staging. Stage the complete new media-query hunk and the style test, leaving unrelated CSS hunks unstaged:

```bash
git add apps/web/app/components/landing-property-card-picker.styles.test.ts
git add -p apps/web/app/globals.css
git diff --cached --check
git commit -m "style: compact mobile property browser"
```

Expected: the commit contains only the scoped browse mobile CSS and its contract test.

---

### Task 3: Verify responsive behavior and the production build

**Files:**
- Verify: `apps/web/app/globals.css`
- Verify: `apps/web/app/components/landing-property-card-picker.styles.test.ts`
- Temporarily create and delete: `apps/web/app/responsive-property-browser-check/page.tsx`

**Interfaces:**
- Consumes: Task 2 implementation and the Docker Web service.
- Produces: automated and browser evidence for player-home, player-property, and bank-property browse layouts.

- [ ] **Step 1: Run the complete automated checks serially where generated files overlap**

Run:

```bash
npm test
npm run typecheck
npm run build -w @zhenhuan/web
```

Expected: each command exits `0`; Vitest has no failures, TypeScript reports no errors, and Next.js builds successfully. Do not run typecheck concurrently with the Next build because both access `.next/types`.

- [ ] **Step 2: Restart Docker Web and confirm the required port**

Run:

```bash
docker compose restart web
docker compose ps web
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

Expected: Web is `Up` and HTTP status is `200`.

- [ ] **Step 3: Inspect the real shared component at target widths**

Create this temporary uncommitted route with `apply_patch`. It imports the production component and global stylesheet rather than copying component markup:

```tsx
'use client';

import { LandingPropertyCardPicker } from '../components/landing-property-card-picker';

const players = [
  { id: 'p1', name: 'Harry', characterId: 'anlingrong' },
  { id: 'p2', name: '华妃玩家', characterId: 'huashifei' },
  { id: 'p3', name: '眉庄玩家', characterId: 'meizhuang', tollCollectionBlocked: true },
  { id: 'p4', name: '皇后玩家', characterId: 'yixiu' },
  { id: 'p5', name: '甄嬛玩家', characterId: 'zhenhuan' },
];

const properties = [
  { name: '延禧宫', ownerId: 'p1', level: 0, mortgaged: false, mortgage: 1200, purchasePrice: 2400, build: 1500, buildingSell: 750, tolls: [700, 1400, 2800, 5600, 8000, 11000] },
  { name: '翊坤宫', ownerId: 'p2', level: 0, mortgaged: true, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1000, tolls: [800, 2000, 3900, 9000, 11000, 13000] },
  { name: '咸福宫', ownerId: 'p3', level: 3, mortgaged: false, mortgage: 1300, purchasePrice: 2600, build: 1600, buildingSell: 800, tolls: [600, 1500, 3000, 6000, 8500, 11500] },
  { name: '景仁宫', ownerId: null, level: 0, mortgaged: false, mortgage: 1500, purchasePrice: 3000, build: 2000, buildingSell: 1000, tolls: [0, 0, 0, 0, 0, 0] },
];

export default function ResponsivePropertyBrowserCheckPage() {
  return <LandingPropertyCardPicker mode="browse" properties={properties} players={players} viewerPlayerId="p1" />;
}
```

Open `http://localhost:3000/responsive-property-browser-check`. Click a card to inspect the expanded state and fill the search field with a non-matching value to inspect the empty state.

At `375x812`, `390x844`, and `430x932`, verify:

- component left and right edges are 16px from the viewport;
- search and card edges align;
- search and each filter control are 40px high;
- seven filters wrap only between buttons and each label stays single-line;
- collapsed cards and empty state are 184px high;
- title, badge, nickname, cold-palace hint, and mortgage stamp stay inside the card;
- expanded details remain content-driven and do not overlap the next card;
- document and property grid have zero horizontal overflow.

At desktop width, verify cards remain 220px high and retain the existing multi-column grid.

- [ ] **Step 4: Remove the temporary route and verify repository boundaries**

Delete the temporary route with `apply_patch`, then run:

```bash
git status --short
git diff --check
git show --stat --oneline HEAD
```

Expected: no temporary route remains; the implementation commit contains only the style test and scoped browse CSS, while unrelated pre-existing worktree changes remain untouched.
