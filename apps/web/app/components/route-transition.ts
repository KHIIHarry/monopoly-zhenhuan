export const ROUTE_TRANSITION_TIMEOUT_MS = 10_000;

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
