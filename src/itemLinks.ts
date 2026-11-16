// Map items linked to a note (see background.ts and main.ts). Each item holds at most one note's id
// in its metadata. The context menu lives in the background page, the note picker in the panel. The
// menu's request reaches the panel as an Owlbear message to this player's own pages (destination
// LOCAL): sent when the menu is used, and again whenever the panel asks for it ("hello", on loading
// or opening), since the panel may not be loaded yet when it's first sent. The panel answers "taken".
// localStorage carries it too, where Owlbear lets the two pages share it.
import { getPluginId } from "./pluginId";

export const ITEM_LINK_KEY = getPluginId("note");
// Set (true) on a linked item while its note is shared with players (visible or public), so the
// background page can offer them "Open note" without asking Firebase. Kept by the note's GM (main.ts).
export const ITEM_SHARED_KEY = getPluginId("shared-note");
// Set (true) on a linked item while its note has "Icon on the map" on (Note.mapIcon): each player's
// background page then draws a badge on it (a local item, BADGE_KEY), and a double click on the badge
// opens the note's quick view (peek.html). Players get it only on items that are also shared.
export const ITEM_ICON_KEY = getPluginId("map-icon");
export const BADGE_KEY = getPluginId("badge");
export const PEEK_POPOVER_ID = getPluginId("peek");
// The quick view asks the panel for the note (the panel has the notes, or the player's shared ones)
// and asks the background page to open it in the panel.
export const PEEK_CHANNEL = getPluginId("peek");
export interface PeekNote {
  title: string;
  html: string;
  /** The GM's own note: its hidden parts are boxed, as in the panel. */
  gm: boolean;
}
export type PeekMessage =
  | { type: "want"; noteId: string; nonce: string }
  | { type: "note"; nonce: string; note: PeekNote | null }
  | { type: "open"; noteId: string; itemId: string; name: string; noteOnly: boolean };
export const ITEM_LINKS_PREF_KEY = getPluginId("itemLinks");
const PENDING_KEY = getPluginId("pending-item-link");
// A request older than this was never picked up (the panel didn't open): it's dropped.
const PENDING_TTL_MS = 60 * 1000;
export const ITEM_LINK_CHANNEL = getPluginId("item-link");
export type ItemLinkMessage = { type: "request"; request: ItemLinkRequest } | { type: "hello" } | { type: "taken"; at: number };
export function isFreshRequest(r: ItemLinkRequest | null | undefined): r is ItemLinkRequest {
  return !!r && (r.action === "link" || r.action === "open") && Array.isArray(r.itemIds) && r.itemIds.length > 0 && typeof r.at === "number" && Date.now() - r.at <= PENDING_TTL_MS;
}

export interface ItemLinkRequest {
  action: "link" | "open";
  itemIds: string[];
  names: string[];
  noteId?: string;
  /** Opening a note reached from a quick view's link: the item isn't linked to it, so nothing about
   * the item (unlinking it) is offered. */
  noteOnly?: boolean;
  at: number;
}

export function writeItemLinkRequest(request: ItemLinkRequest) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(request));
  } catch {
    /* storage blocked or not shared: the message carries it */
  }
}

/** Takes the pending request, if there's a fresh one (it's removed either way). */
export function takeItemLinkRequest(): ItemLinkRequest | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PENDING_KEY);
    if (raw) localStorage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as ItemLinkRequest;
    return isFreshRequest(r) ? r : null;
  } catch {
    return null;
  }
}
export function isItemLinkRequestKey(key: string | null): boolean {
  return key === PENDING_KEY;
}

/** A map item's name, for the panel's messages and chips. */
export function itemLabel(item: { name?: string; text?: { plainText?: string } }, fallback: string): string {
  const name = (item.name || "").trim() || (item.text && item.text.plainText ? item.text.plainText.trim() : "");
  return name.length > 40 ? name.slice(0, 39) + "…" : name || fallback;
}
