import OBR from "@owlbear-rodeo/sdk";
import JSZip from "jszip";
import "./style.css";
import { getStrings } from "./i18n";
import type { Language, Strings, ToolbarStrings } from "./i18n";
import { getNotes, setNotes, clearAllNotes, notesStorageBytes, sanitizeNote } from "./notes";
import { sanitizeNoteHtml } from "./sanitizeHtml";
import type { Note } from "./notes";
import { getPluginId } from "./pluginId";
import { getTemplates, setTemplates, resolveTemplate, toCustomTemplate, sanitizeTemplate, missingBuiltins, newBuiltinTemplate } from "./templates";
import type { Template } from "./templates";
import { watchCloudTemplates, pushTemplate, deleteTemplateFromCloud } from "./templateSync";
import { getLanguage, setLanguage, getAccentPref, setAccentPref } from "./prefs";
import type { AccentPref } from "./prefs";
import { ACCENTS, ACCENT_ORDER, watchTheme } from "./theme";
import {
  cloudSyncAvailable,
  getCurrentUser,
  onAuthChange,
  signInWithGoogle,
  signOutCloud,
  getSyncStatus,
  onSyncStatusChange,
  initCloudSyncContext,
  markNoteDirty,
  deleteNoteFromCloud,
  flushCloudSync,
  watchCloudNotes,
} from "./cloudSync";
import type { User } from "firebase/auth";

// ---------- state ----------
let notes: Note[] = [];
// Global to this browser, not per room — see templates.ts.
let templates: Template[] = [];
// False until the stored templates have actually been read. persistTemplates() writes the whole
// list, so writing after a failed load would replace every stored template with just the in-memory
// ones (empty plus whatever was added since).
let templatesLoaded = false;
let activeId: string | null = null;
let searchTerm = "";
let language: Language = "en";
let accentPref: AccentPref = "auto";
let role: "GM" | "PLAYER" = "GM";
let setThemeAccent: (accent: AccentPref) => void = () => {};

// The debounced per-keystroke save (see scheduleSave in buildNoteEditor) waits 400ms of idle typing
// before actually writing to local storage — a refresh/tab-close inside that window would otherwise
// silently drop the last few keystrokes. Whichever editor instance currently has a save pending points
// this at its own flush, and we force it immediately the moment the page might go away — same idea
// for the cloud sync debounce (much longer, see cloudSync.ts), flushed alongside it here.
let pendingSaveFlush: (() => void | Promise<void>) | null = null;
function flushPendingSave() {
  if (pendingSaveFlush) {
    const flush = pendingSaveFlush;
    pendingSaveFlush = null;
    flush();
  }
  void flushCloudSync();
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

// The little cloud icon next to the save indicator: hidden entirely unless a Firebase project is
// configured (see firebaseConfig.ts) — cloud sync is opt-in infrastructure, not something to hint at
// for anyone who hasn't set it up. Doubles as a manual "sync now" button once signed in; when signed
// out, clicking it opens Settings instead, since that's where signing in actually happens.
function updateSyncIndicator() {
  const btn = document.getElementById("gmCloudSyncBtn") as HTMLButtonElement | null;
  if (!btn || !cloudSyncAvailable()) {
    if (btn) btn.hidden = true;
    return;
  }
  btn.hidden = false;
  const s = strings();
  btn.classList.remove("state-signed-out", "state-synced", "state-pending", "state-syncing", "state-error");
  const user = getCurrentUser();
  if (!user) {
    btn.classList.add("state-signed-out");
    btn.title = s.cloudSignedOutTitle;
    btn.setAttribute("aria-label", s.cloudSignedOutTitle);
    return;
  }
  const status = getSyncStatus();
  const shown = status === "off" ? "synced" : status;
  btn.classList.add(`state-${shown}`);
  btn.title = s.cloudStatusTitle(shown);
  btn.setAttribute("aria-label", s.cloudStatusTitle(shown));
}

function updateCloudAccountUI(user: User | null) {
  const signedOutRow = document.getElementById("cloudSignedOutRow");
  const signedInRow = document.getElementById("cloudSignedInRow");
  const signedInActions = document.getElementById("cloudSignedInActions");
  const emailEl = document.getElementById("cloudAccountEmail");
  if (!signedOutRow || !signedInRow || !signedInActions || !emailEl) return;
  signedOutRow.hidden = !!user;
  signedInRow.hidden = !user;
  signedInActions.hidden = !user;
  emailEl.textContent = user?.email || "";
}

const PILL_COLORS = [
  { id: "violeta", hex: "#7c5cff" },
  { id: "azul", hex: "#3f8ce0" },
  { id: "verde", hex: "#4caf72" },
  { id: "amarillo", hex: "#d6b214" },
  { id: "naranja", hex: "#f2780c" },
  { id: "rojo", hex: "#e04f4f" },
  { id: "rosa", hex: "#e05a86" },
  { id: "marrón", hex: "#9c6b3e" },
  { id: "blanco", hex: "#ffffff" },
  { id: "gris claro", hex: "#b8b8c0" },
  { id: "gris", hex: "#8b8994" },
  { id: "negro", hex: "#2a2a30" },
];

function escapeHtml(str: string): string {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
// Clipboard format for copying WITHIN GM Notes with formatting intact. Pasting anything else stays
// plain text (see the paste handler); only content carrying this type keeps its formatting.
const CLIPBOARD_TYPE = "application/x-gm-notes";

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

      const templateBtn = document.createElement("button");
      templateBtn.className = "row-btn template-btn";
      templateBtn.title = s.saveAsTemplateTitle;
      templateBtn.setAttribute("aria-label", s.saveAsTemplateAria + (n.title || s.untitled));
      templateBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.2 1.6"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
      templateBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void saveAsTemplate(n);
      });

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

      // 2x2 grid beside the whole item (not inline after the title) so the title keeps most of the
      // row's width — four buttons in one line left little room for it.
      const actions = document.createElement("div");
      actions.className = "row-actions";
      actions.appendChild(templateBtn);
      actions.appendChild(exportBtn);
      actions.appendChild(editBtn);
      actions.appendChild(del);

      const snippet = document.createElement("div");
      snippet.className = "snippet";
      snippet.textContent = stripHtml(n.html) || s.emptyNote;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = s.editedAgo + relativeTime(n.updatedAt);

      const body = document.createElement("div");
      body.className = "note-item-body";
      body.appendChild(row);
      body.appendChild(snippet);
      body.appendChild(meta);

      item.classList.add("with-actions");
      item.appendChild(body);
      item.appendChild(actions);

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
    note.updatedAt = Date.now();
    markNoteDirty(note.id);
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
  void deleteNoteFromCloud(id);
  await persist();
  renderList();
  renderEditor();
}

async function createNote(template?: Template) {
  // A built-in's text is copied in the current language and stays that way in the note.
  const source = template ? resolveTemplate(template, language) : null;
  const note: Note = {
    id: "n" + Date.now(),
    title: source ? source.title : strings().newNoteDefaultTitle,
    html: source ? source.html : "",
    updatedAt: Date.now(),
  };
  notes.unshift(note);
  activeId = note.id;
  markNoteDirty(note.id);
  await persist();
  renderList();
  renderEditor();
  closeDropdown();
  closeTemplateMenu();
  const titleInput = editorPaneEl.querySelector(".note-title-input") as HTMLInputElement | null;
  if (titleInput) { titleInput.focus(); titleInput.select(); }
}

// ---------- templates: saved note bodies to start new notes from (see templates.ts) ----------
// Templates are shared by every GM Notes window in this browser (any room), but each window keeps
// its own in-memory copy and saves the whole list — so a window must pick up another's saves before
// its own next save, or it would write back a list missing them. Each successful save announces
// itself here; every other window then reloads the list from storage.
const templatesChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(getPluginId("templates")) : null;
templatesChannel?.addEventListener("message", () => {
  if (!templatesLoaded) return;
  getTemplates()
    .then((fresh) => {
      templates = fresh;
      renderTemplateList();
    })
    .catch((err) => console.error("Notes: failed to reload templates changed in another window", err));
});
async function persistTemplates(): Promise<boolean> {
  if (!templatesLoaded) {
    showStorageBanner(strings().storageBannerGeneric);
    return false;
  }
  try {
    await setTemplates(templates);
    templatesChannel?.postMessage("changed");
    return true;
  } catch (err) {
    console.error("Notes: failed to save templates", err);
    showStorageBanner(strings().storageBannerGeneric);
    return false;
  }
}

async function saveAsTemplate(note: Note) {
  const title = note.title || strings().untitled;
  const template: Template = { id: "t" + Date.now(), title, html: note.html, updatedAt: Date.now() };
  templates.push(template);
  const saved = await persistTemplates();
  void pushTemplate(template);
  renderTemplateList();
  if (saved) void OBR.notification.show(strings().templateSaved(title), "SUCCESS");
}

async function deleteTemplate(id: string) {
  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) return;
  templates.splice(idx, 1);
  await persistTemplates();
  void deleteTemplateFromCloud(id);
  renderTemplateList();
}

function startTemplateRename(itemEl: HTMLElement, template: Template) {
  const titleSpan = itemEl.querySelector(".title") as HTMLElement;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = resolveTemplate(template, language).title;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  function commit() {
    if (done) return;
    done = true;
    const newTitle = input.value.trim() || strings().untitled;
    // Leaving a built-in's name as-is keeps it a built-in (still follows the language).
    if (template.builtin && newTitle === resolveTemplate(template, language).title) {
      renderTemplateList();
      return;
    }
    toCustomTemplate(template, language);
    template.title = newTitle;
    template.updatedAt = Date.now();
    void persistTemplates();
    void pushTemplate(template);
    renderTemplateList();
  }
  input.addEventListener("keydown", (ev) => {
    // Escape here cancels the rename only — it must not also close the whole menu.
    ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    if (ev.key === "Escape") { done = true; renderTemplateList(); }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (ev) => ev.stopPropagation());
}

const templateListEl = document.getElementById("templateList") as HTMLElement;

// Brings back any built-in the GM deleted (and any added in a later version they never got), next
// to whatever they already have — nothing existing is touched, so it needs no confirmation.
async function restoreDefaultTemplates() {
  const restored = missingBuiltins(templates).map(newBuiltinTemplate);
  if (!restored.length) return;
  templates.push(...restored);
  await persistTemplates();
  restored.forEach((t) => void pushTemplate(t));
  renderTemplateList();
}
function appendRestoreButton() {
  if (!missingBuiltins(templates).length) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "restore-templates-btn";
  btn.setAttribute("role", "menuitem");
  btn.textContent = strings().restoreTemplates;
  btn.title = strings().restoreTemplatesHint;
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void restoreDefaultTemplates();
  });
  templateListEl.appendChild(btn);
}

function renderTemplateList() {
  const s = strings();
  if (!templates.length) {
    templateListEl.innerHTML = `<div class="empty-list">${escapeHtml(s.templatesEmpty)}</div>`;
    appendRestoreButton();
    return;
  }
  templateListEl.innerHTML = "";
  templates
    .map((t) => ({ t, shown: resolveTemplate(t, language) }))
    .sort((a, b) => a.shown.title.localeCompare(b.shown.title, language))
    .forEach(({ t, shown }) => {
      const item = document.createElement("div");
      item.className = "note-item";
      item.setAttribute("role", "menuitem");
      item.tabIndex = 0;

      const row = document.createElement("div");
      row.className = "note-item-row";

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = shown.title || s.untitled;

      const editBtn = document.createElement("button");
      editBtn.className = "row-btn edit-btn";
      editBtn.title = s.renameTemplateTitle;
      editBtn.setAttribute("aria-label", s.renameTemplateAria + (shown.title || s.untitled));
      editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M11 2.5 13.5 5 5.8 12.7l-3 .6.6-3L11 2.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        startTemplateRename(item, t);
      });

      const del = document.createElement("button");
      del.className = "row-btn del-btn";
      del.title = s.deleteTemplateTitle;
      del.setAttribute("aria-label", s.deleteTemplateAria + (shown.title || s.untitled));
      del.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5 5 13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void deleteTemplate(t.id);
      });

      row.appendChild(title);
      row.appendChild(editBtn);
      row.appendChild(del);

      const snippet = document.createElement("div");
      snippet.className = "snippet";
      snippet.textContent = stripHtml(shown.html) || s.emptyNote;

      item.appendChild(row);
      item.appendChild(snippet);

      item.addEventListener("click", () => void createNote(t));
      item.addEventListener("keydown", (ev) => {
        if (ev.target !== item) return;
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          void createNote(t);
        }
      });

      templateListEl.appendChild(item);
    });
  appendRestoreButton();
}

const newNoteWrap = document.getElementById("newNoteWrap")!;
const newNoteBtnEl = document.getElementById("newNoteBtn")!;
const templateMenu = document.getElementById("templateMenu")!;

function openTemplateMenu() {
  closeDropdown();
  renderTemplateList();
  templateMenu.hidden = false;
  newNoteBtnEl.setAttribute("aria-expanded", "true");
  (document.getElementById("blankNoteBtn") as HTMLElement).focus();
  document.addEventListener("pointerdown", onTemplateMenuPointerDown, true);
  document.addEventListener("keydown", onTemplateMenuKeydown, true);
}
function closeTemplateMenu() {
  if (templateMenu.hidden) return;
  templateMenu.hidden = true;
  newNoteBtnEl.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onTemplateMenuPointerDown, true);
  document.removeEventListener("keydown", onTemplateMenuKeydown, true);
}
function onTemplateMenuPointerDown(ev: Event) {
  if (!newNoteWrap.contains(ev.target as Node)) closeTemplateMenu();
}
function onTemplateMenuKeydown(ev: KeyboardEvent) {
  // This listens in the capture phase, so it runs before a rename input's own handler — Escape
  // there must only cancel the rename (handled by the input), not close the menu. Closing it would
  // also move focus away, and the input's blur would then save the half-typed name.
  if ((ev.target as HTMLElement | null)?.classList?.contains("rename-input")) return;
  if (ev.key === "Escape") { closeTemplateMenu(); newNoteBtnEl.focus(); }
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
// A built-in template is exported as just its marker (empty title/html) — it carries no text of its
// own, and whichever GM Notes imports it already knows its text in every language.
interface TemplateExportFile {
  type: "gm-notes-template";
  version: 1;
  id: string;
  title: string;
  html: string;
  updatedAt: number;
  builtin?: Template["builtin"];
}
function templateToExportPayload(template: Template): TemplateExportFile {
  return {
    type: "gm-notes-template",
    version: 1,
    id: template.id,
    title: template.title,
    html: template.html,
    updatedAt: template.updatedAt,
    ...(template.builtin ? { builtin: template.builtin } : {}),
  };
}
// Templates travel inside an "export all" zip in their own folder, which is also how import tells a
// template's Markdown file apart from a note's (a .md file has nowhere else to say what it is).
// Folder names in both languages are recognized, since the export uses the exporting GM's language.
const TEMPLATE_FOLDER_NAMES = ["plantillas", "templates"];
function isInTemplateFolder(zipPath: string): boolean {
  const parts = zipPath.split("/");
  return parts.length > 1 && TEMPLATE_FOLDER_NAMES.includes(parts[0].toLowerCase());
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
  // Markdown is plain text — a built-in template's language-following marker can't survive it, and
  // every GM Notes install already has the built-ins anyway, so only the GM's own templates go there.
  const exportedTemplates = format === "json" ? templates : templates.filter((t) => !t.builtin);
  if (!notes.length && !exportedTemplates.length) return;
  if (notes.length === 1 && !exportedTemplates.length) {
    exportNote(notes[0], format);
    return;
  }
  const zip = new JSZip();
  const ext = format === "json" ? ".json" : ".md";
  function addUnique(usedNames: Set<string>, folder: string, title: string, content: string) {
    const base = safeFileName(title);
    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = `${base}-${i++}`;
    usedNames.add(name);
    zip.file(folder + name + ext, content);
  }
  const noteNames = new Set<string>();
  notes.forEach((n) => {
    const content = format === "json" ? JSON.stringify(noteToExportPayload(n), null, 2) : htmlToMarkdown(n.html);
    addUnique(noteNames, "", n.title, content);
  });
  const templateNames = new Set<string>();
  const folder = strings().templatesFolder + "/";
  exportedTemplates.forEach((t) => {
    // A built-in's file is named after its current-language title, purely for readability.
    const title = resolveTemplate(t, language).title;
    const content = format === "json" ? JSON.stringify(templateToExportPayload(t), null, 2) : htmlToMarkdown(t.html);
    addUnique(templateNames, folder, title, content);
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
  return sanitized ? { ...sanitized, html: sanitizeNoteHtml(sanitized.html), id: freshNoteId() } : null;
}

// A Markdown file carries no title/id of its own — the filename (minus extension) becomes the title,
// and its text runs through the SAME parser the paste handler uses, so a note round-tripped out as
// Markdown and back in comes back as real formatting, not literal "**"/"#"/"-" markers.
function noteFromMarkdownFile(filename: string, text: string): Note {
  const title = filename.replace(/\.md$/i, "").trim();
  return { id: freshNoteId(), title: title || strings().untitled, html: markdownToHtml(text), updatedAt: Date.now() };
}

// A JSON file is a template if it says so (type "gm-notes-template", wherever it sits), or if it sits
// in a zip's templates folder.
function parseImportedTemplate(json: string, inTemplateFolder: boolean): Template | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const declared = (data as { type?: unknown } | null)?.type === "gm-notes-template";
  if (!declared && !inTemplateFolder) return null;
  const sanitized = sanitizeTemplate(data);
  return sanitized ? { ...sanitized, html: sanitizeNoteHtml(sanitized.html), id: "t" + freshNoteId() } : null;
}

interface ImportedContent {
  notes: Note[];
  templates: Template[];
}

async function importFromJsonText(json: string, inTemplateFolder: boolean, into: ImportedContent) {
  const template = parseImportedTemplate(json, inTemplateFolder);
  if (template) {
    into.templates.push(template);
    return;
  }
  const note = parseImportedNote(json);
  if (note) into.notes.push(note);
}

async function contentFromImportFile(file: File): Promise<ImportedContent> {
  const result: ImportedContent = { notes: [], templates: [] };
  if (/\.zip$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(file);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const entryName = entry.name.split("/").pop() || entry.name;
      const inTemplateFolder = isInTemplateFolder(entry.name);
      if (/\.json$/i.test(entryName)) {
        await importFromJsonText(await entry.async("text"), inTemplateFolder, result);
      } else if (/\.md$/i.test(entryName)) {
        const fromMarkdown = noteFromMarkdownFile(entryName, await entry.async("text"));
        if (inTemplateFolder) result.templates.push({ ...fromMarkdown, id: "t" + freshNoteId() });
        else result.notes.push(fromMarkdown);
      }
    }
    return result;
  }
  if (/\.md$/i.test(file.name)) {
    result.notes.push(noteFromMarkdownFile(file.name, await file.text()));
    return result;
  }
  await importFromJsonText(await file.text(), false, result);
  return result;
}

// Re-importing the same export (or one from another browser that also has the built-ins) mustn't
// pile up copies: a built-in is skipped if this browser already has that built-in, and a custom
// template if one with the exact same title and body already exists.
function isDuplicateTemplate(candidate: Template, existing: Template[]): boolean {
  return existing.some((t) =>
    candidate.builtin
      ? t.builtin === candidate.builtin
      : !t.builtin && t.title === candidate.title && t.html === candidate.html
  );
}

async function importNotesFromFiles(files: FileList) {
  const imported: Note[] = [];
  const importedTemplates: Template[] = [];
  for (const file of Array.from(files)) {
    try {
      const content = await contentFromImportFile(file);
      imported.push(...content.notes);
      importedTemplates.push(...content.templates);
    } catch (err) {
      console.error("Notes: failed to read import file", file.name, err);
    }
  }
  if (!imported.length && !importedTemplates.length) {
    window.alert(strings().importNoneFound);
    return;
  }
  const newTemplates: Template[] = [];
  importedTemplates.forEach((t) => {
    if (!isDuplicateTemplate(t, [...templates, ...newTemplates])) newTemplates.push(t);
  });
  if (newTemplates.length) {
    const importedAt = Date.now();
    newTemplates.forEach((t) => { t.updatedAt = importedAt; });
    templates = [...templates, ...newTemplates];
    await persistTemplates();
    newTemplates.forEach((t) => void pushTemplate(t));
    renderTemplateList();
  }
  if (!imported.length) {
    window.alert(newTemplates.length ? strings().importSuccess(0, newTemplates.length) : strings().importNothingNew);
    return;
  }
  // The exported file carries the ORIGINAL note's updatedAt, and sanitizeNote() (reused as-is from
  // room-metadata reads) has no reason to touch it — left alone, a freshly-imported note shows the
  // exact same "edited X ago" as whatever note it came from, which reads as though the two are
  // somehow still the same note rather than an independent copy. Importing is its own edit event in
  // THIS room, right now, so it gets its own timestamp.
  const importedAt = Date.now();
  imported.forEach((n) => { n.updatedAt = importedAt; markNoteDirty(n.id); });
  // All-or-nothing: rolling the in-memory array back if persist() fails keeps it from silently
  // showing notes that never actually made it to storage.
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
  window.alert(strings().importSuccess(imported.length, newTemplates.length));
}

// A full, explicit reset for this room's local storage — distinct from deleting notes one at a time,
// and from the migration step in notes.ts that already clears the OLD shared room-metadata entry on
// its own. This clears what's stored HERE, now, for whoever's using it; pairs naturally with "export
// all" as a manual backup-then-wipe flow.
async function clearAllNotesWithConfirm() {
  if (!notes.length) return;
  if (!window.confirm(strings().clearAllConfirm(notes.length))) return;
  await Promise.all(notes.map((n) => deleteNoteFromCloud(n.id)));
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
  picker?: "pill" | "textColor" | "quoteColor" | "block";
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
  { picker: "block" },
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

type BlockTag = "P" | "H1" | "H2" | "H3" | "H4" | "BLOCKQUOTE";
// Block types offered by the block menu, in menu order. H4 is the "toggle" level: styled exactly
// like a plain paragraph, so it reads as normal text that can collapse what follows it.
const BLOCK_TYPES: { tag: BlockTag; key: "paragraph" | "h1" | "h2" | "h3" | "toggle"; short: string }[] = [
  { tag: "P", key: "paragraph", short: "Aa" },
  { tag: "H1", key: "h1", short: "H1" },
  { tag: "H2", key: "h2", short: "H2" },
  { tag: "H3", key: "h3", short: "H3" },
  { tag: "H4", key: "toggle", short: "\u25b8" },
];

// Same dropdown shell as the color pickers (.pill-picker/.pill-swatches, so it shares their opening,
// clamping and click-outside closing); its items are ordinary formatBlock toolbar buttons, handled by
// the toolbar's own click listener.
function buildBlockPicker(idPrefix: string): string {
  const tb = strings().toolbar;
  const items = BLOCK_TYPES.map(
    (t) => `<button type="button" class="block-item block-item-${t.tag.toLowerCase()}" data-cmd="formatBlock" data-value="${t.tag}">${escapeHtml(tb[t.key])}</button>`
  ).join("");
  return (
    `<div class="pill-picker block-picker" id="${idPrefix}BlockPicker">` +
    `<button type="button" class="pill-picker-btn block-picker-btn" id="${idPrefix}BlockPickerBtn" title="${tb.blockType}" aria-haspopup="true" aria-expanded="false">` +
    `<span class="block-picker-label" id="${idPrefix}BlockPickerLabel">Aa</span>` +
    `<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
    `</button>` +
    `<div class="pill-swatches block-menu" id="${idPrefix}BlockMenu" hidden>${items}</div>` +
    `</div>`
  );
}

function renderToolbarButton(b: ToolbarButtonSpec, idPrefix: string): string {
  if (b.sep) return '<span class="tb-sep"></span>';
  const tb = strings().toolbar;
  if (b.picker === "block") return buildBlockPicker(idPrefix);
  if (b.picker === "pill") {
    return buildColorPicker(
      idPrefix + "PillPicker", idPrefix + "PillPickerBtn", idPrefix + "PillSwatches", tb.pill,
      '<svg viewBox="0 0 16 16" fill="none"><rect x="1.5" y="5.4" width="13" height="5.2" rx="2.6" stroke="currentColor" stroke-width="1.4"/></svg>',
      tb.pillNone
    );
  }
  if (b.picker === "textColor") {
    return buildColorPicker(
      idPrefix + "TextColorPicker", idPrefix + "TextColorPickerBtn", idPrefix + "TextColorSwatches", tb.textColor,
      '<svg viewBox="0 0 16 16" fill="none"><text x="8" y="11.2" font-size="13" font-weight="700" text-anchor="middle" fill="currentColor">A</text><rect x="1.5" y="13" width="13" height="2.2" rx="1.1" fill="currentColor"/></svg>',
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
let editorSelectionListener: (() => void) | null = null;
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
    `<div class="editor-foot"><span class="save-state"><span class="pip" id="${idPrefix}SavePip"></span><span id="${idPrefix}SavedAgo">${escapeHtml(s.savedPrefix + s.savedInstant)}</span><button type="button" class="cloud-sync-btn" id="${idPrefix}CloudSyncBtn" hidden><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M5.3 12.3h6.4a2.7 2.7 0 0 0 .35-5.37 3.75 3.75 0 0 0-7.3-1.1A2.6 2.6 0 0 0 5.3 12.3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button></span><span id="${idPrefix}WordCount">${escapeHtml(s.wordsCount(0))}</span></div>`;

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
  // function in this file (getTouchedBlocks/blockAt/setBlockType only recognize P/H1-H4/BLOCKQUOTE/
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
  // Each snapshot also remembers the selection at that moment, so undo/redo puts the caret back
  // where the change happened instead of the browser's default (the very start of the note).
  // Positions are stored as (top-level block index, character offset within that block): stable
  // across the innerHTML round-trip, unlike DOM node references, which all get replaced.
  interface CaretPos { sb: number; so: number; eb: number; eo: number }
  interface Snapshot { html: string; caret: CaretPos | null }
  const history: Snapshot[] = [];
  const future: Snapshot[] = [];
  let restoringHistory = false;

  function pointToPos(node: Node, offset: number): [number, number] | null {
    const blocks = Array.prototype.slice.call(surface.children) as HTMLElement[];
    if (!blocks.length) return null;
    if (node === surface) {
      // offset counts child NODES (whitespace text between blocks included), not elements.
      let index = 0;
      for (let i = 0; i < offset && i < surface.childNodes.length; i++) {
        if (surface.childNodes[i].nodeType === 1) index++;
      }
      return index >= blocks.length ? [blocks.length - 1, blockTextLength(blocks[blocks.length - 1])] : [index, 0];
    }
    const block = blockAt(node);
    if (!block) return null;
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(node, offset);
    return [blocks.indexOf(block), r.toString().replace(/\u200b/g, "").length];
  }
  function blockTextLength(block: HTMLElement): number {
    return (block.textContent || "").replace(/\u200b/g, "").length;
  }
  function posToPoint(blockIndex: number, offset: number): [Node, number] | null {
    const blocks = surface.children;
    if (!blocks.length) return null;
    const block = blocks[Math.min(blockIndex, blocks.length - 1)] as HTMLElement;
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
    return start && end ? { sb: start[0], so: start[1], eb: end[0], eo: end[1] } : null;
  }
  function restoreCaret(caret: CaretPos | null) {
    if (!caret) return;
    const start = posToPoint(caret.sb, caret.so);
    const end = posToPoint(caret.eb, caret.eo);
    if (!start || !end) return;
    const r = document.createRange();
    r.setStart(start[0], start[1]);
    r.setEnd(end[0], end[1]);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function snapshot(): Snapshot {
    return { html: editorHtml(), caret: captureCaret() };
  }
  let typingBurstTimer: ReturnType<typeof setTimeout> | null = null;
  let wordCountTimer: ReturnType<typeof setTimeout> | null = null;

  function pushHistory() {
    if (restoringHistory) return;
    history.push(snapshot());
    if (history.length > 100) history.shift();
    future.length = 0;
  }
  function afterHistoryRestore() {
    const n = currentNote();
    if (n) n.html = editorHtml();
    updateEmptyState();
    updateWordCount();
    updateToolbarState();
    scheduleSave();
  }
  function undo() {
    if (!history.length) return;
    future.push(snapshot());
    const prev = history.pop()!;
    restoringHistory = true;
    surface.innerHTML = prev.html;
    restoringHistory = false;
    restoreCaret(prev.caret);
    afterHistoryRestore();
  }
  function redo() {
    if (!future.length) return;
    history.push(snapshot());
    const next = future.pop()!;
    restoringHistory = true;
    surface.innerHTML = next.html;
    restoringHistory = false;
    restoreCaret(next.caret);
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
    markNoteDirty(n.id);
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

  document.getElementById(idPrefix + "CloudSyncBtn")!.addEventListener("click", () => {
    if (getCurrentUser()) void flushCloudSync();
    else openSettings();
  });
  updateSyncIndicator();

  document.getElementById(idPrefix + "Toolbar")!.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest("button[data-cmd]") as HTMLElement | null;
    if (!btn) return;
    pushHistory();
    surface.focus();
    const cmd = btn.dataset.cmd!;
    const value = btn.dataset.value || undefined;
    if (cmd === "formatBlock") {
      const menuValue = ((value || "P").toUpperCase()) as BlockTag;
      const converted = setBlockType(menuValue);
      // The menu's "normal text" is always a standalone paragraph (<p data-standalone>): it ends the
      // toggle above it, so picking it puts the text back outside any toggle — while paragraphs
      // created by typing (Enter), clear-formatting or removing a quote stay plain and remain part of
      // whatever toggle they're in.
      if (menuValue === "P") {
        converted.forEach((b) => b.setAttribute("data-standalone", ""));
        applyFolding();
      }
      const blockMenu = document.getElementById(idPrefix + "BlockMenu");
      if (blockMenu) blockMenu.hidden = true;
      document.getElementById(idPrefix + "BlockPickerBtn")?.setAttribute("aria-expanded", "false");
    } else if (cmd === "divider") {
      insertDivider();
    } else if (cmd === "removeFormat") {
      clearFormatting();
    } else if ((cmd === "indent" || cmd === "outdent") && !caretInList()) {
      // Outside a list, Chrome "indents" by wrapping the block in a margin-styled <blockquote>, which
      // the HTML sanitizer turns into a real (bar-styled) quote on other devices. These buttons are
      // for sub-lists, same as Tab.
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
    if (n) n.html = editorHtml();
    scheduleSave();
    updateEmptyState();
    updateToolbarState();
  });

  function wireDropdown(btnId: string, swatchesId: string) {
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
  }
  function wireColorPicker(btnId: string, swatchesId: string, onColor: (hex: string) => void, onNone?: () => void) {
    const btn = document.getElementById(btnId);
    const sw = document.getElementById(swatchesId);
    if (!btn || !sw) return;
    wireDropdown(btnId, swatchesId);
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
      if (n) n.html = editorHtml();
      scheduleSave();
      updateEmptyState();
      updateToolbarState();
    });
  }

  wireDropdown(idPrefix + "BlockPickerBtn", idPrefix + "BlockMenu");
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
  function applyTextColor(hex: string, collapsedHex = hex) {
    surface.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return;
    if (range.collapsed) {
      // execCommand only accepts a literal color, never var(...) — hence the separate fallback.
      document.execCommand("foreColor", false, collapsedHex);
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
    // Any color already set INSIDE the selection would otherwise keep winning over the new outer
    // span (the innermost color is the one that paints), so recoloring/resetting a selection that
    // fully contains an earlier colored run looked like it did nothing.
    Array.prototype.slice.call(span.querySelectorAll('span[style*="color"], font[color]')).forEach((el: HTMLElement) => {
      if (el.tagName === "FONT") {
        el.removeAttribute("color");
      } else {
        el.style.color = "";
      }
      if (!el.getAttribute("style")) el.removeAttribute("style");
      if (!el.attributes.length) el.replaceWith(...Array.from(el.childNodes));
    });
    // Pills paint their own text color (derived from the pill color), which beats the new outer
    // span — so a selection spanning pills used to leave their text unchanged. Give each pill inside
    // the chosen color directly; a reset just drops that override, back to the pill's own color.
    const isReset = hex === "var(--text-primary)";
    Array.prototype.slice.call(span.querySelectorAll(".note-pill")).forEach((pill: HTMLElement) => {
      pill.style.color = isReset ? "" : hex;
    });
    // A reset entirely inside one pill (e.g. a double-clicked pill) means "back to the pill's own
    // text color", not the base text color — and if it covers the pill's whole text, the pill's own
    // color override goes too.
    const hostPill = span.parentElement && (span.parentElement.closest(".note-pill") as HTMLElement | null);
    if (isReset && hostPill) {
      span.style.color = "var(--pill-text)";
      if (span.textContent === hostPill.textContent) hostPill.style.color = "";
    }
    // Splitting a pill at the selection's edge (extractContents, when the selection starts/ends right
    // at a pill's boundary) can leave an empty pill shell behind, drawn as a tiny blank pill.
    Array.prototype.slice.call(surface.querySelectorAll(".note-pill")).forEach((pill: HTMLElement) => {
      if (pill.textContent === "") pill.remove();
    });
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
  // Resets to var(--text-primary) itself rather than its current computed value, so the "reset"
  // text keeps following the theme — freezing the computed value left text reset in dark mode stuck
  // white after switching to light mode.
  function resetTextColor() {
    const computed = getComputedStyle(panel).getPropertyValue("--text-primary").trim() || "#000000";
    applyTextColor("var(--text-primary)", computed);
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
  // Every pill a (non-collapsed) selection actually covers some text of — e.g. a word split into two
  // differently-colored pills, double-click-selected as a whole. Falls back to the pill the caret
  // sits in, so recoloring/removing from a plain caret inside a pill keeps working.
  function pillsInSelection(): HTMLElement[] {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    if (!range.collapsed) {
      const covered = Array.prototype.slice.call(surface.querySelectorAll(".note-pill")).filter((pill: HTMLElement) => {
        if (!range.intersectsNode(pill)) return false;
        const part = document.createRange();
        part.selectNodeContents(pill);
        if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) part.setStart(range.startContainer, range.startOffset);
        if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) part.setEnd(range.endContainer, range.endOffset);
        return part.toString() !== "";
      }) as HTMLElement[];
      if (covered.length) return covered;
    }
    const single = getPillAtSelection();
    return single ? [single] : [];
  }
  function applyPillColor(hex: string) {
    const existing = pillsInSelection();
    if (existing.length) {
      existing.forEach((pill) => pill.style.setProperty("--pill-c", hex));
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
    pillsInSelection().forEach((pill) => {
      const text = document.createTextNode(pill.textContent || "");
      pill.replaceWith(text);
    });
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
    let nested = block.querySelector("h1, h2, h3, h4, blockquote, p");
    while (nested) {
      const parent = nested.parentNode!;
      while (nested.firstChild) parent.insertBefore(nested.firstChild, nested);
      parent.removeChild(nested);
      nested = block.querySelector("h1, h2, h3, h4, blockquote, p");
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
      (el) => /^(P|H[1-4]|BLOCKQUOTE|UL|OL)$/.test(el.tagName) && range.intersectsNode(el)
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
  function setBlockType(tag: BlockTag): HTMLElement[] {
    const blocks = getTouchedBlocks();
    if (!blocks.length) return [];

    // Picking the type a block already has is a no-op (the block menu has an explicit "normal text"
    // entry, so the old re-click-to-revert toggle of the H1/H2 buttons is gone).
    const finalTag = tag;

    const result: HTMLElement[] = [];
    let firstNew: HTMLElement | null = null;
    blocks.forEach((b) => {
      if (b.tagName === finalTag) {
        if (!firstNew) firstNew = b;
        result.push(b);
        return;
      }
      // A list can't become a paragraph by wrapping it (that's the invalid <p><ul> nesting
      // unwrapNestedLists() exists to undo); lists are turned into text by the list buttons or
      // clear-formatting, which unpack them item by item first.
      if (finalTag === "P" && (b.tagName === "UL" || b.tagName === "OL")) return;
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
      if (!/^(P|H[1-4]|BLOCKQUOTE)$/.test(el.tagName)) return;
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
  // Copy/cut put the selection on the clipboard three ways: plain text (for other apps), HTML, and our
  // own CLIPBOARD_TYPE, which the paste handler below recognizes to keep the formatting. A selection
  // inside a single block is re-wrapped in the inline formatting around it (pill, color, bold...), and
  // list items in their list, since the browser's range clone only carries what's strictly inside it.
  function selectionHtml(): string | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return null;
    let content: Node = range.cloneContents();
    let el: Node | null = range.commonAncestorContainer;
    if (el.nodeType === 3) el = el.parentNode;
    while (el && el !== surface) {
      const tag = (el as HTMLElement).tagName;
      const inline = /^(SPAN|FONT|B|STRONG|I|EM|U|S|STRIKE)$/.test(tag);
      const listWrap = (tag === "UL" || tag === "OL") && Array.prototype.some.call(content.childNodes, (n: Node) => n.nodeName === "LI");
      if (inline || listWrap) {
        const wrap = (el as HTMLElement).cloneNode(false) as HTMLElement;
        wrap.appendChild(content);
        const frag = document.createDocumentFragment();
        frag.appendChild(wrap);
        content = frag;
      }
      el = el.parentNode;
    }
    const box = document.createElement("div");
    box.appendChild(content);
    return sanitizeNoteHtml(box.innerHTML);
  }
  function onCopy(ev: ClipboardEvent, cut: boolean) {
    const html = selectionHtml();
    if (html === null || !ev.clipboardData) return;
    ev.preventDefault();
    const text = window.getSelection()!.toString().replace(/\u200b/g, "");
    ev.clipboardData.setData("text/plain", text);
    ev.clipboardData.setData("text/html", html);
    ev.clipboardData.setData(CLIPBOARD_TYPE, html);
    // Cancelling the event cancels the browser's own deletion too; doing it via execCommand keeps it
    // in our undo history (beforeinput) and saved (input) like any other edit.
    if (cut) document.execCommand("delete");
  }
  surface.addEventListener("copy", (ev: ClipboardEvent) => onCopy(ev, false));
  surface.addEventListener("cut", (ev: ClipboardEvent) => onCopy(ev, true));

  surface.addEventListener("paste", (ev: ClipboardEvent) => {
    ev.preventDefault();
    const own = ev.clipboardData?.getData(CLIPBOARD_TYPE) ?? "";
    if (own) {
      document.execCommand("insertHTML", false, sanitizeNoteHtml(own));
      unwrapNestedLists();
      removeEditorNoise();
      syncTextDecorationColors();
      return;
    }
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const html = markdownToHtml(text);
    // A single line with no Markdown in it (a copied word or phrase, the common case) is inserted as
    // plain text: going through insertHTML wraps it in a <p>, and the browser drops whitespace at a
    // block's edges, so a copied "word " lost its trailing space. insertText keeps it.
    if (!/[\r\n]/.test(text) && html === `<p>${escapeHtml(text)}</p>`) {
      document.execCommand("insertText", false, text);
      return;
    }
    document.execCommand("insertHTML", false, html);
    unwrapNestedLists();
    removeEditorNoise();
  });
  surface.addEventListener("beforeinput", () => {
    if (restoringHistory) return;
    if (!typingBurstTimer) pushHistory();
    if (typingBurstTimer) clearTimeout(typingBurstTimer);
    typingBurstTimer = setTimeout(() => { typingBurstTimer = null; }, 700);
  });
  // A pill's trailing edge: Chrome treats "end of the pill's text" and "start of whatever follows it"
  // as the same caret spot, draws the caret inside the pill there, and keeps typed text inside it —
  // and when a pill ends its paragraph there's no outside spot at all. So "outside" gets its own
  // caret anchor: a zero-width-space text node right after the pill, with the caret parked after
  // it. Chrome then both draws the caret outside the pill and types there natively. Being at the
  // pill's end INSIDE it stays a distinct spot (typing there extends the pill); → / ← step between
  // the two. The anchor's zero-width space is stripped as soon as real text lands next to it, or
  // the anchor removed entirely once the caret leaves it unused, so it never reaches a saved note.
  const PILL_ANCHOR = "\u200b";
  let pillAnchor: Text | null = null;
  // The editor's HTML minus purely view-side state, for anything saved or snapshotted: the caret
  // anchor's zero-width space and the data-folded markers applyFolding() puts on hidden blocks
  // (recomputed from each heading's data-collapsed whenever a note is shown, so never worth storing).
  function editorHtml(): string {
    let html = surface.innerHTML.split(' data-folded=""').join("").replace(/ data-depth="\d+"/g, "");
    if (pillAnchor) html = html.split(PILL_ANCHOR).join("");
    return html;
  }
  const isPillNode = (n: Node | null | undefined): n is HTMLElement =>
    !!n && n.nodeType === 1 && (n as HTMLElement).classList.contains("note-pill");

  // The pill whose end the (collapsed) caret sits at: `inside` = within the pill, after its last
  // character; `outside` = any DOM form of the spot just after it (excluding our own anchor).
  function pillEdgeAtCaret(): { pill: HTMLElement; inside: boolean } | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (!surface.contains(node) || node === pillAnchor) return null;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    const inside = el && el.closest ? (el.closest(".note-pill") as HTMLElement | null) : null;
    if (inside && surface.contains(inside)) {
      const rest = document.createRange();
      rest.setStart(node, r.startOffset);
      rest.setEnd(inside, inside.childNodes.length);
      return rest.toString() === "" ? { pill: inside, inside: true } : null;
    }
    if (node.nodeType === 3 && r.startOffset === 0 && isPillNode(node.previousSibling)) return { pill: node.previousSibling, inside: false };
    if (node.nodeType === 1 && r.startOffset > 0 && isPillNode(node.childNodes[r.startOffset - 1])) return { pill: node.childNodes[r.startOffset - 1] as HTMLElement, inside: false };
    return null;
  }
  function caretAfterPill(pill: HTMLElement) {
    let anchor = pill.nextSibling as Text | null;
    if (!(anchor && anchor === pillAnchor)) {
      anchor = document.createTextNode(PILL_ANCHOR);
      pill.after(anchor);
      pillAnchor = anchor;
    }
    window.getSelection()!.collapse(anchor, anchor.data.indexOf(PILL_ANCHOR) + 1);
  }
  function caretAtPillEnd(pill: HTMLElement) {
    const r = document.createRange();
    r.selectNodeContents(pill);
    r.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }
  // Strips the anchor's zero-width space (or drops the whole node if that's all it holds), keeping
  // the caret where it was if it's inside the anchor.
  function releasePillAnchor() {
    const anchor = pillAnchor;
    pillAnchor = null;
    if (!anchor || !anchor.parentNode) return;
    const idx = anchor.data.indexOf(PILL_ANCHOR);
    if (idx < 0) return;
    if (anchor.data.length === 1) {
      anchor.remove();
      return;
    }
    const sel = window.getSelection();
    const caretHere = !!sel && sel.isCollapsed && sel.anchorNode === anchor;
    const offset = caretHere ? sel!.anchorOffset : 0;
    anchor.deleteData(idx, 1);
    if (caretHere) sel!.collapse(anchor, offset > idx ? offset - 1 : offset);
  }
  // A document-level listener, so it's swapped rather than added: the editor is rebuilt on every note
  // switch, and each rebuild used to leave its predecessor's listener (and detached editor) behind.
  if (editorSelectionListener) document.removeEventListener("selectionchange", editorSelectionListener);
  editorSelectionListener = () => {
    if (restoringHistory) return;
    const sel = window.getSelection();
    if (pillAnchor && !(sel && sel.isCollapsed && sel.anchorNode === pillAnchor)) releasePillAnchor();
    // A click (or ←) landing just after a pill: move it onto the anchor so the caret shows outside.
    const edge = pillEdgeAtCaret();
    if (edge && !edge.inside) caretAfterPill(edge.pill);
  };
  document.addEventListener("selectionchange", editorSelectionListener);

  // A list item's bullet/number takes the color of the item's first character, so coloring the start
  // of a line recolors its marker too (the browser otherwise always paints markers in the item's own,
  // uncolored text color). Stored as --marker-c on the <li>, read by li::marker in the CSS.
  function firstTextColor(li: HTMLElement): string {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === 1 && /^(UL|OL)$/.test((n as Element).tagName) ? NodeFilter.FILTER_REJECT
          : n.nodeType === 3 && (n as Text).data.replace(/\u200b/g, "").trim() ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
    });
    const text = walker.nextNode();
    let el = text ? text.parentElement : null;
    while (el && el !== li) {
      if (el.tagName === "SPAN" && el.style.color) return el.style.color;
      if (el.tagName === "FONT" && el.getAttribute("color")) return el.getAttribute("color")!;
      if (el.classList.contains("note-pill")) {
        if (el.style.color) return el.style.color;
        const pillC = el.style.getPropertyValue("--pill-c").trim() || "var(--primary-main)";
        return `color-mix(in srgb, ${pillC} 50%, var(--text-primary))`;
      }
      el = el.parentElement;
    }
    return "";
  }
  function syncListMarkerColors() {
    Array.prototype.slice.call(surface.querySelectorAll("li")).forEach((li: HTMLElement) => {
      const c = firstTextColor(li);
      // Only write when it actually changes: this runs from a MutationObserver that also sees its own
      // style writes, so an unchanged value must not touch the DOM again.
      if (li.style.getPropertyValue("--marker-c") === c) return;
      if (c) li.style.setProperty("--marker-c", c);
      else {
        li.style.removeProperty("--marker-c");
        if (!li.getAttribute("style")) li.removeAttribute("style");
      }
    });
  }
  let markerSyncFrame = 0;
  new MutationObserver(() => {
    if (markerSyncFrame) return;
    markerSyncFrame = requestAnimationFrame(() => {
      markerSyncFrame = 0;
      syncListMarkerColors();
    });
  }).observe(surface, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "color", "class"] });
  syncListMarkerColors();

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
  // level (so toggles can't nest); a standalone paragraph ends ONLY a toggle section, never an H1-H3's.
  function setFlag(el: HTMLElement, name: string, on: boolean) {
    if (on && !el.hasAttribute(name)) el.setAttribute(name, "");
    else if (!on && el.hasAttribute(name)) el.removeAttribute(name);
  }
  function applyFolding() {
    let hideUntil = 0;
    const open: number[] = []; // levels of the sections enclosing the current block, outermost first
    Array.prototype.slice.call(surface.children).forEach((el: HTMLElement) => {
      const level = headingLevel(el);
      const standalone = el.tagName === "P" && el.hasAttribute("data-standalone");
      if (level) while (open.length && open[open.length - 1] >= level) open.pop();
      if (standalone) while (open.length && open[open.length - 1] === 4) open.pop();
      if (hideUntil && ((level && level <= hideUntil) || (standalone && hideUntil === 4))) hideUntil = 0;
      const depth = String(open.length);
      if (open.length) {
        if (el.getAttribute("data-depth") !== depth) el.setAttribute("data-depth", depth);
      } else if (el.hasAttribute("data-depth")) {
        el.removeAttribute("data-depth");
      }
      setFlag(el, "data-folded", !!hideUntil);
      if (level) open.push(level);
      if (!hideUntil && level && el.hasAttribute("data-collapsed")) hideUntil = level;
    });
  }
  // Every structural change (typing a new block, setBlockType's replacements, undo/redo, paste)
  // shows up as a childList change on the surface itself; applyFolding only touches attributes, so
  // it can't retrigger this.
  new MutationObserver(applyFolding).observe(surface, { childList: true });
  applyFolding();

  // Collapsing/expanding is saved locally only: it neither bumps the note's "edited" time (which
  // would reorder the note list) nor marks it for cloud sync. The state rides along to the cloud
  // with the next real edit of the note.
  function toggleFold(heading: HTMLElement) {
    if (heading.hasAttribute("data-collapsed")) heading.removeAttribute("data-collapsed");
    else heading.setAttribute("data-collapsed", "");
    applyFolding();
    const sel = window.getSelection();
    const caretBlock = sel && sel.rangeCount ? blockAt(sel.getRangeAt(0).startContainer) : null;
    if (caretBlock && caretBlock.hasAttribute("data-folded")) {
      const r = document.createRange();
      r.selectNodeContents(heading);
      r.collapse(false);
      sel!.removeAllRanges();
      sel!.addRange(r);
    }
    saveFoldState();
  }
  function saveFoldState() {
    const n = currentNote();
    if (n) {
      n.html = editorHtml();
      void persist();
    }
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
    saveFoldState();
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
    const block = blockAt(r.startContainer);
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
  surface.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement;
    const heading = target && target.closest ? (target.closest("h1, h2, h3, h4") as HTMLElement | null) : null;
    if (!heading || heading.parentElement !== surface) return;
    // Only the chevron itself, which sits left of the heading's own box.
    if (ev.clientX >= heading.getBoundingClientRect().left) return;
    ev.preventDefault();
    toggleFold(heading);
  });

  // The editor must always hold at least one real block. Backspace/Delete in a note whose only block
  // is empty made Chrome remove that block entirely, leaving typed text loose in the surface (outside
  // any <p>) and Enter falling back to a bare <br> — the shorter line gap. Two guards: those keys are
  // swallowed when there's nothing left to delete (keydown handler), and any edit that still empties
  // the surface (e.g. select-all + delete) gets its loose content wrapped back into a paragraph here.
  function isOnlyEmptyBlock(): HTMLElement | null {
    const only = surface.children.length === 1 ? (surface.firstElementChild as HTMLElement) : null;
    if (!only || !/^(P|H[1-4]|BLOCKQUOTE)$/.test(only.tagName)) return null;
    if ((only.textContent || "").replace(/\u200b/g, "") !== "" || only.querySelector("hr, ul, ol")) return null;
    return only;
  }
  function ensureBlockWrapper() {
    const hasBlock = Array.prototype.some.call(surface.children, (el: Element) => /^(P|H[1-4]|BLOCKQUOTE|UL|OL|HR|DIV)$/.test(el.tagName));
    if (hasBlock) return;
    const p = document.createElement("p");
    while (surface.firstChild) p.appendChild(surface.firstChild);
    if (!(p.textContent || "").trim() && !p.querySelector("br")) p.innerHTML = "<br>";
    surface.appendChild(p);
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }
  surface.addEventListener("input", () => {
    ensureBlockWrapper();
    if (pillAnchor && pillAnchor.data !== PILL_ANCHOR) releasePillAnchor();
    const n = currentNote();
    if (n) n.html = editorHtml();
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
    // → at a pill's last character steps just outside it instead of skipping past the next
    // character, so there's a way to put the caret right after a pill (see pillEndingAtCaret).
    if (guardFoldedMerge(ev)) return;
    if ((ev.key === "Backspace" || ev.key === "Delete") && window.getSelection()?.isCollapsed) {
      const only = isOnlyEmptyBlock();
      if (only) {
        ev.preventDefault();
        // An empty heading/quote as the only block goes back to a plain paragraph instead.
        if (only.tagName !== "P") {
          pushHistory();
          setBlockType("P");
          surface.dispatchEvent(new Event("input"));
        }
        return;
      }
    }
    // Enter at a pill's end (inside it): Chrome clones the pill onto the new line as an empty pill
    // the next characters land in, and breaking out of a list from there (a second Enter) turns that
    // into stray inline color/background styles. Stepping just outside the pill first makes the new
    // line start clean. (Shift+Enter, a line break WITHIN the pill, is left alone.)
    if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      const edge = pillEdgeAtCaret();
      if (edge && edge.inside) caretAfterPill(edge.pill);
    }
    if (ev.key === "Enter") {
      const sel = window.getSelection();
      const block = sel && sel.rangeCount ? blockAt(sel.getRangeAt(0).startContainer) : null;
      if (block && headingLevel(block)) {
        // Ctrl+Enter collapses/expands the heading the caret is in (keyboard access to the chevron).
        if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); toggleFold(block); return; }
        // A plain Enter in a collapsed heading expands it first: the new line would otherwise land
        // inside the hidden section (with the caret in it), and Chrome copies the heading's
        // attributes onto the half it splits off, which would duplicate the collapsed state.
        if (block.hasAttribute("data-collapsed")) { block.removeAttribute("data-collapsed"); applyFolding(); }
      }
    }
    const plainArrow = !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    if (ev.key === "ArrowRight" && plainArrow) {
      const edge = pillEdgeAtCaret();
      if (edge && edge.inside) { ev.preventDefault(); caretAfterPill(edge.pill); updateToolbarState(); }
      return;
    }
    if (ev.key === "ArrowLeft" && plainArrow) {
      const sel = window.getSelection();
      const prev = pillAnchor && pillAnchor.previousSibling;
      if (sel && sel.anchorNode === pillAnchor && isPillNode(prev)) { ev.preventDefault(); caretAtPillEnd(prev); updateToolbarState(); }
      return;
    }
    if (ev.key !== "Tab") return;
    if (!caretInList()) return;
    ev.preventDefault();
    pushHistory();
    document.execCommand(ev.shiftKey ? "outdent" : "indent", false, undefined);
    const n = currentNote();
    if (n) n.html = editorHtml();
    scheduleSave();
    updateEmptyState();
    updateToolbarState();
  });
  surface.addEventListener("keyup", updateToolbarState);
  surface.addEventListener("mouseup", updateToolbarState);
  // Double-clicking a word made of two adjacent pills (no space between them) selected the whole word
  // across both. Clamp the browser's word selection to the pill that was actually clicked.
  surface.addEventListener("dblclick", (ev) => {
    const pill = (ev.target as HTMLElement).closest ? ((ev.target as HTMLElement).closest(".note-pill") as HTMLElement | null) : null;
    const sel = window.getSelection();
    if (!pill || !surface.contains(pill) || !sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0).cloneRange();
    const bounds = document.createRange();
    bounds.selectNodeContents(pill);
    if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) range.setStart(bounds.startContainer, bounds.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) range.setEnd(bounds.endContainer, bounds.endOffset);
    sel.removeAllRanges();
    sel.addRange(range);
    updateToolbarState();
  });

  function caretInList(): boolean {
    try {
      return document.queryCommandState("insertUnorderedList") || document.queryCommandState("insertOrderedList");
    } catch {
      return false;
    }
  }
  function updateEmptyState() {
    // No text AND no text-less structure (a list item, divider or quote), which the placeholder,
    // overlaid on the first line, would otherwise cover.
    const isEmpty = surface.textContent!.replace(/​/g, "").trim() === "" && !surface.querySelector("ul, ol, hr, blockquote");
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
    const menuTag = /^H[1-4]$/.test(currentBlockTag) ? currentBlockTag : "P";
    document.querySelectorAll(`#${idPrefix}Toolbar button[data-cmd="formatBlock"]`).forEach((b) => {
      b.classList.toggle("active", (b as HTMLElement).dataset.value!.toUpperCase() === menuTag);
    });
    const blockLabel = document.getElementById(idPrefix + "BlockPickerLabel");
    if (blockLabel) blockLabel.textContent = (BLOCK_TYPES.find((t) => t.tag === menuTag) || BLOCK_TYPES[0]).short;

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
  closeTemplateMenu();
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

newNoteBtnEl.addEventListener("click", () => {
  if (templateMenu.hidden) openTemplateMenu(); else closeTemplateMenu();
});
document.getElementById("blankNoteBtn")!.addEventListener("click", () => void createNote());
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
  const cloudSection = document.getElementById("cloudSyncSection");
  if (cloudSection) {
    cloudSection.hidden = !cloudSyncAvailable();
    if (cloudSyncAvailable()) updateCloudAccountUI(getCurrentUser());
  }
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

document.getElementById("cloudSignInBtn")!.addEventListener("click", () => {
  void signInWithGoogle().catch((err) => {
    console.error("Notes: Google sign-in failed", err);
    window.alert(strings().cloudSignInError);
  });
});
document.getElementById("cloudSignOutBtn")!.addEventListener("click", () => void signOutCloud());
document.getElementById("cloudSyncNowBtn")!.addEventListener("click", () => void flushCloudSync());

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
  document.getElementById("blankNoteLabel")!.textContent = s.blankNote;
  document.getElementById("templatesLabel")!.textContent = s.templatesLabel;
  renderTemplateList();

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
  document.getElementById("settingsCloudLabel")!.textContent = s.settingsCloudLabel;
  document.getElementById("cloudSyncHint")!.textContent = s.cloudSyncHint;
  document.getElementById("cloudSignInBtn")!.textContent = s.cloudSignInBtn;
  document.getElementById("cloudSignOutBtn")!.textContent = s.cloudSignOutBtn;
  document.getElementById("cloudSyncNowBtn")!.textContent = s.cloudSyncNowBtn;
  updateSyncIndicator();
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

  // Double-click: back to the default size. Must match action.width/height in public/manifest.json
  // (the whole iframe, margin included); the panel itself goes back to its CSS default (100%).
  const DEFAULT_IFRAME_W = 434;
  const DEFAULT_IFRAME_H = 580;
  handle.addEventListener("dblclick", () => {
    panel.style.width = "";
    panel.style.height = "";
    void Promise.all([OBR.action.setWidth(DEFAULT_IFRAME_W), OBR.action.setHeight(DEFAULT_IFRAME_H)]).then(syncToRealViewport);
  });
})();

// ---------- role: this is a GM-only tool; players see a blocking gate instead ----------
function applyRoleView() {
  const isPlayer = role === "PLAYER";
  document.getElementById("normalView")!.hidden = isPlayer;
  document.getElementById("gmGate")!.hidden = !isPlayer;
  if (isPlayer) {
    closeDropdown();
    closeTemplateMenu();
    closeSettings();
  }
}

// ---------- cloud sync: merging what Firestore has with what's local (see cloudSync.ts) ----------
// Last-write-wins per note, by `updatedAt` — a cloud copy only overwrites the local one when it's
// genuinely newer, so it can never clobber an edit this device made more recently than what's
// arriving. Re-rendering the editor when the ACTIVE note changes is a deliberate simplification: it
// mirrors how switching notes already re-renders from scratch, at the small cost of a visible refresh
// if a remote update happens to land in the same instant as active typing here.
function mergeCloudNotes(cloudNotes: Note[], removedIds: string[]) {
  let listChanged = false;
  let activeNoteChanged = false;
  removedIds.forEach((id) => {
    const idx = notes.findIndex((n) => n.id === id);
    if (idx === -1) return;
    notes.splice(idx, 1);
    listChanged = true;
    if (activeId === id) {
      activeId = notes.length ? notes[0].id : null;
      activeNoteChanged = true;
    }
  });
  cloudNotes.forEach((cloudNote) => {
    const idx = notes.findIndex((n) => n.id === cloudNote.id);
    if (idx === -1) {
      notes.push(cloudNote);
      listChanged = true;
    } else if (cloudNote.updatedAt > notes[idx].updatedAt) {
      notes[idx] = cloudNote;
      listChanged = true;
      if (activeId === cloudNote.id) activeNoteChanged = true;
    }
  });
  if (!listChanged) return;
  void persist();
  renderList();
  if (activeNoteChanged) renderEditor();
}

let stopCloudWatch: (() => void) | null = null;
let stopTemplateWatch: (() => void) | null = null;
function applyCloudAuthState(user: User | null) {
  stopCloudWatch?.();
  stopCloudWatch = null;
  stopTemplateWatch?.();
  stopTemplateWatch = null;
  if (user && currentRoomIdForCloud) {
    stopCloudWatch = watchCloudNotes(currentRoomIdForCloud, mergeCloudNotes);
  }
  if (user) {
    // Templates aren't per room, so they sync regardless of which room this is.
    stopTemplateWatch = watchCloudTemplates(
      () => templates,
      (next) => {
        templates = next;
        void persistTemplates();
        renderTemplateList();
      }
    );
  }
  updateCloudAccountUI(user);
  updateSyncIndicator();
}
let currentRoomIdForCloud: string | null = null;

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
  try {
    templates = await getTemplates();
    templatesLoaded = true;
  } catch (err) {
    // Templates are an extra — failing to load them mustn't keep the notes themselves from opening.
    console.error("Notes: failed to load templates", err);
  }

  setThemeAccent = watchTheme(panel, accentPref);

  applyLanguage();
  applyRoleView();

  if (cloudSyncAvailable()) {
    currentRoomIdForCloud = OBR.room.id;
    initCloudSyncContext(currentRoomIdForCloud, (id) => notes.find((n) => n.id === id));
    onSyncStatusChange(updateSyncIndicator);
    onAuthChange(applyCloudAuthState);
  }

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
