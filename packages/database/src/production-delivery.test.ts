import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const checker = fileURLToPath(new URL('../../../scripts/require-production-web-env.mjs', import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('production delivery contract', () => {
  it('builds with an explicit public API URL and starts both services', () => {
    const rootPackage = readJson('../../../package.json');
    const webPackage = readJson('../../../apps/web/package.json');

    expect(rootPackage.scripts['build:production']).toContain('require-production-web-env.mjs');
    expect(rootPackage.scripts.start).toContain('@zhenhuan/api');
    expect(rootPackage.scripts.start).toContain('@zhenhuan/web');
    expect(webPackage.scripts.start).toBe('next start -p 3000');
  });

  it('builds the dist-only shared workspace before starting Web development', () => {
    const webPackage = readJson('../../../apps/web/package.json');

    expect(webPackage.scripts.dev).toBe('npm run build -w @zhenhuan/shared -- --force && next dev -p 3000');
  });

  it('generates the Prisma client inside the isolated Web dependency volume', () => {
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const webService = compose.slice(compose.indexOf('  web:'), compose.indexOf('\nvolumes:'));

    expect(webService).toContain('npm run db:generate');
  });

  it('uses the Docker localhost origin for an external Playwright stack', () => {
    const playwright = readFileSync(new URL('../../../playwright.config.ts', import.meta.url), 'utf8');

    expect(playwright).toContain("baseURL: realStack || externalStack ? 'http://localhost:3000' : 'http://127.0.0.1:3000'");
  });

  it('cleans API output before compiling so deleted legacy modules cannot ship', () => {
    const apiPackage = readJson('../../../apps/api/package.json');

    expect(apiPackage.scripts.build).toMatch(/^rm -rf dist && tsc -b --force$/);
    expect(existsSync(new URL('../../../apps/api/dist/server.js', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../../../apps/api/dist/game-service.js', import.meta.url))).toBe(false);
    expect(existsSync(new URL('../../../apps/api/dist/game-service.d.ts', import.meta.url))).toBe(false);
  });

  it('uses a Next output mode compatible with the production start command', async () => {
    const { default: nextConfig } = await import('../../../apps/web/next.config.ts');

    expect(nextConfig.output).toBeUndefined();
  });

  it('binds local Compose ports to loopback by default', () => {
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');

    expect(compose).toContain('${POSTGRES_BIND_ADDRESS:-127.0.0.1}:${POSTGRES_PORT:-5432}:5432');
    expect(compose).toContain('${APP_BIND_ADDRESS:-127.0.0.1}:4000:4000');
    expect(compose).toContain('${APP_BIND_ADDRESS:-127.0.0.1}:3000:3000');
  });

  it('rejects a production Web build without a non-loopback API URL', () => {
    for (const nextPublicApiUrl of ['', 'http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']) {
      expect(() => execFileSync(process.execPath, [checker], {
        cwd: root,
        env: { ...process.env, NEXT_PUBLIC_API_URL: nextPublicApiUrl },
        encoding: 'utf8',
        stdio: 'pipe',
      })).toThrow();
    }
  });

  it('accepts an HTTPS API URL for a production Web build', () => {
    expect(() => execFileSync(process.execPath, [checker], {
      cwd: root,
      env: { ...process.env, NEXT_PUBLIC_API_URL: 'https://api.example.com' },
      encoding: 'utf8',
      stdio: 'pipe',
    })).not.toThrow();
  });

  it('requires the exact production HTTPS origin for API CORS and Socket.IO', () => {
    const compose = readFileSync(new URL('../../../docker-compose.prod.yml', import.meta.url), 'utf8');
    const environment = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

    expect(compose).toContain('APP_ORIGIN: ${APP_ORIGIN:?APP_ORIGIN is required}');
    expect(compose).toContain('SUPER_ADMIN_USERNAMES: ${SUPER_ADMIN_USERNAMES:?SUPER_ADMIN_USERNAMES is required}');
    expect(environment).toContain('SUPER_ADMIN_USERNAMES="admin"');
    expect(environment).toContain('APP_ORIGIN="http://localhost:3000"');
    expect(readme).toContain('APP_ORIGIN=https://game.example.com');
  });

  it('ships Docker-only local and trusted LAN HTTP startup instructions', () => {
    const rootPackage = readJson('../../../package.json');
    const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
    const environment = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const deploymentGuide = readFileSync(new URL('../../../DEPLOYMENT_GUIDE.html', import.meta.url), 'utf8');

    expect(environment).not.toContain('LAN_HOST=');
    expect(environment).toContain('LAN_HTTP_ORIGIN=');
    expect(environment).toContain('NEXT_ALLOWED_DEV_ORIGINS=');
    expect(compose).toContain('NEXT_ALLOWED_DEV_ORIGINS: "${NEXT_ALLOWED_DEV_ORIGINS:-}"');
    expect(rootPackage.scripts['test:e2e']).toBe('PLAYWRIGHT_EXTERNAL_STACK=1 playwright test');
    expect(readme).toContain('docker compose up -d');
    expect(readme).toContain('APP_BIND_ADDRESS=0.0.0.0');
    expect(readme).toContain('LAN_HTTP_ORIGIN=http://192.168.31.196:3000');
    expect(readme).toContain('NEXT_PUBLIC_API_URL=http://192.168.31.196:4000');
    expect(readme).toContain('NEXT_ALLOWED_DEV_ORIGINS=192.168.31.196');
    expect(deploymentGuide).toContain('NEXT_ALLOWED_DEV_ORIGINS=192.168.31.196');
    expect(readme).toContain('docker compose up -d --force-recreate api web');
    expect(readme).toContain('PLAYWRIGHT_EXTERNAL_STACK=1 npm run test:e2e');
    expect(readme).not.toContain('\nnpm run dev\n');
    expect(readme).not.toContain('\nnpm run dev:lan\n');
    expect(readme).not.toContain('\nnpm run db:migrate\n');
    expect(readme).toContain('`migrate` 容器');
    expect(readme).not.toContain('LAN_HOST=192.168.31.196 npm run dev:lan');
    expect(readme).toContain('http://192.168.31.196:3000');
    expect(readme).toContain('macOS 防火墙');
    expect(readme).toContain('IP 地址变化');
    expect(readme).toContain('不得将 `3000`、`4000` 或 `5432` 映射到公网');
    expect(readme).toContain('BOOTSTRAP_ADMIN_PASSWORD=<至少 12 位的强密码>');
    expect(deploymentGuide).toContain('BOOTSTRAP_ADMIN_PASSWORD</code> 改成 12 位以上强密码');
  });

  it('documents non-destructive setup and complete fresh-host prerequisites', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const deploymentGuide = readFileSync(new URL('../../../DEPLOYMENT_GUIDE.html', import.meta.url), 'utf8');

    expect(readme).toContain('test -f .env || cp .env.example .env');
    expect(deploymentGuide).toContain('test -f .env || cp .env.example .env');
    expect(readme).toContain('npm ci');
    expect(deploymentGuide).not.toContain('/Users/harry/Documents/');
    expect(deploymentGuide).toContain('sudo apt install -y ca-certificates curl git ufw nano');
    expect(deploymentGuide).toContain('<code>LAN_HTTP_ORIGIN</code>、<code>NEXT_PUBLIC_API_URL</code> 和 <code>NEXT_ALLOWED_DEV_ORIGINS</code>');
    expect(readme).toContain('docker compose --env-file /secure/zhenhuan.prod.env -f docker-compose.prod.yml ps --all');
    expect(deploymentGuide).toContain('ps --all');
  });

  it('keeps production secrets usable by the documented operator and recreates only Nginx for certificates', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const deploymentGuide = readFileSync(new URL('../../../DEPLOYMENT_GUIDE.html', import.meta.url), 'utf8');
    const ownedSecretDirectory = 'sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /secure';
    const ownedEnvironmentFile = 'sudo install -m 600 -o "$USER" -g "$(id -gn)" /dev/null /secure/zhenhuan.prod.env';
    const isolatedNginxRecreate = 'up -d --force-recreate --no-deps nginx';

    expect(readme).toContain(ownedSecretDirectory);
    expect(readme).toContain(ownedEnvironmentFile);
    expect(deploymentGuide).toContain(ownedSecretDirectory);
    expect(deploymentGuide).toContain(ownedEnvironmentFile);
    expect(readme).toContain(isolatedNginxRecreate);
    expect(deploymentGuide.match(new RegExp(isolatedNginxRecreate, 'g'))).toHaveLength(3);
    expect(readme).not.toContain('restart nginx');
    expect(deploymentGuide).not.toContain('restart nginx');
    expect(deploymentGuide).not.toContain('up -d --force-recreate nginx');
  });

  it('pins production Nginx to the configured host and rejects unknown hosts', () => {
    const compose = readFileSync(new URL('../../../docker-compose.prod.yml', import.meta.url), 'utf8');
    const nginx = readFileSync(new URL('../../../deploy/nginx.conf.template', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const deploymentGuide = readFileSync(new URL('../../../DEPLOYMENT_GUIDE.html', import.meta.url), 'utf8');

    expect(compose).toContain('APP_HOST: ${APP_HOST:?APP_HOST is required}');
    expect(compose).toContain('./deploy/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro');
    expect(nginx).toContain('server_name ${APP_HOST};');
    expect(nginx).toContain('return 301 https://${APP_HOST}$request_uri;');
    expect(nginx).toMatch(/listen 80 default_server;[\s\S]*?return 444;/);
    expect(nginx).toMatch(/listen 443 ssl default_server;[\s\S]*?ssl_reject_handshake on;/);
    expect(nginx).not.toContain('server_name _;');
    expect(nginx).not.toContain('https://$host');
    expect(nginx.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g)).toHaveLength(3);
    expect(nginx).not.toContain('$proxy_add_x_forwarded_for');
    expect(readme).toContain('APP_HOST=game.example.com');
    expect(deploymentGuide).toContain('APP_HOST=game.example.com');
  });

  it('runs both production application images as the unprivileged node user', () => {
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');

    expect(dockerfile.match(/^USER node$/gm)).toHaveLength(2);
    expect(dockerfile).toContain('COPY --chown=node:node --from=build /app/apps/web/.next ./apps/web/.next');
  });

  it('documents separate Compose-safe generated production passwords', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const deploymentGuide = readFileSync(new URL('../../../DEPLOYMENT_GUIDE.html', import.meta.url), 'utf8');

    expect(readme).toContain('分别执行两次 `openssl rand -hex 24`');
    expect(deploymentGuide.match(/openssl rand -hex 24/g)).toHaveLength(2);
    expect(deploymentGuide).toContain('只包含十六进制字符，不会被 Compose 插值');
  });
});
