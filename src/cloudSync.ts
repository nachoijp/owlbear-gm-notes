import { initializeApp, type FirebaseApp } from "firebase/app";
import { sanitizeNoteHtml } from "./sanitizeHtml";
import { stripSecret, SECRET_ATTR } from "./secret";
import { lockHolder, lockLapsesIn, type LockInfo } from "./editLock";
import { publicLinks } from "./noteLinks";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  signOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  serverTimestamp,
  runTransaction,
  Timestamp,
  type DocumentData,
  collection,
  onSnapshot,
  getDocs,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import { firebaseConfig, hasFirebaseConfig } from "./firebaseConfig";
import { sanitizePlayerBase, type Note } from "./notes";

// Cloud sync is a purely optional, additional copy of a room's notes — IndexedDB (see notes.ts)
// stays the source of truth for THIS device and works with no sign-in at all. When signed in, notes
// also get pushed to Firestore under the signed-in Google account, letting the SAME account pull
// them back down on another device. Firestore Security Rules (see the project's setup notes) scope
// every document to `request.auth.uid` — the Google account IS the privacy boundary here, not
// Owlbear's own GM/player roles, which Firestore has no way to know about.
//
// Conflict handling is deliberately simple: last-write-wins, per note, by `updatedAt`. Editing the
// SAME note on two devices while both are offline means whichever syncs last overwrites the other —
// there's no merge. For the realistic case (one GM, one device at a time, occasionally switching)
// this never comes up; it's a real, accepted limitation for the rare case where it would.

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

export function cloudSyncAvailable(): boolean {
  return hasFirebaseConfig();
}

function ensureInitialized(): { auth: Auth; db: Firestore } | null {
  if (!hasFirebaseConfig()) return null;
  if (!app) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  }
  return { auth: auth!, db: db! };
}

// Players who edit a note get an anonymous account (see ensureEditorUser): an identity for the
// Security Rules, nothing more. For everything else here, that's nobody signed in.
function accountOf(user: User | null): User | null {
  return user && !user.isAnonymous ? user : null;
}
export function getCurrentUser(): User | null {
  const init = ensureInitialized();
  return init ? accountOf(init.auth.currentUser) : null;
}

export function onAuthChange(callback: (user: User | null) => void): () => void {
  const init = ensureInitialized();
  if (!init) return () => {};
  return onAuthStateChanged(init.auth, (user) => callback(accountOf(user)));
}

export async function signInWithGoogle(): Promise<void> {
  const init = ensureInitialized();
  if (!init) return;
  await signInWithPopup(init.auth, new GoogleAuthProvider());
}

export async function signOutCloud(): Promise<void> {
  const init = ensureInitialized();
  if (!init) return;
  await signOut(init.auth);
}

export type SyncStatus = "off" | "idle" | "pending" | "syncing" | "synced" | "error";

let status: SyncStatus = "off";
const statusListeners = new Set<(status: SyncStatus) => void>();
function setStatus(next: SyncStatus) {
  status = next;
  statusListeners.forEach((cb) => cb(status));
}
export function getSyncStatus(): SyncStatus {
  return status;
}
export function onSyncStatusChange(callback: (status: SyncStatus) => void): () => void {
  statusListeners.add(callback);
  return () => statusListeners.delete(callback);
}

/** For other sync modules (see templateSync.ts): the Firestore handle and signed-in user, or null
 * when cloud sync is unavailable or nobody is signed in. */
export function cloudContext(): { db: Firestore; user: User } | null {
  const init = ensureInitialized();
  const user = init ? accountOf(init.auth.currentUser) : null;
  return init && user ? { db: init.db, user } : null;
}

/** Lets other sync modules surface a failure on the same cloud indicator notes use. */
export function reportCloudSyncError() {
  setStatus("error");
}

function roomNoteDoc(uid: string, roomId: string, noteId: string) {
  return doc(db!, "users", uid, "rooms", roomId, "notes", noteId);
}
function roomNotesCollection(uid: string, roomId: string) {
  return collection(db!, "users", uid, "rooms", roomId, "notes");
}

// Per-note dirty tracking: markDirty() records WHICH note changed and (re)starts a single shared
// debounce; the debounce reads each dirty note's CURRENT content only when it actually fires (via
// getNoteById, supplied by main.ts), not at schedule time — so several edits to the same note during
// one debounce window still cost exactly one Firestore write, always with the latest content.
let dirtyIds = new Set<string>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let getNoteById: ((id: string) => Note | undefined) | null = null;
let currentRoomId: string | null = null;
const SYNC_DEBOUNCE_MS = 15000;

export function initCloudSyncContext(roomId: string, lookup: (id: string) => Note | undefined) {
  currentRoomId = roomId;
  getNoteById = lookup;
}

// ---------- public notes: shared/{key}/notes/{noteId}, readable by anyone with the room's key ----------
// A public note gets a second copy there (see publicKey.ts for the key), tagged with its author's
// uid: the Security Rules let only that account change or delete it, so several GMs in one room each
// manage their own. Edits reach it on the same debounce as the private copy; publishing and
// unpublishing go straight away.
let sharedKey: string | null = null;
export function setSharedKey(key: string | null) {
  sharedKey = key;
}

function sharedNoteDoc(key: string, noteId: string) {
  return doc(db!, "shared", key, "notes", noteId);
}
// The public copy: the note minus its hidden parts, which never leave the GM's own copies, and with
// links only to notes players can see (the others are just their titles, see noteLinks.ts).
// An editable note is the players' too: it comes back from them whole, so it goes up whole. It has
// no hidden parts (a stray mark is dropped, its line shown), and its links to private notes stay
// links, which players see as plain text (an id is all they carry beyond the title).
function sharedNoteData(note: Note, uid: string) {
  if (note.editable) {
    return { title: note.title, html: unmarkSecret(note.html), updatedAt: note.updatedAt, owner: uid, editable: true, editedBy: { uid, name: "" } };
  }
  const html = publicLinks(stripSecret(note.html), (id) => {
    const target = getNoteById ? getNoteById(id) : undefined;
    return target && typeof target.deletedAt !== "number" ? { title: target.title, public: !!target.public } : null;
  });
  return { title: note.title, html, updatedAt: note.updatedAt, owner: uid };
}
function unmarkSecret(html: string): string {
  if (!html.includes(SECRET_ATTR)) return html;
  const box = document.createElement("div");
  box.innerHTML = html;
  box.querySelectorAll("[" + SECRET_ATTR + "]").forEach((el) => el.removeAttribute(SECRET_ATTR));
  return box.innerHTML;
}
// The version of each public copy last written from here ("key/noteId" → updatedAt): the flush that
// follows a publish finds it already up and skips it.
const sharedVersions = new Map<string, number>();
async function writeSharedNote(key: string, note: Note, uid: string) {
  if (!note.editable) {
    await setDoc(sharedNoteDoc(key, note.id), sharedNoteData(note, uid));
    sharedVersions.set(key + "/" + note.id, note.updatedAt);
    return;
  }
  // An editable note: never over a player who's editing it, nor over a newer version of theirs
  // (that reaches this device first, see watchOwnSharedNotes). The lock stays as it is.
  if (lockHolder(note.id, uid)) {
    retryShared(note.id, lockLapsesIn(note.id, uid) + 1000);
    return;
  }
  const ref = sharedNoteDoc(key, note.id);
  await runTransaction(db!, async (tx) => {
    const remote = await tx.get(ref);
    const at = remote.exists() ? remote.data().updatedAt : -1;
    // Already there, or behind the players' (nothing of this version left to send).
    if (remote.exists() && remote.data().editable === true && typeof at === "number" && at >= note.updatedAt) return;
    tx.set(ref, sharedNoteData(note, uid), { merge: true });
  });
  sharedVersions.set(key + "/" + note.id, note.updatedAt);
}
// A write held back by a player's lock tries again once it has lapsed (or been let go sooner).
const retries = new Map<string, ReturnType<typeof setTimeout>>();
function retryShared(noteId: string, delay: number) {
  if (retries.has(noteId)) return;
  retries.set(
    noteId,
    setTimeout(() => {
      retries.delete(noteId);
      markNoteDirty(noteId);
    }, delay)
  );
}

/** Puts (or refreshes) a note's public copy. Rejects when it can't: nobody signed in, no key. */
export async function publishNote(note: Note): Promise<void> {
  const init = ensureInitialized();
  const user = init ? accountOf(init.auth.currentUser) : null;
  if (!init || !user || !sharedKey) throw new Error("Notes: can't publish without an account and a key");
  await writeSharedNote(sharedKey, note, user.uid);
}

/** Takes a note's public copy down. Only for a note that has one: deleting a missing document is
 * refused by the rules (there's no owner to check). */
export async function unpublishNote(noteId: string): Promise<void> {
  const init = ensureInitialized();
  const user = init ? accountOf(init.auth.currentUser) : null;
  if (!init || !user || !sharedKey) return;
  sharedVersions.delete(sharedKey + "/" + noteId);
  try {
    await deleteDoc(sharedNoteDoc(sharedKey, noteId));
  } catch (err) {
    console.error("Notes: failed to unpublish note", noteId, err);
    setStatus("error");
  }
}

/** A shared copy as read back: the note (sanitized), its lock, and who wrote it last. */
export interface SharedCopy {
  note: Note;
  owner: string;
  lock: LockInfo | null;
  editedBy: string | null;
}
function readSharedCopy(id: string, data: DocumentData): SharedCopy {
  const lock = data.lock as { uid?: unknown; name?: unknown; at?: unknown } | undefined;
  const at = lock && lock.at instanceof Timestamp ? lock.at.toMillis() : Date.now();
  const editedBy = data.editedBy as { uid?: unknown } | undefined;
  return {
    note: {
      id,
      title: typeof data.title === "string" ? data.title : "",
      html: typeof data.html === "string" ? sanitizeNoteHtml(data.html) : "",
      updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
      public: true,
      ...(data.editable === true ? { editable: true } : {}),
    },
    owner: typeof data.owner === "string" ? data.owner : "",
    lock: lock && typeof lock.uid === "string" ? { uid: lock.uid, name: typeof lock.name === "string" ? lock.name : "", at } : null,
    editedBy: editedBy && typeof editedBy.uid === "string" ? editedBy.uid : null,
  };
}

/** A player's live view of the room's public notes: every note under `key`, whole, on each change.
 * No account needed to read. */
export function watchSharedNotes(key: string, onChange: (copies: SharedCopy[]) => void, onError: (err: unknown) => void): () => void {
  const init = ensureInitialized();
  if (!init) {
    onError(new Error("Notes: Firebase isn't configured"));
    return () => {};
  }
  return onSnapshot(
    collection(init.db, "shared", key, "notes"),
    (snapshot) => onChange(snapshot.docs.map((d) => readSharedCopy(d.id, d.data({ serverTimestamps: "estimate" })))),
    onError
  );
}

/** The GM's side of their editable notes: this account's copies under `key`, on each change, so
 * the players' edits (and locks) reach the GM's own notes. */
export function watchOwnSharedNotes(key: string, onChange: (copies: SharedCopy[]) => void): () => void {
  const init = ensureInitialized();
  const user = init ? accountOf(init.auth.currentUser) : null;
  if (!init || !user) return () => {};
  return onSnapshot(
    query(collection(init.db, "shared", key, "notes"), where("owner", "==", user.uid)),
    (snapshot) => onChange(snapshot.docs.map((d) => readSharedCopy(d.id, d.data({ serverTimestamps: "estimate" })))),
    (err) => console.error("Notes: failed to follow the shared notes", err)
  );
}

// ---------- editing a shared note: the lock, and the edits (see editLock.ts) ----------
// The GM edits with their account; a player, with an anonymous one made on their first edit.
async function ensureEditorUser(): Promise<User> {
  const init = ensureInitialized();
  if (!init) throw new Error("Notes: Firebase isn't configured");
  return init.auth.currentUser ?? (await signInAnonymously(init.auth)).user;
}
/** Who edits from here (the account, or a player's anonymous one), if anyone yet. */
export function editorUid(): string | null {
  const init = ensureInitialized();
  return init && init.auth.currentUser ? init.auth.currentUser.uid : null;
}
/** Takes (or renews) a note's lock. False when someone else holds it, or it can't be reached. */
export async function takeSharedLock(noteId: string, name: string): Promise<boolean> {
  if (!sharedKey) return false;
  try {
    const user = await ensureEditorUser();
    await updateDoc(sharedNoteDoc(sharedKey, noteId), { lock: { uid: user.uid, name, at: serverTimestamp() } });
    return true;
  } catch (err) {
    console.warn("Notes: couldn't take the note's lock", err);
    return false;
  }
}
/** Writes an edit, renewing the lock with it. False when the lock was lost meanwhile. */
export async function saveSharedEdit(noteId: string, edit: { title: string; html: string; updatedAt: number }, name: string): Promise<boolean> {
  if (!sharedKey) return false;
  try {
    const user = await ensureEditorUser();
    await updateDoc(sharedNoteDoc(sharedKey, noteId), {
      title: edit.title,
      html: unmarkSecret(edit.html),
      updatedAt: edit.updatedAt,
      editedBy: { uid: user.uid, name },
      lock: { uid: user.uid, name, at: serverTimestamp() },
    });
    sharedVersions.set(sharedKey + "/" + noteId, edit.updatedAt);
    return true;
  } catch (err) {
    console.warn("Notes: couldn't save the shared note", err);
    return false;
  }
}
export async function releaseSharedLock(noteId: string): Promise<void> {
  if (!sharedKey) return;
  try {
    await updateDoc(sharedNoteDoc(sharedKey, noteId), { lock: deleteField() });
  } catch (err) {
    console.warn("Notes: couldn't let the note's lock go", err);
  }
}

/** Makes this account's public copies under `key` exactly `wanted()`: removes the ones no longer
 * public (unpublished or deleted while signed out, or every one under a key that's been replaced),
 * and writes the ones missing or older than here. `wanted` is read once the copies are fetched, so a
 * note published meanwhile counts. */
export async function reconcileSharedNotes(key: string, wanted: () => Note[]): Promise<void> {
  const init = ensureInitialized();
  const user = init ? accountOf(init.auth.currentUser) : null;
  if (!init || !user) return;
  try {
    const snapshot = await getDocs(query(collection(init.db, "shared", key, "notes"), where("owner", "==", user.uid)));
    const remote = new Map<string, number>();
    snapshot.forEach((d) => {
      const updatedAt = d.data().updatedAt;
      remote.set(d.id, typeof updatedAt === "number" ? updatedAt : 0);
    });
    const notes = wanted();
    const wantedIds = new Set(notes.map((n) => n.id));
    await Promise.all([
      ...Array.from(remote.keys())
        .filter((id) => !wantedIds.has(id))
        .map((id) => {
          sharedVersions.delete(key + "/" + id);
          return deleteDoc(sharedNoteDoc(key, id));
        }),
      ...notes
        .filter((n) => (remote.get(n.id) ?? -1) < n.updatedAt)
        .map((n) => writeSharedNote(key, n, user.uid)),
    ]);
  } catch (err) {
    console.error("Notes: failed to bring public notes up to date", err);
    setStatus("error");
  }
}

/** Public notes whose copy has to go up again although they didn't change: a note they link to was
 * shared, unshared, renamed or deleted. */
export function refreshSharedCopies(ids: string[]) {
  ids.forEach((id) => {
    if (sharedKey) sharedVersions.delete(sharedKey + "/" + id);
    markNoteDirty(id);
  });
}

export function markNoteDirty(noteId: string) {
  if (!cloudSyncAvailable() || !getCurrentUser()) return;
  dirtyIds.add(noteId);
  setStatus("pending");
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void flushCloudSync(), SYNC_DEBOUNCE_MS);
}

export async function flushCloudSync(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const init = ensureInitialized();
  const user = init ? accountOf(init.auth.currentUser) : null;
  if (!init || !user || !currentRoomId || !getNoteById || !dirtyIds.size) return;
  const ids = Array.from(dirtyIds);
  dirtyIds = new Set();
  setStatus("syncing");
  try {
    await Promise.all(
      ids.map((id) => {
        const note = getNoteById!(id);
        // Deleted for good between markNoteDirty() and this flush — deleteNoteFromCloud() already
        // handles removing it from Firestore directly, so there's nothing to push for this id.
        if (!note) return Promise.resolve();
        return Promise.all([
          setDoc(roomNoteDoc(user.uid, currentRoomId!, id), {
            title: note.title,
            html: note.html,
            updatedAt: note.updatedAt,
            public: !!note.public,
            ...(note.editable ? { editable: true } : {}),
            ...(note.playerBase ? { playerBase: note.playerBase } : {}),
            // In the trash: other devices move it there too.
            ...(typeof note.deletedAt === "number" ? { deletedAt: note.deletedAt } : {}),
            ...(typeof note.secretModel === "number" ? { secretModel: note.secretModel } : {}),
            ...(note.pinned ? { pinned: true } : {}),
            ...(note.folderId ? { folderId: note.folderId } : {}),
            ...(typeof note.folderAt === "number" ? { folderAt: note.folderAt } : {}),
            ...(note.mapIcon ? { mapIcon: true } : {}),
          }),
          note.public && sharedKey && sharedVersions.get(sharedKey + "/" + id) !== note.updatedAt
            ? writeSharedNote(sharedKey, note, user.uid)
            : null,
        ]);
      })
    );
    setStatus("synced");
  } catch (err) {
    console.error("Notes: cloud sync failed", err);
    ids.forEach((id) => dirtyIds.add(id));
    setStatus("error");
  }
}

export async function deleteNoteFromCloud(noteId: string): Promise<void> {
  const init = ensureInitialized();
  const user = init ? accountOf(init.auth.currentUser) : null;
  if (!init || !user || !currentRoomId) return;
  dirtyIds.delete(noteId);
  try {
    await deleteDoc(roomNoteDoc(user.uid, currentRoomId, noteId));
  } catch (err) {
    console.error("Notes: failed to delete cloud copy of note", noteId, err);
  }
}

// Live-subscribes to every note Firestore has for this room, under the signed-in account. Fires once
// immediately with whatever's already there (covers "just signed in" / "just opened on this device"),
// then again on every remote change — the closest thing to real-time sync this app does, and it comes
// for free from Firestore's own listener rather than any polling of ours.
// `onFirstSync` runs once, after the first batch has gone through `onChange` (empty or not): from then
// on this device has everything the account has.
export function watchCloudNotes(
  roomId: string,
  onChange: (notes: Note[], removedIds: string[]) => void,
  onFirstSync?: () => void
): () => void {
  const init = ensureInitialized();
  const user = init ? accountOf(init.auth.currentUser) : null;
  if (!init || !user) return () => {};
  let first = true;
  return onSnapshot(
    roomNotesCollection(user.uid, roomId),
    (snapshot) => {
      const notes: Note[] = [];
      const removedIds: string[] = [];
      snapshot.docChanges().forEach((change) => {
        if (change.type === "removed") {
          removedIds.push(change.doc.id);
        } else {
          const data = change.doc.data() as { title?: unknown; html?: unknown; updatedAt?: unknown; public?: unknown; editable?: unknown; playerBase?: unknown; deletedAt?: unknown; secretModel?: unknown; pinned?: unknown; folderId?: unknown; folderAt?: unknown; mapIcon?: unknown };
          const playerBase = sanitizePlayerBase(data.playerBase);
          notes.push({
            id: change.doc.id,
            title: typeof data.title === "string" ? data.title : "",
            html: typeof data.html === "string" ? sanitizeNoteHtml(data.html) : "",
            updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
            ...(data.public === true ? { public: true } : {}),
            ...(data.public === true && data.editable === true ? { editable: true } : {}),
            ...(playerBase ? { playerBase } : {}),
            ...(typeof data.deletedAt === "number" ? { deletedAt: data.deletedAt } : {}),
            ...(typeof data.secretModel === "number" ? { secretModel: data.secretModel } : {}),
            ...(data.pinned === true ? { pinned: true } : {}),
            ...(typeof data.folderId === "string" && data.folderId ? { folderId: data.folderId } : {}),
            ...(typeof data.folderAt === "number" ? { folderAt: data.folderAt } : {}),
            ...(data.mapIcon === true ? { mapIcon: true } : {}),
          });
        }
      });
      if (notes.length || removedIds.length) onChange(notes, removedIds);
      if (first) {
        first = false;
        onFirstSync?.();
      }
    },
    (err) => {
      console.error("Notes: cloud listener error", err);
      setStatus("error");
    }
  );
}
