import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RouteSkeleton from "./route-skeleton";

describe("RouteSkeleton", () => {
  it("renders one accessible and stable application skeleton", () => {
    const markup = renderToStaticMarkup(createElement(RouteSkeleton));

    expect(markup).toContain('data-testid="route-skeleton"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("页面加载中");
    expect(markup.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("uses fixed mobile-first geometry and disables motion when requested", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./route-skeleton.module.css", import.meta.url)),
      "utf8",
    );

    expect(css).toContain("min-height: 100dvh");
    expect(css).toContain("@media (min-width: 760px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/animation:\s*none/);
  });
});
