// Collapsible sections: folding headings and toggles, and lines leaving the sections around them.

export interface SectionsContext {
  surface: HTMLElement;
  blockAt: (node: Node) => HTMLElement | null;
  /** A section was folded or unfolded (by the GM, or to show what an edit would touch). */
  onFoldChange: () => void;
}

export function createSections(ctx: SectionsContext) {
  const surface = ctx.surface;
  // Collapsible sections: an H1-H4 with data-collapsed hides every following top-level block up to
  // the next heading of the same or a higher level (H4, the "toggle" level, is styled as plain text).
  // Blocks are only ever hidden, never moved or nested, so nothing else in the editor needs to know
  // about sections. The chevron is the heading's ::before, drawn in the gutter to its left.
  function headingLevel(el: Element): number {
    const m = /^H([1-4])$/.exec(el.tagName);
    return m ? Number(m[1]) : 0;
  }
  // Also gives every block a data-depth (how many sections enclose it), which indents it a step per
  // level, so the indent shows which section each line belongs to — toggles look like plain text, so
  // it's also what shows where one ends. A section ends at the next heading of the same or a higher
  // level (so toggles can't nest), or early, at a line that leaves it (see exitLevel).
  function setFlag(el: HTMLElement, name: string, on: boolean) {
    if (on && !el.hasAttribute(name)) el.setAttribute(name, "");
    else if (!on && el.hasAttribute(name)) el.removeAttribute(name);
  }
  // A line (paragraph, quote or heading) can leave the sections around it: data-exit="N" ends every
  // open section of level N or deeper right before it, so it — and what follows — sits outside
  // them (a heading then opens its own section there). Older notes mark a line that left its toggle
  // as data-standalone: the same as data-exit="4".
  const canExit = (el: Element): boolean => /^(P|DIV|BLOCKQUOTE|H[1-4])$/.test(el.tagName);
  function exitLevel(el: Element): number {
    if (!canExit(el)) return 0;
    const n = Number(el.getAttribute("data-exit"));
    if (Number.isInteger(n) && n >= 1 && n <= 4) return n;
    return el.hasAttribute("data-standalone") ? 4 : 0;
  }
  // Steps through the note's top-level blocks keeping the sections open at each one (their levels,
  // outermost first; always increasing, since a heading first closes any section of its level or
  // deeper). `visit` sees each block with the sections around it, before its own exit applies.
  function walkSections(visit: (el: HTMLElement, around: number[]) => boolean | void) {
    const open: number[] = [];
    for (const el of Array.prototype.slice.call(surface.children) as HTMLElement[]) {
      const level = headingLevel(el);
      if (level) while (open.length && open[open.length - 1] >= level) open.pop();
      if (visit(el, open.slice()) === false) return;
      const exit = exitLevel(el);
      if (exit) while (open.length && open[open.length - 1] >= exit) open.pop();
      if (level) open.push(level);
    }
  }
  function applyFolding() {
    let hideUntil = 0;
    walkSections((el, around) => {
      const level = headingLevel(el);
      const exit = exitLevel(el);
      // The sections this block itself is in: those around it that its exit doesn't end.
      const open = exit ? around.filter((l) => l < exit) : around;
      if (hideUntil && ((level && level <= hideUntil) || (exit && exit <= hideUntil))) hideUntil = 0;
      const depth = String(open.length);
      if (open.length) {
        if (el.getAttribute("data-depth") !== depth) el.setAttribute("data-depth", depth);
      } else if (el.hasAttribute("data-depth")) {
        el.removeAttribute("data-depth");
      }
      setFlag(el, "data-folded", !!hideUntil);
      if (!hideUntil && level && el.hasAttribute("data-collapsed")) hideUntil = level;
    });
  }
  // What Decrease indent (-1) / Increase indent (+1) on a line would set its exit to:
  // out of the innermost section it's in, or back into the last one it left. Null when there's
  // nothing to step out of or back into.
  function sectionStep(block: HTMLElement, dir: -1 | 1): number | null {
    if (!canExit(block) || block.parentElement !== surface) return null;
    let around: number[] = [];
    walkSections((el, a) => {
      if (el !== block) return;
      around = a;
      return false;
    });
    const exit = exitLevel(block);
    const inside = exit ? around.filter((l) => l < exit) : around;
    if (dir < 0) return inside.length ? inside[inside.length - 1] : null;
    if (inside.length === around.length) return null;
    // Back into one more section: the exit now ends only the ones deeper than that (none: no exit).
    return inside.length + 1 < around.length ? around[inside.length + 1] : 0;
  }
  function stepSection(block: HTMLElement, dir: -1 | 1): boolean {
    const exit = sectionStep(block, dir);
    if (exit === null) return false;
    block.removeAttribute("data-standalone");
    if (exit) block.setAttribute("data-exit", String(exit));
    else block.removeAttribute("data-exit");
    applyFolding();
    return true;
  }
  // The top-level block the selection starts in.
  function sel0Block(): HTMLElement | null {
    const sel = window.getSelection();
    return sel && sel.rangeCount ? ctx.blockAt(sel.getRangeAt(0).startContainer) : null;
  }
  function toggleFold(heading: HTMLElement) {
    if (heading.hasAttribute("data-collapsed")) heading.removeAttribute("data-collapsed");
    else heading.setAttribute("data-collapsed", "");
    applyFolding();
    const sel = window.getSelection();
    const caretBlock = sel && sel.rangeCount ? ctx.blockAt(sel.getRangeAt(0).startContainer) : null;
    if (caretBlock && caretBlock.hasAttribute("data-folded")) {
      const r = document.createRange();
      r.selectNodeContents(heading);
      r.collapse(false);
      sel!.removeAllRanges();
      sel!.addRange(r);
    }
    ctx.onFoldChange();
  }
  // Expands whatever collapsed heading(s) hide `hidden` (a data-folded block): the owner is the
  // nearest preceding block that isn't itself hidden; a nested collapsed heading inside it may
  // still hide `hidden` after that, hence the loop.
  function unfoldAround(hidden: HTMLElement) {
    while (hidden.hasAttribute("data-folded")) {
      let owner = hidden.previousElementSibling as HTMLElement | null;
      while (owner && owner.hasAttribute("data-folded")) owner = owner.previousElementSibling as HTMLElement | null;
      if (!owner || !owner.hasAttribute("data-collapsed")) break;
      owner.removeAttribute("data-collapsed");
      applyFolding();
    }
    ctx.onFoldChange();
  }
  // Backspace at the start of the block right after a collapsed section (or Delete at the end of a
  // collapsed heading) made Chrome merge across the hidden blocks, silently deleting all of them.
  // Instead, that key press just expands the section, so the merge — if still wanted, with a second
  // press — happens with its content in plain sight.
  function guardFoldedMerge(ev: KeyboardEvent): boolean {
    if (ev.key !== "Backspace" && ev.key !== "Delete") return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    const block = ctx.blockAt(r.startContainer);
    if (!block) return false;
    const edge = document.createRange();
    edge.selectNodeContents(block);
    if (ev.key === "Backspace") edge.setEnd(r.startContainer, r.startOffset);
    else edge.setStart(r.startContainer, r.startOffset);
    if (edge.toString() !== "") return false;
    const neighbor = (ev.key === "Backspace" ? block.previousElementSibling : block.nextElementSibling) as HTMLElement | null;
    if (!neighbor || !neighbor.hasAttribute("data-folded")) return false;
    ev.preventDefault();
    unfoldAround(neighbor);
    return true;
  }
  // A selection reaching into a collapsed section takes in its hidden lines too, so deleting or
  // typing over it would silently remove what can't be seen. An edit over such a selection only
  // expands those sections instead, the selection still in place — now showing everything it
  // covers; repeating the edit then applies to all of it in plain sight. Returns whether it did.
  function unfoldSelection(range?: Range | null): boolean {
    const sel = window.getSelection();
    const r = range || (sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null);
    if (!r || r.collapsed) return false;
    const hidden = (Array.prototype.slice.call(surface.querySelectorAll("[data-folded]")) as HTMLElement[]).filter((el) => r.intersectsNode(el));
    if (!hidden.length) return false;
    hidden.forEach((el) => {
      if (el.hasAttribute("data-folded")) unfoldAround(el);
    });
    return true;
  }
  surface.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement;
    const heading = target && target.closest ? (target.closest("h1, h2, h3, h4") as HTMLElement | null) : null;
    if (!heading || heading.parentElement !== surface) return;
    // Only the chevron itself, which sits left of the heading's own box.
    if (ev.clientX >= heading.getBoundingClientRect().left) return;
    ev.preventDefault();
    toggleFold(heading);
  });

  return { headingLevel, canExit, exitLevel, applyFolding, sectionStep, stepSection, sel0Block, toggleFold, guardFoldedMerge, unfoldSelection };
}
