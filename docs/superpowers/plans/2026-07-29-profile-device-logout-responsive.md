# Responsive Device Logout Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the profile page's “退出设备” control on one line at every supported mobile width.

**Architecture:** The existing `Profile` component already identifies each non-current device action through `.device-list article > button`. The change remains CSS-only: a compact-width media query turns the card into a vertical layout and makes that direct action button full-width with no wrapping. A stylesheet unit test protects the responsive contract without coupling to browser layout internals.

**Tech Stack:** Next.js, React, CSS, Vitest.

## Global Constraints

- Preserve the existing desktop card layout above 560px.
- Do not change device logout behavior, dialog copy, disabled-state behavior, or device metadata.
- At 560px and below, the button must be full-width and use `white-space: nowrap`.
- Keep changes scoped to the profile device-card CSS and its existing stylesheet test.

---

### Task 1: Protect the responsive device-card contract

**Files:**
- Modify: `apps/web/app/globals.css.test.ts:7-13`
- Modify: `apps/web/app/globals.css:1218-1235`

**Interfaces:**
- Consumes: `.device-list article` and its direct device logout button from the profile markup.
- Produces: A test requiring the 560px responsive rules to use a vertical device card and a single-line, full-width direct action button.

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe('profile device controls', ...)` block:

```ts
test('stacks the device logout control without wrapping on narrow screens', async () => {
  const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

  expect(stylesheet).toMatch(/@media\s*\(max-width:\s*560px\)[\s\S]*?\.device-list article\s*\{[^}]*flex-direction:\s*column;/);
  expect(stylesheet).toMatch(/@media\s*\(max-width:\s*560px\)[\s\S]*?\.device-list article\s*>\s*button\s*\{[^}]*width:\s*100%;[^}]*white-space:\s*nowrap;/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- apps/web/app/globals.css.test.ts
```

Expected: FAIL because the existing `@media (max-width: 560px)` block does not set `flex-direction: column` or define direct device-button sizing.

- [ ] **Step 3: Write minimal implementation**

Add the following rules inside the existing `@media (max-width: 560px)` block in `apps/web/app/globals.css`:

```css
  .device-list article { align-items: stretch; flex-direction: column; }
  .device-list article > button { width: 100%; white-space: nowrap; }
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- apps/web/app/globals.css.test.ts
```

Expected: PASS with both profile device-control tests passing.

- [ ] **Step 5: Verify mobile behavior in a browser**

Run the web app and open the profile page at a 390px-wide viewport. With a non-current device present, verify the logout action is below the metadata, spans the card's available width, and displays “退出设备” on one line. Then verify a desktop-width viewport retains the side-by-side layout.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/globals.css apps/web/app/globals.css.test.ts
git commit -m "fix: keep device logout action responsive"
```
