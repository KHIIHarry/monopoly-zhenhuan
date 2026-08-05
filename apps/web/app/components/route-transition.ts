export const MIN_ROUTE_SKELETON_MS = 600;
export const MIN_ROUTE_LOADER_MS = 300;
export const ROUTE_CONTENT_REVEAL_MS = 160;
export const ROUTE_TRANSITION_TIMEOUT_MS = 10_000;

type MinimumRouteSkeletonGateOptions = {
  onRelease: (generation: number) => void;
  minimumMs?: number;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
};

export function createMinimumRouteSkeletonGate({
  onRelease,
  minimumMs = MIN_ROUTE_SKELETON_MS,
  now = () => performance.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
}: MinimumRouteSkeletonGateOptions) {
  const defaultMinimumMs = minimumMs;
  let generation = 0;
  let startedAt: number | null = null;
  let activeMinimumMs = defaultMinimumMs;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  return {
    begin(nextMinimumMs = defaultMinimumMs) {
      generation += 1;
      clearTimer();
      startedAt = now();
      activeMinimumMs = nextMinimumMs;
      return generation;
    },
    requestRelease(expectedGeneration = generation) {
      if (startedAt === null || expectedGeneration !== generation) return false;
      clearTimer();
      const remaining = Math.max(0, activeMinimumMs - (now() - startedAt));
      const finish = () => {
        if (startedAt === null || expectedGeneration !== generation) return;
        timer = null;
        startedAt = null;
        onRelease(expectedGeneration);
      };
      if (remaining === 0) finish();
      else timer = schedule(finish, remaining);
      return true;
    },
    cancel() {
      generation += 1;
      clearTimer();
      startedAt = null;
    },
    currentGeneration() {
      return generation;
    },
  };
}

export function isSameClientRoute(
  target: string,
  current: Pick<Location, "href">,
) {
  const targetUrl = new URL(target, current.href);
  const currentUrl = new URL(current.href);
  return (
    targetUrl.pathname === currentUrl.pathname &&
    targetUrl.search === currentUrl.search
  );
}

export function createRouteTransitionWatchdog(
  onTimeout: () => void,
  schedule: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  return {
    arm() {
      clear();
      timer = schedule(() => {
        timer = null;
        onTimeout();
      }, ROUTE_TRANSITION_TIMEOUT_MS);
    },
    clear,
  };
}
