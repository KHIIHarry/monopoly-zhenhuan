# Room Start Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow unlimited lobby membership, atomically remove capability-less members at game start, and make midgame admission, room badges, rejection messages, and realtime removal behavior agree under concurrency.

**Architecture:** Add one pure admission evaluator consumed by both room summaries and the locked join transaction. Keep lobby joining as the existing membership-first flow, but make `PLAYING` joining assign the selected character and `Player` in that same transaction. Extend the existing idempotent start transaction to remove empty memberships and cancel lobby-only swaps, then use the existing Session Socket channel to evict affected clients after commit.

**Tech Stack:** TypeScript, Prisma 6/PostgreSQL, Fastify, Zod, Socket.IO, React 19, Next.js, Vitest, Playwright, Docker Compose

## Global Constraints

- `LOBBY` admission is unlimited even when all five characters are occupied.
- Start removes only `ACTIVE` memberships where `characterId === null && isBank === false`.
- A bank-only member and a player/bank dual-capability member must survive start.
- Start still requires 2 to `playerLimit` valid character-bearing players; a bank-only member does not count.
- `PLAYING` admission requires `allowMidgameJoin === true` and `playerCount < playerLimit`.
- When midgame joining is both disabled and full, return `MIDGAME_JOIN_DISABLED` before `PLAYER_LIMIT`.
- Midgame join and character acquisition are one locked, idempotent transaction; a failed competitor must not leave an `ACTIVE` empty membership.
- New midgame Players start with balance `0`, no initial-balance ledger, and no initial palace. Retained Players follow the existing re-selection semantics without another initial grant.
- Lobby admin room details and the bank reassignment dropdown continue to include every `ACTIVE` member, including members without a character.
- Reuse the current Prisma schema; do not add a migration or persisted joinability column.
- Preserve retained membership, Player, ledger, property, audit, and security history; do not physically delete kicked rows.
- Socket messages trigger navigation and authoritative REST refresh only; Socket payloads are not persisted state.
- Execute implementation in an isolated worktree created through the `using-git-worktrees` skill. Preserve unrelated changes and commit only task-owned files or hunks.
- Start the application only with Docker Compose. Playwright must use port 3000 and `PLAYWRIGHT_EXTERNAL_STACK=1`.

## File Structure

- Create `apps/api/src/room-admission.ts`: pure room admission types and priority evaluator.
- Create `apps/api/src/room-admission.test.ts`: table-driven evaluator coverage.
- Modify `apps/api/src/account-room-service.ts`: summary joinability, available-character summaries, and atomic midgame join.
- Modify `apps/api/src/account-room-service.integration.test.ts`: unlimited lobby, list contract, atomic admission, retained member, concurrency, and admin bank candidate coverage.
- Modify `apps/api/src/prisma-game-service.integration.test.ts`: update the fixture facade for the structured join input, then cover start cleanup, rollback, replay, and concurrent start.
- Modify `apps/api/src/prisma-game-service.ts`: atomic start cleanup, swap cancellation, audit records, and fresh-commit callback.
- Modify `apps/api/src/app.ts`: join request contract and Session-targeted start-removal delivery.
- Modify `apps/api/src/server-room-routes.test.ts`: Fastify join/start forwarding and public error contract.
- Modify `apps/api/src/app-socket.test.ts`: start-removal Session event and adapter eviction.
- Modify `apps/web/app/components/app-router-client.tsx`: summary types, badges, blocked-room handling, midgame character choice, and removal-event reconciliation.
- Modify `apps/web/app/components/app-router-client.test.ts`: structural contracts for all frontend behaviors.
- Modify `apps/web/app/globals.css`: unavailable badge and compact join-character field styling.
- Modify `apps/web/app/globals.css.test.ts`: focused style contract.
- Modify `tests/e2e/browser-fixture-types.ts`: browser room-summary fields.
- Modify `tests/e2e/task7-visual.spec.ts`: badge combinations and responsive join form.
- Modify `tests/e2e/task7-workflows.spec.ts`: blocked clicks, atomic join payload, stale role retry, and realtime eviction.
- Modify `tests/e2e/task7-real-stack.spec.ts`: real API/database lifecycle proof.

---

### Task 1: One Authoritative Admission Rule and Room Summary Contract

**Files:**
- Create: `apps/api/src/room-admission.ts`
- Create: `apps/api/src/room-admission.test.ts`
- Modify: `apps/api/src/account-room-service.ts:545-559,871-893`
- Modify: `apps/api/src/account-room-service.integration.test.ts`

**Interfaces:**
- Produces: `JoinBlockedReason`, `RoomJoinability`, and `roomJoinability(room, activePlayerCount)`.
- Extends each room summary with `canJoin`, `joinBlockedReason`, and `availableCharacters`.
- Consumed by: Task 2 join transaction and Task 5 frontend room model.

- [ ] **Step 1: Write the failing pure rule tests**

Create `apps/api/src/room-admission.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { roomJoinability } from './room-admission.js';

describe('roomJoinability', () => {
  it('keeps lobby admission unlimited even when character seats are full', () => {
    expect(roomJoinability(
      { status: 'LOBBY', allowMidgameJoin: false, playerLimit: 5 },
      5,
    )).toEqual({ canJoin: true, joinBlockedReason: null });
  });

  it('prioritizes terminal, disabled, and full reasons in that order', () => {
    expect(roomJoinability(
      { status: 'FINISHED', allowMidgameJoin: false, playerLimit: 5 },
      5,
    )).toEqual({ canJoin: false, joinBlockedReason: 'ROOM_FINISHED' });
    expect(roomJoinability(
      { status: 'PLAYING', allowMidgameJoin: false, playerLimit: 5 },
      5,
    )).toEqual({ canJoin: false, joinBlockedReason: 'MIDGAME_JOIN_DISABLED' });
    expect(roomJoinability(
      { status: 'PLAYING', allowMidgameJoin: true, playerLimit: 5 },
      5,
    )).toEqual({ canJoin: false, joinBlockedReason: 'PLAYER_LIMIT' });
    expect(roomJoinability(
      { status: 'PLAYING', allowMidgameJoin: true, playerLimit: 5 },
      4,
    )).toEqual({ canJoin: true, joinBlockedReason: null });
  });
});
```

- [ ] **Step 2: Run the rule test and verify RED**

Run:

```bash
npm test -- apps/api/src/room-admission.test.ts
```

Expected: FAIL because `room-admission.ts` does not exist.

- [ ] **Step 3: Implement the pure evaluator**

Create `apps/api/src/room-admission.ts`:

```ts
export type JoinBlockedReason =
  | 'MIDGAME_JOIN_DISABLED'
  | 'PLAYER_LIMIT'
  | 'ROOM_FINISHED';

export type RoomJoinability = {
  canJoin: boolean;
  joinBlockedReason: JoinBlockedReason | null;
};

type AdmissionRoom = {
  status: string;
  allowMidgameJoin: boolean;
  playerLimit: number;
};

export function roomJoinability(
  room: AdmissionRoom,
  activePlayerCount: number,
): RoomJoinability {
  if (['ENDED', 'FINISHED', 'CLOSED'].includes(room.status)) {
    return { canJoin: false, joinBlockedReason: 'ROOM_FINISHED' };
  }
  if (room.status === 'PLAYING' && !room.allowMidgameJoin) {
    return { canJoin: false, joinBlockedReason: 'MIDGAME_JOIN_DISABLED' };
  }
  if (room.status === 'PLAYING' && activePlayerCount >= room.playerLimit) {
    return { canJoin: false, joinBlockedReason: 'PLAYER_LIMIT' };
  }
  return { canJoin: true, joinBlockedReason: null };
}
```

- [ ] **Step 4: Verify the evaluator GREEN**

Run the command from Step 2. Expected: 2 tests pass.

- [ ] **Step 5: Write failing room-summary integration assertions**

Add an integration case that creates five seated players, an independent bank, an unseated member, and a viewer. Assert the viewer's lobby summary stays joinable with no available character, then update the room through the four table states and assert exact DTOs:

```ts
expect(lobbySummary).toMatchObject({
  memberCount: 7,
  playerCount: 5,
  mine: false,
  canJoin: true,
  joinBlockedReason: null,
  availableCharacters: [],
});

expect(disabledPlayingSummary).toMatchObject({
  canJoin: false,
  joinBlockedReason: 'MIDGAME_JOIN_DISABLED',
});
expect(fullPlayingSummary).toMatchObject({
  canJoin: false,
  joinBlockedReason: 'PLAYER_LIMIT',
});
expect(openPlayingSummary).toMatchObject({
  canJoin: true,
  joinBlockedReason: null,
  availableCharacters: [{ id: releasedCharacter.id, name: releasedCharacter.name }],
});
```

Also assert an `ACTIVE` member summary has `mine: true`, while the same row changed to `LEFT` produces `mine: false` and preserves visibility for a private room.

- [ ] **Step 6: Run the focused integration test and verify RED**

Run:

```bash
npm run test:integration -- -t "reports authoritative room joinability and available characters"
```

Expected: FAIL because the summary lacks all three new fields and the old admission helper does not evaluate capacity.

- [ ] **Step 7: Wire list summaries to the evaluator**

Import `roomJoinability`. Replace `listRooms` with the complete implementation below so the room query includes each active member's Player validity fields and enabled characters are fetched once beside the rooms:

```ts
async listRooms(auth: AuthenticatedSession) {
  const [rooms, enabledCharacters] = await Promise.all([
    this.db.room.findMany({
      where: {
        OR: [
          { visibility: 'PUBLIC' },
          { members: { some: { accountId: auth.account.id } } },
        ],
      },
      include: {
        createdByAccount: { select: { displayName: true } },
        members: {
          where: { status: 'ACTIVE' },
          select: {
            accountId: true,
            characterId: true,
            isBank: true,
            character: { select: { name: true } },
            player: { select: { status: true, characterId: true } },
          },
        },
        settlement: { select: { endedAt: true } },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    this.db.character.findMany({
      where: { enabled: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return rooms.map((room) => {
    const mine = room.members.find((member) => member.accountId === auth.account.id);
    const playableMembers = room.members.filter((member) =>
      member.characterId !== null
      && member.player?.status === 'ACTIVE'
      && member.player.characterId === member.characterId,
    );
    const occupied = new Set(playableMembers.map((member) => member.characterId));
    const admission = roomJoinability(room, playableMembers.length);

    return {
      id: room.id,
      name: room.name,
      status: room.status,
      creator: room.createdByAccount.displayName,
      memberCount: new Set(room.members.map((member) => member.accountId)).size,
      playerCount: playableMembers.length,
      playerLimit: room.playerLimit,
      hasPassword: room.passwordHash !== null,
      mine: Boolean(mine),
      characterId: mine?.characterId ?? null,
      myCharacter: mine?.character?.name ?? null,
      isBank: mine?.isBank ?? false,
      canJoin: !mine && admission.canJoin,
      joinBlockedReason: mine ? null : admission.joinBlockedReason,
      availableCharacters: enabledCharacters.filter((character) =>
        !occupied.has(character.id),
      ),
      createdAt: room.createdAt,
      startedAt: room.startedAt,
      endedAt: room.settlement?.endedAt ?? null,
    };
  });
}
```

Replace the private `admissionError` body with a call to `roomJoinability`, or remove it once Task 2 consumes the evaluator directly. Keep `requireSeatAcquisitionAllowed` until Task 2 updates the midgame path.

- [ ] **Step 8: Verify summary GREEN and commit**

Run:

```bash
npm test -- apps/api/src/room-admission.test.ts
npm run test:integration -- -t "reports authoritative room joinability and available characters"
npm run typecheck
git diff --check -- apps/api/src/room-admission.ts apps/api/src/room-admission.test.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts
```

Expected: all commands exit 0. Commit only these task files:

```bash
git add apps/api/src/room-admission.ts apps/api/src/room-admission.test.ts apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts
git commit -m "feat(api): expose room admission state"
```

---

### Task 2: Atomic Midgame Join and Character Acquisition

**Files:**
- Modify: `apps/api/src/account-room-service.ts:1243-1328`
- Modify: `apps/api/src/account-room-service.integration.test.ts`
- Modify: `apps/api/src/prisma-game-service.integration.test.ts:245,268`
- Modify: `apps/api/src/app.ts:385-391`
- Modify: `apps/api/src/server-room-routes.test.ts`

**Interfaces:**
- Changes: `joinRoom(auth, roomId, input: { password?: string; characterId?: string }, key)`.
- Consumes: `roomJoinability` from Task 1 plus existing `playablePlayers`, `allocatePlayerSeat`, `membershipSummary`, and `playerSummary` helpers.
- Produces: lobby membership-only responses and playing membership-plus-Player responses from one endpoint.

- [ ] **Step 1: Write failing service tests for lobby and midgame semantics**

Add focused integration tests that assert:

```ts
const sixth = await service.joinRoom(
  lobbyJoiner.auth,
  lobby.id,
  { password: undefined },
  'unlimited-lobby-sixth',
);
expect(sixth).toMatchObject({ status: 'ACTIVE', characterId: null, isBank: false });

await expect(service.joinRoom(
  disabledJoiner.auth,
  disabledRoom.id,
  { characterId: freeCharacter.id },
  'disabled-playing-join',
)).rejects.toMatchObject({ code: 'MIDGAME_JOIN_DISABLED' });

await expect(service.joinRoom(
  fullJoiner.auth,
  fullRoom.id,
  { characterId: occupiedCharacter.id },
  'full-playing-join',
)).rejects.toMatchObject({ code: 'PLAYER_LIMIT' });

await expect(service.joinRoom(
  missingCharacter.auth,
  openRoom.id,
  {},
  'missing-character-playing-join',
)).rejects.toMatchObject({ code: 'CHARACTER_REQUIRED' });
```

For a successful fresh midgame join, require one `ACTIVE` membership and one `ACTIVE` Player with the requested character, balance `0`, no `INITIAL_BALANCE` entry, and no owned initial palace. For a retained `LEFT` membership with a retained Player, require the same membership and Player IDs and no duplicate initial grant.

- [ ] **Step 2: Write the failing concurrency test**

Create two `AccountRoomService` instances on separate Prisma clients. With one open seat, submit two joins concurrently:

```ts
const outcomes = await Promise.allSettled([
  firstService.joinRoom(firstJoiner.auth, room.id, { characterId: freeCharacter.id }, 'last-seat-a'),
  secondService.joinRoom(secondJoiner.auth, room.id, { characterId: freeCharacter.id }, 'last-seat-b'),
]);

expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
expect(await db.roomMembership.count({
  where: { roomId: room.id, status: 'ACTIVE', characterId: null, isBank: false },
})).toBe(0);
expect(await service.listRooms(losingJoiner.auth)).toContainEqual(
  expect.objectContaining({ id: room.id, mine: false }),
);
```

- [ ] **Step 3: Run the focused integration tests and verify RED**

Run:

```bash
npm run test:integration -- -t "keeps lobby admission unlimited|joins playing rooms atomically|serializes the last midgame seat"
```

Expected: FAIL because the service accepts a password scalar, creates a membership before character selection, and does not reject full rooms during join.

- [ ] **Step 4: Change the join signature and canonical request**

Add this input type near the other account-room request types:

```ts
type JoinRoomInput = { password?: string; characterId?: string };
```

Replace the existing method declaration with this exact signature:

```ts
async joinRoom(
  auth: AuthenticatedSession,
  roomId: string,
  input: JoinRoomInput,
  key: string,
) {
```

Replace the canonical request line with:

```ts
const canonicalRequest = JSON.stringify(canonicalValue({ roomId, ...input }));
```

Update every direct test/service caller in `apps/api/src/account-room-service.integration.test.ts` from `password` to `{ password }` and from `undefined` to `{}`. Update both `V2GameFixtureFacade` calls in `apps/api/src/prisma-game-service.integration.test.ts` to pass `{}`. Update the route caller in `apps/api/src/app.ts` to pass the parsed body object. These are all current `joinRoom` callers, and the mechanical signature update belongs in this task because otherwise the suite cannot compile.

- [ ] **Step 5: Implement the locked playing branch**

Load the current member with its Player because the playing branch must reuse the retained row:

```ts
const current = await tx.roomMembership.findUnique({
  where: { roomId_accountId: { roomId, accountId: auth.account.id } },
  include: { player: true },
});
```

After replay lookup and before password validation, keep an existing `ACTIVE` membership idempotently successful only when the room is a lobby or the member already has a capability:

```ts
if (
  current?.status === 'ACTIVE'
  && (room.status === 'LOBBY' || current.characterId !== null || current.isBank)
) {
  return persist(membershipSummary(current, auth.session.id));
}
```

This lets a legacy `PLAYING` empty membership acquire its character atomically instead of remaining stuck. For every other non-active or empty account, count playable players under the existing room lock and enforce the shared result:

```ts
const playablePlayers = await this.playablePlayers(tx, roomId);
const admission = roomJoinability(room, playablePlayers.length);
if (!admission.canJoin) return persist({ ok: false, error: admission.joinBlockedReason });
if (room.status === 'PLAYING' && !input.characterId) {
  return persist({ ok: false, error: 'CHARACTER_REQUIRED' });
}
```

Branch by phase before password validation. For `LOBBY`, run the password check immediately after the shared admission result and return from this exact membership-only create/reactivate path:

```ts
if (room.status === 'LOBBY') {
  if (
    room.passwordHash
    && (!input.password || !(await verifyPassword(input.password, room.passwordHash)))
  ) {
    await tx.securityLog.create({
      data: {
        accountId: auth.account.id,
        action: 'ROOM_PASSWORD_FAILED',
        detailsJson: { roomId },
      },
    });
    return persist({ ok: false, error: 'ROOM_PASSWORD_INVALID' });
  }
  if (current?.isBank) {
    const activeBank = await tx.roomMembership.findFirst({
      where: {
        roomId,
        status: 'ACTIVE',
        isBank: true,
        id: { not: current.id },
      },
      select: { id: true },
    });
    if (activeBank) return persist({ ok: false, error: 'BANK_ALREADY_TAKEN' });
  }
  const membership = current
    ? await tx.roomMembership.update({
        where: { id: current.id },
        data: {
          status: 'ACTIVE',
          leftAt: null,
          displayNameSnapshot: auth.account.displayName,
          activeSessionId: auth.session.id,
          controlClaimedAt: new Date(),
        },
      })
    : await tx.roomMembership.create({
        data: {
          roomId,
          accountId: auth.account.id,
          displayNameSnapshot: auth.account.displayName,
          activeSessionId: auth.session.id,
          controlClaimedAt: new Date(),
        },
      });
  await tx.securityLog.create({
    data: {
      accountId: auth.account.id,
      action: 'ROOM_JOINED',
      detailsJson: { roomId },
    },
  });
  const state = await tx.room.update({
    where: { id: roomId },
    data: { stateVersion: { increment: 1 } },
    select: { stateVersion: true },
  });
  return persist({
    ...membershipSummary(membership, auth.session.id),
    stateVersion: state.stateVersion,
  });
}
```

For `PLAYING`, validate the requested character and check its live occupancy first, so the exact rejection order remains terminal, disabled, full, occupied character, then password:

```ts
const character = required(await tx.character.findUnique({
  where: { id: input.characterId! },
  include: { initialProperty: true },
}), 'UNKNOWN_CHARACTER');
if (!character.enabled) return persist({ ok: false, error: 'UNKNOWN_CHARACTER' });

const occupied = await tx.roomMembership.findFirst({
  where: {
    roomId,
    status: 'ACTIVE',
    characterId: character.id,
    id: current ? { not: current.id } : undefined,
  },
  select: { id: true },
});
if (occupied) return persist({ ok: false, error: 'ROLE_ALREADY_TAKEN' });

if (
  room.passwordHash
  && (!input.password || !(await verifyPassword(input.password, room.passwordHash)))
) {
  await tx.securityLog.create({
    data: {
      accountId: auth.account.id,
      action: 'ROOM_PASSWORD_FAILED',
      detailsJson: { roomId },
    },
  });
  return persist({ ok: false, error: 'ROOM_PASSWORD_INVALID' });
}

const allocation = this.allocatePlayerSeat(room.playerLimit, playablePlayers, current?.player ?? undefined);
const membership = current
  ? await tx.roomMembership.update({
      where: { id: current.id },
      data: {
        status: 'ACTIVE',
        leftAt: null,
        characterId: character.id,
        isBank: false,
        displayNameSnapshot: auth.account.displayName,
        activeSessionId: auth.session.id,
        controlClaimedAt: new Date(),
      },
    })
  : await tx.roomMembership.create({
      data: {
        roomId,
        accountId: auth.account.id,
        characterId: character.id,
        displayNameSnapshot: auth.account.displayName,
        activeSessionId: auth.session.id,
        controlClaimedAt: new Date(),
      },
    });

const player = current?.player
  ? await tx.player.update({
      where: { id: current.player.id },
      data: { characterId: character.id, status: 'ACTIVE', ...allocation },
    })
  : await tx.player.create({
      data: {
        roomId,
        memberId: membership.id,
        characterId: character.id,
        balance: 0,
        ...allocation,
      },
    });
```

Write both security logs, increment `stateVersion` exactly once, and persist this exact response. Do not create a ledger entry or assign `character.initialProperty` in this branch:

```ts
await tx.securityLog.createMany({
  data: [
    {
      accountId: auth.account.id,
      action: 'ROOM_JOINED',
      detailsJson: { roomId },
    },
    {
      accountId: auth.account.id,
      action: 'CHARACTER_SELECTED',
      detailsJson: { roomId, characterId: character.id },
    },
  ],
});
const state = await tx.room.update({
  where: { id: roomId },
  data: { stateVersion: { increment: 1 } },
  select: { stateVersion: true },
});
return persist({
  ...membershipSummary(membership, auth.session.id),
  player: playerSummary(player),
  stateVersion: state.stateVersion,
});
```

- [ ] **Step 6: Extend the Fastify request contract**

Change the route body and forwarding call:

```ts
const body = z.object({
  password: z.string().max(100).optional(),
  characterId: z.string().optional(),
}).strict().parse(request.body ?? {});
const result = await accounts.joinRoom(
  auth,
  id,
  body,
  idempotencyKey(request.headers['idempotency-key']),
);
```

Update `server-room-routes.test.ts` so an injected `{ password: 'secret', characterId: 'meizhuang' }` request is forwarded unchanged, and a non-string `characterId` returns HTTP 400 without calling the service.

- [ ] **Step 7: Verify atomic join GREEN and commit**

Run:

```bash
npm test -- apps/api/src/server-room-routes.test.ts apps/api/src/room-admission.test.ts
npm run test:integration -- -t "keeps lobby admission unlimited|joins playing rooms atomically|serializes the last midgame seat"
npm run typecheck
git diff --check -- apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/app.ts apps/api/src/server-room-routes.test.ts
```

Expected: all focused cases pass and typecheck exits 0. Commit:

```bash
git add apps/api/src/account-room-service.ts apps/api/src/account-room-service.integration.test.ts apps/api/src/prisma-game-service.integration.test.ts apps/api/src/app.ts apps/api/src/server-room-routes.test.ts
git commit -m "feat(api): join active games with a character"
```

---

### Task 3: Atomic Start Cleanup and Lobby Swap Cancellation

**Files:**
- Modify: `apps/api/src/prisma-game-service.ts:225-237,1242-1288`
- Modify: `apps/api/src/prisma-game-service.integration.test.ts`

**Interfaces:**
- Adds: `StartRemovalEvent = { removedSessionIds: string[] }`.
- Changes: `start(actor, roomId, key, afterCommit?)` without exposing Session IDs in the HTTP response or idempotency record.
- Produces: `LEFT` empty memberships, cancelled pending swaps, one room version increment, and a fresh-commit-only callback.

- [ ] **Step 1: Write the failing successful-start cleanup test**

Build a lobby containing two valid players, a separate bank-only member, one empty member without a Player, and one empty member with a retained Player. Create pending character and bank swap requests. Start through a service with a callback spy, then assert:

```ts
expect(await db.roomMembership.findUniqueOrThrow({ where: { id: bankMembership.id } }))
  .toMatchObject({ status: 'ACTIVE', characterId: null, isBank: true });
for (const membershipId of [emptyMembership.id, retainedMembership.id]) {
  expect(await db.roomMembership.findUniqueOrThrow({ where: { id: membershipId } }))
    .toMatchObject({ status: 'LEFT', characterId: null, isBank: false, activeSessionId: null });
}
expect(await db.player.findUniqueOrThrow({ where: { id: retainedPlayer.id } }))
  .toMatchObject({ status: 'LEFT', characterId: null });
expect(await db.roleSwapRequest.findMany({
  where: { roomId: room.id, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } },
})).toEqual([]);
expect(await db.roleSwapRequest.findMany({ where: { roomId: room.id } }))
  .toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'CANCELLED', rejectionReason: 'ROOM_STARTED' }),
  ]));
expect(afterCommit).toHaveBeenCalledOnce();
expect(afterCommit).toHaveBeenCalledWith({
  removedSessionIds: expect.arrayContaining([emptySession.id, retainedSession.id]),
});
```

Also assert one `START_ROOM` audit, one removal audit/security log per removed member, and exactly one electronic active turn belonging to a retained playable player.

- [ ] **Step 2: Write failing drift, rollback, and replay tests**

Create an `ACTIVE` character-bearing membership whose associated Player is missing, inactive, or has a different `characterId`; require `PLAYER_IDENTITY_MISMATCH` and assert start does not clean members, cancel swaps, change room state, write audit/security records, or create a turn. With only one valid player plus empty members, require `PLAYER_COUNT_OUT_OF_RANGE` with the same no-mutation assertions. Then start a valid room twice with the same key and assert the callback, removal audits, swap cancellation, and first turn occur only once.

- [ ] **Step 3: Run the focused start tests and verify RED**

Run:

```bash
npm run test:integration -- -t "removes capability-less lobby members when starting|rejects player identity drift at start|rolls start cleanup back|replays start cleanup once"
```

Expected: FAIL because start currently changes only the room and first turn.

- [ ] **Step 4: Add the safe callback interface**

Add and export:

```ts
export type StartRemovalEvent = { removedSessionIds: string[] };
```

Replace the current `start` declaration with this exact declaration and local callback state, keeping Session IDs outside the returned value:

```ts
async start(
  actor: GameActor,
  roomId: string,
  key: string,
  afterCommit?: (event: StartRemovalEvent) => void | Promise<void>,
) {
  let removedSessionIds: string[] = [];
```

At the end of the existing `executeIdempotent` call, replace the closing callback and call terminator with these exact arguments:

```ts
      return { id: roomId, status: 'PLAYING' };
    },
    undefined,
    () => true,
    async () => afterCommit?.({ removedSessionIds }),
  );
}
```

`executeIdempotent` already invokes its callback only when `execution.created === true` and catches notification failures after commit. Do not place `removedSessionIds` in the returned object or persisted idempotency response.

- [ ] **Step 5: Implement cleanup inside the existing start transaction**

Immediately after loading the room, reject a non-lobby phase. Then load every character-bearing active membership and reject identity drift before deriving the playable list or mutating any row:

```ts
if (room.status !== 'LOBBY') fail('ROOM_NOT_IN_LOBBY');
const characterMembers = await tx.roomMembership.findMany({
  where: { roomId, status: 'ACTIVE', characterId: { not: null } },
  include: { player: true },
});
if (characterMembers.some((member) =>
  !member.player
  || member.player.status !== 'ACTIVE'
  || member.player.characterId !== member.characterId,
)) {
  fail('PLAYER_IDENTITY_MISMATCH');
}
const players = await this.playablePlayers(tx, roomId);
if (players.length < 2 || players.length > room.playerLimit) {
  fail('PLAYER_COUNT_OUT_OF_RANGE');
}
```

After validation, use one timestamp and update all pending swaps and empty members before changing room status:

```ts
const at = new Date();
const emptyMembers = await tx.roomMembership.findMany({
  where: { roomId, status: 'ACTIVE', characterId: null, isBank: false },
  include: { player: true },
});
removedSessionIds = [...new Set(emptyMembers.flatMap((member) =>
  member.activeSessionId ? [member.activeSessionId] : [],
))];

await tx.roleSwapRequest.updateMany({
  where: { roomId, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } },
  data: { status: 'CANCELLED', rejectionReason: 'ROOM_STARTED', resolvedAt: at },
});

for (const member of emptyMembers) {
  if (member.player) {
    await tx.player.update({
      where: { id: member.player.id },
      data: { status: 'LEFT', characterId: null },
    });
  }
  await tx.roomMembership.update({
    where: { id: member.id },
    data: {
      status: 'LEFT',
      characterId: null,
      isBank: false,
      activeSessionId: null,
      controlClaimedAt: null,
      leftAt: at,
    },
  });
  await tx.auditLog.create({
    data: {
      roomId,
      actorMemberId: bank.id,
      actorRole: 'BANK',
      action: 'ROOM_START_MEMBER_REMOVED',
      entityType: 'RoomMembership',
      entityId: member.id,
      beforeJson: { status: 'ACTIVE', characterId: null, isBank: false },
      afterJson: { status: 'LEFT', characterId: null, isBank: false },
      reason: 'ROOM_STARTED_WITHOUT_CAPABILITY',
      createdAt: at,
    },
  });
  await tx.securityLog.create({
    data: {
      accountId: member.accountId,
      actorAccountId: actor.accountId,
      action: 'ROOM_START_MEMBER_REMOVED',
      detailsJson: { roomId, membershipId: member.id, reason: 'ROOM_STARTED_WITHOUT_CAPABILITY' },
      createdAt: at,
    },
  });
}
```

Finish the transaction callback with the guarded transition, the shared `at` timestamp, first electronic turn, and start audit. Use the playable list loaded before cleanup; empty members are not in it. The outer `executeIdempotent` performs the only `stateVersion` increment:

```ts
const claimed = await tx.room.updateMany({
  where: { id: roomId, status: 'LOBBY' },
  data: {
    status: 'PLAYING',
    startedAt: room.startedAt ?? at,
    currentTurnPlayerId: null,
    turnNumber: null,
  },
});
if (claimed.count !== 1) fail('ROOM_NOT_IN_LOBBY');
if (room.diceMode === 'ELECTRONIC') {
  await this.createNextActionableTurn(tx, roomId, players, 0, 1);
}
await tx.auditLog.create({
  data: {
    roomId,
    actorMemberId: bank.id,
    actorRole: 'BANK',
    action: 'START_ROOM',
    entityType: 'Room',
    entityId: roomId,
    afterJson: { status: 'PLAYING' },
    createdAt: at,
  },
});
return { id: roomId, status: 'PLAYING' };
```

- [ ] **Step 6: Add concurrent-start coverage**

Start the same valid room through two service instances with different keys. Assert exactly one fulfilled start, one `ROOM_NOT_IN_LOBBY` rejection, one `START_ROOM` audit, one set of removal audits, one callback, and one active first turn.

- [ ] **Step 7: Verify start behavior GREEN and commit**

Run:

```bash
npm run test:integration -- -t "removes capability-less lobby members when starting|rejects player identity drift at start|rolls start cleanup back|replays start cleanup once|serializes concurrent starts"
npm run typecheck
git diff --check -- apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts
```

Expected: all focused cases pass. Commit:

```bash
git add apps/api/src/prisma-game-service.ts apps/api/src/prisma-game-service.integration.test.ts
git commit -m "feat(api): remove empty members at game start"
```

---

### Task 4: Post-Commit Session Eviction and Client Reconciliation

**Files:**
- Modify: `apps/api/src/app.ts:196-208,431`
- Modify: `apps/api/src/app-socket.test.ts`
- Modify: `apps/api/src/server-room-routes.test.ts`
- Modify: `apps/web/app/components/app-router-client.tsx:1765-1845`
- Modify: `apps/web/app/components/app-router-client.test.ts`
- Modify: `tests/e2e/task7-workflows.spec.ts`

**Interfaces:**
- Extends: `room.subscription-rejected` payload with optional `reason`.
- Exact start-removal payload: `{ roomId, reason: 'ROOM_STARTED_WITHOUT_CAPABILITY' }`.
- Consumes: `PrismaGameService.start(..., afterCommit)` from Task 3.

- [ ] **Step 1: Write the failing Socket route test**

Create a Socket harness whose mocked `games.start` invokes its callback with two Session IDs. Subscribe the affected client to `room-a`, invoke the start route, and assert:

```ts
await expect(rejected).resolves.toEqual({
  roomId: 'room-a',
  reason: 'ROOM_STARTED_WITHOUT_CAPABILITY',
});
expect(serverSocket?.rooms.has('room:room-a')).toBe(false);
expect(serverSocket?.data.subscribedRoomId).toBeUndefined();
expect(startResponse.statusCode).toBe(200);
```

Also assert a replay that does not invoke the service callback emits no second rejection.

- [ ] **Step 2: Run the Socket test and verify RED**

Run:

```bash
npm test -- apps/api/src/app-socket.test.ts -t "evicts capability-less members after start commits"
```

Expected: FAIL because the start route has no callback and the removal helper cannot carry a reason.

- [ ] **Step 3: Add the reason-aware eviction helper and start callback**

Change the helper without changing existing callers:

```ts
const removeSessionFromRoom = (
  sessionId: string,
  roomId: string,
  reason?: string,
) => {
  const sessionRoom = sessionChannel(sessionId);
  io.to(sessionRoom).emit('room.subscription-rejected', {
    roomId,
    ...(reason ? { reason } : {}),
  });
  io.in(sessionRoom).socketsLeave(roomChannel(roomId));
  for (const socket of io.sockets.sockets.values()) {
    if (socket.rooms.has(sessionRoom) && socket.data.subscribedRoomId === roomId) {
      delete socket.data.subscribedRoomId;
    }
  }
};
```

Expand the start route and send only after the service transaction commits:

```ts
const result = await games.start(
  gameActor(auth),
  id,
  idempotencyKey(request.headers['idempotency-key']),
  ({ removedSessionIds }) => {
    for (const sessionId of removedSessionIds) {
      removeSessionFromRoom(sessionId, id, 'ROOM_STARTED_WITHOUT_CAPABILITY');
    }
  },
);
notifyVersion(id, result);
return games.snapshot(gameActor(auth), id, 'BANK');
```

Update `server-room-routes.test.ts` to require the fourth callback argument and verify the HTTP response never contains a Session ID.

- [ ] **Step 4: Write failing frontend removal-event tests**

Add structural assertions for reason parsing and a browser workflow that opens an unseated member's seat page, emits the exact event, and expects:

```ts
await expect(page).toHaveURL(/\/rooms$/);
await expect(page.getByRole('alert')).toContainText(
  '游戏已开始，你因未选择人物或银行身份已退出房间',
);
await expect(page.getByRole('region', { name: '我参与的游戏' }))
  .not.toContainText('碎玉轩夜局');
await expect(page.getByRole('region', { name: '可加入房间' }))
  .toContainText('碎玉轩夜局');
```

- [ ] **Step 5: Run the focused frontend tests and verify RED**

Run:

```bash
npm test -- apps/web/app/components/app-router-client.test.ts
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-workflows.spec.ts --grep "returns a member removed at start to the room list"
```

Expected: FAIL because the handler treats every subscription rejection as a generic refresh and does not leave the room or show the reason.

- [ ] **Step 6: Implement reason-specific reconciliation**

Parse the optional reason in `onRoomSubscriptionLost`. For the exact start-removal reason, clear the room runtime, navigate with replacement, set the rejection banner, and reload rooms:

```ts
if (notification?.reason === 'ROOM_STARTED_WITHOUT_CAPABILITY') {
  clearRoomState();
  go('/rooms', true);
  setError('游戏已开始，你因未选择人物或银行身份已退出房间');
  void loadRooms().catch((caught) => void handleFailure(caught));
  return;
}
```

Keep existing `room.control.changed` and reason-less `room.subscription-rejected` behavior unchanged.

- [ ] **Step 7: Verify eviction GREEN and commit**

Run:

```bash
npm test -- apps/api/src/app-socket.test.ts apps/api/src/server-room-routes.test.ts apps/web/app/components/app-router-client.test.ts
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-workflows.spec.ts --grep "returns a member removed at start to the room list"
npm run typecheck
git diff --check -- apps/api/src/app.ts apps/api/src/app-socket.test.ts apps/api/src/server-room-routes.test.ts apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts tests/e2e/task7-workflows.spec.ts
```

Expected: focused tests pass and no Session identifier appears in an HTTP body. Commit:

```bash
git add apps/api/src/app.ts apps/api/src/app-socket.test.ts apps/api/src/server-room-routes.test.ts apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts tests/e2e/task7-workflows.spec.ts
git commit -m "feat: reconcile members removed at game start"
```

---

### Task 5: Accurate Room Badges and Midgame Join Form

**Files:**
- Modify: `apps/web/app/components/app-router-client.tsx:567-583,887-903,1345-1371,2387-2435`
- Modify: `apps/web/app/components/app-router-client.test.ts`
- Modify: `apps/web/app/globals.css:245-251`
- Modify: `apps/web/app/globals.css.test.ts`
- Modify: `tests/e2e/browser-fixture-types.ts`
- Modify: `tests/e2e/task7-visual.spec.ts`
- Modify: `tests/e2e/task7-workflows.spec.ts`

**Interfaces:**
- Consumes summary fields from Task 1: `canJoin`, `joinBlockedReason`, `availableCharacters`.
- Sends Task 2 join body: `{ password?: string; characterId?: string }`.
- Adds badge tone: `unavailable` with label `不可加入`.

- [ ] **Step 1: Update browser fixture types and write failing badge tests**

Add to both `RoomSummary` and `BrowserRoomSummary`:

```ts
canJoin: boolean;
joinBlockedReason: 'MIDGAME_JOIN_DISABLED' | 'PLAYER_LIMIT' | 'ROOM_FINISHED' | null;
availableCharacters: Array<{ id: string; name: string }>;
```

Update shared fixture builders with joinable defaults. Extend the visual badge matrix:

```ts
const blockedDisabled = room({
  id: 'blocked-disabled',
  status: 'PLAYING',
  mine: false,
  canJoin: false,
  joinBlockedReason: 'MIDGAME_JOIN_DISABLED',
});
const blockedFull = room({
  id: 'blocked-full',
  status: 'PLAYING',
  mine: false,
  canJoin: false,
  joinBlockedReason: 'PLAYER_LIMIT',
});

for (const blocked of [blockedDisabled, blockedFull]) {
  const item = page.getByRole('button', { name: new RegExp(blocked.name) });
  await expect(item.locator('.room-status-badge')).toHaveText(['不可加入', '游戏中']);
}
```

- [ ] **Step 2: Write failing blocked-click and atomic-form tests**

Add browser workflows that assert:

```ts
await page.getByRole('button', { name: /禁止中途加入房间/ }).click();
await expect(page).toHaveURL(/\/rooms$/);
await expect(page.getByRole('alert')).toContainText('房间已开局，且不允许中途加入');

await page.getByRole('button', { name: /人数已满房间/ }).click();
await expect(page.getByRole('alert')).toContainText('房间人物已满，暂时无法加入');
```

For a joinable playing room, select `沈眉庄`, submit, and capture the request:

```ts
expect(joinPayload).toEqual({ password: 'secret', characterId: 'meizhuang' });
```

Return `ROLE_ALREADY_TAKEN` from the first submit, refresh the room summaries with a different available character, and assert the user remains on the join page with the specific message and can select again.

- [ ] **Step 3: Run the focused frontend tests and verify RED**

Run:

```bash
npm test -- apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css.test.ts
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-visual.spec.ts tests/e2e/task7-workflows.spec.ts --grep "room admission|midgame join"
```

Expected: FAIL on missing summary fields, unavailable tone, blocked click handling, and character payload.

- [ ] **Step 4: Implement badge and blocked-room behavior**

Extend the badge union and derive identity/admission independently from phase:

```ts
type RoomStatusBadge = {
  label: '已加入' | '可加入' | '不可加入' | '准备中' | '游戏中' | '已结束';
  tone: 'joined' | 'joinable' | 'unavailable' | 'lobby' | 'playing' | 'ended';
};

const accessBadge = room.mine
  ? { label: '已加入' as const, tone: 'joined' as const }
  : room.canJoin
    ? { label: '可加入' as const, tone: 'joinable' as const }
    : { label: '不可加入' as const, tone: 'unavailable' as const };
```

In `openRoom`, stop before navigation when a non-member summary is blocked:

```ts
if (!room.mine && !terminalRoom(room.status) && !room.canJoin) {
  const code = room.joinBlockedReason;
  setError(code ? API_ERROR_MESSAGES[code] : '当前无法加入该房间');
  return;
}
```

Use exact messages:

```ts
MIDGAME_JOIN_DISABLED: '房间已开局，且不允许中途加入。',
PLAYER_LIMIT: '房间人物已满，暂时无法加入。',
ROLE_ALREADY_TAKEN: '所选人物刚刚已被其他玩家选择，请重新选择。',
```

Add `.room-status-unavailable { background: #626963; }` and keep badge radius at 6px.

- [ ] **Step 5: Implement the playing-room join form and payload**

Change the callback to accept one object:

```ts
type JoinRoomInput = { password?: string; characterId?: string };
```

In `JoinRoom`, track `characterId`, render a native select only for `PLAYING`, and disable submission until both required values exist:

```tsx
{room.status === 'PLAYING' && (
  <label>
    选择人物
    <select value={characterId} onChange={(event) => setCharacterId(event.target.value)}>
      <option value="">请选择人物</option>
      {room.availableCharacters.map((character) => (
        <option key={character.id} value={character.id}>{character.name}</option>
      ))}
    </select>
  </label>
)}
```

Submit:

```ts
onJoin({
  ...(password ? { password } : {}),
  ...(room.status === 'PLAYING' ? { characterId } : {}),
});
```

The controller sends that object unchanged. On `ROLE_ALREADY_TAKEN` or `PLAYER_LIMIT`, reload summaries, replace `selectedRoom` from the returned room ID, and retain the server error banner so the options refresh without navigating to an invalid seat page.

- [ ] **Step 6: Preserve lobby admin bank candidates**

Add an integration assertion to the existing admin room detail test and a frontend structural assertion:

```ts
expect(detail.members).toContainEqual(expect.objectContaining({
  id: unseatedMembership.id,
  characterId: null,
  isBank: false,
}));
expect(component).toContain('selectedRoom.members.map((member) => (');
```

Do not add a `characterId` filter to `getAdminRoom` or the dropdown.

- [ ] **Step 7: Verify frontend GREEN and commit**

Run:

```bash
npm test -- apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css.test.ts
npm run test:integration -- -t "keeps unseated active members available for bank reassignment"
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-visual.spec.ts tests/e2e/task7-workflows.spec.ts --grep "room admission|midgame join"
npm run typecheck
git diff --check -- apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css apps/web/app/globals.css.test.ts tests/e2e/browser-fixture-types.ts tests/e2e/task7-visual.spec.ts tests/e2e/task7-workflows.spec.ts apps/api/src/account-room-service.integration.test.ts
```

Expected: badge, click, form, stale-data, and admin-candidate tests pass. Commit:

```bash
git add apps/web/app/components/app-router-client.tsx apps/web/app/components/app-router-client.test.ts apps/web/app/globals.css apps/web/app/globals.css.test.ts tests/e2e/browser-fixture-types.ts tests/e2e/task7-visual.spec.ts tests/e2e/task7-workflows.spec.ts apps/api/src/account-room-service.integration.test.ts
git commit -m "feat(web): show authoritative room admission"
```

---

### Task 6: Real-Stack Lifecycle and Whole-Feature Verification

**Files:**
- Modify: `tests/e2e/task7-real-stack.spec.ts`
- Verify: every file listed in Tasks 1-5

**Interfaces:**
- Consumes all production contracts from Tasks 1-5.
- Produces final behavior evidence; no additional production interface.

- [ ] **Step 1: Add the real-stack lifecycle scenario**

Use real Cookie Sessions and API calls to create these accounts: two character players, one bank-only member, one unseated member, and one later joiner. Verify this sequence through HTTP plus direct read-only Prisma assertions:

```ts
expect(beforeStartSummary).toMatchObject({ mine: true, status: 'LOBBY' });
expect(afterStartMembership).toMatchObject({
  status: 'LEFT',
  characterId: null,
  isBank: false,
  activeSessionId: null,
});
expect(afterStartSummary).toMatchObject({
  mine: false,
  status: 'PLAYING',
  canJoin: true,
  joinBlockedReason: null,
});
expect(bankMembership).toMatchObject({ status: 'ACTIVE', isBank: true });
```

Join the later account with a chosen character and assert it immediately appears in the game snapshot at balance `0`. Then fill the fifth character and assert another account receives `PLAYER_LIMIT`. In a second room with `allowMidgameJoin: false`, assert the removed member receives `MIDGAME_JOIN_DISABLED` even when all five characters are occupied.

- [ ] **Step 2: Run the focused real-stack acceptance test**

Run against the completed production changes from Tasks 1-5:

```bash
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-real-stack.spec.ts --grep "cleans the lobby roster and enforces midgame admission"
```

Expected: PASS against the Docker application and disposable test data.

- [ ] **Step 3: Run the complete non-database suite**

Run:

```bash
npm test
```

Expected: Vitest reports zero failures. Database-gated suites may skip only when `TEST_DATABASE_URL` is not configured.

- [ ] **Step 4: Run the complete PostgreSQL integration suite**

Use the validated isolated test database documented in `README.md`:

```bash
TEST_DATABASE_URL='postgresql://zhenhuan:zhenhuan@localhost:55432/zhenhuan_test?schema=public' npm run test:integration
```

Expected: all integration tests pass and the disposable schema is dropped. Never substitute the development or production database URL.

- [ ] **Step 5: Start or refresh the Docker stack and run browser coverage**

First inspect for host-side project Node processes:

```bash
ps -axo pid=,command= | rg '/Users/harry/Documents/甄嬛传大富翁/monopoly-zhenhuan/.*(next|tsx|node)'
```

Stop only confirmed stale processes from this repository, then run:

```bash
docker compose up -d --build
docker compose ps
PLAYWRIGHT_EXTERNAL_STACK=1 npx playwright test tests/e2e/task7-visual.spec.ts tests/e2e/task7-workflows.spec.ts tests/e2e/task7-real-stack.spec.ts --project=desktop-chromium --project=iphone-webkit
```

Expected: Postgres, API, and Web are healthy/running; all selected desktop and iPhone projects pass on port 3000.

- [ ] **Step 6: Run static quality gates**

Run:

```bash
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0 with no lint warnings, type errors, build errors, or whitespace errors. If Next rewrites `apps/web/next-env.d.ts`, retain only a change required by the feature; otherwise restore the generated path to its pre-run contents without touching unrelated files.

- [ ] **Step 7: Review exact invariants and commit the real-stack test**

Review the final diff against this checklist:

```text
[ ] lobby membership remains unlimited
[ ] only no-character/non-bank members are removed
[ ] bank-only and dual-capability members remain active
[ ] pending lobby swaps are cancelled atomically
[ ] failed/replayed/concurrent start has no duplicate effects
[ ] midgame join is character-atomic and grants no initial resources
[ ] disabled/full error priority is stable
[ ] list grouping and badges use server joinability
[ ] removed clients return to the room list with the exact reason
[ ] admin bank candidates still include unseated active members
[ ] no Session ID is exposed in REST or idempotency payloads
[ ] no schema migration or persisted joinability field was added
```

Fix any failed item and rerun its focused test plus Steps 3-6. Then commit only the real-stack test if it was not committed with an earlier task:

```bash
git add tests/e2e/task7-real-stack.spec.ts
git commit -m "test: cover room start admission lifecycle"
```
