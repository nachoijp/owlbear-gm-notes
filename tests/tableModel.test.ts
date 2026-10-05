import { describe, expect, it } from "vitest";
import {
  applyHeaders,
  blocks,
  buildGrid,
  canMerge,
  cellAt,
  cellColor,
  cleanWidths,
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
  textMatrix,
} from "../src/tableModel";

// Builds a table from rows of cell specs: "A" a <td>, "*A" a header-row <th>, "#A" a header-column
// <th>, with optional "/r2" (rowspan) and "/c2" (colspan) suffixes, e.g. "A/r2/c2".
function table(rows: string[][]): HTMLTableElement {
  const t = document.createElement("table");
  const body = document.createElement("tbody");
  t.appendChild(body);
  rows.forEach((cells) => {
    const tr = document.createElement("tr");
    cells.forEach((spec) => {
      const [head, ...mods] = spec.split("/");
      const th = head.startsWith("*") || head.startsWith("#");
      const el = document.createElement(th ? "th" : "td");
      if (th) el.setAttribute("scope", head.startsWith("*") ? "col" : "row");
      el.textContent = th ? head.slice(1) : head;
      mods.forEach((m) => el.setAttribute(m[0] === "r" ? "rowspan" : "colspan", m.slice(1)));
      tr.appendChild(el);
    });
    body.appendChild(tr);
  });
  return t;
}

// The table back in the same notation (empty cells as "_"), to compare whole tables at once.
function shape(t: HTMLTableElement): string[][] {
  return Array.from(t.rows).map((tr) =>
    Array.from(tr.cells).map((el) => {
      const prefix = el.tagName === "TH" ? (el.getAttribute("scope") === "row" ? "#" : "*") : "";
      let s = prefix + (el.textContent || "_");
      if (el.getAttribute("rowspan")) s += "/r" + el.getAttribute("rowspan");
      if (el.getAttribute("colspan")) s += "/c" + el.getAttribute("colspan");
      return s;
    })
  );
}

describe("buildGrid", () => {
  it("places plain cells", () => {
    const g = buildGrid(table([["A", "B"], ["C", "D"]]));
    expect([g.rows, g.cols]).toEqual([2, 2]);
    expect(g.slots[1][1]!.el.textContent).toBe("D");
  });

  it("skips positions covered by merged cells", () => {
    //  A A B
    //  A A C
    //  D E F
    const g = buildGrid(table([["A/r2/c2", "B"], ["C"], ["D", "E", "F"]]));
    expect(g.cols).toBe(3);
    expect(g.slots[1][0]!.el.textContent).toBe("A");
    expect(g.slots[1][2]!.el.textContent).toBe("C");
    const c = g.cells.find((x) => x.el.textContent === "C")!;
    expect([c.row, c.col]).toEqual([1, 2]);
  });

  it("cuts a rowspan reaching past the last row", () => {
    const g = buildGrid(table([["A/r5", "B"], ["C"]]));
    expect(g.cells[0].rowSpan).toBe(2);
  });

  it("caps absurd spans and ignores junk ones", () => {
    const g = buildGrid(table([["A/c999", "B/rabc"]]));
    expect(g.cells[0].colSpan).toBe(50);
    expect(g.cells[1].rowSpan).toBe(1);
  });
});

describe("createTable", () => {
  it("makes a header row", () => {
    const t = createTable(document, 3, 2);
    expect(shape(t).map((r) => r.map((c) => c[0]))).toEqual([["*", "*"], ["_", "_"], ["_", "_"]]);
    expect(hasHeaderRow(t)).toBe(true);
    expect(hasHeaderCol(t)).toBe(false);
  });
});

describe("headers", () => {
  it("treats a th without scope as a header-row cell (older tables)", () => {
    const t = table([["A", "B"], ["C", "D"]]);
    const th = document.createElement("th");
    th.textContent = "X";
    t.rows[0].cells[0].replaceWith(th);
    expect(hasHeaderRow(t)).toBe(true);
  });

  it("gives the corner to the header row when both are on", () => {
    const t = table([["A", "B"], ["C", "D"]]);
    applyHeaders(t, true, true);
    expect(shape(t)).toEqual([["*A", "*B"], ["#C", "D"]]);
    applyHeaders(t, false, true);
    expect(shape(t)).toEqual([["#A", "B"], ["#C", "D"]]);
    expect(hasHeaderRow(t)).toBe(false);
    expect(hasHeaderCol(t)).toBe(true);
  });

  it("keeps content and spans when retagging", () => {
    const t = table([["A/c2"], ["C", "D"]]);
    t.rows[0].cells[0].innerHTML = "<b>bold</b>";
    applyHeaders(t, true, false);
    expect(t.rows[0].cells[0].outerHTML).toBe('<th colspan="2" scope="col"><b>bold</b></th>');
  });
});

describe("insertRow", () => {
  it("adds a row of empty cells", () => {
    const t = table([["*A", "*B"], ["C", "D"]]);
    insertRow(t, 1);
    expect(shape(t)).toEqual([["*A", "*B"], ["_", "_"], ["C", "D"]]);
  });

  it("adds at the end", () => {
    const t = table([["A", "B"]]);
    insertRow(t, 1);
    expect(shape(t)).toEqual([["A", "B"], ["_", "_"]]);
  });

  it("grows a merged cell crossing the new row instead of adding a cell under it", () => {
    const t = table([["A/r2", "B"], ["C"]]);
    insertRow(t, 1);
    expect(shape(t)).toEqual([["A/r3", "B"], ["_"], ["C"]]);
  });

  it("adds cells under a merged cell that ends right there", () => {
    const t = table([["A/r2", "B"], ["C"]]);
    insertRow(t, 2);
    expect(shape(t)).toEqual([["A/r2", "B"], ["C"], ["_", "_"]]);
  });

  it("starts new rows with a header cell when the header column is on", () => {
    const t = table([["*A", "*B"], ["#C", "D"]]);
    insertRow(t, 2);
    expect(shape(t)[2]).toEqual(["#_", "_"]);
  });
});

describe("insertCol", () => {
  it("adds a column of empty cells, header cell on top", () => {
    const t = table([["*A", "*B"], ["C", "D"]]);
    insertCol(t, 1);
    expect(shape(t)).toEqual([["*A", "*_", "*B"], ["C", "_", "D"]]);
  });

  it("adds at both ends", () => {
    const t = table([["A"], ["B"]]);
    insertCol(t, 0);
    insertCol(t, 2);
    expect(shape(t)).toEqual([["_", "A", "_"], ["_", "B", "_"]]);
  });

  it("grows a merged cell crossing the new column", () => {
    const t = table([["A/c2"], ["B", "C"]]);
    insertCol(t, 1);
    expect(shape(t)).toEqual([["A/c3"], ["B", "_", "C"]]);
  });

  it("puts the new cell in the right place next to a cell merged from above", () => {
    //  A B C        A B _ C
    //  A D E   ->   A D _ E
    const t = table([["A/r2", "B", "C"], ["D", "E"]]);
    insertCol(t, 2);
    expect(shape(t)).toEqual([["A/r2", "B", "_", "C"], ["D", "_", "E"]]);
  });

  it("keeps the header column first when a column is added before it", () => {
    const t = table([["#A", "B"], ["#C", "D"]]);
    insertCol(t, 0);
    expect(shape(t)).toEqual([["#_", "A", "B"], ["#_", "C", "D"]]);
  });
});

describe("deleteRow", () => {
  it("removes a row", () => {
    const t = table([["A"], ["B"], ["C"]]);
    expect(deleteRow(t, 1)).toBe(true);
    expect(shape(t)).toEqual([["A"], ["C"]]);
  });

  it("reports an emptied table", () => {
    expect(deleteRow(table([["A", "B"]]), 0)).toBe(false);
  });

  it("shrinks a merged cell covering the row", () => {
    const t = table([["A/r3", "B"], ["C"], ["D"]]);
    deleteRow(t, 1);
    expect(shape(t)).toEqual([["A/r2", "B"], ["D"]]);
  });

  it("moves a merged cell that starts in the deleted row down, in column order", () => {
    //  X Y Z        Q A R
    //  Q A R   <- deleting row 0 when A starts there:
    const t = table([["X", "A/r2", "Z"], ["Q", "R"]]);
    deleteRow(t, 0);
    expect(shape(t)).toEqual([["Q", "A", "R"]]);
  });

  it("deleting the header row leaves no header row", () => {
    const t = table([["*A", "*B"], ["C", "D"], ["E", "F"]]);
    deleteRow(t, 0);
    expect(shape(t)).toEqual([["C", "D"], ["E", "F"]]);
    expect(hasHeaderRow(t)).toBe(false);
  });
});

describe("deleteCol", () => {
  it("removes a column", () => {
    const t = table([["A", "B", "C"], ["D", "E", "F"]]);
    expect(deleteCol(t, 1)).toBe(true);
    expect(shape(t)).toEqual([["A", "C"], ["D", "F"]]);
  });

  it("reports an emptied table", () => {
    expect(deleteCol(table([["A"], ["B"]]), 0)).toBe(false);
  });

  it("shrinks a merged cell covering the column", () => {
    const t = table([["A/c3"], ["B", "C", "D"]]);
    deleteCol(t, 1);
    expect(shape(t)).toEqual([["A/c2"], ["B", "D"]]);
  });

  it("makes the next column the header column when the first is deleted", () => {
    const t = table([["#A", "B"], ["#C", "D"]]);
    deleteCol(t, 0);
    expect(shape(t)).toEqual([["#B"], ["#D"]]);
  });
});

describe("normalizeTable", () => {
  it("pads short rows", () => {
    const t = table([["A", "B", "C"], ["D"]]);
    expect(normalizeTable(t)).toBe(true);
    expect(shape(t)).toEqual([["A", "B", "C"], ["D", "_", "_"]]);
  });

  it("fills a hole left between merged cells", () => {
    //  A A B       A A B
    //  C           C _ _   (the merge only covers row 0 here)
    const t = table([["A/c2", "B"], ["C"]]);
    normalizeTable(t);
    expect(shape(t)).toEqual([["A/c2", "B"], ["C", "_", "_"]]);
  });

  it("cuts rowspans to the table and fixes junk spans", () => {
    const t = table([["A/r9", "B/cxyz"], ["C"]]);
    normalizeTable(t);
    expect(shape(t)).toEqual([["A/r2", "B"], ["C"]]);
  });

  it("makes headers consistent", () => {
    const t = table([["*A", "B"], ["C", "D"]]);
    normalizeTable(t);
    expect(shape(t)).toEqual([["*A", "*B"], ["C", "D"]]);
  });

  it("reports a table with no cells", () => {
    const t = document.createElement("table");
    expect(normalizeTable(t)).toBe(false);
  });
});

describe("positions", () => {
  it("finds cells by position and positions by cell", () => {
    const t = table([["A/r2", "B"], ["C"]]);
    document.body.appendChild(t);
    expect(cellAt(t, 1, 0)!.textContent).toBe("A");
    expect(cellAt(t, 1, 1)!.textContent).toBe("C");
    const pos = positionOf(t.rows[1].cells[0])!;
    expect([pos.row, pos.col]).toEqual([1, 1]);
    t.remove();
  });
});

describe("textMatrix", () => {
  it("puts a merged cell's text at its top-left, empty elsewhere", () => {
    const t = table([["A/r2/c2", "B"], ["C"], ["D", "E", "F"]]);
    expect(textMatrix(t, (el) => el.textContent || "")).toEqual([
      ["A", "", "B"],
      ["", "", "C"],
      ["D", "E", "F"],
    ]);
  });
});

describe("mergeCells", () => {
  const first = (t: HTMLTableElement) => t.rows[0].cells[0];

  it("merges with the cell to the right, joining their text by lines", () => {
    const t = table([["A", "B", "C"], ["D", "E", "F"]]);
    expect(mergeCells(t, first(t), "right")).toBe(true);
    expect(shape(t)).toEqual([["AB/c2", "C"], ["D", "E", "F"]]);
    expect(first(t).innerHTML).toBe("A<br>B");
  });

  it("merges with the cell below", () => {
    const t = table([["A", "B"], ["C", "D"]]);
    expect(mergeCells(t, t.rows[0].cells[1], "down")).toBe(true);
    expect(shape(t)).toEqual([["A", "BD/r2"], ["C"]]);
  });

  it("takes in every cell along that side when the cell is already merged", () => {
    const t = table([["A/r2", "B"], ["C"]]);
    expect(mergeCells(t, first(t), "right")).toBe(true);
    expect(shape(t)).toEqual([["ABC/r2/c2"], []]);
    expect(buildGrid(t).slots[1][1]?.el).toBe(first(t));
  });

  it("grows by a whole merged neighbor", () => {
    const t = table([["A", "B/c2"], ["C", "D", "E"]]);
    mergeCells(t, first(t), "right");
    expect(shape(t)).toEqual([["AB/c3"], ["C", "D", "E"]]);
  });

  it("skips empty cells and keeps no placeholder line breaks", () => {
    const t = table([["", "", "C"]]);
    t.rows[0].cells[0].innerHTML = "<br>";
    t.rows[0].cells[1].innerHTML = "<br>";
    mergeCells(t, first(t), "right");
    mergeCells(t, first(t), "right");
    expect(first(t).innerHTML).toBe("C");
    const u = table([["", ""]]);
    u.rows[0].cells[0].innerHTML = "<b>x</b><br>";
    u.rows[0].cells[1].innerHTML = "y<br>";
    mergeCells(u, first(u), "right");
    expect(first(u).innerHTML).toBe("<b>x</b><br>y");
  });

  it("leaves an empty merge with a line to type on", () => {
    const t = table([["", ""]]);
    mergeCells(t, first(t), "right");
    expect(first(t).innerHTML).toBe("<br>");
  });

  it("refuses a merge that wouldn't be a rectangle", () => {
    // B covers two rows, A only one.
    const t = table([["A", "B/r2"], ["C"]]);
    expect(canMerge(t, first(t), "right")).toBe(false);
    expect(mergeCells(t, first(t), "right")).toBe(false);
    expect(shape(t)).toEqual([["A", "B/r2"], ["C"]]);
    // The cells to the right of A/r2 end at different columns.
    const u = table([["A/r2", "B", "C"], ["D/c2"]]);
    expect(canMerge(u, first(u), "right")).toBe(false);
  });

  it("refuses at the table's edge", () => {
    const t = table([["A", "B"], ["C", "D"]]);
    expect(canMerge(t, t.rows[0].cells[1], "right")).toBe(false);
    expect(canMerge(t, t.rows[1].cells[0], "down")).toBe(false);
  });

  it("never mixes headers with the body", () => {
    const t = table([["*A", "*B"], ["#C", "D"], ["#E", "F"]]);
    expect(canMerge(t, first(t), "right")).toBe(true);
    expect(canMerge(t, first(t), "down")).toBe(false);
    expect(canMerge(t, t.rows[1].cells[0], "right")).toBe(false);
    expect(canMerge(t, t.rows[1].cells[0], "down")).toBe(true);
    expect(canMerge(t, t.rows[1].cells[1], "down")).toBe(true);
  });
});

describe("splitCell", () => {
  it("splits back into single cells, keeping the content in the first", () => {
    const t = table([["A/r2/c2", "B"], ["C"], ["D", "E", "F"]]);
    expect(splitCell(t, t.rows[0].cells[0])).toBe(true);
    expect(shape(t)).toEqual([["A", "_", "B"], ["_", "_", "C"], ["D", "E", "F"]]);
  });

  it("keeps the header roles of the cells it adds", () => {
    const t = table([["*A/c2", "*B"], ["C", "D", "E"]]);
    splitCell(t, t.rows[0].cells[0]);
    expect(shape(t)[0]).toEqual(["*A", "*_", "*B"]);
  });

  it("undoes a merge", () => {
    const t = table([["A", "B"], ["C", "D"]]);
    mergeCells(t, t.rows[0].cells[0], "down");
    splitCell(t, t.rows[0].cells[0]);
    expect(shape(t)).toEqual([["AC", "B"], ["_", "D"]]);
  });

  it("does nothing to a single cell", () => {
    const t = table([["A"]]);
    expect(splitCell(t, t.rows[0].cells[0])).toBe(false);
  });
});

describe("cell colors", () => {
  const paint = (t: HTMLTableElement, color: string, ...at: [number, number][]) =>
    at.forEach(([r, c]) => setCellColor(cellAt(t, r, c)!, color));
  const colors = (t: HTMLTableElement) => Array.from(t.rows).map((tr) => Array.from(tr.cells).map((el) => cellColor(el) || "-"));

  it("sets and clears a color, leaving no empty style behind", () => {
    const t = table([["A"]]);
    const el = t.rows[0].cells[0];
    setCellColor(el, "#e04f4f");
    expect(el.getAttribute("style")).toBe("--cell-c: #e04f4f;");
    setCellColor(el, "");
    expect(el.hasAttribute("style")).toBe(false);
  });

  it("finds every cell crossing a row or column, merged ones included", () => {
    const t = table([["A/r2", "B", "C"], ["D/c2"], ["E", "F", "G"]]);
    const text = (els: HTMLTableCellElement[]) => els.map((el) => el.textContent);
    expect(text(lineCells(t, cellAt(t, 1, 1)!, "row"))).toEqual(["A", "D"]);
    expect(text(lineCells(t, cellAt(t, 0, 2)!, "col"))).toEqual(["C", "D", "G"]);
    // A merged cell's line is every row it covers.
    expect(text(lineCells(t, cellAt(t, 0, 0)!, "row"))).toEqual(["A", "B", "C", "D"]);
  });

  it("gives a new row the color of each column whose cells all share one", () => {
    const t = table([["*A", "*B"], ["C", "D"], ["E", "F"]]);
    paint(t, "#4caf72", [1, 0], [2, 0]);
    paint(t, "#e04f4f", [0, 0]);
    paint(t, "#3f8ce0", [1, 1]);
    insertRow(t, 3);
    // Column 0: the header's own color doesn't count. Column 1: mixed.
    expect(colors(t)[3]).toEqual(["#4caf72", "-"]);
  });

  it("gives a new column the color of each row whose cells all share one", () => {
    const t = table([["*A", "*B"], ["C", "D"]]);
    paint(t, "#d6b214", [0, 0], [0, 1]);
    insertCol(t, 1);
    expect(colors(t)).toEqual([["#d6b214", "#d6b214", "#d6b214"], ["-", "-", "-"]]);
  });

  it("doesn't take a header column's color into a new column", () => {
    const t = table([["#A", "B"], ["#C", "D"]]);
    paint(t, "#e04f4f", [0, 0], [1, 0]);
    insertCol(t, 2);
    expect(colors(t)).toEqual([["#e04f4f", "-", "-"], ["#e04f4f", "-", "-"]]);
  });

  it("keeps a cell's color through header changes and splits", () => {
    const t = table([["A/c2", "B"], ["C", "D", "E"]]);
    paint(t, "#7c5cff", [0, 0]);
    applyHeaders(t, true, false);
    expect(cellColor(t.rows[0].cells[0])).toBe("#7c5cff");
    splitCell(t, t.rows[0].cells[0]);
    expect(colors(t)[0]).toEqual(["#7c5cff", "#7c5cff", "-"]);
  });
});

describe("column widths", () => {
  it("cleans widths: whole pixels within limits, junk as the average", () => {
    expect(cleanWidths([100.4, 10, 5000])).toEqual([100, 40, 2000]);
    expect(cleanWidths([NaN, 100, 0, 200])).toEqual([150, 100, 150, 200]);
    expect(cleanWidths([NaN])).toEqual([120]);
  });

  it("writes one colgroup first, and removes it to go back to filling the note", () => {
    const t = table([["A", "B"]]);
    setColWidths(t, [80, 150]);
    expect(t.firstElementChild!.outerHTML).toBe('<colgroup><col style="--col-w: 80px;"><col style="--col-w: 150px;"></colgroup>');
    expect(colWidths(t)).toEqual([80, 150]);
    setColWidths(t, null);
    expect(colWidths(t)).toBe(null);
    expect(t.querySelector("colgroup")).toBe(null);
  });

  it("evens widths out keeping the total", () => {
    expect(evenWidths([100, 200, 300])).toEqual([200, 200, 200]);
  });

  it("gives an inserted column the average width, growing the table", () => {
    const t = table([["A", "B"]]);
    setColWidths(t, [100, 200]);
    insertCol(t, 1);
    expect(colWidths(t)).toEqual([100, 150, 200]);
  });

  it("drops a deleted column's width, shrinking the table", () => {
    const t = table([["A", "B", "C"]]);
    setColWidths(t, [100, 200, 300]);
    deleteCol(t, 1);
    expect(colWidths(t)).toEqual([100, 300]);
  });

  it("leaves a table without set widths without a colgroup", () => {
    const t = table([["A", "B"]]);
    insertCol(t, 2);
    deleteCol(t, 0);
    normalizeTable(t);
    expect(t.querySelector("colgroup")).toBe(null);
  });

  it("repairs a colgroup that doesn't match the columns", () => {
    const t = table([["A", "B", "C"]]);
    t.insertAdjacentHTML("beforeend", '<colgroup><col style="--col-w:100px"><col style="--col-w:200px" span="3"></colgroup><colgroup></colgroup>');
    normalizeTable(t);
    expect(t.firstElementChild!.tagName).toBe("COLGROUP");
    expect(t.querySelectorAll("colgroup").length).toBe(1);
    expect(t.querySelector("col[span]")).toBe(null);
    expect(colWidths(t)).toEqual([100, 200, 150]);
  });

  it("doesn't touch a colgroup that's already right", () => {
    const t = table([["A", "B"]]);
    setColWidths(t, [90, 160]);
    const group = t.firstElementChild;
    normalizeTable(t);
    expect(t.firstElementChild).toBe(group);
  });
});

describe("moving rows", () => {
  it("treats rows joined by a merged cell as one block", () => {
    const t = table([["A", "B"], ["C/r2", "D"], ["E"], ["F", "G"]]);
    expect(blocks(t, "row")).toEqual([{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }]);
  });

  it("moves a row, with its cells and their colors", () => {
    const t = table([["A", "B"], ["C", "D"], ["E", "F"]]);
    setCellColor(t.rows[2].cells[0], "#e04f4f");
    expect(moveBlock(t, "row", 2, 0)).toBe(true);
    expect(shape(t)).toEqual([["E", "F"], ["A", "B"], ["C", "D"]]);
    expect(cellColor(t.rows[0].cells[0])).toBe("#e04f4f");
    expect(moveBlock(t, "row", 0, 3)).toBe(true);
    expect(shape(t)).toEqual([["A", "B"], ["C", "D"], ["E", "F"]]);
  });

  it("moves a merged block whole, and never into the middle of one", () => {
    const t = table([["A", "B"], ["C/r2", "D"], ["E"], ["F", "G"]]);
    expect(moveTargets(t, "row", 3)).toEqual([0, 1]);
    expect(moveBlock(t, "row", 3, 2)).toBe(false);
    expect(moveBlock(t, "row", 2, 0)).toBe(true);
    expect(shape(t)).toEqual([["C/r2", "D"], ["E"], ["A", "B"], ["F", "G"]]);
  });

  it("keeps the header row first", () => {
    const t = table([["*A", "*B"], ["C", "D"], ["E", "F"]]);
    expect(moveTargets(t, "row", 0)).toEqual([]);
    expect(moveTargets(t, "row", 2)).toEqual([1]);
    expect(moveStep(t, "row", 1, -1)).toBe(null);
    expect(moveStep(t, "row", 1, 1)).toBe(3);
  });

  it("keeps a header column on the moved row", () => {
    const t = table([["#A", "B"], ["#C", "D"]]);
    moveBlock(t, "row", 1, 0);
    expect(shape(t)).toEqual([["#C", "D"], ["#A", "B"]]);
  });

  it("steps over a whole merged block", () => {
    const t = table([["A", "B"], ["C/r2", "D"], ["E"]]);
    expect(moveStep(t, "row", 0, 1)).toBe(3);
    expect(moveStep(t, "row", 2, -1)).toBe(0);
    expect(moveStep(t, "row", 2, 1)).toBe(null);
  });
});

describe("moving columns", () => {
  it("treats columns joined by a merged cell as one block", () => {
    const t = table([["A/c2", "B", "C"], ["D", "E", "F", "G"]]);
    expect(blocks(t, "col")).toEqual([{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }]);
  });

  it("moves a column left and right in every row", () => {
    const t = table([["*A", "*B", "*C"], ["D", "E", "F"]]);
    expect(moveBlock(t, "col", 2, 0)).toBe(true);
    expect(shape(t)).toEqual([["*C", "*A", "*B"], ["F", "D", "E"]]);
    expect(moveBlock(t, "col", 0, 3)).toBe(true);
    expect(shape(t)).toEqual([["*A", "*B", "*C"], ["D", "E", "F"]]);
    expect(moveBlock(t, "col", 0, 2)).toBe(true);
    expect(shape(t)).toEqual([["*B", "*A", "*C"], ["E", "D", "F"]]);
  });

  it("moves a merged block whole, past cells merged across rows", () => {
    // B covers two rows, so row 1 has no cell of its own in column 1.
    const t = table([["A/c2", "B/r2", "C"], ["D", "E", "F"]]);
    expect(moveBlock(t, "col", 0, 4)).toBe(true);
    expect(shape(t)).toEqual([["B/r2", "C", "A/c2"], ["F", "D", "E"]]);
    const g = buildGrid(t);
    expect(g.slots.map((row) => row.map((gc) => gc!.el.textContent))).toEqual([["B", "C", "A", "A"], ["B", "F", "D", "E"]]);
  });

  it("never moves into the middle of a block", () => {
    const t = table([["A/c2", "B"], ["C", "D", "E"]]);
    expect(moveTargets(t, "col", 2)).toEqual([0]);
    expect(moveBlock(t, "col", 2, 1)).toBe(false);
  });

  it("keeps the header column first", () => {
    const t = table([["#A", "B", "C"], ["#D", "E", "F"]]);
    expect(moveTargets(t, "col", 0)).toEqual([]);
    expect(moveTargets(t, "col", 2)).toEqual([1]);
    expect(moveStep(t, "col", 1, -1)).toBe(null);
  });

  it("moves a column's set width with it", () => {
    const t = table([["A", "B", "C"]]);
    setColWidths(t, [100, 200, 300]);
    moveBlock(t, "col", 2, 0);
    expect(colWidths(t)).toEqual([300, 100, 200]);
  });
});

describe("header column with only the header row left", () => {
  it("can be turned on in a one-row table, and stays on when rows come back", () => {
    const t = table([["*A", "*B"]]);
    applyHeaders(t, true, true);
    expect(hasHeaderCol(t)).toBe(true);
    insertRow(t, 1);
    expect(shape(t)[1][0]).toBe("#_");
  });

  it("survives deleting the body rows", () => {
    const t = table([["*A", "*B"], ["#C", "D"]]);
    applyHeaders(t, true, true);
    deleteRow(t, 1);
    expect(hasHeaderCol(t)).toBe(true);
    applyHeaders(t, true, false);
    expect(hasHeaderCol(t)).toBe(false);
  });
});
