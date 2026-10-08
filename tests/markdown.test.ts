import { describe, expect, it } from "vitest";
import { flattenToInline, htmlToMarkdown, markdownToHtml, stripHtml } from "../src/markdown";

const BS = "\\";

describe("Markdown tables: import", () => {
  it("reads a table with a header row, escaped pipes and line breaks", () => {
    const md = ["| Name | HP |", "| --- | :-: |", "| Goblin | 7 |", `| Orc ${BS}| big | 15<br>temp |`].join("\n");
    expect(markdownToHtml(md)).toBe(
      '<table><tbody><tr><th scope="col">Name</th><th scope="col">HP</th></tr>' +
        "<tr><td>Goblin</td><td>7</td></tr><tr><td>Orc | big</td><td>15<br>temp</td></tr></tbody></table>"
    );
  });

  it("reads an empty header row as no header, and pads short rows", () => {
    const md = ["|  |  |", "| --- | --- |", "| a | b |", "| c |"].join("\n");
    expect(markdownToHtml(md)).toBe("<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td><br></td></tr></tbody></table>");
  });

  it("ends a paragraph where a table starts", () => {
    expect(markdownToHtml("intro\n| A |\n| --- |\n| 1 |\nafter")).toBe(
      '<p>intro</p><table><tbody><tr><th scope="col">A</th></tr><tr><td>1</td></tr></tbody></table><p>after</p>'
    );
  });

  it("doesn't take text with a pipe over a divider for a table", () => {
    expect(markdownToHtml("a | b\n---")).toBe("<p>a | b</p><hr>");
  });
});

describe("Markdown tables: export", () => {
  it("writes a table with a header row", () => {
    const html = '<table><tbody><tr><th scope="col">Name</th><th scope="col">HP</th></tr><tr><td>Orc | big</td><td>15<br>temp</td></tr></tbody></table>';
    expect(htmlToMarkdown(html)).toBe(["| Name | HP |", "| --- | --- |", `| Orc ${BS}| big | 15<br>temp |`].join("\n"));
  });

  it("writes an empty header row for a table without one", () => {
    expect(htmlToMarkdown("<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>")).toBe(
      ["|  |  |", "| --- | --- |", "| a | b |"].join("\n")
    );
  });

  it("puts a merged cell's text in its first position", () => {
    const html = '<table><tbody><tr><td colspan="2">A</td></tr><tr><td>B</td><td>C</td></tr></tbody></table>';
    expect(htmlToMarkdown(html)).toBe(["|  |  |", "| --- | --- |", "| A |  |", "| B | C |"].join("\n"));
  });

  it("round-trips", () => {
    const html = '<table><tbody><tr><th scope="col">A</th><th scope="col">B</th></tr><tr><td><b>x</b></td><td>y<br>z</td></tr></tbody></table>';
    expect(markdownToHtml(htmlToMarkdown(html))).toBe(html);
  });
});

describe("flattenToInline", () => {
  it("turns blocks into lines and cells into spaced text", () => {
    expect(flattenToInline("<p>a</p><h1>b</h1><ul><li>c</li><li><b>d</b></li></ul>")).toBe("a<br>b<br>c<br><b>d</b>");
    expect(flattenToInline("<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>")).toBe(
      "a b<br>c d"
    );
  });

  it("drops dividers and extra line breaks", () => {
    expect(flattenToInline("<p>a</p><hr><p>b</p>")).toBe("a<br>b");
  });
});

describe("stripHtml", () => {
  it("keeps words in adjacent cells apart", () => {
    expect(stripHtml("<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>")).toBe("one two");
  });

  it("separates lines, list items and line breaks", () => {
    expect(stripHtml("<h2>La Tortuga Dragón (barco)</h2><p>dgthdfghdfgh</p><ol><li>asdfasdfas</li><li>b</li></ol>")).toBe(
      "La Tortuga Dragón (barco) dgthdfghdfgh asdfasdfas b"
    );
    expect(stripHtml("<blockquote>a<br>b</blockquote><p>c</p>")).toBe("a b c");
  });
});

describe("Markdown tables: empty cells", () => {
  it("exports empty cells and trailing line breaks as nothing", () => {
    const html = "<table><tbody><tr><td><br></td><td>a<br><br></td><td>b<br>c</td></tr></tbody></table>";
    expect(htmlToMarkdown(html)).toBe(["|  |  |  |", "| --- | --- | --- |", "|  | a | b<br>c |"].join(String.fromCharCode(10)));
  });
});

describe("Markdown tables: adjacent tables", () => {
  it("keeps two tables in a row apart", () => {
    const html =
      '<table><tbody><tr><th scope="col">A</th></tr><tr><td>1</td></tr></tbody></table>' +
      '<table><tbody><tr><th scope="col">B</th></tr><tr><td>2</td></tr></tbody></table>';
    expect(markdownToHtml(htmlToMarkdown(html))).toBe(html);
  });
});
