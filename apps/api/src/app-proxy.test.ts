import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountRoomService } from './account-room-service.js';
import { buildApiApp } from './app.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalAppOrigin = process.env.APP_ORIGIN;
const openApps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalAppOrigin;
  vi.restoreAllMocks();
});

function accounts() {
  return {
    login: vi.fn(async () => ({
      status: 'OK' as const,
      rawToken: 'proxy-session-token',
      account: {
        id: 'account-1',
        username: 'proxy-user',
        displayName: 'Proxy User',
        isSuperAdmin: false,
        canCreateRoom: false,
        lastLoginAt: null,
      },
    })),
  };
}

describe('trusted production proxy boundary', () => {
  it('uses only the nearest forwarded hop as the HTTP client IP in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_ORIGIN = 'https://game.example.com';
    const accountService = accounts();
    const app = await buildApiApp({
      accounts: accountService as unknown as AccountRoomService,
      logger: false,
    });
    openApps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '172.20.0.5',
      headers: { 'x-forwarded-for': '198.51.100.44, 203.0.113.25' },
      payload: { username: 'proxy-user', password: 'password-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(accountService.login).toHaveBeenCalledWith(
      'proxy-user',
      'password-123',
      expect.objectContaining({ ip: '203.0.113.25' }),
    );
  });

  it('ignores forwarded client IP headers outside production', async () => {
    process.env.NODE_ENV = 'test';
    const accountService = accounts();
    const app = await buildApiApp({
      accounts: accountService as unknown as AccountRoomService,
      logger: false,
    });
    openApps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.9',
      headers: { 'x-forwarded-for': '198.51.100.44' },
      payload: { username: 'proxy-user', password: 'password-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(accountService.login).toHaveBeenCalledWith(
      'proxy-user',
      'password-123',
      expect.objectContaining({ ip: '127.0.0.9' }),
    );
  });
});
