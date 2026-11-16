// A note's quick view: a small popover opened by double-clicking a map badge (see background.ts).
// Read-only, shown as the panel shows it: sections fold with their chevrons (not saved), the GM's
// hidden parts sit in boxes with an eye in the margin, and a link opens its note here. The note comes
// from this player's panel (its notes, or the shared ones for a player), asked for over a LOCAL
// message; "Open in the panel" goes through the background page, like the context menu's "Open note".
import OBR from "@owlbear-rodeo/sdk";
import "./style.css";
import { getStrings } from "./i18n";
import { getAccentPref, getLanguage } from "./prefs";
import { watchTheme } from "./theme";
import { sanitizeNoteHtml } from "./sanitizeHtml";
import { createSections } from "./sections";
import { SECRET_ATTR, secretUnits } from "./secret";
import { LINK_ATTR } from "./noteLinks";
import { PEEK_CHANNEL, PEEK_POPOVER_ID } from "./itemLinks";
import type { PeekMessage, PeekNote } from "./itemLinks";

const ASK_EVERY_MS = 400;
const GIVE_UP_MS = 4000;

const q = new URLSearchParams(location.search);
// The note shown: the badge's, until a link leads to another.
const badgeNoteId = q.get("note") || "";
let noteId = badgeNoteId;
const itemId = q.get("item") || "";
const name = q.get("name") || "";
const panel = document.getElementById("panel") as HTMLElement;
const titleEl = document.getElementById("peekTitle") as HTMLElement;
const surface = document.getElementById("peekBody") as HTMLElement;
const scroller = surface.parentElement as HTMLElement;
const secretLayer = document.getElementById("peekSecretLayer") as HTMLElement;
const openBtn = document.getElementById("peekOpenBtn") as HTMLButtonElement;

function blockAt(node: Node): HTMLElement | null {
  let el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
  if (!el || el === surface || !surface.contains(el)) return null;
  while (el.parentElement && el.parentElement !== surface) el = el.parentElement;
  return el;
}

// The GM's hidden parts: one box per run of hidden lines, an eye per line in the right margin (as
// the panel draws them, without the clicks: nothing is changed from here).
let showSecret = false;
function drawSecret() {
  secretLayer.innerHTML = "";
  if (!showSecret) return;
  const base = scroller.getBoundingClientRect();
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { top: r.top - base.top + scroller.scrollTop, bottom: r.bottom - base.top + scroller.scrollTop, left: r.left - base.left, right: r.right - base.left };
  };
  const eyeLeft = Math.round(surface.getBoundingClientRect().right - base.left - 24);
  type Run = { top: number; bottom: number; left: number; right: number };
  const runs: Run[] = [];
  let run: Run | null = null;
  let html = "";
  secretUnits(surface).forEach((u) => {
    const top = blockAt(u) || u;
    if (top.hasAttribute("data-folded")) return;
    if (!u.hasAttribute(SECRET_ATTR)) {
      run = null;
      return;
    }
    const b = box(u);
    if (run) {
      run.top = Math.min(run.top, b.top);
      run.bottom = Math.max(run.bottom, b.bottom);
      run.left = Math.min(run.left, b.left);
      run.right = Math.max(run.right, b.right);
    } else {
      run = { ...b };
      runs.push(run);
    }
    html += `<div class="secret-eye" style="top:${b.top + 2}px;left:${eyeLeft}px"></div>`;
  });
  secretLayer.innerHTML =
    runs.map((b) => `<div class="secret-box" style="top:${b.top - 3}px;left:${b.left - 4}px;width:${b.right - b.left + 8}px;height:${b.bottom - b.top + 6}px"></div>`).join("") + html;
}

const sections = createSections({ surface, blockAt, onFoldChange: drawSecret, onLayout: drawSecret });

function show(note: PeekNote, untitled: string) {
  titleEl.textContent = note.title || untitled;
  surface.classList.remove("peek-status");
  surface.innerHTML = sanitizeNoteHtml(note.html);
  showSecret = note.gm && surface.querySelector(`[${SECRET_ATTR}]`) !== null;
  surface.classList.toggle("has-secret", showSecret);
  scroller.scrollTop = 0;
  sections.applyFolding();
  drawSecret();
}
function status(text: string) {
  surface.classList.add("peek-status");
  surface.classList.remove("has-secret");
  showSecret = false;
  secretLayer.innerHTML = "";
  surface.textContent = text;
}

OBR.onReady(async () => {
  const [language, accent] = await Promise.all([getLanguage(), getAccentPref()]);
  const s = getStrings(language);
  document.documentElement.lang = language;
  watchTheme(panel, accent);
  openBtn.title = s.peekOpenInPanel;
  openBtn.setAttribute("aria-label", s.peekOpenInPanel);
  titleEl.textContent = name;

  openBtn.addEventListener("click", () => {
    void OBR.broadcast.sendMessage(PEEK_CHANNEL, { type: "open", noteId, itemId, name, noteOnly: noteId !== badgeNoteId } satisfies PeekMessage, { destination: "LOCAL" });
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") void OBR.popover.close(PEEK_POPOVER_ID);
  });
  window.addEventListener("resize", drawSecret);

  // Asking for a note: again every so often until the panel answers, or a notice after a while.
  let asking: { nonce: string; timer: number; started: number } | null = null;
  function load(id: string) {
    if (asking) window.clearInterval(asking.timer);
    noteId = id;
    status(s.peekLoading);
    const nonce = Math.random().toString(36).slice(2);
    const ask = () => void OBR.broadcast.sendMessage(PEEK_CHANNEL, { type: "want", noteId: id, nonce } satisfies PeekMessage, { destination: "LOCAL" });
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) {
        window.clearInterval(timer);
        asking = null;
        status(s.peekUnavailable);
        return;
      }
      ask();
    }, ASK_EVERY_MS);
    asking = { nonce, timer, started };
    ask();
  }
  OBR.broadcast.onMessage(PEEK_CHANNEL, (event) => {
    const message = event.data as PeekMessage;
    if (!asking || !message || message.type !== "note" || message.nonce !== asking.nonce) return;
    window.clearInterval(asking.timer);
    asking = null;
    if (message.note) show(message.note, s.untitled);
    else status(s.peekUnavailable);
  });
  // A link opens its note here (a link to a note that's gone does nothing).
  surface.addEventListener("click", (ev) => {
    const link = (ev.target as HTMLElement).closest(".note-link") as HTMLElement | null;
    if (!link || link.hasAttribute("data-missing")) return;
    ev.preventDefault();
    const id = link.getAttribute(LINK_ATTR) || "";
    if (id) load(id);
  });
  load(noteId);
});
