import { scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accountSummary,
  authMeResponse,
  clearSessionCookie,
  hashPassword,
  loginBodySchema,
  maskIp,
  sessionCookie,
  sessionSummary,
  verifyPassword,
} from './auth-domain.js';

describe('auth domain', () => {
  it('uses a salted memory-hard password hash and rejects a wrong password', async () => {
    const encoded = await hashPassword('长安月下-Strong-42');
    expect(encoded).toMatch(/^scrypt\$/);
    await expect(verifyPassword('长安月下-Strong-42', encoded)).resolves.toBe(true);
    await expect(verifyPassword('wrong', encoded)).resolves.toBe(false);

    const parts = encoded.split('$');
    const hash = parts.at(-1)!;
    parts[parts.length - 1] = `${hash[0] === 'A' ? 'B' : 'A'}${hash.slice(1)}`;
    await expect(verifyPassword('长安月下-Strong-42', parts.join('$'))).resolves.toBe(false);
  });

  it('rejects malformed or non-application scrypt encodings without throwing', async () => {
    const password = '长安月下-Strong-42';
    const encoded = await hashPassword(password);
    const [algorithm, n, r, p, saltValue, hashValue] = encoded.split('$') as [string, string, string, string, string, string];
    const salt = Buffer.from(saltValue, 'base64url');
    const alternative = (options: { N?: number; r?: number; p?: number; salt?: Buffer; length?: number }) => {
      const nextN = options.N ?? 16_384;
      const nextR = options.r ?? 8;
      const nextP = options.p ?? 1;
      const nextSalt = options.salt ?? salt;
      const length = options.length ?? 64;
      const derived = scryptSync(password, nextSalt, length, {
        N: nextN, r: nextR, p: nextP, maxmem: 64 * 1024 * 1024,
      });
      return `scrypt$${nextN}$${nextR}$${nextP}$${nextSalt.toString('base64url')}$${derived.toString('base64url')}`;
    };
    const replace = (values: string[]) => values.join('$');
    const cases = [
      ['missing segment', replace([algorithm, n, r, p, saltValue])],
      ['extra segment', `${encoded}$extra`],
      ['padded salt base64', replace([algorithm, n, r, p, `${saltValue}=`, hashValue])],
      ['padded hash base64', replace([algorithm, n, r, p, saltValue, `${hashValue}=`])],
      ['malformed salt base64', replace([algorithm, n, r, p, '***', hashValue])],
      ['malformed hash base64', replace([algorithm, n, r, p, saltValue, '***'])],
      ['altered N', alternative({ N: 8_192 })],
      ['altered r', alternative({ r: 4 })],
      ['altered p', alternative({ p: 2 })],
      ['short salt', alternative({ salt: salt.subarray(0, 15) })],
      ['short derived key', alternative({ length: 32 })],
      ['oversized derived key', alternative({ length: 65 })],
      ['noncanonical numeric parameter', replace([algorithm, '016384', r, p, saltValue, hashValue])],
      ['invalid N that makes scrypt throw', replace([algorithm, '16385', r, p, saltValue, hashValue])],
      ['non-numeric parameter that makes scrypt throw', replace([algorithm, 'NaN', r, p, saltValue, hashValue])],
    ] as const;

    for (const [label, candidate] of cases) {
      await expect(verifyPassword(password, candidate), label).resolves.toBe(false);
    }
  });

  it('sets a 30 day HttpOnly SameSite cookie and enables Secure in production', () => {
    expect(sessionCookie('secret', true)).toBe('zhenhuan_session=secret; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure');
    expect(clearSessionCookie(true)).toBe('zhenhuan_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  });

  it('masks IPv4 and IPv6 addresses by default', () => {
    expect(maskIp('120.31.22.36')).toBe('120.***.***.36');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:****:****:****:****:****:7334');
  });

  it('accepts only username and password as login input', () => {
    expect(loginBodySchema.parse({ username: ' xiaozhu ', password: 'password-123' })).toEqual({
      username: 'xiaozhu',
      password: 'password-123',
    });
    expect(() => loginBodySchema.parse({
      username: 'xiaozhu',
      password: 'password-123',
      deviceName: 'user controlled',
    })).toThrow();
  });

  it('builds auth response DTOs from allowlisted fields only', () => {
    const account = {
      id: 'account-1', username: 'xiaozhu', displayName: '小主',
      isSuperAdmin: false, canCreateRoom: true,
      passwordHash: 'password-secret', status: 'ACTIVE', note: 'private',
    };
    const session = {
      id: 'session-1', accountId: 'account-1', deviceName: 'iOS Safari',
      browser: 'Safari', operatingSystem: 'iOS', loginIp: '120.31.22.36',
      lastIp: '120.31.55.36', createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastActiveAt: new Date('2026-01-01T01:00:00.000Z'),
      sessionTokenHash: 'session-secret', rawToken: 'raw-secret', userAgent: 'secret-agent',
    };

    const safeAccount = accountSummary(account);
    const safeSession = sessionSummary(session, session.id);
    const response = authMeResponse(account, [session], session.id);

    expect(Object.keys(safeAccount).sort()).toEqual(['canCreateRoom', 'displayName', 'id', 'isSuperAdmin', 'lastLoginAt', 'username']);
    expect(safeAccount.lastLoginAt).toBeNull();
    expect(Object.keys(safeSession).sort()).toEqual([
      'browser', 'createdAt', 'current', 'deviceName', 'id', 'lastActiveAt',
      'lastIp', 'loginIp', 'operatingSystem',
    ]);
    expect(safeSession).toMatchObject({ loginIp: '120.***.***.36', lastIp: '120.***.***.36', current: true });
    expect(response).toEqual({ account: safeAccount, sessions: [safeSession] });
    expect(JSON.stringify({ safeAccount, safeSession, response })).not.toMatch(/passwordHash|sessionTokenHash|rawToken|secret/);
  });

  it('preserves the derived super-administrator flag in the auth response', () => {
    const account = { id: 'account-1', username: 'admin', displayName: '管理员', canCreateRoom: true };
    const response = authMeResponse(account, [], undefined, true);

    expect(response.account.isSuperAdmin).toBe(true);
  });
});
