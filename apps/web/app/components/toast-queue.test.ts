import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToastQueue } from './toast-queue.js';

describe('toast queue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows queued items FIFO for exactly 3000 ms each', () => {
    vi.useFakeTimers();
    const changes: Array<string | null> = [];
    const queue = createToastQueue((toast) => { changes.push(toast?.message ?? null); });

    queue.enqueue({ id: 'one', message: '第一条' });
    queue.enqueue({ id: 'two', message: '第二条' });
    expect(queue.current()).toMatchObject({ message: '第一条' });
    vi.advanceTimersByTime(2_999);
    expect(queue.current()).toMatchObject({ message: '第一条' });
    vi.advanceTimersByTime(1);
    expect(queue.current()).toMatchObject({ message: '第二条' });
    vi.advanceTimersByTime(3_000);
    expect(queue.current()).toBeNull();
    expect(changes).toEqual(['第一条', '第二条', null]);
  });

  it('deduplicates stable IDs while assigning unique IDs to local messages', () => {
    vi.useFakeTimers();
    const queue = createToastQueue(() => undefined);

    expect(queue.enqueue({ id: 'fund-1', message: '资金提醒' })).toBe(true);
    expect(queue.enqueue({ id: 'fund-1', message: '重复资金提醒' })).toBe(false);
    expect(queue.enqueue({ message: '本地操作一' })).toBe(true);
    expect(queue.enqueue({ message: '本地操作二' })).toBe(true);
    vi.advanceTimersByTime(3_000);
    const firstLocal = queue.current();
    vi.advanceTimersByTime(3_000);
    const secondLocal = queue.current();

    expect(firstLocal?.id).toMatch(/^local:/);
    expect(secondLocal?.id).toMatch(/^local:/);
    expect(secondLocal?.id).not.toBe(firstLocal?.id);
  });

  it('clears timers and seen IDs and disposal prevents later callbacks', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const queue = createToastQueue(onChange);
    queue.enqueue({ id: 'fund-1', message: '资金提醒' });
    queue.enqueue({ id: 'fund-2', message: '第二条' });

    queue.clear();
    expect(queue.current()).toBeNull();
    expect(queue.enqueue({ id: 'fund-1', message: '清理后可再次加入' })).toBe(true);
    queue.dispose();
    const callsAfterDispose = onChange.mock.calls.length;
    vi.advanceTimersByTime(10_000);

    expect(queue.current()).toBeNull();
    expect(queue.enqueue({ message: '不会显示' })).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(callsAfterDispose);
  });
});
