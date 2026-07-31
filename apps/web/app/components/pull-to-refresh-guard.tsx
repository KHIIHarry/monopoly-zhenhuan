'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { shouldPreventPullToRefresh } from './pull-to-refresh';

export const MAIN_SCROLL_CONTAINER_SELECTOR =
  '.v2-page, .landing-page, .center, .workbench-scroll';

const INTERACTIVE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [draggable="true"], [data-allow-touch-move]';

type GestureState = {
  startX: number;
  startY: number;
  mainScrollContainer: HTMLElement;
  nestedScrollContainers: HTMLElement[];
  interactive: boolean;
};

function findNestedScrollContainers(target: Element, main: HTMLElement) {
  const containers: HTMLElement[] = [];
  let current = target instanceof HTMLElement ? target : target.parentElement;

  while (current && current !== main) {
    const overflowY = getComputedStyle(current).overflowY;
    if (
      /auto|scroll/.test(overflowY) &&
      current.scrollHeight > current.clientHeight
    ) {
      containers.push(current);
    }
    current = current.parentElement;
  }

  return containers;
}

export default function PullToRefreshGuard() {
  const pathname = usePathname();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const scrollContainer = document.querySelector<HTMLElement>(
        MAIN_SCROLL_CONTAINER_SELECTOR,
      );
      if (scrollContainer) scrollContainer.scrollTop = 0;
    });

    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    let gesture: GestureState | null = null;
    const clearGesture = () => {
      gesture = null;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !(event.target instanceof Element)) {
        clearGesture();
        return;
      }

      const touch = event.touches[0];
      const mainScrollContainer =
        event.target.closest<HTMLElement>(MAIN_SCROLL_CONTAINER_SELECTOR) ??
        document.querySelector<HTMLElement>(MAIN_SCROLL_CONTAINER_SELECTOR);
      if (!mainScrollContainer) {
        clearGesture();
        return;
      }

      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        mainScrollContainer,
        nestedScrollContainers: findNestedScrollContainers(
          event.target,
          mainScrollContainer,
        ),
        interactive: Boolean(event.target.closest(INTERACTIVE_SELECTOR)),
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!gesture || event.touches.length !== 1) return;

      const touch = event.touches[0];
      if (
        shouldPreventPullToRefresh({
          touchCount: event.touches.length,
          startX: gesture.startX,
          startY: gesture.startY,
          currentX: touch.clientX,
          currentY: touch.clientY,
          mainScrollTop: gesture.mainScrollContainer.scrollTop,
          nestedScrollTops: gesture.nestedScrollContainers.map(
            (container) => container.scrollTop,
          ),
          cancelable: event.cancelable,
          interactive: gesture.interactive,
        })
      ) {
        event.preventDefault();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', clearGesture);
    document.addEventListener('touchcancel', clearGesture);

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', clearGesture);
      document.removeEventListener('touchcancel', clearGesture);
    };
  }, []);

  return null;
}
