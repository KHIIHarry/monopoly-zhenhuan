import { describe, expect, it } from 'vitest';
import { parseOfflineAdminResetPasswordArgs, runOfflineAdminPasswordReset } from './offline-admin-password-reset.js';

describe('offline administrator password reset CLI arguments', () => {
  it('accepts exactly one non-empty username', () => {
    expect(parseOfflineAdminResetPasswordArgs(['--username', 'admin'])).toEqual({ username: 'admin' });
  });

  it.each([
    [],
    ['--username'],
    ['--username', ''],
    ['--username', '  '],
    ['--username=admin'],
    ['--username', 'admin', '--username', 'other'],
    ['--username', 'admin', '--unexpected'],
    ['--password', 'not-allowed'],
  ])('rejects unsafe or malformed arguments: %j', (argv) => {
    expect(() => parseOfflineAdminResetPasswordArgs(argv)).toThrow();
  });

  it('does not create a database client when the two interactive passwords differ', async () => {
    let databaseCreated = false;
    const errors: string[] = [];

    const exitCode = await runOfflineAdminPasswordReset(['--username', 'admin'], {
      loadSuperAdminUsernames: () => new Set(['admin']),
      readPassword: async (prompt) => prompt.startsWith('New') ? 'first-password' : 'second-password',
      createDatabase: () => {
        databaseCreated = true;
        throw new Error('database must not be opened');
      },
      writeStderr: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(databaseCreated).toBe(false);
    expect(errors.join('')).toContain('Passwords do not match');
    expect(errors.join('')).not.toContain('first-password');
    expect(errors.join('')).not.toContain('second-password');
  });
});
