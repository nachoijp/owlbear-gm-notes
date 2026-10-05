import { doc, setDoc, deleteDoc, collection, onSnapshot } from "firebase/firestore";
import localforage from "localforage";
import { cloudContext, reportCloudSyncError } from "./cloudSync";
import { getPluginId } from "./pluginId";
import { sanitizeTemplate } from "./templates";
import { sanitizeNoteHtml } from "./sanitizeHtml";
import type { Template } from "./templates";

// Cloud copy of the GM's templates, under the signed-in account at users/{uid}/templates/{id} —
// global like the templates themselves, not per room. Same model as notes (see cloudSync.ts):
// IndexedDB stays the source of truth on this device, last-write-wins per template by `updatedAt`.
// Templates change rarely, so each change is pushed right away instead of debounced like notes.
//
// Two things make the first sync on a device trickier than for notes:
// - Every browser seeds its own copies of the four built-ins, with its own ids. A built-in arriving
//   from the cloud replaces a local built-in of the same kind instead of sitting next to it.
// - A template missing from the cloud could be new here (push it) or deleted on another device
//   (drop it). To tell them apart, this device remembers, per account, which template ids it has
//   ever seen in the cloud: a remembered id that's gone was deleted elsewhere.

const store = localforage.createInstance({ name: getPluginId("notes-db") });
function knownIdsKey(uid: string) {
  return `templates:cloudKnown:${uid}`;
}
async function loadKnownIds(uid: string): Promise<Set<string>> {
  const stored = await store.getItem<unknown>(knownIdsKey(uid));
  return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
}
async function saveKnownIds(uid: string, ids: Set<string>) {
  await store.setItem(knownIdsKey(uid), Array.from(ids));
}

let knownIds = new Set<string>();
let knownIdsUid: string | null = null;

function templateDoc(uid: string, templateId: string) {
  return doc(cloudContext()!.db, "users", uid, "templates", templateId);
}

export async function pushTemplate(template: Template): Promise<void> {
  const ctx = cloudContext();
  if (!ctx) return;
  try {
    // Firestore rejects undefined fields, so `builtin` is only written when there is one.
    await setDoc(templateDoc(ctx.user.uid, template.id), {
      title: template.title,
      html: template.html,
      updatedAt: template.updatedAt,
      ...(template.builtin ? { builtin: template.builtin } : {}),
    });
    if (knownIdsUid === ctx.user.uid && !knownIds.has(template.id)) {
      knownIds.add(template.id);
      await saveKnownIds(ctx.user.uid, knownIds);
    }
  } catch (err) {
    console.error("Notes: failed to sync template", template.id, err);
    reportCloudSyncError();
  }
}

export async function deleteTemplateFromCloud(templateId: string): Promise<void> {
  const ctx = cloudContext();
  if (!ctx) return;
  try {
    await deleteDoc(templateDoc(ctx.user.uid, templateId));
    if (knownIdsUid === ctx.user.uid && knownIds.delete(templateId)) {
      await saveKnownIds(ctx.user.uid, knownIds);
    }
  } catch (err) {
    console.error("Notes: failed to delete cloud copy of template", templateId, err);
    reportCloudSyncError();
  }
}

function templateFromDoc(id: string, data: unknown): Template | undefined {
  const template = sanitizeTemplate({ ...(data as object), id });
  return template ? { ...template, html: sanitizeNoteHtml(template.html) } : undefined;
}

/** Applies one template arriving from the cloud: newest wins by `updatedAt`, and a built-in replaces
 * any other local built-in of the same kind (see the header comment). Returns `local` unchanged
 * (same array) when nothing needed to change. */
function upsertFromCloud(local: Template[], incoming: Template): Template[] {
  const sameId = local.find((t) => t.id === incoming.id);
  if (sameId && sameId.updatedAt >= incoming.updatedAt) return local;
  return [
    ...local.filter((t) => t.id !== incoming.id && !(incoming.builtin && t.builtin === incoming.builtin)),
    incoming,
  ];
}

/**
 * Live-syncs templates for the signed-in account. `getLocal` reads the current local list;
 * `applyLocal` replaces it (and is expected to persist + re-render). Returns an unsubscribe.
 */
export function watchCloudTemplates(
  getLocal: () => Template[],
  applyLocal: (templates: Template[]) => void
): () => void {
  const ctx = cloudContext();
  if (!ctx) return () => {};
  const uid = ctx.user.uid;
  let stopped = false;
  let unsubscribe: () => void = () => {};
  let initialDone = false;

  void (async () => {
    knownIds = await loadKnownIds(uid);
    knownIdsUid = uid;
    if (stopped) return;
    unsubscribe = onSnapshot(
      collection(ctx.db, "users", uid, "templates"),
      (snapshot) => {
        if (!initialDone) {
          initialDone = true;
          const cloud: Template[] = [];
          snapshot.docs.forEach((d) => {
            const t = templateFromDoc(d.id, d.data());
            if (t) cloud.push(t);
          });
          void initialMerge(uid, cloud, getLocal(), applyLocal);
          return;
        }
        let next = getLocal();
        let changed = false;
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") {
            if (next.some((t) => t.id === change.doc.id)) {
              next = next.filter((t) => t.id !== change.doc.id);
              changed = true;
            }
            knownIds.delete(change.doc.id);
            return;
          }
          const incoming = templateFromDoc(change.doc.id, change.doc.data());
          if (!incoming) return;
          knownIds.add(incoming.id);
          const merged = upsertFromCloud(next, incoming);
          if (merged !== next) {
            next = merged;
            changed = true;
          }
        });
        void saveKnownIds(uid, knownIds);
        if (changed) applyLocal(next);
      },
      (err) => {
        console.error("Notes: template cloud listener error", err);
        reportCloudSyncError();
      }
    );
  })();

  return () => {
    stopped = true;
    unsubscribe();
    knownIdsUid = null;
  };
}

async function initialMerge(
  uid: string,
  cloud: Template[],
  local: Template[],
  applyLocal: (templates: Template[]) => void
) {
  const cloudById = new Map(cloud.map((t) => [t.id, t]));
  const cloudBuiltins = new Set(cloud.map((t) => t.builtin).filter(Boolean));
  // A device that has never synced with this account, joining an account that already has
  // templates, adopts the account's built-ins rather than adding its own freshly-seeded ones —
  // otherwise a built-in deleted elsewhere would come back from every new device.
  const firstSyncIntoExistingAccount = knownIds.size === 0 && cloud.length > 0;

  const next: Template[] = [];
  const toPush: Template[] = [];
  for (const t of local) {
    const inCloud = cloudById.get(t.id);
    if (inCloud) {
      if (t.updatedAt > inCloud.updatedAt) {
        next.push(t);
        toPush.push(t);
      } else {
        next.push(inCloud);
      }
      cloudById.delete(t.id);
      continue;
    }
    if (t.builtin && cloudBuiltins.has(t.builtin)) continue; // the cloud's copy wins (added below)
    if (knownIds.has(t.id)) continue; // was in the cloud before, now gone: deleted elsewhere
    if (t.builtin && firstSyncIntoExistingAccount) continue;
    next.push(t);
    toPush.push(t);
  }
  next.push(...cloudById.values());

  // Applied before any await: `next` is computed from the list as it was when this snapshot arrived,
  // so applying it later could overwrite a template the GM saved/renamed/deleted in the meantime.
  const before = local.map((t) => `${t.id}:${t.updatedAt}`).sort().join("|");
  const after = next.map((t) => `${t.id}:${t.updatedAt}`).sort().join("|");
  if (before !== after) applyLocal(next);

  cloud.forEach((t) => knownIds.add(t.id));
  await saveKnownIds(uid, knownIds);
  await Promise.all(toPush.map(pushTemplate));
}
