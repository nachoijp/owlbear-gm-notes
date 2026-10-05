import { describe, expect, it } from "vitest";
import { createSections } from "../src/sections";

function setup(html: string) {
  const surface = document.createElement("div");
  surface.innerHTML = html;
  const blockAt = (node: Node) => {
    let n: Node | null = node;
    while (n && n.parentNode !== surface) n = n.parentNode;
    return n as HTMLElement | null;
  };
  const sections = createSections({ surface, blockAt, onFoldChange: () => {} });
  sections.applyFolding();
  const at = (i: number) => surface.children[i] as HTMLElement;
  return { surface, sections, at };
}

describe("collapsible sections", () => {
  it("indents lines by the sections around them and hides what a folded heading holds", () => {
    const { at } = setup('<h2 data-collapsed="">A</h2><p>a</p><h4>t</h4><p>b</p><h2>B</h2><p>c</p>');
    expect(at(1).getAttribute("data-depth")).toBe("1");
    expect(at(3).getAttribute("data-depth")).toBe("2");
    expect([1, 2, 3].every((i) => at(i).hasAttribute("data-folded"))).toBe(true);
    expect(at(4).hasAttribute("data-folded")).toBe(false);
  });

  it("steps a line out one section at a time, and back in", () => {
    const { sections, at } = setup("<h2>A</h2><h4>t</h4><p>x</p>");
    const line = at(2);
    expect(sections.stepSection(line, -1)).toBe(true);
    expect(line.getAttribute("data-exit")).toBe("4");
    expect(line.getAttribute("data-depth")).toBe("1");
    expect(sections.stepSection(line, -1)).toBe(true);
    expect(line.getAttribute("data-exit")).toBe("2");
    expect(line.hasAttribute("data-depth")).toBe(false);
    expect(sections.stepSection(line, -1)).toBe(false);
    expect(sections.stepSection(line, 1)).toBe(true);
    expect(line.getAttribute("data-exit")).toBe("4");
    expect(sections.stepSection(line, 1)).toBe(true);
    expect(line.hasAttribute("data-exit")).toBe(false);
    expect(sections.stepSection(line, 1)).toBe(false);
  });

  it("keeps the lines after one that left a section outside it too", () => {
    const { at } = setup('<h4 data-collapsed="">t</h4><p>in</p><p data-exit="4">out</p><p>after</p>');
    expect(at(1).hasAttribute("data-folded")).toBe(true);
    expect(at(2).hasAttribute("data-folded")).toBe(false);
    expect(at(3).hasAttribute("data-folded")).toBe(false);
    expect(at(3).hasAttribute("data-depth")).toBe(false);
  });

  it("reads older notes' data-standalone as leaving the toggle", () => {
    const { sections, at } = setup("<h4>t</h4><p data-standalone=\"\">x</p>");
    expect(sections.exitLevel(at(1))).toBe(4);
    expect(at(1).hasAttribute("data-depth")).toBe(false);
  });
});
