import { z } from 'zod';

export const realtimeToastEventSchema = z.object({
  eventId: z.string().min(1),
  roomId: z.string().min(1),
  audience: z.enum(['PLAYER', 'BANK']),
  kind: z.enum(['FUNDS', 'REQUEST_REJECTED']),
  message: z.string().trim().min(1).max(240),
}).strict();

export type RealtimeToastEvent = z.infer<typeof realtimeToastEventSchema>;
export type RealtimeToastAudience = RealtimeToastEvent['audience'];

export type SkillInput = { skipTurns: number; amount: number };

export type MasterCharacter = {
  id: string; name: string; initialProperty: string;
  skill: { code: string; name: string; description: string; config: Record<string, number> };
};

export type RawMasterData = {
  currency: string;
  dice: { count: number; sides: number; minTotal: number; maxTotal: number };
  startReward: number;
  characters: MasterCharacter[];
  properties: Array<{ name: string; mortgage: number; tolls: number[]; build: number; building_sell: number; sale: number }>;
};

export function loadMasterData(raw: unknown) {
  const data = raw as RawMasterData;
  if (data.properties.length !== 26 || data.characters.length !== 5) throw new Error('INVALID_MASTER_DATA');
  if (data.dice.count !== 2 || data.dice.sides !== 6) throw new Error('INVALID_DICE_CONFIG');
  return {
    ...data,
    properties: data.properties.map((item) => ({ ...item, purchasePrice: item.sale, buildingSell: item.building_sell }))
  };
}

export function roll2d6(random: () => number = Math.random) {
  const die = () => Math.floor(random() * 6) + 1;
  const dice: [number, number] = [die(), die()];
  return { dice, total: dice[0] + dice[1] };
}

export function calculateToll(input: { tolls: number[]; level: number; mortgaged: boolean }) {
  if (input.mortgaged) throw new Error('MORTGAGED_PROPERTY');
  return input.tolls[input.level] ?? 0;
}

export function applySkill(code: string, input: SkillInput, characters: MasterCharacter[]): SkillInput {
  const config = characters.find((character) => character.skill.code === code)?.skill.config ?? {};
  switch (code) {
    case 'COLD_PALACE_RELIEF': return { skipTurns: Math.max(0, input.skipTurns - (config.skipTurnsReduction ?? 0)), amount: input.amount + (config.cashReward ?? 0) };
    case 'TOLL_BONUS': return { ...input, amount: input.amount + (config.bonus ?? 0) };
    case 'PLOT_FINE_REDUCTION': return { ...input, amount: Math.max(0, input.amount - (config.reduction ?? 0)) };
    case 'BUILD_DISCOUNT': return { ...input, amount: Math.max(0, input.amount - (config.discount ?? 0)) };
    case 'COMPANION_REWARD': return { ...input, amount: input.amount + (config.cashReward ?? 0) };
    default: return input;
  }
}
