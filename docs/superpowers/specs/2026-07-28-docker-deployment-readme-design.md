# Docker Deployment README Design

## Goal

Rewrite the README deployment guidance so an operator can deploy the application to a new Linux server using only Docker Compose, a domain name, and existing TLS certificate files.

## Scope

- Preserve the project overview, local-development instructions, API contract, data-consistency notes, and test guidance.
- Replace the abbreviated production-deployment section with a linear Docker deployment runbook.
- Document prerequisites: Docker Compose, a public domain resolving to the server, ports 80 and 443, and TLS certificate/key files available on the host.
- Provide an exact protected environment-file template containing every variable required by `docker-compose.prod.yml`, including `SUPER_ADMIN_USERNAMES`.
- Explain the deployment sequence: obtain source, create the environment file, build images, start services, inspect status and logs, and verify HTTPS health.
- Explain routine operations: upgrade, service status, logs, restart, database backup, and rollback boundaries.
- State operational constraints already encoded in Compose: only Nginx exposes host ports, the database/API/Web remain on the internal Docker network, persistent database data lives in the named volume, and the API must remain at one replica until Socket.IO uses a shared adapter.

## Accuracy Rules

- Commands must use `docker-compose.prod.yml` and the external production environment file.
- The TLS paths must be absolute host paths because Compose bind-mounts them into Nginx.
- `APP_ORIGIN` and `NEXT_PUBLIC_API_URL` must use the same public HTTPS origin.
- The README must not claim automatic certificate issuance or automatic database backup, because the current configuration does neither.
- Database restore is intentionally out of scope: it is destructive and needs an operator-selected backup target.

## Verification

- Validate that all Compose-required variables appear in the README template.
- Validate command syntax with `docker compose --env-file ... -f docker-compose.prod.yml config` after substituting non-sensitive sample values.
- Review rendered Markdown headings, code fences, and internal links.
