export type BrowserRoomStatus = 'LOBBY' | 'PLAYING' | 'ENDED' | 'FINISHED' | 'CLOSED';

export type BrowserRoomSummary = {
  id: string;
  name: string;
  status: BrowserRoomStatus;
  creator: string;
  memberCount: number;
  playerCount: number;
  playerLimit: number;
  hasPassword: boolean;
  mine: boolean;
  canJoin: boolean;
  joinBlockedReason: 'MIDGAME_JOIN_DISABLED' | 'PLAYER_LIMIT' | 'ROOM_FINISHED' | null;
  availableCharacters: Array<{ id: string; name: string }>;
  characterId: string | null;
  myCharacter: string | null;
  isBank: boolean;
  createdAt?: string;
  startedAt?: string | null;
  endedAt?: string | null;
};

export type BrowserMembership = {
  id: string;
  characterId: string | null;
  playerId: string | null;
  isBank: boolean;
  activeHere: boolean;
};

export type BrowserSeatSnapshot<TRequest = unknown> = {
  stateVersion: number;
  room: {
    id: string;
    name: string;
    status: BrowserRoomStatus;
    skillEnabled: boolean;
  };
  membership: BrowserMembership | null;
  characters: Array<{
    id: string;
    name: string;
    skill: Record<string, unknown>;
    initialProperty: string;
    occupiedBy: string | null;
    canSelect: boolean;
  }>;
  bank: { occupiedBy: string | null };
  roleSwapRequests: TRequest[];
};

export type BrowserSnapshot = {
  id: string;
  stateVersion: number;
  code: string;
  name: string;
  status: Exclude<BrowserRoomStatus, 'CLOSED'>;
  diceMode: 'ELECTRONIC' | 'PHYSICAL';
  redemptionFee: number;
  startReward: number;
  currentPlayerId?: string;
  turn: unknown;
  players: Array<{
    id: string;
    name: string;
    characterId: string | null;
    balance: number;
    remainingSkipTurns: number;
    [key: string]: unknown;
  }>;
  properties: unknown[];
  ledger: unknown[];
  requests: unknown[];
  landings?: unknown[];
  audit?: unknown[];
  reversalCandidate: unknown;
};
