import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRoomTrashCleaner } from './room-trash-cleaner.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('room trash cleaner', () => {
  afterEach(() => {
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

  it('does not start another scan while one is running', async () => {
    vi.useFakeTimers();
    const firstRun = deferred();
    const purgeExpiredRooms = vi.fn()
      .mockImplementationOnce(() => firstRun.promise)
      .mockResolvedValue([]);
    const cleaner = startRoomTrashCleaner({ purgeExpiredRooms, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgeExpiredRooms).toHaveBeenCalledTimes(1);

    firstRun.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgeExpiredRooms).toHaveBeenCalledTimes(2);
    cleaner.stop();
  });

  it('reports a failed scan and retries on the next tick', async () => {
    vi.useFakeTimers();
    const error = new Error('scan failed');
    const onError = vi.fn();
    const purgeExpiredRooms = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue([]);
    const cleaner = startRoomTrashCleaner({ purgeExpiredRooms, onError });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(error);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(purgeExpiredRooms).toHaveBeenCalledTimes(2);
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
