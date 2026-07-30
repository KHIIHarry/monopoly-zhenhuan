import { runOfflineAdminPasswordReset } from './offline-admin-password-reset.js';

void runOfflineAdminPasswordReset(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
