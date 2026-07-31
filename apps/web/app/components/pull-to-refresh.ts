export type PullGestureDecisionInput = {
  touchCount: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  mainScrollTop: number;
  nestedScrollTops: number[];
  cancelable: boolean;
  interactive: boolean;
};

const MOVEMENT_THRESHOLD = 5;

export function shouldPreventPullToRefresh(
  input: PullGestureDecisionInput,
): boolean {
  const deltaX = input.currentX - input.startX;
  const deltaY = input.currentY - input.startY;

  return (
    input.touchCount === 1 &&
    input.cancelable &&
    !input.interactive &&
    input.mainScrollTop <= 0 &&
    input.nestedScrollTops.every((scrollTop) => scrollTop <= 0) &&
    deltaY > MOVEMENT_THRESHOLD &&
    deltaY > Math.abs(deltaX)
  );
}
