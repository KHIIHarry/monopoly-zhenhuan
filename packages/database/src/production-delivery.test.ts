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

  it('ships one-command trusted LAN HTTP development instructions', () => {
    const rootPackage = readJson('../../../package.json');
    const environment = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

    expect(rootPackage.scripts['dev:lan']).toBe('node scripts/start-lan.mjs');
    expect(environment).toContain('LAN_HOST=');
    expect(environment).toContain('LAN_HTTP_ORIGIN=');
    expect(readme).toContain('npm run dev:lan');
    expect(readme).toContain('LAN_HOST=192.168.31.196 npm run dev:lan');
    expect(readme).toContain('http://192.168.31.196:3000');
    expect(readme).toContain('macOS 防火墙');
    expect(readme).toContain('IP 地址变化');
    expect(readme).toContain('不得将 `3000`、`4000` 或 `5432` 映射到公网');
  });
});
