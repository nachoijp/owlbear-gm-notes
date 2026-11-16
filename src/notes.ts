import OBR from "@owlbear-rodeo/sdk";
import { decompressFromUTF16 } from "lz-string";
import localforage from "localforage";
import { getPluginId } from "./pluginId";

export interface Note {
  id: string;
  title: string;
  html: string;
  updatedAt: number;
  /** Shared with the room's players (see sharedNotes in cloudSync.ts). Absent = private. */
  public?: boolean;
  /** Shared AND editable by the players, one person at a time (see editLock.ts). Only with `public`;
   * such a note has no hidden parts. */
  editable?: boolean;
  /** The GM's version from before the players' latest edits, to go back to (see main.ts). */
  playerBase?: { title: string; html: string; updatedAt: number };
  /** In the trash since then (see main.ts): kept apart from the notes, emptied after 30 days. */
  deletedAt?: number;
  /** Which rules its hidden parts follow (see SECRET_MODEL in secret.ts). Absent: the old ones. */
  secretModel?: number;
  /** Kept at the top of the notes list. */
  pinned?: boolean;
  /** The folder it's in (see Folder). Absent, or a folder that no longer exists: the list's root. */
  folderId?: string;
  /** When it was last moved between folders. Moving isn't an edit (updatedAt stays), so this is what
   * tells which device's folder is the latest (see mergeCloudNotes in main.ts). */
  folderAt?: number;
  /** Its linked map items show a badge that opens a quick view of it (see itemLinks.ts). */
  mapIcon?: boolean;
}

/** A folder in the notes list, per room like the notes. Folders nest up to FOLDER_MAX_DEPTH levels. */
export interface Folder {
  id: string;
  name: string;
  /** The folder it's in. Absent (or one that no longer exists): the root. */
  parentId?: string;
  updatedAt: number;
}
export const FOLDER_MAX_DEPTH = 3;

// Notes used to live in OBR.room.setMetadata(), which shares a single 16kB budget across EVERY
// extension in the room — not just this one. A GM writing enough notes could leave other, unrelated
// extensions unable to save at all, with no obvious cause from their side. IndexedDB is per-browser
// instead of per-room-shared, with a quota in the hundreds of MB, so it can't collide with anything
// else in the room. The trade-off, accepted deliberately: notes no longer sync across devices — a
// note only lives where it was written, though export/import (see main.ts) covers moving them
// manually to another device.
const store = localforage.createInstance({ name: getPluginId("notes-db") });

function dbKeyForRoom(roomId: string): string {
  return `notes:${roomId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizePlayerBase(value: unknown): Note["playerBase"] | undefined {
  if (!isPlainObject(value) || typeof value.title !== "string" || typeof value.html !== "string" || typeof value.updatedAt !== "number") return undefined;
  return { title: value.title, html: value.html, updatedAt: value.updatedAt };
}

/** Exported for reuse by the export/import feature: a note read back from a file the GM exported
 * earlier needs exactly the same shape validation as one read back from storage. */
export function sanitizeNote(value: unknown): Note | undefined {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.html !== "string"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    title: value.title,
    html: value.html,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    ...(value.public === true ? { public: true } : {}),
    ...(value.public === true && value.editable === true ? { editable: true } : {}),
    ...(sanitizePlayerBase(value.playerBase) ? { playerBase: sanitizePlayerBase(value.playerBase)! } : {}),
    ...(typeof value.deletedAt === "number" ? { deletedAt: value.deletedAt } : {}),
    ...(typeof value.secretModel === "number" ? { secretModel: value.secretModel } : {}),
    ...(value.pinned === true ? { pinned: true } : {}),
    ...(typeof value.folderId === "string" && value.folderId ? { folderId: value.folderId } : {}),
    ...(typeof value.folderAt === "number" ? { folderAt: value.folderAt } : {}),
    ...(value.mapIcon === true ? { mapIcon: true } : {}),
  };
}

export function sanitizeFolder(value: unknown): Folder | undefined {
  if (!isPlainObject(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string") return undefined;
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.parentId === "string" && value.parentId && value.parentId !== value.id ? { parentId: value.parentId } : {}),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  };
}

// The folders, stored apart from the notes under their own key (older versions simply don't see
// them, and show every note at the root).
export async function getFolders(): Promise<Folder[]> {
  const stored = await store.getItem<unknown>(`folders:${OBR.room.id}`);
  return Array.isArray(stored) ? stored.map(sanitizeFolder).filter((f): f is Folder => f !== undefined) : [];
}
export async function setFolders(folders: Folder[]): Promise<void> {
  await store.setItem(`folders:${OBR.room.id}`, folders);
}
// Folders deleted here that the cloud may not have heard about yet (see folderSync.ts).
export async function getErasedFolders(): Promise<string[]> {
  const stored = await store.getItem<unknown>(`foldersErased:${OBR.room.id}`);
  return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [];
}
export async function setErasedFolders(ids: string[]): Promise<void> {
  await store.setItem(`foldersErased:${OBR.room.id}`, ids.slice(-ERASED_FOLDERS_CAP));
}
const ERASED_FOLDERS_CAP = 500;
// Which folders are folded in the list: this device's view only, not synced.
export async function getFoldedFolders(): Promise<string[]> {
  const stored = await store.getItem<unknown>(`foldersFolded:${OBR.room.id}`);
  return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [];
}
export async function setFoldedFolders(ids: string[]): Promise<void> {
  await store.setItem(`foldersFolded:${OBR.room.id}`, ids);
}

function sanitizeNotes(value: unknown): Note[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(sanitizeNote).filter((note): note is Note => note !== undefined);
}

/** Decodes the OLD room-metadata value shape (LZ-compressed, or — from even before that — a plain
 * array) purely for the one-time migration below. Not used for anything written by this version. */
function decodeLegacyRoomMetadataNotes(raw: unknown): Note[] {
  if (Array.isArray(raw)) {
    return sanitizeNotes(raw);
  }
  if (isPlainObject(raw) && typeof raw.z === "string") {
    const json = decompressFromUTF16(raw.z);
    if (!json) return [];
    try {
      return sanitizeNotes(JSON.parse(json));
    } catch {
      return [];
    }
  }
  return [];
}

const LEGACY_ROOM_METADATA_KEY = getPluginId("notes");

/** Runs once per room, the first time this room is opened under the IndexedDB-based storage: pulls
 * any notes still sitting in the old shared room-metadata key into IndexedDB, then clears that key —
 * completing the whole point of moving off shared storage instead of just leaving old data stranded
 * there forever (the exact "orphaned extension data" problem this project found and fixed a cleanup
 * tool for earlier, before removing that tool for being inappropriate on a publicly-shared extension). */
async function migrateFromRoomMetadata(roomId: string): Promise<Note[]> {
  let metadata: Awaited<ReturnType<typeof OBR.room.getMetadata>>;
  try {
    metadata = await OBR.room.getMetadata();
  } catch (err) {
    console.error("Notes: couldn't read legacy room metadata for migration", err);
    return [];
  }
  const legacyNotes = decodeLegacyRoomMetadataNotes(metadata[LEGACY_ROOM_METADATA_KEY]);
  if (!legacyNotes.length) return [];
  await store.setItem(dbKeyForRoom(roomId), legacyNotes);
  try {
    await OBR.room.setMetadata({ [LEGACY_ROOM_METADATA_KEY]: "" });
  } catch (err) {
    console.error("Notes: migrated to local storage but failed to clear the old room metadata entry", err);
  }
  return legacyNotes;
}

export async function getNotes(): Promise<Note[]> {
  const roomId = OBR.room.id;
  const stored = await store.getItem<unknown>(dbKeyForRoom(roomId));
  if (stored !== null && stored !== undefined) {
    return sanitizeNotes(stored);
  }
  return migrateFromRoomMetadata(roomId);
}

export async function setNotes(notes: Note[]): Promise<void> {
  const roomId = OBR.room.id;
  await store.setItem(dbKeyForRoom(roomId), notes);
}

// The trash (notes deleted less than 30 days ago) is stored apart from the notes, under its own key:
// older versions, which don't know about it, simply don't see it.
function trashKeyForRoom(roomId: string): string {
  return `trash:${roomId}`;
}

export async function getTrash(): Promise<Note[]> {
  const stored = await store.getItem<unknown>(trashKeyForRoom(OBR.room.id));
  return sanitizeNotes(stored).filter((n) => typeof n.deletedAt === "number");
}

export async function setTrash(trash: Note[]): Promise<void> {
  await store.setItem(trashKeyForRoom(OBR.room.id), trash);
}

// The ids of notes deleted for good (out of the trash, here or on another device): map items still
// linked to one of them get unlinked when their scene is open (see main.ts). Only these: a link to a
// note this device simply doesn't have (another device's, without cloud sync) is left alone.
const ERASED_CAP = 500;
export async function getErased(): Promise<string[]> {
  const stored = await store.getItem<unknown>(`erased:${OBR.room.id}`);
  return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [];
}
export async function setErased(ids: string[]): Promise<void> {
  await store.setItem(`erased:${OBR.room.id}`, ids.slice(-ERASED_CAP));
}

/** Erases every note stored locally for the CURRENT room — an explicit, GM-initiated reset (e.g.
 * after exporting a backup and wanting a clean slate), not something run automatically. */
export async function clearAllNotes(): Promise<void> {
  const roomId = OBR.room.id;
  await store.removeItem(dbKeyForRoom(roomId));
  await store.removeItem(`folders:${roomId}`);
  await store.removeItem(`foldersFolded:${roomId}`);
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Byte size of the current notes, for an informational "space used" line in Settings — there's no
 * cap to measure it against anymore, just a rough sense of how much has been written. */
export function notesStorageBytes(notes: Note[]): number {
  return byteLength(notes);
}
