import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RouteSkeleton, { type RouteSkeletonVariant } from "./route-skeleton";

const renderVariant = (variant: RouteSkeletonVariant) =>
  renderToStaticMarkup(createElement(RouteSkeleton, { variant }));

describe("RouteSkeleton", () => {
  it.each(["rooms", "player", "bank", "workbench"] as const)(
    "renders the %s dedicated skeleton with its approved route marker",
    (variant) => {
      const markup = renderVariant(variant);

      expect(markup).toContain('data-testid="route-skeleton"');
      expect(markup).toContain(`data-variant="${variant}"`);
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-busy="true"');
      expect(markup).toContain("页面加载中");
    },
  );

  it("uses stable region-level structures for all four dedicated pages", () => {
    expect(renderVariant("rooms")).toMatch(
      /data-region="room-header"[\s\S]*?data-region="room-list"/,
    );
    expect(renderVariant("player")).toMatch(
      /data-region="workbench-nav"[\s\S]*?data-region="player-header"[\s\S]*?data-region="player-identity"[\s\S]*?data-region="turn"[\s\S]*?data-region="player-actions"[\s\S]*?data-region="properties"/,
    );
    expect(renderVariant("bank")).toMatch(
      /data-region="workbench-nav"[\s\S]*?data-region="bank-header"[\s\S]*?data-region="bank-summary"[\s\S]*?data-region="turn"[\s\S]*?data-region="player-overview"[\s\S]*?data-region="approvals"/,
    );
    expect(renderVariant("workbench")).toMatch(
      /data-region="selector-heading"[\s\S]*?data-region="identity-choices"[\s\S]*?data-region="selector-commands"/,
    );
  });

  it("keeps the mobile player and bank navigation bars visually empty", () => {
    for (const variant of ["player", "bank"] as const) {
      const markup = renderVariant(variant);
      expect(markup).toMatch(
        /<nav[^>]*data-region="mobile-nav"[^>]*><\/nav>/,
      );
      expect(markup).not.toContain("workbench-segment");
    }
  });

  it("renders the palace-red generic loader at the shared default entry", () => {
    const loaderMarkup = renderVariant("loader");
    const defaultMarkup = renderToStaticMarkup(createElement(RouteSkeleton));

    expect(loaderMarkup).toContain('data-testid="route-loader"');
    expect(loaderMarkup).toContain('data-variant="loader"');
    expect(loaderMarkup).toContain("加载中...");
    expect(loaderMarkup).not.toContain('data-testid="route-skeleton"');
    expect(defaultMarkup).toBe(loaderMarkup);
  });

  it("uses the approved geometry, synchronized motion, and loader sizing", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./route-skeleton.module.css", import.meta.url)),
      "utf8",
    );

    expect(css).toContain("min-height: 100dvh");
    expect(css).toContain("#741f28");
    expect(css).toMatch(/\.loaderIcon\s*\{[\s\S]*?width:\s*46px/);
    expect(css).toMatch(/\.loaderIcon\s*\{[\s\S]*?height:\s*46px/);
    expect(css).toMatch(/\.loaderIcon\s*\{[\s\S]*?stroke-width:\s*3/);
    expect(css).toMatch(/animation:\s*shimmer 1\.6s/);
    expect(css).toContain("@media (min-width: 900px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/animation:\s*none/);
  });
});
