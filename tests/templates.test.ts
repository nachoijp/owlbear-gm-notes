import { describe, expect, it } from "vitest";
import { missingBuiltins, newBuiltinTemplate, resolveTemplate } from "../src/templates";
import { sanitizeNoteHtml } from "../src/sanitizeHtml";
import { buildGrid, normalizeTable } from "../src/tableModel";

// Every built-in, in every language.
const builtins = missingBuiltins([]).flatMap((id) =>
  (["es", "en"] as const).map((lang) => ({ id, lang, ...resolveTemplate(newBuiltinTemplate(id), lang) }))
);

describe("built-in templates", () => {
  it.each(builtins)("$id ($lang) has a title and survives the sanitizer whole", ({ title, html }) => {
    expect(title).not.toBe("");
    // Compared as the browser serializes both (attribute order aside, the sanitizer keeps all of it).
    const norm = (h: string) => {
      const el = document.createElement("div");
      el.innerHTML = h;
      el.querySelectorAll("*").forEach((e) => {
        const attrs = Array.from(e.attributes).sort((a, b) => a.name.localeCompare(b.name));
        attrs.forEach((a) => e.removeAttribute(a.name));
        attrs.forEach((a) => e.setAttribute(a.name, a.value));
      });
      return el.innerHTML;
    };
    expect(norm(sanitizeNoteHtml(html))).toBe(norm(html));
  });

  it.each(builtins)("$id ($lang) has only whole tables the editor leaves as they are", ({ html }) => {
    const el = document.createElement("div");
    el.innerHTML = html;
    el.querySelectorAll("table").forEach((t) => {
      const table = t as HTMLTableElement;
      const grid = buildGrid(table);
      expect(grid.slots.every((row) => row.length === grid.cols && row.every(Boolean))).toBe(true);
      const before = table.outerHTML;
      normalizeTable(table);
      expect(table.outerHTML).toBe(before);
    });
  });
});
