# Docker Deployment README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the abbreviated production-deployment README section with a complete, accurate Docker Compose runbook.

**Architecture:** Keep the application and local-development documentation unchanged. Replace only the `## Production Deployment` section with ordered operator instructions derived from `docker-compose.prod.yml`, `Dockerfile`, and `deploy/nginx.conf`; validate the documented environment-file schema through Compose configuration rendering.

**Tech Stack:** Markdown, Docker Compose, Docker, Nginx, PostgreSQL

## Global Constraints

- Use `docker-compose.prod.yml` and a production environment file located outside the repository.
- Include every variable required by `docker-compose.prod.yml`, with `APP_ORIGIN` and `NEXT_PUBLIC_API_URL` set to the same HTTPS origin.
- Document absolute TLS certificate and key paths mounted from the host.
- Do not claim automatic TLS issuance, automatic database backups, or multi-replica API support.
- Preserve the local-development, API, data-consistency, and testing README sections.

---

### Task 1: Rewrite and Validate Production Deployment Documentation

**Files:**
- Modify: `README.md:119-153`
- Test: `docker-compose.prod.yml` through Docker Compose configuration rendering

**Interfaces:**
- Consumes: Required Compose variables `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL`, `APP_ORIGIN`, `NEXT_PUBLIC_API_URL`, `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_DISPLAY_NAME`, `SUPER_ADMIN_USERNAMES`, `TLS_CERT_PATH`, and `TLS_KEY_PATH`.
- Produces: A self-contained README runbook for a public HTTPS Docker deployment.

- [ ] **Step 1: Replace the production deployment section with the Docker runbook**

  Update `README.md` from `## Production Deployment` through the next `## API Contract` heading. Include the following exact sections in this order: prerequisites, deployment topology, server preparation, protected environment file, certificate paths, first deployment, verification, daily operations, upgrades and rollback, database backup, and operational limitations. Use these commands for first deployment:

  ```bash
  docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml build
  docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml up -d
  docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml ps
  curl --fail https://game.example.com/api/health
  ```

- [ ] **Step 2: Render the production Compose configuration with non-sensitive test values**

  Run:

  ```bash
  docker compose \
    --env-file /tmp/zhenhuan-prod-config.env \
    -f docker-compose.prod.yml \
    config --quiet
  ```

  The temporary environment file must define all 12 required variables and point `TLS_CERT_PATH` and `TLS_KEY_PATH` at existing temporary files. Expected result: exit code `0` and no missing-variable errors.

- [ ] **Step 3: Check README coverage against Compose requirements**

  Run:

  ```bash
  rg -n 'POSTGRES_DB|POSTGRES_USER|POSTGRES_PASSWORD|DATABASE_URL|APP_ORIGIN|NEXT_PUBLIC_API_URL|BOOTSTRAP_ADMIN_USERNAME|BOOTSTRAP_ADMIN_PASSWORD|BOOTSTRAP_ADMIN_DISPLAY_NAME|SUPER_ADMIN_USERNAMES|TLS_CERT_PATH|TLS_KEY_PATH' README.md
  ```

  Expected result: every required variable appears in the production environment-file example, and `SUPER_ADMIN_USERNAMES` is included.

- [ ] **Step 4: Inspect the edited Markdown**

  Run:

  ```bash
  sed -n '105,285p' README.md
  ```

  Expected result: ordered headings are present, code fences are balanced, commands target `docker-compose.prod.yml`, and the next `## API Contract` heading remains intact.

- [ ] **Step 5: Commit**

  Git metadata is unavailable in the current workspace. Do not create a commit; report this limitation after completing the documentation and verification steps.
