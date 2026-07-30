import { PrismaClient } from '@prisma/client';
import { AccountRoomService } from './account-room-service.js';
import { passwordSchema } from './auth-domain.js';
import { loadSuperAdminUsernames } from './security-config.js';

class OfflineResetCliError extends Error {}

export type OfflineAdminPasswordResetDependencies = {
  loadSuperAdminUsernames?: () => Set<string>;
  readPassword?: (prompt: string) => Promise<string>;
  createDatabase?: () => PrismaClient;
  writeStdout?: (message: string) => void;
  writeStderr?: (message: string) => void;
};

export function parseOfflineAdminResetPasswordArgs(argv: string[]) {
  if (argv.includes('--password') || argv.some((arg) => arg.startsWith('--password='))) {
    throw new OfflineResetCliError('Refusing --password: enter the password interactively.');
  }
  if (argv.length !== 2 || argv[0] !== '--username' || !argv[1]?.trim()) {
    throw new OfflineResetCliError('Usage: npm run admin:reset-password -- --username <username>');
  }
  return { username: argv[1].trim() };
}

async function readHiddenPassword(prompt: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new OfflineResetCliError('An interactive TTY is required to enter the new password safely.');
  }
  process.stdout.write(prompt);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          process.stdout.write('\n');
          finish(new OfflineResetCliError('Password entry cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          process.stdout.write('\n');
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

function safeErrorMessage(error: unknown) {
  if (error instanceof OfflineResetCliError) return error.message;
  if (error instanceof Error && error.message.startsWith('SUPER_ADMIN_USERNAMES')) return error.message;
  if (error instanceof Error && error.message.includes('String must contain')) return 'Password must be between 8 and 200 characters.';
  return 'Password reset failed. Check the account, configuration, database connection, and security log.';
}

export async function runOfflineAdminPasswordReset(
  argv: string[],
  dependencies: OfflineAdminPasswordResetDependencies = {},
) {
  const readPassword = dependencies.readPassword ?? readHiddenPassword;
  const writeStdout = dependencies.writeStdout ?? ((message: string) => process.stdout.write(message));
  const writeStderr = dependencies.writeStderr ?? ((message: string) => process.stderr.write(message));
  let db: PrismaClient | undefined;
  try {
    const { username } = parseOfflineAdminResetPasswordArgs(argv);
    const superAdminUsernames = (dependencies.loadSuperAdminUsernames ?? loadSuperAdminUsernames)();
    const password = await readPassword('New password: ');
    const confirmation = await readPassword('Confirm new password: ');
    if (password !== confirmation) throw new OfflineResetCliError('Passwords do not match; no changes were made.');
    const parsedPassword = passwordSchema.safeParse(password);
    if (!parsedPassword.success) throw new OfflineResetCliError('Password must be between 8 and 200 characters.');
    db = (dependencies.createDatabase ?? (() => new PrismaClient()))();
    const service = new AccountRoomService(db, (candidate) => superAdminUsernames.has(candidate));
    const result = await service.resetSuperAdminPassword(username, parsedPassword.data);
    writeStdout(`Password reset for ${result.username}. Revoked ${result.revokedSessions} active session(s).\n`);
    return 0;
  } catch (error) {
    writeStderr(`${safeErrorMessage(error)}\n`);
    return 1;
  } finally {
    await db?.$disconnect();
  }
}
