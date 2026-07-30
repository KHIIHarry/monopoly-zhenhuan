import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'scripts/lan-http-config.test.mjs', 'scripts/admin-reset-password.test.mjs'],
    exclude: ['**/dist/**', '**/node_modules/**', 'tests/e2e/**']
  }
});
