import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Next.js development origins', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('allows the comma-separated broadcast origins from the environment', async () => {
    vi.stubEnv('NEXT_ALLOWED_DEV_ORIGINS', ' hutmc.fun, 192.168.31.196, ');
    vi.resetModules();

    const { default: config } = await import('./next.config');

    expect(config.allowedDevOrigins).toEqual(['hutmc.fun', '192.168.31.196']);
  });
});
