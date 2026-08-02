import { describe, expect, it } from 'vitest';
import { roomJoinability } from './room-admission.js';

describe('roomJoinability', () => {
  it('keeps lobby admission unlimited even when character seats are full', () => {
    expect(roomJoinability(
      { status: 'LOBBY', allowMidgameJoin: false, playerLimit: 5 },
      5,
    )).toEqual({ canJoin: true, joinBlockedReason: null });
  });

  it('prioritizes terminal, disabled, and full reasons in that order', () => {
    expect(roomJoinability(
      { status: 'FINISHED', allowMidgameJoin: false, playerLimit: 5 },
      5,
    )).toEqual({ canJoin: false, joinBlockedReason: 'ROOM_FINISHED' });
    expect(roomJoinability(
      { status: 'PLAYING', allowMidgameJoin: false, playerLimit: 5 },
      5,
    )).toEqual({ canJoin: false, joinBlockedReason: 'MIDGAME_JOIN_DISABLED' });
    expect(roomJoinability(
      { status: 'PLAYING', allowMidgameJoin: true, playerLimit: 5 },
      5,
    )).toEqual({ canJoin: false, joinBlockedReason: 'PLAYER_LIMIT' });
    expect(roomJoinability(
      { status: 'PLAYING', allowMidgameJoin: true, playerLimit: 5 },
      4,
    )).toEqual({ canJoin: true, joinBlockedReason: null });
  });
});
