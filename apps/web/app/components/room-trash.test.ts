import { describe, expect, test } from 'vitest';
import {
  formatTrashCountdown,
  formatTrashDeadline,
} from './room-trash';

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
});

describe('formatTrashDeadline', () => {
  test('formats the deadline in Chinese local time without seconds', () => {
    const localDeadline = new Date(2026, 7, 5, 8, 30).toISOString();

    expect(formatTrashDeadline(localDeadline)).toBe('2026/08/05 08:30');
  });
});
