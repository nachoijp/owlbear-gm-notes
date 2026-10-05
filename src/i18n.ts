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
  blockType: string;
  paragraph: string;
  h1: string;
  h2: string;
  h3: string;
  toggle: string;
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
  blankNote: string;
  templatesLabel: string;
  templatesEmpty: string;
  restoreTemplates: string;
  restoreTemplatesHint: string;
  saveAsTemplateTitle: string;
  saveAsTemplateAria: string;
  templateSaved: (title: string) => string;
  renameTemplateTitle: string;
  renameTemplateAria: string;
  deleteTemplateTitle: string;
  deleteTemplateAria: string;
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
  importSuccess: (notes: number, templates: number) => string;
  importNothingNew: string;
  templatesFolder: string;
  clearAllBtn: string;
  clearAllConfirm: (n: number) => string;
  exportFormatTitle: string;
  exportFormatHint: string;
  exportFormatJsonBtn: string;
  exportFormatMdBtn: string;
  settingsCloudLabel: string;
  cloudSyncHint: string;
  cloudSignInBtn: string;
  cloudSignOutBtn: string;
  cloudSyncNowBtn: string;
  cloudSignInError: string;
  cloudSignedOutTitle: string;
  cloudStatusTitle: (status: string) => string;
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
    blankNote: "Nota en blanco",
    templatesLabel: "Plantillas",
    restoreTemplates: "Restaurar plantillas predeterminadas",
    restoreTemplatesHint: "Vuelve a agregar las plantillas predeterminadas que borraste o renombraste. No modifica tus plantillas.",
    templatesEmpty: "Todavía no hay plantillas. Guardá cualquier nota como plantilla con el botón de su fila en la lista de notas.",
    saveAsTemplateTitle: "Guardar como plantilla",
    saveAsTemplateAria: "Guardar como plantilla: ",
    templateSaved: (title) => `Plantilla “${title}” guardada.`,
    renameTemplateTitle: "Renombrar plantilla",
    renameTemplateAria: "Renombrar plantilla ",
    deleteTemplateTitle: "Eliminar plantilla",
    deleteTemplateAria: "Eliminar plantilla ",
    resizeTitle: "Redimensionar panel (doble clic: tamaño por defecto)",
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
    backupHint: "Las notas se guardan en este dispositivo, no en la sala. Exportalas a un archivo para llevarlas a otro dispositivo o como respaldo, e importalas cuando quieras. Exportar todas también incluye tus plantillas.",
    exportAllBtn: "Exportar todas",
    importBtn: "Importar",
    importNoneFound: "No se encontró ninguna nota ni plantilla válida en el/los archivo(s) elegido(s).",
    importSuccess: (notes, templates) => {
      const parts: string[] = [];
      if (notes) parts.push(notes === 1 ? "1 nota" : `${notes} notas`);
      if (templates) parts.push(templates === 1 ? "1 plantilla" : `${templates} plantillas`);
      return `Se importó: ${parts.join(" y ")}.`;
    },
    importNothingNew: "Las plantillas del archivo ya estaban guardadas — no se agregó nada nuevo.",
    templatesFolder: "plantillas",
    clearAllBtn: "Borrar todas las notas",
    clearAllConfirm: (n) => `¿Borrar las ${n} nota(s) guardadas en este dispositivo para esta sala? Esta acción no se puede deshacer — exportalas antes si querés conservarlas.`,
    exportFormatTitle: "Formato de exportación",
    exportFormatHint: "Markdown es texto plano y legible — bueno para llevar una nota a otro lado. JSON conserva todo tal cual y es lo que espera Importar.",
    exportFormatJsonBtn: "JSON",
    exportFormatMdBtn: "Markdown",
    settingsCloudLabel: "Sincronización en la nube",
    cloudSyncHint: "Iniciá sesión con Google para sincronizar tus notas con tu propia cuenta, así te siguen a otro dispositivo. Solo vos podés verlas — iniciar sesión no comparte nada con jugadores ni otros GMs.",
    cloudSignInBtn: "Iniciar sesión con Google",
    cloudSignOutBtn: "Cerrar sesión",
    cloudSyncNowBtn: "Sincronizar ahora",
    cloudSignInError: "No se pudo iniciar sesión. Probá de nuevo.",
    cloudSignedOutTitle: "Sin sincronizar — iniciá sesión en Configuración",
    cloudStatusTitle: (status) => ({
      synced: "Sincronizado con la nube",
      pending: "Cambios pendientes de sincronizar — clic para sincronizar ahora",
      syncing: "Sincronizando…",
      error: "Error al sincronizar — clic para reintentar",
    })[status] || "Sincronización en la nube",
    toolbar: {
      bold: "Negrita (Ctrl+B)", italic: "Cursiva (Ctrl+I)", underline: "Subrayado (Ctrl+U)", strike: "Tachado",
      pill: "Píldora de color", pillNone: "Quitar color", textColor: "Color de texto", textColorNone: "Color por defecto",
      blockType: "Tipo de bloque", paragraph: "Texto normal", h1: "Título 1", h2: "Título 2", h3: "Título 3", toggle: "Desplegable",
      quoteColor: "Cita", quoteColorNone: "Quitar cita", divider: "Línea divisoria",
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
    blankNote: "Blank note",
    templatesLabel: "Templates",
    restoreTemplates: "Restore default templates",
    restoreTemplatesHint: "Adds back the default templates you deleted or renamed. Your own templates aren't changed.",
    templatesEmpty: "No templates yet. Save any note as a template with the button on its row in the notes list.",
    saveAsTemplateTitle: "Save as template",
    saveAsTemplateAria: "Save as template: ",
    templateSaved: (title) => `Saved “${title}” as a template.`,
    renameTemplateTitle: "Rename template",
    renameTemplateAria: "Rename template ",
    deleteTemplateTitle: "Delete template",
    deleteTemplateAria: "Delete template ",
    resizeTitle: "Resize panel (double-click: default size)",
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
    backupHint: "Notes are stored on this device, not in the room. Export them to a file to take them to another device or as a backup, and import them back whenever you want. Export all also includes your templates.",
    exportAllBtn: "Export all",
    importBtn: "Import",
    importNoneFound: "No valid notes or templates were found in the chosen file(s).",
    importSuccess: (notes, templates) => {
      const parts: string[] = [];
      if (notes) parts.push(notes === 1 ? "1 note" : `${notes} notes`);
      if (templates) parts.push(templates === 1 ? "1 template" : `${templates} templates`);
      return `Imported ${parts.join(" and ")}.`;
    },
    importNothingNew: "The templates in the file were already saved — nothing new was added.",
    templatesFolder: "templates",
    clearAllBtn: "Clear all notes",
    clearAllConfirm: (n) => `Delete the ${n} note(s) stored on this device for this room? This can't be undone — export them first if you want to keep them.`,
    exportFormatTitle: "Export format",
    exportFormatHint: "Markdown is plain, readable text — good for taking a note elsewhere. JSON keeps everything exactly as-is and is what Import expects back.",
    exportFormatJsonBtn: "JSON",
    exportFormatMdBtn: "Markdown",
    settingsCloudLabel: "Cloud sync",
    cloudSyncHint: "Sign in with Google to sync your notes to your own account, so they follow you to another device. Only you can see them — signing in does not share anything with players or other GMs.",
    cloudSignInBtn: "Sign in with Google",
    cloudSignOutBtn: "Sign out",
    cloudSyncNowBtn: "Sync now",
    cloudSignInError: "Couldn't sign in. Please try again.",
    cloudSignedOutTitle: "Not syncing — sign in from Settings",
    cloudStatusTitle: (status) => ({
      synced: "Synced with the cloud",
      pending: "Changes waiting to sync — click to sync now",
      syncing: "Syncing…",
      error: "Sync failed — click to retry",
    })[status] || "Cloud sync",
    toolbar: {
      bold: "Bold (Ctrl+B)", italic: "Italic (Ctrl+I)", underline: "Underline (Ctrl+U)", strike: "Strikethrough",
      pill: "Color pill", pillNone: "Remove color", textColor: "Text color", textColorNone: "Default color",
      blockType: "Block type", paragraph: "Normal text", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", toggle: "Toggle",
      quoteColor: "Quote", quoteColorNone: "Remove quote", divider: "Divider",
      bulletList: "Bullet list", numberList: "Numbered list", outdent: "Decrease indent",
      indent: "Increase indent (sub-list)", removeFormat: "Clear formatting",
    },
  },
};

export function getStrings(language: Language): Strings {
  return STRINGS[language];
}
