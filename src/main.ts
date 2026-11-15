import OBR from "@owlbear-rodeo/sdk";
import "./style.css";
import { getStrings } from "./i18n";
import type { Language, Strings } from "./i18n";
import { getNotes, setNotes, getTrash, setTrash, getErased, setErased, notesStorageBytes, getFolders, setFolders, getFoldedFolders, setFoldedFolders, getErasedFolders, setErasedFolders, FOLDER_MAX_DEPTH } from "./notes";
import { sanitizeNoteHtml } from "./sanitizeHtml";
import { escapeHtml, markdownToHtml, flattenToInline, stripHtml } from "./markdown";
import { exportNote as exportNoteFile, exportAll, contentFromImportFile, isDuplicateTemplate } from "./importExport";
import type { ExportFormat } from "./importExport";
import { TRASH_ICON_PATH } from "./icons";
import { createTableEditor } from "./tableEditor";
import { renderToolbar, BLOCK_TYPES, BLOCK_ONLY_CMDS } from "./toolbar";
import type { BlockTag } from "./toolbar";
import { createHistory } from "./history";
import { createSections } from "./sections";
import { SECRET_ATTR, SECRET_MODEL, SECRET_TAGS, blockUnits, expandSecretMarks, secretPartCount, secretUnits } from "./secret";
import { LINK_ATTR, linkElement, linkedIds, syncLinks } from "./noteLinks";
import type { LinkTarget } from "./noteLinks";
import { normalizeStructure, splitBlock, keepingSelection, itemToLine, markPills, restorePills } from "./structure";
import type { Note, Folder } from "./notes";
import { getPluginId } from "./pluginId";
import { getTemplates, setTemplates, resolveTemplate, toCustomTemplate, missingBuiltins, newBuiltinTemplate } from "./templates";
import type { Template } from "./templates";
import { getLanguage, setLanguage, getAccentPref, setAccentPref, getSecretEyeLocked, setSecretEyeLocked, getItemLinksEnabled, setItemLinksEnabled, getNoteSort, setNoteSort } from "./prefs";
import type { NoteSort } from "./prefs";
import { ITEM_LINK_CHANNEL, ITEM_LINK_KEY, isFreshRequest, isItemLinkRequestKey, itemLabel, takeItemLinkRequest } from "./itemLinks";
import type { ItemLinkMessage, ItemLinkRequest } from "./itemLinks";
import type { AccentPref } from "./prefs";
import { ACCENTS, ACCENT_ORDER, watchTheme } from "./theme";
import {
  cloudSyncAvailable,
  startCloudSync,
  prepareCloudSync,
  getCurrentUser,
  signInWithGoogle,
  signOutCloud,
  getSyncStatus,
  markNoteDirty,
  deleteNoteFromCloud,
  refreshSharedCopies,
  flushCloudSync,
  watchCloudNotes,
  watchCloudTemplates,
  pushFolder,
  deleteFolderFromCloud,
  watchCloudFolders,
  pushTemplate,
  deleteTemplateFromCloud,
  setSharedKey,
  watchSharedNotes,
  publishNote,
  unpublishNote,
  reconcileSharedNotes,
  watchOwnSharedNotes,
  editorUid,
  takeSharedLock,
  saveSharedEdit,
  releaseSharedLock,
} from "./cloud";
import type { SharedCopy } from "./cloud";
import { LOCK_IDLE, LOCK_RENEW, lockHolder, lockLapsesIn, noteLockSeen } from "./editLock";
import { ensurePublicKey, getPublicKey, watchPublicKey, replacePublicKey } from "./publicKey";
import type { User } from "firebase/auth";

// ---------- state ----------
let notes: Note[] = [];
// The list's folders (see Folder in notes.ts), and which ones are folded on this device.
let folders: Folder[] = [];
let foldedFolders = new Set<string>();
// False until the stored folders have been read: saving before that would wipe them.
let foldersLoaded = false;
// Folders deleted here that the cloud may not have heard about yet (see folderSync.ts).
let erasedFolders = new Set<string>();
function saveErasedFolders() {
  void setErasedFolders(Array.from(erasedFolders)).catch((err) => console.error("Notes: failed to save deleted folders", err));
}
// Deleted notes, restorable for 30 days (see the trash section), and whether the switcher shows them.
let trash: Note[] = [];
let trashView = false;
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
// Settings → Hidden parts: whether the eye next to a hidden part ignores clicks.
let secretEyeLocked = false;
// The open editor's redraw of its hidden parts (the eyes change with the setting above).
let redrawSecret: (() => void) | null = null;
// Settings → Linked items, and the switcher's "pick the note for these items" mode (see the linked
// items section).
let itemLinksEnabled = true;
let itemPick: { itemIds: string[]; names: string[] } | null = null;
// The notes list's order (see the list footer); pinned notes come first either way.
let noteSort: NoteSort = "recent";
let role: "GM" | "PLAYER" = "GM";
// The room's key for public notes (see publicKey.ts), null until some GM publishes the first one.
let publicKey: string | null = null;
// A player sees the room's public notes instead (read-only, live from Firestore), never `notes`:
// those are this browser's own, and nothing here may write over them.
let sharedNotes: Note[] = [];
let sharedState: "loading" | "ready" | "error" = "loading";
let playerActiveId: string | null = null;
// This player's name in Owlbear: what others see while they edit a note (see editLock.ts).
let playerName = "";
// The open editor, for what happens outside it: a note it's editing in the players' copy (see
// buildNoteEditor) holds that note's lock, and isn't rebuilt under its holder.
interface EditorSession {
  noteId: string;
  player: boolean;
  /** Editing a shared note now: holding its lock, taking it, or with an edit still to go up. */
  busy(): boolean;
  html(): string;
  title(): string;
  /** A lock changed: the editor locks or unlocks to match. */
  refreshLock(): void;
  /** Leaving: the last edit goes up and the lock is let go. */
  end(): void;
}
let editorSession: EditorSession | null = null;
function endEditorSession() {
  const session = editorSession;
  editorSession = null;
  session?.end();
}
window.addEventListener("pagehide", endEditorSession);
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

// List kinds, as the list menu offers them: a checklist is a bullet list marked data-check.
type ListKind = "UL" | "OL" | "CHECK";
const CHECK_ATTR = "data-check";
function listKind(list: Element): ListKind {
  return list.tagName === "OL" ? "OL" : list.hasAttribute(CHECK_ATTR) ? "CHECK" : "UL";
}

function strings(): Strings {
  return getStrings(language);
}

async function persist(): Promise<boolean> {
  try {
    await Promise.all([setNotes(notes), setTrash(trash), foldersLoaded ? setFolders(folders) : null]);
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
  const usedKB = ((notesStorageBytes(notes) + notesStorageBytes(trash)) / 1024).toFixed(1);
  text.textContent = strings().storageMeterText(usedKB);
}

// The little cloud icon next to the save indicator: hidden entirely unless a Firebase project is
// configured (see firebaseConfig.ts) — cloud sync is opt-in infrastructure, not something to hint at
// for anyone who hasn't set it up. Doubles as a manual "sync now" button once signed in; when signed
// out, clicking it opens Settings instead, since that's where signing in actually happens.
function updateSyncIndicator() {
  const btn = document.getElementById("gmCloudSyncBtn") as HTMLButtonElement | null;
  // A player's editor saves to the shared copy only: the account's sync has nothing to say there.
  if (!btn || !cloudSyncAvailable() || isPlayerView()) {
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
  // Replacing the key moves this account's public copies, so it needs the account.
  (document.getElementById("sharedKeySection") as HTMLElement).hidden = !user || role !== "GM";
}

// Clipboard format for copying WITHIN GM Notes with formatting intact. Pasting anything else stays
// plain text (see the paste handler); only content carrying this type keeps its formatting.
const CLIPBOARD_TYPE = "application/x-gm-notes";

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
// Players get the public notes; without cloud sync they just get the gate (see applyRoleView).
function isPlayerView(): boolean {
  return role === "PLAYER" && cloudSyncAvailable();
}
function viewNotes(): Note[] {
  return isPlayerView() ? sharedNotes : notes;
}
function getActive(): Note | undefined {
  return isPlayerView() ? sharedNotes.find((n) => n.id === playerActiveId) : notes.find((n) => n.id === activeId);
}
function filteredNotes(): Note[] {
  if (!searchTerm) return viewNotes();
  const q = searchTerm.toLowerCase();
  return viewNotes().filter((n) => n.title.toLowerCase().includes(q) || stripHtml(n.html).toLowerCase().includes(q));
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
  switcherCountEl.textContent = String(viewNotes().length);
}

// The list's order: pinned first (the GM's own list only), then by title or by last edit.
function sortNotes(ns: Note[], readOnly = isPlayerView()): Note[] {
  const untitled = strings().untitled;
  const byTitle = (n: Note) => (n.title || untitled).toLocaleLowerCase(language);
  return ns.slice().sort((a, b) => {
    if (!readOnly && !!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (!readOnly && noteSort === "alpha") return byTitle(a).localeCompare(byTitle(b), language);
    return b.updatedAt - a.updatedAt;
  });
}

function renderList() {
  folderIndex = buildFolderIndex();
  try {
    renderListNow();
  } finally {
    folderIndex = null;
  }
}
function renderListNow() {
  updateTrashChrome();
  updateSortButton();
  closeRowMenu();
  if (trashView && !isPlayerView()) {
    renderTrash();
    return;
  }
  const list = filteredNotes();
  updateSwitcherHeader();
  const s = strings();

  const readOnly = isPlayerView();
  // Players see a flat list; the GM sees the folders (see renderFolderLevel), while searching only
  // those with a match.
  const flat = readOnly;
  const search = !flat && searchTerm ? folderSearch(searchTerm, list) : null;
  if (!list.length && (flat || !folders.length || (search && !search.show.size))) {
    const empty = viewNotes().length ? escapeHtml(s.emptySearch) : readOnly ? escapeHtml(sharedEmptyMessage()) : s.emptyList;
    noteListEl.innerHTML = `<div class="empty-list">${empty}</div>`;
    return;
  }

  noteListEl.innerHTML = "";
  const sorted = (ns: Note[]) => sortNotes(ns, readOnly);
  const noteItem = (n: Note): HTMLElement => {
    const item = document.createElement("div");
    item.className = "note-item" + (n.id === (readOnly ? playerActiveId : activeId) ? " active" : "");
    item.dataset.id = n.id;
    if (!flat) makeDraggable(item, () => ({ note: n }));

    const row = document.createElement("div");
    row.className = "note-item-row";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = n.title || s.untitled;

    // Players only ever see public notes: for them, the dot marks the ones they can edit.
    if (n.public && (!readOnly || n.editable)) {
      const dot = document.createElement("span");
      dot.className = "public-dot" + (n.editable ? " editable" : "");
      dot.title = n.editable ? (readOnly ? s.editableDotPlayerTitle : s.editableDotTitle) : s.publicDotTitle;
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", dot.title);
      row.appendChild(dot);
    }

    // Pin: in the grid, always shown on a pinned note, on hover for the rest.
    const pin = document.createElement("button");
    pin.className = "row-btn pin-btn" + (n.pinned ? " pinned" : "");
    pin.title = n.pinned ? s.unpinTitle : s.pinTitle;
    pin.setAttribute("aria-label", pin.title + ": " + (n.title || s.untitled));
    pin.setAttribute("aria-pressed", String(!!n.pinned));
    pin.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.5 1.8 14.2 6.5l-2 .6-2.6 2.6.3 3.3-1.4 1.4-2.7-2.7L2.3 15 1 13.7l3.5-3.5-2.7-2.7 1.4-1.4 3.3.3 2.6-2.6.4-2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    pin.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void togglePin(n.id);
    });

    const moreBtn = document.createElement("button");
    moreBtn.className = "row-btn more-btn";
    moreBtn.title = s.moreActions;
    moreBtn.setAttribute("aria-label", s.moreActions + ": " + (n.title || s.untitled));
    moreBtn.setAttribute("aria-haspopup", "menu");
    moreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
    moreBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openRowMenu(moreBtn, n);
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
    del.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">${TRASH_ICON_PATH}</svg>`;
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void deleteNote(n.id);
    });

    row.appendChild(title);

    // A grid beside the whole item (not inline after the title) so the title keeps most of the
    // row's width: rename and delete; pin, and "more" (duplicate, save as template, export) last.
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.appendChild(editBtn);
    actions.appendChild(del);
    actions.appendChild(pin);
    actions.appendChild(moreBtn);

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

    item.appendChild(body);
    if (!readOnly) {
      item.classList.add("with-actions");
      item.appendChild(actions);
    }

    item.addEventListener("click", () => {
      if (itemPick && !readOnly) {
        void linkItemsTo(n.id);
        return;
      }
      if (readOnly) playerActiveId = n.id;
      else activeId = n.id;
      renderList();
      renderEditor();
      closeDropdown();
    });

    return item;
  };
  if (flat) {
    sorted(list).forEach((n) => noteListEl.appendChild(noteItem(n)));
    return;
  }
  renderFolderLevel(null, noteListEl, 0, { list, sorted, noteItem, search });
}

// ---------- folders (see Folder in notes.ts) ----------
// A note or folder pointing at a folder that's gone (deleted on another device, say) sits at the
// root. So does a folder whose parents loop back to it (only possible through bad data).
// While the list renders, the tree is read over and over: an index built once for that render
// answers instead of scanning the folders each time (see renderList).
interface FolderIndex {
  byId: Map<string, Folder>;
  parent: Map<string, string | null>;
  children: Map<string | null, Folder[]>;
  subtree: Map<string, Set<string>>;
}
let folderIndex: FolderIndex | null = null;
function buildFolderIndex(): FolderIndex {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parent = new Map<string, string | null>();
  const children = new Map<string | null, Folder[]>();
  folders.forEach((f) => {
    const p = folderParentId(f);
    parent.set(f.id, p);
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(f);
  });
  children.forEach((list) => list.sort(byFolderName));
  return { byId, parent, children, subtree: new Map() };
}
function byFolderName(a: Folder, b: Folder): number {
  return a.name.toLocaleLowerCase(language).localeCompare(b.name.toLocaleLowerCase(language), language);
}
function folderById(id: string | undefined): Folder | undefined {
  if (!id) return undefined;
  return folderIndex ? folderIndex.byId.get(id) : folders.find((f) => f.id === id);
}
function noteFolderId(n: Note): string | null {
  return folderById(n.folderId) ? n.folderId! : null;
}
function folderParentId(f: Folder): string | null {
  if (folderIndex) return folderIndex.parent.get(f.id) ?? null;
  let p = folderById(f.parentId);
  if (!p) return null;
  const seen = new Set([f.id]);
  for (let up: Folder | undefined = p; up; up = folderById(up.parentId)) {
    if (seen.has(up.id)) return null;
    seen.add(up.id);
  }
  return p.id;
}
function childFolders(parentId: string | null): Folder[] {
  if (folderIndex) return folderIndex.children.get(parentId) ?? [];
  return folders.filter((f) => folderParentId(f) === parentId).sort(byFolderName);
}
// A folder and every folder inside it, at any depth.
function folderSubtree(id: string): Set<string> {
  if (folderIndex) {
    let ids = folderIndex.subtree.get(id);
    if (!ids) {
      const set = new Set([id]);
      childFolders(id).forEach((c) => folderSubtree(c.id).forEach((x) => set.add(x)));
      folderIndex.subtree.set(id, set);
      ids = set;
    }
    return ids;
  }
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    folders.forEach((f) => {
      const p = folderParentId(f);
      if (p && ids.has(p) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
    });
  }
  return ids;
}
// Every note inside a folder, its subfolders' included.
function notesInFolder(id: string, list: Note[]): Note[] {
  const ids = folderSubtree(id);
  return list.filter((n) => { const fid = noteFolderId(n); return !!fid && ids.has(fid); });
}
// 1 for a folder at the root, 2 for one inside it, and so on.
function folderDepth(f: Folder): number {
  let depth = 1;
  for (let p = folderParentId(f); p; p = folderParentId(folderById(p)!)) depth++;
  return depth;
}
// How many levels a folder takes with what's inside it (1: no subfolders).
function folderHeight(id: string): number {
  return 1 + Math.max(0, ...childFolders(id).map((c) => folderHeight(c.id)));
}
// One level of the tree: its folders first (by name, each followed by its contents unless folded),
// then its notes in the list's order.
// While searching: the folders to show (those with a matching note, and their parents), and those
// whose whole contents show (a folder whose name matches, and everything inside it).
interface FolderSearch {
  show: Set<string>;
  whole: Set<string>;
}
function folderSearch(term: string, matches: Note[]): FolderSearch {
  const q = term.toLowerCase();
  const whole = new Set<string>();
  folders.filter((f) => f.name.toLowerCase().includes(q)).forEach((f) => folderSubtree(f.id).forEach((id) => whole.add(id)));
  const show = new Set<string>();
  const withParents = (id: string | null) => {
    for (let f = folderById(id ?? undefined); f && !show.has(f.id); f = folderById(folderParentId(f) ?? undefined)) show.add(f.id);
  };
  matches.forEach((n) => withParents(noteFolderId(n)));
  whole.forEach(withParents);
  return { show, whole };
}
interface TreeRender {
  list: Note[];
  sorted: (ns: Note[]) => Note[];
  noteItem: (n: Note) => HTMLElement;
  search: FolderSearch | null;
}
function renderFolderLevel(parentId: string | null, container: HTMLElement, depth: number, tree: TreeRender) {
  const { search } = tree;
  // Inside a folder whose name matched the search, every note shows, not only the matching ones.
  const listFor = (folderId: string | null) => (search && folderId && search.whole.has(folderId) ? notes : tree.list);
  childFolders(parentId).forEach((f) => {
    if (search && !search.show.has(f.id)) return;
    // Search results show open, whatever the folders' own state.
    const folded = !search && foldedFolders.has(f.id);
    container.appendChild(folderRow(f, depth + 1, folded, notesInFolder(f.id, listFor(f.id)).length));
    if (folded) return;
    const children = document.createElement("div");
    children.className = "folder-children";
    children.setAttribute("role", "group");
    renderFolderLevel(f.id, children, depth + 1, tree);
    if (children.childElementCount) container.appendChild(children);
  });
  tree.sorted(listFor(parentId).filter((n) => noteFolderId(n) === parentId)).forEach((n) => container.appendChild(tree.noteItem(n)));
}
function folderRow(f: Folder, depth: number, folded: boolean, count: number): HTMLElement {
  const s = strings();
  const row = document.createElement("div");
  row.className = "folder-item";
  row.dataset.folderId = f.id;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-expanded", String(!folded));
  row.innerHTML =
    '<svg class="folder-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '<svg class="folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h3.3l1.5 1.6h5.4c.6 0 1.1.5 1.1 1.1v6.5c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.2Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>';
  const name = document.createElement("span");
  name.className = "title";
  name.textContent = f.name || s.newFolder;
  const countEl = document.createElement("span");
  countEl.className = "folder-count";
  countEl.textContent = String(count);
  countEl.title = s.folderNotes(count);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "row-btn more-btn";
  more.title = s.folderActions;
  more.setAttribute("aria-label", s.folderActions + ": " + (f.name || s.newFolder));
  more.setAttribute("aria-haspopup", "menu");
  more.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
  more.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const entries: MenuEntry[] = [[s.newNoteHere, () => void createNote(undefined, f.id)]];
    if (depth < FOLDER_MAX_DEPTH) entries.push([s.newSubfolder, () => void createFolder(f.id)]);
    entries.push([s.renameFolder, () => startFolderRename(row, f)]);
    entries.push([s.moveTo, () => openMoveMenu(more, { folder: f })]);
    entries.push([s.deleteFolder, () => void deleteFolder(f)]);
    showMenu(more, entries);
  });
  row.append(name, countEl, more);
  makeDraggable(row, () => ({ folder: f }));
  const toggle = () => {
    // Search results always show open (see renderFolderLevel): folding there would do nothing.
    if (searchTerm) return;
    if (foldedFolders.has(f.id)) foldedFolders.delete(f.id);
    else foldedFolders.add(f.id);
    saveFolded();
    renderList();
    (noteListEl.querySelector(`.folder-item[data-folder-id="${CSS.escape(f.id)}"]`) as HTMLElement | null)?.focus();
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (ev) => {
    if (ev.target !== row) return;
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
    else if (ev.key === "ArrowRight" && folded) { ev.preventDefault(); toggle(); }
    else if (ev.key === "ArrowLeft" && !folded) { ev.preventDefault(); toggle(); }
  });
  return row;
}
function newFolderId(): string {
  return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
// Which folders are folded is this device's view only (see notes.ts).
function saveFolded() {
  void setFoldedFolders(Array.from(foldedFolders)).catch((err) => console.error("Notes: failed to save folded folders", err));
}
// Opens a folder and the ones around it, so what's inside shows.
function unfoldFolder(id: string | null) {
  let changed = false;
  for (let f = folderById(id ?? undefined); f; f = folderById(folderParentId(f) ?? undefined)) {
    if (foldedFolders.delete(f.id)) changed = true;
  }
  if (changed) saveFolded();
}
// Deleting a folder takes everything in it, after a warning: its notes go to the trash (back at the
// root when restored, since the folder's gone), its subfolders go with it.
async function deleteFolder(folder: Folder) {
  const s = strings();
  const ids = folderSubtree(folder.id);
  const inside = notesInFolder(folder.id, notes);
  if (!window.confirm(s.deleteFolderConfirm(folder.name || s.newFolder, inside.length, ids.size - 1))) return;
  const gone = new Set(inside.map((n) => n.id));
  // Out of the folder for good: restored, they come back at the root, here and on other devices.
  const now = Date.now();
  inside.forEach((n) => {
    delete n.folderId;
    n.folderAt = now;
    moveToTrash(n);
  });
  notes = notes.filter((n) => !gone.has(n.id));
  folders = folders.filter((f) => !ids.has(f.id));
  // Remembered until the cloud is known to have dropped them too (see folderSync.ts): deleted while
  // signed out, they'd otherwise come back from the cloud on the next sign-in.
  ids.forEach((id) => erasedFolders.add(id));
  saveErasedFolders();
  ids.forEach((id) => void deleteFolderFromCloud(id));
  if ([...ids].some((id) => foldedFolders.delete(id))) saveFolded();
  const activeGone = !!activeId && gone.has(activeId);
  if (activeGone) activeId = notes.length ? notes[0].id : null;
  renderList();
  if (activeGone) renderEditor();
  await persist();
}
async function createFolder(parentId: string | null) {
  const s = strings();
  const folder: Folder = {
    id: newFolderId(),
    name: s.newFolder,
    ...(parentId ? { parentId } : {}),
    updatedAt: Date.now(),
  };
  folders.push(folder);
  void pushFolder(folder);
  unfoldFolder(parentId);
  renderList();
  const row = noteListEl.querySelector(`.folder-item[data-folder-id="${CSS.escape(folder.id)}"]`) as HTMLElement | null;
  if (row) {
    row.scrollIntoView({ block: "nearest" });
    startFolderRename(row, folder);
  }
  await persist();
}
// ---------- moving notes and folders ----------
// From a note's or folder's "Move to…", or by dragging it onto a folder (into it), onto a note
// (beside it, in its folder) or onto the list's empty space (the root). A folder can't go inside
// itself, nor anywhere it would end up deeper than FOLDER_MAX_DEPTH with what's inside it.
type Movable = { note: Note } | { folder: Folder };
function canMoveTo(what: Movable, target: string | null): boolean {
  if ("note" in what) return true;
  if (target === null) return true;
  if (folderSubtree(what.folder.id).has(target)) return false;
  return folderDepth(folderById(target)!) + folderHeight(what.folder.id) <= FOLDER_MAX_DEPTH;
}
function currentPlace(what: Movable): string | null {
  return "note" in what ? noteFolderId(what.note) : folderParentId(what.folder);
}
// The note or folder as it is now: a menu or drag may hold an object the cloud has since replaced.
function freshMovable(what: Movable): Movable | null {
  if ("note" in what) {
    const n = notes.find((x) => x.id === what.note.id);
    return n ? { note: n } : null;
  }
  const f = folderById(what.folder.id);
  return f ? { folder: f } : null;
}
async function moveTo(held: Movable, target: string | null) {
  const what = freshMovable(held);
  if (!what || (target !== null && !folderById(target))) return;
  if (!canMoveTo(what, target) || currentPlace(what) === target) return;
  if ("note" in what) {
    // Not an edit: updatedAt stays (see folderAt).
    const n = what.note;
    if (target) n.folderId = target;
    else delete n.folderId;
    n.folderAt = Date.now();
    markNoteDirty(n.id);
  } else {
    const f = what.folder;
    if (target) f.parentId = target;
    else delete f.parentId;
    f.updatedAt = Date.now();
    void pushFolder(f);
  }
  unfoldFolder(target);
  renderList();
  await persist();
}
function openMoveMenu(anchor: HTMLElement, what: Movable) {
  const s = strings();
  const here = currentPlace(what);
  const entries: MenuEntry[] = [[s.noFolder, () => void moveTo(what, null), { current: here === null }]];
  const add = (parentId: string | null, indent: number) =>
    childFolders(parentId).forEach((f) => {
      // A folder's own branch isn't offered at all; a folder too deep for this one is left out.
      if ("folder" in what && f.id === what.folder.id) return;
      if (canMoveTo(what, f.id)) entries.push([f.name || s.newFolder, () => void moveTo(what, f.id), { indent, current: here === f.id }]);
      add(f.id, indent + 1);
    });
  add(null, 1);
  // The anchor may have been re-rendered away by the time this opens.
  showMenu(anchor.isConnected ? anchor : noteListEl, entries);
}
// Dragging: what's being dragged (an own data type, so dropping it into the note's text does nothing).
const MOVE_TYPE = "application/x-gm-notes-move";
let dragging: Movable | null = null;
function makeDraggable(el: HTMLElement, what: () => Movable | null) {
  el.draggable = true;
  el.addEventListener("dragstart", (ev) => {
    const w = what();
    if (!w || !ev.dataTransfer) return;
    dragging = w;
    ev.dataTransfer.setData(MOVE_TYPE, "");
    ev.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
    closeRowMenu();
    // Room at the list's foot to drop on for the root, even when the list is full. Not right away:
    // changing the layout during dragstart itself can cancel the drag.
    setTimeout(() => { if (dragging) noteListEl.classList.add("drag-active"); });
  });
  el.addEventListener("dragend", () => {
    dragging = null;
    el.classList.remove("dragging");
    noteListEl.classList.remove("drag-active");
    clearDropTarget();
  });
}
// Where a drop at this point would put what's dragged: a folder row → into it; a note → its folder;
// anywhere else in the list → the root. Undefined: not a drop spot (outside the list).
function dropTargetAt(target: EventTarget | null): string | null | undefined {
  const el = target instanceof Element ? target : null;
  if (!el || !noteListEl.contains(el)) return undefined;
  const folderRowEl = el.closest(".folder-item") as HTMLElement | null;
  if (folderRowEl) return folderRowEl.dataset.folderId || null;
  const noteEl = el.closest(".note-item") as HTMLElement | null;
  if (noteEl) {
    const n = notes.find((x) => x.id === noteEl.dataset.id);
    return n ? noteFolderId(n) : null;
  }
  // Inside a folder's contents but not on a row: that folder.
  const group = el.closest(".folder-children") as HTMLElement | null;
  const owner = group?.previousElementSibling as HTMLElement | null;
  return owner?.dataset.folderId || null;
}
// A band where what's dragged will show up once dropped. The list orders itself (folders by name,
// notes in the list's order), so that's worked out from the order, not from the pointer.
const dropLine = document.createElement("div");
dropLine.className = "drop-line";
dropLine.setAttribute("aria-hidden", "true");
// What the band shows now: dragover repeats every ~50 ms while the pointer rests, for the same spot.
let dropShown: { what: Movable; target: string | null } | null = null;
function clearDropTarget() {
  dropShown = null;
  noteListEl.classList.remove("drop-root");
  noteListEl.querySelectorAll(".drop-into").forEach((el) => el.classList.remove("drop-into"));
  dropLine.remove();
}
function showDropTarget(target: string | null) {
  if (dropShown && dropShown.what === dragging && dropShown.target === target && dropLine.isConnected) return;
  clearDropTarget();
  const row = target === null ? null : (noteListEl.querySelector(`.folder-item[data-folder-id="${CSS.escape(target)}"]`) as HTMLElement | null);
  if (target === null) noteListEl.classList.add("drop-root");
  else row?.classList.add("drop-into");
  if (!dragging || (target !== null && !row)) return;
  // The level's elements: the root list, or the folder's contents (absent while folded or empty).
  const group = target === null ? noteListEl : row!.nextElementSibling?.classList.contains("folder-children") ? (row!.nextElementSibling as HTMLElement) : null;
  let before: Element | null = null; // the element it will sit just before (null: at the level's end)
  if (group) {
    const what = dragging;
    const folderEl = (f: Folder) => group.querySelector(`:scope > .folder-item[data-folder-id="${CSS.escape(f.id)}"]`);
    const noteEl = (n: Note) => group.querySelector(`:scope > .note-item[data-id="${CSS.escape(n.id)}"]`);
    const levelFolders = childFolders(target);
    const firstNote = (group.querySelector(":scope > .note-item") as Element | null);
    if ("folder" in what) {
      const others = levelFolders.filter((f) => f.id !== what.folder.id);
      const order = [...others, what.folder].sort((a, b) => a.name.toLocaleLowerCase(language).localeCompare(b.name.toLocaleLowerCase(language), language));
      const next = order[order.indexOf(what.folder) + 1];
      before = next ? folderEl(next) : firstNote;
    } else {
      const others = notes.filter((n) => n.id !== what.note.id && noteFolderId(n) === target);
      const order = sortNotes([...others, what.note], false);
      const next = order[order.indexOf(what.note) + 1];
      before = next ? noteEl(next) : null;
    }
  }
  const list = noteListEl.getBoundingClientRect();
  const top0 = list.top - noteListEl.scrollTop;
  let y: number;
  let left: number;
  if (!group) {
    // Into a folded or empty folder: right under its row, a step in.
    const r = row!.getBoundingClientRect();
    y = r.bottom + 1;
    left = r.left + 16;
  } else {
    const anchor = before ?? (Array.from(group.children).filter((c) => c !== dropLine).pop() as Element | undefined);
    const g = group.getBoundingClientRect();
    left = g.left + 5;
    if (!anchor) y = g.top + (group === noteListEl ? 5 : 0);
    else {
      const r = anchor.getBoundingClientRect();
      y = before ? r.top - 1 : r.bottom + 1;
    }
  }
  dropLine.style.top = `${y - top0 - 1}px`;
  dropLine.style.left = `${left - list.left}px`;
  dropLine.style.width = `${Math.max(20, list.right - 5 - left)}px`;
  noteListEl.appendChild(dropLine);
  dropShown = { what: dragging, target };
}
noteListEl.addEventListener("dragover", (ev) => {
  if (!dragging) return;
  const target = dropTargetAt(ev.target);
  if (target === undefined || !canMoveTo(dragging, target) || currentPlace(dragging) === target) {
    clearDropTarget();
    return;
  }
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  showDropTarget(target);
});
// Only when the pointer really leaves the list: Chrome often gives dragleave no relatedTarget, even
// between two rows, which made the band flicker.
noteListEl.addEventListener("dragleave", (ev) => {
  const r = noteListEl.getBoundingClientRect();
  if (ev.clientX <= r.left || ev.clientX >= r.right || ev.clientY <= r.top || ev.clientY >= r.bottom) clearDropTarget();
});
noteListEl.addEventListener("drop", (ev) => {
  if (!dragging) return;
  ev.preventDefault();
  const what = dragging;
  const target = dropTargetAt(ev.target);
  dragging = null;
  noteListEl.classList.remove("drag-active");
  clearDropTarget();
  if (target !== undefined) void moveTo(what, target);
});

function startFolderRename(row: HTMLElement, folder: Folder) {
  row.draggable = false;
  const name = row.querySelector(".title") as HTMLElement;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = folder.name;
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  function commit() {
    if (done) return;
    done = true;
    const v = input.value.trim();
    // As it is now (the cloud may have replaced it while the name was being typed).
    const current = folderById(folder.id);
    if (v && current && v !== current.name) {
      current.name = v;
      current.updatedAt = Date.now();
      void pushFolder(current);
      void persist();
    }
    renderList();
  }
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    if (ev.key === "Escape") { done = true; renderList(); }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (ev) => ev.stopPropagation());
}

function startRename(itemEl: HTMLElement, note: Note) {
  // A draggable row would drag instead of selecting text in the input.
  itemEl.draggable = false;
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
    refreshLinkersOf(note.id);
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

// Deleting a note moves it to the trash (see the trash section below).
async function deleteNote(id: string) {
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  const [removed] = notes.splice(idx, 1);
  moveToTrash(removed);
  if (activeId === id) {
    activeId = notes.length ? notes[0].id : null;
  }
  await persist();
  renderList();
  renderEditor();
}

// Brings a note's hidden parts to the current rules (see secret.ts), once. Returns whether it did.
function migrateSecretModel(note: Note): boolean {
  if (note.secretModel === SECRET_MODEL) return false;
  note.html = expandSecretMarks(note.html);
  note.secretModel = SECRET_MODEL;
  return true;
}

// ---------- links between notes (see noteLinks.ts) ----------
function linkTarget(id: string): LinkTarget | null {
  const n = notes.find((x) => x.id === id);
  if (n) return { title: n.title, gone: false };
  const t = trash.find((x) => x.id === id);
  return t ? { title: t.title, gone: true } : null;
}
// The public notes linking to `id` go up again: what players get of their links depends on it (its
// title, whether it's public, whether it's there at all).
function refreshLinkersOf(id: string) {
  const ids = notes.filter((n) => n.public && n.id !== id && n.html.includes(`${LINK_ATTR}="${id}"`)).map((n) => n.id);
  if (ids.length) refreshSharedCopies(ids);
}
function openLinkedNote(id: string) {
  if (isPlayerView()) {
    if (!sharedNotes.some((n) => n.id === id)) return;
    playerActiveId = id;
  } else {
    if (!notes.some((n) => n.id === id)) return;
    activeId = id;
  }
  renderList();
  renderEditor();
}
// The bubble a link shows when clicked: open it, or why it can't be.
const linkBubble = document.createElement("div");
linkBubble.className = "link-bubble";
linkBubble.hidden = true;
panel.appendChild(linkBubble);
function showLinkBubble(link: HTMLElement) {
  const s = strings();
  const id = link.getAttribute(LINK_ATTR) || "";
  const player = isPlayerView();
  const target = player ? (sharedNotes.find((n) => n.id === id) ? { title: "", gone: false } : null) : linkTarget(id);
  linkBubble.innerHTML = "";
  if (target && !target.gone) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = s.linkOpen(link.textContent || s.untitled);
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.addEventListener("click", () => {
      hideLinkBubble();
      openLinkedNote(id);
    });
    linkBubble.appendChild(btn);
  } else {
    const msg = document.createElement("span");
    msg.textContent = target && target.gone ? s.linkTrashed : s.linkMissing;
    linkBubble.appendChild(msg);
  }
  linkBubble.hidden = false;
  const p = panel.getBoundingClientRect();
  const r = link.getBoundingClientRect();
  const w = linkBubble.getBoundingClientRect().width;
  linkBubble.style.left = `${Math.max(4, Math.min(r.left - p.left, p.width - w - 4))}px`;
  linkBubble.style.top = `${r.bottom - p.top + 4}px`;
}
function hideLinkBubble() {
  linkBubble.hidden = true;
}
document.addEventListener("mousedown", (ev) => {
  if (!linkBubble.hidden && !linkBubble.contains(ev.target as Node)) hideLinkBubble();
}, true);
// A click on a link (in the editor or the read-only view): Ctrl/Cmd+click opens it, a plain click
// shows the bubble.
function onLinkClick(ev: MouseEvent): boolean {
  const link = (ev.target as HTMLElement).closest ? ((ev.target as HTMLElement).closest(".note-link") as HTMLElement | null) : null;
  if (!link) return false;
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    hideLinkBubble();
    openLinkedNote(link.getAttribute(LINK_ATTR) || "");
  } else {
    showLinkBubble(link);
  }
  return true;
}

// ---------- the notes list's row menu, pins, duplicates and order ----------
// A row's "more" menu: duplicate, save as template, export. It floats over the panel (the switcher
// clips what overflows it).
const rowMenu = document.createElement("div");
rowMenu.className = "row-menu";
rowMenu.setAttribute("role", "menu");
rowMenu.hidden = true;
panel.appendChild(rowMenu);
function closeRowMenu() {
  rowMenu.hidden = true;
}
function openRowMenu(anchor: HTMLElement, n: Note) {
  const s = strings();
  const entries: MenuEntry[] = [
    [s.duplicateNote, () => void duplicateNote(n)],
    [s.saveAsTemplateTitle, () => void saveAsTemplate(n)],
    [s.exportTitle, () => openExportFormatModal(n)],
  ];
  if (folders.length) entries.unshift([s.moveTo, () => openMoveMenu(anchor, { note: n })]);
  if (n.editable && n.playerBase) entries.push([s.undoPlayerEdits, () => void undoPlayerEdits(n.id)]);
  showMenu(anchor, entries);
}
// The list's small menu (a note's or a folder's actions), under its button.
// An entry can be indented (the folder tree in "Move to…") or the current choice (shown, not picked).
type MenuEntry = [string, () => void, { indent?: number; current?: boolean }?];
function showMenu(anchor: HTMLElement, entries: MenuEntry[]) {
  rowMenu.innerHTML = "";
  entries.forEach(([label, run, opts]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    if (opts?.indent) b.style.paddingLeft = `${9 + opts.indent * 14}px`;
    if (opts?.current) {
      b.disabled = true;
      b.classList.add("current");
      b.setAttribute("aria-current", "true");
    }
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeRowMenu();
      run();
    });
    rowMenu.appendChild(b);
  });
  rowMenu.hidden = false;
  const p = panel.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const w = rowMenu.getBoundingClientRect().width;
  const h = rowMenu.getBoundingClientRect().height;
  rowMenu.style.left = `${Math.max(4, Math.min(a.right - p.left - w, p.width - w - 4))}px`;
  const below = a.bottom - p.top + 2;
  rowMenu.style.top = `${below + h > p.height - 4 ? a.top - p.top - h - 2 : below}px`;
}
document.addEventListener("pointerdown", (ev) => {
  if (!rowMenu.hidden && !rowMenu.contains(ev.target as Node)) closeRowMenu();
}, true);
async function togglePin(id: string) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  if (n.pinned) delete n.pinned;
  else n.pinned = true;
  n.updatedAt = Date.now();
  markNoteDirty(id);
  renderList();
  await persist();
}
// A copy of a note, opened: private, with no map items linked to it.
async function duplicateNote(n: Note) {
  const s = strings();
  const copy: Note = {
    id: "n" + Date.now(),
    title: (n.title || s.untitled) + s.copySuffix,
    html: n.html,
    updatedAt: Date.now(),
    secretModel: n.secretModel ?? SECRET_MODEL,
    ...(noteFolderId(n) ? { folderId: n.folderId } : {}),
  };
  notes.unshift(copy);
  activeId = copy.id;
  markNoteDirty(copy.id);
  closeDropdown();
  renderList();
  renderEditor();
  await persist();
}
// The list's footer: the trash link and the order.
const listFooter = document.createElement("div");
listFooter.className = "list-footer";
const sortBtn = document.createElement("button");
sortBtn.type = "button";
sortBtn.className = "sort-btn";
const trashLinkEl = document.getElementById("trashLink") as HTMLElement;
trashLinkEl.replaceWith(listFooter);
const newFolderBtn = document.createElement("button");
newFolderBtn.type = "button";
newFolderBtn.className = "sort-btn new-folder-btn";
newFolderBtn.addEventListener("click", () => void createFolder(null));
listFooter.append(trashLinkEl, newFolderBtn, sortBtn);
sortBtn.addEventListener("click", () => {
  noteSort = noteSort === "recent" ? "alpha" : "recent";
  void setNoteSort(noteSort);
  renderList();
});
function updateSortButton() {
  const s = strings();
  sortBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4.5 2.5v11M2 11l2.5 2.5L7 11M9.5 4h4.5M9.5 8h3.5M9.5 12h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  sortBtn.append(document.createTextNode(noteSort === "alpha" ? s.sortAlpha : s.sortRecent));
  sortBtn.title = s.sortTitle;
  newFolderBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h3.3l1.5 1.6h5.4c.6 0 1.1.5 1.1 1.1v6.5c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 7.3v3.6M6.2 9.1h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  newFolderBtn.append(document.createTextNode(s.newFolder));
  newFolderBtn.title = s.newFolderTitle;
  listFooter.hidden = isPlayerView() || trashView;
}

// ---------- linked items: map items linked to a note (see itemLinks.ts, background.ts) ----------
// A note's connections: the map items linked to it (in the current scene) and the notes linking to
// it. A small button at the end of its title row counts them; it opens a panel listing both: an
// item's name selects it on the map, × unlinks it; a note's name opens it. The items are read when
// the note opens and after linking or unlinking only, never following the scene: tokens dragged
// around in combat cost nothing here.
let linkedItemsRefresh: (() => void) | null = null;
const connectionsPop = document.createElement("div");
connectionsPop.className = "connections-pop";
connectionsPop.hidden = true;
panel.appendChild(connectionsPop);
let connections: { noteId: string; items: { id: string; name?: string }[]; backlinks: Note[]; btn: HTMLElement | null } = { noteId: "", items: [], backlinks: [], btn: null };
async function refreshLinkedItems(noteId: string, btn: HTMLElement) {
  if (!btn) return;
  if (role !== "GM") {
    btn.hidden = true;
    return;
  }
  const backlinks = notes.filter((n) => n.id !== noteId && n.html.includes(`${LINK_ATTR}="${noteId}"`));
  let items: { id: string; name?: string }[] = [];
  if (itemLinksEnabled) {
    try {
      if (await OBR.scene.isReady()) items = await OBR.scene.items.getItems((i) => i.metadata[ITEM_LINK_KEY] === noteId);
    } catch (err) {
      console.error("Notes: couldn't read the linked items", err);
    }
  }
  if (!btn.isConnected) return;
  connections = { noteId, items, backlinks, btn };
  const count = items.length + backlinks.length;
  btn.hidden = !count;
  (btn.querySelector(".connections-count") as HTMLElement).textContent = String(count);
  btn.title = strings().connectionsTitle;
  if (!connectionsPop.hidden) renderConnections();
}
function renderConnections() {
  const s = strings();
  const { items, backlinks, btn } = connections;
  connectionsPop.innerHTML = "";
  const section = (heading: string) => {
    const h = document.createElement("div");
    h.className = "connections-head";
    h.textContent = heading;
    connectionsPop.appendChild(h);
  };
  if (items.length) {
    section(s.settingsItemLinksLabel);
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "connections-row";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "connections-name";
      name.textContent = itemLabel(item as never, s.unnamedItem);
      name.title = s.linkedItemSelect;
      name.addEventListener("click", () => void OBR.player.select([item.id], true));
      const x = document.createElement("button");
      x.type = "button";
      x.className = "connections-x";
      x.textContent = "×";
      x.title = s.linkedItemUnlink;
      x.setAttribute("aria-label", s.linkedItemUnlink + ": " + name.textContent);
      x.addEventListener("click", async () => {
        await unlinkItems([item.id]);
        if (btn) void refreshLinkedItems(connections.noteId, btn);
      });
      row.append(name, x);
      connectionsPop.appendChild(row);
    });
  }
  if (backlinks.length) {
    section(s.linkedFrom);
    backlinks.forEach((n) => {
      const row = document.createElement("div");
      row.className = "connections-row";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "connections-name";
      name.textContent = n.title || s.untitled;
      name.addEventListener("click", () => {
        closeConnections();
        openLinkedNote(n.id);
      });
      row.appendChild(name);
      connectionsPop.appendChild(row);
    });
  }
  if (!items.length && !backlinks.length) {
    closeConnections();
    return;
  }
  if (btn) {
    const p = panel.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const w = connectionsPop.getBoundingClientRect().width;
    connectionsPop.style.left = `${Math.max(4, Math.min(b.right - p.left - w, p.width - w - 4))}px`;
    connectionsPop.style.top = `${b.bottom - p.top + 4}px`;
  }
}
function toggleConnections() {
  if (!connectionsPop.hidden) {
    closeConnections();
    return;
  }
  connectionsPop.hidden = false;
  renderConnections();
}
function closeConnections() {
  connectionsPop.hidden = true;
}
document.addEventListener("pointerdown", (ev) => {
  const t = ev.target as Node;
  if (!connectionsPop.hidden && !connectionsPop.contains(t) && !(connections.btn && connections.btn.contains(t))) closeConnections();
}, true);
// Notes deleted for good (see getErased in notes.ts): remembered, and their map items unlinked in
// the open scene now, in any other scene when it's opened (with the panel loaded).
let erased = new Set<string>();
function noteErased(ids: string[]) {
  ids.forEach((id) => erased.add(id));
  void setErased(Array.from(erased)).catch((err) => console.error("Notes: failed to save the deleted notes' ids", err));
  void unlinkErasedInScene();
}
async function unlinkErasedInScene() {
  if (role !== "GM" || !erased.size) return;
  try {
    if (!(await OBR.scene.isReady())) return;
    await OBR.scene.items.updateItems(
      (item) => typeof item.metadata[ITEM_LINK_KEY] === "string" && erased.has(item.metadata[ITEM_LINK_KEY] as string),
      (drafts) => drafts.forEach((d) => { delete d.metadata[ITEM_LINK_KEY]; })
    );
  } catch (err) {
    console.error("Notes: couldn't unlink items from deleted notes", err);
  }
}
async function unlinkItems(ids: string[]) {
  try {
    await OBR.scene.items.updateItems(ids, (drafts) => drafts.forEach((d) => { delete d.metadata[ITEM_LINK_KEY]; }));
  } catch (err) {
    console.error("Notes: couldn't unlink the items", err);
  }
}
async function linkItemsTo(noteId: string) {
  const pick = itemPick;
  endItemPick();
  if (!pick) return;
  try {
    await OBR.scene.items.updateItems(pick.itemIds, (drafts) => drafts.forEach((d) => { d.metadata[ITEM_LINK_KEY] = noteId; }));
  } catch (err) {
    console.error("Notes: couldn't link the items", err);
  }
  activeId = noteId;
  closeDropdown();
  renderList();
  renderEditor();
}
function updatePickBanner() {
  const banner = document.getElementById("pickBanner") as HTMLElement;
  banner.hidden = !itemPick;
  if (itemPick) document.getElementById("pickBannerText")!.textContent = strings().itemPickBanner(itemPick.names[0] || strings().unnamedItem, itemPick.itemIds.length - 1);
}
function endItemPick() {
  itemPick = null;
  updatePickBanner();
}
document.getElementById("pickCancelBtn")!.addEventListener("click", () => closeDropdown());
// Each request is handled once, whichever way it arrives first (message or localStorage).
let lastItemRequestAt = 0;
function receiveItemLinkRequest(request: ItemLinkRequest) {
  if (request.at <= lastItemRequestAt) return;
  lastItemRequestAt = request.at;
  void OBR.broadcast.sendMessage(ITEM_LINK_CHANNEL, { type: "taken", at: request.at } satisfies ItemLinkMessage, { destination: "LOCAL" });
  void handleItemLinkRequest(request);
}
function checkItemLinkRequest() {
  const request = takeItemLinkRequest();
  if (request) receiveItemLinkRequest(request);
  void OBR.broadcast.sendMessage(ITEM_LINK_CHANNEL, { type: "hello" } satisfies ItemLinkMessage, { destination: "LOCAL" });
}
async function handleItemLinkRequest(r: ItemLinkRequest) {
  if (role !== "GM" || !itemLinksEnabled) return;
  const s = strings();
  if (r.action === "open") {
    const id = r.noteId || "";
    if (notes.some((n) => n.id === id)) {
      activeId = id;
      trashView = false;
      closeDropdown();
      renderList();
      renderEditor();
      return;
    }
    const trashed = trash.find((t) => t.id === id);
    if (trashed) {
      if (window.confirm(s.itemNoteTrashed(trashed.title || s.untitled))) await restoreFromTrash(id);
      return;
    }
    if (window.confirm(s.itemNoteMissing(r.names[0] || s.unnamedItem))) await unlinkItems(r.itemIds);
    return;
  }
  itemPick = { itemIds: r.itemIds, names: r.names };
  trashView = false;
  searchInput.value = "";
  searchTerm = "";
  openDropdown();
  updatePickBanner();
  renderList();
}

// ---------- trash: deleted notes, restorable for 30 days ----------
// A deleted note keeps its content, with the time it was deleted (deletedAt), apart from the notes.
// With cloud sync it goes up like an edit, so other devices move it to the trash too; only emptying
// the trash (by hand, or after 30 days) deletes it from the cloud.
const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
function moveToTrash(note: Note) {
  const now = Date.now();
  // Out of the players' sight first; restoring it doesn't share it again.
  if (note.public) void unpublishNote(note.id);
  delete note.public;
  delete note.editable;
  delete note.playerBase;
  note.deletedAt = now;
  note.updatedAt = now;
  trash = trash.filter((t) => t.id !== note.id);
  trash.push(note);
  markNoteDirty(note.id);
  refreshLinkersOf(note.id);
}
function daysLeft(note: Note): number {
  return Math.max(1, Math.ceil(((note.deletedAt || 0) + TRASH_DAYS * DAY_MS - Date.now()) / DAY_MS));
}
function eraseFromTrash(ids: string[]) {
  if (!ids.length) return;
  trash = trash.filter((t) => !ids.includes(t.id));
  ids.forEach((id) => void deleteNoteFromCloud(id));
  noteErased(ids);
}
// Returns whether it erased anything.
function purgeExpiredTrash(): boolean {
  const cutoff = Date.now() - TRASH_DAYS * DAY_MS;
  const expired = trash.filter((t) => (t.deletedAt || 0) < cutoff).map((t) => t.id);
  eraseFromTrash(expired);
  return expired.length > 0;
}
async function restoreFromTrash(id: string) {
  const note = trash.find((t) => t.id === id);
  if (!note) return;
  trash = trash.filter((t) => t.id !== id);
  delete note.deletedAt;
  note.updatedAt = Date.now();
  // Back in its folder if that's still there; at the root otherwise.
  if (!folderById(note.folderId)) {
    // A move to the root, newer than any other device's idea of where it is.
    if (note.folderId) note.folderAt = Date.now();
    delete note.folderId;
  } else unfoldFolder(note.folderId!);
  notes.unshift(note);
  markNoteDirty(id);
  refreshLinkersOf(id);
  activeId = id;
  trashView = false;
  renderList();
  renderEditor();
  closeDropdown();
  await persist();
}
async function deleteForGood(id: string) {
  const note = trash.find((t) => t.id === id);
  if (!note || !window.confirm(strings().trashDeleteConfirm(note.title || strings().untitled))) return;
  eraseFromTrash([id]);
  if (!trash.length) trashView = false;
  renderList();
  await persist();
}
async function emptyTrash() {
  if (!trash.length || !window.confirm(strings().trashEmptyConfirm(trash.length))) return;
  eraseFromTrash(trash.map((t) => t.id));
  trashView = false;
  renderList();
  await persist();
}
const trashHead = document.getElementById("trashHead") as HTMLElement;
const trashLink = document.getElementById("trashLink") as HTMLElement;
document.getElementById("trashLinkIcon")!.innerHTML = TRASH_ICON_PATH;
function setTrashView(on: boolean) {
  trashView = on;
  searchInput.value = "";
  searchTerm = "";
  renderList();
  searchInput.focus();
}
trashLink.addEventListener("click", () => setTrashView(true));
document.getElementById("trashBackBtn")!.addEventListener("click", () => setTrashView(false));
document.getElementById("trashEmptyBtn")!.addEventListener("click", () => void emptyTrash());
// The trash's own header (instead of the "Trash (n)" link at the bottom) while it's open.
function updateTrashChrome() {
  const gm = !isPlayerView();
  if (!gm || !trash.length) trashView = false;
  trashHead.hidden = !trashView;
  trashLink.hidden = trashView || !gm || !trash.length;
  document.getElementById("trashLinkText")!.textContent = strings().trashLink(trash.length);
}
function renderTrash() {
  const s = strings();
  const q = searchTerm.toLowerCase();
  const list = trash
    .filter((n) => !q || n.title.toLowerCase().includes(q) || stripHtml(n.html).toLowerCase().includes(q))
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  if (!list.length) {
    noteListEl.innerHTML = `<div class="empty-list">${escapeHtml(trash.length ? s.emptySearch : s.trashEmptyList)}</div>`;
    return;
  }
  noteListEl.innerHTML = "";
  list.forEach((n) => {
    const item = document.createElement("div");
    item.className = "note-item with-actions trash-item";
    item.dataset.id = n.id;
    const body = document.createElement("div");
    body.className = "note-item-body";
    const row = document.createElement("div");
    row.className = "note-item-row";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = n.title || s.untitled;
    row.appendChild(title);
    const snippet = document.createElement("div");
    snippet.className = "snippet";
    snippet.textContent = stripHtml(n.html) || s.emptyNote;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = s.trashDeletedAgo + relativeTime(n.deletedAt || n.updatedAt) + s.trashExpiresIn(daysLeft(n));
    body.append(row, snippet, meta);
    const restore = document.createElement("button");
    restore.className = "row-btn restore-btn";
    restore.title = s.trashRestoreTitle;
    restore.setAttribute("aria-label", s.trashRestoreTitle + ": " + (n.title || s.untitled));
    restore.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3.5 6.5h6.25a3.25 3.25 0 0 1 0 6.5H6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M6 4 3.5 6.5 6 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    restore.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void restoreFromTrash(n.id);
    });
    const del = document.createElement("button");
    del.className = "row-btn del-btn";
    del.title = s.trashDeleteTitle;
    del.setAttribute("aria-label", s.trashDeleteTitle + ": " + (n.title || s.untitled));
    del.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">${TRASH_ICON_PATH}</svg>`;
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void deleteForGood(n.id);
    });
    const actions = document.createElement("div");
    actions.className = "row-actions trash-actions";
    actions.append(restore, del);
    item.append(body, actions);
    noteListEl.appendChild(item);
  });
}

// ---------- public notes: shared with the room's players (see cloudSync.ts, publicKey.ts) ----------
function publicNotes(): Note[] {
  return notes.filter((n) => n.public);
}
// Public copies are tied to their author's account by the Security Rules: only a signed-in GM writes
// them.
function canPublish(): boolean {
  return role === "GM" && cloudSyncAvailable() && !!getCurrentUser();
}
// Catches the public copies up with what's here: anything changed, unpublished or deleted while
// signed out (or before this device had pulled the account's notes) gets fixed now.
function reconcilePublicNotes() {
  if (canPublish() && publicKey) void reconcileSharedNotes(publicKey, publicNotes);
}
function applyPublicKey(key: string | null) {
  if (key === publicKey) return;
  const old = publicKey;
  publicKey = key;
  setSharedKey(key);
  if (isPlayerView()) {
    startSharedWatch();
    renderList();
    renderEditor();
    return;
  }
  // The key was replaced (here or by another GM): this account's copies move to the new one.
  if (old && canPublish()) void reconcileSharedNotes(old, () => []);
  reconcilePublicNotes();
  followOwnShared();
}
// A note's sharing: private (the GM's alone), visible (players read it) or editable (players edit it,
// one at a time, see editLock.ts; such a note has no hidden parts).
type ShareMode = "private" | "visible" | "editable";
function shareMode(n: Note | undefined): ShareMode {
  return !n || !n.public ? "private" : n.editable ? "editable" : "visible";
}
function applyShareMode(n: Note, mode: ShareMode) {
  if (mode === "private") delete n.public;
  else n.public = true;
  if (mode === "editable") n.editable = true;
  else {
    delete n.editable;
    delete n.playerBase;
  }
}
function unmarkHidden(html: string): string {
  if (!html.includes(SECRET_ATTR)) return html;
  const box = document.createElement("div");
  box.innerHTML = html;
  box.querySelectorAll("[" + SECRET_ATTR + "]").forEach((el) => el.removeAttribute(SECRET_ATTR));
  return box.innerHTML;
}
// By id: a cloud update can replace the note's object while this waits, so it's looked up again
// after every await.
async function setNoteMode(id: string, mode: ShareMode) {
  const find = () => notes.find((n) => n.id === id);
  const note = find();
  if (!note) return;
  const before = shareMode(note);
  if (mode === before) return;
  // The open editor lets its lock go first (its last edit goes up while the note is still editable).
  if (editorSession && editorSession.noteId === id) endEditorSession();
  const updatedAt = Date.now();
  // Before anything awaits: a reconcile running meanwhile counts the note as shared instead of
  // taking its fresh copy down, and the newer time keeps an older cloud version from replacing it.
  applyShareMode(note, mode);
  note.updatedAt = updatedAt;
  if (mode !== "private") {
    try {
      if (!publicKey) applyPublicKey(await ensurePublicKey());
      const current = find();
      if (!current) return;
      applyShareMode(current, mode);
      await publishNote({ ...current, updatedAt });
    } catch (err) {
      console.error("Notes: failed to publish note", err);
      const current = find();
      if (current) applyShareMode(current, before);
      renderList();
      updateBrandPill();
      renderEditor();
      window.alert(strings().publishError);
      return;
    }
  } else {
    // Signed out, this does nothing yet: the copy comes down on the next sign-in (reconcilePublicNotes).
    void unpublishNote(id);
  }
  const current = find();
  if (!current) return;
  applyShareMode(current, mode);
  // Editable: its hidden parts are shown (the confirmation said so), here as for the players.
  if (mode === "editable") current.html = unmarkHidden(current.html);
  current.updatedAt = Math.max(current.updatedAt, updatedAt);
  markNoteDirty(id);
  refreshLinkersOf(id);
  await persist();
  renderList();
  if (id === activeId) renderEditor();
  else updateBrandPill();
}
// "Undo the players' changes": the GM's version from before them (see mergeOwnShared), unless a
// player is editing the note right now.
async function undoPlayerEdits(id: string) {
  const n = notes.find((x) => x.id === id);
  if (!n || !n.playerBase) return;
  const holder = lockHolder(id, editorUid());
  if (holder) {
    window.alert(strings().undoPlayerEditsBusy(holder.name || strings().someone));
    return;
  }
  if (editorSession && editorSession.noteId === id) endEditorSession();
  n.title = n.playerBase.title;
  n.html = n.playerBase.html;
  n.updatedAt = Date.now();
  delete n.playerBase;
  markNoteDirty(id);
  void flushCloudSync();
  refreshLinkersOf(id);
  await persist();
  renderList();
  if (id === activeId) renderEditor();
}

// The GM's own shared copies, followed while signed in with a key: for editable notes, the players'
// edits come back into the GM's notes from there, and their locks show in the GM's editor.
let stopOwnShared: (() => void) | null = null;
function followOwnShared() {
  stopOwnShared?.();
  stopOwnShared = null;
  if (canPublish() && publicKey) stopOwnShared = watchOwnSharedNotes(publicKey, mergeOwnShared);
}
function mergeOwnShared(copies: SharedCopy[]) {
  const me = getCurrentUser()?.uid ?? null;
  let changed = false;
  let activeChanged = false;
  copies.forEach((c) => {
    noteLockSeen(c.note.id, c.lock);
    const local = notes.find((n) => n.id === c.note.id);
    if (!local || !local.editable || !c.note.editable) return;
    // Only a player's edit (the GM's own come from this account, here or on another device, which
    // gets them through the account's own copy).
    if (c.note.updatedAt <= local.updatedAt || !c.editedBy || c.editedBy === me) return;
    // Taken from the first of a run of player edits: what "undo the players' changes" goes back to.
    if (!local.playerBase) local.playerBase = { title: local.title, html: local.html, updatedAt: local.updatedAt };
    local.title = c.note.title;
    local.html = c.note.html;
    local.updatedAt = c.note.updatedAt;
    markNoteDirty(local.id);
    changed = true;
    if (local.id === activeId) activeChanged = true;
  });
  if (changed) {
    void persist();
    renderList();
    if (activeChanged && !(editorSession && editorSession.busy())) renderEditor();
  }
  editorSession?.refreshLock();
}

// The "GM Notes" pill shows the active note's sharing ("Visible" in green, "Public" in amber) and,
// for the GM, opens the menu to change it.
const brandPill = document.getElementById("brandPill") as HTMLButtonElement;
function sharingAvailable(): boolean {
  return role === "GM" && cloudSyncAvailable() && !!getActive();
}
function updateBrandPill() {
  const s = strings();
  const mode = isPlayerView() ? (getActive()?.editable ? "editable" : "visible") : shareMode(getActive());
  const sharing = sharingAvailable();
  brandPill.textContent = mode === "editable" ? s.brandEditable : mode === "visible" ? s.brandVisible : "GM Notes";
  brandPill.classList.toggle("public", mode === "visible");
  brandPill.classList.toggle("editable", mode === "editable");
  brandPill.classList.toggle("clickable", sharing);
  brandPill.tabIndex = sharing ? 0 : -1;
  brandPill.title = !sharing ? "" : canPublish() || mode !== "private" ? s.shareMenuTitle : s.publishSignedOutTitle;
  if (sharing) {
    brandPill.setAttribute("aria-haspopup", "menu");
    brandPill.setAttribute("aria-expanded", String(!shareMenu.hidden));
  } else {
    brandPill.removeAttribute("aria-haspopup");
    brandPill.removeAttribute("aria-expanded");
  }
}
const shareMenu = document.createElement("div");
shareMenu.className = "share-menu";
shareMenu.setAttribute("role", "menu");
shareMenu.hidden = true;
panel.appendChild(shareMenu);
function closeShareMenu() {
  if (shareMenu.hidden) return;
  shareMenu.hidden = true;
  brandPill.setAttribute("aria-expanded", "false");
}
function openShareMenu(note: Note) {
  const s = strings();
  const current = shareMode(note);
  const options: [ShareMode, string, string][] = [
    ["private", s.shareModePrivate, s.shareModePrivateHint],
    ["visible", s.shareModeVisible, s.shareModeVisibleHint],
    ["editable", s.shareModeEditable, s.shareModeEditableHint],
  ];
  shareMenu.innerHTML = "";
  options.forEach(([mode, label, hint]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", String(mode === current));
    b.className = "share-option share-" + mode + (mode === current ? " current" : "");
    b.innerHTML = `<span class="share-dot"></span><span class="share-text"><span class="share-label"></span><span class="share-hint"></span></span>`;
    b.querySelector(".share-label")!.textContent = label;
    b.querySelector(".share-hint")!.textContent = hint;
    b.addEventListener("click", () => {
      closeShareMenu();
      chooseShareMode(note.id, mode);
    });
    shareMenu.appendChild(b);
  });
  shareMenu.hidden = false;
  const p = panel.getBoundingClientRect();
  const a = brandPill.getBoundingClientRect();
  shareMenu.style.left = `${Math.max(4, a.left - p.left)}px`;
  shareMenu.style.top = `${a.bottom - p.top + 4}px`;
  brandPill.setAttribute("aria-expanded", "true");
  (shareMenu.querySelector(".current") as HTMLElement | null)?.focus();
}
document.addEventListener("pointerdown", (ev) => {
  if (!shareMenu.hidden && !shareMenu.contains(ev.target as Node) && ev.target !== brandPill) closeShareMenu();
}, true);
shareMenu.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    closeShareMenu();
    brandPill.focus();
  }
});
// Sharing more asks first (it can't be taken back once a player has seen it); sharing less doesn't.
function chooseShareMode(id: string, mode: ShareMode) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  const current = shareMode(note);
  if (mode === current) return;
  if (mode !== "private" && !canPublish()) {
    openSettings();
    return;
  }
  if (mode === "private" || (mode === "visible" && current === "editable")) void setNoteMode(id, mode);
  else openPublishConfirm(note, mode);
}
brandPill.addEventListener("click", () => {
  const active = getActive();
  if (!active || !sharingAvailable()) return;
  if (!shareMenu.hidden) closeShareMenu();
  else openShareMenu(active);
});

const publishConfirmOverlay = document.getElementById("publishConfirmOverlay") as HTMLElement;
let pendingPublish: { id: string; mode: ShareMode } | null = null;
function openPublishConfirm(note: Note, mode: ShareMode) {
  const s = strings();
  pendingPublish = { id: note.id, mode };
  const parts = secretPartCount(note.html);
  document.getElementById("publishConfirmTitle")!.textContent = mode === "editable" ? s.publishEditableConfirmTitle : s.publishConfirmTitle;
  document.getElementById("publishConfirmHint")!.textContent = mode === "editable" ? s.publishEditableConfirmHint : s.publishConfirmHint;
  const secretHint = document.getElementById("publishConfirmSecret")!;
  secretHint.hidden = !parts;
  secretHint.textContent = !parts ? "" : mode === "editable" ? s.publishEditableConfirmSecret(parts) : s.publishConfirmSecret(parts);
  document.getElementById("publishConfirmBtn")!.textContent = mode === "editable" && parts ? s.publishEditableConfirmShowBtn : s.publishConfirmBtn;
  publishConfirmOverlay.hidden = false;
  (document.getElementById("publishConfirmBtn") as HTMLButtonElement).focus();
}
function closePublishConfirm() {
  pendingPublish = null;
  publishConfirmOverlay.hidden = true;
}
document.getElementById("publishConfirmBackdrop")!.addEventListener("click", closePublishConfirm);
document.getElementById("publishConfirmCloseBtn")!.addEventListener("click", closePublishConfirm);
document.getElementById("publishCancelBtn")!.addEventListener("click", closePublishConfirm);
document.getElementById("publishConfirmBtn")!.addEventListener("click", () => {
  const pending = pendingPublish;
  closePublishConfirm();
  // Deleted meanwhile (from another device, say): setNoteMode finds nothing to publish.
  if (pending) void setNoteMode(pending.id, pending.mode);
});

async function createNote(template?: Template, folderId?: string) {
  // A built-in's text is copied in the current language and stays that way in the note.
  const source = template ? resolveTemplate(template, language) : null;
  const note: Note = {
    id: "n" + Date.now(),
    title: source ? source.title : strings().newNoteDefaultTitle,
    html: source ? expandSecretMarks(source.html) : "",
    updatedAt: Date.now(),
    secretModel: SECRET_MODEL,
    ...(folderId ? { folderId } : {}),
  };
  if (folderId) unfoldFolder(folderId);
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
      del.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">${TRASH_ICON_PATH}</svg>`;
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

// ---------- export / import (the files themselves: see importExport.ts) ----------
function exportNote(note: Note, format: ExportFormat) {
  exportNoteFile(note, format, strings().untitled);
}
function exportAllNotes(format: ExportFormat) {
  return exportAll(notes, templates, format, {
    untitled: strings().untitled,
    folders: folders.map((f) => ({ id: f.id, name: f.name || strings().newFolder, parentId: folderParentId(f) })),
    noteFolder: noteFolderId,
    templatesFolder: strings().templatesFolder,
    templateTitle: (t) => resolveTemplate(t, language).title,
  });
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

async function importNotesFromFiles(files: FileList) {
  const imported: Note[] = [];
  const importedTemplates: Template[] = [];
  const notePaths = new Map<string, string[]>();
  const folderPaths: string[][] = [];
  for (const file of Array.from(files)) {
    try {
      const content = await contentFromImportFile(file, strings().untitled);
      imported.push(...content.notes);
      importedTemplates.push(...content.templates);
      content.notePaths.forEach((path, id) => notePaths.set(id, path));
      folderPaths.push(...content.folderPaths);
    } catch (err) {
      console.error("Notes: failed to read import file", file.name, err);
    }
  }
  if (!imported.length && !importedTemplates.length) {
    window.alert(strings().importNoneFound);
    return;
  }
  imported.forEach(migrateSecretModel);
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
  if (!imported.length && !folderPaths.length) {
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
  const foldersBefore = folders;
  // The zip's folders, by name: into the list's folder of the same name in the same place, or a new
  // one. Past the deepest level allowed, what's further in lands in the deepest one.
  const created: Folder[] = [];
  const folderAtPath = (path: string[]): string | null => {
    let parent: string | null = null;
    for (const name of path.slice(0, FOLDER_MAX_DEPTH)) {
      const clean = name.trim() || strings().newFolder;
      const existing: Folder | undefined = childFolders(parent).find((f) => f.name.trim().toLowerCase() === clean.toLowerCase());
      if (existing) {
        parent = existing.id;
        continue;
      }
      const folder: Folder = {
        id: newFolderId(),
        name: clean,
        ...(parent ? { parentId: parent } : {}),
        updatedAt: Date.now(),
      };
      folders = [...folders, folder];
      created.push(folder);
      parent = folder.id;
    }
    return parent;
  };
  if (foldersLoaded) {
    folderPaths.forEach(folderAtPath);
    imported.forEach((n) => {
      const path = notePaths.get(n.id);
      const at = path ? folderAtPath(path) : null;
      if (at) n.folderId = at;
    });
  }
  notes = [...imported, ...notes];
  const ok = await persist();
  if (!ok) {
    notes = before;
    folders = foldersBefore;
    return;
  }
  created.forEach((f) => void pushFolder(f));
  renderList();
  renderEditor();
  updateStorageMeter();
  window.alert(strings().importSuccess(imported.length, newTemplates.length));
}

// Every note of this room to the trash at once (restorable for 30 days, like any deleted note).
async function clearAllNotesWithConfirm() {
  if (!notes.length) return;
  if (!window.confirm(strings().clearAllConfirm(notes.length))) return;
  notes.forEach(moveToTrash);
  notes = [];
  activeId = null;
  await persist();
  renderList();
  renderEditor();
  updateStorageMeter();
}

// ---------- rich-text editor ----------
let editorSelectionListener: (() => void) | null = null;
// `player`: a player editing one of the room's editable notes (from `sharedNotes`), with what players
// get of the editor: no hidden parts, no linked items, links only to notes shared with them.
function buildNoteEditor(containerEl: HTMLElement, idPrefix: string, noteId: string | null, onSaved: () => void, player = false) {
  endEditorSession();
  const pool = () => (player ? sharedNotes : notes);
  const seed = noteId ? pool().find((n) => n.id === noteId) : undefined;
  if (!seed) {
    containerEl.innerHTML = `<div class="editor-empty">${escapeHtml(strings().editorEmpty)}</div>`;
    return;
  }
  const s = strings();
  // Edited in the players' copy too, one person at a time (see the lock below).
  const shared = player || !!(seed.public && seed.editable);
  // A note the players edit has no hidden parts (see setNoteMode).
  const noSecrets = () => shared;

  function currentNote(): Note | undefined {
    return noteId ? pool().find((n) => n.id === noteId) : undefined;
  }

  const toolbarHtml = renderToolbar(idPrefix, s.toolbar);

  containerEl.innerHTML =
    toolbarHtml +
    `<div class="title-row"><input class="note-title-input" id="${idPrefix}TitleInput" placeholder="${escapeHtml(s.titlePlaceholder)}" value="${escapeHtml(seed.title)}" />` +
    `<button type="button" class="connections-btn" id="${idPrefix}ConnectionsBtn" hidden aria-haspopup="dialog"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.6 9.4a2.8 2.8 0 0 0 4 0l2.3-2.3a2.8 2.8 0 0 0-4-4L7.8 4.2M9.4 6.6a2.8 2.8 0 0 0-4 0L3.1 8.9a2.8 2.8 0 0 0 4 4l1.1-1.1" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg><span class="connections-count">0</span></button></div>` +
    `<div class="lock-banner" id="${idPrefix}LockBanner" role="status" hidden></div>` +
    `<div class="editor-scroll"><div class="secret-layer" id="${idPrefix}SecretLayer" aria-hidden="true"></div><div class="editor-surface" id="${idPrefix}EditorSurface" contenteditable="true" data-placeholder="${escapeHtml(s.bodyPlaceholder)}"></div></div>` +
    `<div class="editor-foot"><span class="save-state"><span class="pip" id="${idPrefix}SavePip"></span><span id="${idPrefix}SavedAgo">${escapeHtml(s.savedPrefix + s.savedInstant)}</span><button type="button" class="cloud-sync-btn" id="${idPrefix}CloudSyncBtn" hidden><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M5.3 12.3h6.4a2.7 2.7 0 0 0 .35-5.37 3.75 3.75 0 0 0-7.3-1.1A2.6 2.6 0 0 0 5.3 12.3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button></span><span class="foot-end"><span id="${idPrefix}WordCount">${escapeHtml(s.wordsCount(0))}</span>` +
    `<span class="lock-state" id="${idPrefix}LockState" role="status" hidden><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M10.6 2.9l2.5 2.5-7.4 7.4-3.1.6.6-3.1 7.4-7.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="lock-state-text"></span></span>` +
    `<button type="button" class="finish-edit-btn" id="${idPrefix}FinishEditBtn" title="${escapeHtml(s.finishEditingTitle)}" hidden><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3.2 8.4l3.1 3.1 6.5-6.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>${escapeHtml(s.finishEditing)}</button></span></div>`;

  const surface = document.getElementById(idPrefix + "EditorSurface") as HTMLElement;
  const tables = createTableEditor({
    surface,
    idPrefix,
    toolbarStrings: () => strings().toolbar,
    blockAt,
    placeCaretAtStart,
    caretRangeAt,
    pushHistory,
    noteTyping,
    ensureBlockWrapper,
    updateToolbarState,
  });
  // A brand-new note starts with html: "" — surface.innerHTML = "" leaves surface with no element
  // content at all, so the very first character typed lands as a loose text node with no block
  // wrapper around it (invisible to getTouchedBlocks() et al, same class of bug as the stray <div>
  // fixed above), and the first Enter press has no existing <p> to split, so the browser falls back
  // to inserting a bare <br> instead — a visibly shorter gap than a real paragraph break, since it
  // skips the block's own margin. Seeding an empty note with one real (empty) paragraph instead gives
  // typing a block to land in and Enter a block to split from the very first keystroke; the placeholder
  // still shows normally since updateEmptyState() checks textContent, not innerHTML.
  surface.innerHTML = seed.html || "<p><br></p>";
  if (noSecrets()) surface.querySelectorAll("[" + SECRET_ATTR + "]").forEach((el) => el.removeAttribute(SECRET_ATTR));
  if (player) {
    containerEl.classList.add("player-editor");
    document.querySelector(`#${idPrefix}Toolbar button[data-cmd="toggleSecret"]`)?.remove();
  } else {
    containerEl.classList.remove("player-editor");
    if (noSecrets()) (document.querySelector(`#${idPrefix}Toolbar button[data-cmd="toggleSecret"]`) as HTMLElement | null)?.setAttribute("hidden", "");
  }
  const connectionsBtn = document.getElementById(idPrefix + "ConnectionsBtn") as HTMLElement;
  connectionsBtn.addEventListener("click", toggleConnections);
  closeConnections();
  if (!player) {
    linkedItemsRefresh = () => void refreshLinkedItems(seed.id, connectionsBtn);
    linkedItemsRefresh();
  } else {
    linkedItemsRefresh = null;
  }
  // Links show their notes' current titles (and which ones are gone); new titles are saved with the
  // opening repair below, locally, without a new "edited" time. A player's links reach only the notes
  // shared with them; the rest read as plain text.
  const linksSynced = syncLinks(
    surface,
    player
      ? (id: string) => {
          const target = sharedNotes.find((n) => n.id === id);
          return target ? { title: target.title, gone: false } : null;
        }
      : linkTarget,
    s.untitled
  );
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

  // Undo/redo: see history.ts.
  const undoStack = createHistory({
    surface,
    blockAt,
    cellAt: tables.cellAt,
    tableCells: tables.tableCells,
    editorHtml,
    onRestore: afterHistoryRestore,
  });
  function pushHistory() {
    undoStack.push();
  }
  function undo() {
    undoStack.undo();
  }
  function redo() {
    undoStack.redo();
  }
  function afterHistoryRestore() {
    // A snapshot taken before a repair existed (or of a state the browser broke) comes back repaired.
    repairStructure();
    const n = currentNote();
    if (n) n.html = editorHtml();
    updateEmptyState();
    updateWordCount();
    updateToolbarState();
    scheduleSave();
  }
  let typingBurstTimer: ReturnType<typeof setTimeout> | null = null;
  let wordCountTimer: ReturnType<typeof setTimeout> | null = null;

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
    // A hidden mark that got in (a paste from another note, say) is dropped: the line shows.
    if (noSecrets() && surface.querySelector("[" + SECRET_ATTR + "]")) {
      surface.querySelectorAll("[" + SECRET_ATTR + "]").forEach((el) => el.removeAttribute(SECRET_ATTR));
      n.html = editorHtml();
      paintSecret();
    }
    n.updatedAt = Date.now();
    if (shared) sharedEdited();
    // A player's edits live in the players' copy only (sharedEdited sends them).
    if (player) {
      setSaveIndicator(true);
      return;
    }
    // The GM's own edit: the players' changes before it are part of the note now.
    if (n.playerBase) delete n.playerBase;
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

  // ---------- a note the players edit: one editor at a time (see editLock.ts) ----------
  // The first edit takes the note's lock (the editor stays editable meanwhile; if someone else got it
  // first, what was typed goes back to their version). Edits go up shortly after each pause,
  // renewing the lock; a minute without edits, or leaving the note, lets it go. While someone else
  // holds it, the editor is read-only and says who.
  const titleInputEl = document.getElementById(idPrefix + "TitleInput") as HTMLInputElement;
  const lockBanner = document.getElementById(idPrefix + "LockBanner") as HTMLElement;
  const lockStateEl = document.getElementById(idPrefix + "LockState") as HTMLElement;
  const finishEditBtn = document.getElementById(idPrefix + "FinishEditBtn") as HTMLButtonElement;
  const wordCountEl = document.getElementById(idPrefix + "WordCount") as HTMLElement;
  let lockMine = false;
  let lockTaking: Promise<boolean> | null = null;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushing: Promise<void> | null = null;
  let lastEdit = 0;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let lapseTimer: ReturnType<typeof setTimeout> | null = null;
  let ended = false;
  // The players' copy as this editor last had it (built from it, or sent to it): a later version of
  // it with the same text is this one coming back, no reason to rebuild.
  let sharedHtml = seed.html;
  let sharedTitle = seed.title;
  function editorName(): string {
    return playerName || (player ? strings().someone : "GM");
  }
  // Why the editor is read-only, if it is: the GM is signed out, or someone else has the lock.
  function lockReason(): { signedOut: true } | { holder: string } | null {
    if (!shared || ended) return null;
    if (!player && !canPublish()) return { signedOut: true };
    if (lockMine || lockTaking) return null;
    const holder = lockHolder(seed!.id, editorUid());
    return holder ? { holder: holder.name || strings().someone } : null;
  }
  function refreshLock() {
    if (!shared || ended) return;
    const reason = lockReason();
    const st = strings();
    surface.contentEditable = reason ? "false" : "true";
    titleInputEl.readOnly = !!reason;
    document.getElementById(idPrefix + "Toolbar")?.classList.toggle("locked", !!reason);
    // Signed out goes above the note (it's an instruction); who's editing, or "Done" while it's this
    // editor, goes in the footer in the word count's place.
    const signedOut = !!reason && "signedOut" in reason;
    lockBanner.hidden = !signedOut;
    lockBanner.textContent = signedOut ? st.editableSignedOut : "";
    const holderText = reason && "holder" in reason ? st.lockedBy(reason.holder) : "";
    lockStateEl.hidden = !holderText;
    lockStateEl.title = holderText;
    lockStateEl.querySelector(".lock-state-text")!.textContent = holderText;
    finishEditBtn.hidden = !lockMine;
    wordCountEl.hidden = !!holderText || lockMine;
    if (lapseTimer) clearTimeout(lapseTimer);
    lapseTimer = null;
    const wait = lockLapsesIn(seed!.id, editorUid());
    if (reason && wait) lapseTimer = setTimeout(refreshLock, wait + 50);
  }
  function takeLock(): Promise<boolean> {
    if (lockMine) return Promise.resolve(true);
    if (!lockTaking) {
      lockTaking = takeSharedLock(seed!.id, editorName()).then((ok) => {
        lockTaking = null;
        if (ok) {
          lockMine = true;
          // Leaving meanwhile: letGo sends the last edit and lets the lock go, no renewing.
          if (!ended) startRenew();
        } else lockLost();
        refreshLock();
        return ok;
      });
    }
    return lockTaking;
  }
  function startRenew() {
    if (renewTimer) return;
    renewTimer = setInterval(() => {
      if (!lockMine) return;
      if (Date.now() - lastEdit >= LOCK_IDLE) {
        void letGo();
        return;
      }
      if (!pushTimer && !pushing) {
        void takeSharedLock(seed!.id, editorName()).then((ok) => {
          if (!ok && lockMine) lockLost();
        });
      }
    }, LOCK_RENEW);
  }
  function stopRenew() {
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = null;
  }
  function sharedEdited() {
    lastEdit = Date.now();
    void takeLock();
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void pushNow(), 1200);
  }
  // Sends what's on screen (not the note object: for a player, a live update replaces it with the
  // version last sent).
  async function pushNow() {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    if (pushing) await pushing;
    const run = (async () => {
      if (!(await takeLock())) return;
      const edit = { title: titleInputEl.value, html: editorHtml(), updatedAt: Date.now() };
      if (!(await saveSharedEdit(seed!.id, edit, editorName()))) {
        lockLost();
        return;
      }
      sharedHtml = sanitizeNoteHtml(edit.html);
      sharedTitle = edit.title;
      if (player && !pushTimer) {
        setSaveIndicator(false);
        onSaved();
      }
    })();
    pushing = run;
    await run;
    if (pushing === run) pushing = null;
  }
  async function letGo() {
    stopRenew();
    if (lockTaking) await lockTaking;
    if (pushTimer || pushing) await pushNow();
    stopRenew();
    if (!lockMine) return;
    lockMine = false;
    await releaseSharedLock(seed!.id);
    refreshLock();
  }
  function lockLost() {
    lockMine = false;
    stopRenew();
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    if (ended) return;
    if (player) setSaveIndicator(false);
    refreshLock();
    // Someone else got there first: a player's screen goes back to their version (the GM's edits stay
    // in the GM's own note, until a newer version of the players' comes back).
    if (player) renderEditor(true);
  }
  // Done: the last edit goes up and the lock is let go now, not after a minute; typing again takes it back.
  finishEditBtn.addEventListener("click", () => {
    surface.blur();
    titleInputEl.blur();
    void letGo();
  });
  editorSession = {
    noteId: seed.id,
    player,
    busy: () => lockMine || !!lockTaking || !!pushTimer || !!pushing,
    html: () => sharedHtml,
    title: () => sharedTitle,
    refreshLock,
    end: () => {
      if (ended) return;
      ended = true;
      if (lapseTimer) clearTimeout(lapseTimer);
      if (shared) void letGo();
    },
  };
  refreshLock();

  (document.getElementById(idPrefix + "TitleInput") as HTMLInputElement).addEventListener("input", function (this: HTMLInputElement) {
    const n = currentNote();
    if (!n) return;
    n.title = this.value;
    refreshLinkersOf(n.id);
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
    const cmd = btn.dataset.cmd!;
    const value = btn.dataset.value || undefined;
    // Table cells hold inline formatting only (see updateToolbarState, which greys these out there).
    if (BLOCK_ONLY_CMDS.has(cmd) && tables.selectionInTable()) return;
    // An item of a dropdown (the block menu, the list menu): the dropdown closes.
    const menu = btn.closest(".pill-swatches") as HTMLElement | null;
    if (menu) {
      menu.hidden = true;
      menu.parentElement?.querySelector(".pill-picker-btn")?.setAttribute("aria-expanded", "false");
    }
    if (cmd === "toggleSecret") {
      surface.focus();
      toggleSecret();
      return;
    }
    pushHistory();
    surface.focus();
    secretSnapshot();
    if (cmd === "formatBlock") {
      const menuValue = ((value || "P").toUpperCase()) as BlockTag;
      // Only the block type: a converted line stays in the section it's in (leaving one is the
      // indent buttons' job, see stepSection).
      setBlockType(menuValue);
    } else if (cmd === "divider") {
      // A divider replaces the selection: over a collapsed section, it only expands it.
      if (!sections.unfoldSelection()) insertDivider();
    } else if (cmd === "removeFormat") {
      clearFormatting();
    } else if ((cmd === "indent" || cmd === "outdent") && !caretInList()) {
      // Outside a list, Chrome "indents" by wrapping the block in a margin-styled <blockquote>, which
      // the HTML sanitizer turns into a real (bar-styled) quote on other devices. Out of lists these
      // buttons move the line out of (or back into) the sections around it instead, same as Tab.
      const block = sel0Block();
      if (block) stepSection(block, cmd === "outdent" ? -1 : 1);
    } else if (cmd === "insertUnorderedList" || cmd === "insertOrderedList" || cmd === "checkList") {
      setListKind(cmd === "checkList" ? "CHECK" : cmd === "insertOrderedList" ? "OL" : "UL");
    } else {
      // Outdenting items: they're moved as they are, see outdentSelection.
      const handled = cmd === "outdent" && outdentSelection();
      if (!handled) runKeepingPills(() => document.execCommand(cmd, false, value));
      if (cmd === "indent") inheritChecklist();
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
    const hid = guardSecret();
    const n = currentNote();
    if (n) n.html = editorHtml();
    scheduleSave();
    if (hid) pushSecretNow();
    updateEmptyState();
    updateToolbarState();
  });

  function wireDropdown(btnId: string, swatchesId: string, onOpen?: (sw: HTMLElement) => void) {
    const btn = document.getElementById(btnId);
    const sw = document.getElementById(swatchesId);
    if (!btn || !sw) return;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (btn.getAttribute("aria-disabled") === "true") return;
      surface.focus();
      const willOpen = sw.hidden;
      sw.hidden = !willOpen;
      btn.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        onOpen?.(sw);
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
        // Same for the bottom: a dropdown taller than the room left below it (the table menu, in a
        // short panel, or once a submenu opens) would be cut off by the panel's edge, so it scrolls
        // within that room instead.
        const room = panelRect.bottom - margin - sw.getBoundingClientRect().top;
        sw.style.maxHeight = `${Math.max(room, 80)}px`;
      }
    });
  }
  // `current` is the color applied where the selection starts: a swatch's color, "" for none, or null
  // when it's neither (a color from outside the palette). The menu marks that swatch when it opens,
  // like the table menu does.
  function wireColorPicker(
    btnId: string,
    swatchesId: string,
    current: () => string | null,
    onColor: (hex: string) => void,
    onNone?: () => void
  ) {
    const btn = document.getElementById(btnId);
    const sw = document.getElementById(swatchesId);
    if (!btn || !sw) return;
    wireDropdown(btnId, swatchesId, () => {
      const color = current();
      const shown = color ? cssColor(color) : color;
      sw.querySelectorAll<HTMLElement>("button[data-color]").forEach((b) => {
        const c = b.dataset.color!;
        b.classList.toggle("on", shown !== null && (c ? cssColor(c) : "") === shown);
      });
    });
    sw.addEventListener("click", (ev) => {
      const b = (ev.target as HTMLElement).closest("button[data-color]") as HTMLElement | null;
      if (!b) return;
      ev.stopPropagation();
      pushHistory();
      const color = b.dataset.color;
      if (color) { onColor(color); } else if (onNone) { onNone(); }
      repairStructure();
      sw.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      // Back to the note: focus stayed on the (now hidden) swatch, so keys — Ctrl+Z to undo the
      // color just picked, or simply typing on — went nowhere until the note was clicked again.
      surface.focus();
      const n = currentNote();
      if (n) n.html = editorHtml();
      scheduleSave();
      updateEmptyState();
      updateToolbarState();
    });
  }

  wireDropdown(idPrefix + "BlockPickerBtn", idPrefix + "BlockMenu");
  wireDropdown(idPrefix + "ListPickerBtn", idPrefix + "ListMenu");
  wireColorPicker(idPrefix + "PillPickerBtn", idPrefix + "PillSwatches", pillColorAtSelection, applyPillColor, removePillAtSelection);
  wireColorPicker(idPrefix + "TextColorPickerBtn", idPrefix + "TextColorSwatches", textColorAtSelection, applyTextColor, resetTextColor);
  wireColorPicker(idPrefix + "QuoteColorPickerBtn", idPrefix + "QuoteColorSwatches", quoteColorAtSelection, applyQuoteColor, removeQuote);
  // The color each picker would mark (see wireColorPicker).
  function pillColorAtSelection(): string | null {
    const pill = getPillAtSelection();
    return pill ? pill.style.getPropertyValue("--pill-c").trim() || null : "";
  }
  function quoteColorAtSelection(): string | null {
    const quote = getQuoteAtSelection();
    return quote ? quote.style.getPropertyValue("--quote-c").trim() || null : "";
  }
  // The nearest color set on the text (by the text color picker: a span's own color), up to its
  // block. Text reset to the theme's color counts as none; a pill's own text color, as neither.
  function textColorAtSelection(): string | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return "";
    const block = blockAt(sel.getRangeAt(0).startContainer);
    for (let n: Node | null = sel.getRangeAt(0).startContainer; n && n !== block && n !== surface; n = n.parentNode) {
      // A color picked with nothing selected comes from execCommand("foreColor"): a <font color>.
      const color = n.nodeType === 1 ? (n as HTMLElement).style.color || (n as HTMLElement).getAttribute("color") || "" : "";
      if (!color) continue;
      if (color === "var(--text-primary)") return "";
      return color.startsWith("var(") ? null : color;
    }
    return "";
  }
  // A color as the browser writes it back (rgb(...)), so colors written as hex compare equal.
  function cssColor(color: string): string {
    const probe = document.createElement("span");
    probe.style.color = color;
    return probe.style.color;
  }
  // Before wireDropdown: the menu's content (size grid or options) must be set before it measures
  // the menu to place it.
  tables.wirePicker();
  wireDropdown(idPrefix + "TablePickerBtn", idPrefix + "TableMenu");

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
    if (tables.selectionInTable()) return;
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
  // Only the quotes: lines of another type (or a list) the selection also reaches are left as they are.
  function removeQuote() {
    if (getTouchedBlocks().some((b) => b.tagName === "BLOCKQUOTE")) setBlockType("P", (b) => b.tagName === "BLOCKQUOTE");
  }

  // The parts of a selection in each line it spans — paragraph, heading, quote line, list item or
  // table cell. A pill or a color span is inline: one wrapped around a selection that crosses lines
  // swallowed the lines themselves (list items inside a span inside an item, table cells split in
  // two), so those get one span per line instead. A selection within one line is used as-is (a
  // pill across Shift+Enter line breaks stays one pill).
  const LINE_ELEMENTS = "p, h1, h2, h3, h4, blockquote, li, td, th";
  function lineRanges(range: Range): Range[] {
    const lines = (Array.prototype.slice.call(surface.querySelectorAll(LINE_ELEMENTS)) as HTMLElement[]).filter(
      (el) => !el.querySelector(LINE_ELEMENTS) && range.intersectsNode(el)
    );
    if (lines.length <= 1) return [range];
    return lines
      .map((el) => {
        const part = document.createRange();
        part.selectNodeContents(el);
        if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) part.setStart(range.startContainer, range.startOffset);
        if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) part.setEnd(range.endContainer, range.endOffset);
        return part;
      })
      .filter((part) => part.toString() !== "");
  }
  function wrapRange(range: Range, wrapper: HTMLElement) {
    try {
      range.surroundContents(wrapper);
    } catch {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
    }
  }
  // Selects from the start of the first element to the end of the last.
  function selectSpanning(els: HTMLElement[]) {
    const sel = window.getSelection();
    if (!sel || !els.length) return;
    const r = document.createRange();
    r.setStart(els[0], 0);
    const last = els[els.length - 1];
    r.setEnd(last, last.childNodes.length);
    sel.removeAllRanges();
    sel.addRange(r);
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
    const isReset = hex === "var(--text-primary)";
    const spans = lineRanges(range).map((part) => {
      const span = document.createElement("span");
      span.style.color = hex;
      wrapRange(part, span);
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
      return span;
    });
    // Splitting a pill at the selection's edge (extractContents, when the selection starts/ends right
    // at a pill's boundary) can leave an empty pill shell behind, drawn as a tiny blank pill.
    Array.prototype.slice.call(surface.querySelectorAll(".note-pill")).forEach((pill: HTMLElement) => {
      if (pill.textContent === "") pill.remove();
    });
    selectSpanning(spans);
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
    // One pill per line the selection spans (see lineRanges); a line where only spaces are selected
    // gets none, rather than a blank pill.
    const pills = lineRanges(range)
      .filter((part) => part.toString().trim() !== "")
      .map((part) => {
        const span = document.createElement("span");
        span.className = "note-pill";
        span.style.setProperty("--pill-c", hex);
        wrapRange(part, span);
        return span;
      });
    selectSpanning(pills);
  }
  function removePillAtSelection() {
    pillsInSelection().forEach((pill) => {
      const text = document.createTextNode(pill.textContent || "");
      pill.replaceWith(text);
    });
  }

  // The block-level element (P/H1/H2/BLOCKQUOTE/UL/OL) that's a DIRECT CHILD of `surface` and
  // contains `node` — the level our own block-type toggling and clear-formatting operate at.
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
  // only: converts just the touched blocks it accepts (and then leaves lists alone).
  function setBlockType(tag: BlockTag, only?: (block: HTMLElement) => boolean): HTMLElement[] {
    // Any other type turns the selected list items into lines of that type (a quote keeps a list
    // whole, inside it).
    if (tag !== "BLOCKQUOTE" && !only) delistTouchedBlocks();
    const blocks = only ? getTouchedBlocks().filter(only) : getTouchedBlocks();
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
      // Only a quote can hold a list (delistTouchedBlocks already turned any other list into lines).
      if (finalTag !== "BLOCKQUOTE" && (b.tagName === "UL" || b.tagName === "OL")) return;
      const nb = document.createElement(finalTag);
      // Hidden from players is not its type either.
      if (b.hasAttribute(SECRET_ATTR)) nb.setAttribute(SECRET_ATTR, "");
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
        // Where the line sits among the sections is not its type: a line that left one keeps
        // having left it.
        const exit = exitLevel(b);
        if (exit && canExit(nb)) nb.setAttribute("data-exit", String(exit));
        b.replaceWith(nb);
        // A quote holding a list, turned into a paragraph/heading: the list goes back to being a
        // list of its own, after the line, instead of ending up inside it (<p><ul>).
        const pieces = splitBlock(nb);
        if (pieces.length !== 1 || pieces[0] !== nb) {
          if (!firstNew) firstNew = pieces[0];
          result.push(...pieces);
          return;
        }
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

    // Cells the selection covers, gathered before anything below moves the selection: they're not
    // blocks (setBlockType leaves tables alone), so their pills/colors are stripped separately.
    const touchedCells = (Array.prototype.slice.call(surface.querySelectorAll("td, th")) as HTMLElement[]).filter((c) => range.intersectsNode(c));

    // Lists included: setBlockType turns the selected items into paragraphs first.
    const blocks = setBlockType("P");

    // setBlockType() collapses the selection to a single caret in the FIRST converted block (that's
    // its own contract — see its comment). Restoring a selection spanning every block it actually
    // touched, before the two steps below run, is what makes THEM also apply to every block instead
    // of just that first one: without this, "clear formatting" across a multi-paragraph selection
    // correctly converted every block to plain text, but silently only ever stripped bold/italic/
    // color/pills from the first paragraph, leaving the rest formatted.
    // (Cells count here too, so a selection spanning text and a table clears both.)
    const cleared = [...blocks, ...touchedCells].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    if (blocks.length) {
      const first = cleared[0];
      const last = cleared[cleared.length - 1];
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
    cleared.forEach((block) => {
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
  // The list items a selection actually covers: some of their text, the caret, or the whole item
  // (an empty one in the middle). Merely touching an item's edge — a triple-clicked line above a
  // list ends right at the start of its first item — doesn't count.
  function selectedItems(range: Range): HTMLElement[] {
    return (Array.prototype.slice.call(surface.querySelectorAll("li")) as HTMLElement[]).filter((li) => {
      if (li.closest("td, th") || !range.intersectsNode(li)) return false;
      if (li.contains(range.startContainer) || li === range.startContainer) return true;
      const part = document.createRange();
      part.selectNodeContents(li);
      const startsBefore = part.compareBoundaryPoints(Range.START_TO_START, range) >= 0;
      const endsAfter = part.compareBoundaryPoints(Range.END_TO_END, range) <= 0;
      if (startsBefore && endsAfter) return true;
      if (!startsBefore) part.setStart(range.startContainer, range.startOffset);
      if (!endsAfter) part.setEnd(range.endContainer, range.endOffset);
      return part.toString().replace(/[\s\u200b]/g, "") !== "";
    });
  }
  // Turns the list items the selection covers into lines (see itemToLine): just those items — the
  // rest of their list, their sub-items included, stays a list — leaving the selection spanning
  // them and the other lines it covered, for setBlockType to convert next.
  function delistTouchedBlocks() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const items = selectedItems(sel.getRangeAt(0));
    if (!items.length) return;
    // Recorded before anything moves: moving the items' content out from under the selection
    // leaves it pointing elsewhere.
    const others = getTouchedBlocks().filter((b) => !/^(UL|OL)$/.test(b.tagName) && !(b.tagName === "BLOCKQUOTE" && b.querySelector("li")));
    const lines = items.map((li) => itemToLine(li, surface)).filter((l): l is HTMLElement => !!l);
    const all = [...others, ...lines].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (!all.length) return;
    const last = all[all.length - 1];
    const span = document.createRange();
    span.setStart(all[0], 0);
    span.setEnd(last, last.childNodes.length);
    sel.removeAllRanges();
    sel.addRange(span);
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

  // After the toolbar's own DOM changes and pastes: the same repair every edit gets (see structure.ts).
  function removeEditorNoise() {
    repairStructure();
  }
  // Repairs what the browser's own editing leaves behind (see structure.ts), keeping the selection.
  // The surface's own text color tells a stray span copying it from a color the GM actually picked.
  function repairStructure(): boolean {
    // Read only if a stray span turns up: getComputedStyle forces a style recalculation, and this
    // runs on every keystroke.
    const changed = normalizeStructure(surface, { baseColor: () => getComputedStyle(surface).color });
    // A table the browser left anywhere but the top level (dragged into a list or a quote, or into
    // another table's cell) goes back there; one lifted out of a line already was, above.
    const misplaced = Array.prototype.some.call(surface.querySelectorAll("table"), (t: Element) => t.parentElement !== surface);
    if (misplaced) tables.normalizeTables();
    return changed || misplaced;
  }

  // A native list command, with the pills it would drop put back (see markPills in structure.ts).
  // Links are made editable for the command's length: Chrome's list and indent commands duplicate a
  // list item holding only something it can't edit. They're atomic again right after.
  function runKeepingPills(command: () => void) {
    // A selection reaching from list lines into a table: Chrome's indent and list commands tear the
    // table apart (cells pulled out into a margin block, the rest duplicated). They get only what
    // comes before the table.
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const table = (Array.prototype.slice.call(surface.querySelectorAll(":scope > table")) as HTMLElement[]).find((t) => r.intersectsNode(t));
      if (table && !table.contains(r.startContainer)) {
        const prev = table.previousElementSibling;
        if (prev) {
          const cut = document.createRange();
          cut.setStart(r.startContainer, r.startOffset);
          cut.selectNodeContents(prev);
          cut.setStart(r.startContainer, r.startOffset);
          sel.removeAllRanges();
          sel.addRange(cut);
        }
      }
    }
    const marks = markPills(surface, getTouchedBlocks());
    const links = Array.prototype.slice.call(surface.querySelectorAll(".note-link")) as HTMLElement[];
    links.forEach((l) => l.setAttribute("contenteditable", "true"));
    try {
      command();
    } finally {
      surface.querySelectorAll(".note-link").forEach((l) => l.setAttribute("contenteditable", "false"));
    }
    if (marks.length) keepingSelection(surface, () => restorePills(surface, marks));
  }

  // An item of a list sitting at the top level (straight in the note, or in a quote).
  function isTopLevelItem(li: HTMLElement): boolean {
    const host = li.parentElement && li.parentElement.parentElement;
    return !!host && (host === surface || (host.tagName === "BLOCKQUOTE" && host.parentElement === surface));
  }

  // Chrome's own outdent and list toggle rebuild the content of the items they move from computed
  // styles: a pill came out as text in the pill's color (and bold/strike got copied font sizes). The
  // items are moved as they are instead — every node kept, the selection with them.
  //
  // Outdent (Shift+Tab, Decrease indent): every selected item moves up one level — a top-level one
  // out of its list, as a line; a sub-item into the list above it (see outdentItems). Returns whether
  // it did this.
  function outdentSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const items = selectedItems(sel.getRangeAt(0));
    if (!items.length) return false;
    keepingSelection(surface, () => {
      // Which ones are top-level is decided first: a sub-item moved up becomes one, and stays an item.
      const top = items.filter(isTopLevelItem);
      outdentItems(items.filter((li) => !isTopLevelItem(li)));
      top.forEach((li) => itemToLine(li, surface));
      return true;
    });
    return true;
  }
  // The list button turning its list off: every selected item becomes a line, sub-items included.
  function unlistSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const items = selectedItems(sel.getRangeAt(0));
    if (!items.length) return false;
    keepingSelection(surface, () => items.map((li) => itemToLine(li, surface)).some(Boolean));
    return true;
  }
  // Moves sub-items up one level: into the list above, right after the sub-list they were in, each
  // with its own sub-items (which move up with it); the items after them in that sub-list become
  // sub-items of the last one — as in a word processor. Selected items of the same sub-list move
  // together, shallower sub-lists first; a selected item carried up along with its parent has
  // already moved its one level, so it isn't moved again.
  function outdentItems(nested: HTMLElement[]) {
    const done = new Set<HTMLElement>();
    const depth = (el: HTMLElement) => {
      let d = 0;
      for (let p = el.parentElement; p && p !== surface; p = p.parentElement) d++;
      return d;
    };
    const groups = new Map<HTMLElement, HTMLElement[]>();
    nested.forEach((li) => {
      const sub = li.parentElement as HTMLElement;
      if (!groups.has(sub)) groups.set(sub, []);
      groups.get(sub)!.push(li);
    });
    Array.from(groups.entries())
      .sort((a, b) => depth(a[0]) - depth(b[0]))
      .forEach(([, all]) => {
        const group = all.filter((li) => !done.has(li));
        if (!group.length) return;
        const sub = group[0].parentElement;
        if (!sub || !sub.parentElement || !/^(UL|OL)$/.test(sub.parentElement.tagName)) return;
        const kids = Array.prototype.slice.call(sub.childNodes) as Node[];
        const at = group.map((li) => kids.indexOf(li)).filter((i) => i >= 0);
        if (!at.length) return;
        const i0 = Math.min(...at);
        let i1 = Math.max(...at);
        const next = kids[i1 + 1];
        if (next && next.nodeType === 1 && /^(UL|OL)$/.test((next as Element).tagName)) i1++;
        const moved = kids.slice(i0, i1 + 1);
        const rest = kids.slice(i1 + 1);
        let cursor: Node = sub;
        moved.forEach((n) => {
          cursor.parentNode!.insertBefore(n, cursor.nextSibling);
          cursor = n;
          if (n.nodeType === 1) nested.forEach((li) => { if ((n as Element).contains(li)) done.add(li); });
        });
        if (rest.some((n) => n.nodeType === 1)) {
          // Joined to the sub-list that moved up with the last item, if there's one: one list, not
          // two side by side.
          const last = cursor as Element;
          const into = last.tagName === sub.tagName ? last : null;
          const after = into || (sub.cloneNode(false) as HTMLElement);
          rest.forEach((n) => after.appendChild(n));
          if (!into) last.after(after);
        }
        if (!sub.children.length) sub.remove();
      });
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
    // it, so blockAt() always climbs all the way to the outermost list; see structure.ts's repairLists).
    // Splitting that the same way a paragraph gets split below would extract raw text/inline content
    // straight into a freshly cloned list with no <li> wrapper around it — invalid markup that renders
    // with no bullet and misaligned, the same class of breakage the quote-wrapping-a-list bug was.
    // Properly splitting a list in place would mean replicating this file's list-splitting logic
    // (already intricate specifically because of that sibling-nesting) just for an occasional
    // mid-list divider insert, so instead we simply place the divider right after the whole list.
    // Same for a table: a divider can't go inside a cell, so it goes after the whole table.
    if (!block || block.tagName === "UL" || block.tagName === "OL" || block.tagName === "TABLE") {
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
  // list items in their list (and cells in their table), since the browser's range clone only carries
  // what's strictly inside it.
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
      const has = (names: string[]) => Array.prototype.some.call(content.childNodes, (n: Node) => names.includes(n.nodeName));
      const listWrap = (tag === "UL" || tag === "OL") && has(["LI"]);
      // A selection across cells: its rows/cells only make sense inside their table.
      const tableWrap =
        (tag === "TR" && has(["TD", "TH"])) ||
        ((tag === "TBODY" || tag === "THEAD") && has(["TR"])) ||
        (tag === "TABLE" && has(["TBODY", "THEAD", "TR"]));
      if (inline || listWrap || tableWrap) {
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
    // saved (input) like any other edit, and startEditStep() makes it undoable.
    if (cut) {
      startEditStep();
      secretSnapshot();
      document.execCommand("delete");
    }
  }
  // Cutting a selection that reaches into a collapsed section only expands it (see sections.ts).
  surface.addEventListener("cut", (ev: ClipboardEvent) => {
    if (sections.unfoldSelection()) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  });
  surface.addEventListener("copy", (ev: ClipboardEvent) => onCopy(ev, false));
  surface.addEventListener("cut", (ev: ClipboardEvent) => onCopy(ev, true));

  surface.addEventListener("paste", (ev: ClipboardEvent) => {
    ev.preventDefault();
    snapOutOfLinks();
    // Pasting over a selection reaching into a collapsed section only expands it (see sections.ts).
    if (sections.unfoldSelection()) return;
    const own = ev.clipboardData?.getData(CLIPBOARD_TYPE) ?? "";
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!own && !text) return;
    startEditStep();
    insertTransfer(own, text);
  });
  // Inserts pasted or dropped content at the selection: `own` is content in our own format (from
  // this editor), `text` anyone else's plain text.
  function insertTransfer(own: string, text: string) {
    secretSnapshot();
    // Into a table cell, everything goes in as inline content (cells hold no blocks): our own
    // formatted content flattened, anyone else's text as literal text (no Markdown), its lines
    // becoming line breaks.
    if (tables.selectionCell()) {
      if (own) {
        insertOwnHtml(flattenToInline(sanitizeNoteHtml(own)));
        return;
      }
      if (!/[\r\n]/.test(text)) {
        document.execCommand("insertText", false, text);
        return;
      }
      document.execCommand("insertHTML", false, text.replace(/\r\n?/g, "\n").split("\n").map(escapeHtml).join("<br>"));
      removeEditorNoise();
      return;
    }
    if (own) {
      insertOwnHtml(sanitizeNoteHtml(own));
      return;
    }
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
    tables.normalizeTables();
    removeEditorNoise();
    if (guardSecret()) {
      const n = currentNote();
      if (n) n.html = editorHtml();
      scheduleSave();
      pushSecretNow();
    }
  }

  // Inserts content in our own format at the selection as nodes, not through execCommand("insertHTML"):
  // Chrome rewrites what insertHTML inserts to match the computed styles around it, so a pill pasted
  // next to plain text arrived as a span of its computed color, with no pill class. Blocks landing
  // inside a line split it around them (repairStructure), so each pasted block keeps its type.
  function insertOwnHtml(html: string) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !surface.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
    // The browser's own delete merges the lines a selection spans, as typing over it would.
    if (!sel.isCollapsed) document.execCommand("delete");
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const last = tpl.content.lastChild;
    if (!last) return;
    if (insertItemsIntoList(tpl.content)) return;
    if (tpl.content.querySelector(".note-pill")) leavePillAtCaret();
    sel.getRangeAt(0).insertNode(tpl.content);
    // The caret goes after what was inserted: at the end of its last line when that's a block, so
    // typing doesn't land loose between blocks.
    const end = document.createRange();
    if (last.nodeType === 1 && /^(P|H[1-4]|BLOCKQUOTE|UL|OL|TABLE|DIV)$/.test((last as Element).tagName)) {
      end.selectNodeContents(last);
      end.collapse(false);
    } else {
      end.setStartAfter(last);
    }
    sel.removeAllRanges();
    sel.addRange(end);
    tables.normalizeTables();
    syncTextDecorationColors();
    // Saves like any edit, and repairs the line the content landed in (see the input listener).
    surface.dispatchEvent(new Event("input"));
  }

  // Content with pills of its own, inserted with the caret inside a pill, would put a pill inside a
  // pill: the pill is split at the caret first, and the caret put between the two halves.
  function leavePillAtCaret() {
    const sel = window.getSelection()!;
    const r = sel.getRangeAt(0);
    const start = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : (r.startContainer as HTMLElement);
    const pill = start && (start.closest(".note-pill") as HTMLElement | null);
    if (!pill || !surface.contains(pill)) return;
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(pill, pill.childNodes.length);
    const rest = pill.cloneNode(false) as HTMLElement;
    rest.appendChild(tail.extractContents());
    pill.after(rest);
    const between = document.createRange();
    between.setStartAfter(pill);
    between.collapse(true);
    sel.removeAllRanges();
    sel.addRange(between);
    // An empty half is dropped by the repair after the insert.
  }

  // List items pasted or dropped with the caret in a list item join that list, right after the item
  // (the item's text after the caret following them as an item of its own), rather than landing
  // inside the item — which made them a sub-list, a level deeper than they were. Into an empty item,
  // they replace it. Only when what's inserted is nothing but lists; returns whether it did this.
  function insertItemsIntoList(content: DocumentFragment): boolean {
    const sel = window.getSelection()!;
    const r = sel.getRangeAt(0);
    const start = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : (r.startContainer as HTMLElement);
    const li = start && (start.closest("li") as HTMLElement | null);
    if (!li || !surface.contains(li) || li.closest("td, th")) return false;
    const nodes = Array.prototype.slice.call(content.childNodes) as Node[];
    const lists = nodes.filter((n) => !(n.nodeType === 3 && !(n as Text).data.trim()));
    if (!lists.length || !lists.every((n) => n.nodeType === 1 && /^(UL|OL)$/.test((n as Element).tagName))) return false;
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(li, li.childNodes.length);
    const rest = tail.extractContents();
    let cursor: Element = li;
    let lastItem: HTMLElement | null = null;
    lists.forEach((list) => {
      (Array.prototype.slice.call((list as Element).childNodes) as Node[]).forEach((n) => {
        if (n.nodeType !== 1) return;
        cursor.after(n);
        cursor = n as Element;
        const items = (n as Element).tagName === "LI" ? [n as HTMLElement] : (Array.prototype.slice.call((n as Element).querySelectorAll("li")) as HTMLElement[]);
        if (items.length) lastItem = items[items.length - 1];
      });
    });
    const restText = (rest.textContent || "").replace(/\u200b/g, "").trim();
    if (restText || (rest as DocumentFragment).querySelector?.(".note-pill")) {
      const item = document.createElement("li");
      item.appendChild(rest);
      cursor.after(item);
    }
    if (!(li.textContent || "").replace(/\u200b/g, "").trim() && !li.querySelector(".note-pill")) li.remove();
    if (lastItem) {
      const end = document.createRange();
      end.selectNodeContents(lastItem);
      end.collapse(false);
      sel.removeAllRanges();
      sel.addRange(end);
    }
    syncTextDecorationColors();
    surface.dispatchEvent(new Event("input"));
    return true;
  }

  // Drag and drop goes through the same path as copy/paste. Left to the browser, a drop inserted
  // another page's HTML as-is (its fonts, colors, links, images — none of which the sanitizer lets
  // in through paste) and moved dragged blocks into places they can't be (a list into a table cell).
  // A drag from this editor carries our own format, like a copy; dropping it moves it (Ctrl/Alt:
  // copies it), as the browser would.
  let dragSource: Range | null = null;
  const DROP_MARKER = "data-drop-point";
  surface.addEventListener("dragstart", (ev: DragEvent) => {
    const html = selectionHtml();
    const sel = window.getSelection();
    if (html === null || !ev.dataTransfer || !sel || !sel.rangeCount) return;
    ev.dataTransfer.setData("text/plain", sel.toString().replace(/\u200b/g, ""));
    ev.dataTransfer.setData("text/html", html);
    ev.dataTransfer.setData(CLIPBOARD_TYPE, html);
    // A live range: it follows the dragged content as the drop inserts before it.
    dragSource = sel.getRangeAt(0).cloneRange();
  });
  surface.addEventListener("dragend", () => {
    dragSource = null;
  });
  function caretRangeAt(x: number, y: number): Range | null {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      return r;
    }
    return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  }
  surface.addEventListener("drop", (ev: DragEvent) => {
    ev.preventDefault();
    const source = dragSource;
    dragSource = null;
    const own = ev.dataTransfer?.getData(CLIPBOARD_TYPE) ?? "";
    const text = ev.dataTransfer?.getData("text/plain") ?? "";
    if (!own && !text) return;
    const at = caretRangeAt(ev.clientX, ev.clientY);
    if (!at || !surface.contains(at.startContainer)) return;
    // Moving a selection that reaches into a collapsed section would remove what's hidden there:
    // the drop only expands it (see sections.ts).
    if (source && !(ev.ctrlKey || ev.altKey) && sections.unfoldSelection(source)) return;
    // Dropped back onto itself: nothing moves.
    if (source && source.isPointInRange(at.startContainer, at.startOffset)) return;
    const sel = window.getSelection()!;
    surface.focus();
    startEditStep();
    if (source && !source.collapsed && !(ev.ctrlKey || ev.altKey)) {
      // A move: the original goes first, then the copy lands where it was dropped. The drop point is
      // held by a marker node, not a range: deleting (and the repair after it) can move or rebuild
      // the nodes around it, which leaves a range pointing somewhere else — the copy (or the
      // deletion, the other way round) then landed on the wrong text. A node moves along with them.
      const marker = document.createElement("wbr");
      marker.setAttribute(DROP_MARKER, "");
      at.insertNode(marker);
      const wholeLines = coversWholeLines(source);
      sel.removeAllRanges();
      sel.addRange(source);
      secretSnapshot();
      document.execCommand("delete");
      tidyAfterMove(wholeLines);
      const back = document.createRange();
      if (marker.isConnected) {
        back.setStartBefore(marker);
        marker.remove();
      } else {
        back.setStart(at.startContainer, at.startOffset);
      }
      back.collapse(true);
      sel.removeAllRanges();
      sel.addRange(back);
    } else {
      sel.removeAllRanges();
      sel.addRange(at);
    }
    insertTransfer(own, text);
    updateToolbarState();
  });
  // Whether a selection runs from the very start of its first line to the very end of its last —
  // moving it takes whole lines, so none should stay behind empty.
  function coversWholeLines(range: Range): boolean {
    const lineOf = (node: Node) => {
      const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
      return el ? (el.closest(LINE_ELEMENTS) as HTMLElement | null) : null;
    };
    const first = lineOf(range.startContainer);
    const last = lineOf(range.endContainer);
    if (!first || !last) return false;
    const before = document.createRange();
    before.selectNodeContents(first);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.selectNodeContents(last);
    after.setStart(range.endContainer, range.endOffset);
    return before.toString().replace(/\u200b/g, "") === "" && after.toString().replace(/\u200b/g, "") === "";
  }
  // After a drag moved text away (the caret where it was): the line it took whole doesn't stay
  // behind as an empty line or bullet, and a word taken from between two spaces doesn't leave both.
  function tidyAfterMove(wholeLines: boolean) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode!;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    const line = el ? (el.closest(LINE_ELEMENTS) as HTMLElement | null) : null;
    if (!line || !surface.contains(line)) return;
    // A line holding the drop point's marker isn't empty: what's being moved lands there.
    const isEmpty = !(line.textContent || "").replace(/\u200b/g, "").trim() && !line.querySelector(`.note-pill, hr, [${DROP_MARKER}]`);
    if (wholeLines && isEmpty && !/^(TD|TH)$/.test(line.tagName) && surface.children.length > 1) {
      const next = (line.nextElementSibling || line.previousElementSibling) as HTMLElement | null;
      line.remove();
      if (next) placeCaretAtStart(next);
      surface.dispatchEvent(new Event("input"));
      return;
    }
    // Chrome can leave the two spaces in separate text nodes: joined first (live ranges, the caret
    // and the drop point included, follow along).
    const host = node.parentNode;
    if (!host) return;
    host.normalize();
    const at = window.getSelection()!;
    if (!at.anchorNode || at.anchorNode.nodeType !== 3) return;
    const t = at.anchorNode as Text;
    const caret = at.anchorOffset;
    const space = /[ \u00a0]/;
    if (caret > 0 && caret < t.data.length && space.test(t.data[caret - 1]) && space.test(t.data[caret])) {
      t.deleteData(caret - 1, 1);
      // Chrome keeps the space it leaves as a non-breaking one; between two words it's an ordinary
      // space again (one that lets the line wrap there).
      const kept = caret - 1;
      if (t.data[kept] === "\u00a0" && kept > 0 && kept + 1 < t.data.length && !space.test(t.data[kept - 1]) && !space.test(t.data[kept + 1])) {
        t.replaceData(kept, 1, " ");
      }
      surface.dispatchEvent(new Event("input"));
    }
  }
  function noteTyping() {
    if (undoStack.restoring()) return;
    if (!typingBurstTimer) pushHistory();
    if (typingBurstTimer) clearTimeout(typingBurstTimer);
    typingBurstTimer = setTimeout(() => { typingBurstTimer = null; }, 700);
  }
  // Edits made with execCommand (our own paste/cut/line-break handling) never fire beforeinput, so
  // they record their undo step themselves. A paste or cut is a step of its own, also ending any
  // typing burst so the typing after it is undone separately.
  function startEditStep() {
    pushHistory();
    if (typingBurstTimer) { clearTimeout(typingBurstTimer); typingBurstTimer = null; }
  }
  surface.addEventListener("beforeinput", (ev: InputEvent) => {
    // Typing or deleting over a selection that reaches into a collapsed section: expand it first
    // (see sections.ts), so nothing hidden goes without being seen.
    if (ev.cancelable && sections.unfoldSelection()) {
      ev.preventDefault();
      return;
    }
    noteTyping();
    // Typing at a caret can't move anything from one block to another; everything else can (see
    // guardSecret).
    const sel = window.getSelection();
    const typing = /^insert(Text|CompositionText|ReplacementText)$/.test(ev.inputType) && !!sel && sel.isCollapsed;
    if (typing) secretBefore = null;
    else secretSnapshot();
  });
  // A pill's trailing edge: Chrome treats "end of the pill's text" and "start of whatever follows it"
  // as the same caret spot, draws the caret inside the pill there, and keeps typed text inside it —
  // and when a pill ends its paragraph there's no outside spot at all. So "outside" gets its own
  // caret anchor: a zero-width-space text node right after the pill, with the caret parked after
  // it. Chrome then both draws the caret outside the pill and types there natively. Being at the
  // pill's end INSIDE it stays a distinct spot (typing there extends the pill); → / ← step between
  // the two. The anchor's zero-width space is stripped as soon as real text lands next to it, or
  // the anchor removed entirely once the caret leaves it unused, so it never reaches a saved note.
  // The leading edge has the same problem the other way round (Chrome resolves "before the pill's
  // first character" to outside it), so it gets two anchors of its own: one as the pill's first
  // child, for the spot inside it before its first character, and one right before the pill, for
  // the spot outside it (which a pill starting its paragraph otherwise doesn't have either). Only
  // one anchor exists at a time: `pillAnchorKind` says which.
  const PILL_ANCHOR = "\u200b";
  let pillAnchor: Text | null = null;
  let pillAnchorKind: "after" | "before" | "start" = "after";
  // The editor's HTML minus purely view-side state, for anything saved or snapshotted: the caret
  // anchor's zero-width space and the data-folded markers applyFolding() puts on hidden blocks
  // (recomputed from each heading's data-collapsed whenever a note is shown, so never worth storing).
  // A selection end inside a link (a double-clicked word of it, say) moves to the link's edge: the
  // start before it, the end (or a caret past its first character) after it. Edits then never land
  // inside a link, the editor's own insertions (paste, drop) included.
  function snapOutOfLinks() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.focusNode) return;
    const linkOf = (n: Node) => {
      const el = n.nodeType === 3 ? n.parentElement : (n as HTMLElement);
      const link = el && el.closest ? (el.closest(".note-link") as HTMLElement | null) : null;
      return link && surface.contains(link) ? link : null;
    };
    const a = linkOf(sel.anchorNode);
    const f = linkOf(sel.focusNode);
    if (!a && !f) return;
    const spot = (link: HTMLElement, after: boolean) => {
      const parent = link.parentNode!;
      const i = Array.prototype.indexOf.call(parent.childNodes, link) as number;
      return { node: parent, offset: after ? i + 1 : i };
    };
    if (sel.isCollapsed) {
      const p = spot(a!, sel.anchorOffset > 0);
      sel.collapse(p.node, p.offset);
      return;
    }
    const r = sel.getRangeAt(0);
    const backward = r.startContainer === sel.focusNode && r.startOffset === sel.focusOffset && !(r.startContainer === sel.anchorNode && r.startOffset === sel.anchorOffset);
    const startLink = linkOf(r.startContainer);
    const endLink = linkOf(r.endContainer);
    const s = startLink ? spot(startLink, false) : { node: r.startContainer, offset: r.startOffset };
    const e = endLink ? spot(endLink, true) : { node: r.endContainer, offset: r.endOffset };
    if (backward) sel.setBaseAndExtent(e.node, e.offset, s.node, s.offset);
    else sel.setBaseAndExtent(s.node, s.offset, e.node, e.offset);
  }
  function editorHtml(): string {
    let html = surface.innerHTML.split(' data-folded=""').join("").split(' data-secret-in=""').join("").split(' data-missing=""').join("").replace(/ data-depth="\d+"/g, "");
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
      releasePillAnchor();
      anchor = document.createTextNode(PILL_ANCHOR);
      pill.after(anchor);
      pillAnchor = anchor;
      pillAnchorKind = "after";
    }
    window.getSelection()!.collapse(anchor, anchor.data.indexOf(PILL_ANCHOR) + 1);
  }
  // Inside the pill, before its first character: the caret after an anchor that's the pill's first
  // child, so typed text lands in the pill.
  function caretAtPillStart(pill: HTMLElement) {
    releasePillAnchor();
    const anchor = document.createTextNode(PILL_ANCHOR);
    pill.insertBefore(anchor, pill.firstChild);
    pillAnchor = anchor;
    pillAnchorKind = "start";
    window.getSelection()!.collapse(anchor, 1);
  }
  // Outside the pill, just before it: the caret before an anchor right before the pill, so the
  // anchor's zero-width space keeps it off the pill's edge and typed text lands outside.
  function caretBeforePill(pill: HTMLElement) {
    releasePillAnchor();
    const anchor = document.createTextNode(PILL_ANCHOR);
    pill.before(anchor);
    pillAnchor = anchor;
    pillAnchorKind = "before";
    window.getSelection()!.collapse(anchor, 0);
  }
  // The pill the caret is on the anchor of, if it is (and which anchor).
  function pillAtAnchor(): { pill: HTMLElement; kind: "after" | "before" | "start" } | null {
    const sel = window.getSelection();
    if (!pillAnchor || !sel || !sel.isCollapsed || sel.anchorNode !== pillAnchor) return null;
    const pill =
      pillAnchorKind === "after" ? pillAnchor.previousSibling
        : pillAnchorKind === "before" ? pillAnchor.nextSibling
          : pillAnchor.parentElement;
    return isPillNode(pill) ? { pill, kind: pillAnchorKind } : null;
  }
  // The pill whose start the (collapsed) caret is at, from outside: the end of whatever precedes it
  // (excluding our own anchors).
  function pillStartingAtCaret(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (!surface.contains(node) || node === pillAnchor) return null;
    if (node.nodeType === 3 && r.startOffset === (node as Text).length && isPillNode(node.nextSibling)) return node.nextSibling;
    if (node.nodeType === 1 && isPillNode(node.childNodes[r.startOffset])) return node.childNodes[r.startOffset] as HTMLElement;
    return null;
  }
  // The pill the (collapsed) caret is inside of, right after its first character.
  function pillAfterFirstCharAtCaret(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (!surface.contains(node) || node === pillAnchor) return null;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    const pill = el && el.closest ? (el.closest(".note-pill") as HTMLElement | null) : null;
    if (!pill || !surface.contains(pill)) return null;
    const before = document.createRange();
    before.setStart(pill, 0);
    before.setEnd(node, r.startOffset);
    return Array.from(before.toString().split(PILL_ANCHOR).join("")).length === 1 ? pill : null;
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
    if (undoStack.restoring()) return;
    snapOutOfLinks();
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

  // ---------- checklists ----------
  // A checklist item's box is drawn in the gutter left of the item (its ::before): a click there
  // checks or unchecks it, as an edit of its own.
  surface.addEventListener("mousedown", (ev) => {
    const li = (ev.target as HTMLElement).closest ? ((ev.target as HTMLElement).closest("li") as HTMLElement | null) : null;
    if (!li || !surface.contains(li) || !li.parentElement || !li.parentElement.hasAttribute(CHECK_ATTR)) return;
    if (ev.clientX >= li.getBoundingClientRect().left) return;
    ev.preventDefault();
    // Read-only (someone else is editing the note): the boxes stay as they are.
    if (!surface.isContentEditable) return;
    pushHistory();
    li.toggleAttribute("data-checked");
    const n = currentNote();
    if (n) n.html = editorHtml();
    scheduleSave();
  });
  // Enter in a checked item: Chrome copies the item, checked, to the new one. The new one (the empty
  // one of the two, or the second half of an item split in the middle) starts unchecked.
  function uncheckNewItem() {
    const sel = window.getSelection();
    const node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    const el = node ? (node.nodeType === 3 ? node.parentElement : (node as HTMLElement)) : null;
    const li = el ? (el.closest("li") as HTMLElement | null) : null;
    if (!li || !li.parentElement || !li.parentElement.hasAttribute(CHECK_ATTR)) return;
    const prev = li.previousElementSibling as HTMLElement | null;
    const empty = (x: HTMLElement) => !(x.textContent || "").replace(/[\s\u200b]/g, "") && !x.querySelector(".note-pill");
    if (prev && prev.tagName === "LI" && empty(prev) && !empty(li)) prev.removeAttribute("data-checked");
    else li.removeAttribute("data-checked");
  }

  // ---------- links: "[[" opens a picker of the room's notes ----------
  // Typing "[[" starts a link: what follows filters the notes, ↑/↓ pick, Enter or Tab (or a click)
  // puts the link in place of the "[[…" typed, Escape (or moving away) leaves the text as it is.
  // One picker for the panel, reused by each editor built (one per note shown).
  const linkPicker = (panel.querySelector(".link-picker") as HTMLElement | null) || panel.appendChild(Object.assign(document.createElement("div"), { className: "link-picker" }));
  linkPicker.hidden = true;
  let pickerList: Note[] = [];
  let pickerIndex = 0;
  let pickerDismissed: Text | null = null;
  // The "[[" query at the caret: its text node, where the "[[" starts, and what follows it.
  function linkQuery(): { node: Text; start: number; end: number; q: string } | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || !surface.contains(node)) return null;
    const before = (node as Text).data.slice(0, sel.anchorOffset);
    const at = before.lastIndexOf("[[");
    if (at < 0) return null;
    const q = before.slice(at + 2).replace(/\u00a0/g, " ");
    if (/[\[\]\n]/.test(q) || q.length > 60) return null;
    return { node: node as Text, start: at, end: sel.anchorOffset, q };
  }
  function closeLinkPicker() {
    linkPicker.hidden = true;
    pickerList = [];
  }
  function updateLinkPicker() {
    const query = linkQuery();
    if (!query || query.node === pickerDismissed) {
      if (!query) pickerDismissed = null;
      closeLinkPicker();
      return;
    }
    const s = strings();
    const q = query.q.trim().toLowerCase();
    pickerList = pool()
      .filter((n) => n.id !== noteId && (!q || (n.title || s.untitled).toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    pickerIndex = Math.min(pickerIndex, Math.max(0, pickerList.length - 1));
    linkPicker.innerHTML = "";
    const head = document.createElement("div");
    head.className = "link-picker-head";
    head.textContent = s.linkPickerTitle;
    linkPicker.appendChild(head);
    if (!pickerList.length) {
      const empty = document.createElement("div");
      empty.className = "link-picker-empty";
      empty.textContent = s.linkPickerEmpty;
      linkPicker.appendChild(empty);
    }
    const list = document.createElement("div");
    list.className = "link-picker-list";
    linkPicker.appendChild(list);
    pickerList.forEach((n, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "link-picker-item" + (i === pickerIndex ? " active" : "");
      item.textContent = n.title || s.untitled;
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        chooseLink(n);
      });
      list.appendChild(item);
    });
    // Below the caret, as tall as the panel leaves room for (scrolling past that); above it when
    // there's clearly more room there.
    linkPicker.hidden = false;
    linkPicker.style.maxHeight = "";
    const caret = document.createRange();
    caret.setStart(query.node, query.end);
    const rect = caret.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const box = linkPicker.getBoundingClientRect();
    const below = p.bottom - rect.bottom - 10;
    const above = rect.top - p.top - 10;
    const up = box.height > below && above > below;
    const room = Math.max(up ? above : below, 80);
    linkPicker.style.maxHeight = `${room}px`;
    const height = Math.min(box.height, room);
    linkPicker.style.left = `${Math.max(4, Math.min(rect.left - p.left, p.width - box.width - 4))}px`;
    linkPicker.style.top = `${up ? rect.top - p.top - 4 - height : rect.bottom - p.top + 4}px`;
    linkPicker.querySelector(".link-picker-item.active")?.scrollIntoView({ block: "nearest" });
  }
  function chooseLink(n: Note) {
    const query = linkQuery();
    closeLinkPicker();
    if (!query) return;
    startEditStep();
    const r = document.createRange();
    r.setStart(query.node, query.start);
    r.setEnd(query.node, query.end);
    r.deleteContents();
    const link = linkElement(n.id, n.title || strings().untitled);
    const space = document.createTextNode("\u00a0");
    r.insertNode(space);
    r.insertNode(link);
    const sel = window.getSelection()!;
    sel.collapse(space, 1);
    surface.dispatchEvent(new Event("input"));
  }
  // The picker's keys, while it's open. Returns whether it took the key.
  function linkPickerKey(ev: KeyboardEvent): boolean {
    if (linkPicker.hidden) return false;
    if (ev.key === "Escape") {
      pickerDismissed = linkQuery()?.node || null;
      closeLinkPicker();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!pickerList.length) return false;
      pickerIndex = (pickerIndex + (ev.key === "ArrowDown" ? 1 : -1) + pickerList.length) % pickerList.length;
      linkPicker.querySelectorAll(".link-picker-item").forEach((el, i) => el.classList.toggle("active", i === pickerIndex));
      linkPicker.querySelector(".link-picker-item.active")?.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      if (!pickerList.length) return false;
      chooseLink(pickerList[pickerIndex]);
    } else {
      return false;
    }
    ev.preventDefault();
    ev.stopPropagation();
    return true;
  }
  // Moving the caret away from the "[[…" closes it; clicking a link shows its bubble.
  surface.addEventListener("click", (ev) => {
    onLinkClick(ev);
    if (!linkPicker.hidden && !linkQuery()) closeLinkPicker();
  });
  surface.addEventListener("blur", () => closeLinkPicker());

  // ---------- Markdown shortcuts ----------
  // Typed at the very start of a plain paragraph (not a heading, quote, list item or cell), a
  // Markdown marker followed by a space turns the paragraph into that block: "- " or "* " bullets,
  // "1. " numbered, "[] " or "[ ] " a checklist, "# " to "#### " headings (#### a toggle), "> " a
  // quote; "---" and Enter, a divider. The marker goes; whatever followed it stays, in the new block.
  // The conversion is an undo step of its own, so Ctrl+Z right after brings the marker back as text.
  const SHORTCUTS: [RegExp, "UL" | "OL" | "CHECK" | BlockTag][] = [
    [/^[-*] $/, "UL"],
    [/^1[.)] $/, "OL"],
    [/^\[ ?\] $/, "CHECK"],
    [/^# $/, "H1"],
    [/^## $/, "H2"],
    [/^### $/, "H3"],
    [/^#### $/, "H4"],
    [/^> $/, "BLOCKQUOTE"],
  ];
  // The plain top-level paragraph the (collapsed) caret is in, and the text before the caret.
  function caretParagraph(): { block: HTMLElement; before: string; range: Range } | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    const block = blockAt(r.startContainer);
    if (!block || block.tagName !== "P") return null;
    const head = document.createRange();
    head.setStart(block, 0);
    head.setEnd(r.startContainer, r.startOffset);
    return { block, before: head.toString().replace(/\u00a0/g, " ").replace(/\u200b/g, ""), range: head };
  }
  function markdownShortcut() {
    const at = caretParagraph();
    if (!at) return;
    const match = SHORTCUTS.find(([re]) => re.test(at.before));
    if (!match) return;
    const kind = match[1];
    // The marker, typed, is what Ctrl+Z goes back to.
    startEditStep();
    at.range.deleteContents();
    if (!at.block.hasChildNodes() || !(at.block.textContent || "").length) {
      if (!at.block.querySelector("br")) at.block.appendChild(document.createElement("br"));
    }
    placeCaretAtStart(at.block);
    secretSnapshot();
    if (kind === "UL" || kind === "OL" || kind === "CHECK") setListKind(kind);
    else setBlockType(kind);
    removeEditorNoise();
    const hid = guardSecret();
    const n = currentNote();
    if (n) n.html = editorHtml();
    scheduleSave();
    if (hid) pushSecretNow();
    updateEmptyState();
    updateToolbarState();
  }
  // "---" alone in a plain paragraph, then Enter: a divider there, and the caret on an empty line
  // after it.
  function dividerShortcut(): boolean {
    const at = caretParagraph();
    if (!at || at.before !== "---" || (at.block.textContent || "").replace(/\u200b/g, "") !== "---") return false;
    startEditStep();
    const hr = document.createElement("hr");
    if (at.block.hasAttribute(SECRET_ATTR)) hr.setAttribute(SECRET_ATTR, "");
    at.block.before(hr);
    at.block.innerHTML = "<br>";
    placeCaretAtStart(at.block);
    const n = currentNote();
    if (n) n.html = editorHtml();
    scheduleSave();
    updateEmptyState();
    updateToolbarState();
    return true;
  }

  // ---------- parts hidden from players (see secret.ts) ----------
  // Each line is hidden on its own: a block, or a list item (secretUnits). The GM sees hidden lines
  // boxed (lines hidden in a row share a box) with an eye beside each one: a click on it shows that
  // line again. Hovering a line that isn't hidden shows a fainter eye that hides it. The toolbar's
  // eye does the same for every line the selection is on. Settings can lock the eyes beside the text.
  const topBlocks = () => Array.prototype.slice.call(surface.children) as HTMLElement[];
  const isHidden = (el: Element) => el.hasAttribute(SECRET_ATTR);
  // The margin the eyes sit in is kept in every note the GM edits.
  surface.classList.add("has-secret");
  // A list item of the editor's lists (not of a table cell), holding `n`.
  function itemOf(n: Node): HTMLElement | null {
    const el = n.nodeType === 3 ? n.parentElement : (n as HTMLElement);
    const li = el && el.closest ? (el.closest("li") as HTMLElement | null) : null;
    return li && surface.contains(li) && !li.closest("td, th") ? li : null;
  }
  // The line (unit) holding a node: its list item, or its block.
  const holderOf = (n: Node): HTMLElement | null => itemOf(n) || blockAt(n);
  // The lines on screen: not inside a folded section.
  function shownUnits(): HTMLElement[] {
    return secretUnits(surface).filter((u) => {
      const top = blockAt(u) || u;
      return !top.hasAttribute("data-folded");
    });
  }
  function paintSecret() {
    drawSecret();
  }
  const secretLayer = document.getElementById(idPrefix + "SecretLayer") as HTMLElement;
  let secretFrame = 0;
  let eyeUnits: HTMLElement[] = [];
  function unitBox(el: Element, scroller: HTMLElement, base: DOMRect) {
    const r = el.getBoundingClientRect();
    return { top: r.top - base.top + scroller.scrollTop, bottom: r.bottom - base.top + scroller.scrollTop, left: r.left - base.left, right: r.right - base.left };
  }
  function drawSecret() {
    if (secretFrame) return;
    secretFrame = requestAnimationFrame(() => {
      secretFrame = 0;
      if (!surface.isConnected) return;
      const scroller = surface.parentElement as HTMLElement;
      const base = scroller.getBoundingClientRect();
      const units = shownUnits();
      type Run = { top: number; bottom: number; left: number; right: number };
      const runs: Run[] = [];
      let run: Run | null = null;
      eyeUnits = [];
      const eyes: string[] = [];
      const s = strings();
      const title = escapeHtml(secretEyeLocked ? s.secretEyeLocked : s.secretEyeShow);
      units.forEach((u) => {
        if (!isHidden(u)) {
          run = null;
          return;
        }
        const b = unitBox(u, scroller, base);
        if (run) {
          run.top = Math.min(run.top, b.top);
          run.bottom = Math.max(run.bottom, b.bottom);
          run.left = Math.min(run.left, b.left);
          run.right = Math.max(run.right, b.right);
        } else {
          run = { ...b };
          runs.push(run);
        }
        eyes.push(`<div class="secret-eye${secretEyeLocked ? "" : " clickable"}" data-unit="${eyeUnits.length}" title="${title}" style="top:${b.top + 2}px;left:EYE_LEFTpx"></div>`);
        eyeUnits.push(u);
      });
      // The eyes line up in the margin, right of the text.
      const eyeLeft = surface.getBoundingClientRect().right - base.left - 24;
      secretLayer.innerHTML =
        runs
          .map((b) => `<div class="secret-box" style="top:${b.top - 3}px;left:${b.left - 4}px;width:${b.right - b.left + 8}px;height:${b.bottom - b.top + 6}px"></div>`)
          .join("") + eyes.join("").split("EYE_LEFT").join(String(Math.round(eyeLeft)));
      secretLayer.appendChild(hoverEye);
      hoverEye.hidden = true;
    });
  }
  redrawSecret = drawSecret;
  // The eye that hides a line, shown while hovering it.
  const hoverEye = document.createElement("div");
  hoverEye.className = "secret-eye hover clickable";
  hoverEye.hidden = true;
  let hoverUnit: HTMLElement | null = null;
  // The margin right of the text, at a line's height: hovering there offers that line's eye (a
  // line already hidden has its own). Tracked on the scrolling area, so the pointer can move from
  // the margin onto the eye without it going away.
  const scrollArea = surface.parentElement as HTMLElement;
  let hoverFrame = 0;
  let hoverY = 0;
  let hoverX = 0;
  function hideHoverEye() {
    hoverEye.hidden = true;
    hoverUnit = null;
  }
  scrollArea.addEventListener("mousemove", (ev) => {
    hoverX = ev.clientX;
    hoverY = ev.clientY;
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const sr = surface.getBoundingClientRect();
      const inMargin = hoverX >= sr.right - 30 && hoverX <= sr.right + 2;
      if (secretEyeLocked || !inMargin || noSecrets()) {
        hideHoverEye();
        return;
      }
      const unit = shownUnits().find((u) => {
        const r = u.getBoundingClientRect();
        return hoverY >= r.top - 2 && hoverY <= r.bottom + 2;
      });
      if (!unit || isHidden(unit)) {
        hideHoverEye();
        return;
      }
      if (unit === hoverUnit && !hoverEye.hidden) return;
      hoverUnit = unit;
      const base = scrollArea.getBoundingClientRect();
      const b = unitBox(unit, scrollArea, base);
      hoverEye.title = strings().toolbar.secret;
      hoverEye.style.top = `${b.top + 2}px`;
      hoverEye.style.left = `${Math.round(sr.right - base.left - 24)}px`;
      hoverEye.hidden = false;
    });
  });
  scrollArea.addEventListener("mouseleave", hideHoverEye);
  // Marks or unmarks lines, as one edit. A collapsed heading takes the lines folded under it along:
  // they can't be seen to be picked one by one.
  function setHidden(picked: HTMLElement[], hide: boolean) {
    if (hide && noSecrets()) return;
    const units: HTMLElement[] = [];
    picked.forEach((u) => {
      units.push(u);
      if (u.parentElement === surface && u.hasAttribute("data-collapsed")) {
        for (let n = u.nextElementSibling as HTMLElement | null; n && n.hasAttribute("data-folded"); n = n.nextElementSibling as HTMLElement | null) {
          blockUnits(n).forEach((x) => { if (!units.includes(x)) units.push(x); });
        }
      }
    });
    pushHistory();
    units.forEach((u) => {
      if (hide) u.setAttribute(SECRET_ATTR, "");
      else u.removeAttribute(SECRET_ATTR);
    });
    secretBefore = null;
    paintSecret();
    const n = currentNote();
    if (n) n.html = editorHtml();
    scheduleSave();
    if (hide) pushSecretNow();
    updateToolbarState();
  }
  secretLayer.addEventListener("mousedown", (ev) => {
    // Keeps the caret (and focus) in the note.
    if ((ev.target as HTMLElement).closest(".secret-eye")) ev.preventDefault();
  });
  secretLayer.addEventListener("click", (ev) => {
    const eye = (ev.target as HTMLElement).closest(".secret-eye.clickable") as HTMLElement | null;
    if (!eye || secretEyeLocked) return;
    if (eye === hoverEye) {
      if (hoverUnit && surface.contains(hoverUnit)) setHidden([hoverUnit], true);
      hoverEye.hidden = true;
      hoverUnit = null;
      return;
    }
    const unit = eyeUnits[Number(eye.dataset.unit)];
    if (unit && surface.contains(unit)) setHidden([unit], false);
  });
  new ResizeObserver(drawSecret).observe(surface);
  // The lines the selection is on. A selection merely ending at the very start of a line, as a
  // triple-clicked line does, isn't on that one.
  function secretSelection(): HTMLElement[] {
    const sel = window.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!r || !surface.contains(r.commonAncestorContainer)) return [];
    if (r.collapsed) {
      const u = holderOf(r.startContainer);
      return u ? [u] : [];
    }
    return secretUnits(surface).filter((u) => {
      if (!r.intersectsNode(u)) return false;
      if (!u.contains(r.startContainer) && u.contains(r.endContainer)) {
        const before = document.createRange();
        before.setStart(u, 0);
        before.setEnd(r.endContainer, r.endOffset);
        if (before.toString().replace(/\u200b/g, "") === "" && !before.cloneContents().querySelector("hr, table, br")) return false;
      }
      return true;
    });
  }
  // The toolbar's eye: hides the lines the selection is on, or shows them if all of them are hidden.
  function toggleSecret() {
    const units = secretSelection();
    if (!units.length) return;
    setHidden(units, !units.every(isHidden));
  }
  // A public note whose hidden parts grew goes up right away, not after the usual wait: what was
  // just hidden shouldn't stay in front of the players for those seconds.
  function pushSecretNow() {
    const n = currentNote();
    if (n && n.public) void flushCloudSync();
  }
  // Edits must never make a hidden line public by accident. Before any edit that can move content
  // between lines (anything but typing at a caret), secretSnapshot() records what's hidden; after
  // it, guardSecret() hides whatever line now holds what was hidden: a hidden line merged into the
  // one before it, content moved into a list or out of one. Lines the edit created out of a
  // selection that touched something hidden (a list made from it, lines pasted into it) are hidden
  // too. Merging lines, Chrome rebuilds the text as new nodes, so a hidden line the edit removed is
  // also followed by its text: what of it the edit didn't delete, found in the line the caret ends up
  // in. It errs towards hiding: what it hides shows boxed, and its eye shows it again.
  const squash = (s: string) => s.replace(/[\s\u00a0\u200b]/g, "");
  let secretBefore: { units: HTMLElement[]; nodes: Node[]; top: Set<Element>; items: Set<Element>; touched: boolean; rest: Map<HTMLElement, string> } | null = null;
  function secretSnapshot() {
    const units = secretUnits(surface).filter(isHidden);
    const nodes: Node[] = [];
    units.forEach((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        // Line breaks and bare whitespace say nothing about where the content went.
        if (node.nodeType === 3 ? (node as Text).data.replace(/[\s\u200b]/g, "") !== "" : node.nodeName !== "BR") nodes.push(node);
      }
    });
    const sel = window.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const inEditor = !!r && surface.contains(r.commonAncestorContainer);
    const touched = inEditor && units.some((el) => r!.intersectsNode(el));
    // Each hidden line's text the edit can't delete: all of it, or what follows the selection when
    // the selection ends inside it (none when it ends after it).
    const rest = new Map<HTMLElement, string>();
    units.forEach((el) => {
      let text = el.textContent || "";
      if (inEditor && r!.intersectsNode(el)) {
        if (!el.contains(r!.endContainer)) return;
        const after = document.createRange();
        after.selectNodeContents(el);
        after.setStart(r!.endContainer, r!.endOffset);
        text = after.toString();
      }
      if (squash(text)) rest.set(el, squash(text));
    });
    const items = new Set<Element>(Array.prototype.slice.call(surface.querySelectorAll("li")) as Element[]);
    secretBefore = { units, nodes, top: new Set(topBlocks()), items, touched, rest };
  }
  // Returns whether it hid anything.
  function guardSecret(): boolean {
    const snap = secretBefore;
    secretBefore = null;
    if (!snap) return false;
    const hiddenNow = (n: Node): boolean => {
      const h = holderOf(n);
      return !!h && isHidden(h);
    };
    const hide = new Set<HTMLElement>();
    const consider = (n: Node) => {
      if (!n.isConnected || n === surface || !surface.contains(n)) return;
      if (hiddenNow(n)) return;
      const h = holderOf(n);
      if (h) hide.add(h);
    };
    snap.units.forEach(consider);
    snap.nodes.forEach(consider);
    const sel = window.getSelection();
    const caretUnit = sel && sel.rangeCount ? holderOf(sel.getRangeAt(0).startContainer) : null;
    if (caretUnit && !isHidden(caretUnit)) {
      const text = squash(caretUnit.textContent || "");
      snap.rest.forEach((rest, el) => {
        if (!el.isConnected && text.includes(rest)) hide.add(caretUnit);
      });
    }
    if (snap.touched) {
      topBlocks().forEach((el) => { if (!snap.top.has(el) && !hiddenNow(el)) hide.add(el); });
      (Array.prototype.slice.call(surface.querySelectorAll("li")) as HTMLElement[]).forEach((li) => {
        if (!snap.items.has(li) && !li.closest("td, th") && !isHidden(li)) hide.add(li);
      });
    }
    let hid = false;
    hide.forEach((el) => {
      // A list hides by its items.
      const targets = /^(UL|OL)$/.test(el.tagName) ? (Array.prototype.slice.call(el.querySelectorAll("li")) as HTMLElement[]) : [el];
      targets.forEach((t) => {
        if (t.tagName !== "LI" && !SECRET_TAGS.test(t.tagName)) return;
        if (isHidden(t)) return;
        t.setAttribute(SECRET_ATTR, "");
        hid = true;
      });
    });
    // A list carries no mark of its own (its items do), but Chrome's list commands copy a hidden
    // line's mark onto the list they make: it goes to the items, so none of them comes out shown.
    (Array.prototype.slice.call(surface.querySelectorAll("ul[data-secret], ol[data-secret]")) as HTMLElement[]).forEach((list) => {
      list.removeAttribute(SECRET_ATTR);
      (Array.prototype.slice.call(list.querySelectorAll("li")) as HTMLElement[]).forEach((li) => {
        if (isHidden(li)) return;
        li.setAttribute(SECRET_ATTR, "");
        hid = true;
      });
    });
    if (hid) paintSecret();
    return hid;
  }

  // Collapsible sections: see sections.ts.
  const sections = createSections({ surface, blockAt, onFoldChange: saveFoldState, onLayout: paintSecret });
  const { headingLevel, canExit, exitLevel, applyFolding, sectionStep, stepSection, sel0Block, toggleFold, guardFoldedMerge } = sections;
  // Every structural change (typing a new block, setBlockType's replacements, undo/redo, paste)
  // shows up as a childList change on the surface itself; applyFolding only touches attributes, so
  // it can't retrigger this.
  new MutationObserver(() => {
    tables.ensureTableExit();
    applyFolding();
  }).observe(surface, { childList: true });
  tables.normalizeTables();
  applyFolding();
  // A note broken before this repair existed (or by a path it doesn't cover yet) is fixed on opening
  // and saved right away — locally only, like the fold state: no new "edited" time, not marked for
  // the cloud. A fresh time would make this device's copy "newer" than an edit made on another
  // device that hasn't arrived here yet (cloud sync is last-write-wins), so merely opening a note
  // could overwrite that edit. The repaired version reaches the cloud with the next real edit.
  if (repairStructure() || linksSynced) {
    seed.html = editorHtml();
    if (!player) void persist();
  }

  // Collapsing/expanding is saved locally only: it neither bumps the note's "edited" time (which
  // would reorder the note list) nor marks it for cloud sync. The state rides along to the cloud
  // with the next real edit of the note.
  function saveFoldState() {
    const n = currentNote();
    if (n) {
      n.html = editorHtml();
      if (!player) void persist();
    }
  }
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
    const hasBlock = Array.prototype.some.call(surface.children, (el: Element) => /^(P|H[1-4]|BLOCKQUOTE|UL|OL|HR|DIV|TABLE)$/.test(el.tagName));
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
  surface.addEventListener("input", (ev) => {
    // Moving nodes mid-composition (accents, IME input) would cut it short; compositionend repairs.
    if (!(ev as InputEvent).isComposing) repairStructure();
    ensureBlockWrapper();
    if (pillAnchor && pillAnchor.data !== PILL_ANCHOR) releasePillAnchor();
    if ((ev as InputEvent).inputType === "insertParagraph") uncheckNewItem();
    if ((ev as InputEvent).inputType === "insertText" && (ev as InputEvent).data === " ") markdownShortcut();
    updateLinkPicker();
    const hid = guardSecret();
    drawSecret();
    const n = currentNote();
    if (n) n.html = editorHtml();
    updateEmptyState();
    scheduleWordCountUpdate();
    scheduleSave();
    if (hid) pushSecretNow();
  });
  surface.addEventListener("compositionend", () => {
    if (!repairStructure()) return;
    const n = currentNote();
    if (n) n.html = editorHtml();
    scheduleSave();
  });
  surface.addEventListener("keydown", (ev) => {
    snapOutOfLinks();
    if (linkPickerKey(ev)) return;
    const key = ev.key.toLowerCase();
    const isUndo = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && key === "z";
    const isRedo = (ev.ctrlKey || ev.metaKey) && (key === "y" || (ev.shiftKey && key === "z"));
    if (isUndo) { ev.preventDefault(); undo(); return; }
    if (isRedo) { ev.preventDefault(); redo(); return; }
    // Keys that replace a selection, over one reaching into a collapsed section: expand it first
    // (see sections.ts). Here too, not only in beforeinput: some of these keys have handlers below
    // that edit before the browser would.
    const replacesSelection = ev.key === "Enter" || ev.key === "Backspace" || ev.key === "Delete" || (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey);
    if (replacesSelection && sections.unfoldSelection()) { ev.preventDefault(); return; }
    // → at a pill's last character steps just outside it instead of skipping past the next
    // character, so there's a way to put the caret right after a pill (see pillEndingAtCaret).
    if (guardFoldedMerge(ev)) return;
    if (tables.handleEdgeKeys(ev)) return;
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
    if (tables.handleEnter(ev)) return;
    if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && dividerShortcut()) {
      ev.preventDefault();
      return;
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
        // The undo step starts here, before expanding, so undoing the Enter folds it back too.
        if (block.hasAttribute("data-collapsed")) { noteTyping(); block.removeAttribute("data-collapsed"); applyFolding(); }
      }
    }
    const plainArrow = !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    // ← / → across a pill's edges stop at both sides of each: inside and outside (see PILL_ANCHOR).
    if (ev.key === "ArrowRight" && plainArrow) {
      const edge = pillEdgeAtCaret();
      const at = pillAtAnchor();
      const starting = at ? null : pillStartingAtCaret();
      if (edge && edge.inside) { ev.preventDefault(); caretAfterPill(edge.pill); updateToolbarState(); }
      else if (at && at.kind === "before") { ev.preventDefault(); caretAtPillStart(at.pill); updateToolbarState(); }
      else if (starting) { ev.preventDefault(); caretAtPillStart(starting); updateToolbarState(); }
      else tables.handleArrowKeys(ev);
      return;
    }
    if (ev.key === "ArrowLeft" && plainArrow) {
      const at = pillAtAnchor();
      const afterFirst = at ? null : pillAfterFirstCharAtCaret();
      if (at && at.kind === "after") { ev.preventDefault(); caretAtPillEnd(at.pill); updateToolbarState(); }
      else if (at && at.kind === "start") { ev.preventDefault(); caretBeforePill(at.pill); updateToolbarState(); }
      else if (afterFirst) { ev.preventDefault(); caretAtPillStart(afterFirst); updateToolbarState(); }
      else tables.handleArrowKeys(ev);
      return;
    }
    // ↑ / ↓ in a table: to the cell above / below from a cell's first / last line (see tableEditor.ts).
    if (tables.handleArrowKeys(ev)) return;
    if (tables.handleTab(ev)) return;
    if (tables.handleMoveKeys(ev)) return;
    if (ev.key !== "Tab") return;
    if (!caretInList()) {
      // Out of lists, Tab / Shift+Tab move the line into / out of the sections around it. Where
      // there's nothing to step into or out of, Tab keeps its usual job (moving focus).
      const block = sel0Block();
      const dir = ev.shiftKey ? -1 : 1;
      if (!block || ev.ctrlKey || ev.metaKey || ev.altKey || sectionStep(block, dir) === null) return;
      ev.preventDefault();
      pushHistory();
      secretSnapshot();
      stepSection(block, dir);
      const hid = guardSecret();
      const n = currentNote();
      if (n) n.html = editorHtml();
      scheduleSave();
      if (hid) pushSecretNow();
      updateToolbarState();
      return;
    }
    ev.preventDefault();
    pushHistory();
    secretSnapshot();
    if (!(ev.shiftKey && outdentSelection())) runKeepingPills(() => document.execCommand(ev.shiftKey ? "outdent" : "indent", false, undefined));
    if (!ev.shiftKey) inheritChecklist();
    repairStructure();
    const hid = guardSecret();
    const n = currentNote();
    if (n) n.html = editorHtml();
    scheduleSave();
    if (hid) pushSecretNow();
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
  // Double-clicking empty space in the note (not on a line) opens a line there to write on. Below
  // the last line it's a line outside every section. In a gap between two lines it's an ordinary
  // line, in whatever section is there — so nothing after it moves — except that it leaves the
  // sections the next line closes anyway (a heading ends its level and deeper): there it lands
  // where that next line does, and never inside a folded section. Next to an empty line already
  // there, the caret just goes to that one instead of stacking another.
  surface.addEventListener("dblclick", (ev) => {
    if (ev.target !== surface || !surface.isContentEditable) return;
    const blocks = (Array.prototype.slice.call(surface.children) as HTMLElement[]).filter((b) => b.getClientRects().length);
    const y = ev.clientY;
    let next: HTMLElement | null = null;
    let prev: HTMLElement | null = null;
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return; // beside a line, not between lines
      if (r.top > y) { next = b; break; }
      prev = b;
    }
    const isEmptyLine = (b: HTMLElement | null) =>
      !!b && /^(P|DIV)$/.test(b.tagName) && !(b.textContent || "").replace(/​/g, "") && !b.querySelector("img, hr, input");
    ev.preventDefault();
    const reuse = next
      ? isEmptyLine(prev) ? prev : isEmptyLine(next) ? next : null
      : isEmptyLine(prev) && !prev!.hasAttribute("data-depth") ? prev : null;
    if (reuse) {
      placeCaretAtStart(reuse);
      updateToolbarState();
      return;
    }
    pushHistory();
    const line = document.createElement("p");
    line.innerHTML = "<br>";
    // Below the last line: after everything, hidden lines of a folded last section included.
    if (next) surface.insertBefore(line, next);
    else surface.appendChild(line);
    applyFolding();
    if (line.hasAttribute("data-depth") || line.hasAttribute("data-folded")) {
      const exit = !next ? 1 : headingLevel(next) || exitLevel(next);
      if (exit) {
        line.setAttribute("data-exit", String(exit));
        applyFolding();
      }
    }
    placeCaretAtStart(line);
    surface.dispatchEvent(new Event("input"));
    updateToolbarState();
  });

  // Whether the selection starts or ends in a list item. Read from the DOM: Chrome's own
  // queryCommandState said "not in a list" for some selections spanning nested items (a sub-item
  // to its own sub-item), so Shift+Tab there moved sections instead of outdenting.
  function caretInList(): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    const inItem = (n: Node) => {
      const el = n.nodeType === 3 ? n.parentElement : (n as HTMLElement);
      const li = el && (el.closest("li") as HTMLElement | null);
      return !!li && surface.contains(li) && !li.closest("td, th");
    };
    return inItem(r.startContainer) || inItem(r.endContainer);
  }
  // Whether the list menu's `kind` is "on" here: the selection is all list content, every selected
  // item in a list of that kind. (queryCommandState misread some nested selections.)
  function listIsOn(kind: ListKind): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const items = selectedItems(sel.getRangeAt(0));
    return items.length > 0 && onlyListsSelected() && items.every((li) => listKind(li.parentElement!) === kind);
  }
  function onlyListsSelected(): boolean {
    return getTouchedBlocks().every((b) => /^(UL|OL)$/.test(b.tagName) || (b.tagName === "BLOCKQUOTE" && !!b.querySelector("li")));
  }
  // The list menu: picking the kind the selection already is takes the list away (moving the items
  // as they are, see unlistSelection). A checklist is a bullet list marked data-check, so between
  // those two only the mark changes; anything else goes through Chrome's list commands (pills kept,
  // see runKeepingPills), and the lists the selection ends up in get the right mark.
  function setListKind(kind: ListKind) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    if (listIsOn(kind) && unlistSelection()) return;
    const items = selectedItems(sel.getRangeAt(0));
    const lists = Array.from(new Set(items.map((li) => li.parentElement!)));
    if (kind !== "OL" && items.length && onlyListsSelected() && lists.every((l) => l.tagName === "UL")) {
      lists.forEach((l) => l.toggleAttribute(CHECK_ATTR, kind === "CHECK"));
      return;
    }
    // Plain bullet lists for Chrome: it copies what it sees, and a checked item's gray would come
    // out as a fixed color on its text.
    lists.forEach((l) => l.removeAttribute(CHECK_ATTR));
    runKeepingPills(() => document.execCommand(kind === "OL" ? "insertOrderedList" : "insertUnorderedList", false, undefined));
    const after = window.getSelection();
    if (!after || !after.rangeCount) return;
    selectedItems(after.getRangeAt(0)).forEach((li) => li.parentElement!.toggleAttribute(CHECK_ATTR, kind === "CHECK"));
  }
  // A sub-list made inside a checklist (Tab, Increase indent) is a checklist too.
  function inheritChecklist() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    selectedItems(sel.getRangeAt(0)).forEach((li) => {
      const list = li.parentElement!;
      const outer = list.parentElement && list.parentElement.closest("ul, ol");
      if (list.tagName === "UL" && outer && outer.hasAttribute(CHECK_ATTR) && surface.contains(outer)) list.setAttribute(CHECK_ATTR, "");
    });
  }
  function updateEmptyState() {
    // No text AND no text-less structure (a list item, divider or quote), which the placeholder,
    // overlaid on the first line, would otherwise cover.
    const isEmpty = surface.textContent!.replace(/​/g, "").trim() === "" && !surface.querySelector("ul, ol, hr, blockquote, table");
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
    const cmds = ["bold", "italic", "underline", "strikeThrough"];
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
    // The list menu: lit while in any list, its item for the list's kind marked. Read from the DOM
    // (see caretInList).
    const listSel = window.getSelection();
    const listStart = listSel && listSel.rangeCount ? listSel.getRangeAt(0).startContainer : null;
    const listEl = listStart ? ((listStart.nodeType === 3 ? listStart.parentElement : (listStart as HTMLElement))?.closest("li") as HTMLElement | null) : null;
    const listTag = listEl && surface.contains(listEl) && !listEl.closest("td, th") ? listEl.parentElement!.tagName : "";
    document.getElementById(idPrefix + "ListPickerBtn")?.classList.toggle("active", !!listTag);
    document.querySelectorAll(`#${idPrefix}ListMenu button[data-cmd]`).forEach((b) => {
      const cmd = (b as HTMLElement).dataset.cmd;
      const kind = listEl && listTag ? listKind(listEl.parentElement!) : null;
      b.classList.toggle("active", (cmd === "insertUnorderedList" && kind === "UL") || (cmd === "insertOrderedList" && kind === "OL") || (cmd === "checkList" && kind === "CHECK"));
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

    const secretBtn = document.querySelector(`#${idPrefix}Toolbar button[data-cmd="toggleSecret"]`);
    if (secretBtn) {
      const units = secretSelection();
      const on = units.length > 0 && units.every((el) => el.hasAttribute(SECRET_ATTR));
      secretBtn.classList.toggle("active", on);
      secretBtn.setAttribute("aria-pressed", String(on));
    }

    // Block-level tools do nothing inside a table (see BLOCK_ONLY_CMDS), so they show as disabled.
    const inTable = tables.selectionInTable();
    const blockTools = [
      ...(Array.prototype.slice.call(document.querySelectorAll(`#${idPrefix}Toolbar > button[data-cmd]`)) as HTMLElement[])
        .filter((b) => BLOCK_ONLY_CMDS.has(b.dataset.cmd!)),
      document.getElementById(idPrefix + "BlockPickerBtn"),
      document.getElementById(idPrefix + "ListPickerBtn"),
      quoteColorBtnEl,
    ] as (HTMLElement | null)[];
    blockTools.forEach((b) => {
      if (!b) return;
      if (inTable) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    });
    tables.updateToolbarButton(inTable);
  }
}

// `force`: a player's editor is rebuilt even if it shows the note's current version.
function renderEditor(force = false) {
  updateBrandPill();
  if (isPlayerView()) {
    const active = getActive();
    if (active && active.editable) {
      const session = editorSession;
      // Their own edit coming back, or one to another note: this editor stays as it is.
      if (!force && session && session.player && session.noteId === active.id && (session.busy() || (session.html() === active.html && session.title() === active.title))) {
        session.refreshLock();
        return;
      }
      const sameNote = !!session && session.player && session.noteId === active.id;
      const prevScroll = sameNote ? editorPaneEl.querySelector(".editor-scroll")?.scrollTop ?? 0 : 0;
      shownShared = null;
      buildNoteEditor(editorPaneEl, "gm", active.id, () => renderList(), true);
      const scroller = editorPaneEl.querySelector(".editor-scroll");
      if (scroller && prevScroll) scroller.scrollTop = prevScroll;
      return;
    }
    renderSharedNote();
    return;
  }
  shownShared = null;
  const active = getActive();
  buildNoteEditor(editorPaneEl, "gm", active ? active.id : null, () => renderList());
}

// ---------- player view: the room's public notes, read-only ----------
function sharedEmptyMessage(): string {
  const s = strings();
  return sharedState === "error" ? s.sharedLoadError : sharedState === "loading" ? s.sharedLoading : s.sharedEmpty;
}
let stopSharedWatch: (() => void) | null = null;
function startSharedWatch() {
  stopSharedWatch?.();
  stopSharedWatch = null;
  sharedNotes = [];
  // No key: no GM has published anything in this room yet.
  sharedState = publicKey ? "loading" : "ready";
  if (publicKey) {
    stopSharedWatch = watchSharedNotes(
      publicKey,
      (copies) => {
        copies.forEach((c) => noteLockSeen(c.note.id, c.lock));
        sharedNotes = copies.map((c) => c.note);
        sharedState = "ready";
        if (!sharedNotes.some((n) => n.id === playerActiveId)) {
          const newest = sharedNotes.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
          playerActiveId = newest ? newest.id : null;
        }
        renderList();
        renderEditor();
      },
      (err) => {
        console.error("Notes: failed to load the public notes", err);
        sharedState = "error";
        renderList();
        renderEditor();
      }
    );
  }
}
function stopSharedView() {
  stopSharedWatch?.();
  stopSharedWatch = null;
  sharedNotes = [];
  playerActiveId = null;
}

// What the viewer shows, so a live update that changed nothing visible (another note, say) doesn't
// redraw it; and per note, the sections the player folded or unfolded, kept across the GM's edits.
let shownShared: { id: string; title: string; html: string; language: Language; links: string } | null = null;
const playerFolds = new Map<string, Map<string, boolean>>();
function headingKeys(surface: HTMLElement): [HTMLElement, string][] {
  const seen = new Map<string, number>();
  return (Array.prototype.slice.call(surface.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4")) as HTMLElement[]).map((h) => {
    const base = h.tagName + "|" + (h.textContent || "");
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return [h, base + "|" + n];
  });
}
function renderSharedNote() {
  if (editorSession) {
    endEditorSession();
    shownShared = null;
  }
  editorPaneEl.classList.remove("player-editor");
  const s = strings();
  const note = getActive();
  if (!note) {
    shownShared = null;
    editorPaneEl.innerHTML = `<div class="editor-empty">${escapeHtml(sharedEmptyMessage())}</div>`;
    return;
  }
  // Its links show the linked notes' titles, so a renamed (or unshared) one redraws it too.
  const links = linkedIds(note.html).map((id) => sharedNotes.find((n) => n.id === id)?.title ?? "\u0000").join("\u0001");
  if (shownShared && shownShared.id === note.id && shownShared.title === note.title && shownShared.html === note.html && shownShared.language === language && shownShared.links === links) return;
  const prevScroll = shownShared && shownShared.id === note.id ? editorPaneEl.querySelector(".editor-scroll")?.scrollTop ?? 0 : 0;
  editorPaneEl.innerHTML =
    `<div class="title-row"><div class="note-title-text"></div></div>` +
    `<div class="editor-scroll"><div class="editor-surface read-only"></div></div>`;
  editorPaneEl.querySelector(".note-title-text")!.textContent = note.title || s.untitled;
  const surface = editorPaneEl.querySelector(".editor-surface") as HTMLElement;
  // Already sanitized on arrival (watchSharedNotes).
  surface.innerHTML = note.html;
  // A link to a note that isn't shared (any more) is just its text, as the note's next upload will
  // have it anyway.
  surface.querySelectorAll(".note-link").forEach((l) => {
    if (!sharedNotes.some((n) => n.id === l.getAttribute(LINK_ATTR))) l.replaceWith(document.createTextNode(l.textContent || ""));
  });
  syncLinks(surface, (id) => {
    const target = sharedNotes.find((n) => n.id === id);
    return target ? { title: target.title, gone: false } : null;
  }, s.untitled);
  surface.addEventListener("click", onLinkClick);
  const folds = playerFolds.get(note.id);
  if (folds) {
    headingKeys(surface).forEach(([h, key]) => {
      const collapsed = folds.get(key);
      if (collapsed === true) h.setAttribute("data-collapsed", "");
      else if (collapsed === false) h.removeAttribute("data-collapsed");
    });
  }
  const sections = createSections({
    surface,
    blockAt: (node) => {
      let el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
      if (!el || el === surface || !surface.contains(el)) return null;
      while (el.parentElement && el.parentElement !== surface) el = el.parentElement;
      return el;
    },
    onFoldChange: () => {
      playerFolds.set(note.id, new Map(headingKeys(surface).map(([h, key]) => [key, h.hasAttribute("data-collapsed")])));
    },
  });
  sections.applyFolding();
  editorPaneEl.querySelector(".editor-scroll")!.scrollTop = prevScroll;
  shownShared = { id: note.id, title: note.title, html: note.html, language, links };
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
  if (itemPick) endItemPick();
  if (switcherDropdown.hidden) return;
  switcherDropdown.hidden = true;
  noteSwitcher.classList.remove("open");
  switcherTrigger.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown, true);
}
function onDocPointerDown(ev: Event) {
  if (!noteSwitcher.contains(ev.target as Node) && !rowMenu.contains(ev.target as Node)) closeDropdown();
}
function onDocKeydown(ev: KeyboardEvent) {
  // Escape in a note's or folder's rename only cancels it (the input's own handler): closing the
  // list would also blur the input, which saves the half-typed name.
  if ((ev.target as HTMLElement | null)?.classList?.contains("rename-input")) return;
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
    if (cloudSyncAvailable()) {
      updateCloudAccountUI(getCurrentUser());
      prepareCloudSync();
    }
  }
  settingsOverlay.hidden = false;
}
function closeSettings() {
  settingsOverlay.hidden = true;
}
document.getElementById("settingsBtn")!.addEventListener("click", openSettings);

// Each Settings section's explanation sits behind an "i" next to its title: shown on hover, on
// keyboard focus, or while clicked open (touch screens have no hover). The explanation keeps its
// element (and id), so whatever updates its text still does; it's only shown differently.
const settingsBody = document.querySelector("#settingsOverlay .settings-modal-body") as HTMLElement;
settingsBody.querySelectorAll(".settings-section > .cleanup-hint").forEach((hint) => {
  const section = hint.parentElement!;
  const label = section.querySelector(".settings-section-label");
  if (!label) return;
  const row = document.createElement("div");
  row.className = "settings-label-row";
  label.replaceWith(row);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "info-btn";
  btn.textContent = "i";
  btn.setAttribute("aria-describedby", hint.id);
  btn.setAttribute("aria-expanded", "false");
  row.append(label, btn);
  hint.classList.add("info-tip");
  hint.setAttribute("role", "tooltip");
  section.classList.add("has-info");
});
function closeInfoTips(except?: Element) {
  settingsBody.querySelectorAll(".settings-section.tip-open").forEach((s) => {
    if (s === except) return;
    s.classList.remove("tip-open");
    s.querySelector(".info-btn")?.setAttribute("aria-expanded", "false");
  });
}
settingsBody.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest(".info-btn");
  if (!btn) {
    closeInfoTips();
    return;
  }
  const section = btn.closest(".settings-section")!;
  closeInfoTips(section);
  const open = section.classList.toggle("tip-open");
  btn.setAttribute("aria-expanded", String(open));
});
document.getElementById("settingsBackdrop")!.addEventListener("click", closeSettings);
document.getElementById("settingsCloseBtn")!.addEventListener("click", closeSettings);

const exportFormatOverlay = document.getElementById("exportFormatOverlay") as HTMLElement;
document.getElementById("exportFormatBackdrop")!.addEventListener("click", closeExportFormatModal);
document.getElementById("exportFormatCloseBtn")!.addEventListener("click", closeExportFormatModal);
document.getElementById("exportFormatJsonBtn")!.addEventListener("click", () => chooseExportFormat("json"));
document.getElementById("exportFormatMdBtn")!.addEventListener("click", () => chooseExportFormat("markdown"));

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (!publishConfirmOverlay.hidden) closePublishConfirm();
  else if (!signOutOverlay.hidden) closeSignOutConfirm();
  else if (!exportFormatOverlay.hidden) closeExportFormatModal();
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
// Signed out, public notes can't be updated or taken down: with any shared, signing out asks first
// whether to unpublish them all, after sending what's still pending so they stay at their latest.
const signOutOverlay = document.getElementById("signOutOverlay") as HTMLElement;
function closeSignOutConfirm() {
  signOutOverlay.hidden = true;
}
document.getElementById("cloudSignOutBtn")!.addEventListener("click", async () => {
  const shared = publicNotes();
  if (!shared.length || !canPublish()) {
    void signOutCloud();
    return;
  }
  await flushCloudSync();
  const s = strings();
  document.getElementById("signOutHint")!.textContent = s.signOutPublicHint(shared.length);
  document.getElementById("signOutUnpublishBtn")!.textContent = s.signOutUnpublishBtn(shared.length);
  document.getElementById("signOutKeepBtn")!.textContent = s.signOutKeepBtn(shared.length);
  signOutOverlay.hidden = false;
});
document.getElementById("signOutBackdrop")!.addEventListener("click", closeSignOutConfirm);
document.getElementById("signOutCloseBtn")!.addEventListener("click", closeSignOutConfirm);
document.getElementById("signOutKeepBtn")!.addEventListener("click", () => {
  closeSignOutConfirm();
  void signOutCloud();
});
document.getElementById("signOutUnpublishBtn")!.addEventListener("click", async () => {
  closeSignOutConfirm();
  const shared = publicNotes();
  const updatedAt = Date.now();
  shared.forEach((n) => {
    delete n.public;
    n.updatedAt = updatedAt;
    markNoteDirty(n.id);
  });
  await Promise.all(shared.map((n) => unpublishNote(n.id)));
  // The account's own copies must say "private" too before signing out, or another of the GM's
  // devices would publish them again.
  await flushCloudSync();
  await persist();
  renderList();
  updateBrandPill();
  void signOutCloud();
});

// A new key for the room: whoever kept the old one (someone no longer in the room) stops seeing the
// public notes; everyone in the room picks up the new one and keeps seeing them.
document.getElementById("regenerateKeyBtn")!.addEventListener("click", async () => {
  if (!canPublish() || !window.confirm(strings().regenerateKeyConfirm)) return;
  try {
    applyPublicKey(await replacePublicKey());
  } catch (err) {
    console.error("Notes: failed to replace the room's public key", err);
    window.alert(strings().regenerateKeyError);
  }
});
document.getElementById("cloudSyncNowBtn")!.addEventListener("click", () => void flushCloudSync());

document.getElementById("secretEyeRow")!.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button[data-eye]") as HTMLElement | null;
  if (!b) return;
  const locked = b.dataset.eye === "locked";
  if (locked === secretEyeLocked) return;
  secretEyeLocked = locked;
  void setSecretEyeLocked(locked);
  updateSecretEyeButtons();
  if (redrawSecret) redrawSecret();
});
document.getElementById("itemLinksRow")!.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button[data-itemlinks]") as HTMLElement | null;
  if (!b) return;
  const on = b.dataset.itemlinks === "on";
  if (on === itemLinksEnabled) return;
  itemLinksEnabled = on;
  void setItemLinksEnabled(on);
  updateItemLinksButtons();
  if (linkedItemsRefresh) linkedItemsRefresh();
});
function updateItemLinksButtons() {
  document.getElementById("itemLinksOnBtn")!.classList.toggle("is-active", itemLinksEnabled);
  document.getElementById("itemLinksOffBtn")!.classList.toggle("is-active", !itemLinksEnabled);
}
function updateSecretEyeButtons() {
  document.getElementById("secretEyeClickBtn")!.classList.toggle("is-active", !secretEyeLocked);
  document.getElementById("secretEyeLockBtn")!.classList.toggle("is-active", secretEyeLocked);
}

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
  updateBrandPill();
  document.getElementById("publishConfirmTitle")!.textContent = s.publishConfirmTitle;
  document.getElementById("publishConfirmHint")!.textContent = s.publishConfirmHint;
  document.getElementById("publishConfirmBtn")!.textContent = s.publishConfirmBtn;
  document.getElementById("publishCancelBtn")!.textContent = s.publishCancelBtn;
  document.querySelectorAll("#settingsOverlay .info-btn").forEach((b) => {
    (b as HTMLElement).title = s.settingsInfo;
    b.setAttribute("aria-label", s.settingsInfo);
  });
  const publishConfirmCloseBtn = document.getElementById("publishConfirmCloseBtn")!;
  publishConfirmCloseBtn.title = s.settingsClose;
  publishConfirmCloseBtn.setAttribute("aria-label", s.settingsClose);

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
  document.getElementById("settingsHelpLabel")!.textContent = s.settingsHelpLabel;
  document.getElementById("helpHint")!.textContent = s.helpHint;
  document.getElementById("helpLink")!.textContent = s.helpLink;
  document.getElementById("settingsBackupLabel")!.textContent = s.settingsBackupLabel;
  document.getElementById("backupHint")!.textContent = s.backupHint;
  document.getElementById("exportAllBtn")!.textContent = s.exportAllBtn;
  document.getElementById("importBtn")!.textContent = s.importBtn;
  document.getElementById("clearAllBtn")!.textContent = s.clearAllBtn;
  document.getElementById("trashHeadTitle")!.textContent = s.trashTitle;
  const trashBackBtn = document.getElementById("trashBackBtn")!;
  trashBackBtn.title = s.trashBack;
  trashBackBtn.setAttribute("aria-label", s.trashBack);
  document.getElementById("trashEmptyBtn")!.textContent = s.trashEmptyBtn;
  document.getElementById("settingsCloudLabel")!.textContent = s.settingsCloudLabel;
  document.getElementById("cloudSyncHint")!.textContent = s.cloudSyncHint;
  document.getElementById("cloudSignInBtn")!.textContent = s.cloudSignInBtn;
  document.getElementById("cloudSignOutBtn")!.textContent = s.cloudSignOutBtn;
  document.getElementById("settingsItemLinksLabel")!.textContent = s.settingsItemLinksLabel;
  document.getElementById("itemLinksHint")!.textContent = s.itemLinksHint;
  document.getElementById("itemLinksOnBtn")!.textContent = s.itemLinksOnBtn;
  document.getElementById("itemLinksOffBtn")!.textContent = s.itemLinksOffBtn;
  document.getElementById("pickCancelBtn")!.textContent = s.itemPickCancel;
  updateItemLinksButtons();
  updatePickBanner();
  document.getElementById("settingsSecretLabel")!.textContent = s.settingsSecretLabel;
  document.getElementById("secretEyeHint")!.textContent = s.secretEyeHint;
  document.getElementById("secretEyeClickBtn")!.textContent = s.secretEyeClickBtn;
  document.getElementById("secretEyeLockBtn")!.textContent = s.secretEyeLockBtn;
  updateSecretEyeButtons();
  document.getElementById("settingsSharedLabel")!.textContent = s.settingsSharedLabel;
  document.getElementById("sharedKeyHint")!.textContent = s.sharedKeyHint;
  document.getElementById("regenerateKeyBtn")!.textContent = s.regenerateKeyBtn;
  document.getElementById("signOutTitle")!.textContent = s.signOutPublicTitle;
  const signOutCloseBtn = document.getElementById("signOutCloseBtn")!;
  signOutCloseBtn.title = s.settingsClose;
  signOutCloseBtn.setAttribute("aria-label", s.settingsClose);
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
  const DEFAULT_IFRAME_W = 439;
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
  const playerView = isPlayerView();
  // Without cloud sync there's nowhere for public notes to come from: players get the gate.
  document.getElementById("normalView")!.hidden = isPlayer && !playerView;
  document.getElementById("gmGate")!.hidden = !isPlayer || playerView;
  panel.classList.toggle("player-view", playerView);
  if (playerView) startSharedWatch();
  else stopSharedView();
  searchTerm = "";
  searchInput.value = "";
  renderList();
  renderEditor();
  if (isPlayer) {
    closeDropdown();
    closeTemplateMenu();
    closeSettings();
    closePublishConfirm();
    closeSignOutConfirm();
  }
  updateCloudAccountUI(getCurrentUser());
  updateBrandPill();
  reconcilePublicNotes();
}

// ---------- cloud sync: merging what Firestore has with what's local (see cloudSync.ts) ----------
// Last-write-wins per note, by `updatedAt` — a cloud copy only overwrites the local one when it's
// genuinely newer, so it can never clobber an edit this device made more recently than what's
// arriving. Re-rendering the editor when the ACTIVE note changes is a deliberate simplification: it
// mirrors how switching notes already re-renders from scratch, at the small cost of a visible refresh
// if a remote update happens to land in the same instant as active typing here.
// A note in the trash (deletedAt) goes to the trash here too, and one restored elsewhere comes back.
function mergeCloudNotes(cloudNotes: Note[], removedIds: string[]) {
  let listChanged = false;
  let activeNoteChanged = false;
  // Takes a note out of wherever it is here (the notes or the trash).
  const take = (id: string) => {
    const idx = notes.findIndex((n) => n.id === id);
    if (idx !== -1) {
      notes.splice(idx, 1);
      if (activeId === id) {
        activeId = notes.length ? notes[0].id : null;
        activeNoteChanged = true;
      }
    }
    trash = trash.filter((t) => t.id !== id);
  };
  // Deleted for good on another device: its map items here get unlinked too.
  if (removedIds.length) noteErased(removedIds);
  removedIds.forEach((id) => {
    if (!notes.some((n) => n.id === id) && !trash.some((t) => t.id === id)) return;
    take(id);
    listChanged = true;
  });
  cloudNotes.forEach((cloudNote) => {
    if (migrateSecretModel(cloudNote)) markNoteDirty(cloudNote.id);
    const local = notes.find((n) => n.id === cloudNote.id) || trash.find((t) => t.id === cloudNote.id);
    // Moving between folders isn't an edit: whichever side moved it last decides its folder, apart
    // from which side has the latest text.
    const movedHere = !!local && (local.folderAt ?? 0) > (cloudNote.folderAt ?? 0);
    const movedThere = !!local && (cloudNote.folderAt ?? 0) > (local.folderAt ?? 0);
    const placeFrom = (from: Note, to: Note) => {
      if (from.folderId) to.folderId = from.folderId;
      else delete to.folderId;
      if (typeof from.folderAt === "number") to.folderAt = from.folderAt;
    };
    if (local && movedHere) markNoteDirty(cloudNote.id);
    if (local && movedHere && cloudNote.updatedAt > local.updatedAt) placeFrom(local, cloudNote);
    if (local && movedThere && cloudNote.updatedAt <= local.updatedAt) {
      placeFrom(cloudNote, local);
      listChanged = true;
    }
    if (!local || cloudNote.updatedAt > local.updatedAt) {
      if (local) take(cloudNote.id);
      if (typeof cloudNote.deletedAt === "number") trash.push(cloudNote);
      else notes.push(cloudNote);
      listChanged = true;
      if (activeId === cloudNote.id) activeNoteChanged = true;
    } else if (cloudNote.updatedAt < local.updatedAt) {
      // Changed here while signed out (or before the last push went through): the account's copy is
      // behind, so it goes up now. Otherwise another device would keep the old version, and with it,
      // say, a note still public that was unpublished here.
      markNoteDirty(cloudNote.id);
    }
  });
  if (purgeExpiredTrash()) listChanged = true;
  if (!listChanged) return;
  void persist();
  renderList();
  if (activeNoteChanged) renderEditor();
}

let stopCloudWatch: (() => void) | null = null;
let stopTemplateWatch: (() => void) | null = null;
let stopFolderWatch: (() => void) | null = null;
function applyCloudAuthState(user: User | null) {
  stopCloudWatch?.();
  stopCloudWatch = null;
  stopFolderWatch?.();
  stopFolderWatch = null;
  stopTemplateWatch?.();
  stopTemplateWatch = null;
  if (user && currentRoomIdForCloud) {
    // Public copies wait for the account's notes: until then this device may be missing some.
    stopCloudWatch = watchCloudNotes(currentRoomIdForCloud, mergeCloudNotes, reconcilePublicNotes);
    // Only once the stored ones are read: before that, the local list would look empty.
    if (foldersLoaded) {
      stopFolderWatch = watchCloudFolders(
        currentRoomIdForCloud,
        () => folders,
        (next) => {
          folders = next;
          void persist();
          renderList();
        },
        {
          ids: () => erasedFolders,
          settled: (ids) => {
            ids.forEach((id) => erasedFolders.delete(id));
            saveErasedFolders();
          },
        }
      );
    }
  }
  followOwnShared();
  // A public note can be edited only signed in.
  editorSession?.refreshLock();
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
  updateBrandPill();
}
let currentRoomIdForCloud: string | null = null;

// ---------- boot ----------
async function boot() {
  const [initialNotes, initialLanguage, initialAccent, initialRole, initialEyeLocked, initialItemLinks, initialSort] = await Promise.all([
    getNotes(),
    getLanguage(),
    getAccentPref(),
    OBR.player.getRole(),
    getSecretEyeLocked(),
    getItemLinksEnabled(),
    getNoteSort(),
  ]);
  secretEyeLocked = initialEyeLocked;
  itemLinksEnabled = initialItemLinks;
  noteSort = initialSort;
  notes = initialNotes;
  try {
    folders = await getFolders();
    foldersLoaded = true;
    foldedFolders = new Set(await getFoldedFolders());
    erasedFolders = new Set(await getErasedFolders());
  } catch (err) {
    console.error("Notes: failed to load the folders", err);
  }
  try {
    trash = await getTrash();
    erased = new Set(await getErased());
  } catch (err) {
    console.error("Notes: failed to load the trash", err);
  }
  if (purgeExpiredTrash()) void persist();
  // Notes from before each line was hidden on its own (see secret.ts): converted once, keeping what
  // players see the same. Saved locally; the cloud copy carries the conversion (same edit time, so
  // no other device takes it for a newer version).
  const converted = [...notes, ...trash].filter(migrateSecretModel);
  if (converted.length) {
    converted.forEach((n) => markNoteDirty(n.id));
    void persist();
  }
  try {
    publicKey = await getPublicKey();
  } catch (err) {
    console.error("Notes: failed to read the room's public key", err);
  }
  setSharedKey(publicKey);
  language = initialLanguage;
  accentPref = initialAccent;
  role = initialRole;
  try {
    playerName = await OBR.player.getName();
  } catch (err) {
    console.error("Notes: failed to read the player's name", err);
  }
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
    startCloudSync(currentRoomIdForCloud, (id) => notes.find((n) => n.id === id) || trash.find((t) => t.id === id), updateSyncIndicator, applyCloudAuthState);
  }

  watchPublicKey(applyPublicKey);

  OBR.player.onChange((player) => {
    playerName = player.name;
    if (player.role !== role) {
      role = player.role;
      applyRoleView();
      followOwnShared();
    }
  });

  // Linked items: a request from the context menu (see itemLinks.ts), now or whenever it comes;
  // the chip follows the scene being there.
  OBR.broadcast.onMessage(ITEM_LINK_CHANNEL, (event) => {
    const message = event.data as ItemLinkMessage;
    if (message.type === "request" && isFreshRequest(message.request)) receiveItemLinkRequest(message.request);
  });
  checkItemLinkRequest();
  window.addEventListener("storage", (ev) => {
    if (isItemLinkRequestKey(ev.key) && ev.newValue) checkItemLinkRequest();
  });
  OBR.action.onOpenChange((open) => {
    if (open) checkItemLinkRequest();
  });
  OBR.scene.onReadyChange((ready) => {
    if (ready) void unlinkErasedInScene();
    if (linkedItemsRefresh) linkedItemsRefresh();
  });
  void unlinkErasedInScene();
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
