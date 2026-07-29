# LAN HTTP Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-command, explicitly enabled HTTP LAN development mode for phones and tablets on the same trusted Wi-Fi.

**Architecture:** A dependency-free Node launcher selects or validates one RFC1918 IPv4 and injects exact frontend/API origins into the existing development command. A focused API origin-policy module validates the opt-in origin once and supplies the same allow predicate to REST and Socket.IO while controlling the session Cookie `Secure` flag.

**Tech Stack:** Node.js ESM, TypeScript, Fastify, Socket.IO, Vitest, Next.js, npm workspaces.

## Global Constraints

- LAN HTTP mode must be opt-in through `LAN_HTTP_ORIGIN` and must never run in production.
- CORS must allow one exact configured private IPv4 origin, never a wildcard or private subnet.
- Only LAN HTTP mode may remove `Secure`; `HttpOnly`, `SameSite=Lax`, `Path=/`, and expiry remain unchanged.
- PostgreSQL remains bound to loopback and ports 3000/4000 must not be exposed to the public Internet.
- Work in the current `main` checkout so running ports cannot diverge across worktrees.

---

### Task 1: Private IPv4 Configuration And Launcher

**Files:**
- Create: `scripts/lan-http-config.mjs`
- Create: `scripts/lan-http-config.test.mjs`
- Create: `scripts/start-lan.mjs`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `isPrivateIpv4(value: string): boolean`, `resolveLanHost(options): string`, and `buildLanEnvironment(host: string): Record<string, string>`.
- Consumes: Node `os.networkInterfaces()` output and optional `process.env.LAN_HOST`.

- [ ] **Step 1: Write failing configuration tests**

Cover RFC1918 acceptance, rejection of loopback/public/hostname/port inputs, explicit override, Wi-Fi interface preference, ambiguous candidates, and exact generated environment values:

```js
expect(isPrivateIpv4('192.168.31.196')).toBe(true);
expect(() => resolveLanHost({ override: '8.8.8.8', interfaces: {} })).toThrow(/private IPv4/);
expect(resolveLanHost({ interfaces: { en0: [{ family: 'IPv4', address: '192.168.31.196', internal: false }] } })).toBe('192.168.31.196');
expect(buildLanEnvironment('192.168.31.196')).toEqual({
  LAN_HTTP_ORIGIN: 'http://192.168.31.196:3000',
  NEXT_PUBLIC_API_URL: 'http://192.168.31.196:4000',
  NEXT_ALLOWED_DEV_ORIGINS: '192.168.31.196',
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm exec -- vitest run scripts/lan-http-config.test.mjs`

Expected: FAIL because `scripts/lan-http-config.mjs` does not exist.

- [ ] **Step 3: Implement the minimal configuration module**

Parse four decimal IPv4 octets; accept only `10/8`, `172.16/12`, and `192.168/16`. Resolve an explicit override first, otherwise prefer a single non-internal IPv4 from `en0`, `wlan0`, or `wi-fi`; accept one unambiguous remaining candidate and reject zero or multiple candidates with an actionable `LAN_HOST` message.

```js
export function isPrivateIpv4(value) {
  const octets = value.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^\d+$/.test(part) || Number(part) > 255 || String(Number(part)) !== part)) return false;
  const [first, second] = octets.map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function buildLanEnvironment(host) {
  if (!isPrivateIpv4(host)) throw new Error('LAN_HOST must be an RFC1918 private IPv4 address');
  return {
    LAN_HTTP_ORIGIN: `http://${host}:3000`,
    NEXT_PUBLIC_API_URL: `http://${host}:4000`,
    NEXT_ALLOWED_DEV_ORIGINS: host,
  };
}
```

- [ ] **Step 4: Implement the launcher and Vitest inclusion**

`scripts/start-lan.mjs` calls the configuration module, prints `http://<host>:3000`, and spawns `npm run dev` with inherited environment plus the generated values. Add `scripts/**/*.test.mjs` to `vitest.config.ts` so the root suite owns the launcher tests.

```js
const host = resolveLanHost({ override: process.env.LAN_HOST, interfaces: networkInterfaces() });
const environment = buildLanEnvironment(host);
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(command, ['run', 'dev'], { env: { ...process.env, ...environment }, stdio: 'inherit' });
child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
```

- [ ] **Step 5: Verify GREEN**

Run: `npm exec -- vitest run scripts/lan-http-config.test.mjs`

Expected: all launcher configuration tests pass.

---

### Task 2: Exact API Origin And Cookie Policy

**Files:**
- Create: `apps/api/src/origin-policy.ts`
- Create: `apps/api/src/origin-policy.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app-cors.test.ts`

**Interfaces:**
- Produces: `loadOriginPolicy(env): { originAllowed(origin?: string): boolean; secureCookie: boolean }`.
- Consumes: `NODE_ENV`, production `APP_ORIGIN`, and development `LAN_HTTP_ORIGIN`.

- [ ] **Step 1: Write failing policy tests**

Test that a development `LAN_HTTP_ORIGIN=http://192.168.31.196:3000` allows that exact origin, rejects `192.168.31.197`, rejects port 3001, and returns `secureCookie: false`. Test malformed/public origins. Test default development returns `secureCookie: true`. Test production rejects any `LAN_HTTP_ORIGIN` and still requires an exact HTTPS `APP_ORIGIN`.

- [ ] **Step 2: Run the focused policy test and verify RED**

Run: `npm exec -- vitest run apps/api/src/origin-policy.test.ts`

Expected: FAIL because `origin-policy.ts` does not exist.

- [ ] **Step 3: Implement the minimal policy module**

Validate the LAN origin using `URL`, require `parsed.origin === raw`, protocol `http:`, port `3000`, no credentials, and an RFC1918 IPv4 hostname. Return one predicate shared by REST and Socket.IO plus the Cookie flag. Keep the current production HTTPS validation behavior and throw a clear startup error for invalid configuration.

```ts
export type OriginPolicy = {
  originAllowed: (origin?: string) => boolean;
  secureCookie: boolean;
};

export function loadOriginPolicy(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const production = env.NODE_ENV === 'production';
  const lanOrigin = env.LAN_HTTP_ORIGIN?.trim();
  if (production && lanOrigin) throw new Error('LAN_HTTP_ORIGIN is not allowed in production');
  if (production) {
    const appOrigin = requireExactProductionHttpsOrigin(env.APP_ORIGIN);
    return { originAllowed: (origin) => !origin || origin === appOrigin, secureCookie: true };
  }
  const exactLanOrigin = lanOrigin ? requireExactLanHttpOrigin(lanOrigin) : undefined;
  return {
    originAllowed: (origin) => !origin || localDevelopmentOrigin.test(origin) || origin === exactLanOrigin,
    secureCookie: exactLanOrigin === undefined,
  };
}
```

- [ ] **Step 4: Wire the policy into Fastify and add request-level coverage**

Replace the inline production/origin logic and `const secureCookie = true` in `app.ts` with `loadOriginPolicy(process.env)`. Extend `app-cors.test.ts` to inject an allowed LAN preflight and a rejected neighboring-origin preflight, proving the HTTP boundary uses the shared policy.

```ts
const { originAllowed, secureCookie } = loadOriginPolicy(process.env);
app.addHook('onRequest', async (request, reply) => {
  if (request.headers.origin && !originAllowed(request.headers.origin)) {
    return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
  }
});
```

- [ ] **Step 5: Verify GREEN and regression behavior**

Run: `npm exec -- vitest run apps/api/src/origin-policy.test.ts apps/api/src/app-cors.test.ts apps/api/src/auth-domain.test.ts apps/api/src/server-room-routes.test.ts`

Expected: all selected policy, CORS, Cookie serialization, and production-origin tests pass.

---

### Task 3: Command, Documentation, And End-To-End Runtime Gate

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `packages/database/src/production-delivery.test.ts`

**Interfaces:**
- Produces: user command `npm run dev:lan` and documented `LAN_HOST` override.
- Consumes: `scripts/start-lan.mjs` from Task 1 and API policy from Task 2.

- [ ] **Step 1: Write a failing delivery-contract test**

Assert the root `dev:lan` script equals `node scripts/start-lan.mjs`, `.env.example` documents `LAN_HOST`/`LAN_HTTP_ORIGIN` as development-only, README contains `npm run dev:lan`, the phone URL shape, firewall guidance, IP-change guidance, and the prohibition on public port forwarding.

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npm exec -- vitest run packages/database/src/production-delivery.test.ts`

Expected: FAIL because `dev:lan` and LAN documentation do not yet exist.

- [ ] **Step 3: Add the command and operational documentation**

Add `"dev:lan": "node scripts/start-lan.mjs"` to root scripts. Document automatic detection, `LAN_HOST=192.168.31.196 npm run dev:lan`, player access on port 3000, macOS firewall permission, trusted-Wi-Fi-only use, DHCP/IP changes, and no public mappings for 3000/4000/5432.

```json
{
  "scripts": {
    "dev:lan": "node scripts/start-lan.mjs"
  }
}
```

- [ ] **Step 4: Verify focused contract and all required commands**

Run:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Verify real LAN startup**

Stop the existing localhost development process, run `LAN_HOST=192.168.31.196 npm run dev:lan`, and verify:

```bash
curl --fail http://192.168.31.196:3000/
curl --fail http://192.168.31.196:4000/health
curl -i -X OPTIONS http://192.168.31.196:4000/api/auth/me \
  -H 'Origin: http://192.168.31.196:3000' \
  -H 'Access-Control-Request-Method: GET'
```

Expected: H5 and health return 200; preflight returns 204 with the exact allow-origin and allow-credentials headers. Use a browser request to confirm login response Cookie lacks `Secure`, then confirm Socket.IO connects without an origin error.

- [ ] **Step 6: Commit implementation**

```bash
git add package.json vitest.config.ts scripts apps/api/src .env.example README.md packages/database/src/production-delivery.test.ts docs/superpowers/plans/2026-07-29-lan-http-development.md
git commit -m "feat: add trusted LAN HTTP development mode"
```
