import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth";
import {
  getFirestore,
  doc,
  setDoc,
  deleteDoc,
  collection,
  onSnapshot,
  type Firestore,
} from "firebase/firestore";
import { firebaseConfig, hasFirebaseConfig } from "./firebaseConfig";
import type { Note } from "./notes";

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

export function getCurrentUser(): User | null {
  const init = ensureInitialized();
  return init ? init.auth.currentUser : null;
}

export function onAuthChange(callback: (user: User | null) => void): () => void {
  const init = ensureInitialized();
  if (!init) return () => {};
  return onAuthStateChanged(init.auth, callback);
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
  const user = init ? init.auth.currentUser : null;
  if (!init || !user || !currentRoomId || !getNoteById || !dirtyIds.size) return;
  const ids = Array.from(dirtyIds);
  dirtyIds = new Set();
  setStatus("syncing");
  try {
    await Promise.all(
      ids.map((id) => {
        const note = getNoteById!(id);
        // Deleted locally between markNoteDirty() and this flush — deleteNoteFromCloud() already
        // handles removing it from Firestore directly, so there's nothing to push for this id.
        if (!note) return Promise.resolve();
        return setDoc(roomNoteDoc(user.uid, currentRoomId!, id), {
          title: note.title,
          html: note.html,
          updatedAt: note.updatedAt,
        });
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
  const user = init ? init.auth.currentUser : null;
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
export function watchCloudNotes(
  roomId: string,
  onChange: (notes: Note[], removedIds: string[]) => void
): () => void {
  const init = ensureInitialized();
  const user = init ? init.auth.currentUser : null;
  if (!init || !user) return () => {};
  return onSnapshot(
    roomNotesCollection(user.uid, roomId),
    (snapshot) => {
      const notes: Note[] = [];
      const removedIds: string[] = [];
      snapshot.docChanges().forEach((change) => {
        if (change.type === "removed") {
          removedIds.push(change.doc.id);
        } else {
          const data = change.doc.data() as { title?: unknown; html?: unknown; updatedAt?: unknown };
          notes.push({
            id: change.doc.id,
            title: typeof data.title === "string" ? data.title : "",
            html: typeof data.html === "string" ? data.html : "",
            updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
          });
        }
      });
      if (notes.length || removedIds.length) onChange(notes, removedIds);
    },
    (err) => {
      console.error("Notes: cloud listener error", err);
      setStatus("error");
    }
  );
}
