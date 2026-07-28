import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { z } from 'zod';
const sessionSeconds = 30 * 24 * 60 * 60;
const scryptN = 16_384;
const scryptR = 8;
const scryptP = 1;
const scryptSaltLength = 16;
const scryptDerivedLength = 64;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

export const sessionCookieName = 'zhenhuan_session';
export const sessionDurationMs = sessionSeconds * 1000;
export const loginBodySchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
}).strict();

const scrypt = (password: string, salt: Buffer, length: number, options: ScryptOptions) => new Promise<Buffer>((resolve, reject) => {
  scryptCallback(password, salt, length, options, (error, derived) => error ? reject(error) : resolve(derived));
});

export async function hashPassword(password: string) {
  const salt = randomBytes(scryptSaltLength);
  const derived = await scrypt(password, salt, scryptDerivedLength, { N: scryptN, r: scryptR, p: scryptP, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${scryptN}$${scryptR}$${scryptP}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split('$');
  if (parts.length !== 6) return false;
  const [algorithm, n, r, p, saltValue, hashValue] = parts;
  if (
    algorithm !== 'scrypt'
    || n !== String(scryptN)
    || r !== String(scryptR)
    || p !== String(scryptP)
    || saltValue?.length !== 22
    || hashValue?.length !== 86
    || !base64UrlPattern.test(saltValue)
    || !base64UrlPattern.test(hashValue)
  ) return false;

  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(hashValue, 'base64url');
  if (
    salt.length !== scryptSaltLength
    || expected.length !== scryptDerivedLength
    || salt.toString('base64url') !== saltValue
    || expected.toString('base64url') !== hashValue
  ) return false;

  try {
    const actual = await scrypt(password, salt, scryptDerivedLength, {
      N: scryptN, r: scryptR, p: scryptP, maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function cookie(value: string, maxAge: number, secure: boolean) {
  return `${sessionCookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export const sessionCookie = (token: string, secure: boolean) => cookie(token, sessionSeconds, secure);
export const clearSessionCookie = (secure: boolean) => cookie('', 0, secure);

export function maskIp(ip: string) {
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.***.***.${parts[3]}` : '***';
  }
  const parts = ip.split(':').filter(Boolean);
  return `${parts[0] ?? '****'}:${parts[1] ?? '****'}:****:****:****:****:****:${parts.at(-1) ?? '****'}`;
}

type AccountSummaryInput = {
  id: string;
  username: string;
  displayName: string;
  canCreateRoom: boolean;
  lastLoginAt?: Date | null;
};

type SessionSummaryInput = {
  id: string;
  deviceName: string;
  browser: string;
  operatingSystem: string;
  loginIp: string;
  lastIp: string;
  createdAt: Date;
  lastActiveAt: Date;
};

export function accountSummary(account: AccountSummaryInput, isSuperAdmin = false) {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    isSuperAdmin,
    canCreateRoom: account.canCreateRoom,
    lastLoginAt: account.lastLoginAt ?? null,
  };
}

export function sessionSummary(session: SessionSummaryInput, currentSessionId?: string) {
  return {
    id: session.id,
    deviceName: session.deviceName,
    browser: session.browser,
    operatingSystem: session.operatingSystem,
    loginIp: maskIp(session.loginIp),
    lastIp: maskIp(session.lastIp),
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    current: session.id === currentSessionId,
  };
}

export function authMeResponse(
  account: AccountSummaryInput,
  sessions: SessionSummaryInput[],
  currentSessionId?: string,
  isSuperAdmin = false,
) {
  return {
    account: accountSummary(account, isSuperAdmin),
    sessions: sessions.map((session) => sessionSummary(session, currentSessionId)),
  };
}
