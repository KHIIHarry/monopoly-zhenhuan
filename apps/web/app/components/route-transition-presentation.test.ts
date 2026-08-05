import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hookUrl = new URL("./route-transition-presentation.ts", import.meta.url);
const cssUrl = new URL("../globals.css", import.meta.url);

describe("route transition presentation", () => {
  it("holds route loading with the shared gate and exposes watchdog cancellation", async () => {
    const source = await readFile(fileURLToPath(hookUrl), "utf8");
    expect(source).toContain("createMinimumRouteSkeletonGate");
    expect(source).toContain(
      'matchMedia("(prefers-reduced-motion: reduce)")',
    );
    expect(source).toContain("cancelMinimumDelay");
    expect(source).toMatch(/showSkeleton:\s*loading\s*\|\|\s*holding/);
  });

  it("adds one root reveal animation with a reduced-motion override", async () => {
    const css = await readFile(fileURLToPath(cssUrl), "utf8");
    expect(css).toMatch(/html\[data-route-reveal="true"\]\s+#root\s*>\s*main/);
    expect(css).toMatch(
      /animation:\s*route-content-reveal 160ms ease-out both/,
    );
    expect(css).toMatch(
      /@keyframes route-content-reveal[\s\S]*?opacity:\s*0[\s\S]*?opacity:\s*1/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/,
    );
  });
});
