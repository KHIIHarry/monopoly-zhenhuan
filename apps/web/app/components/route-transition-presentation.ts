"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ROUTE_CONTENT_REVEAL_MS,
  createMinimumRouteSkeletonGate,
} from "./route-transition";

export function useRouteTransitionPresentation(loading: boolean) {
  const [holding, setHolding] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const loadingRef = useRef(loading);
  const revealTimer = useRef<number | null>(null);
  const gateRef = useRef<ReturnType<
    typeof createMinimumRouteSkeletonGate
  > | null>(null);
  loadingRef.current = loading;

  const clearReveal = useCallback(() => {
    if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    revealTimer.current = null;
    delete document.documentElement.dataset.routeReveal;
  }, []);

  if (gateRef.current === null) {
    gateRef.current = createMinimumRouteSkeletonGate({
      onRelease: (generation) => {
        if (
          loadingRef.current ||
          gateRef.current?.currentGeneration() !== generation
        ) {
          return;
        }
        clearReveal();
        document.documentElement.dataset.routeReveal = "true";
        setHolding(false);
        revealTimer.current = window.setTimeout(
          clearReveal,
          ROUTE_CONTENT_REVEAL_MS,
        );
      },
    });
  }

  const cancelMinimumDelay = useCallback(() => {
    gateRef.current?.cancel();
    clearReveal();
    setHolding(false);
  }, [clearReveal]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useLayoutEffect(() => {
    if (reducedMotion) {
      gateRef.current?.cancel();
      clearReveal();
      setHolding(false);
      return;
    }
    if (loading) {
      clearReveal();
      gateRef.current?.begin();
      setHolding(true);
      return;
    }
    gateRef.current?.requestRelease();
  }, [clearReveal, loading, reducedMotion]);

  useEffect(
    () => () => {
      gateRef.current?.cancel();
      clearReveal();
    },
    [clearReveal],
  );

  return { showSkeleton: loading || holding, cancelMinimumDelay };
}
