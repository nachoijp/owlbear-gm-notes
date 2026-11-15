import type { User } from "firebase/auth";
import { hasFirebaseConfig } from "./firebaseConfig";
import { getPluginId } from "./pluginId";
import type { Note, Folder } from "./notes";
import type { Template } from "./templates";
import type { SyncStatus, SharedCopy } from "./cloudSync";
export type { SharedCopy } from "./cloudSync";

// Cloud sync without Firebase in the main bundle: cloudSync.ts and templateSync.ts (and Firebase
// with them, most of the extension's size) load on demand, in the background. A device that was
// signed out last time doesn't load them at all until Settings opens, where signing in happens;
// one that was signed in (or hasn't recorded either yet) loads them right after boot.
//
// Everything that needs a signed-in user is a no-op until they've loaded: nobody can be signed in
// before Firebase is there to say so.

type Impl = typeof import("./cloudSync") & typeof import("./templateSync") & typeof import("./folderSync");

let impl: Impl | null = null;
let loading: Promise<Impl> | null = null;

let authCallback: ((user: User | null) => void) | null = null;
const statusListeners: ((status: SyncStatus) => void)[] = [];
let context: [string, (id: string) => Note | undefined] | null = null;

const SIGNED_IN_KEY = getPluginId("cloud-signed-in");
function rememberedSignIn(): "1" | "0" | null {
  try {
    const v = localStorage.getItem(SIGNED_IN_KEY);
    return v === "1" || v === "0" ? v : null;
  } catch {
    return null;
  }
}
function rememberSignIn(user: User | null) {
  try {
    localStorage.setItem(SIGNED_IN_KEY, user ? "1" : "0");
  } catch {
    // Without storage every boot loads cloud sync, as if the state were unknown.
  }
}

function load(): Promise<Impl> {
  if (!loading) {
    loading = Promise.all([import("./cloudSync"), import("./templateSync"), import("./folderSync")]).then(([sync, templateSync, folderSync]) => {
      const loaded: Impl = { ...sync, ...templateSync, ...folderSync };
      if (context) loaded.initCloudSyncContext(...context);
      loaded.setSharedKey(sharedKey);
      statusListeners.forEach((cb) => loaded.onSyncStatusChange(cb));
      loaded.onAuthChange((user) => {
        rememberSignIn(user);
        authCallback?.(user);
      });
      impl = loaded;
      return loaded;
    });
    loading.catch((err) => console.error("Notes: failed to load cloud sync", err));
  }
  return loading;
}

export function cloudSyncAvailable(): boolean {
  return hasFirebaseConfig();
}

/** Starts cloud sync for this room: `onAuth` gets the signed-in user (or null) now and on every
 * change. */
export function startCloudSync(
  roomId: string,
  lookup: (id: string) => Note | undefined,
  onStatus: (status: SyncStatus) => void,
  onAuth: (user: User | null) => void
) {
  if (!cloudSyncAvailable()) return;
  context = [roomId, lookup];
  statusListeners.push(onStatus);
  authCallback = onAuth;
  if (rememberedSignIn() === "0") onAuth(null);
  else void load();
}

/** Settings is where signing in happens: loading cloud sync when it opens has it ready by the time
 * the sign-in button is clicked, so the sign-in popup opens straight from the click. */
export function prepareCloudSync() {
  if (cloudSyncAvailable()) void load();
}

export function getCurrentUser(): User | null {
  return impl ? impl.getCurrentUser() : null;
}
export function getSyncStatus(): SyncStatus {
  return impl ? impl.getSyncStatus() : "off";
}

export async function signInWithGoogle(): Promise<void> {
  if (!cloudSyncAvailable()) return;
  await (impl ?? (await load())).signInWithGoogle();
}
export async function signOutCloud(): Promise<void> {
  if (impl) await impl.signOutCloud();
}

export function markNoteDirty(noteId: string) {
  impl?.markNoteDirty(noteId);
}
export async function deleteNoteFromCloud(noteId: string): Promise<void> {
  if (impl) await impl.deleteNoteFromCloud(noteId);
}
export async function flushCloudSync(): Promise<void> {
  if (impl) await impl.flushCloudSync();
}
export function watchCloudNotes(
  roomId: string,
  onChange: (notes: Note[], removedIds: string[]) => void,
  onFirstSync?: () => void
): () => void {
  return impl ? impl.watchCloudNotes(roomId, onChange, onFirstSync) : () => {};
}

// Public notes (see cloudSync.ts): all of it needs a signed-in account, so Firebase is there already.
let sharedKey: string | null = null;
export function setSharedKey(key: string | null) {
  sharedKey = key;
  impl?.setSharedKey(key);
}
export async function publishNote(note: Note): Promise<void> {
  if (!impl) throw new Error("Notes: cloud sync isn't loaded");
  await impl.publishNote(note);
}
export function refreshSharedCopies(ids: string[]) {
  impl?.refreshSharedCopies(ids);
}
export async function unpublishNote(noteId: string): Promise<void> {
  if (impl) await impl.unpublishNote(noteId);
}
/** Loads Firebase (players have no other reason to) and follows the room's public notes. */
export function watchSharedNotes(key: string, onChange: (copies: SharedCopy[]) => void, onError: (err: unknown) => void): () => void {
  if (!cloudSyncAvailable()) return () => {};
  let stopped = false;
  let stop: (() => void) | null = null;
  load().then(
    (loaded) => {
      if (!stopped) stop = loaded.watchSharedNotes(key, onChange, onError);
    },
    onError
  );
  return () => {
    stopped = true;
    stop?.();
  };
}
/** The GM's own shared copies, live: how the players' edits to editable notes come back. */
export function watchOwnSharedNotes(key: string, onChange: (copies: SharedCopy[]) => void): () => void {
  return impl ? impl.watchOwnSharedNotes(key, onChange) : () => {};
}
// Editing a shared note (see editLock.ts). A player's first edit loads Firebase if it isn't yet.
export function editorUid(): string | null {
  return impl ? impl.editorUid() : null;
}
export async function takeSharedLock(noteId: string, name: string): Promise<boolean> {
  if (!cloudSyncAvailable()) return false;
  return (impl ?? (await load())).takeSharedLock(noteId, name);
}
export async function saveSharedEdit(noteId: string, edit: { title: string; html: string; updatedAt: number }, name: string): Promise<boolean> {
  if (!cloudSyncAvailable()) return false;
  return (impl ?? (await load())).saveSharedEdit(noteId, edit, name);
}
export async function releaseSharedLock(noteId: string): Promise<void> {
  if (impl) await impl.releaseSharedLock(noteId);
}
export async function reconcileSharedNotes(key: string, wanted: () => Note[]): Promise<void> {
  if (impl) await impl.reconcileSharedNotes(key, wanted);
}

export async function pushTemplate(template: Template): Promise<void> {
  if (impl) await impl.pushTemplate(template);
}
export async function deleteTemplateFromCloud(templateId: string): Promise<void> {
  if (impl) await impl.deleteTemplateFromCloud(templateId);
}
export function watchCloudTemplates(...args: Parameters<Impl["watchCloudTemplates"]>): () => void {
  return impl ? impl.watchCloudTemplates(...args) : () => {};
}

export async function pushFolder(folder: Folder): Promise<void> {
  if (impl) await impl.pushFolder(folder);
}
export async function deleteFolderFromCloud(id: string): Promise<void> {
  if (impl) await impl.deleteFolderFromCloud(id);
}
export function watchCloudFolders(...args: Parameters<Impl["watchCloudFolders"]>): () => void {
  return impl ? impl.watchCloudFolders(...args) : () => {};
}
