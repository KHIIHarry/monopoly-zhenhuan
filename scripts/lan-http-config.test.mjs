import { describe, expect, it } from 'vitest';
import { buildLanEnvironment, isPrivateIpv4, resolveLanHost } from './lan-http-config.mjs';

const address = (value) => ({ address: value, family: 'IPv4', internal: false });

describe('LAN HTTP configuration', () => {
  it.each(['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.31.196'])('accepts RFC1918 address %s', (value) => {
    expect(isPrivateIpv4(value)).toBe(true);
  });

  it.each(['127.0.0.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', '192.168.1.2:3000', 'host.local', '192.168.01.2', '256.1.1.1'])('rejects non-private IPv4 input %s', (value) => {
    expect(isPrivateIpv4(value)).toBe(false);
  });

  it('uses a valid explicit LAN_HOST override', () => {
    expect(resolveLanHost({ override: '192.168.31.196', interfaces: {} })).toBe('192.168.31.196');
    expect(() => resolveLanHost({ override: '8.8.8.8', interfaces: {} })).toThrow(/private IPv4/);
  });

  it('prefers the common Wi-Fi interface over other private interfaces', () => {
    expect(resolveLanHost({
      interfaces: {
        bridge100: [address('192.168.64.1')],
        en0: [address('192.168.31.196')],
      },
    })).toBe('192.168.31.196');
  });

  it('uses one unambiguous private candidate and rejects ambiguous candidates', () => {
    expect(resolveLanHost({ interfaces: { eth0: [address('10.0.0.8')] } })).toBe('10.0.0.8');
    expect(() => resolveLanHost({
      interfaces: {
        eth0: [address('10.0.0.8')],
        bridge0: [address('192.168.64.1')],
      },
    })).toThrow(/LAN_HOST/);
  });

  it('builds exact frontend, API, and Next development origins', () => {
    expect(buildLanEnvironment('192.168.31.196')).toEqual({
      LAN_HTTP_ORIGIN: 'http://192.168.31.196:3000',
      NEXT_PUBLIC_API_URL: 'http://192.168.31.196:4000',
      NEXT_ALLOWED_DEV_ORIGINS: '192.168.31.196',
    });
  });
});
