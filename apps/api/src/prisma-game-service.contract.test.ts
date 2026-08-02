import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('PrismaGameService V2 production boundary', () => {
  it('exposes request and landing submission times in room snapshots', async () => {
    const source = await readFile(new URL('./prisma-game-service.ts', import.meta.url), 'utf8');

    expect(source).toContain('createdAt: request.createdAt');
    expect(source).toContain('createdAt: landing.declaredAt');
  });

  it('contains no legacy room admission, reconnect, bearer-token, or removed membership fields', async () => {
    const source = await readFile(new URL('./prisma-game-service.ts', import.meta.url), 'utf8');

    for (const forbidden of [
      /\bcreateRoom\s*\(/,
      /\bjoinPlayer\s*\(/,
      /\bjoinBank\s*\(/,
      /\breconnect\s*\(/,
      /\bauthorizePlayer\s*\(/,
      /\bauthorizeBank\s*\(/,
      /\bauthorizeMember\s*\(/,
      /matchesBearerToken/,
      /deviceTokenHash/,
      /bankControlGrantedAt/,
      /onlineStatus/,
      /lastSeenAt/,
      /(?:member|membership)\.role\b/,
    ]) expect(source).not.toMatch(forbidden);
  });

  it('accepts an explicit account/session actor and never a token argument', async () => {
    const source = await readFile(new URL('./prisma-game-service.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/export type GameActor\s*=\s*\{/);
    expect(source).toMatch(/accountId:\s*string/);
    expect(source).toMatch(/sessionId:\s*string/);
    expect(source).not.toMatch(/(?:device|bank|bearer|raw)Token\s*:\s*string/);
  });
});
