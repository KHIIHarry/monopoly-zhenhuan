# Removed Member Rejoin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit an administrator-removed account to rejoin its room when ordinary room admission rules allow it.

**Architecture:** Retain the existing `RoomMembership` row and reactivate it in `AccountRoomService.joinRoom`. The join path remains responsible for password, room-lifecycle, and midgame-admission validation, so no schema or frontend change is needed.

**Tech Stack:** TypeScript, Fastify, Prisma, PostgreSQL, Vitest.

## Global Constraints

- Keep the existing `(roomId, accountId)` uniqueness constraint and historical records.
- Do not restore removed character, bank, player, or asset capabilities.
- Preserve `PLAYING` room admission through `allowMidgameJoin` and terminal-room rejection.

---

### Task 1: Reactivate Removed Memberships

**Files:**
- Modify: `apps/api/src/admin-account-room-service.integration.test.ts:815-831`
- Modify: `apps/api/src/account-room-service.ts:1239-1240`

**Interfaces:**
- Consumes: `AccountRoomService.joinRoom(auth, roomId, password, key)`.
- Produces: an active retained membership returned by the existing join response.

- [ ] **Step 1: Write the failing test**

Replace the removed-membership join assertion with a LOBBY assertion that receives HTTP 200 and verifies the retained membership has `status: 'ACTIVE'`, `characterId: null`, and `isBank: false`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run apps/api/src/admin-account-room-service.integration.test.ts`

Expected: failure because the join route returns `ROOM_MEMBERSHIP_REMOVED`.

- [ ] **Step 3: Write minimal implementation**

Delete the early `current?.status === 'LEFT'` rejection in `joinRoom`. Let the existing `current ? roomMembership.update(...)` branch reactivate the retained row after admission and password validation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run apps/api/src/admin-account-room-service.integration.test.ts`

Expected: pass, including the removed-member rejoin regression.

- [ ] **Step 5: Run service integration coverage**

Run: `npm test -- --run apps/api/src/account-room-service.integration.test.ts apps/api/src/admin-account-room-service.integration.test.ts`

Expected: pass with the old permanent-rejection test updated to verify recovery.
