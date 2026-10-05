// The structure of the editor's tables: a grid view of a <table> (which cell covers which row and
// column, merged cells included) and every structural change, made directly on the DOM. The table's
// HTML stays the only source of truth — the grid is rebuilt from it whenever it's needed — so undo,
// saving, sync and export keep working on plain HTML with nothing to keep in sync.
// No editor state here: callers place the caret and record undo.

export type Scope = "col" | "row" | null;

// One cell placed on the grid: its top-left position and how many rows/columns it covers.
export interface GridCell {
  el: HTMLTableCellElement;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

export interface Grid {
  rows: number;
  cols: number;
  // slots[r][c]: the cell covering that position (undefined where a short row leaves a hole).
  slots: (GridCell | undefined)[][];
  // Every cell once, in reading order (the order of the cells in the HTML).
  cells: GridCell[];
  of: Map<HTMLTableCellElement, GridCell>;
}

// Spans above this are treated as this (a pasted or hand-edited table can't make the grid huge).
const MAX_SPAN = 50;
function readSpan(el: HTMLTableCellElement, attr: "rowspan" | "colspan"): number {
  const n = Math.floor(Number(el.getAttribute(attr)));
  return n >= 1 ? Math.min(n, MAX_SPAN) : 1;
}
function writeSpan(el: HTMLTableCellElement, attr: "rowspan" | "colspan", n: number) {
  if (n > 1) el.setAttribute(attr, String(n));
  else el.removeAttribute(attr);
}

function rowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.prototype.slice.call(table.rows) as HTMLTableRowElement[];
}

// The standard HTML table layout: each cell takes the next free position in its row, skipping
// positions already covered by a cell from a row above. A rowspan reaching past the last row is cut
// to the rows that exist.
export function buildGrid(table: HTMLTableElement): Grid {
  const rows = rowsOf(table);
  const slots: (GridCell | undefined)[][] = rows.map(() => []);
  const cells: GridCell[] = [];
  const of = new Map<HTMLTableCellElement, GridCell>();
  rows.forEach((tr, r) => {
    let c = 0;
    (Array.prototype.slice.call(tr.cells) as HTMLTableCellElement[]).forEach((el) => {
      while (slots[r][c]) c++;
      const gc: GridCell = {
        el,
        row: r,
        col: c,
        rowSpan: Math.min(readSpan(el, "rowspan"), rows.length - r),
        colSpan: readSpan(el, "colspan"),
      };
      cells.push(gc);
      of.set(el, gc);
      for (let i = r; i < r + gc.rowSpan; i++) {
        for (let k = c; k < c + gc.colSpan; k++) slots[i][k] = gc;
      }
      c += gc.colSpan;
    });
  });
  const cols = Math.max(0, ...slots.map((s) => s.length));
  return { rows: rows.length, cols, slots, cells, of };
}

export function newCell(doc: Document, tag: "TD" | "TH", scope: Scope = null): HTMLTableCellElement {
  const cell = doc.createElement(tag) as HTMLTableCellElement;
  if (scope) cell.setAttribute("scope", scope);
  cell.innerHTML = "<br>";
  return cell;
}

// A new table with a header row.
export function createTable(doc: Document, rows: number, cols: number): HTMLTableElement {
  const table = doc.createElement("table");
  const body = doc.createElement("tbody");
  table.appendChild(body);
  for (let r = 0; r < rows; r++) {
    const tr = doc.createElement("tr");
    for (let c = 0; c < cols; c++) tr.appendChild(r === 0 ? newCell(doc, "TH", "col") : newCell(doc, "TD"));
    body.appendChild(tr);
  }
  return table;
}

export function cellAt(table: HTMLTableElement, row: number, col: number): HTMLTableCellElement | null {
  return buildGrid(table).slots[row]?.[col]?.el ?? null;
}
export function positionOf(cell: HTMLTableCellElement): GridCell | null {
  const table = cell.closest("table");
  return table ? buildGrid(table).of.get(cell) ?? null : null;
}

// ---------- headers ----------
// Header cells are <th>: scope="col" in the header row, scope="row" in the header column (the corner
// cell, when both are on, belongs to the header row). A <th> without scope is a header-row cell from
// before the header column existed. The table itself also says it has a header column
// (data-header-col): with only the header row left, no cell would.
export function hasHeaderRow(table: HTMLTableElement): boolean {
  return buildGrid(table).cells.some(
    (gc) => gc.row === 0 && gc.el.tagName === "TH" && (gc.el.getAttribute("scope") || "col") === "col"
  );
}
export function hasHeaderCol(table: HTMLTableElement): boolean {
  if (table.hasAttribute("data-header-col")) return true;
  return buildGrid(table).cells.some((gc) => gc.col === 0 && gc.el.tagName === "TH" && gc.el.getAttribute("scope") === "row");
}

// "col" for a header-row cell, "row" for a header-column one, "TD" for the body.
function roleOf(el: HTMLTableCellElement): string {
  return el.tagName === "TH" ? el.getAttribute("scope") || "col" : "TD";
}

// Swaps a cell's tag and scope, keeping its content and every other attribute (spans, color...).
function retag(cell: HTMLTableCellElement, tag: "TD" | "TH", scope: Scope): HTMLTableCellElement {
  let el = cell;
  if (cell.tagName !== tag) {
    el = cell.ownerDocument.createElement(tag) as HTMLTableCellElement;
    Array.prototype.forEach.call(cell.attributes, (a: Attr) => el.setAttribute(a.name, a.value));
    while (cell.firstChild) el.appendChild(cell.firstChild);
    if (!el.hasChildNodes()) el.innerHTML = "<br>";
    cell.replaceWith(el);
  }
  if (scope) el.setAttribute("scope", scope);
  else el.removeAttribute("scope");
  return el;
}

// Re-tags every cell from the two header switches, so any structural change keeps them right (e.g.
// deleting the first column makes the next one the header column). Cells may be replaced: callers
// find the caret's cell again by position.
export function applyHeaders(table: HTMLTableElement, headerRow: boolean, headerCol: boolean) {
  if (headerCol) table.setAttribute("data-header-col", "");
  else table.removeAttribute("data-header-col");
  buildGrid(table).cells.forEach((gc) => {
    if (gc.row === 0 && headerRow) retag(gc.el, "TH", "col");
    else if (gc.col === 0 && headerCol) retag(gc.el, "TH", "row");
    else retag(gc.el, "TD", null);
  });
}
function keepHeaders(table: HTMLTableElement, change: () => void) {
  const headerRow = hasHeaderRow(table);
  const headerCol = hasHeaderCol(table);
  change();
  applyHeaders(table, headerRow, headerCol);
}

// ---------- colors ----------
// A cell's color is stored on the cell itself (--cell-c, a palette color the CSS turns into a tint).
// Coloring a row or column colors each of its cells: there's no row or column color to keep right
// through merges, inserts and deletes.
export function cellColor(el: HTMLTableCellElement): string {
  return el.style.getPropertyValue("--cell-c").trim();
}
export function setCellColor(el: HTMLTableCellElement, color: string) {
  if (color) el.style.setProperty("--cell-c", color);
  else el.style.removeProperty("--cell-c");
  if (!el.getAttribute("style")) el.removeAttribute("style");
}

// Every cell crossing the rows (or columns) `cell` covers, in reading order.
export function lineCells(table: HTMLTableElement, cell: HTMLTableCellElement, line: "row" | "col"): HTMLTableCellElement[] {
  const grid = buildGrid(table);
  const gc = grid.of.get(cell);
  if (!gc) return [];
  const [from, to] = line === "row" ? [gc.row, gc.row + gc.rowSpan] : [gc.col, gc.col + gc.colSpan];
  return grid.cells
    .filter((c) => (line === "row" ? c.row < to && c.row + c.rowSpan > from : c.col < to && c.col + c.colSpan > from))
    .map((c) => c.el);
}

// The color a cell added to a column (or row) takes: the one all its cells share, if they do. The
// cells of the header crossing that line don't count (a colored header row doesn't color the rows
// added below it).
function inheritedColor(line: (GridCell | undefined)[], skipRole: string): string {
  const cells = Array.from(new Set(line.filter((gc): gc is GridCell => !!gc && roleOf(gc.el) !== skipRole)));
  if (!cells.length) return "";
  const color = cellColor(cells[0].el);
  return cells.every((gc) => cellColor(gc.el) === color) ? color : "";
}
function coloredCell(doc: Document, color: string): HTMLTableCellElement {
  const cell = newCell(doc, "TD");
  setCellColor(cell, color);
  return cell;
}

// ---------- column widths ----------
// Set widths live in a <colgroup> before the rows: one <col style="--col-w:120px"> per column (the
// CSS makes that the column's width). A table with set widths is as wide as they add up to: wider
// than the note it scrolls sideways, narrower it sits at the left. A table without them fills the
// note and sizes its columns to their content. Inserting or deleting a column keeps the colgroup
// matching (see insertCol, deleteCol, normalizeTable).
export const MIN_COL_WIDTH = 40;
export const MAX_COL_WIDTH = 2000;

function colgroups(table: HTMLTableElement): HTMLElement[] {
  return Array.prototype.filter.call(table.children, (el: Element) => el.tagName === "COLGROUP") as HTMLElement[];
}
export function colWidths(table: HTMLTableElement): number[] | null {
  const group = colgroups(table)[0];
  if (!group) return null;
  return Array.prototype.map.call(group.children, (col: HTMLElement) => parseFloat(col.style.getPropertyValue("--col-w")) || 0) as number[];
}

// Whole pixels within the limits; missing or junk values take the average of the valid ones.
export function cleanWidths(widths: number[]): number[] {
  const valid = widths.filter((w) => isFinite(w) && w > 0);
  const fallback = valid.length ? valid.reduce((t, w) => t + w, 0) / valid.length : 120;
  return widths.map((w) => Math.round(Math.min(Math.max(isFinite(w) && w > 0 ? w : fallback, MIN_COL_WIDTH), MAX_COL_WIDTH)));
}

// Replaces the table's widths (null: back to filling the note, sized by content).
export function setColWidths(table: HTMLTableElement, widths: number[] | null) {
  colgroups(table).forEach((g) => g.remove());
  if (!widths || !widths.length) return;
  const doc = table.ownerDocument;
  const group = doc.createElement("colgroup");
  cleanWidths(widths).forEach((w) => {
    const col = doc.createElement("col");
    col.style.setProperty("--col-w", w + "px");
    group.appendChild(col);
  });
  table.prepend(group);
}

// Every column as wide as the average, so the table keeps its width.
export function evenWidths(widths: number[]): number[] {
  const avg = widths.reduce((t, w) => t + w, 0) / Math.max(1, widths.length);
  return widths.map(() => avg);
}

// ---------- structure ----------
// Puts `el` into row `r` so the row's cells stay in column order (a cell's place in the HTML is what
// decides its column).
function placeInRow(grid: Grid, tr: HTMLTableRowElement, r: number, col: number, el: HTMLTableCellElement) {
  const after = grid.cells.find((gc) => gc.row === r && gc.col > col && gc.el.parentElement === tr);
  if (after) after.el.before(el);
  else tr.appendChild(el);
}

// Inserts an empty row so it becomes row `at` (0 … rows). A merged cell crossing that line grows
// to cover the new row instead of getting a new cell there.
export function insertRow(table: HTMLTableElement, at: number): HTMLTableRowElement {
  const doc = table.ownerDocument;
  keepHeaders(table, () => {
    const grid = buildGrid(table);
    const tr = doc.createElement("tr");
    const grown = new Set<GridCell>();
    for (let c = 0; c < grid.cols; c++) {
      const gc = at < grid.rows ? grid.slots[at][c] : undefined;
      if (gc && gc.row < at) {
        if (!grown.has(gc)) {
          grown.add(gc);
          writeSpan(gc.el, "rowspan", gc.rowSpan + 1);
        }
        continue;
      }
      tr.appendChild(coloredCell(doc, inheritedColor(grid.slots.map((row) => row[c]), "col")));
    }
    const rows = rowsOf(table);
    if (at < rows.length) rows[at].before(tr);
    else if (rows.length) rows[rows.length - 1].after(tr);
    else (table.tBodies[0] || table.appendChild(doc.createElement("tbody"))).appendChild(tr);
  });
  return rowsOf(table)[at];
}

// Inserts an empty column so it becomes column `at` (0 … cols). A merged cell crossing that line
// grows to cover the new column.
export function insertCol(table: HTMLTableElement, at: number) {
  const doc = table.ownerDocument;
  keepHeaders(table, () => {
    const grid = buildGrid(table);
    const rows = rowsOf(table);
    const grown = new Set<GridCell>();
    rows.forEach((tr, r) => {
      const gc = at < grid.cols ? grid.slots[r][at] : undefined;
      if (gc && gc.col < at) {
        if (!grown.has(gc)) {
          grown.add(gc);
          writeSpan(gc.el, "colspan", gc.colSpan + 1);
        }
        return;
      }
      placeInRow(grid, tr, r, at - 1, coloredCell(doc, inheritedColor(grid.slots[r], "row")));
    });
  });
  // The new column is as wide as the average one; the table grows by that much.
  const widths = colWidths(table);
  if (widths) {
    widths.splice(at, 0, NaN);
    setColWidths(table, widths);
  }
}

// Deletes row `r`. A merged cell covering it shrinks; one that starts in it moves down to the next
// row. Returns false if the table has no rows left (the caller removes it).
export function deleteRow(table: HTMLTableElement, r: number): boolean {
  const headerCol = hasHeaderCol(table);
  // Deleting the header row leaves the table without one.
  const headerRow = r !== 0 && hasHeaderRow(table);
  const grid = buildGrid(table);
  const rows = rowsOf(table);
  if (r < 0 || r >= rows.length) return rows.length > 0;
  const seen = new Set<GridCell>();
  grid.slots[r].forEach((gc) => {
    if (!gc || seen.has(gc)) return;
    seen.add(gc);
    if (gc.row < r) {
      writeSpan(gc.el, "rowspan", gc.rowSpan - 1);
    } else if (gc.rowSpan > 1) {
      writeSpan(gc.el, "rowspan", gc.rowSpan - 1);
      placeInRow(grid, rows[r + 1], r + 1, gc.col, gc.el);
    }
  });
  rows[r].remove();
  if (!table.rows.length) return false;
  applyHeaders(table, headerRow, headerCol);
  return true;
}

// Deletes column `c`. A merged cell covering it shrinks. Returns false if no columns are left.
export function deleteCol(table: HTMLTableElement, c: number): boolean {
  const grid = buildGrid(table);
  if (c < 0 || c >= grid.cols) return grid.cols > 0;
  if (grid.cols === 1) return false;
  keepHeaders(table, () => {
    const seen = new Set<GridCell>();
    grid.slots.forEach((row) => {
      const gc = row[c];
      if (!gc || seen.has(gc)) return;
      seen.add(gc);
      if (gc.colSpan > 1) writeSpan(gc.el, "colspan", gc.colSpan - 1);
      else gc.el.remove();
    });
  });
  const widths = colWidths(table);
  if (widths) {
    widths.splice(c, 1);
    setColWidths(table, widths);
  }
  return true;
}

// ---------- moving rows and columns ----------
// Rows (or columns) joined by a merged cell only move together, as a block: moving them apart would
// tear the merge. Every other row (column) is a block of its own. The header row (column) stays
// first.
export type Axis = "row" | "col";
export interface Block {
  start: number;
  // One past the block's last row (column).
  end: number;
}

export function blocks(table: HTMLTableElement, axis: Axis): Block[] {
  const grid = buildGrid(table);
  const count = axis === "row" ? grid.rows : grid.cols;
  // How far the cells crossing position i reach along the axis.
  const reach = (i: number) =>
    (axis === "row" ? grid.slots[i] : grid.slots.map((row) => row[i])).reduce(
      (end, gc) => (gc ? Math.max(end, axis === "row" ? gc.row + gc.rowSpan : gc.col + gc.colSpan) : end),
      i + 1
    );
  const out: Block[] = [];
  let start = 0;
  let end = 0;
  for (let i = 0; i < count; i++) {
    end = Math.max(end, reach(i));
    if (end === i + 1) {
      out.push({ start, end });
      start = end;
    }
  }
  return out;
}
export function blockOf(table: HTMLTableElement, axis: Axis, index: number): Block | null {
  return blocks(table, axis).find((b) => index >= b.start && index < b.end) ?? null;
}

// The positions the block holding `index` can move to: the start of every block (and the end of the
// table), except where it already is and before the header row (column).
export function moveTargets(table: HTMLTableElement, axis: Axis, index: number): number[] {
  const all = blocks(table, axis);
  const own = all.find((b) => index >= b.start && index < b.end);
  const header = axis === "row" ? hasHeaderRow(table) : hasHeaderCol(table);
  if (!own || (header && own.start === 0)) return [];
  const edges = all.map((b) => b.start).concat([all[all.length - 1].end]);
  return edges.filter((at) => at !== own.start && at !== own.end && !(header && at === 0));
}

// One block back or forward: before the previous block, or after the next one.
export function moveStep(table: HTMLTableElement, axis: Axis, index: number, dir: -1 | 1): number | null {
  const all = blocks(table, axis);
  const i = all.findIndex((b) => index >= b.start && index < b.end);
  const neighbor = all[i + dir];
  if (i === -1 || !neighbor) return null;
  const at = dir < 0 ? neighbor.start : neighbor.end;
  return moveTargets(table, axis, index).includes(at) ? at : null;
}

// Moves the block holding `index` so it sits before position `at` as the table is now (at = the
// count: to the end). Only to one of moveTargets(); returns false otherwise. Cells move whole, with
// everything on them; a column's set width moves with it.
export function moveBlock(table: HTMLTableElement, axis: Axis, index: number, at: number): boolean {
  if (!moveTargets(table, axis, index).includes(at)) return false;
  const own = blockOf(table, axis, index)!;
  const rows = rowsOf(table);
  if (axis === "row") {
    const moving = rows.slice(own.start, own.end);
    if (at < rows.length) rows[at].before(...moving);
    else rows[rows.length - 1].after(...moving);
    return true;
  }
  // Columns: where each column lands, then every row's cells put in that order. A row's own cells
  // fill the positions cells from rows above don't cover, in order — and those cells move the same
  // way — so ordering each row by new position is all it takes.
  const grid = buildGrid(table);
  const size = own.end - own.start;
  const moved = (c: number) => {
    if (c >= own.start && c < own.end) return (at > own.start ? at - size : at) + (c - own.start);
    if (at > own.start && c >= own.end && c < at) return c - size;
    if (at < own.start && c >= at && c < own.start) return c + size;
    return c;
  };
  rows.forEach((tr, r) => {
    grid.cells
      .filter((gc) => gc.row === r && gc.el.parentElement === tr)
      .sort((a, b) => moved(a.col) - moved(b.col))
      .forEach((gc) => tr.appendChild(gc.el));
  });
  const widths = colWidths(table);
  if (widths) {
    const next = widths.slice();
    widths.forEach((w, c) => (next[moved(c)] = w));
    setColWidths(table, next);
  }
  return true;
}

// ---------- merging ----------
export type MergeDirection = "right" | "down";

// The cells merging `cell` with its neighbors to the right (or below) would combine: every cell
// touching that side, as long as together they make a rectangle (they don't stick out past the
// cell's rows/columns, and they all end at the same column/row) of one role (headers never merge
// with the body). Null when there's no such merge. `end` is where the merged cell will end (its
// last column/row + 1).
function mergeGroup(grid: Grid, gc: GridCell, dir: MergeDirection): { group: GridCell[]; end: number } | null {
  const right = dir === "right";
  // `at`: the first column (row) past the cell; from…to: the rows (columns) it covers.
  const at = right ? gc.col + gc.colSpan : gc.row + gc.rowSpan;
  if (at >= (right ? grid.cols : grid.rows)) return null;
  const from = right ? gc.row : gc.col;
  const to = from + (right ? gc.rowSpan : gc.colSpan);
  const group = [gc];
  let end = -1;
  for (let i = from; i < to; i++) {
    const n = right ? grid.slots[i][at] : grid.slots[at]?.[i];
    if (!n) return null;
    if (group.includes(n)) continue;
    const nFrom = right ? n.row : n.col;
    const nTo = nFrom + (right ? n.rowSpan : n.colSpan);
    const nAt = right ? n.col : n.row;
    const nEnd = nAt + (right ? n.colSpan : n.rowSpan);
    if (nAt !== at || nFrom < from || nTo > to || (end !== -1 && nEnd !== end)) return null;
    if (roleOf(n.el) !== roleOf(gc.el)) return null;
    end = nEnd;
    group.push(n);
  }
  return end - (right ? gc.col : gc.row) <= MAX_SPAN ? { group, end } : null;
}

export function canMerge(table: HTMLTableElement, cell: HTMLTableCellElement, dir: MergeDirection): boolean {
  const grid = buildGrid(table);
  const gc = grid.of.get(cell);
  return !!gc && mergeGroup(grid, gc, dir) !== null;
}

const isBlankCell = (el: HTMLElement) => (el.textContent || "").replace(/​/g, "").trim() === "";
// A trailing <br> only holds an empty line open; joined to more text it would add a blank line.
function dropTrailingBreak(el: HTMLElement) {
  if (el.lastChild && el.lastChild.nodeName === "BR") el.lastChild.remove();
}

// Merges `cell` with its neighbors to the right (or below) into one cell covering their rectangle.
// Their content is joined in reading order, one cell per line, skipping empty ones. Returns false
// if that merge isn't possible (see mergeGroup).
export function mergeCells(table: HTMLTableElement, cell: HTMLTableCellElement, dir: MergeDirection): boolean {
  const grid = buildGrid(table);
  const gc = grid.of.get(cell);
  const merge = gc && mergeGroup(grid, gc, dir);
  if (!gc || !merge) return false;
  const others = grid.cells.filter((c) => c !== gc && merge.group.includes(c));
  if (isBlankCell(cell)) cell.innerHTML = "";
  others.forEach((o) => {
    if (isBlankCell(o.el)) return;
    dropTrailingBreak(cell);
    dropTrailingBreak(o.el);
    if (cell.hasChildNodes()) cell.appendChild(table.ownerDocument.createElement("br"));
    while (o.el.firstChild) cell.appendChild(o.el.firstChild);
  });
  if (!cell.hasChildNodes()) cell.innerHTML = "<br>";
  others.forEach((o) => o.el.remove());
  if (dir === "right") writeSpan(cell, "colspan", merge.end - gc.col);
  else writeSpan(cell, "rowspan", merge.end - gc.row);
  return true;
}

// Splits a merged cell back into single cells: its content stays in the top-left one, the rest are
// new empty cells of its color.
export function splitCell(table: HTMLTableElement, cell: HTMLTableCellElement): boolean {
  const doc = table.ownerDocument;
  const grid = buildGrid(table);
  const gc = grid.of.get(cell);
  if (!gc || (gc.rowSpan === 1 && gc.colSpan === 1)) return false;
  keepHeaders(table, () => {
    const rows = rowsOf(table);
    for (let r = gc.row; r < gc.row + gc.rowSpan; r++) {
      let prev: HTMLTableCellElement | null = r === gc.row ? cell : null;
      for (let c = gc.col; c < gc.col + gc.colSpan; c++) {
        if (r === gc.row && c === gc.col) continue;
        const filler = coloredCell(doc, cellColor(cell));
        if (prev) prev.after(filler);
        else placeInRow(grid, rows[r], r, c, filler);
        prev = filler;
      }
    }
    writeSpan(cell, "rowspan", 1);
    writeSpan(cell, "colspan", 1);
  });
  return true;
}

// Repairs a table into a full rectangle: rowspans cut to the rows that exist, holes left by short
// rows filled with empty cells, headers made consistent, set widths matched to the columns. Returns false if the table has no cells at
// all (the caller removes it).
export function normalizeTable(table: HTMLTableElement): boolean {
  const doc = table.ownerDocument;
  const grid = buildGrid(table);
  if (!grid.rows || !grid.cols) return false;
  keepHeaders(table, () => {
    // Rewrites spans as the grid read them: cut to the table, capped, and junk values dropped.
    grid.cells.forEach((gc) => {
      writeSpan(gc.el, "rowspan", gc.rowSpan);
      writeSpan(gc.el, "colspan", gc.colSpan);
    });
    const rows = rowsOf(table);
    rows.forEach((tr, r) => {
      for (let c = 0; c < grid.cols; c++) {
        if (grid.slots[r][c]) continue;
        const filler = newCell(doc, "TD");
        placeInRow(grid, tr, r, c, filler);
        // Later holes in this row go after this one.
        const gc: GridCell = { el: filler, row: r, col: c, rowSpan: 1, colSpan: 1 };
        grid.cells.push(gc);
        grid.slots[r][c] = gc;
      }
    });
  });
  normalizeWidths(table, grid.cols);
  return true;
}

// One colgroup, first, with a width for each column. Left untouched when it already is (this runs
// on every note that's opened).
function normalizeWidths(table: HTMLTableElement, cols: number) {
  const widths = colWidths(table);
  if (!widths) return;
  const fixed = widths.slice(0, cols);
  while (fixed.length < cols) fixed.push(NaN);
  const target = cleanWidths(fixed);
  const groups = colgroups(table);
  const ok =
    groups.length === 1 &&
    table.firstElementChild === groups[0] &&
    groups[0].children.length === cols &&
    Array.prototype.every.call(groups[0].children, (col: HTMLElement, i: number) =>
      col.tagName === "COL" && col.attributes.length === 1 && col.getAttribute("style") === `--col-w: ${target[i]}px;`
    );
  if (!ok) setColWidths(table, target);
}

// The table as rows × columns of text, for formats without merged cells (Markdown): a merged cell's
// text sits at its top-left position, the rest of its area is empty.
export function textMatrix(table: HTMLTableElement, text: (el: HTMLTableCellElement) => string): string[][] {
  const grid = buildGrid(table);
  const out = Array.from({ length: grid.rows }, () => Array.from({ length: grid.cols }, () => ""));
  grid.cells.forEach((gc) => {
    out[gc.row][gc.col] = text(gc.el);
  });
  return out;
}
