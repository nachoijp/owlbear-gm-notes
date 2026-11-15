import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Folder } from "../src/notes";

// A tiny in-memory Firestore: one collection of folder docs, one snapshot listener.
const cloud = new Map<string, Record<string, unknown>>();
let listener: ((snap: unknown) => void) | null = null;
const writes: string[] = [];
const kv = new Map<string, unknown>();

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => ({ id: path[path.length - 1] }),
  collection: () => ({}),
  setDoc: async (ref: { id: string }, data: Record<string, unknown>) => {
    writes.push("set:" + ref.id);
    cloud.set(ref.id, data);
  },
  deleteDoc: async (ref: { id: string }) => {
    writes.push("del:" + ref.id);
    cloud.delete(ref.id);
  },
  onSnapshot: (_c: unknown, _opts: unknown, cb: (snap: unknown) => void) => {
    listener = cb;
    return () => { listener = null; };
  },
}));
vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({
      getItem: async (k: string) => kv.get(k) ?? null,
      setItem: async (k: string, v: unknown) => { kv.set(k, v); },
    }),
  },
}));
vi.mock("../src/cloudSync", () => ({
  cloudContext: () => ({ db: {}, user: { uid: "u1" } }),
  reportCloudSyncError: () => {},
}));
vi.mock("@owlbear-rodeo/sdk", () => ({ default: { room: { id: "room" } } }));

const { watchCloudFolders, pushFolder, deleteFolderFromCloud } = await import("../src/folderSync");

function initialSnapshot(fromCache = false) {
  listener!({ metadata: { fromCache }, docs: Array.from(cloud.entries()).map(([id, data]) => ({ id, data: () => data })), docChanges: () => [] });
}
function change(type: "added" | "modified" | "removed", id: string, data: Record<string, unknown> = {}) {
  listener!({ metadata: { fromCache: false }, docs: [], docChanges: () => [{ type, doc: { id, data: () => data } }] });
}
const f = (id: string, name: string, updatedAt: number, parentId?: string): Folder => ({ id, name, updatedAt, ...(parentId ? { parentId } : {}) });
const flush = () => new Promise((r) => setTimeout(r, 0));

let erased = new Set<string>();
async function start(local: Folder[], opts: { cacheFirst?: boolean } = {}) {
  let current = local;
  const stop = watchCloudFolders("room", () => current, (next) => { current = next; }, {
    ids: () => erased,
    settled: (ids) => ids.forEach((id) => erased.delete(id)),
  });
  await flush();
  if (opts.cacheFirst) {
    // Offline: an empty snapshot from the cache comes first.
    listener!({ metadata: { fromCache: true }, docs: [], docChanges: () => [] });
    await flush();
  }
  initialSnapshot();
  await flush();
  return { get: () => current, set: (v: Folder[]) => { current = v; }, stop };
}

beforeEach(() => {
  erased = new Set();
  cloud.clear();
  writes.length = 0;
  kv.clear();
});

describe("folder cloud sync", () => {
  it("first sync: a folder new here goes up; the cloud's come down", async () => {
    cloud.set("c", { name: "Cloud", updatedAt: 5 });
    const s = await start([f("a", "Mine", 1)]);
    expect(s.get().map((x) => x.id).sort()).toEqual(["a", "c"]);
    expect(writes).toEqual(["set:a"]);
    s.stop();
  });

  it("first sync: newest wins per folder", async () => {
    cloud.set("a", { name: "Old", updatedAt: 1 });
    cloud.set("b", { name: "Newer", updatedAt: 9 });
    const s = await start([f("a", "New", 5), f("b", "Older", 2)]);
    expect(s.get().find((x) => x.id === "a")!.name).toBe("New");
    expect(s.get().find((x) => x.id === "b")!.name).toBe("Newer");
    expect(writes).toEqual(["set:a"]);
    s.stop();
  });

  it("a folder seen in the cloud before, now gone, was deleted elsewhere: dropped, not pushed back", async () => {
    cloud.set("a", { name: "A", updatedAt: 1 });
    let s = await start([f("a", "A", 1)]);
    s.stop();
    // Deleted on another device while this one was closed.
    cloud.delete("a");
    writes.length = 0;
    s = await start([f("a", "A", 1)]);
    expect(s.get()).toEqual([]);
    expect(writes).toEqual([]);
    s.stop();
  });

  it("a snapshot from the cache (offline) is not compared: known folders survive it", async () => {
    cloud.set("a", { name: "A", updatedAt: 1 });
    let s = await start([f("a", "A", 1)]);
    s.stop();
    // Boots offline: the cache answers first, empty; the server's answer still has "a".
    s = await start([f("a", "A", 1)], { cacheFirst: true });
    expect(s.get().map((x) => x.id)).toEqual(["a"]);
    s.stop();
  });

  it("a folder deleted here while signed out is deleted in the cloud, not brought back", async () => {
    cloud.set("a", { name: "A", updatedAt: 1 });
    cloud.set("b", { name: "B", updatedAt: 1 });
    let s = await start([f("a", "A", 1), f("b", "B", 1)]);
    s.stop();
    // Signed out: "a" deleted here only.
    erased.add("a");
    erased.add("gone-already");
    writes.length = 0;
    s = await start([f("b", "B", 1)]);
    expect(s.get().map((x) => x.id)).toEqual(["b"]);
    await flush();
    expect(cloud.has("a")).toBe(false);
    expect(writes).toEqual(["del:a"]);
    // One the cloud didn't have is settled right away; "a" once its removal comes through.
    expect(erased.has("gone-already")).toBe(false);
    change("removed", "a");
    expect(erased.size).toBe(0);
    s.stop();
  });

  it("a watcher stopped before it loaded doesn't take over", async () => {
    const stopA = watchCloudFolders("room", () => [], () => {}, { ids: () => erased, settled: () => {} });
    stopA();
    const s = await start([f("x", "X", 1)]);
    expect(writes).toEqual(["set:x"]);
    s.stop();
  });

  it("live: newer changes come in, older ones and removals handled", async () => {
    const s = await start([f("a", "A", 5)]);
    change("modified", "a", { name: "Stale", updatedAt: 3 });
    expect(s.get()[0].name).toBe("A");
    change("modified", "a", { name: "Fresh", updatedAt: 8, parentId: "p" });
    expect(s.get()[0]).toEqual({ id: "a", name: "Fresh", parentId: "p", updatedAt: 8 });
    change("added", "b", { name: "B", updatedAt: 1 });
    expect(s.get().map((x) => x.id).sort()).toEqual(["a", "b"]);
    change("removed", "a");
    expect(s.get().map((x) => x.id)).toEqual(["b"]);
    s.stop();
  });

  it("push and delete write to the room's folders", async () => {
    const s = await start([]);
    await pushFolder(f("x", "X", 1, "p"));
    expect(cloud.get("x")).toEqual({ name: "X", updatedAt: 1, parentId: "p" });
    await deleteFolderFromCloud("x");
    expect(cloud.has("x")).toBe(false);
    s.stop();
    // Not watching (signed out / another room): nothing is written.
    writes.length = 0;
    await pushFolder(f("y", "Y", 1));
    expect(writes).toEqual([]);
  });
});
