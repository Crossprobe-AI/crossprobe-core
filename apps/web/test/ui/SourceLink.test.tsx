/**
 * The top bar's link to the source (ui/SourceLink.tsx): GitHub's mark from third_party/octicons,
 * a 30 px button in the bar's text colour, named for screen readers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import "../../src/styles.css";
import { SOURCE_URL, SourceLink } from "../../src/ui/SourceLink";

afterEach(async () => {
  await cleanup();
});

describe("SourceLink", () => {
  it("links to the source, with a name and GitHub's mark in the text colour", async () => {
    await render(
      <header className="topbar">
        <SourceLink />
      </header>,
    );
    const link = document.querySelector<HTMLAnchorElement>("a.source-link")!;
    expect(link.href).toBe(SOURCE_URL);
    expect(link.getAttribute("aria-label")).toBe("Source on GitHub");
    expect(link.rel).toContain("noopener");
    const box = link.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([30, 30]);

    const mark = link.querySelector<HTMLElement>(".source-mark")!;
    const style = getComputedStyle(mark);
    expect(style.maskImage || style.webkitMaskImage).toMatch(/^url\(/);
    expect(style.backgroundColor).toBe(getComputedStyle(link).color);
    // The image is the Octicons file: it loads, as an SVG.
    const url = /url\("?(.*?)"?\)$/.exec(style.maskImage || style.webkitMaskImage)![1]!;
    const svg = await (await fetch(url)).text();
    expect(svg).toMatch(/^<svg[^>]*viewBox=["']0 0 16 16["']/);
  });
});
