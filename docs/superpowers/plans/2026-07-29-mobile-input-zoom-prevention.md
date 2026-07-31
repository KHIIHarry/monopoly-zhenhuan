# Mobile Input Zoom Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent iOS Safari from zooming the page when a mobile user focuses an editable form control.

**Architecture:** Keep the browser viewport configuration unchanged. Add one mobile-only CSS declaration that establishes a 16px computed font size for editable controls, guarded by an existing stylesheet contract test.

**Tech Stack:** Next.js, React, CSS, Vitest.

## Global Constraints

- Apply the rule only when the viewport width is 600px or narrower.
- Target `input`, `select`, and `textarea`; do not change labels or non-editable text.
- Use `font-size: 16px` to address the Safari zoom threshold.
- Do not disable browser zoom through viewport directives.

---

### Task 1: Add the Mobile Form-Control Font-Size Contract

**Files:**
- Modify: `apps/web/app/globals.css.test.ts`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `apps/web/app/globals.css`, loaded as a UTF-8 string by the existing Vitest test file.
- Produces: A CSS rule that guarantees a 16px font size for editable mobile form controls.

- [ ] **Step 1: Write the failing test**

Append this test to `apps/web/app/globals.css.test.ts`:

```ts
describe('mobile editable controls', () => {
  test('keeps editable control text at the iOS zoom threshold', async () => {
    const stylesheet = await readFile(fileURLToPath(stylesheetUrl), 'utf8');

    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*600px\)[\s\S]*?input,\s*select,\s*textarea\s*\{[^}]*font-size:\s*16px;/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run apps/web/app/globals.css.test.ts
```

Expected: FAIL because no mobile `input, select, textarea` rule sets `font-size: 16px`.

- [ ] **Step 3: Write the minimal implementation**

Append this rule to `apps/web/app/globals.css`:

```css
@media (max-width: 600px) {
  input,
  select,
  textarea {
    font-size: 16px;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vitest run apps/web/app/globals.css.test.ts
```

Expected: PASS with the existing stylesheet tests and the new mobile-control contract test passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/globals.css apps/web/app/globals.css.test.ts
git commit -m "fix: prevent mobile input zoom"
```
