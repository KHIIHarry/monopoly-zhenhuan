import { afterEach, describe, expect, it } from 'vitest';
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
});
