// Our own undo/redo stack. contenteditable's native Ctrl+Z only tracks changes made via
// execCommand — our custom DOM surgery (dividers, list-clearing, color spans via Range) never
// gets recorded there, so mixing the two desyncs the native history and Ctrl+Z misbehaves
// (skips steps, half-undoes a divider, etc.). We snapshot innerHTML ourselves and fully own
// undo/redo instead of ever invoking the browser's built-in contenteditable undo.
// Each snapshot also remembers the selection at that moment, so undo/redo puts the caret back
// where the change happened instead of the browser's default (the very start of the note).
// Positions are stored as (top-level block index, character offset within that block): stable
// across the innerHTML round-trip, unlike DOM node references, which all get replaced.
// Inside a table, the offset counts from the start of the cell (sc/ec: the cell's index in the
// table, -1 elsewhere): counted from the table's start, an empty cell has no position at all, and
// the end of one cell is the same count as the start of the next.
interface CaretPos { sb: number; so: number; sc: number; eb: number; eo: number; ec: number }
interface Snapshot { html: string; caret: CaretPos | null }

export interface HistoryContext {
  surface: HTMLElement;
  blockAt: (node: Node) => HTMLElement | null;
  cellAt: (node: Node | null) => HTMLElement | null;
  tableCells: (table: HTMLElement) => HTMLElement[];
  /** The note's HTML as saved (see editorHtml in main.ts). */
  editorHtml: () => string;
  /** After undo/redo replaced the note's content. */
  onRestore: () => void;
}

export function createHistory(ctx: HistoryContext) {
  const surface = ctx.surface;
  const past: Snapshot[] = [];
  const future: Snapshot[] = [];
  let restoringHistory = false;

  function pointToPos(node: Node, offset: number): [number, number, number] | null {
    const blocks = Array.prototype.slice.call(surface.children) as HTMLElement[];
    if (!blocks.length) return null;
    if (node === surface) {
      // offset counts child NODES (whitespace text between blocks included), not elements.
      let index = 0;
      for (let i = 0; i < offset && i < surface.childNodes.length; i++) {
        if (surface.childNodes[i].nodeType === 1) index++;
      }
      return index >= blocks.length ? [blocks.length - 1, blockTextLength(blocks[blocks.length - 1]), -1] : [index, 0, -1];
    }
    const block = ctx.blockAt(node);
    if (!block) return null;
    const cell = ctx.cellAt(node);
    const r = document.createRange();
    r.setStart(cell || block, 0);
    r.setEnd(node, offset);
    return [blocks.indexOf(block), r.toString().replace(/\u200b/g, "").length, cell ? ctx.tableCells(block).indexOf(cell) : -1];
  }
  function blockTextLength(block: HTMLElement): number {
    return (block.textContent || "").replace(/\u200b/g, "").length;
  }
  function posToPoint(blockIndex: number, offset: number, cellIndex: number): [Node, number] | null {
    const blocks = surface.children;
    if (!blocks.length) return null;
    let block = blocks[Math.min(blockIndex, blocks.length - 1)] as HTMLElement;
    if (cellIndex >= 0 && block.tagName === "TABLE") {
      const cells = ctx.tableCells(block);
      if (cells.length) block = cells[Math.min(cellIndex, cells.length - 1)];
    }
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let last: Text | null = null;
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      if (remaining <= t.data.length) return [t, remaining];
      remaining -= t.data.length;
      last = t;
    }
    return last ? [last, last.data.length] : [block, 0];
  }
  function captureCaret(): CaretPos | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!surface.contains(r.startContainer) || !surface.contains(r.endContainer)) return null;
    const start = pointToPos(r.startContainer, r.startOffset);
    const end = pointToPos(r.endContainer, r.endOffset);
    return start && end ? { sb: start[0], so: start[1], sc: start[2], eb: end[0], eo: end[1], ec: end[2] } : null;
  }
  function restoreCaret(caret: CaretPos | null) {
    if (!caret) return;
    const start = posToPoint(caret.sb, caret.so, caret.sc);
    const end = posToPoint(caret.eb, caret.eo, caret.ec);
    if (!start || !end) return;
    const r = document.createRange();
    r.setStart(start[0], start[1]);
    r.setEnd(end[0], end[1]);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function snapshot(): Snapshot {
    return { html: ctx.editorHtml(), caret: captureCaret() };
  }

  function pushHistory() {
    if (restoringHistory) return;
    past.push(snapshot());
    if (past.length > 100) past.shift();
    future.length = 0;
  }
  function undo() {
    if (!past.length) return;
    future.push(snapshot());
    const prev = past.pop()!;
    restoringHistory = true;
    surface.innerHTML = prev.html;
    restoringHistory = false;
    restoreCaret(prev.caret);
    ctx.onRestore();
  }
  function redo() {
    if (!future.length) return;
    past.push(snapshot());
    const next = future.pop()!;
    restoringHistory = true;
    surface.innerHTML = next.html;
    restoringHistory = false;
    restoreCaret(next.caret);
    ctx.onRestore();
  }

  return {
    push: pushHistory,
    undo,
    redo,
    /** True while undo/redo is replacing the content, so the changes it makes aren't edits. */
    restoring: () => restoringHistory,
  };
}
