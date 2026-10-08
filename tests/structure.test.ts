import { describe, expect, it } from "vitest";
import { itemToLine, normalizeHtml, normalizeStructure } from "../src/structure";

function run(html: string, opts = {}): { html: string; changed: boolean } {
  const surface = document.createElement("div");
  surface.innerHTML = html;
  document.body.appendChild(surface);
  const changed = normalizeStructure(surface, opts);
  surface.remove();
  return { html: surface.innerHTML, changed };
}

describe("normalizeStructure: loose content in the surface", () => {
  it("repairs a heading turned into loose text after removing a list (reported note)", () => {
    const html =
      '<h3>Casco</h3><ul><li>AC: 18</li></ul><span style="background-color: initial;">Ataques</span><br>Events<ul><li>After</li></ul>';
    expect(run(html).html).toBe("<h3>Casco</h3><ul><li>AC: 18</li></ul><p>Ataques</p><p>Events</p><ul><li>After</li></ul>");
  });

  it("makes each line a paragraph and keeps empty lines", () => {
    expect(run("a<br><br>b<p>c</p>").html).toBe("<p>a</p><p><br></p><p>b</p><p>c</p>");
  });

  it("wraps text typed straight into the surface", () => {
    expect(run("<p>a</p>b <b>c</b>").html).toBe("<p>a</p><p>b <b>c</b></p>");
  });

  it("drops formatting whitespace between blocks but keeps a typed space", () => {
    expect(run("<p>a</p>\n  <p>b</p>").html).toBe("<p>a</p><p>b</p>");
    expect(run("<p>a</p> ").html).toBe("<p>a</p><p> </p>");
  });

  it("leaves a well-formed note untouched", () => {
    const html = '<h2>T</h2><p>a <span class="note-pill" style="--pill-c: #e04f4f;">x</span></p><hr><ul><li>b</li><ul><li>c</li></ul></ul><blockquote>q</blockquote><table><tbody><tr><td>1</td></tr></tbody></table><p><br></p>';
    expect(run(html)).toEqual({ html, changed: false });
  });
});

describe("normalizeStructure: styles copied by the browser", () => {
  it("strips copied styles and unwraps what's left empty", () => {
    expect(run('<p><span style="background-color: initial;">a</span></p>').html).toBe("<p>a</p>");
    expect(run('<p><span style="font-size: 1.17em; font-weight: bold;">a</span></p>').html).toBe("<p>a</p>");
  });

  it("keeps the editor's own span styles", () => {
    const html = '<p><span style="color: rgb(224, 79, 79);">a</span><span style="font-weight: normal;">b</span></p>';
    expect(run(html).html).toBe(html);
  });

  it("keeps a real color on a copied span, but not the base text color", () => {
    expect(run('<p><span style="font-size: 2em; color: rgb(224, 79, 79);">a</span></p>', { baseColor: "rgb(0, 0, 0)" }).html).toBe(
      '<p><span style="color: rgb(224, 79, 79);">a</span></p>'
    );
    expect(run('<p><span style="font-size: 2em; color: rgb(0, 0, 0);">a</span></p>', { baseColor: "rgb(0, 0, 0)" }).html).toBe("<p>a</p>");
  });

  it("removes an emptied pill", () => {
    expect(run('<p>a<span class="note-pill" style="--pill-c: #e04f4f;"></span></p>').html).toBe("<p>a</p>");
  });

  it("removes empty spans and font attributes other than color", () => {
    expect(run('<p>a<span></span><font face="Arial" color="#e04f4f">b</font><font size="3">c</font></p>').html).toBe(
      '<p>a<font color="#e04f4f">b</font>c</p>'
    );
  });
});

describe("normalizeStructure: selection", () => {
  it("keeps the caret in text it moves into a new paragraph", () => {
    const surface = document.createElement("div");
    surface.innerHTML = "<p>a</p>hello";
    document.body.appendChild(surface);
    const text = surface.lastChild as Text;
    window.getSelection()!.collapse(text, 3);
    normalizeStructure(surface);
    const sel = window.getSelection()!;
    expect(surface.innerHTML).toBe("<p>a</p><p>hello</p>");
    expect(sel.anchorNode).toBe(text);
    expect(sel.anchorOffset).toBe(3);
    surface.remove();
  });
});

// The HTML parser never puts a block inside a <p> (it closes the <p> first): these shapes only come
// from editing the DOM, so they're built that way here.
function nested(outer: string, inner: string, attrs = ""): string {
  const box = document.createElement("div");
  box.innerHTML = `<${outer}${attrs}></${outer}>`;
  (box.firstElementChild as HTMLElement).innerHTML = inner;
  return box.innerHTML;
}
function runNested(outer: string, inner: string, attrs = "") {
  const surface = document.createElement("div");
  const el = document.createElement(outer);
  surface.appendChild(el);
  if (attrs) el.setAttribute(attrs, "");
  el.innerHTML = inner;
  document.body.appendChild(surface);
  const changed = normalizeStructure(surface);
  surface.remove();
  return { html: surface.innerHTML, changed };
}

describe("normalizeStructure: blocks inside blocks", () => {
  it("lifts a list out of a paragraph or heading, keeping the line's type", () => {
    expect(runNested("p", "<ul><li>a</li></ul>").html).toBe("<ul><li>a</li></ul>");
    expect(runNested("h2", "T<ul><li>a</li></ul>tail").html).toBe("<h2>T</h2><ul><li>a</li></ul><h2>tail</h2>");
  });

  it("keeps section attributes on the first piece only", () => {
    expect(runNested("h3", "T<ul><li>a</li></ul>more", "data-collapsed").html).toBe(
      '<h3 data-collapsed="">T</h3><ul><li>a</li></ul><h3>more</h3>'
    );
  });

  it("lifts nested blocks repeatedly and drops empty leftovers", () => {
    expect(runNested("p", nested("h2", "T<ul><li>a</li></ul>") + "<br>").html).toBe("<h2>T</h2><ul><li>a</li></ul>");
    expect(runNested("p", "a<hr>b").html).toBe("<p>a</p><hr><p>b</p>");
  });

  it("leaves a quoted list alone", () => {
    const html = "<blockquote><ul><li>a</li></ul></blockquote>";
    expect(run(html)).toEqual({ html, changed: false });
  });
});

describe("normalizeStructure: list shape", () => {
  it("leaves the editor's own nesting (sub-list as the item's sibling) alone", () => {
    const html = "<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul><ol><ul><li>x</li></ul></ol>";
    expect(run(html)).toEqual({ html, changed: false });
  });

  it("moves a sub-list out of its item, after it", () => {
    expect(run("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>").html).toBe("<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>");
    expect(run("<ul><li>a<ul><li>b</li></ul>tail</li></ul>").html).toBe("<ul><li>a</li><ul><li>b</li></ul><li>tail</li></ul>");
  });

  it("turns content straight in a list into items", () => {
    expect(runNested("ul", "<li>a</li>loose<br>more<p>para</p>\n").html).toBe("<ul><li>a</li><li>loose</li><li>more</li><li>para</li></ul>");
  });

  it("makes blocks inside an item lines of it", () => {
    expect(run("<ul><li><p>a</p><p>b</p></li></ul>").html).toBe("<ul><li>a<br>b</li></ul>");
    expect(runNested("li", "a<p>b</p>c").html).toBe("<ul><li>a<br>b<br>c</li></ul>");
  });

  it("puts stray items back into a list and drops empty lists", () => {
    const surface = document.createElement("div");
    surface.innerHTML = "<p>a</p><ul></ul>";
    surface.appendChild(document.createElement("li")).textContent = "b";
    surface.appendChild(document.createElement("li")).textContent = "c";
    normalizeStructure(surface);
    expect(surface.innerHTML).toBe("<p>a</p><ul><li>b</li><li>c</li></ul>");
  });


});

describe("normalizeStructure: <div> lines", () => {
  it("turns top-level divs into paragraphs, keeping section exits", () => {
    expect(run('<h2>T</h2><div data-exit="2">a <b>b</b></div><div></div><div><br></div>').html).toBe(
      '<h2>T</h2><p data-exit="2">a <b>b</b></p><p><br></p><p><br></p>'
    );
  });

  it("lifts nested divs before converting them", () => {
    expect(runNested("div", "a<div>b</div>").html).toBe("<p>a</p><p>b</p>");
  });

  it("keeps the caret in a converted div", () => {
    const surface = document.createElement("div");
    surface.innerHTML = "<div>hello</div>";
    document.body.appendChild(surface);
    const text = surface.firstChild!.firstChild as Text;
    window.getSelection()!.collapse(text, 2);
    normalizeStructure(surface);
    expect(surface.innerHTML).toBe("<p>hello</p>");
    expect(window.getSelection()!.anchorNode).toBe(text);
    expect(window.getSelection()!.anchorOffset).toBe(2);
    surface.remove();
  });
});

describe("normalizeStructure: blocks in table cells", () => {
  const table = (cell: string) => `<table><tbody><tr><td>${cell}</td></tr></tbody></table><p><br></p>`;
  it("turns paragraphs, lists and dividers dropped into a cell into lines of it", () => {
    expect(run(table("<p>a</p><p>b</p>")).html).toBe(table("a<br>b"));
    expect(run(table("x<ul><li>a</li><li>b</li></ul>y")).html).toBe(table("x<br>a<br>b<br>y"));
    expect(run(table("a<hr>b")).html).toBe(table("ab"));
  });

  it("leaves a cell of inline content alone", () => {
    const html = table("a<br><b>b</b>");
    expect(run(html)).toEqual({ html, changed: false });
  });
});

describe("normalizeStructure: base color", () => {
  it("reads a base color given as a function only when a stray span needs it", () => {
    let calls = 0;
    const baseColor = () => { calls++; return "rgb(0, 0, 0)"; };
    run('<p><span style="color: rgb(224, 79, 79);">a</span></p>', { baseColor });
    expect(calls).toBe(0);
    expect(run('<p><span style="font-size: 2em; color: rgb(0, 0, 0);">a</span><span style="font-size: 2em; color: rgb(0, 0, 0);">b</span></p>', { baseColor }).html).toBe("<p>ab</p>");
    expect(calls).toBe(1);
  });
});

describe("normalizeStructure: blocks inside inline formatting", () => {
  const pill = (t: string) => `<span class="note-pill" style="--pill-c: #e04f4f;">${t}</span>`;

  it("splits a pill around lines pasted inside it", () => {
    expect(runNested("p", `a${pill("b<p>X</p><ul><li>y</li></ul>c")}d`).html).toBe(
      `<p>a${pill("b")}</p><p>X</p><ul><li>y</li></ul><p>${pill("c")}d</p>`
    );
  });

  it("drops the empty half when the block sits at the edge", () => {
    expect(runNested("h2", "<b><p>X</p>tail</b>").html).toBe("<p>X</p><h2><b>tail</b></h2>");
  });

  it("splits nested inline formatting at every level", () => {
    expect(runNested("p", "<b>a<i>b<p>X</p>c</i></b>").html).toBe("<p><b>a<i>b</i></b></p><p>X</p><p><b><i>c</i></b></p>");
  });

  it("does the same inside a list item", () => {
    const surface = document.createElement("div");
    surface.innerHTML = "<ul><li></li></ul>";
    (surface.querySelector("li") as HTMLElement).innerHTML = `a${pill("b<p>X</p>c")}`;
    normalizeStructure(surface);
    expect(surface.innerHTML).toBe(`<ul><li>a${pill("b")}<br>X<br>${pill("c")}</li></ul>`);
  });

  it("keeps the caret in text that moves", () => {
    const surface = document.createElement("div");
    surface.innerHTML = "<p></p>";
    (surface.firstChild as HTMLElement).innerHTML = "<b>ab<p>X</p>cd</b>";
    document.body.appendChild(surface);
    const text = surface.querySelector("b")!.lastChild as Text;
    window.getSelection()!.collapse(text, 1);
    normalizeStructure(surface);
    expect(surface.innerHTML).toBe("<p><b>ab</b></p><p>X</p><p><b>cd</b></p>");
    expect(window.getSelection()!.anchorNode).toBe(text);
    expect(window.getSelection()!.anchorOffset).toBe(1);
    surface.remove();
  });
});

describe("normalizeStructure: quotes", () => {
  const q = (inner: string, attrs = ' style="--quote-c: #e04f4f;"') => `<blockquote${attrs}>${inner}</blockquote>`;

  it("makes each line in a quote a quote of its own, with its color", () => {
    expect(run(q("a<p>b</p>c")).html).toBe(q("a") + q("b") + q("c"));
    expect(run(q("<p>a</p><div><br></div>")).html).toBe(q("a") + q("<br>"));
  });

  it("splits a quote around headings, dividers and tables", () => {
    expect(run(q("a<h2>T</h2>b")).html).toBe(q("a") + "<h2>T</h2>" + q("b"));
    expect(run(q("<hr>a")).html).toBe("<hr>" + q("a"));
  });

  it("keeps a quoted list, and section attributes on the first piece only", () => {
    const html = q("<ul><li>a</li></ul>");
    expect(run(html)).toEqual({ html, changed: false });
    expect(run(q("a<p>b</p>", ' data-exit="2"')).html).toBe('<blockquote data-exit="2">a</blockquote><blockquote>b</blockquote>');
  });

  it("brings lines out of formatting inside a quote first", () => {
    expect(runNested("blockquote", "<b>a<p>b</p></b>").html).toBe("<blockquote><b>a</b></blockquote><blockquote>b</blockquote>");
  });

  it("repairs a heading lifted out of a quote that itself holds a list", () => {
    const surface = document.createElement("div");
    surface.innerHTML = "<blockquote>a</blockquote>";
    const h = document.createElement("h2");
    h.innerHTML = "T<ul><li>x</li></ul>";
    surface.firstChild!.appendChild(h);
    normalizeStructure(surface);
    expect(surface.innerHTML).toBe("<blockquote>a</blockquote><h2>T</h2><ul><li>x</li></ul>");
  });
});

describe("normalizeHtml", () => {
  it("repairs HTML outside the editor, and returns sound HTML unchanged", () => {
    expect(normalizeHtml('<span style="background-color: initial;">Ataques</span><br>Events')).toBe("<p>Ataques</p><p>Events</p>");
    expect(normalizeHtml("<p>a</p>")).toBe("<p>a</p>");
    expect(normalizeHtml("")).toBe("");
  });
});

describe("normalizeStructure: dividers and quotes inside lists", () => {
  it("lifts a divider out of a list, splitting it", () => {
    expect(run("<ul><li>a</li><li><hr></li><li>b</li></ul>").html).toBe("<ul><li>a</li></ul><hr><ul><li>b</li></ul>");
  });

  it("splits the quote holding the list, keeping its color on both parts", () => {
    const q = (t: string) => `<blockquote style="--quote-c: #e04f4f;">${t}</blockquote>`;
    expect(run(q("<ol><li>a</li><li><hr></li><li>b</li></ol>")).html).toBe(q("<ol><li>a</li></ol>") + "<hr>" + q("<ol><li>b</li></ol>"));
  });

  it("lifts a quote pasted into an item, keeping the item's text around it", () => {
    expect(run('<ul><li>a</li><li>Lis</li><ul><li>t b</li></ul><li><blockquote style="--quote-c: #3f8ce0;">Quo</blockquote>ted</li></ul><hr><p>End</p>').html).toBe(
      '<ul><li>a</li><li>Lis</li><ul><li>t b</li></ul></ul><blockquote style="--quote-c: #3f8ce0;">Quo</blockquote><ul><li>ted</li></ul><hr><p>End</p>'
    );
  });
});

describe("normalizeStructure: empty lines", () => {
  it("gives a line with nothing in it its line break", () => {
    const surface = document.createElement("div");
    surface.innerHTML = "<ul><li>a</li><li></li></ul><p>x</p><p></p>";
    surface.querySelector("p")!.appendChild(document.createTextNode(""));
    (surface.lastChild as HTMLElement).appendChild(document.createTextNode(""));
    normalizeStructure(surface);
    expect(surface.innerHTML).toBe("<ul><li>a</li><li><br></li></ul><p>x</p><p><br></p>");
  });
});

describe("normalizeStructure: emptied pills", () => {
  it("removes a pill left holding only an empty text node", () => {
    const surface = document.createElement("div");
    surface.innerHTML = '<p>a<span class="note-pill" style="--pill-c: #e04f4f;"></span>b</p>';
    surface.querySelector(".note-pill")!.appendChild(document.createTextNode(""));
    normalizeStructure(surface);
    expect(surface.innerHTML).toBe("<p>ab</p>");
  });
});

describe("normalizeStructure: browser leftovers in formatting", () => {
  it("drops colors the browser computed, keeping real ones", () => {
    expect(run('<p><font color="color(srgb 0.6 0.7 0.9)">x</font><span style="color: color(srgb 0.6 0.7 0.9);">y</span><span style="color: rgb(224, 79, 79);">z</span></p>').html).toBe(
      '<p>xy<span style="color: rgb(224, 79, 79);">z</span></p>'
    );
  });

  it("strips styles from bold/strike/line breaks and drops emptied formatting", () => {
    expect(run('<p><strike style="font-size: 0.92em; font-weight: 600;">a</strike><b style="background-color: transparent;"></b>b<br style="background-color: transparent;">c<strike></strike></p>').html).toBe(
      "<p><strike>a</strike>b<br>c</p>"
    );
  });

  it("drops an emptied colored span left by a split", () => {
    const surface = document.createElement("div");
    surface.innerHTML = '<h1><span style="color: rgb(124, 92, 255);"></span></h1>';
    surface.querySelector("span")!.appendChild(document.createTextNode(""));
    normalizeStructure(surface);
    expect(surface.innerHTML).toBe("<h1><br></h1>");
  });
});

describe("normalizeStructure: pill inside a pill", () => {
  it("joins the inner pill's text to the outer one", () => {
    const p = (t: string, c = "#7c5cff") => `<span class="note-pill" style="--pill-c: ${c};">${t}</span>`;
    expect(run(`<h3>${p("Sub apla" + p("Afnew", "#3f8ce0"))}</h3>`).html).toBe(`<h3>${p("Sub aplaAfnew")}</h3>`);
  });
});

describe("itemToLine", () => {
  function lift(html: string, text: string) {
    const surface = document.createElement("div");
    surface.innerHTML = html;
    const li = Array.from(surface.querySelectorAll("li")).find((l) => l.firstChild?.textContent === text)!;
    itemToLine(li as HTMLElement, surface);
    return surface.innerHTML;
  }

  it("takes one item out, keeping the rest of the list and its sub-items a list", () => {
    expect(lift("<ul><li>a</li><li>b</li><ul><li>b1</li></ul><li>c</li></ul>", "b")).toBe(
      "<ul><li>a</li></ul><p>b</p><ul><ul><li>b1</li></ul><li>c</li></ul>"
    );
  });

  it("drops a list part left empty", () => {
    expect(lift("<ul><li>a</li><li>b</li></ul>", "a")).toBe("<p>a</p><ul><li>b</li></ul>");
    expect(lift("<ul><li>a</li></ul>", "a")).toBe("<p>a</p>");
  });

  it("takes a nested item out to the top", () => {
    expect(lift("<ul><li>a</li><ul><li>a1</li><li>a2</li></ul></ul>", "a1")).toBe("<ul><li>a</li></ul><p>a1</p><ul><ul><li>a2</li></ul></ul>");
  });

  it("keeps a quoted list's item quoted, in the quote's color", () => {
    const q = (t: string) => `<blockquote style="--quote-c: #e04f4f;">${t}</blockquote>`;
    expect(lift(q("<ul><li>a</li><li>b</li></ul>"), "a")).toBe(q("a") + q("<ul><li>b</li></ul>"));
  });
});

describe("section markers when a block splits", () => {
  it("go to the first line after a lifted list", () => {
    expect(runNested("p", "<ul><li>a</li></ul>text", "data-exit").html.replace('data-exit=""', 'data-exit')).toBe("<ul><li>a</li></ul><p data-exit>text</p>");
  });

  it("go to the line taken out of a quoted list whose first part was emptied", () => {
    const surface = document.createElement("div");
    surface.innerHTML = '<blockquote data-exit="2" style="--quote-c: #e04f4f;"><ul><li>a</li><li>b</li></ul></blockquote>';
    itemToLine(surface.querySelector("li") as HTMLElement, surface);
    expect(surface.innerHTML).toBe(
      '<blockquote style="--quote-c: #e04f4f;" data-exit="2">a</blockquote><blockquote style="--quote-c: #e04f4f;"><ul><li>b</li></ul></blockquote>'
    );
  });
});
