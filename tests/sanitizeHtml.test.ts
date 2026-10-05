import { describe, expect, it } from "vitest";
import { sanitizeNoteHtml } from "../src/sanitizeHtml";

describe("sanitizeNoteHtml: tables", () => {
  it("keeps header scopes and merged cells", () => {
    const html = '<table><tbody><tr><th scope="col" colspan="2">A</th></tr><tr><td rowspan="3">B</td><td>C</td></tr></tbody></table>';
    expect(sanitizeNoteHtml(html)).toBe(html);
  });

  it("drops spans out of range or not plain numbers", () => {
    const html = '<table><tbody><tr><td colspan="1">a</td><td colspan="51">b</td><td rowspan="2x">c</td><td rowspan="-2">d</td></tr></tbody></table>';
    expect(sanitizeNoteHtml(html)).toBe("<table><tbody><tr><td>a</td><td>b</td><td>c</td><td>d</td></tr></tbody></table>");
  });

  it("keeps cell colors, but only plain color values on cells", () => {
    expect(sanitizeNoteHtml('<table><tbody><tr><td style="--cell-c: #e04f4f;">a</td></tr></tbody></table>')).toBe(
      '<table><tbody><tr><td style="--cell-c: #e04f4f;">a</td></tr></tbody></table>'
    );
    expect(sanitizeNoteHtml('<table><tbody><tr><td style="--cell-c: url(x)">a</td></tr></tbody></table>')).toBe(
      "<table><tbody><tr><td>a</td></tr></tbody></table>"
    );
    expect(sanitizeNoteHtml('<p style="--cell-c: #e04f4f">a</p>')).toBe("<p>a</p>");
  });

  it("keeps column widths only as whole pixels", () => {
    const html = '<table><colgroup><col style="--col-w: 120px;"><col style="--col-w: 40%;" span="2"><col style="width: 90px;"></colgroup><tbody><tr><td>a</td></tr></tbody></table>';
    expect(sanitizeNoteHtml(html)).toBe('<table><colgroup><col style="--col-w: 120px;"><col><col></colgroup><tbody><tr><td>a</td></tr></tbody></table>');
  });
});

describe("sanitizeNoteHtml: sections", () => {
  it("keeps a line's section exit (1-4) on paragraphs, quotes and headings only", () => {
    expect(sanitizeNoteHtml('<p data-exit="2">a</p><blockquote data-exit="4">b</blockquote><ul data-exit="1"><li>c</li></ul>')).toBe(
      '<p data-exit="2">a</p><blockquote data-exit="4">b</blockquote><ul><li>c</li></ul>'
    );
    expect(sanitizeNoteHtml('<p data-exit="5">a</p><p data-exit="x">b</p><p data-standalone="">c</p>')).toBe(
      '<p>a</p><p>b</p><p data-standalone="">c</p>'
    );
  });
});

describe("sanitizeNoteHtml: more structure", () => {
  it("keeps a heading's section exit and a table's header column", () => {
    expect(sanitizeNoteHtml('<h4 data-exit="2">a</h4>')).toBe('<h4 data-exit="2">a</h4>');
    expect(sanitizeNoteHtml('<table data-header-col=""><tbody><tr><td>a</td></tr></tbody></table>')).toBe(
      '<table data-header-col=""><tbody><tr><td>a</td></tr></tbody></table>'
    );
  });
});
