import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROUTE_TRANSITION_TIMEOUT_MS,
  createRouteTransitionWatchdog,
  isSameClientRoute,
} from "./route-transition";

afterEach(() => vi.useRealTimers());

describe("route transition", () => {
  it("compares pathname and search while ignoring the hash", () => {
    const current = { href: "http://localhost:3000/rooms?tab=mine#top" };

    expect(isSameClientRoute("/rooms?tab=mine", current)).toBe(true);
    expect(isSameClientRoute("/rooms?tab=all", current)).toBe(false);
    expect(isSameClientRoute("/profile", current)).toBe(false);
  });

  it("rearming keeps only one ten-second timeout", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = createRouteTransitionWatchdog(onTimeout);

    watchdog.arm();
    vi.advanceTimersByTime(ROUTE_TRANSITION_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.arm();
    vi.advanceTimersByTime(ROUTE_TRANSITION_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("clear cancels a pending timeout", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = createRouteTransitionWatchdog(onTimeout);

    watchdog.arm();
    watchdog.clear();
    vi.runAllTimers();

    expect(onTimeout).not.toHaveBeenCalled();
  });
});
