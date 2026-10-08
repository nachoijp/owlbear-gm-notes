// Keeps the editor's HTML in the shape the rest of the editor understands, repairing whatever the
// browser's own editing leaves behind. Chrome's native commands (removing a list, Shift+Tab out of
// one, Backspace merging two different blocks) can leave text loose in the surface — outside any
// block, invisible to every block-aware helper, so the block menu then treats it all as one line —
// and wrap text in spans that copy computed styles (`background-color: initial`, `font-size: ...`).
// This runs after every edit and when a note opens, so an already-broken note repairs itself too.

// What a top-level child of the surface may be. DIV: older notes can hold browser-made <div> lines.
const BLOCK_TAGS = /^(P|H[1-4]|BLOCKQUOTE|UL|OL|HR|TABLE|DIV)$/;
// The style properties the editor itself puts on a plain (non-pill) span: text color, the decoration
// line synced onto colored spans, and Chrome's own "normal" spans un-bolding text in a heading.
const SPAN_STYLE_PROPS = new Set(["color", "text-decoration-line", "font-weight", "font-style"]);

export interface NormalizeOptions {
  /** The surface's own text color (computed): a stray span copying it is not a color the GM picked.
   *  A function is only called when a stray span turns up. */
  baseColor?: string | (() => string);
}

// Wraps text and inline elements sitting directly in the surface into paragraphs. A <br> there is
// how Chrome ends a line it left outside any block, so each line becomes its own paragraph — not
// one paragraph with line breaks, which the block menu would format as a single line.
export function wrapLooseRootContent(surface: HTMLElement): boolean {
  let changed = false;
  let run: Node[] = [];
  const flush = (before: Node | null) => {
    if (!run.length) return;
    const p = document.createElement("p");
    surface.insertBefore(p, before);
    run.forEach((n) => p.appendChild(n));
    run = [];
    changed = true;
  };
  Array.prototype.slice.call(surface.childNodes).forEach((node: Node) => {
    if (node.nodeType === 1 && BLOCK_TAGS.test((node as Element).tagName)) {
      flush(node);
      return;
    }
    if (node.nodeType === 1 && (node as Element).tagName === "BR") {
      if (run.length) {
        flush(node);
        node.parentNode!.removeChild(node);
      } else {
        // A <br> with nothing before it on its line is an empty line.
        run.push(node);
        flush(node.nextSibling);
      }
      changed = true;
      return;
    }
    if (node.nodeType === 3) {
      // Whitespace between blocks from formatted HTML (an imported file) is not content. A plain
      // space is kept: it may be what the GM just typed there.
      const data = (node as Text).data;
      if (!run.length && /^\s*$/.test(data) && (data === "" || /[\n\r\t]/.test(data))) {
        node.parentNode!.removeChild(node);
        changed = true;
        return;
      }
      run.push(node);
      return;
    }
    if (node.nodeType === 1) {
      run.push(node);
      return;
    }
    // Comments and the like.
    node.parentNode!.removeChild(node);
    changed = true;
  });
  flush(null);
  return changed;
}

// A paragraph or heading holding a block of its own (<p><ul>, <h2><table>, <p><h3>): Chrome's list
// commands and pastes make these, and the block menu then converts the wrong thing (a heading
// applied to a list wrapped the whole list in it). Splitting it lifts the inner blocks out between
// pieces of the same type holding the inline content around them: <h2>T<ul>…</ul></h2> →
// <h2>T</h2><ul>…</ul>. Quotes are left alone: a quoted list (<blockquote><ul>) is intended.
const INNER_BLOCK_TAGS = /^(P|H[1-4]|BLOCKQUOTE|UL|OL|HR|TABLE|DIV)$/;
const SPLITTABLE_TAGS = /^(P|H[1-4]|DIV)$/;
// Attributes that belong to the line as a whole, kept by its first piece only.
const FIRST_PIECE_ONLY = ["data-collapsed", "data-exit", "data-standalone"];

// A block split into pieces keeps those attributes on its first piece that can carry them: where the
// line sits among the sections (data-exit / data-standalone: a paragraph, heading or quote) and, for
// a heading, whether it's collapsed. A list can't leave a section, so it never takes them — the
// first line after it does. Without this, splitting a line whose first piece was a lifted list, or
// whose original part was left empty and dropped, lost the marker: the lines after it fell back
// into the section they had left.
function carryLineAttributes(from: Element, pieces: Element[]) {
  FIRST_PIECE_ONLY.forEach((attr) => {
    const value = from.getAttribute(attr);
    if (value === null) return;
    const canCarry = attr === "data-collapsed" ? /^H[1-4]$/ : /^(P|DIV|BLOCKQUOTE|H[1-4])$/;
    const target = pieces.find((p) => canCarry.test(p.tagName));
    if (target && !target.hasAttribute(attr)) target.setAttribute(attr, value);
  });
}

// A block inside inline formatting within `container` (pasting lines with the caret inside a pill or
// bold text: <p>a<span class="note-pill">b<ul>…</ul>c</span></p>) is moved up to be a direct child
// of `container`, each inline element around it split in two — <p>a<span…>b</span><ul>…</ul>
// <span…>c</span></p> — so the formatting stays on both sides. Moved, not copied: text keeps its
// nodes, and with them the caret. A block inside another block is left to that one's own repair.
function hoistDeepBlocks(container: HTMLElement, tags: RegExp): boolean {
  let changed = false;
  const deep = (Array.prototype.slice.call(container.querySelectorAll("*")) as HTMLElement[]).filter((el) => {
    if (!tags.test(el.tagName) || el.parentElement === container) return false;
    for (let a = el.parentElement; a && a !== container; a = a.parentElement) {
      if (INNER_BLOCK_TAGS.test(a.tagName) || a.tagName === "LI") return false;
    }
    return true;
  });
  deep.forEach((block) => {
    let parent = block.parentElement;
    while (parent && parent !== container) {
      const after = parent.cloneNode(false) as HTMLElement;
      while (block.nextSibling) after.appendChild(block.nextSibling);
      parent.after(block);
      // A half holding nothing (or only an empty text node) isn't kept: it'd be an empty pill or
      // span with no text to show.
      const holdsSomething = (el: Element) => el.textContent !== "" || !!el.querySelector("*");
      if (holdsSomething(after)) block.after(after);
      if (!holdsSomething(parent)) parent.remove();
      parent = block.parentElement;
    }
    changed = true;
  });
  return changed;
}

function hasInnerBlock(el: Element): boolean {
  return Array.prototype.some.call(el.children, (c: Element) => INNER_BLOCK_TAGS.test(c.tagName));
}

/** Splits `block` (see above) in place; returns what took its place, in order. */
export function splitBlock(block: HTMLElement): HTMLElement[] {
  if (!SPLITTABLE_TAGS.test(block.tagName) || !hasInnerBlock(block)) return [block];
  const pieces: HTMLElement[] = [];
  let current: HTMLElement | null = null;
  const close = () => {
    if (!current) return;
    // Only whitespace or a lone line-holding <br>: nothing worth a line of its own.
    if (isMeaningfulPiece(current)) pieces.push(current);
    current = null;
  };
  Array.prototype.slice.call(block.childNodes).forEach((child: Node) => {
    if (child.nodeType === 1 && INNER_BLOCK_TAGS.test((child as Element).tagName)) {
      close();
      pieces.push(child as HTMLElement);
      return;
    }
    if (!current) {
      current = block.cloneNode(false) as HTMLElement;
      FIRST_PIECE_ONLY.forEach((a) => current!.removeAttribute(a));
    }
    current.appendChild(child);
  });
  close();
  carryLineAttributes(block, pieces);
  block.replaceWith(...pieces);
  return pieces;
}

// Splits every top-level line that holds another block, directly or inside its inline formatting
// (hoisted up first); a lifted block may itself hold one (<p><h2><ul>), hence the repeat.
export function splitNestedBlocks(surface: HTMLElement): boolean {
  let changed = false;
  for (let pass = 0; pass < 10; pass++) {
    (Array.prototype.slice.call(surface.children) as HTMLElement[]).forEach((el) => {
      if (SPLITTABLE_TAGS.test(el.tagName) && hoistDeepBlocks(el, INNER_BLOCK_TAGS)) changed = true;
    });
    const nested = (Array.prototype.slice.call(surface.children) as HTMLElement[]).filter(
      (el) => SPLITTABLE_TAGS.test(el.tagName) && hasInnerBlock(el)
    );
    if (!nested.length) break;
    nested.forEach(splitBlock);
    changed = true;
  }
  return changed;
}

// Lists in the shape the editor's list code expects:
// a <ul>/<ol> holds only <li>s and sub-lists, and a sub-list sits as a SIBLING right after the item
// it belongs to — the shape Chrome's own indent makes. Repairs, in every list outside a table cell:
// text or inline content straight in a list becomes items (a <br> ending each); a paragraph/heading
// in a list becomes an item; a sub-list inside its item (<li>a<ul>…</ul></li>, the standard shape
// other HTML uses) moves out to right after it, anything after it in the item becoming an item of
// its own; blocks inside an item become lines of it; an empty list goes. <li>s left straight in
// the surface are put back in a list.
const LIST_TAGS = /^(UL|OL)$/;
const LINE_TAGS = /^(P|H[1-4]|DIV)$/;

function isFormattingWhitespace(n: Node): boolean {
  return n.nodeType === 3 && /^\s*$/.test((n as Text).data) && ((n as Text).data === "" || /[\n\r\t]/.test((n as Text).data));
}
function hasContent(nodes: Node[]): boolean {
  return nodes.some((n) => n.nodeType === 1 || ((n as Text).data || "").replace(/\u200b/g, "").trim() !== "");
}

function repairItem(li: HTMLElement): boolean {
  // Lines and sub-lists inside the item's inline formatting first come up to the item itself.
  let changed = hoistDeepBlocks(li, /^(P|H[1-4]|DIV|UL|OL)$/);
  // Blocks inside the item become lines of it: a line break on each side with content beyond it
  // (a sub-list is moved out below, so it needs none).
  const isBreak = (n: Node | null) => !!n && n.nodeType === 1 && (n as Element).tagName === "BR";
  const needsBreak = (n: Node | null) => !!n && !isBreak(n) && !(n.nodeType === 1 && LIST_TAGS.test((n as Element).tagName)) && hasContent([n]);
  Array.prototype.slice.call(li.children).forEach((child: HTMLElement) => {
    if (!LINE_TAGS.test(child.tagName)) return;
    if (needsBreak(child.previousSibling)) child.before(document.createElement("br"));
    const last = child.lastChild;
    if (needsBreak(child.nextSibling) && !isBreak(last)) child.after(document.createElement("br"));
    unwrap(child);
    changed = true;
  });
  // A sub-list inside the item moves out after it, with whatever follows it.
  const firstSub = Array.prototype.find.call(li.children, (c: Element) => LIST_TAGS.test(c.tagName)) as HTMLElement | undefined;
  if (firstSub) {
    let cursor: Element = li;
    let run: Node[] = [];
    const flushRun = () => {
      if (hasContent(run)) {
        const item = document.createElement("li");
        run.forEach((n) => item.appendChild(n));
        cursor.after(item);
        cursor = item;
      } else {
        run.forEach((n) => n.parentNode && n.parentNode.removeChild(n));
      }
      run = [];
    };
    let n: Node | null = firstSub;
    while (n) {
      const next: Node | null = n.nextSibling;
      if (n.nodeType === 1 && LIST_TAGS.test((n as Element).tagName)) {
        flushRun();
        cursor.after(n);
        cursor = n as Element;
      } else {
        run.push(n);
      }
      n = next;
    }
    flushRun();
    changed = true;
  }
  if (!li.hasChildNodes()) {
    li.appendChild(document.createElement("br"));
    changed = true;
  }
  return changed;
}

function repairList(list: HTMLElement): boolean {
  let changed = false;
  let run: Node[] = [];
  const flushRun = (before: Node | null) => {
    if (!run.length) return;
    const li = document.createElement("li");
    list.insertBefore(li, before);
    run.forEach((n) => li.appendChild(n));
    run = [];
    changed = true;
  };
  Array.prototype.slice.call(list.childNodes).forEach((child: Node) => {
    if (child.nodeType === 1) {
      const tag = (child as Element).tagName;
      if (tag === "LI" || LIST_TAGS.test(tag)) {
        flushRun(child);
        return;
      }
      if (LINE_TAGS.test(tag)) {
        flushRun(child);
        const li = document.createElement("li");
        while (child.firstChild) li.appendChild(child.firstChild);
        list.replaceChild(li, child);
        changed = true;
        return;
      }
      if (tag === "BR") {
        if (run.length) flushRun(child);
        list.removeChild(child);
        changed = true;
        return;
      }
    } else if (child.nodeType === 3) {
      if (!run.length && isFormattingWhitespace(child)) {
        list.removeChild(child);
        changed = true;
        return;
      }
    } else {
      list.removeChild(child);
      changed = true;
      return;
    }
    run.push(child);
  });
  flushRun(null);
  Array.prototype.slice.call(list.children).forEach((li: HTMLElement) => {
    if (li.tagName === "LI" && repairItem(li)) changed = true;
  });
  return changed;
}

export function repairLists(surface: HTMLElement): boolean {
  let changed = false;
  // Items left straight in the surface go back into a list (a run of them, into one).
  Array.prototype.slice.call(surface.children).forEach((el: HTMLElement) => {
    if (el.tagName !== "LI" || el.parentNode !== surface) return;
    const list = document.createElement("ul");
    el.before(list);
    let n: Element | null = el;
    while (n && n.tagName === "LI") {
      const next: Element | null = n.nextElementSibling;
      list.appendChild(n);
      n = next;
    }
    changed = true;
  });
  // Outermost first: moving a sub-list out of its item puts it in the list above it, which is
  // repaired after (querySelectorAll's document order).
  Array.prototype.slice.call(surface.querySelectorAll("ul, ol")).forEach((list: HTMLElement) => {
    if (!surface.contains(list) || list.closest("td, th")) return;
    if (repairList(list)) changed = true;
    if (!list.hasChildNodes()) {
      list.remove();
      changed = true;
    }
  });
  return changed;
}

// A quote is one line, like a paragraph: quoting several lines makes a quote of each (see the
// editor's setBlockType), and only a list may sit inside one, whole. Lines pasted or dropped into a
// quote (<blockquote>a<p>b</p></blockquote>) become quotes of their own, keeping its bar color;
// headings, dividers, tables and nested quotes split the quote around them, as blocks of their own.
const QUOTE_LINE_TAGS = /^(P|DIV)$/;
const QUOTE_LIFT_TAGS = /^(H[1-4]|HR|TABLE|BLOCKQUOTE)$/;

function isMeaningfulPiece(piece: HTMLElement): boolean {
  return (piece.textContent || "").replace(/\u200b/g, "").trim() !== "" ||
    Array.prototype.some.call(piece.querySelectorAll("*"), (el: Element) => el.tagName !== "BR" && el.tagName !== "SPAN");
}

function splitQuote(quote: HTMLElement): boolean {
  const misplaced = Array.prototype.some.call(quote.children, (c: Element) => QUOTE_LINE_TAGS.test(c.tagName) || QUOTE_LIFT_TAGS.test(c.tagName));
  if (!misplaced) return false;
  const pieces: HTMLElement[] = [];
  let current: HTMLElement | null = null;
  let firstQuote = true;
  const newQuote = () => {
    const q = quote.cloneNode(false) as HTMLElement;
    if (!firstQuote) FIRST_PIECE_ONLY.forEach((a) => q.removeAttribute(a));
    firstQuote = false;
    return q;
  };
  const close = () => {
    if (current && isMeaningfulPiece(current)) pieces.push(current);
    current = null;
  };
  Array.prototype.slice.call(quote.childNodes).forEach((child: Node) => {
    const tag = child.nodeType === 1 ? (child as Element).tagName : "";
    if (QUOTE_LIFT_TAGS.test(tag)) {
      close();
      pieces.push(child as HTMLElement);
      return;
    }
    if (QUOTE_LINE_TAGS.test(tag)) {
      close();
      const q = newQuote();
      while (child.firstChild) q.appendChild(child.firstChild);
      if (!q.hasChildNodes()) q.appendChild(document.createElement("br"));
      pieces.push(q);
      return;
    }
    if (!current) current = newQuote();
    current.appendChild(child);
  });
  close();
  if (!pieces.length) {
    const q = newQuote();
    q.appendChild(document.createElement("br"));
    pieces.push(q);
  }
  quote.replaceWith(...pieces);
  return true;
}

export function repairQuotes(surface: HTMLElement): boolean {
  let changed = false;
  (Array.prototype.slice.call(surface.children) as HTMLElement[]).forEach((quote) => {
    if (quote.tagName !== "BLOCKQUOTE") return;
    // Blocks inside the quote's inline formatting first come up to the quote itself.
    if (hoistDeepBlocks(quote, INNER_BLOCK_TAGS)) changed = true;
    if (splitQuote(quote)) changed = true;
  });
  return changed;
}

// A divider or a quote inside a list item (Chrome's list buttons wrap a divider in an item when the
// selection spans one; pasting a quote with the caret in an item puts it there) can't be shown in
// it, so it's lifted out, splitting the top-level block it's in (the list, or the quote holding the
// list) in two around it — the part after it a copy of the same block, sub-lists and all. Tables
// are the table code's (see normalizeTables), cells too.
const LIFT_FROM_LISTS = "hr, blockquote";

function isEmptyTree(el: Element): boolean {
  return (el.textContent || "").replace(/\u200b/g, "").trim() === "" && !el.querySelector("hr, table, br, .note-pill");
}

// Drops the items the split emptied entirely (no content at all, not even a line break) and any
// list left with no items; a split-off part left with nothing goes too.
function dropSplitLeftovers(part: HTMLElement) {
  Array.prototype.slice.call(part.querySelectorAll("li")).forEach((li: HTMLElement) => {
    if (!li.hasChildNodes()) li.remove();
  });
  Array.prototype.slice.call(part.querySelectorAll("ul, ol")).reverse().forEach((l: HTMLElement) => {
    if (!l.children.length) l.remove();
  });
  if (isEmptyTree(part) && !part.querySelector("li")) part.remove();
}

// One list item out of its list, as a line where it was: the top-level block holding it (the list,
// or a quote holding the list) is split around it — the items before it stay in the first part, its
// sub-items and the items after it go in the second, still a list. Its content is moved, not copied.
// The line is a paragraph, or a quote line in the quote's color when the list was quoted.
export function itemToLine(li: HTMLElement, surface: HTMLElement): HTMLElement | null {
  let top: HTMLElement = li;
  while (top.parentElement && top.parentElement !== surface) top = top.parentElement;
  if (top === li || top.parentElement !== surface) return null;
  const tail = document.createRange();
  tail.setStartAfter(li);
  tail.setEnd(top, top.childNodes.length);
  const after = top.cloneNode(false) as HTMLElement;
  FIRST_PIECE_ONLY.forEach((a) => after.removeAttribute(a));
  after.appendChild(tail.extractContents());
  const line = top.tagName === "BLOCKQUOTE" ? (after.cloneNode(false) as HTMLElement) : document.createElement("p");
  while (li.firstChild) line.appendChild(li.firstChild);
  if (!line.hasChildNodes()) line.appendChild(document.createElement("br"));
  li.remove();
  top.after(line);
  line.after(after);
  dropSplitLeftovers(top);
  dropSplitLeftovers(after);
  // The part that kept them was emptied and dropped: the line (or the rest) takes them.
  if (!top.parentNode) carryLineAttributes(top, [line, after].filter((p) => !!p.parentNode));
  return line;
}

export function liftOutOfLists(surface: HTMLElement): boolean {
  let changed = false;
  for (let guard = 0; guard < 50; guard++) {
    const el = (Array.prototype.slice.call(surface.querySelectorAll(LIFT_FROM_LISTS)) as HTMLElement[]).find(
      (e) => !!e.parentElement && !!e.parentElement.closest("li, ul, ol") && surface.contains(e.parentElement.closest("li, ul, ol")) && !e.closest("td, th")
    );
    if (!el) break;
    let top: HTMLElement = el;
    while (top.parentElement && top.parentElement !== surface) top = top.parentElement;
    if (top === el || top.parentElement !== surface) break;
    const tail = document.createRange();
    tail.setStartAfter(el);
    tail.setEnd(top, top.childNodes.length);
    const after = top.cloneNode(false) as HTMLElement;
    FIRST_PIECE_ONLY.forEach((a) => after.removeAttribute(a));
    after.appendChild(tail.extractContents());
    top.after(el);
    el.after(after);
    dropSplitLeftovers(top);
    dropSplitLeftovers(after);
    if (!top.parentNode) carryLineAttributes(top, [el, after].filter((p) => !!p.parentNode));
    changed = true;
  }
  return changed;
}

// A line with nothing in it — not even the <br> that holds an empty line open — has no height: it
// can't be seen or clicked into. Edits leave these behind (an item emptied by deleting its text with
// the DOM, a paragraph split at its very end); each gets its <br>. Empty text nodes count as nothing.
const LINE_SELECTOR = "p, h1, h2, h3, h4, li, td, th";
export function fillEmptyLines(surface: HTMLElement): boolean {
  let changed = false;
  const quotes = (Array.prototype.slice.call(surface.children) as HTMLElement[]).filter((el) => el.tagName === "BLOCKQUOTE");
  (Array.prototype.slice.call(surface.querySelectorAll(LINE_SELECTOR)) as HTMLElement[]).concat(quotes).forEach((el) => {
    const empty = Array.prototype.every.call(el.childNodes, (n: Node) => n.nodeType === 3 && (n as Text).data === "");
    if (!empty) return;
    el.appendChild(document.createElement("br"));
    changed = true;
  });
  return changed;
}

// A <div> line (Chrome's own line wrapper before the editor told it to use <p>, still in older
// notes) is invisible to the block menu, quote and clear formatting, which only know the editor's
// own block tags. It becomes the paragraph it stands for, keeping where it sits among the sections.
export function divsToParagraphs(surface: HTMLElement): boolean {
  let changed = false;
  Array.prototype.slice.call(surface.children).forEach((div: HTMLElement) => {
    if (div.tagName !== "DIV") return;
    const p = document.createElement("p");
    ["data-exit", "data-standalone"].forEach((a) => {
      const v = div.getAttribute(a);
      if (v !== null) p.setAttribute(a, v);
    });
    while (div.firstChild) p.appendChild(div.firstChild);
    if (!p.hasChildNodes()) p.appendChild(document.createElement("br"));
    div.replaceWith(p);
    changed = true;
  });
  return changed;
}

// Table cells hold inline content only (the table code relies on it: Enter in a cell is a line
// break). Blocks the browser moves into one — dragging a paragraph or list into a cell — become
// lines of the cell: each block unwrapped, with a <br> between it and any content around it. Same result as
// markdown.ts's flattenToInline (used when pasting into a cell), but on the nodes themselves, so the
// caret stays put. A table inside a cell is the table code's (see normalizeTables).
const CELL_BLOCKS = "p, div, h1, h2, h3, h4, blockquote, ul, ol, li";
export function flattenCellBlocks(surface: HTMLElement): boolean {
  let changed = false;
  Array.prototype.slice.call(surface.querySelectorAll("td, th")).forEach((cell: HTMLElement) => {
    Array.prototype.slice.call(cell.querySelectorAll("hr")).forEach((hr: HTMLElement) => {
      if (hr.closest("td, th") !== cell) return;
      hr.remove();
      changed = true;
    });
    // Document order, outermost first: a list is unwrapped before its items, which then each end
    // with a line break (the list itself adds none).
    Array.prototype.slice.call(cell.querySelectorAll(CELL_BLOCKS)).forEach((b: HTMLElement) => {
      if (b.closest("td, th") !== cell) return;
      // A line of its own: a break before it too when text precedes it (x<ul>… isn't "xa").
      const prev = b.previousSibling;
      if (prev && !(prev.nodeType === 1 && (prev as Element).tagName === "BR") && hasContent([prev])) b.before(document.createElement("br"));
      const last = b.lastChild;
      const endsWithBreak = !!last && last.nodeType === 1 && (last as Element).tagName === "BR";
      if (b.nextSibling && !endsWithBreak && !/^(UL|OL)$/.test(b.tagName)) b.after(document.createElement("br"));
      unwrap(b);
      changed = true;
    });
  });
  return changed;
}

function unwrap(el: Element) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function sameColor(a: string, b: string): boolean {
  const probe = (c: string) => {
    const s = document.createElement("span");
    s.style.color = c;
    return s.style.color.replace(/\s+/g, "");
  };
  return probe(a) === probe(b);
}

// Spans (and <font>s) carrying styles the editor never sets are the browser copying computed styles
// around text it moved: those properties go. Such a span's weight/style/color were copied too (from
// the block the text came from, e.g. a heading merged into a paragraph), so those go with them —
// unless the color is a real one, not just the base text color. Empty spans, and spans left with no
// attributes at all, are unwrapped. Pills are the editor's own and left alone.
const FORMAT_TAGS = "b, strong, i, em, u, s, strike";
// A color written in the color() function is one the browser computed and copied (a pill's text
// color, a color-mix): the editor and its palette never write one.
function isComputedColor(color: string): boolean {
  return color.trim().toLowerCase().startsWith("color(");
}
// Inline formatting with nothing in it — no text, no line break — shows nothing.
function isEmptyInline(el: Element): boolean {
  return el.textContent === "" && !el.querySelector("br, .note-pill");
}

export function cleanInlineNoise(root: HTMLElement, opts: NormalizeOptions = {}): boolean {
  let changed = false;
  Array.prototype.slice.call(root.querySelectorAll("span, font")).forEach((el: HTMLElement) => {
    if (el.classList.contains("note-pill")) {
      // An emptied pill (its text dragged or deleted away, sometimes leaving an empty text node in
      // it) would stay behind as an invisible, unreachable one.
      if (el.textContent === "" && !el.querySelector("br")) {
        el.remove();
        changed = true;
        return;
      }
      // A pill inside a pill can't be shown as two: its text joins the outer one.
      if (el.parentElement && el.parentElement.closest(".note-pill")) {
        unwrap(el);
        changed = true;
      }
      return;
    }
    if (el.tagName === "FONT") {
      Array.prototype.slice.call(el.attributes).forEach((a: Attr) => {
        if (a.name !== "color") { el.removeAttribute(a.name); changed = true; }
      });
      if (isComputedColor(el.getAttribute("color") || "")) { el.removeAttribute("color"); changed = true; }
    } else {
      // Read from the attribute itself: not every DOM parses color() into style.color.
      const decls = (el.getAttribute("style") || "").split(";").filter((d) => d.trim());
      const kept = decls.filter((d) => !(/^\s*color\s*:/i.test(d) && isComputedColor(d.slice(d.indexOf(":") + 1))));
      if (kept.length !== decls.length) {
        if (kept.length) el.setAttribute("style", kept.join(";") + ";");
        else el.removeAttribute("style");
        changed = true;
      }
      const props: string[] = [];
      for (let i = 0; i < el.style.length; i++) props.push(el.style[i]);
      const foreign = props.filter((p) => !SPAN_STYLE_PROPS.has(p));
      if (foreign.length) {
        foreign.forEach((p) => el.style.removeProperty(p));
        el.style.removeProperty("font-weight");
        el.style.removeProperty("font-style");
        const color = el.style.color;
        if (color && opts.baseColor) {
          if (typeof opts.baseColor === "function") opts = { ...opts, baseColor: opts.baseColor() };
          if (sameColor(color, opts.baseColor as string)) el.style.removeProperty("color");
        }
        changed = true;
      }
      if (el.hasAttribute("style") && !el.getAttribute("style")!.trim()) { el.removeAttribute("style"); changed = true; }
      if (el.hasAttribute("class") && !el.className.trim()) { el.removeAttribute("class"); changed = true; }
    }
    if (isEmptyInline(el)) {
      el.remove();
      changed = true;
      return;
    }
    if (!el.attributes.length) {
      unwrap(el);
      changed = true;
    }
  });
  // Bold/italic/underline/strike and line breaks carry no style of the editor's own: whatever the
  // browser put there (a copied size, weight, color, a transparent background) goes. Emptied ones go.
  Array.prototype.slice.call(root.querySelectorAll(FORMAT_TAGS + ", br")).forEach((el: HTMLElement) => {
    if (el.hasAttribute("style")) { el.removeAttribute("style"); changed = true; }
    if (el.tagName !== "BR" && isEmptyInline(el)) { el.remove(); changed = true; }
  });
  return changed;
}

// A selection endpoint that survives its nodes being moved: a text node keeps its identity when
// re-parented (so it's kept as-is), an element position is kept as "before/after this child".
type Point = { node: Node; offset: number } | { before: Node | null; after: Node | null };
function savePoint(node: Node, offset: number): Point {
  if (node.nodeType === 3) return { node, offset };
  return { before: node.childNodes[offset] || null, after: offset > 0 ? node.childNodes[offset - 1] : null };
}
function restorePoint(p: Point, surface: HTMLElement): { node: Node; offset: number } | null {
  if ("node" in p) return p.node.isConnected && surface.contains(p.node) ? p : null;
  const at = (n: Node, after: boolean) => {
    const parent = n.parentNode!;
    const i = Array.prototype.indexOf.call(parent.childNodes, n) as number;
    return { node: parent, offset: after ? i + 1 : i };
  };
  if (p.after && p.after.isConnected && surface.contains(p.after)) return at(p.after, true);
  if (p.before && p.before.isConnected && surface.contains(p.before)) return at(p.before, false);
  return null;
}

// Runs `change` and puts the selection back where it was, when it's inside the surface — moving a
// node out from under a selection otherwise collapses it to wherever that node used to be.
export function keepingSelection(surface: HTMLElement, change: () => boolean): boolean {
  const sel = window.getSelection();
  const inside = !!sel && sel.rangeCount > 0 && !!sel.anchorNode && surface.contains(sel.anchorNode) && !!sel.focusNode && surface.contains(sel.focusNode);
  const anchor = inside ? savePoint(sel!.anchorNode!, sel!.anchorOffset) : null;
  const focus = inside ? savePoint(sel!.focusNode!, sel!.focusOffset) : null;
  const changed = change();
  if (changed && anchor && focus) {
    const a = restorePoint(anchor, surface);
    const f = restorePoint(focus, surface);
    if (a && f) {
      try {
        sel!.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
      } catch {
        /* an offset past a node that shrank: leave the browser's own selection */
      }
    }
  }
  return changed;
}

// Every repair, keeping the selection. Returns whether anything changed (so the caller saves).
export function normalizeStructure(surface: HTMLElement, opts: NormalizeOptions = {}): boolean {
  return keepingSelection(surface, () => {
    // First: the list repair below skips lists inside cells, which this unwraps.
    let changed = flattenCellBlocks(surface);
    if (cleanInlineNoise(surface, opts)) changed = true;
    // One repair can leave work for another (splitting a line lifts a list or a <div> out of it, a
    // quote lifts a heading that holds a list...), so they run until nothing changes; each only
    // changes what's broken, so this settles in a pass or two.
    for (let pass = 0; pass < 5; pass++) {
      const results = [
        liftOutOfLists(surface),
        // Before wrapping loose content: an <li> straight in the surface goes back into a list.
        repairLists(surface),
        wrapLooseRootContent(surface),
        splitNestedBlocks(surface),
        repairQuotes(surface),
        divsToParagraphs(surface),
      ];
      if (!results.some(Boolean)) break;
      changed = true;
    }
    // Again at the end: the repairs above split inline formatting, which can leave empty pieces.
    if (changed && cleanInlineNoise(surface, opts)) changed = true;
    if (fillEmptyLines(surface)) changed = true;
    return changed;
  });
}

// The same repairs on HTML that isn't in the editor (an exported or imported note).
export function normalizeHtml(html: string): string {
  const box = document.createElement("div");
  box.innerHTML = html;
  return normalizeStructure(box) ? box.innerHTML : html;
}
