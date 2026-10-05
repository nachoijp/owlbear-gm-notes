import type { User } from "firebase/auth";
import { hasFirebaseConfig } from "./firebaseConfig";
import { getPluginId } from "./pluginId";
import type { Note } from "./notes";
import type { Template } from "./templates";
import type { SyncStatus } from "./cloudSync";

// Cloud sync without Firebase in the main bundle: cloudSync.ts and templateSync.ts (and Firebase
// with them, most of the extension's size) load on demand, in the background. A device that was
// signed out last time doesn't load them at all until Settings opens, where signing in happens;
// one that was signed in (or hasn't recorded either yet) loads them right after boot.
//
// Everything that needs a signed-in user is a no-op until they've loaded: nobody can be signed in
// before Firebase is there to say so.

type Impl = typeof import("./cloudSync") & typeof import("./templateSync");

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
    loading = Promise.all([import("./cloudSync"), import("./templateSync")]).then(([sync, templateSync]) => {
      const loaded: Impl = { ...sync, ...templateSync };
      if (context) loaded.initCloudSyncContext(...context);
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
export function watchCloudNotes(roomId: string, onChange: (notes: Note[], removedIds: string[]) => void): () => void {
  return impl ? impl.watchCloudNotes(roomId, onChange) : () => {};
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
