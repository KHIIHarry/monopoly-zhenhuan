# Task 6 admin preflight

Read-only audit performed against the V2.1 product authority and corrected goal objective.

## Critical gates

- Add super-admin inspection and forced revocation of another account's Sessions using the same masked, allowlisted device DTO as self-service device management.
- Persist account-scoped idempotency for every admin write, including create/update/reset/status/device/room operations and forced finish.
- Keep every privileged mutation and its `SecurityLog` row in one transaction.
- Provide all-room administration plus safe SecurityLog/AuditLog read APIs. Super-admin access must not depend on occupying that room's bank seat.

## Important gates

- Map duplicate usernames to a stable 409 public error such as `USERNAME_TAKEN`.
- Map `ADMIN_REQUIRED` to 403, not 401.
- Dashboard aggregates include account/session/room counts, average duration, character-selection counts, and win counts. Do not return raw internal rows as the dashboard contract.
- Account CRUD keeps `isSuperAdmin` and `canCreateRoom` independently editable; password reset and disable revoke all target Sessions atomically.
- Add real authenticated positive/negative integration and route coverage rather than fabricated admin objects.

## Required admin room surfaces

- List/search rooms and inspect configuration, members, current character/bank capabilities, settlement, and logs.
- Edit supported room configuration/password within lifecycle constraints.
- Remove a member and change the bank capability without creating a second membership/Player/assets or violating immutable history.
- Force finish with a required reason through the Task 5 settlement transaction.

## Required coverage

- Admin versus ordinary-account authorization for every route family.
- Same-key replay, changed-payload rejection, cross-account isolation, and concurrent duplicate requests.
- Username uniqueness and atomic security logging.
- Target-device inspection/revocation with masked IPs and immediate Session invalidation.
- Independent permission toggles and revocation on reset/disable.
- Room administration and safe log DTOs.
- Character-selection and settlement-win dashboard aggregates.
