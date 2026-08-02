export type JoinBlockedReason =
  | 'MIDGAME_JOIN_DISABLED'
  | 'PLAYER_LIMIT'
  | 'ROOM_FINISHED';

export type RoomJoinability = {
  canJoin: boolean;
  joinBlockedReason: JoinBlockedReason | null;
};

type AdmissionRoom = {
  status: string;
  allowMidgameJoin: boolean;
  playerLimit: number;
};

export function roomJoinability(
  room: AdmissionRoom,
  activePlayerCount: number,
): RoomJoinability {
  if (['ENDED', 'FINISHED', 'CLOSED'].includes(room.status)) {
    return { canJoin: false, joinBlockedReason: 'ROOM_FINISHED' };
  }
  if (room.status === 'PLAYING' && !room.allowMidgameJoin) {
    return { canJoin: false, joinBlockedReason: 'MIDGAME_JOIN_DISABLED' };
  }
  if (room.status === 'PLAYING' && activePlayerCount >= room.playerLimit) {
    return { canJoin: false, joinBlockedReason: 'PLAYER_LIMIT' };
  }
  return { canJoin: true, joinBlockedReason: null };
}
