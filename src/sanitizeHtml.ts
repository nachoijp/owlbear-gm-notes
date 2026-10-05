// Rebuilds note HTML that came from OUTSIDE this editor — the clipboard (any page can put data under
// our clipboard type), an imported file, or the cloud — keeping only what the editor itself can
// produce: unknown elements are unwrapped to their text, scripts/styles dropped, and only our own
// attributes and style properties survive. Nothing in the input can run or load anything.
// DIV: older notes can contain browser-made <div> blocks (from before <p> became the default).
const CLIP_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "BLOCKQUOTE", "UL", "OL", "LI", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "SPAN", "BR", "HR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "COLGROUP", "COL"]);
const CLIP_DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH"]);
// font-weight/font-style: Chrome un-bolds text inside a heading (or un-italicizes it inside a quote)
// with a "normal" span.
const CLIP_STYLE_PROPS = ["color", "--pill-c", "--quote-c", "--marker-c", "text-decoration-line", "font-weight", "font-style"];
// Only plain color values (hex/rgb/var/color-mix) — never url(), expression() or the like.
function isSafeClipValue(v: string): boolean {
  return /^[#\w\s(),.%-]+$/.test(v) && !/url\s*\(|expression/i.test(v);
}
export function sanitizeNoteHtml(html: string): string {
  const src = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const out = document.createElement("div");
  function copyChildren(from: Node, to: Node) {
    from.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        to.appendChild(document.createTextNode((n as Text).data.replace(/\u200b/g, "")));
        return;
      }
      if (n.nodeType !== 1) return;
      const el = n as HTMLElement;
      // toUpperCase: elements in the SVG/MathML namespaces keep lowercase tag names.
      if (CLIP_DROP.has(el.tagName.toUpperCase())) return;
      // Chrome writes color applied at a plain caret (execCommand foreColor) as <font color>; keep it,
      // as the <span style="color"> the rest of the editor uses.
      const fontColor = el.tagName === "FONT" ? (el.getAttribute("color") || "").trim() : "";
      if (!CLIP_TAGS.has(el.tagName) && !fontColor) {
        copyChildren(el, to);
        return;
      }
      const clean = document.createElement(fontColor ? "SPAN" : el.tagName);
      if (fontColor && isSafeClipValue(fontColor)) clean.style.color = fontColor;
      if (el.tagName === "SPAN" && el.classList.contains("note-pill")) clean.className = "note-pill";
      CLIP_STYLE_PROPS.forEach((prop) => {
        const v = el.style.getPropertyValue(prop).trim();
        if (v && isSafeClipValue(v)) clean.style.setProperty(prop, v);
      });
      if (/^H[1-4]$/.test(el.tagName) && el.hasAttribute("data-collapsed")) clean.setAttribute("data-collapsed", "");
      if (el.tagName === "P" && el.hasAttribute("data-standalone")) clean.setAttribute("data-standalone", "");
      // A line that leaves the sections around it (see the editor's exitLevel).
      const exit = el.getAttribute("data-exit");
      if (/^(P|DIV|BLOCKQUOTE|H[1-4])$/.test(el.tagName) && exit && /^[1-4]$/.test(exit)) clean.setAttribute("data-exit", exit);
      if (el.tagName === "TABLE" && el.hasAttribute("data-header-col")) clean.setAttribute("data-header-col", "");
      // Header cells: scope tells a header-row cell (col) from a header-column one (row).
      const scope = el.getAttribute("scope");
      if (el.tagName === "TH" && (scope === "col" || scope === "row")) clean.setAttribute("scope", scope);
      // Merged cells (the table model caps spans at 50 too) and cell colors.
      if (el.tagName === "TD" || el.tagName === "TH") {
        const color = el.style.getPropertyValue("--cell-c").trim();
        if (color && isSafeClipValue(color)) clean.style.setProperty("--cell-c", color);
        (["rowspan", "colspan"] as const).forEach((attr) => {
          const v = el.getAttribute(attr);
          if (v && /^\d+$/.test(v) && Number(v) >= 2 && Number(v) <= 50) clean.setAttribute(attr, v);
        });
      }
      // Set column widths: whole pixels, nothing else.
      const colW = el.tagName === "COL" ? el.style.getPropertyValue("--col-w").trim() : "";
      if (/^\d{1,4}px$/.test(colW)) clean.style.setProperty("--col-w", colW);
      copyChildren(el, clean);
      to.appendChild(clean);
    });
  }
  copyChildren(src, out);
  return out.innerHTML;
}
