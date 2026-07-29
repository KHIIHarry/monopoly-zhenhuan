import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRoomService } from './account-room-service.js';
import { buildApiApp } from './app.js';

const openApps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('browser CORS preflight', () => {
  it.each(['PATCH', 'DELETE'])('allows %s for cross-origin API writes', async (method) => {
    const app = await buildApiApp({ logger: false });
    openApps.push(app);

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/admin/rooms/room-1',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']?.split(',').map((value) => value.trim())).toContain(method);
    expect(response.headers['access-control-allow-headers']).toBe('content-type,idempotency-key');
  });

  it('allows only the exact explicitly configured LAN HTTP origin', async () => {
    const previousLanOrigin = process.env.LAN_HTTP_ORIGIN;
    process.env.LAN_HTTP_ORIGIN = 'http://192.168.31.196:3000';
    try {
      const accounts = {
        login: vi.fn(async () => ({
          status: 'OK' as const,
          rawToken: 'lan-session-token',
          account: {
            id: 'account-1',
            username: 'lan-player',
            displayName: '局域网玩家',
            isSuperAdmin: false,
            canCreateRoom: false,
            lastLoginAt: null,
          },
        })),
      };
      const app = await buildApiApp({ accounts: accounts as unknown as AccountRoomService, logger: false });
      openApps.push(app);

      const allowed = await app.inject({
        method: 'OPTIONS',
        url: '/api/auth/me',
        headers: {
          origin: 'http://192.168.31.196:3000',
          'access-control-request-method': 'GET',
        },
      });
      const rejected = await app.inject({
        method: 'OPTIONS',
        url: '/api/auth/me',
        headers: {
          origin: 'http://192.168.31.197:3000',
          'access-control-request-method': 'GET',
        },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: 'http://192.168.31.196:3000' },
        payload: { username: 'lan-player', password: 'password-123' },
      });

      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers['access-control-allow-origin']).toBe('http://192.168.31.196:3000');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toEqual({ error: 'ORIGIN_NOT_ALLOWED' });
      expect(login.statusCode).toBe(200);
      expect(login.headers['set-cookie']).toContain('HttpOnly; SameSite=Lax');
      expect(login.headers['set-cookie']).not.toContain('Secure');
    } finally {
      if (previousLanOrigin === undefined) delete process.env.LAN_HTTP_ORIGIN;
      else process.env.LAN_HTTP_ORIGIN = previousLanOrigin;
    }
  });
});
