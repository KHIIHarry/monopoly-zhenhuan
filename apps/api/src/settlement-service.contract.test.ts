import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('settlement service transaction contract', () => {
  it('reauthorizes and replays an exact persisted winner after a settlement uniqueness race', async () => {
    const source = await readFile(new URL('./account-room-service.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/recoverSettlementConflict\([\s\S]*?authorizeSettlement\([\s\S]*?assertRequestHash\([\s\S]*?settlementDto/);
    expect(source).toMatch(/error\.code === 'P2002'[\s\S]*?recoverSettlementConflict/);
    expect(source).not.toMatch(/error\.code === 'P2002'\) fail\('TRANSACTION_CONFLICT'\)/);
  });

  it('declares blockers as a discriminated union with no shared optional resource bag', async () => {
    const source = await readFile(new URL('./account-room-service.ts', import.meta.url), 'utf8');
    const declaration = source.match(/const settlementBlockerSchema = z\.discriminatedUnion\('code', \[[\s\S]*?\]\);\nconst settlementWinnersSchema/)?.[0] ?? '';
    for (const code of [
      'PENDING_GAME_REQUEST', 'INCOMPLETE_PROPERTY_TRADE', 'PROPERTY_ACTION_LOCKED',
      'PENDING_ROLE_SWAP', 'INVALID_PLAYER_BALANCE', 'OPEN_DEBT',
      'UNRESOLVED_LANDING', 'ACTIVE_TURN', 'SETTLEMENT_DATA_INVALID',
    ]) expect(declaration).toContain(`z.literal('${code}')`);
    expect(declaration).not.toMatch(/requestId:\s*z\.[^\n]*\.optional\(|playerId:\s*z\.[^\n]*\.optional\(|membershipId:\s*z\.[^\n]*\.optional\(/);
    expect(source).toContain('export type SettlementBlocker = z.infer<typeof settlementBlockerSchema>;');
  });
});
