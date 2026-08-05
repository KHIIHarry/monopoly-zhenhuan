import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_ROUTE_SKELETON_MS,
  ROUTE_CONTENT_REVEAL_MS,
  ROUTE_TRANSITION_TIMEOUT_MS,
  createMinimumRouteSkeletonGate,
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

  it("holds a fast route only for the remaining minimum duration", () => {
    vi.useFakeTimers();
    let now = 0;
    const onRelease = vi.fn();
    const gate = createMinimumRouteSkeletonGate({ onRelease, now: () => now });

    const generation = gate.begin();
    now = 200;
    expect(gate.requestRelease(generation)).toBe(true);
    vi.advanceTimersByTime(MIN_ROUTE_SKELETON_MS - 201);
    expect(onRelease).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRelease).toHaveBeenCalledWith(generation);
  });

  it("releases immediately when real loading exceeds the minimum", () => {
    let now = 0;
    const onRelease = vi.fn();
    const gate = createMinimumRouteSkeletonGate({ onRelease, now: () => now });

    const generation = gate.begin();
    now = MIN_ROUTE_SKELETON_MS + 1;
    expect(gate.requestRelease(generation)).toBe(true);
    expect(onRelease).toHaveBeenCalledWith(generation);
  });

  it("cannot release a newer navigation from an older timer", () => {
    vi.useFakeTimers();
    let now = 0;
    const onRelease = vi.fn();
    const gate = createMinimumRouteSkeletonGate({ onRelease, now: () => now });

    const first = gate.begin();
    now = 100;
    gate.requestRelease(first);
    now = 200;
    const second = gate.begin();
    now = 250;
    gate.requestRelease(second);

    vi.advanceTimersByTime(500);
    expect(onRelease).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith(second);
  });

  it("cancel prevents a pending artificial release", () => {
    vi.useFakeTimers();
    const onRelease = vi.fn();
    const gate = createMinimumRouteSkeletonGate({ onRelease, now: () => 0 });

    const generation = gate.begin();
    gate.requestRelease(generation);
    gate.cancel();
    vi.runAllTimers();

    expect(onRelease).not.toHaveBeenCalled();
  });

  it("exports the approved transition timings", () => {
    expect(MIN_ROUTE_SKELETON_MS).toBe(600);
    expect(ROUTE_CONTENT_REVEAL_MS).toBe(160);
  });
});
