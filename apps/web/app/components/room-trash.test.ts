import { describe, expect, test, vi } from 'vitest';
import {
  completeTrashWrite,
  createTrashRoomLoader,
  formatTrashCountdown,
  formatTrashDeadline,
  reloadAdminWithTrash,
  type AdminTrashRoom,
} from './room-trash';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const trashRoom = (id: string): AdminTrashRoom => ({
  id,
  name: `room-${id}`,
  code: `code-${id}`,
  status: 'FINISHED',
  deletedAt: '2026-08-04T00:00:00.000Z',
  purgeAfter: '2026-08-05T00:00:00.000Z',
  deletedBy: null,
});

describe('formatTrashCountdown', () => {
  const now = Date.parse('2026-08-04T00:00:00.000Z');

  test('rounds positive time up to the next whole hour', () => {
    expect(formatTrashCountdown('2026-08-05T00:00:00.000Z', now)).toBe(
      '剩余 24 小时',
    );
    expect(formatTrashCountdown('2026-08-04T23:01:00.000Z', now)).toBe(
      '剩余 24 小时',
    );
  });

  test('distinguishes the final partial hour from an elapsed deadline', () => {
    expect(formatTrashCountdown('2026-08-04T00:59:00.000Z', now)).toBe(
      '剩余不足 1 小时',
    );
    expect(formatTrashCountdown('2026-08-04T00:00:00.000Z', now)).toBe(
      '等待自动删除',
    );
  });

  test('uses a stable fallback for invalid deadlines and clocks', () => {
    expect(formatTrashCountdown('invalid', now)).toBe('删除时间未知');
    expect(
      formatTrashCountdown('2026-08-05T00:00:00.000Z', Number.NaN),
    ).toBe('删除时间未知');
  });
});

describe('formatTrashDeadline', () => {
  test('formats the deadline in Chinese local time without seconds', () => {
    const localDeadline = new Date(2026, 7, 5, 8, 30).toISOString();

    expect(formatTrashDeadline(localDeadline)).toBe('2026/08/05 08:30');
  });

  test('uses a stable fallback for an invalid deadline', () => {
    expect(formatTrashDeadline('invalid')).toBe('删除时间未知');
  });
});

describe('room trash loading control', () => {
  test('starts independently while the initial admin load is still pending', async () => {
    const adminRequest = deferred<void>();
    const trashRequest = deferred<AdminTrashRoom[]>();
    const read = vi.fn(() => trashRequest.promise);
    const loader = createTrashRoomLoader({ read, onValue: vi.fn() });

    const adminLoad = adminRequest.promise;
    const trashLoad = loader.load();

    expect(read).toHaveBeenCalledOnce();
    trashRequest.resolve([trashRoom('trash')]);
    await expect(trashLoad).resolves.toMatchObject({ ok: true });
    adminRequest.resolve();
    await adminLoad;
  });

  test('returns the same real in-flight request to reentrant callers', async () => {
    const request = deferred<AdminTrashRoom[]>();
    const read = vi.fn(() => request.promise);
    const onValue = vi.fn();
    const loader = createTrashRoomLoader({ read, onValue });

    const first = loader.load();
    const reentrant = loader.load();

    expect(reentrant).toBe(first);
    expect(read).toHaveBeenCalledOnce();
    request.resolve([trashRoom('shared')]);
    await expect(Promise.all([first, reentrant])).resolves.toEqual([
      { ok: true, value: [trashRoom('shared')] },
      { ok: true, value: [trashRoom('shared')] },
    ]);
    expect(onValue).toHaveBeenCalledOnce();
  });

  test('invalidates an old lifecycle and lets the latest real request win', async () => {
    const first = deferred<AdminTrashRoom[]>();
    const latest = deferred<AdminTrashRoom[]>();
    const read = vi
      .fn<() => Promise<AdminTrashRoom[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const onValue = vi.fn();
    const loader = createTrashRoomLoader({ read, onValue });

    const staleLoad = loader.load();
    loader.invalidate();
    const latestLoad = loader.load();
    expect(read).toHaveBeenCalledTimes(2);

    latest.resolve([trashRoom('latest')]);
    await latestLoad;
    first.resolve([trashRoom('stale')]);
    await staleLoad;

    expect(onValue).toHaveBeenCalledOnce();
    expect(onValue).toHaveBeenCalledWith([trashRoom('latest')]);
  });

  test('reports a current read failure and resolves it as failed', async () => {
    const error = new Error('trash unavailable');
    const onError = vi.fn();
    const loader = createTrashRoomLoader({
      read: vi.fn().mockRejectedValue(error),
      onValue: vi.fn(),
      onError,
    });

    await expect(loader.load()).resolves.toEqual({ ok: false, error });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe('room trash reload and write completion', () => {
  const adminData = { accounts: [], rooms: [] };

  test('treats a trash failure after the main reload as an overall failure', async () => {
    const error = new Error('trash unavailable');
    const loadTrash = vi.fn().mockResolvedValue({ ok: false, error });

    await expect(
      reloadAdminWithTrash(
        vi.fn().mockResolvedValue({ ok: true, value: adminData }),
        loadTrash,
        () => true,
      ),
    ).resolves.toEqual({ ok: false, error });
    expect(loadTrash).toHaveBeenCalledOnce();
  });

  test('does not confirm the stable write intent unless both reloads succeed', async () => {
    const confirm = vi.fn();
    const write = vi.fn().mockResolvedValue({ ok: true, confirm });
    const failedReload = vi
      .fn()
      .mockResolvedValue({ ok: false, error: new Error('trash unavailable') });

    await expect(completeTrashWrite(write, failedReload)).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();

    await expect(
      completeTrashWrite(write, vi.fn().mockResolvedValue({ ok: true, value: adminData })),
    ).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
