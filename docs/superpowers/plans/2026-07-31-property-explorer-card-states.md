# Property Explorer Card States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the approved shared property search, owner filters, themed card states, browse expansion, and landing-only selection behavior to the player and bank applications.

**Architecture:** Keep `LandingPropertyCardPicker` as the single UI component for player browse, bank browse, and landing selection modes. Put deterministic search, filter, ownership, and sort decisions in `landing-property-picker.ts`; keep only query, owner-filter, and expanded-card state in the client component; use existing room snapshot data with no API changes.

**Tech Stack:** Next.js, React, TypeScript, `pinyin-pro`, Vitest, CSS, Docker Compose.

## Global Constraints

- Start the actual Web and API services only with Docker Compose.
- Verify the running application only on `http://localhost:3000`.
- Preserve unrelated dirty-worktree changes, especially in `app-router-client.tsx`, `globals.css`, and existing tests.
- Search must match Chinese substrings, full-pinyin continuous substrings, initials, mixed Chinese/pinyin, character names, and player nicknames while ignoring whitespace and English case.
- Owner filters must be ordered as `全部`, white `无主`, then only valid characters currently selected in the room.
- Collapsed browse cards, landing cards, and empty-result cards must share a fixed `220px` height.
- Browse cards expand and collapse without selection styling; landing cards select without rendering details.
- Rent details must render 0 level as one row, 1-4 levels as a 2 x 2 grid, and 5 level as a separate double-border palace row.

---

### Task 1: Search, Filter, And Ownership Model

**Files:**
- Modify: `apps/web/app/components/landing-property-picker.ts`
- Test: `apps/web/app/components/landing-property-picker.test.ts`

**Interfaces:**
- Produces: `type PropertyOwnerFilter = 'all' | 'unowned' | string`
- Produces: `filterLandingProperties(properties, players, query, ownerFilter)`
- Produces: `propertyOwner(property, players, viewerPlayerId?)`
- Produces: `propertyCharacterMeta(characterId)` with `filterLabel`

- [ ] **Step 1: Write failing model tests**

```ts
it('searches property, character, and nickname text with pinyin variants', () => {
  expect(filterLandingProperties(properties, players, 'yix', 'all')).toEqual([properties[0]]);
  expect(filterLandingProperties(properties, players, 'laoshi', 'all')).toEqual([properties[0]]);
});

it('distinguishes all, unowned, and a player owner filter', () => {
  expect(filterLandingProperties(properties, players, '', 'unowned')).toEqual([properties[1]]);
  expect(filterLandingProperties(properties, players, '', 'p1')).toEqual([properties[0]]);
});

it('marks the viewer owned property as mine', () => {
  expect(propertyOwner(properties[0], players, 'p1').label).toBe('我的地产');
});
```

- [ ] **Step 2: Run the model test and verify the new expectations fail**

Run: `npm test -- apps/web/app/components/landing-property-picker.test.ts`

Expected: FAIL because the filter signature, unowned state, owner metadata search, and viewer label are not implemented.

- [ ] **Step 3: Implement normalized multi-field matching and explicit filter states**

```ts
export type PropertyOwnerFilter = 'all' | 'unowned' | string;

function matchesSearchText(value: string, term: string) {
  const normalized = normalizedLandingQuery(value);
  return !term || normalized.includes(term) || Boolean(match(value, term));
}

export function filterLandingProperties<T extends LandingProperty>(
  properties: T[],
  players: LandingPlayer[],
  query: string,
  ownerFilter: PropertyOwnerFilter = 'all',
) {
  const term = normalizedLandingQuery(query);
  return properties.filter((property) => {
    const owner = players.find((player) => player.id === property.ownerId);
    const character = propertyCharacterMeta(owner?.characterId);
    const ownerMatches = ownerFilter === 'all'
      || (ownerFilter === 'unowned' ? property.ownerId === null : property.ownerId === ownerFilter);
    return ownerMatches && [property.name, character?.name ?? '', owner?.name ?? '']
      .some((value) => matchesSearchText(value, term));
  });
}
```

- [ ] **Step 4: Run the model tests and verify they pass**

Run: `npm test -- apps/web/app/components/landing-property-picker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the model change**

```bash
git add apps/web/app/components/landing-property-picker.ts apps/web/app/components/landing-property-picker.test.ts
git commit -m "feat: model property explorer filters"
```

### Task 2: Shared Card Rendering And Mode Behavior

**Files:**
- Modify: `apps/web/app/components/landing-property-card-picker.tsx`
- Test: `apps/web/app/components/landing-property-card-picker.test.ts`

**Interfaces:**
- Consumes: Task 1 filter and ownership helpers.
- Produces: `LandingPropertyCardPicker` with optional `viewerPlayerId`.

- [ ] **Step 1: Write failing component rendering tests**

```ts
expect(html).toContain('>无主</button>');
expect(html).toContain('「小行老师」');
expect(html).toContain('「银行」');
expect(html).toContain('aria-expanded="false"');
expect(html).not.toContain('查看完整价格与租金');
expect(landingHtml).not.toContain('property-details-panel');
expect(mortgagedHtml).toContain('property-mortgage-stamp">已抵押');
expect(coldPalaceHtml).toContain('冷宫 · 免过路费');
```

- [ ] **Step 2: Run the component test and verify it fails**

Run: `npm test -- apps/web/app/components/landing-property-card-picker.test.ts`

Expected: FAIL because the unowned filter, two-line bank owner, card expansion control, and approved state markup are absent.

- [ ] **Step 3: Implement explicit owner filtering and room-role fallback**

```ts
const [ownerFilter, setOwnerFilter] = useState<PropertyOwnerFilter>('all');
const activeOwnerFilter = ownerFilter === 'all' || ownerFilter === 'unowned'
  || propertyPlayers.some((player) => player.id === ownerFilter)
  ? ownerFilter
  : 'all';
```

- [ ] **Step 4: Implement browse expansion and landing selection on the same card shell**

```tsx
<article
  role="button"
  tabIndex={0}
  aria-expanded={mode === 'browse' ? expanded : undefined}
  aria-pressed={mode === 'landing' ? selected : undefined}
  onClick={() => mode === 'browse' ? toggleExpanded(property.name) : onChange?.(property.name)}
  onKeyDown={(event) => handleCardKeyDown(event, property.name)}
>
  {summaryContents}
  {mode === 'browse' && expanded && detailsContents}
</article>
```

- [ ] **Step 5: Render the approved detail grouping**

```tsx
<div className="property-details-panel">
  <p>价格信息</p>
  <div className="property-detail-grid">{priceCells}</div>
  <p>建筑等级过路费</p>
  <div className="property-empty-land-tier">空地（0级） <strong>{tolls[0]} 两</strong></div>
  <div className="property-detail-grid property-level-rent-grid">{tolls.slice(1, 5)}</div>
  <div className="property-palace-tier">大宫殿（5级） <strong>{tolls[5]} 两</strong></div>
</div>
```

- [ ] **Step 6: Run the component tests and verify they pass**

Run: `npm test -- apps/web/app/components/landing-property-card-picker.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the shared component change**

```bash
git add apps/web/app/components/landing-property-card-picker.tsx apps/web/app/components/landing-property-card-picker.test.ts
git commit -m "feat: render property explorer card states"
```

### Task 3: Approved Visual Contract

**Files:**
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/app/components/landing-property-card-picker.styles.test.ts`

**Interfaces:**
- Consumes: Task 2 class names.
- Produces: fixed collapsed geometry, themed borders and fills, mortgage stamp, cold-palace title hint, compact detail grids, and responsive single-column fallback.

- [ ] **Step 1: Write a failing CSS contract test**

```ts
expect(stylesheet).toMatch(/\.landing-property-card\.collapsed[^}]*height:\s*220px/);
expect(stylesheet).toMatch(/\.property-mortgage-stamp[^}]*rotate\(-45deg\)/);
expect(stylesheet).toMatch(/\.property-owner-filter[^}]*color-mix/);
expect(stylesheet).toMatch(/\.property-palace-tier[^}]*border:\s*3px double/);
expect(stylesheet).toMatch(/\.landing-property-empty[^}]*height:\s*220px/);
```

- [ ] **Step 2: Run the CSS contract test and verify it fails**

Run: `npm test -- apps/web/app/components/landing-property-card-picker.styles.test.ts`

Expected: FAIL because the approved CSS hooks do not exist.

- [ ] **Step 3: Replace the old property-card CSS block with the approved responsive styles**

```css
.landing-property-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 360px)); justify-content: start; }
.landing-property-card.collapsed { height: 220px; }
.landing-property-card.mortgaged { opacity: .62; }
.property-mortgage-stamp { width: 106px; height: 36px; transform: translate(-50%, -50%) rotate(-45deg); }
.property-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.property-palace-tier { border: 3px double color-mix(in srgb, var(--property-theme) 72%, #6f5b31); }
.landing-property-empty { width: 100%; max-width: 360px; height: 220px; }
```

- [ ] **Step 4: Run the CSS contract and component tests**

Run: `npm test -- apps/web/app/components/landing-property-card-picker.styles.test.ts apps/web/app/components/landing-property-card-picker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the visual contract**

```bash
git add apps/web/app/globals.css apps/web/app/components/landing-property-card-picker.styles.test.ts
git commit -m "style: match approved property card states"
```

### Task 4: Player And Bank Integration

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx`
- Test: `apps/web/app/components/app-router-client.test.ts`

**Interfaces:**
- Consumes: Task 2 `viewerPlayerId` prop.
- Produces: player browse labels for `我的地产`; bank and landing behavior remain viewer-neutral.

- [ ] **Step 1: Write a failing integration assertion**

```ts
expect(component.match(/mode="browse"[\s\S]{0,160}viewerPlayerId=\{me\.id\}/g)).toHaveLength(2);
expect(component).toMatch(/title="全地图地产"[\s\S]*?mode="browse"[\s\S]*?players=\{snapshot\.players\}/);
```

- [ ] **Step 2: Run the integration test and verify it fails**

Run: `npm test -- apps/web/app/components/app-router-client.test.ts`

Expected: FAIL because player browse calls do not yet pass `viewerPlayerId`.

- [ ] **Step 3: Pass the player identity only from player browse views**

```tsx
<LandingPropertyCardPicker
  mode="browse"
  properties={mine}
  players={snapshot.players}
  viewerPlayerId={me.id}
/>
```

- [ ] **Step 4: Run focused tests, typecheck, and build**

Run: `npm test -- apps/web/app/components/landing-property-picker.test.ts apps/web/app/components/landing-property-card-picker.test.ts apps/web/app/components/landing-property-card-picker.styles.test.ts apps/web/app/components/app-router-client.test.ts`

Run: `npm run typecheck`

Run: `npm run build -w @zhenhuan/web`

Expected: all commands exit 0.

- [ ] **Step 5: Commit the integration change**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts
git commit -m "feat: integrate shared property explorer states"
```

### Task 5: Docker And Browser Verification

**Files:**
- Verify only: `docker-compose.yml`

**Interfaces:**
- Consumes: completed player, bank, and landing UI.
- Produces: verified desktop and mobile behavior on the real application.

- [ ] **Step 1: Check port 3000 and stale host-side project processes**

Run: `lsof -nP -iTCP:3000 -sTCP:LISTEN`

Expected: either no host process or the existing Docker Web service.

- [ ] **Step 2: Start or rebuild the application through Docker Compose**

Run: `docker compose up -d --build`

Expected: Web and API containers become healthy/running.

- [ ] **Step 3: Verify the player and bank property views at desktop width**

Check: search by Chinese, continuous full pinyin, initials, and nickname; `无主` and character filters; one-card filtering does not stretch; browse cards expand/collapse; 0 / 1-4 / 5 rent grouping; mortgage and cold-palace states.

- [ ] **Step 4: Verify landing mode and mobile width**

Check: landing cards only select with red outline/check, never expand; controls and cards do not overflow; collapsed and empty cards keep matching dimensions.

- [ ] **Step 5: Review the final diff without reverting unrelated changes**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; all unrelated user changes remain present.
