import { describe, expect, test } from 'vitest';
import { shouldPreventPullToRefresh } from './pull-to-refresh';

const qualifyingGesture = {
  touchCount: 1,
  startX: 20,
  startY: 100,
  currentX: 21,
  currentY: 120,
  mainScrollTop: 0,
  nestedScrollTops: [],
  cancelable: true,
  interactive: false,
};

describe('pull-to-refresh gesture decision', () => {
  test('prevents a single-finger downward overscroll at the main top edge', () => {
    expect(shouldPreventPullToRefresh(qualifyingGesture)).toBe(true);
  });

  test('allows an outer nested scroller to consume the downward drag', () => {
    const nestedGesture = { ...qualifyingGesture, nestedScrollTops: [0, 12] };

    expect(shouldPreventPullToRefresh(nestedGesture)).toBe(false);
  });

  test.each([
    ['main content is not at the top', { mainScrollTop: 1 }],
    ['a nested scroller can consume the drag', { nestedScrollTops: [1] }],
    ['the gesture moves upward', { currentY: 80 }],
    ['horizontal movement dominates', { currentX: 60, currentY: 110 }],
    ['movement is below the threshold', { currentY: 104 }],
    ['the gesture has multiple touches', { touchCount: 2 }],
    ['the target is interactive', { interactive: true }],
    ['the event cannot be canceled', { cancelable: false }],
  ])('allows touch movement when %s', (_name, change) => {
    expect(
      shouldPreventPullToRefresh({ ...qualifyingGesture, ...change }),
    ).toBe(false);
  });
});
