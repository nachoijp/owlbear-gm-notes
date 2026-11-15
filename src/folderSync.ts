import { doc, setDoc, deleteDoc, collection, onSnapshot } from "firebase/firestore";
import localforage from "localforage";
import { cloudContext, reportCloudSyncError } from "./cloudSync";
import { getPluginId } from "./pluginId";
import { sanitizeFolder } from "./notes";
import type { Folder } from "./notes";

// Cloud copy of the note list's folders, per room under the signed-in account at
// users/{uid}/rooms/{roomId}/folders/{id}. Same model as templates (see templateSync.ts): IndexedDB
// stays the source of truth on this device, last-write-wins per folder by `updatedAt`, and each
// change goes up right away (folders change rarely). Which folder a note is in travels with the
// note itself (see cloudSync.ts).
//
// A folder here but not in the cloud could be new here (push it) or deleted on another device
// (drop it): this device remembers, per account and room, which folder ids it has seen in the
// cloud, and a remembered id that's gone was deleted elsewhere.

const store = localforage.createInstance({ name: getPluginId("notes-db") });
const knownKey = (uid: string, roomId: string) => `folders:cloudKnown:${uid}:${roomId}`;
async function loadKnown(uid: string, roomId: string): Promise<Set<string>> {
  const stored = await store.getItem<unknown>(knownKey(uid, roomId));
  return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
}
function saveKnown(uid: string, roomId: string, ids: Set<string>) {
  void store.setItem(knownKey(uid, roomId), Array.from(ids)).catch((err) => console.error("Notes: failed to save known folders", err));
}

let known = new Set<string>();
let knownFor: string | null = null; // "uid/roomId" the set above belongs to
let watchedRoom: string | null = null;

function folderDoc(uid: string, roomId: string, id: string) {
  return doc(cloudContext()!.db, "users", uid, "rooms", roomId, "folders", id);
}

export async function pushFolder(folder: Folder): Promise<void> {
  const ctx = cloudContext();
  if (!ctx || !watchedRoom) return;
  const roomId = watchedRoom;
  try {
    await setDoc(folderDoc(ctx.user.uid, roomId, folder.id), {
      name: folder.name,
      updatedAt: folder.updatedAt,
      ...(folder.parentId ? { parentId: folder.parentId } : {}),
    });
    if (knownFor === `${ctx.user.uid}/${roomId}` && !known.has(folder.id)) {
      known.add(folder.id);
      saveKnown(ctx.user.uid, roomId, known);
    }
  } catch (err) {
    console.error("Notes: failed to sync folder", folder.id, err);
    reportCloudSyncError();
  }
}

export async function deleteFolderFromCloud(id: string): Promise<void> {
  const ctx = cloudContext();
  if (!ctx || !watchedRoom) return;
  const roomId = watchedRoom;
  try {
    await deleteDoc(folderDoc(ctx.user.uid, roomId, id));
    if (knownFor === `${ctx.user.uid}/${roomId}` && known.delete(id)) saveKnown(ctx.user.uid, roomId, known);
  } catch (err) {
    console.error("Notes: failed to delete cloud copy of folder", id, err);
    reportCloudSyncError();
  }
}

/** Folders deleted on this device, possibly while the cloud couldn't hear about it (signed out, or
 * before cloud sync loaded): `ids()` reads them, `settled()` reports the ones the cloud no longer has. */
export interface ErasedFolders {
  ids: () => Set<string>;
  settled: (ids: string[]) => void;
}

/**
 * Live-syncs this room's folders for the signed-in account. `getLocal` reads the current local
 * list; `applyLocal` replaces it (and is expected to save and re-render). Returns an unsubscribe.
 */
export function watchCloudFolders(
  roomId: string,
  getLocal: () => Folder[],
  applyLocal: (folders: Folder[]) => void,
  erased: ErasedFolders
): () => void {
  const ctx = cloudContext();
  if (!ctx) return () => {};
  const uid = ctx.user.uid;
  let stopped = false;
  let unsubscribe: () => void = () => {};
  let first = true;
  watchedRoom = roomId;

  void (async () => {
    const loaded = await loadKnown(uid, roomId);
    // Stopped meanwhile (signed out, another account): this watcher's set mustn't replace the next one's.
    if (stopped) return;
    known = loaded;
    knownFor = `${uid}/${roomId}`;
    unsubscribe = onSnapshot(
      collection(ctx.db, "users", uid, "rooms", roomId, "folders"),
      // Metadata changes too: the first comparison waits for the server's answer (below), and when the
      // server has nothing new that answer only shows up as a metadata change.
      { includeMetadataChanges: true },
      (snapshot) => {
        const local = getLocal();
        if (first) {
          // Offline, the first snapshot comes from the local cache — possibly empty — and would read
          // as "every folder deleted elsewhere". Only the server's own state is compared against.
          if (snapshot.metadata.fromCache) return;
          first = false;
          // Deleted here while the cloud couldn't hear it: deleted there now, not brought back.
          const gone = erased.ids();
          const settled: string[] = [];
          gone.forEach((id) => {
            if (snapshot.docs.some((d) => d.id === id)) void deleteFolderFromCloud(id);
            else settled.push(id);
          });
          if (settled.length) erased.settled(settled);
          const cloud = new Map<string, Folder>();
          snapshot.docs.forEach((d) => {
            const f = sanitizeFolder({ ...d.data(), id: d.id });
            if (f && !gone.has(f.id)) cloud.set(f.id, f);
          });
          const next: Folder[] = [];
          const toPush: Folder[] = [];
          local.forEach((f) => {
            const there = cloud.get(f.id);
            if (there) {
              cloud.delete(f.id);
              if (f.updatedAt > there.updatedAt) {
                next.push(f);
                toPush.push(f);
              } else next.push(there);
            } else if (!known.has(f.id)) {
              // New here: up it goes. (A known one that's gone was deleted elsewhere: dropped.)
              next.push(f);
              toPush.push(f);
            }
          });
          next.push(...cloud.values());
          known = new Set(next.map((f) => f.id));
          saveKnown(uid, roomId, known);
          // Applied before pushing: `next` comes from the list as it was when this snapshot arrived.
          const sig = (fs: Folder[]) => fs.map((f) => `${f.id}:${f.updatedAt}:${f.name}:${f.parentId ?? ""}`).sort().join("|");
          if (sig(next) !== sig(local)) applyLocal(next);
          toPush.forEach((f) => void pushFolder(f));
          return;
        }
        let next = local;
        let changed = false;
        const gone = erased.ids();
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") {
            known.delete(change.doc.id);
            if (gone.has(change.doc.id)) erased.settled([change.doc.id]);
            if (next.some((f) => f.id === change.doc.id)) {
              next = next.filter((f) => f.id !== change.doc.id);
              changed = true;
            }
            return;
          }
          const incoming = sanitizeFolder({ ...change.doc.data(), id: change.doc.id });
          if (!incoming || gone.has(incoming.id)) return;
          known.add(incoming.id);
          const mine = next.find((f) => f.id === incoming.id);
          if (mine && mine.updatedAt >= incoming.updatedAt) return;
          next = [...next.filter((f) => f.id !== incoming.id), incoming];
          changed = true;
        });
        saveKnown(uid, roomId, known);
        if (changed) applyLocal(next);
      },
      (err) => {
        console.error("Notes: folder cloud listener error", err);
        reportCloudSyncError();
      }
    );
  })();

  return () => {
    stopped = true;
    unsubscribe();
    knownFor = null;
    watchedRoom = null;
  };
}
