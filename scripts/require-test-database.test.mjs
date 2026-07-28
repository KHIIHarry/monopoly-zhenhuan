import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./require-test-database.mjs', import.meta.url));

test('rejects an integration test run without TEST_DATABASE_URL', () => {
  assert.throws(
    () => execFileSync(process.execPath, [script], { env: { ...process.env, TEST_DATABASE_URL: '' }, encoding: 'utf8' }),
    (error) => error.status === 1 && error.stderr.includes('TEST_DATABASE_URL is required'),
  );
});

test('allows an integration test run with TEST_DATABASE_URL', () => {
  execFileSync(process.execPath, [script], {
    env: { ...process.env, TEST_DATABASE_URL: 'postgresql://localhost/zhenhuan_test' },
    encoding: 'utf8',
  });
});
