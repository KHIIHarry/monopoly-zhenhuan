import { describe, expect, it } from 'vitest';
import { loadSecurityConfig } from './security-config.js';

describe('loadSecurityConfig', () => {
  it.each(['development', 'test', 'production'])('loads account-based security in %s', (nodeEnv) => {
    expect(loadSecurityConfig({ NODE_ENV: nodeEnv, SUPER_ADMIN_USERNAMES: 'admin' })).toEqual({
      superAdminUsernames: new Set(['admin']),
    });
  });

  it.each([
    [{ SUPER_ADMIN_USERNAMES: 'admin' }, 'NODE_ENV must be development, test, or production'],
    [{ NODE_ENV: 'staging', SUPER_ADMIN_USERNAMES: 'admin' }, 'NODE_ENV must be development, test, or production'],
  ])('rejects defaults without an approved NODE_ENV: %o', (env, message) => {
    expect(() => loadSecurityConfig(env)).toThrow(message);
  });

  it('does not expose removed legacy token settings', () => {
    expect(loadSecurityConfig({
      NODE_ENV: 'production',
      ADMIN_TOKEN: 'legacy-admin-token',
      BANK_JOIN_TOKEN: 'legacy-bank-token',
      SUPER_ADMIN_USERNAMES: 'admin',
    })).toEqual({
      superAdminUsernames: new Set(['admin']),
    });
  });

  it('parses trimmed configured usernames', () => {
    const config = loadSecurityConfig({
      NODE_ENV: 'production',
      SUPER_ADMIN_USERNAMES: 'admin, owner',
    });
    expect(config.superAdminUsernames).toEqual(new Set(['admin', 'owner']));
  });

  it.each([
    [undefined, 'SUPER_ADMIN_USERNAMES is required'],
    ['   ', 'SUPER_ADMIN_USERNAMES is required'],
    ['admin,,owner', 'SUPER_ADMIN_USERNAMES must not contain empty usernames'],
    ['admin,admin', 'SUPER_ADMIN_USERNAMES must not contain duplicate usernames'],
  ])('rejects invalid username list', (value, error) => {
    expect(() => loadSecurityConfig({
      NODE_ENV: 'test',
      SUPER_ADMIN_USERNAMES: value,
    })).toThrow(error);
  });
});
