// Export (JSON or Markdown, one file or a zip) and import (JSON, Markdown, zips of either) of notes
// and templates. Works on plain values; main.ts owns the state and decides what to do with the result.
import JSZip from "jszip";
import { sanitizeNote } from "./notes";
import type { Note } from "./notes";
import { sanitizeTemplate } from "./templates";
import type { Template } from "./templates";
import { sanitizeNoteHtml } from "./sanitizeHtml";
import { htmlToMarkdown, markdownToHtml } from "./markdown";

interface NoteExportFile {
  type: "gm-notes-note";
  version: 1;
  id: string;
  title: string;
  html: string;
  updatedAt: number;
}
function noteToExportPayload(note: Note): NoteExportFile {
  return { type: "gm-notes-note", version: 1, id: note.id, title: note.title, html: note.html, updatedAt: note.updatedAt };
}
// A built-in template is exported as just its marker (empty title/html) — it carries no text of its
// own, and whichever GM Notes imports it already knows its text in every language.
interface TemplateExportFile {
  type: "gm-notes-template";
  version: 1;
  id: string;
  title: string;
  html: string;
  updatedAt: number;
  builtin?: Template["builtin"];
}
function templateToExportPayload(template: Template): TemplateExportFile {
  return {
    type: "gm-notes-template",
    version: 1,
    id: template.id,
    title: template.title,
    html: template.html,
    updatedAt: template.updatedAt,
    ...(template.builtin ? { builtin: template.builtin } : {}),
  };
}
// Templates travel inside an "export all" zip in their own folder, which is also how import tells a
// template's Markdown file apart from a note's (a .md file has nowhere else to say what it is).
// Folder names in both languages are recognized, since the export uses the exporting GM's language.
const TEMPLATE_FOLDER_NAMES = ["plantillas", "templates"];
function isInTemplateFolder(zipPath: string): boolean {
  const parts = zipPath.split("/");
  return parts.length > 1 && TEMPLATE_FOLDER_NAMES.includes(parts[0].toLowerCase());
}
// A freshly-imported note always gets a brand-new id, even if the file still carries its original
// one (kept only so a future "was this already imported" check has something to compare) — re-importing
// the same export twice, or importing into a DIFFERENT room's notes that happens to reuse an id, must
// never silently overwrite an existing note.
function freshNoteId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "n" + Date.now() + Math.random().toString(36).slice(2);
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
// Filesystem-safe stand-in for a note title, used as an export filename (and, inside a zip, an entry
// name) — titles are free text and can contain characters no filesystem allows.
function safeFileName(title: string, untitled: string): string {
  const cleaned = title.trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
  return cleaned || untitled;
}

export type ExportFormat = "json" | "markdown";

export function exportNote(note: Note, format: ExportFormat, untitled: string) {
  if (format === "json") {
    const blob = new Blob([JSON.stringify(noteToExportPayload(note), null, 2)], { type: "application/json" });
    downloadBlob(blob, safeFileName(note.title, untitled) + ".json");
  } else {
    const blob = new Blob([htmlToMarkdown(note.html)], { type: "text/markdown" });
    downloadBlob(blob, safeFileName(note.title, untitled) + ".md");
  }
}

export interface ExportAllOptions {
  untitled: string;
  // The zip folder templates go in (named in the exporting GM's language).
  templatesFolder: string;
  // A template's file name: a built-in is named after its current-language title, for readability.
  templateTitle: (t: Template) => string;
}

export async function exportAll(notes: Note[], templates: Template[], format: ExportFormat, opts: ExportAllOptions) {
  // Markdown is plain text — a built-in template's language-following marker can't survive it, and
  // every GM Notes install already has the built-ins anyway, so only the GM's own templates go there.
  const exportedTemplates = format === "json" ? templates : templates.filter((t) => !t.builtin);
  if (!notes.length && !exportedTemplates.length) return;
  if (notes.length === 1 && !exportedTemplates.length) {
    exportNote(notes[0], format, opts.untitled);
    return;
  }
  const zip = new JSZip();
  const ext = format === "json" ? ".json" : ".md";
  function addUnique(usedNames: Set<string>, folder: string, title: string, content: string) {
    const base = safeFileName(title, opts.untitled);
    let name = base;
    let i = 2;
    while (usedNames.has(name)) name = `${base}-${i++}`;
    usedNames.add(name);
    zip.file(folder + name + ext, content);
  }
  const noteNames = new Set<string>();
  notes.forEach((n) => {
    const content = format === "json" ? JSON.stringify(noteToExportPayload(n), null, 2) : htmlToMarkdown(n.html);
    addUnique(noteNames, "", n.title, content);
  });
  const templateNames = new Set<string>();
  const folder = opts.templatesFolder + "/";
  exportedTemplates.forEach((t) => {
    const content = format === "json" ? JSON.stringify(templateToExportPayload(t), null, 2) : htmlToMarkdown(t.html);
    addUnique(templateNames, folder, opts.templateTitle(t), content);
  });
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, "gm-notes-export.zip");
}

// Accepts anything sanitizeNote() would accept from room metadata (so a hand-edited or older-format
// file still imports), not just our own NoteExportFile shape.
function parseImportedNote(json: string): Note | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const sanitized = sanitizeNote(data);
  return sanitized ? { ...sanitized, html: sanitizeNoteHtml(sanitized.html), id: freshNoteId() } : null;
}

// A Markdown file carries no title/id of its own — the filename (minus extension) becomes the title,
// and its text runs through the SAME parser the paste handler uses, so a note round-tripped out as
// Markdown and back in comes back as real formatting, not literal "**"/"#"/"-" markers.
function noteFromMarkdownFile(filename: string, text: string, untitled: string): Note {
  const title = filename.replace(/\.md$/i, "").trim();
  return { id: freshNoteId(), title: title || untitled, html: markdownToHtml(text), updatedAt: Date.now() };
}

// A JSON file is a template if it says so (type "gm-notes-template", wherever it sits), or if it sits
// in a zip's templates folder.
function parseImportedTemplate(json: string, inTemplateFolder: boolean): Template | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const declared = (data as { type?: unknown } | null)?.type === "gm-notes-template";
  if (!declared && !inTemplateFolder) return null;
  const sanitized = sanitizeTemplate(data);
  return sanitized ? { ...sanitized, html: sanitizeNoteHtml(sanitized.html), id: "t" + freshNoteId() } : null;
}

export interface ImportedContent {
  notes: Note[];
  templates: Template[];
}

async function importFromJsonText(json: string, inTemplateFolder: boolean, into: ImportedContent) {
  const template = parseImportedTemplate(json, inTemplateFolder);
  if (template) {
    into.templates.push(template);
    return;
  }
  const note = parseImportedNote(json);
  if (note) into.notes.push(note);
}

export async function contentFromImportFile(file: File, untitled: string): Promise<ImportedContent> {
  const result: ImportedContent = { notes: [], templates: [] };
  if (/\.zip$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(file);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const entryName = entry.name.split("/").pop() || entry.name;
      const inTemplateFolder = isInTemplateFolder(entry.name);
      if (/\.json$/i.test(entryName)) {
        await importFromJsonText(await entry.async("text"), inTemplateFolder, result);
      } else if (/\.md$/i.test(entryName)) {
        const fromMarkdown = noteFromMarkdownFile(entryName, await entry.async("text"), untitled);
        if (inTemplateFolder) result.templates.push({ ...fromMarkdown, id: "t" + freshNoteId() });
        else result.notes.push(fromMarkdown);
      }
    }
    return result;
  }
  if (/\.md$/i.test(file.name)) {
    result.notes.push(noteFromMarkdownFile(file.name, await file.text(), untitled));
    return result;
  }
  await importFromJsonText(await file.text(), false, result);
  return result;
}

// Re-importing the same export (or one from another browser that also has the built-ins) mustn't
// pile up copies: a built-in is skipped if this browser already has that built-in, and a custom
// template if one with the exact same title and body already exists.
export function isDuplicateTemplate(candidate: Template, existing: Template[]): boolean {
  return existing.some((t) =>
    candidate.builtin
      ? t.builtin === candidate.builtin
      : !t.builtin && t.title === candidate.title && t.html === candidate.html
  );
}
