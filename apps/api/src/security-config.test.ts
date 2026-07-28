import { describe, expect, it } from 'vitest';
import { loadSecurityConfig } from './security-config.js';

const strongAdminToken = 'admin-7c8870e28dd54884a80d54062a2e8d56';
const strongBankToken = 'bank-4f6132bc9e1d48ce8ba6b265cf80310a';

describe('loadSecurityConfig', () => {
  it.each(['development', 'test'])('uses local defaults in %s', (nodeEnv) => {
    expect(loadSecurityConfig({ NODE_ENV: nodeEnv, SUPER_ADMIN_USERNAMES: 'admin' })).toEqual({
      adminToken: 'local-admin-change-me',
      bankJoinToken: 'local-bank-change-me',
      superAdminUsernames: new Set(['admin']),
    });
  });

  it.each([
    [{ SUPER_ADMIN_USERNAMES: 'admin' }, 'NODE_ENV must be development, test, or production'],
    [{ NODE_ENV: 'staging', SUPER_ADMIN_USERNAMES: 'admin' }, 'NODE_ENV must be development, test, or production'],
  ])('rejects defaults without an approved NODE_ENV: %o', (env, message) => {
    expect(() => loadSecurityConfig(env)).toThrow(message);
  });

  it.each([
    [{ NODE_ENV: 'production', SUPER_ADMIN_USERNAMES: 'admin' }, 'ADMIN_TOKEN and BANK_JOIN_TOKEN are required in production'],
    [{ NODE_ENV: 'production', ADMIN_TOKEN: 'local-admin-change-me', BANK_JOIN_TOKEN: strongBankToken, SUPER_ADMIN_USERNAMES: 'admin' }, 'ADMIN_TOKEN must not use the local default in production'],
    [{ NODE_ENV: 'production', ADMIN_TOKEN: strongAdminToken, BANK_JOIN_TOKEN: 'local-bank-change-me', SUPER_ADMIN_USERNAMES: 'admin' }, 'BANK_JOIN_TOKEN must not use the local default in production'],
    [{ NODE_ENV: 'production', ADMIN_TOKEN: strongAdminToken, BANK_JOIN_TOKEN: strongAdminToken, SUPER_ADMIN_USERNAMES: 'admin' }, 'ADMIN_TOKEN and BANK_JOIN_TOKEN must differ in production'],
    [{ NODE_ENV: 'production', ADMIN_TOKEN: 'too-short', BANK_JOIN_TOKEN: strongBankToken, SUPER_ADMIN_USERNAMES: 'admin' }, 'ADMIN_TOKEN must be at least 32 characters in production'],
  ])('rejects unsafe production credentials: %o', (env, message) => {
    expect(() => loadSecurityConfig(env)).toThrow(message);
  });

  it('accepts distinct strong production credentials', () => {
    expect(loadSecurityConfig({
      NODE_ENV: 'production',
      ADMIN_TOKEN: strongAdminToken,
      BANK_JOIN_TOKEN: strongBankToken,
      SUPER_ADMIN_USERNAMES: 'admin',
    })).toEqual({
      adminToken: strongAdminToken,
      bankJoinToken: strongBankToken,
      superAdminUsernames: new Set(['admin']),
    });
  });

  it('parses trimmed configured usernames', () => {
    const config = loadSecurityConfig({
      NODE_ENV: 'production',
      ADMIN_TOKEN: strongAdminToken,
      BANK_JOIN_TOKEN: strongBankToken,
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
