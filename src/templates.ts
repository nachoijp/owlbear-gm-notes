import localforage from "localforage";
import { getPluginId } from "./pluginId";
import { sanitizeNote } from "./notes";
import type { Note } from "./notes";
import type { Language } from "./i18n";

export type BuiltinTemplateId = "npc" | "location" | "sessionPrep" | "sessionRecap";
const BUILTIN_IDS: BuiltinTemplateId[] = ["npc", "location", "sessionPrep", "sessionRecap"];

// A template is a saved note body to start new notes from — the same shape as a Note, plus an
// optional `builtin` id. A built-in template stores no text of its own: its title and body come from
// DEFAULTS in whatever language the GM has chosen right now (see resolveTemplate), so switching
// language translates it. A note created from it copies the text once, in that moment's language, and
// never changes afterwards. Renaming a built-in turns it into an ordinary template (see
// toCustomTemplate); deleting it removes it in every language, since it's one stored entry.
export type Template = Note & { builtin?: BuiltinTemplateId };

// Templates are global to this browser, not per room like notes: a "NPC" or "Session recap" layout
// is useful in every campaign, so the GM shouldn't have to recreate it in each room. Same IndexedDB
// database as notes, under a key that isn't scoped by room id.
const store = localforage.createInstance({ name: getPluginId("notes-db") });
const TEMPLATES_KEY = "templates";

function isBuiltinId(value: unknown): value is BuiltinTemplateId {
  return typeof value === "string" && (BUILTIN_IDS as string[]).includes(value);
}

export function sanitizeTemplate(value: unknown): Template | undefined {
  const note = sanitizeNote(value);
  if (!note) return undefined;
  const builtin = (value as { builtin?: unknown }).builtin;
  return isBuiltinId(builtin) ? { ...note, builtin } : note;
}

function sanitizeTemplates(value: unknown): Template[] {
  if (!Array.isArray(value)) return [];
  return value.map(sanitizeTemplate).filter((t): t is Template => t !== undefined);
}

/** Built-ins seeded by the first version of this feature were stored as plain text in the language
 * of that moment. Any that still match a built-in's text exactly (in either language) are turned
 * back into language-following built-ins; one the GM has already renamed no longer matches and is
 * left as their own. Returns whether anything changed. */
function migrateSeededTextToBuiltins(templates: Template[]): boolean {
  let changed = false;
  for (const template of templates) {
    if (template.builtin) continue;
    const match = BUILTIN_IDS.find((id) =>
      (Object.keys(DEFAULTS[id]) as Language[]).some(
        (lang) => DEFAULTS[id][lang].title === template.title && DEFAULTS[id][lang].html === template.html
      )
    );
    if (match) {
      template.builtin = match;
      template.title = "";
      template.html = "";
      changed = true;
    }
  }
  return changed;
}

/** The title and body to show / copy right now: a built-in's text in the current language, or the
 * template's own stored text. */
export function resolveTemplate(template: Template, language: Language): { title: string; html: string } {
  return template.builtin ? DEFAULTS[template.builtin][language] : { title: template.title, html: template.html };
}

/** A built-in being renamed becomes the GM's own: it keeps the body it currently shows (in the
 * current language) and stops following language changes. */
export function toCustomTemplate(template: Template, language: Language): void {
  if (!template.builtin) return;
  const { html } = resolveTemplate(template, language);
  template.html = html;
  delete template.builtin;
}

/** Returns the stored templates. The very first time (nothing stored yet), seeds the four
 * built-ins — after that an empty list stays empty (deleting every template doesn't bring the
 * built-ins back). */
export async function getTemplates(): Promise<Template[]> {
  const stored = await store.getItem<unknown>(TEMPLATES_KEY);
  if (stored !== null && stored !== undefined) {
    const templates = sanitizeTemplates(stored);
    if (migrateSeededTextToBuiltins(templates)) {
      await store.setItem(TEMPLATES_KEY, templates);
    }
    return templates;
  }
  const seeded = defaultTemplates();
  await store.setItem(TEMPLATES_KEY, seeded);
  return seeded;
}

export async function setTemplates(templates: Template[]): Promise<void> {
  await store.setItem(TEMPLATES_KEY, templates);
}

// ---------- built-in templates ----------
// Plain blocks the editor already produces (h2, p, ul/li, strong), so a note started from one
// behaves exactly like one typed by hand.

function section(title: string, body: string): string {
  return `<h2>${title}</h2>${body}`;
}
function fields(labels: string[]): string {
  return `<ul>${labels.map((label) => `<li><strong>${label}:</strong> </li>`).join("")}</ul>`;
}
const EMPTY_LIST = "<ul><li><br></li></ul>";
const EMPTY_PARAGRAPH = "<p><br></p>";

type TemplateSpec = { title: string; html: string };

const DEFAULTS: Record<BuiltinTemplateId, Record<Language, TemplateSpec>> = {
  npc: {
    es: {
      title: "PNJ",
      html:
        section("Resumen", fields(["Rol", "Apariencia", "Personalidad", "Voz o tic"])) +
        section("Motivación", fields(["Qué quiere", "Qué teme"])) +
        section("Qué sabe o esconde", EMPTY_LIST) +
        section("Relaciones", EMPTY_LIST) +
        section("Notas", EMPTY_PARAGRAPH),
    },
    en: {
      title: "NPC",
      html:
        section("Overview", fields(["Role", "Appearance", "Personality", "Voice or quirk"])) +
        section("Motivation", fields(["Wants", "Fears"])) +
        section("Knows or hides", EMPTY_LIST) +
        section("Relationships", EMPTY_LIST) +
        section("Notes", EMPTY_PARAGRAPH),
    },
  },
  location: {
    es: {
      title: "Lugar",
      html:
        section("Primera impresión", fields(["Vista", "Sonido", "Olor"])) +
        section("Quién está aquí", EMPTY_LIST) +
        section("Qué está pasando", EMPTY_PARAGRAPH) +
        section("Secretos", EMPTY_LIST) +
        section("Ganchos", EMPTY_LIST),
    },
    en: {
      title: "Location",
      html:
        section("First impression", fields(["Sight", "Sound", "Smell"])) +
        section("Who's here", EMPTY_LIST) +
        section("What's happening", EMPTY_PARAGRAPH) +
        section("Secrets", EMPTY_LIST) +
        section("Hooks", EMPTY_LIST),
    },
  },
  sessionPrep: {
    es: {
      title: "Preparación de sesión",
      html:
        section("Inicio", EMPTY_PARAGRAPH) +
        section("Escenas posibles", EMPTY_LIST) +
        section("Secretos y pistas", EMPTY_LIST) +
        section("PNJs", EMPTY_LIST) +
        section("Lugares", EMPTY_LIST) +
        section("Recompensas", EMPTY_LIST),
    },
    en: {
      title: "Session prep",
      html:
        section("Opening", EMPTY_PARAGRAPH) +
        section("Possible scenes", EMPTY_LIST) +
        section("Secrets and clues", EMPTY_LIST) +
        section("NPCs", EMPTY_LIST) +
        section("Locations", EMPTY_LIST) +
        section("Rewards", EMPTY_LIST),
    },
  },
  sessionRecap: {
    es: {
      title: "Resumen de sesión",
      html:
        section("Sesión", fields(["Fecha", "Participantes"])) +
        section("Qué pasó", EMPTY_PARAGRAPH) +
        section("Decisiones importantes", EMPTY_LIST) +
        section("Botín y recompensas", EMPTY_LIST) +
        section("Hilos abiertos", EMPTY_LIST),
    },
    en: {
      title: "Session recap",
      html:
        section("Session", fields(["Date", "Players"])) +
        section("What happened", EMPTY_PARAGRAPH) +
        section("Key decisions", EMPTY_LIST) +
        section("Loot and rewards", EMPTY_LIST) +
        section("Open threads", EMPTY_LIST),
    },
  },
};

function defaultTemplates(): Template[] {
  const now = Date.now();
  return BUILTIN_IDS.map((builtin, index) => ({
    id: `t${now}-${index}`,
    title: "",
    html: "",
    updatedAt: now,
    builtin,
  }));
}
