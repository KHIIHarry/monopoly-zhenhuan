# Project Operations

- Start and run this project exclusively through Docker Compose.
- Do not use `npm run dev`, `npm run start`, `npm run dev:lan`, or workspace-level npm commands to launch the Web or API services.
- Use `docker compose up -d` for normal local startup. Use scoped Docker Compose commands only when diagnosing or restarting an individual service.
- npm commands may still be used for linting, type checking, tests, builds, database tooling, and dependency maintenance when needed; this restriction applies to starting the running system.
- Before starting Docker services, check for and stop stale host-side Node.js/Next.js processes from this project so they cannot share `.next` state or occupy application ports.
- Keep Web and browser-based feature testing on port 3000. Do not create or switch to a temporary alternate port just because port 3000 is already in use.
- When an existing test for this project is already using port 3000, reuse that running instance when the tests can safely share it. If they cannot safely share it, wait for the earlier test to finish before starting the next test on port 3000; do not interrupt the earlier test or start the new test on another port.
- Run Playwright against the Docker stack with `PLAYWRIGHT_EXTERNAL_STACK=1`; never let Playwright start a host-side Next.js or API process.
