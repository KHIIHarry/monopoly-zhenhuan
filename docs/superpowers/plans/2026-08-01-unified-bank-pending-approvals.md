# Unified Bank Pending Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every pending request and pending landing in one chronological, timestamped approval component on both bank views.

**Architecture:** Preserve the existing database models and expose `LandingEvent.declaredAt` as the landing snapshot's `createdAt`. A focused frontend utility converts both timestamped source arrays into a discriminated union, sorts oldest-first, and formats the exact Chinese timestamp. `BankView` derives the unified items once and renders one shared section component in both tabs while retaining type-specific cards and actions.

**Tech Stack:** TypeScript, React 19, Next.js, Prisma 6, Vitest, CSS

## Global Constraints

- Display all pending items; do not keep the summary's former two-item limit.
- Do not split the list by business type.
- Sort valid timestamps ascending; break equal timestamps by ascending item ID; place missing or invalid timestamps last.
- Render valid timestamps exactly as `xxxx年xx月xx日 xx:xx:xx`; render invalid timestamps as `提交时间未知`.
- Do not alter approval state machines, permissions, realtime refresh, notifications, player submission flows, or database schema.
- Preserve all unrelated worktree changes.
- Use Docker Compose only if a running application stack is required; do not start Web or API services with npm commands.

---

### Task 1: Expose Landing Submission Time

**Files:**
- Modify: `apps/api/src/prisma-game-service.integration.test.ts`
- Modify: `apps/api/src/prisma-game-service.ts:206`

**Interfaces:**
- Consumes: Prisma `LandingEvent.declaredAt: Date` and existing `GameRequest.createdAt: Date`.
- Produces: bank snapshot landing objects with `createdAt: Date`; the existing request snapshot continues to produce `createdAt: Date`.

- [ ] **Step 1: Write the failing snapshot contract assertion**

In the existing `keeps every pending request visible to the bank while bounding resolved history` integration test, load the persisted records after taking `snapshot` and require both snapshot item kinds to expose their source timestamps:

```ts
const [persistedRequest, persistedLanding] = await Promise.all([
  firstDb.gameRequest.findUniqueOrThrow({ where: { id: lockedRequest.id } }),
  firstDb.landingEvent.findUniqueOrThrow({ where: { id: landing.id } }),
]);

expect(snapshot.requests.find((request) => request.id === lockedRequest.id)).toMatchObject({
  createdAt: persistedRequest.createdAt,
});
expect(snapshot.landings.find((item) => item.id === landing.id)).toMatchObject({
  createdAt: persistedLanding.declaredAt,
});
```

- [ ] **Step 2: Run the focused integration test and verify RED**

Run:

```bash
npm run test:integration -- -t "keeps every pending request visible to the bank while bounding resolved history"
```

Expected: FAIL because the landing snapshot does not contain `createdAt`; the ordinary request assertion already passes.

- [ ] **Step 3: Add the landing timestamp to the snapshot mapping**

Extend the existing `landings` mapping without changing the query or schema:

```ts
landings: room.landingEvents.map((landing) => ({
  id: landing.id,
  turnId: landing.turnId ?? undefined,
  playerId: landing.playerId,
  propertyName: landing.property?.definition.name,
  spaceType: landing.spaceType,
  status: landing.status,
  plotResolved: landing.plotResolved,
  propertyActionsCancelled: landing.propertyActionsCancelled,
  tollSettled: tollSettlementStates.get(landing.id) === 'COMMITTED',
  createdAt: landing.declaredAt,
})),
```

- [ ] **Step 4: Run the focused integration test and verify GREEN**

Run the command from Step 2. Expected: PASS with one selected integration test and no assertion failures.

- [ ] **Step 5: Commit the API contract change**

```bash
git add apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts
git commit -m "feat(api): expose landing submission time"
```

---

### Task 2: Merge, Sort, and Format Pending Items

**Files:**
- Create: `apps/web/app/components/bank-pending-approvals.ts`
- Create: `apps/web/app/components/bank-pending-approvals.test.ts`

**Interfaces:**
- Consumes: request and landing arrays whose elements contain `id: string` and optional `createdAt?: string`.
- Produces: `PendingApprovalItem<R, L>`, `mergePendingApprovals<R, L>(requests, landings)`, and `formatApprovalSubmittedAt(createdAt)`.

- [ ] **Step 1: Write failing unit tests for merge order and exact formatting**

Create `bank-pending-approvals.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  formatApprovalSubmittedAt,
  mergePendingApprovals,
} from './bank-pending-approvals';

describe('bank pending approvals', () => {
  test('merges request and landing items oldest-first with deterministic ties and invalid dates last', () => {
    const items = mergePendingApprovals(
      [
        { id: 'request-b', createdAt: '2026-08-01T02:00:00.000Z' },
        { id: 'request-invalid', createdAt: 'invalid' },
      ],
      [
        { id: 'landing-a', createdAt: '2026-08-01T01:00:00.000Z' },
        { id: 'landing-b', createdAt: '2026-08-01T02:00:00.000Z' },
      ],
    );

    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'LANDING:landing-a',
      'LANDING:landing-b',
      'REQUEST:request-b',
      'REQUEST:request-invalid',
    ]);
  });

  test('formats the browser-local submission time to Chinese seconds precision', () => {
    const localDate = new Date(2026, 7, 1, 9, 8, 7);
    expect(formatApprovalSubmittedAt(localDate.toISOString())).toBe(
      '提交时间：2026年08月01日 09:08:07',
    );
    expect(formatApprovalSubmittedAt('invalid')).toBe('提交时间未知');
  });
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run:

```bash
npm test -- apps/web/app/components/bank-pending-approvals.test.ts
```

Expected: FAIL because `bank-pending-approvals.ts` does not exist.

- [ ] **Step 3: Implement the focused utility**

Create `bank-pending-approvals.ts`:

```ts
type TimestampedApprovalSource = { id: string; createdAt?: string };

export type PendingApprovalItem<
  R extends TimestampedApprovalSource,
  L extends TimestampedApprovalSource,
> =
  | { kind: 'REQUEST'; id: string; createdAt?: string; request: R }
  | { kind: 'LANDING'; id: string; createdAt?: string; landing: L };

function timestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function mergePendingApprovals<
  R extends TimestampedApprovalSource,
  L extends TimestampedApprovalSource,
>(requests: R[], landings: L[]): PendingApprovalItem<R, L>[] {
  return [
    ...requests.map((request) => ({
      kind: 'REQUEST' as const,
      id: request.id,
      createdAt: request.createdAt,
      request,
    })),
    ...landings.map((landing) => ({
      kind: 'LANDING' as const,
      id: landing.id,
      createdAt: landing.createdAt,
      landing,
    })),
  ].sort((left, right) => {
    const leftTime = timestamp(left.createdAt);
    const rightTime = timestamp(right.createdAt);
    if (leftTime === null || rightTime === null) {
      if (leftTime === rightTime) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      return leftTime === null ? 1 : -1;
    }
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function formatApprovalSubmittedAt(createdAt?: string): string {
  if (!createdAt) return '提交时间未知';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '提交时间未知';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `提交时间：${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
```

- [ ] **Step 4: Run the unit test and verify GREEN**

Run the command from Step 2. Expected: 2 tests pass.

- [ ] **Step 5: Commit the frontend domain utility**

```bash
git add apps/web/app/components/bank-pending-approvals.ts apps/web/app/components/bank-pending-approvals.test.ts
git commit -m "feat(web): order unified pending approvals"
```

---

### Task 3: Render One Shared Approval Section in Both Bank Tabs

**Files:**
- Modify: `apps/web/app/components/app-router-client.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx:100-139,6120-6725,7449-7532`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/globals.css.test.ts`

**Interfaces:**
- Consumes: `mergePendingApprovals`, `formatApprovalSubmittedAt`, `PendingApprovalItem<BankRequest, Landing>`, and the four existing action callbacks.
- Produces: `PendingApprovalSection`, the only approval-list renderer used by both `SUMMARY` and `APPROVAL`.

- [ ] **Step 1: Write failing structural and style tests**

Add a `unified bank pending approvals` describe block to `app-router-client.test.ts` that reads the component source and asserts:

```ts
expect(component).toContain('createdAt?: string;');
expect(component).toContain('const pendingApprovals = mergePendingApprovals(pending, pendingLandings);');
expect(component.match(/<PendingApprovalSection/g)).toHaveLength(2);
expect(component).not.toContain('pending.slice(0, 2)');
expect(component).not.toContain('title="待确认落点"');
expect(component).not.toContain('title="待审批请求"');
expect(component).toContain('formatApprovalSubmittedAt(item.createdAt)');
expect(component).toContain('当前没有待审批事项');
```

Add to `globals.css.test.ts`:

```ts
expect(stylesheet).toMatch(
  /\.approval-submitted-at\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
);
```

- [ ] **Step 2: Run the focused web tests and verify RED**

Run:

```bash
npm test -- apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css.test.ts
```

Expected: FAIL because there is no unified item derivation or shared section and the timestamp style is absent.

- [ ] **Step 3: Wire the timestamped types and unified derivation**

Import the Task 2 utility. Add `createdAt?: string` to both `BankRequest` and `Landing`. Keep the existing status filters and derive once:

```ts
const pendingApprovals = mergePendingApprovals(pending, pendingLandings);
```

Replace each tab's approval markup with the same component invocation and complete callbacks:

```tsx
<PendingApprovalSection
  items={pendingApprovals}
  players={snapshot.players}
  properties={snapshot.properties}
  busy={busy}
  approve={setApproveTarget}
  reject={(request) => {
    setRejectReason('');
    setRejectTarget(request);
  }}
  confirmLanding={confirmLanding}
  cancelLanding={(landing) => {
    setCancelLandingReason('');
    setCancelLandingTarget(landing);
  }}
/>
```

- [ ] **Step 4: Consolidate both existing card renderers into `PendingApprovalSection`**

Define `PendingApprovalSection` outside `BankView`. It renders `SectionTitle title="待审批" action={`${items.length} 项`}`, the unified empty state, and one `.approval-list` mapping. In the map:

```tsx
<small className="approval-submitted-at">
  {formatApprovalSubmittedAt(item.createdAt)}
</small>
```

For `item.kind === 'REQUEST'`, preserve the current `ApprovalList` request card body and request callbacks verbatim. For `item.kind === 'LANDING'`, preserve the current landing card body, property-owner lookup, `PROPERTY`-only cancel action, and confirmation callback verbatim. Delete the superseded `ApprovalList` function and both separately rendered landing/request blocks.

- [ ] **Step 5: Make the full timestamp wrap safely**

Add the focused CSS rule without changing card sizing or colors:

```css
.approval-list .approval-submitted-at {
  white-space: normal;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 6: Run focused tests and type checking**

Run:

```bash
npm test -- apps/web/app/components/bank-pending-approvals.test.ts apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 7: Run the full regression suite**

Run:

```bash
npm test
npm run lint
```

Expected: Vitest reports zero failures and ESLint exits 0 with zero warnings. If the configured test database is available, also run `npm run test:integration`; otherwise report that integration limitation explicitly while retaining the focused Task 1 evidence.

- [ ] **Step 8: Commit the shared bank approval UI**

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css apps/web/app/globals.css.test.ts
git commit -m "feat(web): unify bank pending approvals"
```

---

## Final Verification Checklist

- [ ] Both tabs show the same total and complete item sequence.
- [ ] A landing submitted before a request appears above that request, and vice versa.
- [ ] Every valid item shows year, month, day, hour, minute, and second.
- [ ] Missing or invalid timestamps do not crash rendering and appear last.
- [ ] Request approve/reject and landing confirm/cancel controls retain their original behavior.
- [ ] No database migration or unrelated file change is included.
