# Account Logout Confirmation Design

## Goal

Prevent an accidental logout from the room lobby by requiring an explicit
confirmation, consistent with the existing "return to room list" action.

## Interaction

1. In the room lobby, clicking the account "退出" button opens the shared
   `ConfirmDialog` instead of calling the logout endpoint immediately.
2. The dialog is titled "确认退出账号" and explains that signing out requires a
   fresh login before returning to the game.
3. "取消" closes the dialog without changing session, account, rooms, or route.
4. "确认退出" calls the existing logout callback. The existing successful logout
   flow clears local session-related state and navigates to the home page.
5. While the logout request is pending, both dialog actions follow the existing
   busy state behavior to prevent duplicate submission.

## Scope And Compatibility

- Reuse the current accessible `ConfirmDialog`, including focus management and
  Escape cancellation.
- Keep the existing `/api/auth/logout` request and all logout cleanup unchanged.
- Do not add a second server-side confirmation step or change account/session
  APIs.

## Verification

An end-to-end browser test will verify that the first click opens the dialog
without making a logout request, cancelling preserves the lobby, and confirming
sends exactly one logout request and returns the user to the home page.
