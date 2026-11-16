// The extension's background page: always loaded, for everyone in the room, so it's kept tiny (the
// Owlbear SDK and nothing else). It holds the GM's context-menu entry for linking map items to notes
// (see itemLinks.ts): "Link note" on items without one, "Open note" on items with one. Players get
// "Open note" only on items whose note is shared with them (the ITEM_SHARED_KEY mark). It follows
// the player's role, language and Settings switch, re-registering only when one of those changes.
// It also draws the map badges (ITEM_ICON_KEY) and opens a note's quick view on a double click.
import OBR, { buildImage } from "@owlbear-rodeo/sdk";
import type { Item } from "@owlbear-rodeo/sdk";
import { getPluginId } from "./pluginId";
import { BADGE_KEY, ITEM_ICON_KEY, ITEM_LINK_CHANNEL, ITEM_LINK_KEY, ITEM_LINKS_PREF_KEY, ITEM_SHARED_KEY, PEEK_CHANNEL, PEEK_POPOVER_ID, isFreshRequest, itemLabel, writeItemLinkRequest } from "./itemLinks";
import type { ItemLinkMessage, ItemLinkRequest, PeekMessage } from "./itemLinks";

const MENU_ID = getPluginId("item-link-menu");
const LANGUAGE_KEY = getPluginId("language");
const LABELS = {
  en: { link: "Link note", open: "Open note", unnamed: "item" },
  es: { link: "Vincular nota", open: "Abrir nota", unnamed: "objeto" },
};
// The badge: a disc with no see-through gaps (Owlbear only takes clicks on the image's pixels that
// aren't transparent), a fraction of a grid cell wide, near the item's bottom-right corner (a little
// inside it, so it reads as the item's). Locked, so it never moves and a double click
// (Owlbear's way to select a locked item) is what opens the note: a single click stays the item's.
const BADGE_URL = new URL("/map-badge.png", location.href).href;
const BADGE_PX = 128;
const BADGE_CELLS = 0.25;
const BADGE_INSET_CELLS = 0.07;
const PEEK_W = 320;
const PEEK_H = 280;

OBR.onReady(() => {
  let current = "";
  let gm = false;
  let enabled = false;
  let language: "en" | "es" = "en";
  // The menu's last request, until the panel takes it (see itemLinks.ts).
  let pending: ItemLinkRequest | null = null;
  const send = (message: ItemLinkMessage) => void OBR.broadcast.sendMessage(ITEM_LINK_CHANNEL, message, { destination: "LOCAL" });
  OBR.broadcast.onMessage(ITEM_LINK_CHANNEL, (event) => {
    const message = event.data as ItemLinkMessage;
    if (message.type === "hello" && isFreshRequest(pending)) send({ type: "request", request: pending });
    else if (message.type === "taken" && pending && message.at === pending.at) pending = null;
  });
  function request(r: Omit<ItemLinkRequest, "at">) {
    pending = { ...r, at: Date.now() };
    writeItemLinkRequest(pending);
    send({ type: "request", request: pending });
    void OBR.action.open();
  }
  async function sync() {
    const [role, metadata] = await Promise.all([OBR.player.getRole(), OBR.player.getMetadata()]);
    gm = role === "GM";
    // The Settings switch is the GM's own; players always get their entry.
    enabled = !gm || metadata[ITEM_LINKS_PREF_KEY] !== false;
    language = metadata[LANGUAGE_KEY] === "es" ? "es" : "en";
    const state = enabled ? (gm ? "gm-" : "player-") + language : "off";
    if (state === current) return;
    current = state;
    scheduleBadges();
    if (!enabled) {
      await OBR.contextMenu.remove(MENU_ID);
      return;
    }
    const t = LABELS[language];
    const isGm = gm;
    await OBR.contextMenu.create({
      id: MENU_ID,
      icons: isGm
        ? [
            { icon: "/item-link.svg", label: t.link, filter: { roles: ["GM"], every: [{ key: ["metadata", ITEM_LINK_KEY], value: undefined }] } },
            { icon: "/item-link.svg", label: t.open, filter: { roles: ["GM"], some: [{ key: ["metadata", ITEM_LINK_KEY], value: undefined, operator: "!=" }] } },
          ]
        : [{ icon: "/item-link.svg", label: t.open, filter: { roles: ["PLAYER"], some: [{ key: ["metadata", ITEM_SHARED_KEY], value: true }] } }],
      onClick(context) {
        const items = context.items as Item[];
        const linked = items.find((i) => typeof i.metadata[ITEM_LINK_KEY] === "string" && (isGm || i.metadata[ITEM_SHARED_KEY] === true));
        if (!isGm) {
          if (linked) openInPanel(linked);
          return;
        }
        if (linked) openInPanel(linked);
        else request({ action: "link", itemIds: items.map((i) => i.id), names: items.map((i) => itemLabel(i as never, t.unnamed)) });
      },
    });
  }
  function openInPanel(item: Item) {
    request({ action: "open", itemIds: [item.id], names: [itemLabel(item as never, LABELS[language].unnamed)], noteId: item.metadata[ITEM_LINK_KEY] as string });
  }

  // ---- map badges: a local item (this player's own) on each item whose note shows one ----
  let sceneReady = false;
  // The badges drawn: badge id → the item it's on.
  const badgeOf = new Map<string, string>();
  const wantsBadge = (i: Item) =>
    i.metadata[ITEM_ICON_KEY] === true && typeof i.metadata[ITEM_LINK_KEY] === "string" && (gm || (i.metadata[ITEM_SHARED_KEY] === true && i.visible));
  let lastWanted = "";
  let running = false;
  let again = false;
  function scheduleBadges() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void syncBadges().finally(() => {
      running = false;
      if (again) {
        again = false;
        scheduleBadges();
      }
    });
  }
  const wantedKey = (items: Item[]) => items.map((i) => i.id).sort().join(",");
  async function syncBadges() {
    try {
      if (!sceneReady) {
        badgeOf.clear();
        lastWanted = "";
        return;
      }
      const wanted = enabled ? await OBR.scene.items.getItems(wantsBadge) : [];
      const want = new Set(wanted.map((i) => i.id));
      const badges = await OBR.scene.local.getItems((i) => typeof i.metadata[BADGE_KEY] === "string");
      const have = new Set<string>();
      const remove: string[] = [];
      badges.forEach((b) => {
        const on = b.metadata[BADGE_KEY] as string;
        if (want.has(on) && !have.has(on)) have.add(on);
        else remove.push(b.id);
      });
      if (remove.length) await OBR.scene.local.deleteItems(remove);
      const add = wanted.filter((i) => !have.has(i.id));
      let complete = true;
      if (add.length) {
        // The image's own dpi is its width, so at scale 1 it's one cell wide. It goes with the item's
        // scale (drawn at it, then following it as an attachment): on a small token, a small badge.
        const dpi = await OBR.scene.grid.getDpi();
        // Each on its own: an item gone meanwhile (its bounds can't be read) doesn't cost the others.
        const results = await Promise.allSettled(add.map(async (item) => {
          const bounds = await OBR.scene.items.getItemBounds([item.id]);
          const sc = item.scale || { x: 1, y: 1 };
          const k = Math.min(Math.abs(sc.x), Math.abs(sc.y)) || 1;
          const inset = BADGE_INSET_CELLS * dpi * k;
          return buildImage({ url: BADGE_URL, width: BADGE_PX, height: BADGE_PX, mime: "image/png" }, { dpi: BADGE_PX, offset: { x: BADGE_PX / 2, y: BADGE_PX / 2 } })
            .position({ x: bounds.max.x - inset, y: bounds.max.y - inset })
            .scale({ x: BADGE_CELLS * k, y: BADGE_CELLS * k })
            .attachedTo(item.id)
            .layer("ATTACHMENT")
            .locked(true)
            .disableHit(false)
            .disableAttachmentBehavior(["ROTATION"])
            .name("GM Notes")
            .metadata({ [BADGE_KEY]: item.id })
            .build();
        }));
        const built = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        complete = built.length === add.length;
        if (built.length) await OBR.scene.local.addItems(built);
      }
      badgeOf.clear();
      (await OBR.scene.local.getItems((i) => typeof i.metadata[BADGE_KEY] === "string")).forEach((b) => badgeOf.set(b.id, b.metadata[BADGE_KEY] as string));
      // Only once drawn: anything missed is tried again on the next change in the scene.
      lastWanted = complete ? wantedKey(wanted) : "";
    } catch (err) {
      lastWanted = "";
      console.error("Notes: couldn't draw the map badges", err);
    }
  }
  OBR.scene.onReadyChange((ready) => {
    sceneReady = ready;
    scheduleBadges();
  });
  void OBR.scene.isReady().then((ready) => {
    sceneReady = ready;
    scheduleBadges();
  });
  OBR.scene.items.onChange((items) => {
    // Only when which items want a badge changed (moving them doesn't).
    const wanted = enabled ? wantedKey(items.filter(wantsBadge)) : "";
    if (wanted !== lastWanted) scheduleBadges();
  });
  // Something else removed a badge (a scene change, say): drawn again.
  OBR.scene.local.onChange((items) => {
    const drawn = items.filter((i) => typeof i.metadata[BADGE_KEY] === "string").length;
    if (drawn !== badgeOf.size && !running) scheduleBadges();
  });

  // ---- a double click on a badge selects it: the quick view opens instead ----
  let lastSelection = "";
  async function onSelection(selection: string[] | undefined) {
    const key = (selection || []).join(",");
    if (key === lastSelection) return;
    lastSelection = key;
    const badgeId = (selection || []).find((id) => badgeOf.has(id));
    if (!badgeId) return;
    const itemId = badgeOf.get(badgeId)!;
    try {
      await OBR.player.deselect([badgeId]);
      const [[item], bounds] = await Promise.all([OBR.scene.items.getItems([itemId]), OBR.scene.items.getItemBounds([itemId])]);
      if (!item || typeof item.metadata[ITEM_LINK_KEY] !== "string") return;
      // To the item's right, halfway down it (Owlbear keeps it on screen).
      const at = await OBR.viewport.transformPoint({ x: bounds.max.x, y: bounds.center.y });
      const q = new URLSearchParams({ note: item.metadata[ITEM_LINK_KEY] as string, item: item.id, name: itemLabel(item as never, LABELS[language].unnamed) });
      await OBR.popover.open({
        id: PEEK_POPOVER_ID,
        url: "/peek.html?" + q.toString(),
        width: PEEK_W,
        height: PEEK_H,
        anchorReference: "POSITION",
        anchorPosition: { left: Math.round(at.x), top: Math.round(at.y) },
        anchorOrigin: { horizontal: "RIGHT", vertical: "CENTER" },
        transformOrigin: { horizontal: "LEFT", vertical: "CENTER" },
        hidePaper: true,
      });
    } catch (err) {
      console.error("Notes: couldn't open the quick view", err);
    }
  }
  // The quick view's "Open in the panel".
  OBR.broadcast.onMessage(PEEK_CHANNEL, async (event) => {
    const message = event.data as PeekMessage;
    if (!message || message.type !== "open") return;
    void OBR.popover.close(PEEK_POPOVER_ID);
    request({ action: "open", itemIds: [message.itemId], names: [message.name], noteId: message.noteId, ...(message.noteOnly ? { noteOnly: true } : {}) });
  });

  void sync();
  // Player changes include every selection change: sync() only acts when role, language or the
  // switch actually changed.
  OBR.player.onChange((player) => {
    void sync();
    void onSelection(player.selection);
  });
});
