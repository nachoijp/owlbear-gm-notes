import OBR from "@owlbear-rodeo/sdk";
import { decompressFromUTF16 } from "lz-string";
import localforage from "localforage";
import { getPluginId } from "./pluginId";

export interface Note {
  id: string;
  title: string;
  html: string;
  updatedAt: number;
}

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
  };
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

/** Erases every note stored locally for the CURRENT room — an explicit, GM-initiated reset (e.g.
 * after exporting a backup and wanting a clean slate), not something run automatically. */
export async function clearAllNotes(): Promise<void> {
  const roomId = OBR.room.id;
  await store.removeItem(dbKeyForRoom(roomId));
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Byte size of the current notes, for an informational "space used" line in Settings — there's no
 * cap to measure it against anymore, just a rough sense of how much has been written. */
export function notesStorageBytes(notes: Note[]): number {
  return byteLength(notes);
}
