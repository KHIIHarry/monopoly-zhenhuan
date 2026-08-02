import { describe, expect, it } from 'vitest';
import { selectCurrentLanding } from './landing-lifecycle';

const base = {
  playerId: 'player-1',
  spaceType: 'PROPERTY',
  propertyActionsCancelled: false,
};

describe('selectCurrentLanding', () => {
  it('restores a null-turn physical landing directly from the snapshot', () => {
    const declared = { ...base, id: 'physical-declared', status: 'DECLARED' as const };
    const confirmed = { ...base, id: 'physical-confirmed', status: 'CONFIRMED' as const };

    expect(selectCurrentLanding([declared], {
      playerId: 'player-1',
      spaceType: 'PROPERTY',
    })).toEqual(declared);
    expect(selectCurrentLanding([confirmed], {
      playerId: 'player-1',
      spaceType: 'PROPERTY',
    })).toEqual(confirmed);
  });

  it('restores a physical start landing with the same selector', () => {
    const start = {
      ...base,
      id: 'physical-start',
      spaceType: 'START',
      status: 'CONFIRMED' as const,
    };

    expect(selectCurrentLanding([start], {
      playerId: 'player-1',
      spaceType: 'START',
    })).toEqual(start);
  });

  it('uses only the active turn landing in electronic mode', () => {
    const stale = { ...base, id: 'stale', turnId: 'turn-1', status: 'CONFIRMED' as const };
    const current = { ...base, id: 'current', turnId: 'turn-2', status: 'CONFIRMED' as const };

    expect(selectCurrentLanding([stale, current], {
      playerId: 'player-1',
      spaceType: 'PROPERTY',
      activeTurnId: 'turn-2',
    })).toEqual(current);
  });

  it('rejects closed, invalidated, cancelled, wrong-player, and wrong-space entries', () => {
    const candidates = [
      { ...base, id: 'closed', status: 'CLOSED' as const },
      { ...base, id: 'invalid', status: 'INVALIDATED' as const },
      { ...base, id: 'cancelled', status: 'CONFIRMED' as const, propertyActionsCancelled: true },
      { ...base, id: 'other-player', status: 'CONFIRMED' as const, playerId: 'player-2' },
      { ...base, id: 'start', status: 'CONFIRMED' as const, spaceType: 'START' },
    ];

    expect(selectCurrentLanding(candidates, {
      playerId: 'player-1',
      spaceType: 'PROPERTY',
    })).toBeUndefined();
  });
});
