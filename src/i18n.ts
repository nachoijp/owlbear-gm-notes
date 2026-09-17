export type Language = "es" | "en";

export interface ToolbarStrings {
  bold: string;
  italic: string;
  underline: string;
  strike: string;
  pill: string;
  pillNone: string;
  textColor: string;
  textColorNone: string;
  h1: string;
  h2: string;
  quoteColor: string;
  quoteColorNone: string;
  divider: string;
  bulletList: string;
  numberList: string;
  outdent: string;
  indent: string;
  removeFormat: string;
}

export interface Strings {
  notesLabel: string;
  searchPlaceholder: string;
  newNoteTitle: string;
  settingsTitle: string;
  gmGateSub: string;
  emptySearch: string;
  emptyList: string;
  untitled: string;
  emptyNote: string;
  renameTitle: string;
  renameAria: string;
  deleteTitle: string;
  deleteAria: string;
  editedAgo: string;
  timeNow: string;
  timeMin: string;
  timeHour: string;
  timeDay: string;
  editorEmpty: string;
  titlePlaceholder: string;
  bodyPlaceholder: string;
  savedPrefix: string;
  savedInstant: string;
  savingLabel: string;
  wordsCount: (n: number) => string;
  newNoteDefaultTitle: string;
  resizeTitle: string;
  settingsClose: string;
  settingsAccentLabel: string;
  settingsLangLabel: string;
  settingsStorageLabel: string;
  storageMeterText: (usedKB: string) => string;
  storageBannerGeneric: string;
  accentAutoTitle: string;
  exportTitle: string;
  exportAria: string;
  settingsBackupLabel: string;
  backupHint: string;
  exportAllBtn: string;
  importBtn: string;
  importNoneFound: string;
  importSuccess: (n: number) => string;
  clearAllBtn: string;
  clearAllConfirm: (n: number) => string;
  toolbar: ToolbarStrings;
}

const STRINGS: Record<Language, Strings> = {
  es: {
    notesLabel: "Notas",
    searchPlaceholder: "Buscar notas…",
    newNoteTitle: "Nueva nota",
    settingsTitle: "Configuración",
    gmGateSub: "Acceso de GM requerido.",
    emptySearch: "Sin resultados para tu búsqueda.",
    emptyList: "Todavía no hay notas.<br>Creá la primera con el botón “+”.",
    untitled: "Sin título",
    emptyNote: "Nota vacía",
    renameTitle: "Renombrar nota",
    renameAria: "Renombrar ",
    deleteTitle: "Eliminar nota",
    deleteAria: "Eliminar ",
    editedAgo: "editado hace ",
    timeNow: "ahora",
    timeMin: " min",
    timeHour: " h",
    timeDay: " d",
    editorEmpty: "Seleccioná una nota, o creá una nueva con el botón “+” para empezar a escribir.",
    titlePlaceholder: "Título de la nota",
    bodyPlaceholder: "Escribí aquí las notas de tu partida…",
    savedPrefix: "Guardado hace ",
    savedInstant: "un instante",
    savingLabel: "Guardando…",
    wordsCount: (n) => n + (n === 1 ? " palabra" : " palabras"),
    newNoteDefaultTitle: "Nueva nota",
    resizeTitle: "Redimensionar panel",
    settingsClose: "Cerrar",
    settingsAccentLabel: "Color de acento",
    settingsLangLabel: "Idioma",
    settingsStorageLabel: "Espacio usado en este dispositivo",
    storageMeterText: (usedKB) => `${usedKB} KB`,
    storageBannerGeneric: "No se pudo guardar el último cambio. Si estás en una ventana privada o con el almacenamiento del navegador bloqueado, probá desactivarlo para esta página.",
    accentAutoTitle: "Automático (seguir Owlbear)",
    exportTitle: "Exportar nota",
    exportAria: "Exportar ",
    settingsBackupLabel: "Respaldo de notas",
    backupHint: "Las notas se guardan en este dispositivo, no en la sala. Exportalas a un archivo para llevarlas a otro dispositivo o como respaldo, e importalas cuando quieras.",
    exportAllBtn: "Exportar todas",
    importBtn: "Importar",
    importNoneFound: "No se encontró ninguna nota válida en el/los archivo(s) elegido(s).",
    importSuccess: (n) => n === 1 ? "Se importó 1 nota." : `Se importaron ${n} notas.`,
    clearAllBtn: "Borrar todas las notas",
    clearAllConfirm: (n) => `¿Borrar las ${n} nota(s) guardadas en este dispositivo para esta sala? Esta acción no se puede deshacer — exportalas antes si querés conservarlas.`,
    toolbar: {
      bold: "Negrita (Ctrl+B)", italic: "Cursiva (Ctrl+I)", underline: "Subrayado (Ctrl+U)", strike: "Tachado",
      pill: "Píldora de color", pillNone: "Quitar color", textColor: "Color de texto", textColorNone: "Color por defecto",
      h1: "Título", h2: "Subtítulo", quoteColor: "Cita", quoteColorNone: "Quitar cita", divider: "Línea divisoria",
      bulletList: "Lista", numberList: "Lista numerada", outdent: "Reducir sangría",
      indent: "Aumentar sangría (sub-lista)", removeFormat: "Quitar formato",
    },
  },
  en: {
    notesLabel: "Notes",
    searchPlaceholder: "Search notes…",
    newNoteTitle: "New note",
    settingsTitle: "Settings",
    gmGateSub: "GM access required.",
    emptySearch: "No results for your search.",
    emptyList: "No notes yet.<br>Create the first one with the “+” button.",
    untitled: "Untitled",
    emptyNote: "Empty note",
    renameTitle: "Rename note",
    renameAria: "Rename ",
    deleteTitle: "Delete note",
    deleteAria: "Delete ",
    editedAgo: "edited ",
    timeNow: "now",
    timeMin: "m ago",
    timeHour: "h ago",
    timeDay: "d ago",
    editorEmpty: "Select a note, or create a new one with the “+” button to start writing.",
    titlePlaceholder: "Note title",
    bodyPlaceholder: "Write your session notes here…",
    savedPrefix: "Saved ",
    savedInstant: "a moment ago",
    savingLabel: "Saving…",
    wordsCount: (n) => n + (n === 1 ? " word" : " words"),
    newNoteDefaultTitle: "New note",
    resizeTitle: "Resize panel",
    settingsClose: "Close",
    settingsAccentLabel: "Accent color",
    settingsLangLabel: "Language",
    settingsStorageLabel: "Storage used on this device",
    storageMeterText: (usedKB) => `${usedKB} KB`,
    storageBannerGeneric: "Couldn't save your last change. If you're in a private window or have browser storage blocked, try allowing it for this page.",
    accentAutoTitle: "Auto (follow Owlbear)",
    exportTitle: "Export note",
    exportAria: "Export ",
    settingsBackupLabel: "Notes backup",
    backupHint: "Notes are stored on this device, not in the room. Export them to a file to take them to another device or as a backup, and import them back whenever you want.",
    exportAllBtn: "Export all",
    importBtn: "Import",
    importNoneFound: "No valid notes were found in the chosen file(s).",
    importSuccess: (n) => n === 1 ? "Imported 1 note." : `Imported ${n} notes.`,
    clearAllBtn: "Clear all notes",
    clearAllConfirm: (n) => `Delete the ${n} note(s) stored on this device for this room? This can't be undone — export them first if you want to keep them.`,
    toolbar: {
      bold: "Bold (Ctrl+B)", italic: "Italic (Ctrl+I)", underline: "Underline (Ctrl+U)", strike: "Strikethrough",
      pill: "Color pill", pillNone: "Remove color", textColor: "Text color", textColorNone: "Default color",
      h1: "Heading", h2: "Subheading", quoteColor: "Quote", quoteColorNone: "Remove quote", divider: "Divider",
      bulletList: "Bullet list", numberList: "Numbered list", outdent: "Decrease indent",
      indent: "Increase indent (sub-list)", removeFormat: "Clear formatting",
    },
  },
};

export function getStrings(language: Language): Strings {
  return STRINGS[language];
}
