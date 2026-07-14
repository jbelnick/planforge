import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("mobile operator CSS", () => {
  it("keeps the phone composer sticky with safe-area padding and removes the old 2x2 selector fallback", async () => {
    const css = await readFile("src/styles.css", "utf8");
    expect(css).toContain("@media (max-width: 860px)");
    expect(css).toContain(".composer");
    expect(css).toContain("position: sticky;");
    expect(css).toContain("bottom: 0;");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toContain("overflow-x: hidden;");
    expect(css).toContain(".approval-controls .button");
    expect(css).toContain("width: 100%;");
    expect(css).not.toContain(".chat-header .run-controls.is-inline");
  });

  it("keeps all five sidebar regions stable and gives the phone header explicit areas", async () => {
    const css = await readFile("src/styles.css", "utf8");
    expect(css.match(/grid-template-rows: auto auto auto minmax\(0, 1fr\) auto;/g)).toHaveLength(2);
    expect(css).toContain('grid-template-areas: "menu title" "target target" "summary summary" "actions actions";');
    expect(css).toContain(".title-display {");
    expect(css).toContain("min-width: 0;");
  });
});
