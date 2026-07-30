import { runOfflineAdminPasswordReset } from '../apps/api/src/offline-admin-password-reset.js';

void runOfflineAdminPasswordReset(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
