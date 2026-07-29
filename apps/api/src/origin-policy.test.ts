import { describe, expect, it } from 'vitest';
import { loadOriginPolicy } from './origin-policy.js';

describe('API origin policy', () => {
  it('keeps localhost development origins and secure cookies by default', () => {
    const policy = loadOriginPolicy({ NODE_ENV: 'development' });

    expect(policy.secureCookie).toBe(true);
    expect(policy.originAllowed()).toBe(true);
    expect(policy.originAllowed('http://localhost:3000')).toBe(true);
    expect(policy.originAllowed('http://127.0.0.1:4173')).toBe(true);
    expect(policy.originAllowed('http://[::1]:3000')).toBe(true);
    expect(policy.originAllowed('http://192.168.31.196:3000')).toBe(false);
  });

  it('allows only the exact configured LAN origin and disables Secure cookies', () => {
    const policy = loadOriginPolicy({
      NODE_ENV: 'development',
      LAN_HTTP_ORIGIN: 'http://192.168.31.196:3000',
    });

    expect(policy.secureCookie).toBe(false);
    expect(policy.originAllowed('http://192.168.31.196:3000')).toBe(true);
    expect(policy.originAllowed('http://192.168.31.197:3000')).toBe(false);
    expect(policy.originAllowed('http://192.168.31.196:3001')).toBe(false);
  });

  it.each(['http://10.0.0.8:3000', 'http://172.16.0.8:3000', 'http://172.31.255.254:3000'])('accepts RFC1918 LAN origin %s', (origin) => {
    const policy = loadOriginPolicy({ NODE_ENV: 'development', LAN_HTTP_ORIGIN: origin });

    expect(policy.originAllowed(origin)).toBe(true);
    expect(policy.secureCookie).toBe(false);
  });

  it.each([
    'https://192.168.31.196:3000',
    'http://192.168.31.196:4000',
    'http://8.8.8.8:3000',
    'http://172.32.0.1:3000',
    'http://localhost:3000',
    'http://user:pass@192.168.31.196:3000',
    'http://192.168.31.196:3000/path',
    'http://192.168.01.2:3000',
  ])('rejects invalid LAN_HTTP_ORIGIN %s', (origin) => {
    expect(() => loadOriginPolicy({ NODE_ENV: 'development', LAN_HTTP_ORIGIN: origin })).toThrow(/LAN_HTTP_ORIGIN/);
  });

  it('keeps an exact HTTPS origin and Secure cookies in production', () => {
    const policy = loadOriginPolicy({ NODE_ENV: 'production', APP_ORIGIN: 'https://game.example.com' });

    expect(policy.secureCookie).toBe(true);
    expect(policy.originAllowed('https://game.example.com')).toBe(true);
    expect(policy.originAllowed('https://foreign.example')).toBe(false);
  });

  it('rejects LAN mode and invalid APP_ORIGIN in production', () => {
    expect(() => loadOriginPolicy({
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://game.example.com',
      LAN_HTTP_ORIGIN: 'http://192.168.31.196:3000',
    })).toThrow(/not allowed in production/);
    expect(() => loadOriginPolicy({ NODE_ENV: 'production', APP_ORIGIN: 'http://game.example.com' })).toThrow(/exact HTTPS origin/);
  });
});
