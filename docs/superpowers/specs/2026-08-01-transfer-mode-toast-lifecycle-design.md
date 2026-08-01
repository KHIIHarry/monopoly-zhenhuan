# Transfer Mode Toast Lifecycle Design

## Goal

Make every player transfer submission and bank decision report its authoritative outcome through the existing Toast queue, including rooms whose transfer approval mode changes while a game is already running.

## Root Cause

The player client currently displays a fixed success message after every successful transfer API call:

`转帐已提交，结果已同步至账本或审批队列`

That message does not inspect the server response and therefore cannot distinguish an immediately executed transfer from a newly pending approval. Reading the client snapshot's `transferApprovalRequired` value would still be unsafe because an administrator can change the mode between snapshot refresh and submission.

The transfer service already reads `room.transferApprovalRequired` inside the serialized transfer transaction and returns `status: 'EXECUTED'` or `status: 'PENDING'`. The response status is the authoritative mode decision for that submission.

## Confirmed Notification Matrix

| Scenario | Player Toast | Bank Toast |
| --- | --- | --- |
| Approval disabled, transfer succeeds | `转账已成功，结果已同步至账本` | Existing committed fund-flow Toast |
| Approval disabled, transfer fails | Red: `转账失败：{reason}` | None |
| Approval enabled, request commits | `转账已提交，请等待银行审批` | Player recipient: `收到{payerName}的转账申请：向{recipientName}支付 {amount} 两`; bank recipient: `收到{payerName}的转账申请：向银行支付 {amount} 两` |
| Approval enabled, request creation fails after reaching the server | Red: `转账申请提交失败：{reason}` | Red: `{payerName}的转账申请提交失败：{reason}` |
| Bank approval succeeds | `银行审批通过，转账已成功，结果已同步至账本` | Existing committed fund-flow Toast |
| Bank approval execution fails | Red: `银行审批执行失败：{reason}` | Red local Toast with the same reason; request remains pending |
| Bank explicitly rejects | Red: `转账申请已被银行拒绝：{reason}` | Local rejection-success Toast |

Player-to-player and player-to-bank requests use recipient-specific bank wording. The payer receives the lifecycle message; a receiving player still receives the existing incoming-funds Toast when money actually moves.

`payerName` and `recipientName` are persisted room display names, `amount` is the server-calculated actual transfer amount, and `reason` is a safe localized display reason or the bank-entered rejection reason.

## Authoritative Mode Handling

The player client must branch on the transfer API response status, never on a cached room setting:

- `EXECUTED` means the transfer committed immediately.
- `PENDING` means the server committed an approval request.

This remains correct if an administrator changes `transferApprovalRequired` during the game or immediately before submission. The existing room-version event continues refreshing bank snapshots so a committed pending request appears in the approval list.

## Realtime Event Model

Extend the existing realtime Toast event kind with:

- `TRANSFER_REQUESTED`: a committed pending request delivered to the active bank Session.
- `TRANSFER_APPROVED`: a committed approved transfer delivered to the payer Session.
- `TRANSFER_FAILED`: a red failure notification delivered to the affected player or bank Session.

Continue using `REQUEST_REJECTED` for an explicit bank rejection and `FUNDS` for ordinary committed money movement. The client maps `TRANSFER_FAILED` and `REQUEST_REJECTED` to the existing red Toast tone; the other kinds use the green success tone.

Success events are emitted only after a fresh transaction commits. Replaying the same idempotency key must not emit another event. Delivery remains best-effort and cannot roll back committed money, requests, or decisions.

## Submission Failure Boundary

If a player's network request never reaches the server, only that player can report the network failure. The bank cannot reliably know that an unobserved attempt occurred.

If the server receives an approval-mode transfer but request creation fails, the service retains the authoritative mode observed during that transaction attempt and best-effort notifies the active bank Session. The player receives the same safe reason through the failed API response.

Failure messages use a bounded Chinese display-reason mapping for known domain error codes. Raw stack traces, SQL details, and internal exception text must never enter a Toast. Unknown errors use a generic retry message.

## Approval Failure And Rejection

When approving a `PLAYER_TRANSFER` fails before commit, the persisted request remains `PENDING`. The bank receives a local red Toast from the API failure and the payer receives a realtime `TRANSFER_FAILED` event explaining that approval execution failed. A stable failure event ID prevents duplicate delivery for the same request and reason.

When the bank explicitly rejects a transfer, the existing persisted rejection builder delivers the bank-entered reason to the payer. Its transfer wording is changed to the confirmed copy without affecting other request types.

## Client Feedback

Add a small error-Toast path alongside `showNotice`. Transfer submission and bank approval actions retain the existing inline error state for accessibility and diagnostics, while also enqueueing the red Toast required for immediate feedback. Toast duration, FIFO behavior, deduplication, pointer behavior, and responsive styling remain unchanged.

## Testing

- Unit-test authoritative response-to-copy mapping for `EXECUTED` and `PENDING`.
- Unit-test red local feedback for transfer submission and approval errors.
- Builder-test bank request delivery, approval delivery, failure delivery, exact copy, active Session targeting, missing Session handling, and stable IDs.
- PostgreSQL-test immediate execution, pending creation, approval, approval failure, rejection, and idempotent replay.
- Test a `PLAYING` room changed by the admin API from approval disabled to enabled and back to disabled; each subsequent submission must follow the current server setting.
- Socket-test bank-only request delivery and payer-only approval/failure/rejection delivery.
- Docker-backed Playwright-test player-to-player and player-to-bank flows on desktop and mobile, including mode changes during an active game.

## Scope Boundaries

- Do not add durable delivery acknowledgements or a notification outbox.
- Do not notify the bank about a client request that never reached the server.
- Do not replace the ledger or pending approval list.
- Do not change transfer accounting, approval semantics, Toast duration, or queue behavior.
- Preserve all unrelated uncommitted work in shared files.
