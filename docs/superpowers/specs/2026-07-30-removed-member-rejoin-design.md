# Removed Member Rejoin Design

## Goal

Allow an account removed from a room by an administrator to join that same room again when the room's normal admission rules permit it.

## Behavior

- Administrative removal continues to set the membership and its player record to `LEFT`, clear the character and bank capabilities, revoke control, and retain history.
- A subsequent `POST /api/rooms/:id/join` by the same account reactivates the retained membership rather than creating a second membership.
- Reactivation sets `status` to `ACTIVE`, clears `leftAt`, refreshes the display-name snapshot, and assigns the current session as controller.
- Reactivation does not restore the prior character, bank capability, player status, assets, or other removed privileges.
- A `PLAYING` room still requires `allowMidgameJoin`; terminal rooms remain unavailable.

## Data Integrity

The existing unique `(roomId, accountId)` membership constraint remains unchanged. Reusing the retained row preserves audit and historical foreign-key references while avoiding duplicate memberships.

## Verification

An API integration test will remove a member, join with that account again, and assert that the same membership becomes active with no restored role or player capability. Existing admission tests remain responsible for terminal and midgame restrictions.
