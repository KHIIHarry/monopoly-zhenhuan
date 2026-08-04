import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRoomTrashCleaner } from './room-trash-cleaner.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe('room trash cleaner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs immediately when started', async () => {
    vi.useFakeTimers();
    const purgeExpiredRooms = vi.fn().mockResolvedValue([]);

    const cleaner = startRoomTrashCleaner({ purgeExpiredRooms, onError: vi.fn() });
    await cleaner.runNow();

    expect(purgeExpiredRooms).toHaveBeenCalledTimes(1);
    cleaner.stop();
  });

  it('runs every minute by default', async () => {
    vi.useFakeTimers();
    const purgeExpiredRooms = vi.fn().mockResolvedValue([]);
    const cleaner = startRoomTrashCleaner({ purgeExpiredRooms, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(purgeExpiredRooms).toHaveBeenCalledTimes(2);
    cleaner.stop();
  });

  it('honors a valid custom interval', async () => {
    vi.useFakeTimers();
    const purgeExpiredRooms = vi.fn().mockResolvedValue([]);
    const cleaner = startRoomTrashCleaner({ purgeExpiredRooms, intervalMs: 1_234, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(1_233);
    expect(purgeExpiredRooms).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(purgeExpiredRooms).toHaveBeenCalledTimes(2);
    cleaner.stop();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'falls back to one minute for invalid interval %s',
    (intervalMs) => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const cleaner = startRoomTrashCleaner({
        purgeExpiredRooms: vi.fn().mockResolvedValue([]),
        intervalMs,
        onError: vi.fn(),
      });

      expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 60_000);
      cleaner.stop();
    },
  );

  it('does not start another scan while one is running', async () => {
    vi.useFakeTimers();
    const firstRun = deferred();
    const purgeExpiredRooms = vi.fn()
      .mockImplementationOnce(() => firstRun.promise)
      .mockResolvedValue([]);
    const cleaner = startRoomTrashCleaner({ purgeExpiredRooms, onError: vi.fn() });
    let joinedRunFinished = false;
    const joinedRun = cleaner.runNow().then(() => { joinedRunFinished = true; });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgeExpiredRooms).toHaveBeenCalledTimes(1);
    expect(joinedRunFinished).toBe(false);

    firstRun.resolve();
    await joinedRun;
    expect(joinedRunFinished).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgeExpiredRooms).toHaveBeenCalledTimes(2);
    cleaner.stop();
  });

  it('isolates a throwing error observer and retries on the next tick', async () => {
    vi.useFakeTimers();
    const error = new Error('scan failed');
    const observerError = new Error('observer failed');
    const onError = vi.fn(() => { throw observerError; });
    const purgeExpiredRooms = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(error)
      .mockResolvedValue([]);
    const cleaner = startRoomTrashCleaner({ purgeExpiredRooms, onError });

    await vi.advanceTimersByTimeAsync(0);
    await expect(cleaner.runNow()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgeExpiredRooms).toHaveBeenCalledTimes(3);
    cleaner.stop();
  });

  it('stops cleanly and can be stopped more than once', async () => {
    vi.useFakeTimers();
    const purgeExpiredRooms = vi.fn().mockResolvedValue([]);
    const cleaner = startRoomTrashCleaner({ purgeExpiredRooms, onError: vi.fn() });

    cleaner.stop();
    cleaner.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(purgeExpiredRooms).toHaveBeenCalledTimes(1);
  });
});
