import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));

describe('admin password reset script', () => {
  it('rejects a plaintext --password argument before attempting interactive input', async () => {
    await expect(execute('npm', ['run', 'admin:reset-password', '--', '--username', 'admin', '--password', 'not-allowed'], {
      cwd: workspaceRoot,
      env: { ...process.env, SUPER_ADMIN_USERNAMES: 'admin' },
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Refusing --password'),
    });
  });
});
