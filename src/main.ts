import OBR from "@owlbear-rodeo/sdk";
import JSZip from "jszip";
import "./style.css";
import { getStrings } from "./i18n";
import type { Language, Strings, ToolbarStrings } from "./i18n";
import { getNotes, setNotes, clearAllNotes, notesStorageBytes, sanitizeNote } from "./notes";
import type { Note } from "./notes";
import { getLanguage, setLanguage, getAccentPref, setAccentPref } from "./prefs";
import type { AccentPref } from "./prefs";
import { ACCENTS, ACCENT_ORDER, watchTheme } from "./theme";

// ---------- state ----------
let notes: Note[] = [];
let activeId: string | null = null;
let searchTerm = "";
let language: Language = "en";
let accentPref: AccentPref = "auto";
let role: "GM" | "PLAYER" = "GM";
let setThemeAccent: (accent: AccentPref) => void = () => {};

// The debounced per-keystroke save (see scheduleSave in buildNoteEditor) waits 400ms of idle typing
// before actually writing to room metadata — a refresh/tab-close inside that window would otherwise
// silently drop the last few keystrokes. Whichever editor instance currently has a save pending points
// this at its own flush, and we force it immediately the moment the page might go away.
let pendingSaveFlush: (() => void | Promise<void>) | null = null;
function flushPendingSave() {
  if (pendingSaveFlush) {
    const flush = pendingSaveFlush;
    pendingSaveFlush = null;
    flush();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingSave();
});
window.addEventListener("pagehide", flushPendingSave);

function strings(): Strings {
  return getStrings(language);
}

async function persist(): Promise<boolean> {
  try {
    await setNotes(notes);
    hideStorageBanner();
    updateStorageMeter();
    return true;
  } catch (err) {
    // setNotes() rejecting was previously silent (callers use `void persist()`), which is exactly
    // what "my notes vanish on refresh" looks like from the outside: the edit never actually reached
    // storage, so the next getNotes() naturally reads back the last state that DID save. IndexedDB
    // has no meaningful capacity limit to pre-flight against (unlike the old room-metadata 16kB
    // cap), so a failure here is something environmental — private browsing blocking storage, quota
    // exhausted at the OS/disk level — not something to predict, just report.
    console.error("Notes: failed to save notes", err);
    showStorageBanner(strings().storageBannerGeneric);
    return false;
  }
}

function showStorageBanner(message: string) {
  const banner = document.getElementById("storageBanner") as HTMLElement;
  const text = document.getElementById("storageBannerText")!;
  text.textContent = message;
  banner.hidden = false;
}
function hideStorageBanner() {
  (document.getElementById("storageBanner") as HTMLElement).hidden = true;
}

function updateStorageMeter() {
  const text = document.getElementById("storageMeterText");
  if (!text) return;
  const usedKB = (notesStorageBytes(notes) / 1024).toFixed(1);
  text.textContent = strings().storageMeterText(usedKB);
}

const PILL_COLORS = [
  { id: "violeta", hex: "#7c5cff" },
  { id: "azul", hex: "#3f8ce0" },
  { id: "verde", hex: "#4caf72" },
  { id: "amarillo", hex: "#d6b214" },
  { id: "naranja", hex: "#e2822f" },
  { id: "rojo", hex: "#e04f4f" },
  { id: "rosa", hex: "#e05a86" },
  { id: "marrón", hex: "#9c6b3e" },
  { id: "gris", hex: "#8b8994" },
];

function escapeHtml(str: string): string {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
// Best-effort Markdown -> this editor's own HTML, used on paste. Markdown source is plain text as
// far as the clipboard is concerned, so stripping rich formatting alone (see the paste handler)
// leaves the literal "**"/"#"/"-" markers sitting in the note. Parsing them into the SAME tags the
// toolbar itself produces — rather than inventing a separate representation — means pasted content
// immediately works with everything else here: pills, color, clear-format, all of it. Only recognizes
// what this editor can actually represent (H1/H2, bold/italic, bullet/numbered lists, blockquote, hr,
// paragraphs) — constructs with no equivalent here (tables, code blocks, links, images) are left as
// plain escaped text rather than silently dropped or half-converted.
function markdownToHtml(text: string): string {
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

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      closeList();
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const tag = heading[1].length === 1 ? "h1" : "h2";
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
    while (i < lines.length && !isSpecial(lines[i])) {
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
// the JSON export exists for that. Escapes literal backslash/backtick/asterisk/underscore in plain
// text so the user's own characters don't get misread as Markdown syntax by whatever reads the file.
function htmlToMarkdown(html: string): string {
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
  // <ul>/<ol> (see stripAllListsAtSelection's own comment on this) — walking list.children in order
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
      default:
        return inline(el);
    }
  }

  return Array.prototype.map.call(container.children, block).join("\n\n");
}

function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || "").replace(/\s+/g, " ").trim();
}
function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.round(diff / 60000);
  const s = strings();
  if (m < 1) return s.timeNow;
  if (m < 60) return m + s.timeMin;
  const h = Math.round(m / 60);
  if (h < 24) return h + s.timeHour;
  const d = Math.round(h / 24);
  return d + s.timeDay;
}
function getActive(): Note | undefined {
  return notes.find((n) => n.id === activeId);
}
function filteredNotes(): Note[] {
  if (!searchTerm) return notes;
  const q = searchTerm.toLowerCase();
  return notes.filter((n) => n.title.toLowerCase().includes(q) || stripHtml(n.html).toLowerCase().includes(q));
}

// ---------- static DOM refs ----------
const panel = document.getElementById("panel") as HTMLElement;
const noteListEl = document.getElementById("noteList") as HTMLElement;
const editorPaneEl = document.getElementById("editorPane") as HTMLElement;
const searchInput = document.getElementById("searchInput") as HTMLInputElement;
const switcherTitleEl = document.getElementById("switcherTitle") as HTMLElement;
const switcherCountEl = document.getElementById("switcherCount") as HTMLElement;

// ---------- GM note list + switcher ----------
function updateSwitcherHeader() {
  switcherTitleEl.textContent = strings().notesLabel;
  switcherCountEl.textContent = String(notes.length);
}

function renderList() {
  const list = filteredNotes();
  updateSwitcherHeader();
  const s = strings();

  if (!list.length) {
    noteListEl.innerHTML = `<div class="empty-list">${notes.length ? escapeHtml(s.emptySearch) : s.emptyList}</div>`;
    return;
  }

  noteListEl.innerHTML = "";
  list
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach((n) => {
      const item = document.createElement("div");
      item.className = "note-item" + (n.id === activeId ? " active" : "");
      item.dataset.id = n.id;

      const row = document.createElement("div");
      row.className = "note-item-row";

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = n.title || s.untitled;

      const exportBtn = document.createElement("button");
      exportBtn.className = "row-btn export-btn";
      exportBtn.title = s.exportTitle;
      exportBtn.setAttribute("aria-label", s.exportAria + (n.title || s.untitled));
      exportBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v7m0 0L5 6m3 3 3-3M3 12.5h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      exportBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openExportFormatModal(n);
      });

      const editBtn = document.createElement("button");
      editBtn.className = "row-btn edit-btn";
      editBtn.title = s.renameTitle;
      editBtn.setAttribute("aria-label", s.renameAria + (n.title || s.untitled));
      editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11 2.5 13.5 5 5.8 12.7l-3 .6.6-3L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        startRename(item, n);
      });

      const del = document.createElement("button");
      del.className = "row-btn del-btn";
      del.title = s.deleteTitle;
      del.setAttribute("aria-label", s.deleteAria + (n.title || s.untitled));
      del.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5 5 13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void deleteNote(n.id);
      });

      row.appendChild(title);
      row.appendChild(exportBtn);
      row.appendChild(editBtn);
      row.appendChild(del);

      const snippet = document.createElement("div");
      snippet.className = "snippet";
      snippet.textContent = stripHtml(n.html) || s.emptyNote;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = s.editedAgo + relativeTime(n.updatedAt);

      item.appendChild(row);
      item.appendChild(snippet);
      item.appendChild(meta);

      item.addEventListener("click", () => {
        activeId = n.id;
        renderList();
        renderEditor();
        closeDropdown();
      });

      noteListEl.appendChild(item);
    });
}

function startRename(itemEl: HTMLElement, note: Note) {
  const titleSpan = itemEl.querySelector(".title") as HTMLElement;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = note.title;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const v = input.value.trim();
    note.title = v || strings().untitled;
    void persist();
    renderList();
    renderEditor();
  }
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    if (ev.key === "Escape") { renderList(); }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (ev) => ev.stopPropagation());
}

async function deleteNote(id: string) {
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  notes.splice(idx, 1);
  if (activeId === id) {
    activeId = notes.length ? notes[0].id : null;
  }
  await persist();
  renderList();
  renderEditor();
}

async function createNote() {
  const note: Note = { id: "n" + Date.now(), title: strings().newNoteDefaultTitle, html: "", updatedAt: Date.now() };
  notes.unshift(note);
  activeId = note.id;
  await persist();
  renderList();
  renderEditor();
  closeDropdown();
  const titleInput = editorPaneEl.querySelector(".note-title-input") as HTMLInputElement | null;
  if (titleInput) { titleInput.focus(); titleInput.select(); }
}

// ---------- export / import: an escape valve for the room's shared 16kB cap that doesn't need a
// backend. A note the GM doesn't need active can be exported to a file (freeing room-metadata space
// the same way deleting it would) and imported back later without losing anything — unlike the
// room-cleanup tool above, this only ever touches this extension's own data, so it's safe to ship in
// a publicly-shared copy of the extension too. ----------
interface NoteExportFile {
  type: "gm-notes-note";
  version: 1;
  id: string;
  title: string;
  html: string;
  updatedAt: number;
}
function noteToExportPayload(note: Note): NoteExportFile {
  return { type: "gm-notes-note", version: 1, id: note.id, title: note.title, html: note.html, updatedAt: note.updatedAt };
}
// A freshly-imported note always gets a brand-new id, even if the file still carries its original
// one (kept only so a future "was this already imported" check has something to compare) — re-importing
// the same export twice, or importing into a DIFFERENT room's notes that happens to reuse an id, must
// never silently overwrite an existing note.
function freshNoteId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "n" + Date.now() + Math.random().toString(36).slice(2);
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
// Filesystem-safe stand-in for a note title, used as an export filename (and, inside a zip, an entry
// name) — titles are free text and can contain characters no filesystem allows.
function safeFileName(title: string): string {
  const cleaned = title.trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
  return cleaned || strings().untitled;
}

type ExportFormat = "json" | "markdown";

function exportNote(note: Note, format: ExportFormat) {
  if (format === "json") {
    const blob = new Blob([JSON.stringify(noteToExportPayload(note), null, 2)], { type: "application/json" });
    downloadBlob(blob, safeFileName(note.title) + ".json");
  } else {
    const blob = new Blob([htmlToMarkdown(note.html)], { type: "text/markdown" });
    downloadBlob(blob, safeFileName(note.title) + ".md");
  }
}

async function exportAllNotes(format: ExportFormat) {
  if (!notes.length) return;
  if (notes.length === 1) {
    exportNote(notes[0], format);
    return;
  }
  const zip = new JSZip();
  const usedNames = new Set<string>();
  const ext = format === "json" ? ".json" : ".md";
  notes.forEach((n) => {
    const base = safeFileName(n.title);
    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = `${base}-${i++}`;
    usedNames.add(name);
    const content = format === "json" ? JSON.stringify(noteToExportPayload(n), null, 2) : htmlToMarkdown(n.html);
    zip.file(name + ext, content);
  });
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, "gm-notes-export.zip");
}

// Which export was requested (a single note, or "all") while the format-choice modal is open — set
// when the modal opens, read and cleared the moment a format button is clicked.
let pendingExportTarget: Note | "all" | null = null;
function openExportFormatModal(target: Note | "all") {
  pendingExportTarget = target;
  (document.getElementById("exportFormatOverlay") as HTMLElement).hidden = false;
}
function closeExportFormatModal() {
  pendingExportTarget = null;
  (document.getElementById("exportFormatOverlay") as HTMLElement).hidden = true;
}
function chooseExportFormat(format: ExportFormat) {
  const target = pendingExportTarget;
  closeExportFormatModal();
  if (!target) return;
  if (target === "all") void exportAllNotes(format);
  else exportNote(target, format);
}

// Accepts anything sanitizeNote() would accept from room metadata (so a hand-edited or older-format
// file still imports), not just our own NoteExportFile shape.
function parseImportedNote(json: string): Note | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const sanitized = sanitizeNote(data);
  return sanitized ? { ...sanitized, id: freshNoteId() } : null;
}

// A Markdown file carries no title/id of its own — the filename (minus extension) becomes the title,
// and its text runs through the SAME parser the paste handler uses, so a note round-tripped out as
// Markdown and back in comes back as real formatting, not literal "**"/"#"/"-" markers.
function noteFromMarkdownFile(filename: string, text: string): Note {
  const title = filename.replace(/\.md$/i, "").trim();
  return { id: freshNoteId(), title: title || strings().untitled, html: markdownToHtml(text), updatedAt: Date.now() };
}

async function notesFromImportFile(file: File): Promise<Note[]> {
  if (/\.zip$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(file);
    const results: Note[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const entryName = entry.name.split("/").pop() || entry.name;
      if (/\.json$/i.test(entryName)) {
        const parsed = parseImportedNote(await entry.async("text"));
        if (parsed) results.push(parsed);
      } else if (/\.md$/i.test(entryName)) {
        results.push(noteFromMarkdownFile(entryName, await entry.async("text")));
      }
    }
    return results;
  }
  if (/\.md$/i.test(file.name)) {
    return [noteFromMarkdownFile(file.name, await file.text())];
  }
  const parsed = parseImportedNote(await file.text());
  return parsed ? [parsed] : [];
}

async function importNotesFromFiles(files: FileList) {
  const imported: Note[] = [];
  for (const file of Array.from(files)) {
    try {
      imported.push(...(await notesFromImportFile(file)));
    } catch (err) {
      console.error("Notes: failed to read import file", file.name, err);
    }
  }
  if (!imported.length) {
    window.alert(strings().importNoneFound);
    return;
  }
  // The exported file carries the ORIGINAL note's updatedAt, and sanitizeNote() (reused as-is from
  // room-metadata reads) has no reason to touch it — left alone, a freshly-imported note shows the
  // exact same "edited X ago" as whatever note it came from, which reads as though the two are
  // somehow still the same note rather than an independent copy. Importing is its own edit event in
  // THIS room, right now, so it gets its own timestamp.
  const importedAt = Date.now();
  imported.forEach((n) => { n.updatedAt = importedAt; });
  // All-or-nothing: persist() already validates the merged size against the room's shared cap and
  // surfaces the storage banner if it doesn't fit — rolling the in-memory array back on failure keeps
  // it from silently showing notes the room never actually saved.
  const before = notes;
  notes = [...imported, ...notes];
  const ok = await persist();
  if (!ok) {
    notes = before;
    return;
  }
  renderList();
  renderEditor();
  updateStorageMeter();
  window.alert(strings().importSuccess(imported.length));
}

// A full, explicit reset for this room's local storage — distinct from deleting notes one at a time,
// and from the migration step in notes.ts that already clears the OLD shared room-metadata entry on
// its own. This clears what's stored HERE, now, for whoever's using it; pairs naturally with "export
// all" as a manual backup-then-wipe flow.
async function clearAllNotesWithConfirm() {
  if (!notes.length) return;
  if (!window.confirm(strings().clearAllConfirm(notes.length))) return;
  await clearAllNotes();
  notes = [];
  activeId = null;
  renderList();
  renderEditor();
  updateStorageMeter();
}

// ---------- toolbar ----------
interface ToolbarButtonSpec {
  cmd?: string;
  label?: string;
  titleKey?: keyof ToolbarStrings;
  style?: string;
  value?: string;
  picker?: "pill" | "textColor" | "quoteColor";
  sep?: boolean;
  svg?: string;
}

const TOOLBAR_BUTTONS: ToolbarButtonSpec[] = [
  { cmd: "bold", label: "B", titleKey: "bold", style: "font-weight:700;" },
  { cmd: "italic", label: "I", titleKey: "italic", style: "font-style:italic;" },
  { cmd: "underline", label: "U", titleKey: "underline", style: "text-decoration:underline;" },
  { cmd: "strikeThrough", label: "S", titleKey: "strike", style: "text-decoration:line-through;" },
  { picker: "pill" },
  { picker: "textColor" },
  { sep: true },
  { cmd: "formatBlock", value: "H1", label: "H1", titleKey: "h1" },
  { cmd: "formatBlock", value: "H2", label: "H2", titleKey: "h2" },
  { picker: "quoteColor" },
  { cmd: "divider", titleKey: "divider", svg: '<svg viewBox="0 0 16 16" fill="none"><path d="M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' },
  { sep: true },
  { cmd: "insertUnorderedList", titleKey: "bulletList", svg: '<svg viewBox="0 0 16 16" fill="none"><circle cx="2.3" cy="4" r="1.1" fill="currentColor"/><circle cx="2.3" cy="8" r="1.1" fill="currentColor"/><circle cx="2.3" cy="12" r="1.1" fill="currentColor"/><path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
  { cmd: "insertOrderedList", titleKey: "numberList", svg: '<svg viewBox="0 0 16 16" fill="none"><text x="0" y="5.2" font-size="4.2" fill="currentColor">1</text><text x="0" y="9.2" font-size="4.2" fill="currentColor">2</text><text x="0" y="13.2" font-size="4.2" fill="currentColor">3</text><path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
  { cmd: "outdent", titleKey: "outdent", svg: '<svg viewBox="0 0 16 16" fill="none"><path d="M5.5 4.5 2.5 8l3 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 3.5h5.5M8 8h5.5M8 12.5h5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
  { cmd: "indent", titleKey: "indent", svg: '<svg viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5 5.5 8l-3 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 3.5h5.5M8 8h5.5M8 12.5h5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
  { sep: true },
  { cmd: "removeFormat", titleKey: "removeFormat", svg: '<svg viewBox="0 0 16 16" fill="none"><path d="M3 3h7M6.5 3v7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M2.5 13.5 13.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
];

function buildColorPicker(pickerId: string, btnId: string, swatchesId: string, title: string, iconSvg: string, noneTitle?: string): string {
  let swatches = PILL_COLORS.map(
    (c) => `<button type="button" class="pill-swatch" data-color="${c.hex}" style="--sw:${c.hex}" title="${c.id}" aria-label="${title} ${c.id}"></button>`
  ).join("");
  if (noneTitle) {
    swatches += `<button type="button" class="pill-swatch pill-swatch-none" data-color="" title="${noneTitle}" aria-label="${noneTitle}"><svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
  }
  return (
    `<div class="pill-picker" id="${pickerId}">` +
    `<button type="button" class="pill-picker-btn" id="${btnId}" title="${title}" aria-haspopup="true" aria-expanded="false">${iconSvg}</button>` +
    `<div class="pill-swatches" id="${swatchesId}" hidden>${swatches}</div>` +
    `</div>`
  );
}

function renderToolbarButton(b: ToolbarButtonSpec, idPrefix: string): string {
  if (b.sep) return '<span class="tb-sep"></span>';
  const tb = strings().toolbar;
  if (b.picker === "pill") {
    return buildColorPicker(
      idPrefix + "PillPicker", idPrefix + "PillPickerBtn", idPrefix + "PillSwatches", tb.pill,
      '<svg viewBox="0 0 16 16" fill="none"><rect x="2" y="5.5" width="12" height="5" rx="2.5" stroke="currentColor" stroke-width="1.3"/></svg>',
      tb.pillNone
    );
  }
  if (b.picker === "textColor") {
    return buildColorPicker(
      idPrefix + "TextColorPicker", idPrefix + "TextColorPickerBtn", idPrefix + "TextColorSwatches", tb.textColor,
      '<svg viewBox="0 0 16 16" fill="none"><text x="2" y="11" font-size="10" font-weight="700" fill="currentColor">A</text><rect x="2" y="13" width="11" height="2" rx="1" fill="currentColor"/></svg>',
      tb.textColorNone
    );
  }
  if (b.picker === "quoteColor") {
    return buildColorPicker(
      idPrefix + "QuoteColorPicker", idPrefix + "QuoteColorPickerBtn", idPrefix + "QuoteColorSwatches", tb.quoteColor,
      '<svg viewBox="0 0 16 16" fill="none"><rect x="3" y="2.5" width="2.3" height="11" rx="1.15" fill="currentColor"/><path d="M8.3 5h4M8.3 8h4M8.3 11h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
      tb.quoteColorNone
    );
  }
  const inner = b.svg || b.label || "";
  const title = b.titleKey ? tb[b.titleKey] : "";
  return `<button type="button" data-cmd="${b.cmd}" data-value="${b.value || ""}" title="${title}" style="${b.style || ""}">${inner}</button>`;
}

// ---------- rich-text editor ----------
function buildNoteEditor(containerEl: HTMLElement, idPrefix: string, noteId: string | null, onSaved: () => void) {
  const seed = noteId ? notes.find((n) => n.id === noteId) : undefined;
  if (!seed) {
    containerEl.innerHTML = `<div class="editor-empty">${escapeHtml(strings().editorEmpty)}</div>`;
    return;
  }
  const s = strings();

  function currentNote(): Note | undefined {
    return noteId ? notes.find((n) => n.id === noteId) : undefined;
  }

  const toolbarHtml = `<div class="toolbar" id="${idPrefix}Toolbar">${TOOLBAR_BUTTONS.map((b) => renderToolbarButton(b, idPrefix)).join("")}</div>`;

  containerEl.innerHTML =
    toolbarHtml +
    `<div class="title-row"><input class="note-title-input" id="${idPrefix}TitleInput" placeholder="${escapeHtml(s.titlePlaceholder)}" value="${escapeHtml(seed.title)}" /></div>` +
    `<div class="editor-scroll"><div class="editor-surface" id="${idPrefix}EditorSurface" contenteditable="true" data-placeholder="${escapeHtml(s.bodyPlaceholder)}"></div></div>` +
    `<div class="editor-foot"><span class="save-state"><span class="pip" id="${idPrefix}SavePip"></span><span id="${idPrefix}SavedAgo">${escapeHtml(s.savedPrefix + s.savedInstant)}</span></span><span id="${idPrefix}WordCount">${escapeHtml(s.wordsCount(0))}</span></div>`;

  const surface = document.getElementById(idPrefix + "EditorSurface") as HTMLElement;
  // A brand-new note starts with html: "" — surface.innerHTML = "" leaves surface with no element
  // content at all, so the very first character typed lands as a loose text node with no block
  // wrapper around it (invisible to getTouchedBlocks() et al, same class of bug as the stray <div>
  // fixed above), and the first Enter press has no existing <p> to split, so the browser falls back
  // to inserting a bare <br> instead — a visibly shorter gap than a real paragraph break, since it
  // skips the block's own margin. Seeding an empty note with one real (empty) paragraph instead gives
  // typing a block to land in and Enter a block to split from the very first keystroke; the placeholder
  // still shows normally since updateEmptyState() checks textContent, not innerHTML.
  surface.innerHTML = seed.html || "<p><br></p>";
  updateEmptyState();
  updateWordCount();

  // Chrome's contenteditable defaults to wrapping a new line (e.g. pressing Enter right after
  // exiting a list) in a plain <div> instead of a <p> — that div is invisible to every block-aware
  // function in this file (getTouchedBlocks/blockAt/setBlockType only recognize P/H1/H2/BLOCKQUOTE/
  // UL/OL as top-level blocks), so anything typed into it, including pills and color, silently never
  // participates in formatting at all. Telling the browser to use <p> instead makes every block it
  // creates on its own something our own code already understands. Re-applied on focus since it's a
  // document-level setting another editable region (the title input, another note's panel) could
  // otherwise leave in a different state.
  document.execCommand("defaultParagraphSeparator", false, "p");
  surface.addEventListener("focus", () => {
    document.execCommand("defaultParagraphSeparator", false, "p");
  });

  // Our own undo/redo stack. contenteditable's native Ctrl+Z only tracks changes made via
  // execCommand — our custom DOM surgery (dividers, list-clearing, color spans via Range) never
  // gets recorded there, so mixing the two desyncs the native history and Ctrl+Z misbehaves
  // (skips steps, half-undoes a divider, etc.). We snapshot innerHTML ourselves and fully own
  // undo/redo instead of ever invoking the browser's built-in contenteditable undo.
  const history: string[] = [];
  const future: string[] = [];
  let restoringHistory = false;
  let typingBurstTimer: ReturnType<typeof setTimeout> | null = null;
  let wordCountTimer: ReturnType<typeof setTimeout> | null = null;

  function pushHistory() {
    if (restoringHistory) return;
    history.push(surface.innerHTML);
    if (history.length > 100) history.shift();
    future.length = 0;
  }
  function afterHistoryRestore() {
    const n = currentNote();
    if (n) n.html = surface.innerHTML;
    updateEmptyState();
    updateWordCount();
    updateToolbarState();
    scheduleSave();
  }
  function undo() {
    if (!history.length) return;
    future.push(surface.innerHTML);
    const prev = history.pop()!;
    restoringHistory = true;
    surface.innerHTML = prev;
    restoringHistory = false;
    afterHistoryRestore();
  }
  function redo() {
    if (!future.length) return;
    history.push(surface.innerHTML);
    const next = future.pop()!;
    restoringHistory = true;
    surface.innerHTML = next;
    restoringHistory = false;
    afterHistoryRestore();
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // The "Guardado hace..." label previously flipped to its saved text the instant a keystroke
  // scheduled a save, not when the write actually reached room metadata 400ms later - so it read
  // "saved" the whole time a change was still only pending. It now shows a distinct pending state
  // until persist() genuinely resolves.
  function setSaveIndicator(pending: boolean) {
    const savedAgoEl = document.getElementById(idPrefix + "SavedAgo");
    const pipEl = document.getElementById(idPrefix + "SavePip");
    if (savedAgoEl) savedAgoEl.textContent = pending ? strings().savingLabel : strings().savedPrefix + strings().savedInstant;
    if (pipEl) pipEl.classList.toggle("pending", pending);
  }
  function scheduleSave() {
    const n = currentNote();
    if (!n) return;
    n.updatedAt = Date.now();
    if (saveTimer) clearTimeout(saveTimer);
    setSaveIndicator(true);
    const fire = async () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (pendingSaveFlush === fire) pendingSaveFlush = null;
      await persist();
      setSaveIndicator(false);
      onSaved();
    };
    pendingSaveFlush = fire;
    saveTimer = setTimeout(fire, 400);
  }

  (document.getElementById(idPrefix + "TitleInput") as HTMLInputElement).addEventListener("input", function (this: HTMLInputElement) {
    const n = currentNote();
    if (!n) return;
    n.title = this.value;
    scheduleSave();
  });

  document.getElementById(idPrefix + "Toolbar")!.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button[data-cmd]") as HTMLElement | null;
    if (!btn) return;
    pushHistory();
    surface.focus();
    const cmd = btn.dataset.cmd!;
    const value = btn.dataset.value || undefined;
    if (cmd === "formatBlock") {
      setBlockType(((value || "P").toUpperCase()) as "P" | "H1" | "H2" | "BLOCKQUOTE");
    } else if (cmd === "divider") {
      insertDivider();
    } else if (cmd === "removeFormat") {
      clearFormatting();
    } else {
      document.execCommand(cmd, false, value);
      // Chrome's own insertUnorderedList/insertOrderedList occasionally wraps the new <ul>/<ol>
      // INSIDE the paragraph it was converting instead of replacing it — most reliably reproduced by
      // clicking a list button on a fresh note's lone starter paragraph — leaving a <p><ul>...</ul></p>
      // that every block-detection helper in this file (blockAt included) doesn't know how to see
      // through, since they all assume lists sit directly under `surface` like every other block.
      if (cmd === "insertUnorderedList" || cmd === "insertOrderedList") {
        unwrapNestedLists();
      }
    }
    removeEditorNoise();
    // Only underline/strikeThrough/removeFormat can change which spans need their decoration-line
    // color recomputed — bold, italic, headings, quote, divider and lists never touch text-decoration
    // at all. syncTextDecorationColors() rescans every colored span in the WHOLE note, so calling it
    // unconditionally after every toolbar click (as before) was pure wasted work for most of them,
    // scaling with note length on every single click regardless of which button was pressed.
    if (cmd === "underline" || cmd === "strikeThrough" || cmd === "removeFormat") {
      syncTextDecorationColors();
    }
    const n = currentNote();
    if (n) n.html = surface.innerHTML;
    scheduleSave();
    updateEmptyState();
    updateToolbarState();
  });

  function wireColorPicker(btnId: string, swatchesId: string, onColor: (hex: string) => void, onNone?: () => void) {
    const btn = document.getElementById(btnId);
    const sw = document.getElementById(swatchesId);
    if (!btn || !sw) return;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      surface.focus();
      const willOpen = sw.hidden;
      sw.hidden = !willOpen;
      btn.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        // Swatches open left-anchored to their button by default (CSS left:0), which runs the
        // dropdown off the panel's right edge once it's narrow enough that a button sitting further
        // right in the toolbar doesn't have ~260px of room left. Simply flipping to right-anchored
        // instead just traded that for overflowing the LEFT edge in the opposite case (a button near
        // the start of a narrow panel). Clamping an explicit pixel offset into the panel's actual
        // bounds — instead of a left/right binary choice — is the only version of this that can't
        // overflow either side, regardless of where the button sits or how narrow the panel is.
        sw.style.left = "0px";
        const pickerEl = btn.closest(".pill-picker") as HTMLElement;
        const pickerLeft = pickerEl.getBoundingClientRect().left;
        const swWidth = sw.getBoundingClientRect().width;
        const panelRect = panel.getBoundingClientRect();
        const margin = 4;
        const maxLeft = panelRect.right - margin - swWidth;
        const minLeft = panelRect.left + margin;
        const clampedLeft = Math.min(Math.max(pickerLeft, minLeft), maxLeft);
        sw.style.left = `${clampedLeft - pickerLeft}px`;
      }
    });
    sw.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest("button[data-color]") as HTMLElement | null;
      if (!b) return;
      ev.stopPropagation();
      pushHistory();
      const color = b.dataset.color;
      if (color) { onColor(color); } else if (onNone) { onNone(); }
      sw.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      const n = currentNote();
      if (n) n.html = surface.innerHTML;
      scheduleSave();
      updateEmptyState();
      updateToolbarState();
    });
  }

  wireColorPicker(idPrefix + "PillPickerBtn", idPrefix + "PillSwatches", applyPillColor, removePillAtSelection);
  wireColorPicker(idPrefix + "TextColorPickerBtn", idPrefix + "TextColorSwatches", applyTextColor, resetTextColor);
  wireColorPicker(idPrefix + "QuoteColorPickerBtn", idPrefix + "QuoteColorSwatches", applyQuoteColor, removeQuote);

  // Same one-picker-does-both pattern as the pill picker: picking a color both turns the current
  // block into a quote (if it isn't one already) AND colors its left bar via a `--quote-c` custom
  // property (same pattern as pills' `--pill-c`); the picker's "none" swatch removes the quote
  // formatting entirely, rather than just resetting the color on an already-existing one — there's no
  // separate plain "quote" toggle button anymore.
  function getQuoteAtSelection(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const block = blockAt(sel.getRangeAt(0).startContainer);
    return block && block.tagName === "BLOCKQUOTE" ? block : null;
  }
  function applyQuoteColor(hex: string) {
    // Coloring ONLY the block getQuoteAtSelection() finds (just the one at the selection's start)
    // was the bug behind "the second of two selected lines gets the base color instead of the one I
    // picked" — a multi-block selection converts ALL of them to quotes, but only ever colored the
    // first. touched/result cover every block the selection spans, not just its start.
    const touched = getTouchedBlocks();
    const alreadyAllQuotes = touched.length > 0 && touched.every((b) => b.tagName === "BLOCKQUOTE");
    const result = alreadyAllQuotes ? touched : setBlockType("BLOCKQUOTE");
    result.forEach((b) => {
      if (b.tagName === "BLOCKQUOTE") b.style.setProperty("--quote-c", hex);
    });
  }
  function removeQuote() {
    if (getTouchedBlocks().some((b) => b.tagName === "BLOCKQUOTE")) setBlockType("P");
  }

  // Wraps the selection in our own <span style="color:...">, rather than execCommand("foreColor"),
  // so it always ends up as the OUTERMOST element around any <u>/<s> inside it — with execCommand,
  // the browser sometimes nests the color span *inside* an existing <u>, and text-decoration draws
  // in the <u>'s own (uncolored) color instead of inheriting the new one, so underlines stayed unchanged.
  function applyTextColor(hex: string) {
    surface.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return;
    if (range.collapsed) {
      document.execCommand("foreColor", false, hex);
      return;
    }
    const span = document.createElement("span");
    span.style.color = hex;
    try {
      range.surroundContents(span);
    } catch {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.addRange(newRange);
    // Only text color interacts with underline/strikethrough color at all (pills and quote colors
    // don't touch text-decoration) — scoped here instead of unconditionally after every color pick,
    // which used to rescan every colored span in the whole note for pill/quote-color picks too, work
    // that could never have found anything to change for them.
    syncTextDecorationColors();
  }
  function resetTextColor() {
    const computed = getComputedStyle(panel).getPropertyValue("--text-primary").trim() || "#000000";
    applyTextColor(computed);
  }

  // text-decoration set on an ancestor (e.g. a toolbar-created <u>/<s>) keeps painting in THAT
  // ancestor's own original color in most browsers even after a descendant span overrides the text
  // color — the override never reaches the decoration line. Re-declaring the decoration directly on
  // the colored span itself sidesteps that: a decoration declared on the same element as the color
  // unambiguously uses that element's own color.
  function syncTextDecorationColors() {
    Array.prototype.slice.call(surface.querySelectorAll('span[style*="color"]')).forEach((span: HTMLElement) => {
      const deco: string[] = [];
      let el = span.parentElement;
      while (el && el !== surface) {
        if (el.tagName === "U") deco.push("underline");
        if (el.tagName === "S" || el.tagName === "STRIKE") deco.push("line-through");
        el = el.parentElement;
      }
      span.style.textDecorationLine = deco.length ? deco.join(" ") : "";
    });
  }

  function getPillAtSelection(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    // startContainer, not commonAncestorContainer: for a selection that starts inside a pill but
    // extends past its end, the common ancestor is a shared parent OUTSIDE the pill (e.g. the
    // enclosing paragraph), so this used to report "not in a pill" even though the selection clearly
    // starts in one — and picking a color would then create a new, overlapping pill instead of
    // recoloring the existing one. startContainer matches what blockAt()/getQuoteAtSelection() already
    // use, and matches the cursor-based intent ("the pill I'm sitting in/starting from") better.
    const node = sel.getRangeAt(0).startContainer;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    const pillEl = el && el.closest ? (el.closest(".note-pill") as HTMLElement | null) : null;
    return pillEl && surface.contains(pillEl) ? pillEl : null;
  }
  function applyPillColor(hex: string) {
    const existing = getPillAtSelection();
    if (existing) {
      existing.style.setProperty("--pill-c", hex);
      return;
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer) || range.collapsed) return;
    const span = document.createElement("span");
    span.className = "note-pill";
    span.style.setProperty("--pill-c", hex);
    try {
      range.surroundContents(span);
    } catch {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.addRange(newRange);
  }
  function removePillAtSelection() {
    const existing = getPillAtSelection();
    if (existing) {
      const text = document.createTextNode(existing.textContent || "");
      existing.replaceWith(text);
    }
  }

  // The block-level element (P/H1/H2/BLOCKQUOTE/UL/OL) that's a DIRECT CHILD of `surface` and
  // contains `node` — the level our own block-type toggling and clear-formatting operate at,
  // mirroring liAt()/topOf() for lists below.
  function blockAt(node: Node): HTMLElement | null {
    let el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    // A click/selection that lands in the editor's own padding rather than squarely inside a child
    // (most reachable right above the very first block, since that's the only block bordering the
    // surface's own top padding) can report `surface` itself as the container — climbing from there
    // used to keep walking into surface's OWN ancestors outside the editor entirely, silently
    // returning nothing usable and making toolbar buttons intermittently do nothing, especially for
    // whatever's in the first row. Bail out to null immediately whenever we're not starting from
    // somewhere actually inside the editor's content.
    if (!el || el === surface || !surface.contains(el)) return null;
    while (el.parentElement && el.parentElement !== surface) {
      el = el.parentElement;
    }
    return el.parentElement === surface ? el : null;
  }

  // Unwraps any P/H1/H2/BLOCKQUOTE nested INSIDE `block` into its parent, leaving only inline
  // content — cleans up a block that ended up with headings nested inside each other (from repeated
  // heading-button clicks before setBlockType existed, or from any future formatBlock hiccup), which
  // `document.execCommand("formatBlock", false, "P")` only ever converts the outermost wrapper of,
  // leaving inner heading tags — and the font size they carry — behind.
  function flattenNestedBlocks(block: HTMLElement) {
    let nested = block.querySelector("h1, h2, blockquote, p");
    while (nested) {
      const parent = nested.parentNode!;
      while (nested.firstChild) parent.insertBefore(nested.firstChild, nested);
      parent.removeChild(nested);
      nested = block.querySelector("h1, h2, blockquote, p");
    }
  }

  // Every top-level block (direct child of `surface`) the current selection touches, in document
  // order — read-only, shared by setBlockType() (which then mutates them) and by the quote-color
  // picker (which needs to know what's ALREADY there before deciding whether to convert or just
  // recolor — see applyQuoteColor).
  function getTouchedBlocks(): HTMLElement[] {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return [];

    // Walking startContainer/endContainer up to their top-level block (via blockAt) and slicing
    // surface.children between those two indices used to miss blocks whenever either endpoint
    // resolved to something blockAt can't place (e.g. landing in the editor's own padding past the
    // last block, the same class of edge case the "row 1" bug came from) — that silently dropped
    // everything from that endpoint on, so a selection spanning list/text/list only ever "saw" the
    // first list. Checking every top-level child directly against the range with intersectsNode
    // sidesteps container-resolution entirely: no endpoint to misplace.
    const candidates = Array.prototype.slice.call(surface.children) as HTMLElement[];
    return candidates.filter(
      (el) => /^(P|H1|H2|BLOCKQUOTE|UL|OL)$/.test(el.tagName) && range.intersectsNode(el)
    );
  }

  // Sets the block-level tag of every top-level block the selection touches, by REPLACING each block
  // element outright rather than asking the browser to do it via execCommand("formatBlock"). Browsers
  // don't reliably no-op or swap the tag when formatBlock is applied again to a block that's already
  // that type — it can instead wrap a new heading INSIDE the existing one, and since heading sizes are
  // set in `em`, each nested wrapper compounds the previous one's size on top of its own, which is
  // exactly what clicking a heading button repeatedly looked like: the text kept growing.
  // Returns the resulting blocks (in the same order), so a caller like applyQuoteColor can act on
  // exactly what's there now — the selection itself collapses to a single caret position by the time
  // this returns (see placeCaretAtStart below), so re-deriving "what did we just touch" from the
  // selection afterward would only ever see one of them again.
  function setBlockType(tag: "P" | "H1" | "H2" | "BLOCKQUOTE"): HTMLElement[] {
    const blocks = getTouchedBlocks();
    if (!blocks.length) return [];

    // Toggle: re-clicking a heading that's already applied to every touched block reverts to a
    // plain paragraph instead of re-applying (and re-nesting) the same tag.
    const allMatch = blocks.every((b) => b.tagName === tag);
    const finalTag = allMatch ? "P" : tag;

    const result: HTMLElement[] = [];
    let firstNew: HTMLElement | null = null;
    blocks.forEach((b) => {
      if (b.tagName === finalTag) {
        if (!firstNew) firstNew = b;
        result.push(b);
        return;
      }
      const nb = document.createElement(finalTag);
      if (b.tagName === "UL" || b.tagName === "OL") {
        // A list's <li>s are only valid inside a <ul>/<ol> — unpacking them straight into the new
        // block (like every other case here does) leaves them with no list ancestor at all, which
        // browsers render with the bullet/number completely mispositioned, overlapping whatever's to
        // their left (a quote's border bar, in the report that caught this). Keeping the list intact
        // as a single child preserves its own bullets/numbers/nesting exactly as they were.
        b.replaceWith(nb);
        nb.appendChild(b);
      } else {
        flattenNestedBlocks(b);
        while (b.firstChild) nb.appendChild(b.firstChild);
        if (!nb.hasChildNodes()) nb.innerHTML = "<br>";
        b.replaceWith(nb);
      }
      if (!firstNew) firstNew = nb;
      result.push(nb);
    });
    if (firstNew) placeCaretAtStart(firstNew);
    return result;
  }

  // execCommand("removeFormat") only strips inline styles (bold/italic/...) — it never touches the
  // block type or our custom pills, which is why the button looked like it "did nothing" on a
  // heading/quote/pill. This normalizes all of it back to a plain paragraph.
  function clearFormatting() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return;

    // stripAllListsAtSelection() tracks precisely which list items the selection touches, via the
    // LIVE selection — but it collapses that selection to a single caret when it's done (like
    // setBlockType() does), so if the ORIGINAL selection also spanned a paragraph/heading/quote
    // outside the list, that part silently stopped being what setBlockType() sees next. Reserve that
    // precise per-item behavior for the common case (a selection that's ONLY list content); once
    // other block types are mixed in too, flatten any touched list wholesale instead — the selection
    // is already asking to convert everything else in the same span down to plain paragraphs, so
    // preserving exactly which list items were covered stops being worth the added complexity.
    const originalBlocks = getTouchedBlocks();
    const touchesList = originalBlocks.some((b) => b.tagName === "UL" || b.tagName === "OL");
    const touchesOther = originalBlocks.some((b) => b.tagName !== "UL" && b.tagName !== "OL");

    if (touchesList && touchesOther) {
      const flattened = originalBlocks.flatMap((b) =>
        b.tagName === "UL" || b.tagName === "OL" ? flattenListBlock(b) : [b]
      );
      if (!flattened.length) return;
      const spanRange = document.createRange();
      spanRange.setStart(flattened[0], 0);
      spanRange.setEnd(flattened[flattened.length - 1], flattened[flattened.length - 1].childNodes.length);
      sel.removeAllRanges();
      sel.addRange(spanRange);
    } else {
      stripAllListsAtSelection();
    }

    const blocks = setBlockType("P");

    // setBlockType() collapses the selection to a single caret in the FIRST converted block (that's
    // its own contract — see its comment). Restoring a selection spanning every block it actually
    // touched, before the two steps below run, is what makes THEM also apply to every block instead
    // of just that first one: without this, "clear formatting" across a multi-paragraph selection
    // correctly converted every block to plain text, but silently only ever stripped bold/italic/
    // color/pills from the first paragraph, leaving the rest formatted.
    if (blocks.length) {
      const first = blocks[0];
      const last = blocks[blocks.length - 1];
      const full = document.createRange();
      full.setStart(first, 0);
      full.setEnd(last, last.childNodes.length);
      sel.removeAllRanges();
      sel.addRange(full);
    }

    // Strip our own hand-rolled pills and color spans FIRST, before execCommand("removeFormat") runs
    // — not after. <span> is one of the elements the native command is spec'd to reach into, and in
    // practice it was stripping just enough of a pill's class/style to break OUR OWN class/style-based
    // lookup if run afterward (its --pill-c custom property survived, since removeFormat only touches
    // recognized formatting properties, but the plain "font-weight: bold" look was gone) — leaving an
    // unrecognizable, half-stripped span behind instead of the plain text we wanted. Converting them
    // to plain text up front sidesteps that: there's nothing custom left in the selection by the time
    // the native command runs, so it only ever has real bold/italic/underline/etc. left to clean up
    // (including whatever was inside the pill's own text).
    blocks.forEach((block) => {
      Array.prototype.slice.call(block.querySelectorAll(".note-pill")).forEach((pill: HTMLElement) => {
        const text = document.createTextNode(pill.textContent || "");
        pill.replaceWith(text);
      });
      Array.prototype.slice.call(block.querySelectorAll('span[style*="color"]')).forEach((span: HTMLElement) => {
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
      });
    });

    document.execCommand("removeFormat", false, undefined);
  }
  function placeCaretAtStart(el: HTMLElement) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // Turns one <li> into a <p>. A browser's own execCommand("indent") (our Tab-to-nest) places a
  // sub-<ul>/<ol> as a SIBLING immediately after the <li> it belongs to, not as that <li>'s child —
  // so the sub-list's own <li>s are found via nextElementSibling here, flattened recursively too,
  // and the now-drained sub-list removed - otherwise clearing an item with a sub-list left the
  // nested bullets behind as their own orphaned list (or, if that sibling <ul> got misidentified as
  // plain content, a stray <li> ended up wrapped inside a <p>, an invalid, visibly broken result).
  function flattenListItemToParagraphs(li: HTMLElement): HTMLElement[] {
    const p = document.createElement("p");
    Array.prototype.slice.call(li.childNodes).forEach((child: ChildNode) => {
      p.appendChild(child);
    });
    if (!p.hasChildNodes()) p.innerHTML = "<br>";
    const result: HTMLElement[] = [p];
    const nextSibling = li.nextElementSibling;
    if (nextSibling && /^(UL|OL)$/i.test(nextSibling.tagName)) {
      Array.prototype.slice.call(nextSibling.children).forEach((childLi: HTMLElement) => {
        if (childLi.tagName === "LI") result.push(...flattenListItemToParagraphs(childLi));
      });
      nextSibling.remove();
    }
    return result;
  }

  // Converts EVERY <li> in `list` (its own direct top-level items, recursing into nested sub-lists
  // the same way flattenListItemToParagraphs already does) into a run of <p> elements replacing the
  // whole list. Used by clearFormatting() only for the mixed-selection case (a list touched together
  // with some other block type) — unlike stripAllListsAtSelection() below, this doesn't try to figure
  // out exactly which items the selection covers, it flattens the entire block.
  function flattenListBlock(list: HTMLElement): HTMLElement[] {
    const items = Array.prototype.slice.call(list.children) as HTMLElement[];
    const result: HTMLElement[] = [];
    items.forEach((li) => {
      if (li.tagName === "LI") result.push(...flattenListItemToParagraphs(li));
    });
    if (result.length) {
      list.replaceWith(...result);
    } else {
      list.remove();
    }
    return result;
  }

  // Chrome's own editing commands occasionally leave inert residue behind: an empty <span> with
  // nothing in it, or a <span style="background-color: transparent"> wrapping otherwise-plain text —
  // background-color is never something this codebase itself sets (bold/italic/pill/quote-color all
  // use other properties), so a transparent one is always the browser's own no-op leftover, not
  // anything the user asked for. Neither changes how the note looks, but both get persisted to room
  // metadata forever otherwise, which matters given the shared 16 KB storage cap.
  function removeEditorNoise() {
    Array.prototype.slice.call(surface.querySelectorAll("span")).forEach((span: HTMLElement) => {
      if (span.classList.contains("note-pill")) return;
      if (span.style.backgroundColor === "transparent") span.style.removeProperty("background-color");
      if (!span.hasChildNodes()) {
        span.remove();
        return;
      }
      if (!span.className && !span.getAttribute("style")) {
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
      }
    });
  }

  // Un-nests a <ul>/<ol> that ended up wrapped inside a <p>/<h1>/<h2>/<blockquote> instead of sitting
  // directly under `surface` like every other block (see the insertUnorderedList/insertOrderedList
  // call site above). Moves the wrapper's own children — the list, plus anything else it happens to
  // contain — up to take its place; a wrapper left with nothing afterward is removed entirely.
  function unwrapNestedLists() {
    Array.prototype.slice.call(surface.children).forEach((el: HTMLElement) => {
      if (!/^(P|H1|H2|BLOCKQUOTE)$/.test(el.tagName)) return;
      if (!el.querySelector(":scope > ul, :scope > ol")) return;
      while (el.firstChild) el.parentElement!.insertBefore(el.firstChild, el);
      el.remove();
    });
  }

  // Fully de-lists every top-level item the current selection touches — a plain caret only touches
  // one, but a drag-selection across several bullets (nested or not) must clear all of them, not
  // just whichever single <li> happens to be the selection's commonAncestorContainer (which is
  // often the shared <ul> itself once more than one item is selected, matching no <li> at all).
  function stripAllListsAtSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);

    function liAt(node: Node): HTMLElement | null {
      const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
      return el && el.closest ? (el.closest("li") as HTMLElement | null) : null;
    }
    // Climbs from a nested <li> to the top-level <li> that "owns" it. Since a sub-list sits as a
    // SIBLING of its owning <li> (see flattenListItemToParagraphs above), not as its child, the
    // relationship to climb is "my list's previous sibling", not "my nearest ancestor <li>".
    function topOf(li: HTMLElement): HTMLElement {
      let current = li;
      for (;;) {
        const parentList = current.parentElement;
        if (!parentList || !surface.contains(parentList)) break;
        const prevSibling = parentList.previousElementSibling;
        if (prevSibling && prevSibling.tagName === "LI") {
          current = prevSibling as HTMLElement;
          continue;
        }
        break;
      }
      return current;
    }

    const startLi = liAt(range.startContainer);
    const endLi = liAt(range.endContainer);
    let touchedTop: HTMLElement[] = [];
    if (startLi && surface.contains(startLi)) touchedTop.push(topOf(startLi));
    if (endLi && surface.contains(endLi)) {
      const endTop = topOf(endLi);
      if (!touchedTop.includes(endTop)) touchedTop.push(endTop);
    }
    if (!touchedTop.length) return;

    // start/end landed in two different top-level items: sweep every top-level sibling between
    // them too, so a drag-selection across several bullets clears the whole run.
    if (touchedTop.length === 2 && touchedTop[0].parentElement === touchedTop[1].parentElement) {
      const siblings = Array.prototype.slice.call(touchedTop[0].parentElement!.children) as HTMLElement[];
      const i0 = siblings.indexOf(touchedTop[0]);
      const i1 = siblings.indexOf(touchedTop[1]);
      // the slice can include a sibling <ul>/<ol> sitting between two <li>s (a nested sub-list) —
      // that gets absorbed by its owning <li>'s own flattenListItemToParagraphs call, not processed
      // as its own "top" item, so filter it out here.
      touchedTop = siblings.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).filter((el) => el.tagName === "LI");
    }

    let firstParagraph: HTMLElement | null = null;
    touchedTop.forEach((topLi) => {
      const list = topLi.parentElement!;
      const listParent = list.parentElement!;
      const paragraphs = flattenListItemToParagraphs(topLi);
      if (!firstParagraph) firstParagraph = paragraphs[0];

      const afterList = document.createElement(list.tagName);
      while (topLi.nextSibling) afterList.appendChild(topLi.nextSibling);
      topLi.remove();

      let insertAfter: HTMLElement = list;
      paragraphs.forEach((p) => {
        listParent.insertBefore(p, insertAfter.nextSibling);
        insertAfter = p;
      });
      if (afterList.childNodes.length) {
        listParent.insertBefore(afterList, insertAfter.nextSibling);
      }
      if (!list.hasChildNodes()) list.remove();
    });

    if (firstParagraph) placeCaretAtStart(firstParagraph);
  }

  // Inserts <hr> as a sibling of the whole block the caret is in (splitting it if needed),
  // rather than as a raw DOM node at the text offset — an <hr> can never nest inside a <p>/<blockquote>,
  // and that stray nesting was what also confused the formatBlock toggle afterwards.
  function insertDivider() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return;
    range.deleteContents();

    // Shares blockAt() rather than keeping its own copy of the same climb — this used to be a
    // separate, near-identical loop that didn't get the surface-boundary guard blockAt() needed for
    // the first-row heading/quote bug, and could easily have drifted out of sync silently again.
    const block = blockAt(range.startContainer);

    // A caret anywhere inside a list — top-level or nested — resolves `block` to the WHOLE <ul>/<ol>
    // (nested sub-lists sit as siblings of their owning <li> inside the same outer list, not inside
    // it, so blockAt() always climbs all the way to the outermost list; see stripAllListsAtSelection).
    // Splitting that the same way a paragraph gets split below would extract raw text/inline content
    // straight into a freshly cloned list with no <li> wrapper around it — invalid markup that renders
    // with no bullet and misaligned, the same class of breakage the quote-wrapping-a-list bug was.
    // Properly splitting a list in place would mean replicating this file's list-splitting logic
    // (already intricate specifically because of that sibling-nesting) just for an occasional
    // mid-list divider insert, so instead we simply place the divider right after the whole list.
    if (!block || block.tagName === "UL" || block.tagName === "OL") {
      const hr0 = document.createElement("hr");
      const p0 = document.createElement("p");
      p0.innerHTML = "<br>";
      if (block) {
        block.after(hr0);
        hr0.after(p0);
      } else {
        surface.appendChild(hr0);
        surface.appendChild(p0);
      }
      placeCaretAtStart(p0);
      return;
    }

    let tail: DocumentFragment;
    if (block.hasChildNodes()) {
      const splitRange = document.createRange();
      splitRange.setStart(range.startContainer, range.startOffset);
      splitRange.setEndAfter(block.lastChild!);
      tail = splitRange.extractContents();
    } else {
      tail = document.createDocumentFragment();
    }

    const newBlock = block.cloneNode(false) as HTMLElement;
    newBlock.appendChild(tail);
    if (!newBlock.hasChildNodes()) newBlock.innerHTML = "<br>";
    if (!block.hasChildNodes()) block.innerHTML = "<br>";

    const hr = document.createElement("hr");
    block.after(hr);
    hr.after(newBlock);
    placeCaretAtStart(newBlock);
  }

  // Groups a burst of continuous typing into a single undo step: only snapshot at the START of a
  // burst (first keystroke after a pause), not on every character.
  // Pasting from another app brings ALL of its source formatting along by default — fonts, colors,
  // background-color, sizes — none of which this codebase's own toolbar can produce or represents in
  // its own model, so it becomes exactly the kind of unrecognized noise removeEditorNoise() exists to
  // clean up, just at a much larger scale than one leftover span. Taking only the plain-text flavor
  // and running it through markdownToHtml() sidesteps that source formatting entirely while still
  // recognizing markdown syntax the pasted text itself might use (headings, lists, bold/italic, etc.)
  // and turning it into this editor's own real blocks instead of leaving literal "**"/"#"/"-" markers
  // sitting in the note.
  surface.addEventListener("paste", (ev: ClipboardEvent) => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    document.execCommand("insertHTML", false, markdownToHtml(text));
    unwrapNestedLists();
    removeEditorNoise();
  });
  surface.addEventListener("beforeinput", () => {
    if (restoringHistory) return;
    if (!typingBurstTimer) pushHistory();
    if (typingBurstTimer) clearTimeout(typingBurstTimer);
    typingBurstTimer = setTimeout(() => { typingBurstTimer = null; }, 700);
  });
  surface.addEventListener("input", () => {
    const n = currentNote();
    if (n) n.html = surface.innerHTML;
    updateEmptyState();
    scheduleWordCountUpdate();
    scheduleSave();
  });
  surface.addEventListener("keydown", (ev) => {
    const key = ev.key.toLowerCase();
    const isUndo = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && key === "z";
    const isRedo = (ev.ctrlKey || ev.metaKey) && (key === "y" || (ev.shiftKey && key === "z"));
    if (isUndo) { ev.preventDefault(); undo(); return; }
    if (isRedo) { ev.preventDefault(); redo(); return; }
    if (ev.key !== "Tab") return;
    let inList = false;
    try { inList = document.queryCommandState("insertUnorderedList") || document.queryCommandState("insertOrderedList"); } catch { /* ignore */ }
    if (!inList) return;
    ev.preventDefault();
    pushHistory();
    document.execCommand(ev.shiftKey ? "outdent" : "indent", false, undefined);
    const n = currentNote();
    if (n) n.html = surface.innerHTML;
    scheduleSave();
    updateEmptyState();
    updateToolbarState();
  });
  surface.addEventListener("keyup", updateToolbarState);
  surface.addEventListener("mouseup", updateToolbarState);

  function updateEmptyState() {
    const isEmpty = surface.textContent!.replace(/​/g, "").trim() === "";
    surface.classList.toggle("is-empty", isEmpty);
  }
  function updateWordCount() {
    const text = stripHtml(surface.innerHTML);
    const words = text.length ? text.split(/\s+/).filter(Boolean).length : 0;
    document.getElementById(idPrefix + "WordCount")!.textContent = strings().wordsCount(words);
  }
  // stripHtml() re-parses the WHOLE note's HTML into a scratch DOM element to extract plain text —
  // fine for the occasional call (initial load, undo/redo), but the "input" listener fires on every
  // single keystroke, and re-parsing the entire note on every keystroke scales with note length: a
  // long session-notes document made every keystroke pay an O(note size) cost, compounding into a
  // typing session that gets slower the longer the note gets. Debouncing it the same way scheduleSave
  // already debounces persistence (just faster, since it's only a local UI label, not a network write)
  // keeps the label fresh without paying that cost on every individual character.
  function scheduleWordCountUpdate() {
    if (wordCountTimer) clearTimeout(wordCountTimer);
    wordCountTimer = setTimeout(() => {
      wordCountTimer = null;
      updateWordCount();
    }, 250);
  }
  function updateToolbarState() {
    const cmds = ["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"];
    cmds.forEach((cmd) => {
      const b = document.querySelector(`#${idPrefix}Toolbar button[data-cmd="${cmd}"]`);
      if (!b) return;
      let on = false;
      try { on = document.queryCommandState(cmd); } catch { /* ignore */ }
      b.classList.toggle("active", on);
    });

    // document.queryCommandValue("formatBlock") is what let heading clicks nest instead of toggle in
    // the first place (see setBlockType) — reading the actual DOM here instead of trusting it keeps
    // this highlight consistent with what setBlockType will actually do on the next click.
    const blockSel = window.getSelection();
    const currentBlockTag = blockSel && blockSel.rangeCount ? blockAt(blockSel.getRangeAt(0).startContainer)?.tagName || "" : "";
    document.querySelectorAll(`#${idPrefix}Toolbar button[data-cmd="formatBlock"]`).forEach((b) => {
      b.classList.toggle("active", (b as HTMLElement).dataset.value!.toUpperCase() === currentBlockTag);
    });

    const pillPickerBtnEl = document.getElementById(idPrefix + "PillPickerBtn");
    if (pillPickerBtnEl) {
      pillPickerBtnEl.classList.toggle("active", !!getPillAtSelection());
    }

    const quoteColorBtnEl = document.getElementById(idPrefix + "QuoteColorPickerBtn");
    if (quoteColorBtnEl) {
      quoteColorBtnEl.classList.toggle("active", !!getQuoteAtSelection());
    }
  }
}

function renderEditor() {
  const active = getActive();
  buildNoteEditor(editorPaneEl, "gm", active ? active.id : null, () => renderList());
}

// ---------- GM note switcher dropdown ----------
const noteSwitcher = document.getElementById("noteSwitcher")!;
const switcherTrigger = document.getElementById("switcherTrigger")!;
const switcherDropdown = document.getElementById("switcherDropdown")!;

function openDropdown() {
  switcherDropdown.hidden = false;
  noteSwitcher.classList.add("open");
  switcherTrigger.setAttribute("aria-expanded", "true");
  searchInput.focus();
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeydown, true);
}
function closeDropdown() {
  if (switcherDropdown.hidden) return;
  switcherDropdown.hidden = true;
  noteSwitcher.classList.remove("open");
  switcherTrigger.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown, true);
}
function onDocPointerDown(ev: Event) {
  if (!noteSwitcher.contains(ev.target as Node)) closeDropdown();
}
function onDocKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") { closeDropdown(); (switcherTrigger as HTMLElement).focus(); }
}
switcherTrigger.addEventListener("click", () => {
  if (switcherDropdown.hidden) openDropdown(); else closeDropdown();
});

document.getElementById("newNoteBtn")!.addEventListener("click", () => void createNote());
searchInput.addEventListener("input", function (this: HTMLInputElement) {
  searchTerm = this.value.trim();
  renderList();
});

// ---------- color pickers: close on outside click ----------
document.addEventListener("click", (ev) => {
  document.querySelectorAll(".pill-picker").forEach((picker) => {
    const swatches = picker.querySelector(".pill-swatches") as HTMLElement | null;
    if (!swatches || swatches.hidden) return;
    if (!picker.contains(ev.target as Node)) {
      swatches.hidden = true;
      const btn = picker.querySelector(".pill-picker-btn");
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
  });
});

// ---------- settings modal: accent override + language ----------
const settingsOverlay = document.getElementById("settingsOverlay")!;
const settingsAccentRow = document.getElementById("settingsAccentRow")!;

function renderAccentOptions() {
  settingsAccentRow.innerHTML = "";
  const s = strings();
  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "accent-swatch accent-swatch-auto";
  autoBtn.dataset.accent = "auto";
  autoBtn.title = s.accentAutoTitle;
  autoBtn.setAttribute("aria-label", s.accentAutoTitle);
  autoBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none"><path d="M6 8a2 2 0 0 1 2-2h3M10 8a2 2 0 0 1-2 2H5" stroke="white" stroke-width="1.4" stroke-linecap="round"/><path d="M9.3 4.7 11 6l-1.7 1.3M6.7 11.3 5 10l1.7-1.3" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  settingsAccentRow.appendChild(autoBtn);

  ACCENT_ORDER.forEach((id) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "accent-swatch";
    b.style.setProperty("--sw", ACCENTS[id].main);
    b.dataset.accent = id;
    b.title = id;
    b.setAttribute("aria-label", id);
    settingsAccentRow.appendChild(b);
  });

  settingsAccentRow.querySelectorAll(".accent-swatch").forEach((b) => {
    b.classList.toggle("is-active", (b as HTMLElement).dataset.accent === accentPref);
  });
}

settingsAccentRow.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button[data-accent]") as HTMLElement | null;
  if (!b) return;
  accentPref = b.dataset.accent as AccentPref;
  void setAccentPref(accentPref);
  setThemeAccent(accentPref);
  renderAccentOptions();
});

function openSettings() {
  renderAccentOptions();
  updateStorageMeter();
  settingsOverlay.hidden = false;
}
function closeSettings() {
  settingsOverlay.hidden = true;
}
document.getElementById("settingsBtn")!.addEventListener("click", openSettings);
document.getElementById("settingsBackdrop")!.addEventListener("click", closeSettings);
document.getElementById("settingsCloseBtn")!.addEventListener("click", closeSettings);

const exportFormatOverlay = document.getElementById("exportFormatOverlay") as HTMLElement;
document.getElementById("exportFormatBackdrop")!.addEventListener("click", closeExportFormatModal);
document.getElementById("exportFormatCloseBtn")!.addEventListener("click", closeExportFormatModal);
document.getElementById("exportFormatJsonBtn")!.addEventListener("click", () => chooseExportFormat("json"));
document.getElementById("exportFormatMdBtn")!.addEventListener("click", () => chooseExportFormat("markdown"));

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!exportFormatOverlay.hidden) closeExportFormatModal();
  else if (!settingsOverlay.hidden) closeSettings();
});

document.getElementById("exportAllBtn")!.addEventListener("click", () => openExportFormatModal("all"));
document.getElementById("importBtn")!.addEventListener("click", () => {
  (document.getElementById("importFileInput") as HTMLInputElement).click();
});
document.getElementById("importFileInput")!.addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.files && input.files.length) void importNotesFromFiles(input.files);
  input.value = "";
});
document.getElementById("clearAllBtn")!.addEventListener("click", () => void clearAllNotesWithConfirm());

document.getElementById("settingsLangRow")!.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button[data-lang]") as HTMLElement | null;
  if (!b || b.dataset.lang === language) return;
  language = b.dataset.lang as Language;
  void setLanguage(language);
  applyLanguage();
});

function applyLanguage() {
  document.documentElement.lang = language;
  const s = strings();
  searchInput.placeholder = s.searchPlaceholder;

  const newNoteBtn = document.getElementById("newNoteBtn")!;
  newNoteBtn.title = s.newNoteTitle;
  newNoteBtn.setAttribute("aria-label", s.newNoteTitle);

  const settingsBtn = document.getElementById("settingsBtn")!;
  settingsBtn.title = s.settingsTitle;
  settingsBtn.setAttribute("aria-label", s.settingsTitle);

  document.getElementById("gmGateSub")!.textContent = s.gmGateSub;
  document.getElementById("resizeHandle")!.title = s.resizeTitle;

  document.getElementById("settingsModalTitle")!.textContent = s.settingsTitle;
  const closeBtn = document.getElementById("settingsCloseBtn")!;
  closeBtn.title = s.settingsClose;
  closeBtn.setAttribute("aria-label", s.settingsClose);
  document.getElementById("settingsStorageLabel")!.textContent = s.settingsStorageLabel;
  document.getElementById("settingsAccentLabel")!.textContent = s.settingsAccentLabel;
  document.getElementById("settingsLangLabel")!.textContent = s.settingsLangLabel;
  document.getElementById("settingsBackupLabel")!.textContent = s.settingsBackupLabel;
  document.getElementById("backupHint")!.textContent = s.backupHint;
  document.getElementById("exportAllBtn")!.textContent = s.exportAllBtn;
  document.getElementById("importBtn")!.textContent = s.importBtn;
  document.getElementById("clearAllBtn")!.textContent = s.clearAllBtn;
  document.getElementById("exportFormatTitle")!.textContent = s.exportFormatTitle;
  document.getElementById("exportFormatHint")!.textContent = s.exportFormatHint;
  document.getElementById("exportFormatJsonBtn")!.textContent = s.exportFormatJsonBtn;
  document.getElementById("exportFormatMdBtn")!.textContent = s.exportFormatMdBtn;
  const exportFormatCloseBtn = document.getElementById("exportFormatCloseBtn")!;
  exportFormatCloseBtn.title = s.settingsClose;
  exportFormatCloseBtn.setAttribute("aria-label", s.settingsClose);
  document.querySelectorAll("#settingsLangRow .opt-btn").forEach((b) => {
    b.classList.toggle("is-active", (b as HTMLElement).dataset.lang === language);
  });

  renderAccentOptions();
  renderList();
  renderEditor();
}

// ---------- panel resize ----------
// The actual OBR popover is a separate host-managed iframe — our own CSS resizing the .panel div is
// purely cosmetic until OBR.action.setWidth/setHeight tells the HOST to resize that iframe too. Only
// committing that on pointerup (as before) let our div and the real iframe drift out of sync mid-drag:
// shrinking showed leftover host background outside the now-smaller div, growing got clipped at the
// still-small iframe's edge, and everything only snapped into place on release. Committing the real
// resize on every animation frame during the drag (not every pointermove — that would flood the
// host with IPC calls) keeps the two in step throughout, not just at the end.
const sizeHint = document.getElementById("sizeHint")!;
(function () {
  const handle = document.getElementById("resizeHandle")!;
  // Must match body{padding} in style.css: the panel measures its OWN box (inside that padding), but
  // OBR.action.setWidth/setHeight sizes the whole iframe — telling it just the panel's size left the
  // iframe too small to also fit the margin, clipping/misaligning everything on every resize.
  const PANEL_MARGIN = 7;
  let startX = 0, startY = 0, startW = 0, startH = 0, dragging = false;
  let pendingW = 0, pendingH = 0, commitRAF: number | null = null;

  // Owlbear silently caps how big the host popover iframe can actually get, but there's no signal
  // for it anywhere in its SDK: getWidth()/getHeight() just echo back the last value we asked for,
  // never the real rendered size, confirmed by logging both side by side while dragging well past the
  // visible edge of the screen. A screen.availWidth/availHeight-based guess isn't right either — it
  // reflects the MONITOR, not the actual (possibly smaller, possibly on a different monitor) browser
  // window. What does work: this popover's content is OUR OWN iframe, so window.innerWidth/innerHeight
  // are the real, current, live size the host genuinely rendered us at, whatever the real limit came
  // from. The native `resize` event fires whenever that changes, so syncToRealViewport() snaps the
  // panel back down the moment it's bigger than what's actually there.
  //
  // A live predictive clamp during the drag itself (so the panel never LOOKS oversized even mid-drag)
  // was also tried, remembering the real boundary the first time it's discovered and clamping pointer
  // movement against it directly — but overlapping resize requests fired on every animation frame
  // during a fast drag let their responses land out of order, which made that tracking misfire and
  // wrongly cap the panel from ever growing back after being shrunk. Given the choice, landing on the
  // correct size the moment you let go is what actually matters — a live-clamped drag is a nice-to-have
  // that isn't worth that risk, so this stays reactive-only: it can overshoot visibly WHILE dragging,
  // but always corrects on release.
  function syncToRealViewport() {
    const realW = window.innerWidth - PANEL_MARGIN * 2;
    const realH = window.innerHeight - PANEL_MARGIN * 2;
    const rect = panel.getBoundingClientRect();
    if (rect.width > realW + 0.5) panel.style.width = `${Math.max(300, realW)}px`;
    if (rect.height > realH + 0.5) panel.style.height = `${Math.max(280, realH)}px`;
  }
  window.addEventListener("resize", syncToRealViewport);

  function commitSize() {
    commitRAF = null;
    void OBR.action.setWidth(Math.round(pendingW) + PANEL_MARGIN * 2);
    void OBR.action.setHeight(Math.round(pendingH) + PANEL_MARGIN * 2);
  }

  handle.addEventListener("pointerdown", (ev: PointerEvent) => {
    dragging = true;
    startX = ev.clientX; startY = ev.clientY;
    const rect = panel.getBoundingClientRect();
    startW = rect.width; startH = rect.height;
    panel.classList.add("resizing");
    handle.setPointerCapture(ev.pointerId);
  });
  handle.addEventListener("pointermove", (ev: PointerEvent) => {
    if (!dragging) return;
    const w = Math.max(300, startW + (ev.clientX - startX));
    const h = Math.max(280, startH + (ev.clientY - startY));
    panel.style.width = `${w}px`;
    panel.style.height = `${h}px`;
    sizeHint.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    pendingW = w;
    pendingH = h;
    if (commitRAF === null) {
      commitRAF = requestAnimationFrame(commitSize);
    }
  });
  function stop() {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove("resizing");
    if (commitRAF !== null) { cancelAnimationFrame(commitRAF); commitRAF = null; }
    const rect = panel.getBoundingClientRect();
    void Promise.all([
      OBR.action.setWidth(Math.round(rect.width) + PANEL_MARGIN * 2),
      OBR.action.setHeight(Math.round(rect.height) + PANEL_MARGIN * 2),
    ]).then(syncToRealViewport);
  }
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
})();

// ---------- role: this is a GM-only tool; players see a blocking gate instead ----------
function applyRoleView() {
  const isPlayer = role === "PLAYER";
  document.getElementById("normalView")!.hidden = isPlayer;
  document.getElementById("gmGate")!.hidden = !isPlayer;
  if (isPlayer) {
    closeDropdown();
    closeSettings();
  }
}

// ---------- reacting to remote room-metadata changes (the GM editing from another device/tab) ----------
// ---------- boot ----------
async function boot() {
  const [initialNotes, initialLanguage, initialAccent, initialRole] = await Promise.all([
    getNotes(),
    getLanguage(),
    getAccentPref(),
    OBR.player.getRole(),
  ]);
  notes = initialNotes;
  language = initialLanguage;
  accentPref = initialAccent;
  role = initialRole;
  activeId = notes.length ? notes[0].id : null;

  setThemeAccent = watchTheme(panel, accentPref);

  applyLanguage();
  applyRoleView();

  OBR.player.onChange((player) => {
    if (player.role !== role) {
      role = player.role;
      applyRoleView();
    }
  });
}

OBR.onReady(() => {
  boot().catch((err) => {
    // A silent failure here (a rejected promise anywhere in boot) used to just leave the static
    // pre-JS placeholder markup on screen forever, looking exactly like "nothing loaded" with no
    // clue why — surfacing it directly makes that failure mode diagnosable instead of invisible.
    console.error("Notes failed to start:", err);
    const panelBody = document.getElementById("panelBody");
    if (panelBody) {
      panelBody.innerHTML =
        '<div class="editor-empty">Notes failed to start. Open the browser console for details, and let Ignacio know.</div>';
    }
  });
});
