export type LandingLifecycleCandidate = {
  playerId: string;
  spaceType: string;
  status: 'DECLARED' | 'CONFIRMED' | 'CLOSED' | 'INVALIDATED';
  propertyActionsCancelled: boolean;
  turnId?: string;
};

export function selectCurrentLanding<T extends LandingLifecycleCandidate>(
  landings: readonly T[] | undefined,
  options: {
    playerId: string;
    spaceType: string;
    activeTurnId?: string;
  },
): T | undefined {
  return landings?.find((landing) =>
    landing.playerId === options.playerId &&
    landing.spaceType === options.spaceType &&
    (landing.status === 'DECLARED' || landing.status === 'CONFIRMED') &&
    !landing.propertyActionsCancelled &&
    (landing.turnId === undefined || landing.turnId === options.activeTurnId),
  );
}
