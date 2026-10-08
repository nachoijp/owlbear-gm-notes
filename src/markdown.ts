// Conversions between note HTML and plain text / Markdown: pasting, Markdown import/export, word
// counts and search. Pure functions (no editor state).
import { hasHeaderRow, textMatrix } from "./tableModel";

export function escapeHtml(str: string): string {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
// Best-effort Markdown -> this editor's own HTML, used on paste. Markdown source is plain text as
// far as the clipboard is concerned, so stripping rich formatting alone (see the paste handler)
// leaves the literal "**"/"#"/"-" markers sitting in the note. Parsing them into the SAME tags the
// toolbar itself produces — rather than inventing a separate representation — means pasted content
// immediately works with everything else here: pills, color, clear-format, all of it. Only recognizes
// what this editor can actually represent (H1/H2, bold/italic, bullet/numbered lists, blockquote, hr,
// tables, paragraphs) — constructs with no equivalent here (code blocks, links, images) are left as
// plain escaped text rather than silently dropped or half-converted.
export function markdownToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;

  function closeList() {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  }
  function inline(s: string): string {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a, b) => `<b>${a ?? b}</b>`)
      .replace(/\*(.+?)\*|(?<![\w\\])_(.+?)_(?!\w)/g, (_m, a, b) => `<i>${a ?? b}</i>`);
  }
  function isSpecial(line: string): boolean {
    return (
      /^\s*$/.test(line) ||
      /^(#{1,6})\s+/.test(line) ||
      /^(-{3,}|\*{3,})\s*$/.test(line) ||
      /^\s*[-*]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line) ||
      /^\s*>\s?/.test(line)
    );
  }

  // GitHub-style tables: a row of cells, then a |---|:---:| separator line, then more rows. The
  // pipes at the ends are optional; a literal pipe in a cell is written \|.
  function splitRow(line: string): string[] {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  }
  function isTableStart(at: number): boolean {
    const head = lines[at];
    const sep = lines[at + 1];
    // The separator needs a pipe too, or "text | text" over a "---" line would be a table.
    if (sep === undefined || !head.includes("|") || !sep.includes("|")) return false;
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(sep);
  }
  // A cell's <br> (how line breaks inside a cell are written) survives as a real line break.
  function cellInline(s: string): string {
    return inline(s).replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  }
  function table(at: number): [string, number] {
    const head = splitRow(lines[at]);
    const cols = head.length;
    let next = at + 2;
    const body: string[][] = [];
    while (next < lines.length && lines[next].includes("|") && !/^\s*$/.test(lines[next])) {
      body.push(splitRow(lines[next]));
      next++;
    }
    // An all-empty header row is how a table without one is written (Markdown requires the row).
    const hasHeader = head.some((c) => c !== "");
    const cell = (tag: string, c: string, scope = "") => `<${tag}${scope}>${cellInline(c) || "<br>"}</${tag}>`;
    const row = (cells: string[], header: boolean) =>
      "<tr>" + Array.from({ length: cols }, (_v, k) => (header ? cell("th", cells[k] ?? "", ' scope="col"') : cell("td", cells[k] ?? ""))).join("") + "</tr>";
    const rows = (hasHeader ? [row(head, true)] : []).concat(body.map((r) => row(r, false)));
    if (!rows.length) rows.push(row([], false));
    return [`<table><tbody>${rows.join("")}</tbody></table>`, next];
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      closeList();
      i++;
      continue;
    }

    if (isTableStart(i)) {
      closeList();
      const [html, next] = table(i);
      out.push(html);
      i = next;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const tag = "h" + Math.min(heading[1].length, 4);
      out.push(`<${tag}>${inline(heading[2].trim())}</${tag}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      i++;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (listTag !== "ul") {
        closeList();
        out.push("<ul>");
        listTag = "ul";
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      i++;
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (listTag !== "ol") {
        closeList();
        out.push("<ol>");
        listTag = "ol";
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
      i++;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      const qLines = [quote[1]];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(/^\s*>\s?(.*)$/);
        if (!m) break;
        qLines.push(m[1]);
        i++;
      }
      out.push(`<blockquote>${qLines.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    // Plain text: gather consecutive non-blank, non-special lines into one paragraph, keeping each
    // source line break as a <br> rather than reflowing them — GM notes often rely on line-by-line
    // structure (stat blocks, dialogue) that collapsing into flowing prose would destroy.
    closeList();
    const pLines = [line];
    i++;
    while (i < lines.length && !isSpecial(lines[i]) && !isTableStart(i)) {
      pLines.push(lines[i]);
      i++;
    }
    out.push(`<p>${pLines.map(inline).join("<br>")}</p>`);
  }
  closeList();
  return out.join("");
}

// The reverse of markdownToHtml() above, used for the Markdown export option. Formatting with no
// standard Markdown equivalent — pills, text color, underline — has no representation to fall back
// to (Markdown itself has no concept of color), so it's dropped, keeping just the plain text; this is
// a one-way, human-readable export for taking a note elsewhere, not a lossless round-trip format —
// a table's header column, for one, has no Markdown form —
// the JSON export exists for that. Escapes literal backslash/backtick/asterisk/underscore in plain
// text so the user's own characters don't get misread as Markdown syntax by whatever reads the file.
export function htmlToMarkdown(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;

  function escapeText(s: string): string {
    return (s || "").replace(/[\\`*_]/g, "\\$&");
  }
  function inline(node: Node): string {
    if (node.nodeType === 3) return escapeText(node.textContent || "");
    if (node.nodeType !== 1) return "";
    const el = node as HTMLElement;
    const inner = Array.prototype.map.call(el.childNodes, inline).join("");
    switch (el.tagName) {
      case "B":
      case "STRONG":
        return `**${inner}**`;
      case "I":
      case "EM":
        return `*${inner}*`;
      case "S":
      case "STRIKE":
      case "DEL":
        return `~~${inner}~~`;
      case "BR":
        return "  \n";
      default:
        return inner;
    }
  }
  // Sub-lists in this editor sit as a SIBLING of the <li> they nest under, inside the same parent
  // <ul>/<ol> (see structure.ts's repairLists) — walking list.children in order
  // and bumping the indent level whenever a UL/OL turns up between <li>s reproduces that nesting
  // correctly in the output without needing to know about the quirk explicitly.
  function list(el: HTMLElement, depth: number): string {
    const ordered = el.tagName === "OL";
    const indent = "  ".repeat(depth);
    const lines: string[] = [];
    let n = 1;
    Array.prototype.forEach.call(el.children, (child: HTMLElement) => {
      if (child.tagName === "LI") {
        lines.push(`${indent}${ordered ? `${n++}. ` : "- "}${inline(child)}`);
      } else if (child.tagName === "UL" || child.tagName === "OL") {
        lines.push(list(child, depth + 1));
      }
    });
    return lines.join("\n");
  }
  function block(el: HTMLElement): string {
    switch (el.tagName) {
      case "H1":
        return `# ${inline(el)}`;
      case "H2":
        return `## ${inline(el)}`;
      case "H3":
        return `### ${inline(el)}`;
      case "H4":
        return `#### ${inline(el)}`;
      case "BLOCKQUOTE":
        return inline(el)
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
      case "HR":
        return "---";
      case "UL":
      case "OL":
        return list(el, 0);
      case "TABLE":
        return table(el as HTMLTableElement);
      default:
        return inline(el);
    }
  }
  // GitHub-style table. Markdown requires a header row, so a table without one gets an empty one
  // (markdownToHtml reads that back as "no header"). Line breaks in a cell are written as <br>.
  // Merged cells have no Markdown form: their text goes in their first position (see textMatrix).
  function table(el: HTMLTableElement): string {
    const cells = textMatrix(el, (c) =>
      inline(c).replace(/( {2}\n)+$/, "").replace(/ {2}\n/g, "<br>").replace(/\n/g, " ").replace(/\|/g, "\\|").trim()
    );
    if (!cells.length) return "";
    const cols = cells[0].length;
    const line = (row: string[] | null) => "| " + Array.from({ length: cols }, (_v, k) => (row ? row[k] : "")).join(" | ") + " |";
    const header = hasHeaderRow(el);
    const out = [line(header ? cells[0] : null), "|" + " --- |".repeat(cols)];
    (header ? cells.slice(1) : cells).forEach((r) => out.push(line(r)));
    return out.join("\n");
  }

  return Array.prototype.map.call(container.children, block).join("\n\n");
}

// Note HTML reduced to inline content, for pasting into a table cell (which holds no blocks): each
// block becomes a line (separated by <br>), cells of a pasted table are separated by spaces, and
// dividers are dropped. Inline formatting (bold, color, pills...) is kept.
export function flattenToInline(html: string): string {
  const box = document.createElement("div");
  box.innerHTML = html;
  box.querySelectorAll("hr").forEach((hr) => hr.remove());
  box.querySelectorAll("td, th").forEach((c) => {
    if (c.nextElementSibling) c.after(" ");
  });
  box.querySelectorAll("p, div, h1, h2, h3, h4, blockquote, li, tr").forEach((b) => {
    if (b.nextSibling || b.parentElement !== box) b.after(document.createElement("br"));
  });
  box.querySelectorAll("table, thead, tbody, tr, td, th, p, div, h1, h2, h3, h4, blockquote, ul, ol, li").forEach((b) => {
    b.replaceWith(...Array.from(b.childNodes));
  });
  // No line break at the very start or end, and at most one in a row.
  return box.innerHTML
    .replace(/(<br>\s*){2,}/g, "<br>")
    .replace(/^(\s*<br>)+/, "")
    .replace(/(<br>\s*)+$/, "");
}

export function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  // Adjacent cells, lines and line breaks have no whitespace between them in the markup (the editor
  // writes none); without this the last word of one line and the first of the next merged into one,
  // undercounting words and joining lines in note snippets and search.
  tmp.querySelectorAll("td, th, p, div, h1, h2, h3, h4, blockquote, li, tr").forEach((c) => c.append(" "));
  tmp.querySelectorAll("br").forEach((br) => br.after(" "));
  return (tmp.textContent || "").replace(/\s+/g, " ").trim();
}
