// Tables inside the note editor: the toolbar's table button (a size grid to insert one, or the
// table's options with the caret inside one), keyboard handling in cells, and keeping tables in a
// shape the rest of the editor understands. The structure itself is changed by tableModel.ts.
//
// A table is one top-level block (<table><tbody><tr><th|td>), so the editor's blockAt() returns the
// TABLE for anything inside it and its block commands leave it alone. Cells hold inline content only.
import type { ToolbarStrings } from "./i18n";
import { escapeHtml, flattenToInline } from "./markdown";
import { TRASH_ICON_PATH } from "./icons";
import { swatchesHtml } from "./palette";
import {
  type Axis,
  type Block,
  applyHeaders,
  blockOf,
  buildGrid,
  canMerge,
  cellAt as gridCellAt,
  cellColor,
  colWidths,
  createTable,
  deleteCol,
  deleteRow,
  evenWidths,
  hasHeaderCol,
  hasHeaderRow,
  insertCol,
  insertRow,
  lineCells,
  mergeCells,
  moveBlock,
  moveStep,
  moveTargets,
  normalizeTable,
  positionOf,
  setCellColor,
  setColWidths,
  splitCell,
} from "./tableModel";

// Largest table the size grid offers. Rows past that come from Tab in the last cell; the panel is
// too narrow for many more columns anyway.
const GRID_COLS = 6;
const GRID_ROWS = 6;

type TableAction =
  | "rowAbove" | "rowBelow" | "colLeft" | "colRight"
  | "rowUp" | "rowDown" | "colMoveLeft" | "colMoveRight"
  | "mergeRight" | "mergeDown" | "split"
  | "distribute" | "fitContent" | "fitFrame"
  | "deleteRow" | "deleteCol"
  | "headerRow" | "headerCol"
  | "deleteTable";
const ACTION_ICONS: Record<TableAction, string> = {
  rowAbove: '<rect x="2" y="8.5" width="12" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v4.6M5.7 4.1h4.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  rowBelow: '<rect x="2" y="2.5" width="12" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M8 9.6v4.6M5.7 11.9h4.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  colLeft: '<rect x="8.5" y="2" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M4.1 5.7v4.6M1.8 8h4.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  colRight: '<rect x="2.5" y="2" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M11.9 5.7v4.6M9.6 8h4.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  rowUp: '<rect x="2" y="9.5" width="12" height="4.5" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M8 7V2M5.8 4.2 8 2l2.2 2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  rowDown: '<rect x="2" y="2" width="12" height="4.5" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M8 9v5M5.8 11.8 8 14l2.2-2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  colMoveLeft: '<rect x="9.5" y="2" width="4.5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M7 8H2M4.2 5.8 2 8l2.2 2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  colMoveRight: '<rect x="2" y="2" width="4.5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M9 8h5M11.8 5.8 14 8l-2.2 2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  mergeRight: '<rect x="1.5" y="4" width="13" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 8h7M9.6 6.1 11.5 8l-1.9 1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  mergeDown: '<rect x="4" y="1.5" width="8" height="13" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.5v7M6.1 9.6 8 11.5l1.9-1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  split: '<rect x="1.5" y="4" width="13" height="8" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M8 4v8" stroke="currentColor" stroke-width="1.1" stroke-dasharray="1.6 1.4"/><path d="M5.8 6.6 4.4 8l1.4 1.4M10.2 6.6 11.6 8l-1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  distribute: '<rect x="1.5" y="3" width="13" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M5.8 3v10M10.2 3v10" stroke="currentColor" stroke-width="1.1"/><path d="M2.9 8h1.6M11.5 8h1.6M7.2 8h1.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  fitContent: '<rect x="1.5" y="3" width="13" height="10" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 3v10" stroke="currentColor" stroke-width="1.1"/><path d="M3.6 6.5h3.7M3.6 9.5h2.4M11.2 6.5h1.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  fitFrame: '<path d="M1.5 2.5v11M14.5 2.5v11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4 8h8M5.8 6.2 4 8l1.8 1.8M10.2 6.2 12 8l-1.8 1.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  deleteRow: '<rect x="2" y="2.5" width="12" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M6.2 10.2l3.6 3.6M9.8 10.2l-3.6 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  deleteCol: '<rect x="2.5" y="2" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M10.2 6.2l3.6 3.6M13.8 6.2l-3.6 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  headerRow: '<rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="2.5" width="12" height="3.8" rx="1.5" fill="currentColor"/><path d="M2 9.9h12M8 6.3v7.2" stroke="currentColor" stroke-width="1.1"/>',
  headerCol: '<rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="2.5" width="4.2" height="11" rx="1.5" fill="currentColor"/><path d="M6.2 8h7.8M10.1 2.5v11" stroke="currentColor" stroke-width="1.1"/>',
  deleteTable: TRASH_ICON_PATH,
};
type MenuItem = { action: TableAction; key: keyof ToolbarStrings };
// Things that can also be done with the mouse (dragging rows and columns, column borders) sit in
// submenus, to keep the menu short.
type Submenu = { submenu: string; key: keyof ToolbarStrings; icon: string; items: MenuItem[] };
// Menu order; null is a separator, "color" the cell color section.
const MENU: (MenuItem | Submenu | "color" | null)[] = [
  { action: "rowAbove", key: "tableRowAbove" },
  { action: "rowBelow", key: "tableRowBelow" },
  { action: "colLeft", key: "tableColLeft" },
  { action: "colRight", key: "tableColRight" },
  null,
  { action: "mergeRight", key: "tableMergeRight" },
  { action: "mergeDown", key: "tableMergeDown" },
  { action: "split", key: "tableSplit" },
  null,
  { action: "deleteRow", key: "tableDeleteRow" },
  { action: "deleteCol", key: "tableDeleteCol" },
  null,
  { action: "headerRow", key: "tableHeaderRow" },
  { action: "headerCol", key: "tableHeaderCol" },
  null,
  {
    submenu: "move",
    key: "tableMove",
    icon: '<path d="M8 1.8v12.4M1.8 8h12.4M6.2 3.6 8 1.8l1.8 1.8M6.2 12.4 8 14.2l1.8-1.8M3.6 6.2 1.8 8l1.8 1.8M12.4 6.2 14.2 8l-1.8 1.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    items: [
      { action: "rowUp", key: "tableRowUp" },
      { action: "rowDown", key: "tableRowDown" },
      { action: "colMoveLeft", key: "tableColMoveLeft" },
      { action: "colMoveRight", key: "tableColMoveRight" },
    ],
  },
  {
    submenu: "widths",
    key: "tableWidths",
    icon: '<path d="M2 2.5v11M14 2.5v11M8 2.5v11" stroke="currentColor" stroke-width="1.1"/><path d="M3.6 8h2.8M9.6 8h2.8M5 6.6 6.4 8 5 9.4M11 6.6 9.6 8l1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    items: [
      { action: "distribute", key: "tableDistribute" },
      { action: "fitContent", key: "tableFitContent" },
      { action: "fitFrame", key: "tableFitFrame" },
    ],
  },
  null,
  "color",
  null,
  { action: "deleteTable", key: "tableDelete" },
];

// What a cell color applies to: the selected cells, or every row / column they're in.
type ColorScope = "cell" | "row" | "col";
const COLOR_SCOPES: { scope: ColorScope; key: keyof ToolbarStrings }[] = [
  { scope: "cell", key: "tableColorCell" },
  { scope: "row", key: "tableColorRow" },
  { scope: "col", key: "tableColorCol" },
];

// The toolbar's table button, in the same dropdown shell as the color pickers. Its menu is either a
// grid of cells to pick a size from (hover or arrow keys to grow the highlight, click or Enter to
// insert; the header row counts as a row) or, with the caret inside a table, the table's options.
export function buildTablePicker(idPrefix: string, tb: ToolbarStrings): string {
  const icon = (paths: string, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 16 16" fill="none" aria-hidden="true">${paths}</svg>`;
  const item = (a: MenuItem) =>
    `<button type="button" class="table-action" data-table-action="${a.action}"${a.action === "headerRow" || a.action === "headerCol" ? ' aria-pressed="false"' : ""}>` +
    `${icon(ACTION_ICONS[a.action])}<span>${escapeHtml(tb[a.key] as string)}</span></button>`;
  const submenu = (m: Submenu) => {
    const id = `${idPrefix}TableSub-${m.submenu}`;
    return (
      `<button type="button" class="table-action table-submenu-btn" data-submenu aria-expanded="false" aria-controls="${id}">` +
      `${icon(m.icon)}<span>${escapeHtml(tb[m.key] as string)}</span>` +
      icon('<path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>', "table-submenu-chev") +
      `</button><div class="table-submenu" id="${id}" data-collapsed>${m.items.map(item).join("")}</div>`
    );
  };
  const scopes = COLOR_SCOPES.map(
    (c) => `<button type="button" data-color-scope="${c.scope}" aria-pressed="${c.scope === "cell"}">${escapeHtml(tb[c.key] as string)}</button>`
  ).join("");
  const color =
    `<div class="table-color" role="group" aria-label="${escapeHtml(tb.tableColor)}">` +
    `<span class="table-color-label" aria-hidden="true">${escapeHtml(tb.tableColor)}</span>` +
    `<div class="table-color-scope">${scopes}</div>` +
    `<div class="table-color-swatches" id="${idPrefix}TableColorSwatches">${swatchesHtml(tb.tableColor, tb.tableColorNone)}</div>` +
    `</div>`;
  const actions = MENU.map((e) =>
    e === null ? '<span class="table-actions-sep"></span>' : e === "color" ? color : "submenu" in e ? submenu(e) : item(e)
  ).join("");
  let cells = "";
  for (let r = 1; r <= GRID_ROWS; r++) {
    for (let c = 1; c <= GRID_COLS; c++) {
      cells += `<button type="button" class="table-grid-cell" data-rows="${r}" data-cols="${c}" tabindex="${r === 1 && c === 1 ? 0 : -1}" aria-label="${escapeHtml(tb.tableSize(c, r))}"></button>`;
    }
  }
  return (
    `<div class="pill-picker table-picker" id="${idPrefix}TablePicker">` +
    `<button type="button" class="pill-picker-btn" id="${idPrefix}TablePickerBtn" title="${tb.table}" aria-haspopup="true" aria-expanded="false">` +
    `<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.2h12M2 9.8h12M6 6.2v7.3M10 6.2v7.3" stroke="currentColor" stroke-width="1.1"/></svg>` +
    `</button>` +
    `<div class="pill-swatches table-menu" id="${idPrefix}TableMenu" hidden>` +
    `<div class="table-size" id="${idPrefix}TableSize">` +
    `<div class="table-grid" id="${idPrefix}TableGrid">${cells}</div>` +
    `<div class="table-grid-label" id="${idPrefix}TableGridLabel" aria-hidden="true">${escapeHtml(tb.tableSize(1, 1))}</div>` +
    `</div>` +
    `<div class="table-actions" id="${idPrefix}TableActions" hidden>${actions}</div>` +
    `</div>` +
    `</div>`
  );
}

// What the table code needs from the editor it lives in.
export interface TableEditorContext {
  surface: HTMLElement;
  idPrefix: string;
  toolbarStrings: () => ToolbarStrings;
  // The top-level block (direct child of surface) containing `node`.
  blockAt: (node: Node) => HTMLElement | null;
  placeCaretAtStart: (el: HTMLElement) => void;
  // Records an undo step before a change.
  pushHistory: () => void;
  // Records an undo step for typing, grouped with the keystrokes around it.
  noteTyping: () => void;
  // Puts loose content back into a paragraph if the surface was left with no block at all.
  ensureBlockWrapper: () => void;
  updateToolbarState: () => void;
}

export type TableEditor = ReturnType<typeof createTableEditor>;

export function createTableEditor(ctx: TableEditorContext) {
  const { surface, idPrefix } = ctx;
  const isBlankText = (s: string | null) => (s || "").replace(/​/g, "") === "";

  // A change made outside the browser's own editing: saved, counted, and reflected in the toolbar
  // like any typed edit.
  function afterEdit() {
    surface.dispatchEvent(new Event("input"));
    ctx.updateToolbarState();
  }

  function cellAt(node: Node | null): HTMLTableCellElement | null {
    if (!node) return null;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    const cell = el && el.closest ? (el.closest("td, th") as HTMLTableCellElement | null) : null;
    return cell && surface.contains(cell) ? cell : null;
  }
  // Either end of the selection inside a cell.
  function selectionInTable(): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    return !!(cellAt(r.startContainer) || cellAt(r.endContainer));
  }
  // The cell the selection starts in (where the table options act).
  function selectionCell(): HTMLTableCellElement | null {
    const sel = window.getSelection();
    return sel && sel.rangeCount ? cellAt(sel.getRangeAt(0).startContainer) : null;
  }
  // Every cell, in reading order.
  function tableCells(table: HTMLElement): HTMLTableCellElement[] {
    return Array.prototype.slice.call(table.querySelectorAll("td, th")) as HTMLTableCellElement[];
  }
  function caretToCellEnd(cell: HTMLElement) {
    const r = document.createRange();
    r.selectNodeContents(cell);
    r.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // A table at the very end of the note would leave nowhere to click or type after it, so it always
  // gets a line after it. Tables may sit right next to each other: Enter at the start of a table
  // opens a line above it (see handleEnter).
  function ensureTableExit() {
    const last = surface.lastElementChild;
    if (!last || last.tagName !== "TABLE") return;
    const p = document.createElement("p");
    p.innerHTML = "<br>";
    last.after(p);
  }

  // Pasted (or imported) tables can arrive in shapes the editor doesn't expect: inside a paragraph
  // or list (insertHTML puts them where the caret was), inside a cell, or ragged (a copied part of a
  // table). Tables are lifted out to the top level, splitting the block they were in; a table inside
  // a cell becomes its text; the rest is repaired by normalizeTable.
  function normalizeTables() {
    Array.prototype.slice.call(surface.querySelectorAll("table")).forEach((table: HTMLTableElement) => {
      if (!table.isConnected) return;
      const host = table.parentElement && table.parentElement.closest("td, th");
      if (host && surface.contains(host)) {
        const tmp = document.createElement("template");
        tmp.innerHTML = flattenToInline(table.outerHTML);
        table.replaceWith(tmp.content);
        return;
      }
      if (table.parentElement !== surface) {
        const b = ctx.blockAt(table);
        if (!b) return;
        const tail = document.createRange();
        tail.setStartAfter(table);
        tail.setEnd(b, b.childNodes.length);
        const after = b.cloneNode(false) as HTMLElement;
        after.appendChild(tail.extractContents());
        b.after(table);
        table.after(after);
        const isBlank = (el: HTMLElement) => (el.textContent || "").replace(/​/g, "").trim() === "" && !el.querySelector("hr, table");
        if (isBlank(after)) after.remove();
        if (isBlank(b)) b.remove();
      }
      if (!normalizeTable(table)) table.remove();
    });
    ensureTableExit();
  }

  // Inserts after the block the caret is in (after the whole list, for a list), or in place of an
  // empty paragraph — except the first one, so there's always a line above a table at the top.
  function insertTable(rows: number, cols: number) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer) || selectionInTable()) return;
    const table = createTable(document, rows, cols);
    const block = ctx.blockAt(range.startContainer);
    const emptyParagraph = !!block && block.tagName === "P" && isBlankText(block.textContent) && !block.querySelector("hr");
    if (block && emptyParagraph && block.previousElementSibling) block.replaceWith(table);
    else if (block) block.after(table);
    else surface.appendChild(table);
    ensureTableExit();
    ctx.placeCaretAtStart(tableCells(table)[0]);
  }

  // Removes the whole table, leaving the caret on the line after it (there always is one).
  function removeTable(table: HTMLElement) {
    const next = (table.nextElementSibling || table.previousElementSibling) as HTMLElement | null;
    table.remove();
    ctx.ensureBlockWrapper();
    if (next) ctx.placeCaretAtStart(next);
  }

  // ---------- cell colors ----------
  let colorScope: ColorScope = "cell";
  // The cells the selection touches in `cell`'s table (just `cell` for a caret), or every row /
  // column they're in.
  function colorTargets(cell: HTMLTableCellElement): HTMLTableCellElement[] {
    const table = cell.closest("table") as HTMLTableElement;
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const touched = range && !range.collapsed ? tableCells(table).filter((c) => range.intersectsNode(c)) : [];
    const picked = touched.length ? touched : [cell];
    if (colorScope === "cell") return picked;
    const all = new Set<HTMLTableCellElement>();
    picked.forEach((c) => lineCells(table, c, colorScope as "row" | "col").forEach((el) => all.add(el)));
    return tableCells(table).filter((c) => all.has(c));
  }
  // Marks the scope in use and the color the targets share (none marked if they differ).
  function showColorState(section: HTMLElement, cell: HTMLTableCellElement) {
    section.querySelectorAll("[data-color-scope]").forEach((b) => {
      b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.colorScope === colorScope));
    });
    const targets = colorTargets(cell);
    const shared = cellColor(targets[0]);
    const current = targets.every((c) => cellColor(c) === shared) ? shared : null;
    section.querySelectorAll(".table-color-swatches [data-color]").forEach((b) => {
      b.classList.toggle("on", (b as HTMLElement).dataset.color === current);
    });
  }

  // Moving rows and cells takes their nodes out of the document for a moment, which drops a
  // selection inside them; this puts it back where it was.
  function keepingSelection(change: () => void) {
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount ? ([sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] as const) : null;
    change();
    if (sel && saved && saved[0]?.isConnected && saved[2]?.isConnected) {
      sel.setBaseAndExtent(saved[0], saved[1], saved[2], saved[3]);
    }
  }
  // Moves the rows (columns) holding `index` one block back or forward; false if they can't go
  // that way.
  function stepBlock(table: HTMLTableElement, axis: Axis, index: number, dir: -1 | 1): boolean {
    const at = moveStep(table, axis, index, dir);
    if (at === null) return false;
    keepingSelection(() => moveBlock(table, axis, index, at));
    return true;
  }

  // Each action says where the caret goes (row, column, start or end of that cell): structural
  // changes can replace cells, so it's found again by position afterwards.
  function runTableAction(action: TableAction, cell: HTMLTableCellElement) {
    const table = cell.closest("table") as HTMLTableElement;
    const pos = positionOf(cell);
    if (!pos) return;
    let caret: [number, number, boolean] = [pos.row, pos.col, true];
    switch (action) {
      case "deleteTable":
        removeTable(table);
        return;
      case "rowAbove":
        insertRow(table, pos.row);
        caret = [pos.row, pos.col, false];
        break;
      // The caret stays in its cell, wherever that went.
      case "rowUp":
      case "rowDown":
        stepBlock(table, "row", pos.row, action === "rowUp" ? -1 : 1);
        return;
      case "colMoveLeft":
      case "colMoveRight":
        stepBlock(table, "col", pos.col, action === "colMoveLeft" ? -1 : 1);
        return;
      case "rowBelow":
        insertRow(table, pos.row + pos.rowSpan);
        caret = [pos.row + pos.rowSpan, pos.col, false];
        break;
      case "colLeft":
        insertCol(table, pos.col);
        caret = [pos.row, pos.col, false];
        break;
      case "colRight":
        insertCol(table, pos.col + pos.colSpan);
        caret = [pos.row, pos.col + pos.colSpan, false];
        break;
      case "deleteRow":
        if (!deleteRow(table, pos.row)) { removeTable(table); return; }
        caret = [Math.min(pos.row, table.rows.length - 1), pos.col, true];
        break;
      case "deleteCol":
        if (!deleteCol(table, pos.col)) { removeTable(table); return; }
        caret = [pos.row, Math.min(pos.col, buildGrid(table).cols - 1), true];
        break;
      case "mergeRight":
      case "mergeDown":
        mergeCells(table, cell, action === "mergeRight" ? "right" : "down");
        break;
      case "split":
        splitCell(table, cell);
        break;
      case "distribute":
        setColWidths(table, evenWidths(colWidths(table) || shownWidths(table)));
        break;
      case "fitContent":
        setColWidths(table, contentWidths(table));
        break;
      case "fitFrame":
        setColWidths(table, null);
        break;
      case "headerRow":
        applyHeaders(table, !hasHeaderRow(table), hasHeaderCol(table));
        break;
      case "headerCol":
        applyHeaders(table, hasHeaderRow(table), !hasHeaderCol(table));
        break;
    }
    const target = gridCellAt(table, caret[0], caret[1]);
    if (!target) return;
    if (caret[2]) caretToCellEnd(target);
    else ctx.placeCaretAtStart(target);
  }

  // ---------- column resizing ----------
  // Dragging the border at the right of a column sets that column's width (see setColWidths); the
  // columns after it move along, so the table grows or shrinks. A table still sized by content
  // starts from the widths it's shown at.
  const EDGE = 4;

  // The column border under the pointer: the table and the border's index (1 … columns; the one
  // before column 0 doesn't move). Found from what's under the pointer, not the event's target:
  // clicks after a press on a border go to the surface, which captured the pointer.
  function borderAt(ev: MouseEvent): { table: HTMLTableElement; border: number } | null {
    const cell = cellAt(document.elementFromPoint(ev.clientX, ev.clientY));
    if (!cell) return null;
    const rect = cell.getBoundingClientRect();
    const right = Math.abs(ev.clientX - rect.right) <= EDGE;
    if (!right && Math.abs(ev.clientX - rect.left) > EDGE) return null;
    const table = cell.closest("table") as HTMLTableElement;
    const grid = buildGrid(table);
    const gc = grid.of.get(cell);
    if (!gc) return null;
    const border = right ? gc.col + gc.colSpan : gc.col;
    return border > 0 && border <= grid.cols ? { table, border } : null;
  }

  // Where the columns' edges are on screen (edges[c]: where column c starts; the last one, where the
  // table ends), from where the cells' edges are. An edge no cell starts or ends at (every cell
  // crossing it is merged over it) is placed evenly between the known edges around it.
  function columnEdges(table: HTMLTableElement): number[] {
    const grid = buildGrid(table);
    const edges: (number | undefined)[] = Array(grid.cols + 1).fill(undefined);
    grid.cells.forEach((gc) => {
      const r = gc.el.getBoundingClientRect();
      if (edges[gc.col] === undefined) edges[gc.col] = r.left;
      if (edges[gc.col + gc.colSpan] === undefined) edges[gc.col + gc.colSpan] = r.right;
    });
    const box = table.getBoundingClientRect();
    if (edges[0] === undefined) edges[0] = box.left;
    if (edges[grid.cols] === undefined) edges[grid.cols] = box.right;
    for (let i = 1; i < grid.cols; i++) {
      if (edges[i] !== undefined) continue;
      let j = i + 1;
      while (edges[j] === undefined) j++;
      const a = edges[i - 1]!;
      edges[i] = a + (edges[j]! - a) / (j - i + 1);
    }
    return edges as number[];
  }
  // The widths the columns are shown at, in whole pixels, rounded up: set as widths, a fraction of a
  // pixel short would wrap a word that just fit.
  function shownWidths(table: HTMLTableElement): number[] {
    const edges = columnEdges(table);
    return edges.slice(1).map((e, i) => Math.ceil(e - edges[i] - 0.01));
  }

  // Lays out a hidden copy of the table, `width` wide, for `measure` to read sizes from, so the table
  // itself doesn't flicker. `prepare` sets the copy up first. The copy goes right next to the note:
  // it must inherit everything the note's tables do (the theme's variables sit on the panel, and
  // without --divider the cells would measure a border short).
  function measureCopy<T>(table: HTMLTableElement, width: number, prepare: (copy: HTMLTableElement) => void, measure: (copy: HTMLTableElement) => T): T {
    const probe = document.createElement("div");
    probe.className = "editor-surface";
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = `position:absolute; left:0; top:0; visibility:hidden; pointer-events:none; box-sizing:border-box; min-height:0; width:${width}px;`;
    const copy = table.cloneNode(true) as HTMLTableElement;
    prepare(copy);
    probe.appendChild(copy);
    surface.after(probe);
    try {
      return measure(copy);
    } finally {
      probe.remove();
    }
  }

  // The widths the columns take sized by their content: as much as their text needs, up to `width`
  // in all (the note's, by default; past that, text wraps the way it does in a table without set
  // widths). A tiny `width` gives each column's narrowest: its longest word.
  function contentWidths(table: HTMLTableElement, width = surface.clientWidth): number[] {
    return measureCopy(
      table,
      width,
      (copy) => {
        setColWidths(copy, null);
        // As wide as the content needs, not the note's full width.
        if (copy.tBodies[0]) copy.tBodies[0].style.width = "auto";
      },
      shownWidths
    );
  }

  // Double-click on a column's right border fits that column alone, keeping the others' widths: the
  // narrowest width at which its text adds no lines to any row, compared with the width it would
  // take on one line (at most the note's). A row already made taller by another cell lets its text
  // wrap into those lines; where its own text is the tallest, it keeps the lines it has at full
  // width. Never narrower than its longest word.
  function fitColumn(table: HTMLTableElement, col: number) {
    const style = getComputedStyle(surface);
    const room = surface.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const widths = colWidths(table) || shownWidths(table);
    let hi = Math.min(contentWidths(table, 100000)[col], room);
    let lo = Math.min(hi, contentWidths(table, 1)[col]);
    widths[col] = measureCopy(
      table,
      surface.clientWidth,
      (copy) => setColWidths(copy, widths),
      (copy) => {
        const colEl = copy.querySelector(":scope > colgroup")!.children[col] as HTMLElement;
        const heights = (w: number) => {
          colEl.style.setProperty("--col-w", w + "px");
          return Array.prototype.map.call(copy.rows, (r: HTMLElement) => r.getBoundingClientRect().height) as number[];
        };
        const goal = heights(hi);
        const fits = (w: number) => heights(w).every((h, i) => h <= goal[i] + 0.5);
        // Fewer lines never come from a narrower column, so the fitting widths are one range.
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (fits(mid)) hi = mid;
          else lo = mid + 1;
        }
        return hi;
      }
    );
    setColWidths(table, widths);
  }
  surface.addEventListener("dblclick", (ev) => {
    const hit = borderAt(ev);
    if (!hit) return;
    ev.preventDefault();
    ctx.pushHistory();
    fitColumn(hit.table, hit.border - 1);
    afterEdit();
  });

  let drag: { table: HTMLTableElement; border: number; startX: number; start: number[]; moved: boolean } | null = null;
  function setResizeCursor(state: "" | "hover" | "drag") {
    if (state) surface.setAttribute("data-col-resize", state);
    else surface.removeAttribute("data-col-resize");
  }
  surface.addEventListener("pointermove", (ev) => {
    if (!drag) {
      setResizeCursor(!ev.buttons && borderAt(ev) ? "hover" : "");
      return;
    }
    // A slip of the hand on a click isn't a resize (nor an undo step).
    if (!drag.moved && Math.abs(ev.clientX - drag.startX) < 2) return;
    if (!drag.moved) {
      drag.moved = true;
      ctx.pushHistory();
    }
    const widths = drag.start.slice();
    widths[drag.border - 1] += ev.clientX - drag.startX;
    setColWidths(drag.table, widths);
  });
  surface.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const hit = borderAt(ev);
    if (!hit) return;
    // Pointer capture keeps the drag going when the pointer leaves the table (or the panel).
    surface.setPointerCapture(ev.pointerId);
    drag = { ...hit, startX: ev.clientX, start: colWidths(hit.table) || shownWidths(hit.table), moved: false };
    setResizeCursor("drag");
  });
  // On a border, a press starts a resize instead of placing the caret or selecting text.
  surface.addEventListener("mousedown", (ev) => {
    if (drag) ev.preventDefault();
  });
  function endDrag(ev: PointerEvent) {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (surface.hasPointerCapture(ev.pointerId)) surface.releasePointerCapture(ev.pointerId);
    setResizeCursor(borderAt(ev) ? "hover" : "");
    if (moved) afterEdit();
  }
  surface.addEventListener("pointerup", endDrag);
  surface.addEventListener("pointercancel", endDrag);
  surface.addEventListener("pointerleave", () => {
    if (!drag) setResizeCursor("");
  });

  // ---------- dragging rows and columns ----------
  // Over a cell, grips show left of its row and above its column (of the whole block, when merged
  // cells join rows or columns; never for a header row or column, which stays first). Dragging one
  // shades what's moving and shows a line where it would go; dropping moves it there. Grips, shade
  // and line live in the scrolling box around the note, never in its content.
  const scroller = surface.parentElement as HTMLElement;
  const AXES: Axis[] = ["row", "col"];
  function overlay<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    el.className = className;
    el.hidden = true;
    scroller.appendChild(el);
    return el;
  }
  const DOTS = [2, 6.5, 11].flatMap((a) => [2, 6].map((b) => [a, b]));
  function makeGrip(axis: Axis): HTMLButtonElement {
    const g = overlay("button", "table-grip");
    g.type = "button";
    g.tabIndex = -1;
    g.dataset.axis = axis;
    // Keyboard and screen readers have "Mover" in the table menu and Alt+Shift+arrows instead.
    g.setAttribute("aria-hidden", "true");
    const [w, h] = axis === "row" ? [8, 14] : [14, 8];
    const dots = DOTS.map(([a, b]) => (axis === "row" ? `<circle cx="${b}" cy="${a + 0.5}" r="1.1"/>` : `<circle cx="${a + 0.5}" cy="${b}" r="1.1"/>`));
    g.innerHTML = `<svg viewBox="0 0 ${w} ${h}" fill="currentColor">${dots.join("")}</svg>`;
    return g;
  }
  const grips: Record<Axis, HTMLButtonElement> = { row: makeGrip("row"), col: makeGrip("col") };
  const shade = overlay("div", "table-drag-shade");
  const dropLine = overlay("div", "table-drop-line");

  const gripFor: Record<Axis, { table: HTMLTableElement; block: Block } | null> = { row: null, col: null };
  let moving: { axis: Axis; table: HTMLTableElement; block: Block; targets: number[]; at: number | null } | null = null;

  // Places an overlay at a viewport position, in the scroller's own coordinates (so it scrolls with
  // the note).
  function place(el: HTMLElement, left: number, top: number, width: number, height: number) {
    const box = scroller.getBoundingClientRect();
    el.style.left = left - box.left + scroller.scrollLeft + "px";
    el.style.top = top - box.top + scroller.scrollTop + "px";
    el.style.width = width + "px";
    el.style.height = height + "px";
  }
  // Where the rows (columns) start on screen; the last entry is where the table ends.
  function edges(table: HTMLTableElement, axis: Axis): number[] {
    if (axis === "col") return columnEdges(table);
    const rows = Array.prototype.slice.call(table.rows) as HTMLTableRowElement[];
    return rows.map((r) => r.getBoundingClientRect().top).concat([rows[rows.length - 1].getBoundingClientRect().bottom]);
  }
  // A block's area on screen, cut to what the table shows (a wide table scrolls sideways).
  function blockRect(table: HTMLTableElement, axis: Axis, block: Block) {
    const t = table.getBoundingClientRect();
    const e = edges(table, axis);
    return axis === "row"
      ? { left: t.left, right: t.right, top: e[block.start], bottom: e[block.end] }
      : { left: Math.max(t.left, e[block.start]), right: Math.min(t.right, e[block.end]), top: t.top, bottom: t.bottom };
  }

  function hideGrip(axis: Axis) {
    if (moving) return;
    grips[axis].hidden = true;
    gripFor[axis] = null;
  }
  const hideGrips = () => AXES.forEach(hideGrip);
  function showGrip(axis: Axis, table: HTMLTableElement, block: Block) {
    const now = gripFor[axis];
    if (now && now.table === table && now.block.start === block.start && now.block.end === block.end) return;
    const r = blockRect(table, axis, block);
    // A column scrolled out of view gets no grip.
    if (r.right - r.left < 4) return hideGrip(axis);
    const g = grips[axis];
    g.title = ctx.toolbarStrings()[axis === "row" ? "tableRowDrag" : "tableColDrag"];
    g.hidden = false;
    if (axis === "row") {
      const h = Math.min(20, r.bottom - r.top);
      place(g, r.left - 14, (r.top + r.bottom) / 2 - h / 2, 12, h);
    } else {
      const w = Math.min(20, r.right - r.left);
      place(g, (r.left + r.right) / 2 - w / 2, r.top - 14, w, 12);
    }
    gripFor[axis] = { table, block };
  }
  // On the way from the cell to a grip (across the margin left of the table, or the line above it)
  // that grip stays.
  function onWayToGrip(axis: Axis, ev: PointerEvent): boolean {
    const f = gripFor[axis];
    if (!f) return false;
    const r = blockRect(f.table, axis, f.block);
    return axis === "row"
      ? ev.clientY >= r.top && ev.clientY <= r.bottom && ev.clientX >= r.left - 16 && ev.clientX <= r.left
      : ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 16 && ev.clientY <= r.top;
  }
  surface.addEventListener("pointermove", (ev) => {
    if (moving || ev.buttons) return;
    const cell = cellAt(ev.target as Node);
    const pos = cell && positionOf(cell);
    AXES.forEach((axis) => {
      if (cell && pos) {
        const table = cell.closest("table") as HTMLTableElement;
        const index = axis === "row" ? pos.row : pos.col;
        const block = blockOf(table, axis, index);
        if (block && moveTargets(table, axis, index).length) showGrip(axis, table, block);
        else hideGrip(axis);
      } else if (!onWayToGrip(axis, ev)) {
        hideGrip(axis);
      }
    });
  });
  scroller.addEventListener("pointerleave", hideGrips);
  scroller.addEventListener("scroll", hideGrips);
  // A table scrolling sideways (scroll events don't bubble; capture sees them).
  surface.addEventListener("scroll", hideGrips, true);
  surface.addEventListener("input", hideGrips);
  surface.addEventListener("keydown", hideGrips);

  AXES.forEach((axis) => {
    const g = grips[axis];
    // Keeps the caret where it is: a grip isn't something to focus.
    g.addEventListener("mousedown", (ev) => ev.preventDefault());
    g.addEventListener("pointerdown", (ev) => {
      const f = gripFor[axis];
      if (ev.button !== 0 || !f) return;
      ev.preventDefault();
      g.setPointerCapture(ev.pointerId);
      moving = { axis, table: f.table, block: f.block, targets: moveTargets(f.table, axis, f.block.start), at: null };
      g.classList.add("dragging");
      // The other grip would only be in the way.
      grips[axis === "row" ? "col" : "row"].hidden = true;
      const r = blockRect(f.table, axis, f.block);
      shade.hidden = false;
      place(shade, r.left, r.top, r.right - r.left, r.bottom - r.top);
    });
    g.addEventListener("pointermove", (ev) => {
      if (!moving || moving.axis !== axis) return;
      const { table, block, targets } = moving;
      const p = axis === "row" ? ev.clientY : ev.clientX;
      // Near the edge of what's showing, the note (or a wide table) scrolls along.
      if (axis === "row") {
        const box = scroller.getBoundingClientRect();
        if (p < box.top + 24) scroller.scrollTop -= 10;
        else if (p > box.bottom - 24) scroller.scrollTop += 10;
      } else {
        const box = table.getBoundingClientRect();
        if (p < box.left + 24) table.scrollLeft -= 10;
        else if (p > box.right - 24) table.scrollLeft += 10;
      }
      // The closest edge wins; the block's own edges mean "no move".
      const e = edges(table, axis);
      let best = block.start;
      targets.concat([block.end]).forEach((at) => {
        if (Math.abs(e[at] - p) < Math.abs(e[best] - p)) best = at;
      });
      moving.at = targets.includes(best) ? best : null;
      dropLine.hidden = moving.at === null;
      if (moving.at !== null) {
        const t = table.getBoundingClientRect();
        dropLine.dataset.axis = axis;
        if (axis === "row") place(dropLine, t.left, e[moving.at], t.width, 2);
        else place(dropLine, Math.min(Math.max(e[moving.at], t.left), t.right), t.top, 2, t.height);
      }
      const r = blockRect(table, axis, block);
      place(shade, r.left, r.top, r.right - r.left, r.bottom - r.top);
    });
    const end = (ev: PointerEvent, drop: boolean) => {
      if (!moving || moving.axis !== axis) return;
      const { table, block, at } = moving;
      moving = null;
      if (g.hasPointerCapture(ev.pointerId)) g.releasePointerCapture(ev.pointerId);
      g.classList.remove("dragging");
      shade.hidden = true;
      dropLine.hidden = true;
      hideGrips();
      if (!drop || at === null || !table.isConnected) return;
      ctx.pushHistory();
      keepingSelection(() => moveBlock(table, axis, block.start, at));
      afterEdit();
    };
    g.addEventListener("pointerup", (ev) => end(ev, true));
    g.addEventListener("pointercancel", (ev) => end(ev, false));
  });

  // ---------- toolbar button ----------
  // Call before the editor wires the button's dropdown: the menu's content (size grid or options)
  // must be set before the dropdown measures the menu to place it.
  function wirePicker() {
    const btn = document.getElementById(idPrefix + "TablePickerBtn");
    const menu = document.getElementById(idPrefix + "TableMenu");
    const grid = document.getElementById(idPrefix + "TableGrid");
    const label = document.getElementById(idPrefix + "TableGridLabel");
    const sizeSection = document.getElementById(idPrefix + "TableSize");
    const actionsSection = document.getElementById(idPrefix + "TableActions");
    if (!btn || !menu || !grid || !label || !sizeSection || !actionsSection) return;
    const cells = Array.prototype.slice.call(grid.querySelectorAll(".table-grid-cell")) as HTMLElement[];
    const sizeOf = (el: HTMLElement): [number, number] => [Number(el.dataset.rows), Number(el.dataset.cols)];
    const cellOf = (target: EventTarget | null) =>
      target instanceof HTMLElement ? (target.closest(".table-grid-cell") as HTMLElement | null) : null;
    function highlight(rows: number, cols: number) {
      cells.forEach((c) => {
        const [r, k] = sizeOf(c);
        c.classList.toggle("on", r <= rows && k <= cols);
      });
      label!.textContent = ctx.toolbarStrings().tableSize(cols, rows);
    }
    // Back to whatever has keyboard focus in the grid (or the 1x1 start) once the pointer leaves.
    function highlightFocused() {
      const focused = cellOf(document.activeElement);
      if (focused && grid!.contains(focused)) highlight(...sizeOf(focused));
      else highlight(1, 1);
    }
    function closeMenu() {
      menu!.hidden = true;
      btn!.setAttribute("aria-expanded", "false");
    }
    function toggleSubmenu(b: HTMLElement, open: boolean) {
      b.setAttribute("aria-expanded", String(open));
      document.getElementById(b.getAttribute("aria-controls") || "")?.toggleAttribute("data-collapsed", !open);
    }

    btn.addEventListener("click", () => {
      if (!menu.hidden) return;
      const cell = selectionCell();
      sizeSection.hidden = !!cell;
      actionsSection.hidden = !cell;
      if (cell) {
        const table = cell.closest("table") as HTMLTableElement;
        const header = hasHeaderRow(table);
        ([["headerRow", header], ["headerCol", hasHeaderCol(table)]] as [string, boolean][]).forEach(([action, on]) => {
          const toggle = actionsSection.querySelector(`[data-table-action="${action}"]`)!;
          toggle.setAttribute("aria-pressed", String(on));
          toggle.classList.toggle("active", on);
        });
        const pos = positionOf(cell);
        const disable = (action: TableAction, off: boolean) => {
          (actionsSection.querySelector(`[data-table-action="${action}"]`) as HTMLButtonElement).disabled = off;
        };
        // Nothing goes above the header row.
        disable("rowAbove", header && pos?.row === 0);
        // Nor left of the header column.
        disable("colLeft", hasHeaderCol(table) && pos?.col === 0);
        disable("rowUp", !pos || moveStep(table, "row", pos.row, -1) === null);
        disable("rowDown", !pos || moveStep(table, "row", pos.row, 1) === null);
        disable("colMoveLeft", !pos || moveStep(table, "col", pos.col, -1) === null);
        disable("colMoveRight", !pos || moveStep(table, "col", pos.col, 1) === null);
        disable("mergeRight", !canMerge(table, cell, "right"));
        disable("mergeDown", !canMerge(table, cell, "down"));
        disable("split", !pos || (pos.rowSpan === 1 && pos.colSpan === 1));
        disable("fitFrame", !colWidths(table));
        showColorState(actionsSection, cell);
        actionsSection.querySelectorAll("[data-submenu]").forEach((b) => toggleSubmenu(b as HTMLElement, false));
      } else {
        highlight(1, 1);
        cells.forEach((c, i) => c.setAttribute("tabindex", i === 0 ? "0" : "-1"));
      }
    });
    actionsSection.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      // Opening a submenu (or switching color scope) keeps the menu open.
      const subBtn = target.closest("button[data-submenu]") as HTMLElement | null;
      if (subBtn) {
        ev.stopPropagation();
        toggleSubmenu(subBtn, subBtn.getAttribute("aria-expanded") !== "true");
        return;
      }
      const scopeBtn = target.closest("button[data-color-scope]") as HTMLElement | null;
      if (scopeBtn) {
        ev.stopPropagation();
        colorScope = scopeBtn.dataset.colorScope as ColorScope;
        const cell = selectionCell();
        if (cell) showColorState(actionsSection, cell);
        return;
      }
      const swatch = target.closest("button[data-color]") as HTMLElement | null;
      if (swatch) {
        ev.stopPropagation();
        closeMenu();
        const cell = selectionCell();
        if (!cell) return;
        ctx.pushHistory();
        surface.focus();
        colorTargets(cell).forEach((c) => setCellColor(c, swatch.dataset.color || ""));
        afterEdit();
        return;
      }
      const b = target.closest("button[data-table-action]") as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      ev.stopPropagation();
      closeMenu();
      const cell = selectionCell();
      if (!cell) return;
      ctx.pushHistory();
      surface.focus();
      runTableAction(b.dataset.tableAction as TableAction, cell);
      afterEdit();
    });
    grid.addEventListener("mouseover", (ev) => {
      const c = cellOf(ev.target);
      if (c) highlight(...sizeOf(c));
    });
    grid.addEventListener("mouseleave", highlightFocused);
    grid.addEventListener("focusin", (ev) => {
      const c = cellOf(ev.target);
      if (c) highlight(...sizeOf(c));
    });
    // One tab stop for the whole grid; arrow keys move within it.
    grid.addEventListener("keydown", (ev) => {
      const c = cellOf(ev.target);
      if (!c) return;
      let [r, k] = sizeOf(c);
      if (ev.key === "ArrowRight") k++;
      else if (ev.key === "ArrowLeft") k--;
      else if (ev.key === "ArrowDown") r++;
      else if (ev.key === "ArrowUp") r--;
      else return;
      ev.preventDefault();
      r = Math.min(Math.max(r, 1), GRID_ROWS);
      k = Math.min(Math.max(k, 1), GRID_COLS);
      const next = cells[(r - 1) * GRID_COLS + (k - 1)];
      cells.forEach((cell) => cell.setAttribute("tabindex", cell === next ? "0" : "-1"));
      next.focus();
    });
    grid.addEventListener("click", (ev) => {
      const c = cellOf(ev.target);
      if (!c) return;
      ev.stopPropagation();
      closeMenu();
      ctx.pushHistory();
      surface.focus();
      insertTable(...sizeOf(c));
      afterEdit();
    });
  }
  // In a table, the table button opens the table's options instead of the size grid.
  function updateToolbarButton(inTable: boolean) {
    const btn = document.getElementById(idPrefix + "TablePickerBtn");
    if (!btn) return;
    btn.classList.toggle("active", inTable);
    btn.title = inTable ? ctx.toolbarStrings().tableOptions : ctx.toolbarStrings().table;
  }

  // ---------- keys ----------
  // Tab / Shift+Tab: next / previous cell; Tab in the last cell adds a row.
  function handleTab(ev: KeyboardEvent): boolean {
    if (ev.key !== "Tab" || ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    const cell = cellAt(window.getSelection()?.anchorNode ?? null);
    if (!cell) return false;
    ev.preventDefault();
    const table = cell.closest("table") as HTMLTableElement;
    const cells = tableCells(table);
    const i = cells.indexOf(cell);
    if (ev.shiftKey) {
      if (i > 0) caretToCellEnd(cells[i - 1]);
    } else if (i < cells.length - 1) {
      caretToCellEnd(cells[i + 1]);
    } else {
      ctx.pushHistory();
      const at = table.rows.length;
      insertRow(table, at);
      const first = gridCellAt(table, at, 0);
      if (first) ctx.placeCaretAtStart(first);
      surface.dispatchEvent(new Event("input"));
    }
    ctx.updateToolbarState();
    return true;
  }
  // Alt+Shift+arrows in a cell: Up/Down move its row, Left/Right its column (the whole block).
  const MOVE_KEYS: Record<string, [Axis, -1 | 1]> = {
    ArrowUp: ["row", -1],
    ArrowDown: ["row", 1],
    ArrowLeft: ["col", -1],
    ArrowRight: ["col", 1],
  };
  function handleMoveKeys(ev: KeyboardEvent): boolean {
    if (!ev.altKey || !ev.shiftKey || ev.ctrlKey || ev.metaKey || !MOVE_KEYS[ev.key]) return false;
    const cell = cellAt(window.getSelection()?.anchorNode ?? null);
    const pos = cell && positionOf(cell);
    if (!cell || !pos) return false;
    ev.preventDefault();
    const table = cell.closest("table") as HTMLTableElement;
    const [axis, dir] = MOVE_KEYS[ev.key];
    const index = axis === "row" ? pos.row : pos.col;
    if (moveStep(table, axis, index, dir) === null) return true;
    ctx.pushHistory();
    stepBlock(table, axis, index, dir);
    afterEdit();
    return true;
  }
  // Enter in a cell is a line break within it, never a new paragraph (cells hold no blocks). The
  // exception is the very start of a table with no line above it (at the top of the note, or right
  // after another table): there it opens an empty line above the table, as in word processors.
  function handleEnter(ev: KeyboardEvent): boolean {
    if (ev.key !== "Enter" || ev.ctrlKey || ev.metaKey) return false;
    const sel = window.getSelection();
    const cell = cellAt(sel?.anchorNode ?? null);
    if (!cell) return false;
    ev.preventDefault();
    if (openLineAbove(sel!, cell)) return true;
    ctx.noteTyping();
    document.execCommand("insertLineBreak");
    return true;
  }
  function openLineAbove(sel: Selection, cell: HTMLElement): boolean {
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const table = cell.closest("table") as HTMLElement | null;
    if (!table || table.parentElement !== surface || tableCells(table)[0] !== cell) return false;
    const above = table.previousElementSibling;
    if (above && above.tagName !== "TABLE") return false;
    const r = sel.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(cell);
    before.setEnd(r.startContainer, r.startOffset);
    if (!isBlankText(before.toString()) || before.cloneContents().querySelector("br")) return false;
    ctx.pushHistory();
    const p = document.createElement("p");
    p.innerHTML = "<br>";
    table.before(p);
    ctx.placeCaretAtStart(p);
    surface.dispatchEvent(new Event("input"));
    ctx.updateToolbarState();
    return true;
  }
  // Keeps Backspace/Delete from merging text into or out of a table (Chrome would pull the next
  // paragraph into the last cell, or a cell's text into the line above): at a cell's edge they do
  // nothing; at the edge of a block next to a table they step into the table instead, removing the
  // block if it was an empty line (as long as the table keeps a line after it).
  function handleEdgeKeys(ev: KeyboardEvent): boolean {
    if (ev.key !== "Backspace" && ev.key !== "Delete") return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    const back = ev.key === "Backspace";
    const cell = cellAt(r.startContainer);
    const container = cell || ctx.blockAt(r.startContainer);
    if (!container) return false;
    const edge = document.createRange();
    edge.selectNodeContents(container);
    if (back) edge.setEnd(r.startContainer, r.startOffset);
    else edge.setStart(r.startContainer, r.startOffset);
    if (!isBlankText(edge.toString())) return false;
    if (cell) {
      // A line break between the caret and the cell's edge is a blank line the key may remove. A
      // trailing <br> doesn't count: it only holds the cell's last line open.
      let last: Node | null = cell;
      while (last.lastChild) last = last.lastChild;
      const breaks = edge.cloneContents().querySelectorAll("br").length;
      const placeholder = last.nodeName === "BR" && edge.intersectsNode(last) ? 1 : 0;
      if (breaks > placeholder) return false;
      ev.preventDefault();
      return true;
    }
    const neighbor = back ? container.previousElementSibling : container.nextElementSibling;
    if (!neighbor || neighbor.tagName !== "TABLE") return false;
    ev.preventDefault();
    const cells = tableCells(neighbor as HTMLElement);
    const isEmpty = isBlankText(container.textContent) && !container.querySelector("hr, ul, ol");
    const removable = isEmpty && (back ? !!container.nextElementSibling : !!container.previousElementSibling);
    if (removable) {
      ctx.pushHistory();
      container.remove();
    }
    if (back) caretToCellEnd(cells[cells.length - 1]);
    else ctx.placeCaretAtStart(cells[0]);
    if (removable) surface.dispatchEvent(new Event("input"));
    ctx.updateToolbarState();
    return true;
  }

  return {
    cellAt,
    selectionInTable,
    selectionCell,
    tableCells,
    ensureTableExit,
    normalizeTables,
    wirePicker,
    updateToolbarButton,
    handleTab,
    handleEnter,
    handleEdgeKeys,
    handleMoveKeys,
  };
}
