import OBR from "@owlbear-rodeo/sdk";
import { compressToUTF16, decompressFromUTF16 } from "lz-string";
import { getPluginId } from "./pluginId";

export interface Note {
  id: string;
  title: string;
  html: string;
  updatedAt: number;
}

const NOTES_KEY = getPluginId("notes");

// Owlbear caps a room's ENTIRE metadata (summed across every extension sharing the room, not just
// ours) at 16kB total — see https://docs.owlbear.rodeo/extensions/apis/room/. Storing the raw HTML
// blindly burns through that fast, so we compress the whole notes payload before writing it and
// decompress on read. Rich-text HTML is highly repetitive (tags, inline styles), so this typically
// buys back a large multiple of the raw 16kB budget in practice.
interface StoredPayload {
  /** Schema marker so a future format change can be told apart from this one. */
  v: 1;
  /** The full notes array, JSON-stringified and LZ-compressed. */
  z: string;
}

export const ROOM_METADATA_CAP_BYTES = 16 * 1024;
// A margin below Owlbear's real 16kB cap: other extensions' own writes land between our own
// pre-flight check and our write, and the exact cap enforcement (does it count the JSON encoding
// overhead of the room-metadata envelope itself, UTF-8 vs UTF-16, etc.) isn't documented precisely
// enough to cut it exactly at 16384.
const SAFE_MARGIN_BYTES = 512;

/** Thrown by setNotes() BEFORE it ever calls OBR.room.setMetadata(), when writing would exceed the
 * room's shared metadata budget. Owlbear's own rejection for this happens inside its own top-level
 * page's script context (not ours), so it can never reach a catch block or even a same-origin
 * "unhandledrejection" listener in our extension's iframe — pre-flighting the size ourselves is the
 * only way we can detect and surface this at all. */
export class StorageLimitError extends Error {
  readonly breakdown: MetadataKeySize[];
  constructor(breakdown: MetadataKeySize[]) {
    super("Room metadata is at its shared 16kB limit");
    this.name = "StorageLimitError";
    this.breakdown = breakdown;
  }
}

export interface MetadataKeySize {
  key: string;
  bytes: number;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exported for reuse by the export/import feature: a note read back from a file the GM exported
 * earlier needs exactly the same shape validation as one read back from room metadata. */
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

/** Reads a note list out of a room-metadata value, however it was stored (compressed or, from
 * before compression existed, a plain array). */
function decodeStoredNotes(raw: unknown): Note[] {
  if (Array.isArray(raw)) {
    // Legacy, pre-compression shape: the metadata value was the notes array itself.
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

function encodeStoredNotes(notes: Note[]): StoredPayload {
  return { v: 1, z: compressToUTF16(JSON.stringify(notes)) };
}

export async function getNotes(): Promise<Note[]> {
  const metadata = await OBR.room.getMetadata();
  return decodeStoredNotes(metadata[NOTES_KEY]);
}

export async function setNotes(notes: Note[]): Promise<void> {
  const payload = encodeStoredNotes(notes);
  // Summing each key's own JSON.stringify() length (the original approach) undercounts: it misses
  // the key-name bytes and the object's own punctuation (braces, commas, colons, quotes) — with 30+
  // keys in a well-populated room, that overhead alone can run past a kilobyte. Serializing the
  // WHOLE merged object in one shot (exactly what setMetadata's `{...current, [key]: value}` merge
  // produces) measures precisely what actually gets sent over the wire.
  const metadata = await OBR.room.getMetadata();
  const merged = { ...metadata, [NOTES_KEY]: payload };
  if (byteLength(merged) > ROOM_METADATA_CAP_BYTES - SAFE_MARGIN_BYTES) {
    const breakdown = Object.entries(merged)
      .map(([key, value]) => ({ key, bytes: byteLength(value) }))
      .sort((a, b) => b.bytes - a.bytes);
    throw new StorageLimitError(breakdown);
  }
  await OBR.room.setMetadata({ [NOTES_KEY]: payload });
}

/** Fires with the current, sanitized note list whenever it changes remotely (e.g. the GM editing from another device/tab). */
export function onNotesChange(callback: (notes: Note[]) => void): () => void {
  return OBR.room.onMetadataChange((metadata) => {
    callback(decodeStoredNotes(metadata[NOTES_KEY]));
  });
}

/** Byte sizes for a "storage used" indicator. `raw` is the uncompressed JSON size (what the GM's
 * content actually amounts to); `stored` is what's actually written to the room's shared 16kB
 * budget after compression — the number that matters for whether a save will succeed. */
export function notesStorageStats(notes: Note[]): { raw: number; stored: number } {
  return {
    raw: byteLength(notes),
    stored: byteLength(encodeStoredNotes(notes)),
  };
}

