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
  table: string;
  tableSize: (cols: number, rows: number) => string;
  tableOptions: string;
  tableRowAbove: string;
  tableRowBelow: string;
  tableColLeft: string;
  tableColRight: string;
  tableRowUp: string;
  tableRowDown: string;
  tableRowDrag: string;
  tableColMoveLeft: string;
  tableColMoveRight: string;
  tableColDrag: string;
  tableMove: string;
  tableWidths: string;
  tableDeleteRow: string;
  tableDeleteCol: string;
  tableMergeRight: string;
  tableMergeDown: string;
  tableSplit: string;
  tableDistribute: string;
  tableFitContent: string;
  tableFitFrame: string;
  tableColor: string;
  tableColorCell: string;
  tableColorRow: string;
  tableColorCol: string;
  tableColorNone: string;
  tableHeaderRow: string;
  tableHeaderCol: string;
  tableDelete: string;
  listMenu: string;
  bulletList: string;
  checkList: string;
  numberList: string;
  outdent: string;
  indent: string;
  removeFormat: string;
  secret: string;
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
  pinTitle: string;
  unpinTitle: string;
  sortRecent: string;
  sortAlpha: string;
  sortTitle: string;
  moreActions: string;
  duplicateNote: string;
  copySuffix: string;
  newFolder: string;
  newFolderTitle: string;
  newNoteHere: string;
  newSubfolder: string;
  renameFolder: string;
  folderActions: string;
  folderNotes: (n: number) => string;
  moveTo: string;
  noFolder: string;
  deleteFolder: string;
  deleteFolderConfirm: (name: string, notes: number, subfolders: number) => string;
  renameAria: string;
  deleteTitle: string;
  trashLink: (n: number) => string;
  trashTitle: string;
  trashBack: string;
  trashEmptyBtn: string;
  trashEmptyConfirm: (n: number) => string;
  trashEmptyList: string;
  trashRestoreTitle: string;
  trashDeleteTitle: string;
  trashDeleteConfirm: (title: string) => string;
  trashDeletedAgo: string;
  trashExpiresIn: (days: number) => string;
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
  settingsInfo: string;
  linkPickerTitle: string;
  linkPickerEmpty: string;
  linkOpen: (title: string) => string;
  linkTrashed: string;
  linkMissing: string;
  settingsAccentLabel: string;
  settingsLangLabel: string;
  settingsHelpLabel: string;
  helpHint: string;
  helpLink: string;
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
  brandVisible: string;
  brandEditable: string;
  shareMenuTitle: string;
  shareModePrivate: string;
  shareModePrivateHint: string;
  shareModeVisible: string;
  shareModeVisibleHint: string;
  shareModeEditable: string;
  shareModeEditableHint: string;
  publishSignedOutTitle: string;
  publishConfirmTitle: string;
  publishConfirmHint: string;
  publishConfirmSecret: (n: number) => string;
  publishConfirmBtn: string;
  publishCancelBtn: string;
  publishError: string;
  publishEditableConfirmTitle: string;
  publishEditableConfirmHint: string;
  publishEditableConfirmSecret: (n: number) => string;
  publishEditableConfirmShowBtn: string;
  publicDotTitle: string;
  editableDotTitle: string;
  editableDotPlayerTitle: string;
  lockedBy: (name: string) => string;
  finishEditing: string;
  finishEditingTitle: string;
  someone: string;
  editableSignedOut: string;
  undoPlayerEdits: string;
  undoPlayerEditsBusy: (name: string) => string;
  settingsItemLinksLabel: string;
  itemLinksHint: string;
  itemLinksOnBtn: string;
  itemLinksOffBtn: string;
  itemPickBanner: (name: string, more: number) => string;
  itemPickCancel: string;
  linkedItemsLabel: string;
  connectionsTitle: string;
  linkedFrom: string;
  linkedItemSelect: string;
  linkedItemUnlink: string;
  itemNoteTrashed: (title: string) => string;
  itemNoteMissing: (name: string) => string;
  unnamedItem: string;
  settingsSecretLabel: string;
  secretEyeHint: string;
  secretEyeClickBtn: string;
  secretEyeLockBtn: string;
  secretEyeShow: string;
  secretEyeLocked: string;
  settingsSharedLabel: string;
  sharedKeyHint: string;
  regenerateKeyBtn: string;
  regenerateKeyConfirm: string;
  regenerateKeyError: string;
  signOutPublicTitle: string;
  signOutPublicHint: (n: number) => string;
  signOutUnpublishBtn: (n: number) => string;
  signOutKeepBtn: (n: number) => string;
  sharedLoading: string;
  sharedEmpty: string;
  sharedLoadError: string;
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
    pinTitle: "Fijar arriba",
    unpinTitle: "Dejar de fijar",
    sortRecent: "Recientes",
    sortAlpha: "A–Z",
    sortTitle: "Cambiar el orden de la lista",
    moreActions: "Más acciones",
    duplicateNote: "Duplicar",
    newFolder: "Nueva carpeta",
    newFolderTitle: "Crear una carpeta para ordenar las notas",
    newNoteHere: "Nueva nota aquí",
    newSubfolder: "Nueva subcarpeta",
    renameFolder: "Renombrar",
    folderActions: "Acciones de la carpeta",
    folderNotes: (n) => (n === 1 ? "1 nota" : `${n} notas`),
    moveTo: "Mover a…",
    noFolder: "Sin carpeta",
    deleteFolder: "Borrar carpeta",
    deleteFolderConfirm: (name, notes, subfolders) => {
      const parts = [notes === 1 ? "1 nota" : notes ? `${notes} notas` : "", subfolders === 1 ? "1 subcarpeta" : subfolders ? `${subfolders} subcarpetas` : ""].filter(Boolean);
      if (!parts.length) return `¿Borrar la carpeta «${name}»? Está vacía.`;
      return `¿Borrar la carpeta «${name}» con todo lo que tiene (${parts.join(" y ")})?` + (notes ? " Las notas van a la papelera y podés restaurarlas durante 30 días." : "");
    },
    copySuffix: " (copia)",
    renameAria: "Renombrar ",
    deleteTitle: "Mover a la papelera",
    trashLink: (n) => `Papelera (${n})`,
    trashTitle: "Papelera",
    trashBack: "Volver a las notas",
    trashEmptyBtn: "Vaciar papelera",
    trashEmptyConfirm: (n) => (n === 1 ? "¿Eliminar para siempre la nota de la papelera? No se puede deshacer." : `¿Eliminar para siempre las ${n} notas de la papelera? No se puede deshacer.`),
    trashEmptyList: "La papelera está vacía.",
    trashRestoreTitle: "Restaurar",
    trashDeleteTitle: "Eliminar para siempre",
    trashDeleteConfirm: (title) => `¿Eliminar para siempre “${title}”? No se puede deshacer.`,
    trashDeletedAgo: "borrada hace ",
    trashExpiresIn: (d) => (d <= 1 ? " · último día" : ` · quedan ${d} días`),
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
    settingsInfo: "Más información",
    linkPickerTitle: "Enlazar a una nota",
    linkPickerEmpty: "Ninguna nota coincide",
    linkOpen: (t) => `Abrir «${t}»`,
    linkTrashed: "Esta nota está en la papelera",
    linkMissing: "Esta nota ya no existe",
    settingsAccentLabel: "Color de acento",
    settingsLangLabel: "Idioma",
    settingsHelpLabel: "Ayuda",
    helpHint: "Abre el manual de GM Notes (el README en GitHub) en una pestaña nueva.",
    helpLink: "Ver manual",
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
    clearAllConfirm: (n) => (n === 1 ? "¿Mover la nota de esta sala a la papelera? Podés restaurarla durante 30 días." : `¿Mover las ${n} notas de esta sala a la papelera? Podés restaurarlas durante 30 días.`),
    brandVisible: "Visible",
    brandEditable: "Pública",
    shareMenuTitle: "Compartir esta nota con los jugadores",
    shareModePrivate: "Privada",
    shareModePrivateHint: "Solo vos la ves",
    shareModeVisible: "Visible",
    shareModeVisibleHint: "Los jugadores la leen",
    shareModeEditable: "Pública",
    shareModeEditableHint: "Los jugadores la editan, de a uno",
    publishSignedOutTitle: "Para compartir notas con los jugadores, iniciá sesión en Configuración",
    publishConfirmTitle: "¿Compartir esta nota?",
    publishConfirmSecret: (n) => (n === 1 ? "La parte oculta de la nota no se comparte." : `Las ${n} partes ocultas de la nota no se comparten.`),
    publishConfirmHint: "Todos los jugadores de la sala van a poder verla, pero no editarla. Lo que cambies después también lo van a ver.",
    publishConfirmBtn: "Compartir",
    publishCancelBtn: "Cancelar",
    publishError: "No se pudo compartir la nota. Probá de nuevo.",
    publishEditableConfirmTitle: "¿Hacer pública esta nota?",
    publishEditableConfirmHint: "Todos los jugadores de la sala van a poder verla y editarla, de a uno por vez. Vas a ver sus cambios, y podés deshacerlos desde el menú ⋯ de la nota.",
    publishEditableConfirmSecret: (n) => (n === 1 ? "Su parte oculta se va a mostrar: una nota pública no tiene partes ocultas." : `Sus ${n} partes ocultas se van a mostrar: una nota pública no tiene partes ocultas.`),
    publishEditableConfirmShowBtn: "Mostrar y compartir",
    publicDotTitle: "Visible para los jugadores",
    editableDotTitle: "Pública: los jugadores la editan",
    editableDotPlayerTitle: "Podés editarla",
    lockedBy: (name) => `${name} está editando`,
    finishEditing: "Terminar",
    finishEditingTitle: "Terminar de editar: libera la nota para que otros la editen",
    someone: "Alguien",
    editableSignedOut: "Para editar una nota pública, iniciá sesión en Configuración.",
    undoPlayerEdits: "Deshacer los cambios de los jugadores",
    undoPlayerEditsBusy: (name) => `${name} está editando esta nota. Probá cuando termine.`,
    settingsItemLinksLabel: "Objetos vinculados",
    itemLinksHint: "Con click derecho sobre cualquier objeto del mapa podés vincularle una nota y, después, abrirla desde ahí mismo. Desactivalo para sacar esa opción del menú; los vínculos se conservan.",
    itemLinksOnBtn: "Activados",
    itemLinksOffBtn: "Desactivados",
    itemPickBanner: (name, more) => (more ? `Elegí la nota para «${name}» (+${more})` : `Elegí la nota para «${name}»`),
    itemPickCancel: "Cancelar",
    linkedItemsLabel: "Vinculada a:",
    connectionsTitle: "Objetos vinculados y notas que enlazan a esta",
    linkedFrom: "Enlazada desde",
    linkedItemSelect: "Seleccionar en el mapa",
    linkedItemUnlink: "Desvincular",
    itemNoteTrashed: (t) => `La nota vinculada, «${t}», está en la papelera. ¿Restaurarla?`,
    itemNoteMissing: (name) => `La nota vinculada a «${name}» no está en este dispositivo (se borró, o no se sincronizó). ¿Desvincular el objeto?`,
    unnamedItem: "objeto",
    settingsSecretLabel: "Partes ocultas",
    secretEyeHint: "Hacer click en el ojito junto a una parte oculta la vuelve a mostrar a los jugadores. Bloquealo si preferís que el ojito solo la señale.",
    secretEyeClickBtn: "Mostrar con un click",
    secretEyeLockBtn: "Bloqueado",
    secretEyeShow: "Mostrar a los jugadores",
    secretEyeLocked: "Oculto a los jugadores",
    settingsSharedLabel: "Notas compartidas",
    sharedKeyHint: "Los jugadores ven las notas públicas gracias a una clave guardada en la sala. Si alguien que ya no está en la sala la conserva, regenerala: desde ese momento deja de verlas. Los que están en la sala no notan nada.",
    regenerateKeyBtn: "Regenerar clave",
    regenerateKeyConfirm: "¿Regenerar la clave de las notas compartidas? Quien tenga la clave vieja deja de ver las notas públicas.",
    regenerateKeyError: "No se pudo regenerar la clave. Probá de nuevo.",
    signOutPublicTitle: "Tenés notas públicas",
    signOutPublicHint: (n) => `Sin sesión iniciada no se pueden actualizar ni despublicar: los jugadores van a seguir viendo ${n === 1 ? "tu nota pública tal como está" : `tus ${n} notas públicas tal como están`} ahora, hasta que vuelvas a iniciar sesión.`,
    signOutUnpublishBtn: (n) => (n === 1 ? "Despublicarla y cerrar sesión" : "Despublicar todas y cerrar sesión"),
    signOutKeepBtn: (n) => (n === 1 ? "Cerrar sesión y dejarla visible" : "Cerrar sesión y dejarlas visibles"),
    sharedLoading: "Cargando las notas compartidas…",
    sharedEmpty: "El GM todavía no compartió ninguna nota.",
    sharedLoadError: "No se pudieron cargar las notas compartidas. Probá cerrar y volver a abrir GM Notes.",
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
      table: "Tabla", tableSize: (c, r) => `${c} ${c === 1 ? "columna" : "columnas"} × ${r} ${r === 1 ? "fila" : "filas"}`,
      tableOptions: "Opciones de tabla", tableRowAbove: "Insertar fila arriba", tableRowBelow: "Insertar fila abajo",
      tableColLeft: "Insertar columna a la izquierda", tableColRight: "Insertar columna a la derecha",
      tableRowUp: "Mover fila arriba", tableRowDown: "Mover fila abajo", tableRowDrag: "Arrastrar para mover la fila",
      tableColMoveLeft: "Mover columna a la izquierda", tableColMoveRight: "Mover columna a la derecha", tableColDrag: "Arrastrar para mover la columna",
      tableMove: "Mover", tableWidths: "Ancho de columnas",
      tableDeleteRow: "Eliminar fila", tableDeleteCol: "Eliminar columna",
      tableMergeRight: "Combinar con la celda de la derecha", tableMergeDown: "Combinar con la celda de abajo", tableSplit: "Separar celda", tableDistribute: "Distribuir columnas", tableFitContent: "Ajustar al contenido", tableFitFrame: "Ajustar al marco",
      tableColor: "Color de fondo", tableColorCell: "Celda", tableColorRow: "Fila", tableColorCol: "Columna", tableColorNone: "Sin color",
      tableHeaderRow: "Fila de encabezado", tableHeaderCol: "Columna de encabezado", tableDelete: "Eliminar tabla",
      listMenu: "Listas", bulletList: "Lista con viñetas", checkList: "Casillas", numberList: "Lista numerada", outdent: "Reducir sangría",
      indent: "Aumentar sangría", removeFormat: "Quitar formato",
      secret: "Ocultar a los jugadores",
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
    pinTitle: "Pin to the top",
    unpinTitle: "Unpin",
    sortRecent: "Recent",
    sortAlpha: "A–Z",
    sortTitle: "Change the list's order",
    moreActions: "More actions",
    duplicateNote: "Duplicate",
    newFolder: "New folder",
    newFolderTitle: "Create a folder to organize your notes",
    newNoteHere: "New note here",
    newSubfolder: "New subfolder",
    renameFolder: "Rename",
    folderActions: "Folder actions",
    folderNotes: (n) => (n === 1 ? "1 note" : `${n} notes`),
    moveTo: "Move to…",
    noFolder: "No folder",
    deleteFolder: "Delete folder",
    deleteFolderConfirm: (name, notes, subfolders) => {
      const parts = [notes === 1 ? "1 note" : notes ? `${notes} notes` : "", subfolders === 1 ? "1 subfolder" : subfolders ? `${subfolders} subfolders` : ""].filter(Boolean);
      if (!parts.length) return `Delete the folder “${name}”? It's empty.`;
      return `Delete the folder “${name}” and everything in it (${parts.join(" and ")})?` + (notes ? " The notes go to the trash, where you can restore them for 30 days." : "");
    },
    copySuffix: " (copy)",
    renameAria: "Rename ",
    deleteTitle: "Move to trash",
    trashLink: (n) => `Trash (${n})`,
    trashTitle: "Trash",
    trashBack: "Back to the notes",
    trashEmptyBtn: "Empty trash",
    trashEmptyConfirm: (n) => (n === 1 ? "Delete the note in the trash for good? This can't be undone." : `Delete the ${n} notes in the trash for good? This can't be undone.`),
    trashEmptyList: "The trash is empty.",
    trashRestoreTitle: "Restore",
    trashDeleteTitle: "Delete for good",
    trashDeleteConfirm: (title) => `Delete “${title}” for good? This can't be undone.`,
    trashDeletedAgo: "deleted ",
    trashExpiresIn: (d) => (d <= 1 ? " · last day" : ` · ${d} days left`),
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
    settingsInfo: "More info",
    linkPickerTitle: "Link to a note",
    linkPickerEmpty: "No matching notes",
    linkOpen: (t) => `Open “${t}”`,
    linkTrashed: "This note is in the trash",
    linkMissing: "This note no longer exists",
    settingsAccentLabel: "Accent color",
    settingsLangLabel: "Language",
    settingsHelpLabel: "Help",
    helpHint: "Opens the GM Notes manual (the README on GitHub) in a new tab.",
    helpLink: "View manual",
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
    clearAllConfirm: (n) => (n === 1 ? "Move this room's note to the trash? You can restore it for 30 days." : `Move this room's ${n} notes to the trash? You can restore them for 30 days.`),
    brandVisible: "Visible",
    brandEditable: "Public",
    shareMenuTitle: "Share this note with the players",
    shareModePrivate: "Private",
    shareModePrivateHint: "Only you see it",
    shareModeVisible: "Visible",
    shareModeVisibleHint: "Players read it",
    shareModeEditable: "Public",
    shareModeEditableHint: "Players edit it, one at a time",
    publishSignedOutTitle: "To share notes with the players, sign in from Settings",
    publishConfirmTitle: "Share this note?",
    publishConfirmSecret: (n) => (n === 1 ? "The note's hidden part isn't shared." : `The note's ${n} hidden parts aren't shared.`),
    publishConfirmHint: "Every player in the room will be able to see it, but not edit it. They'll also see whatever you change afterwards.",
    publishConfirmBtn: "Share",
    publishCancelBtn: "Cancel",
    publishError: "Couldn't share the note. Please try again.",
    publishEditableConfirmTitle: "Make this note public?",
    publishEditableConfirmHint: "Every player in the room will be able to see and edit it, one at a time. You'll see their changes, and you can undo them from the note's ⋯ menu.",
    publishEditableConfirmSecret: (n) => (n === 1 ? "Its hidden part will be shown: a public note has no hidden parts." : `Its ${n} hidden parts will be shown: a public note has no hidden parts.`),
    publishEditableConfirmShowBtn: "Show and share",
    publicDotTitle: "Visible to the players",
    editableDotTitle: "Public: players edit it",
    editableDotPlayerTitle: "You can edit it",
    lockedBy: (name) => `${name} is editing`,
    finishEditing: "Done",
    finishEditingTitle: "Done editing: frees the note for others to edit",
    someone: "Someone",
    editableSignedOut: "To edit a public note, sign in from Settings.",
    undoPlayerEdits: "Undo the players' changes",
    undoPlayerEditsBusy: (name) => `${name} is editing this note. Try again once they're done.`,
    settingsItemLinksLabel: "Linked items",
    itemLinksHint: "Right-click any item on the map to link a note to it, and then open that note from right there. Turn it off to take that option out of the menu; the links are kept.",
    itemLinksOnBtn: "On",
    itemLinksOffBtn: "Off",
    itemPickBanner: (name, more) => (more ? `Pick the note for “${name}” (+${more})` : `Pick the note for “${name}”`),
    itemPickCancel: "Cancel",
    linkedItemsLabel: "Linked to:",
    connectionsTitle: "Linked items, and notes that link here",
    linkedFrom: "Linked from",
    linkedItemSelect: "Select on the map",
    linkedItemUnlink: "Unlink",
    itemNoteTrashed: (t) => `The linked note, “${t}”, is in the trash. Restore it?`,
    itemNoteMissing: (name) => `The note linked to “${name}” isn't on this device (deleted, or not synced). Unlink the item?`,
    unnamedItem: "item",
    settingsSecretLabel: "Hidden parts",
    secretEyeHint: "Clicking the eye next to a hidden part shows it to players again. Lock it if you'd rather the eye only mark it.",
    secretEyeClickBtn: "Show on click",
    secretEyeLockBtn: "Locked",
    secretEyeShow: "Show to players",
    secretEyeLocked: "Hidden from players",
    settingsSharedLabel: "Shared notes",
    sharedKeyHint: "Players see the public notes through a key stored in the room. If someone no longer in the room still has it, regenerate it: from then on they stop seeing them. Those in the room won't notice a thing.",
    regenerateKeyBtn: "Regenerate key",
    regenerateKeyConfirm: "Regenerate the shared notes key? Anyone holding the old key stops seeing the public notes.",
    regenerateKeyError: "Couldn't regenerate the key. Please try again.",
    signOutPublicTitle: "You have public notes",
    signOutPublicHint: (n) => `Signed out, they can't be updated or unpublished: players will keep seeing ${n === 1 ? "your public note as it is" : `your ${n} public notes as they are`} now, until you sign in again.`,
    signOutUnpublishBtn: (n) => (n === 1 ? "Unpublish it and sign out" : "Unpublish all and sign out"),
    signOutKeepBtn: (n) => (n === 1 ? "Sign out and keep it visible" : "Sign out and keep them visible"),
    sharedLoading: "Loading the shared notes…",
    sharedEmpty: "The GM hasn't shared any notes yet.",
    sharedLoadError: "Couldn't load the shared notes. Try closing GM Notes and opening it again.",
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
      table: "Table", tableSize: (c, r) => `${c} ${c === 1 ? "column" : "columns"} × ${r} ${r === 1 ? "row" : "rows"}`,
      tableOptions: "Table options", tableRowAbove: "Insert row above", tableRowBelow: "Insert row below",
      tableColLeft: "Insert column left", tableColRight: "Insert column right",
      tableRowUp: "Move row up", tableRowDown: "Move row down", tableRowDrag: "Drag to move the row",
      tableColMoveLeft: "Move column left", tableColMoveRight: "Move column right", tableColDrag: "Drag to move the column",
      tableMove: "Move", tableWidths: "Column widths",
      tableDeleteRow: "Delete row", tableDeleteCol: "Delete column",
      tableMergeRight: "Merge with cell on the right", tableMergeDown: "Merge with cell below", tableSplit: "Split cell", tableDistribute: "Distribute columns", tableFitContent: "Fit to content", tableFitFrame: "Fit to frame",
      tableColor: "Background color", tableColorCell: "Cell", tableColorRow: "Row", tableColorCol: "Column", tableColorNone: "No color",
      tableHeaderRow: "Header row", tableHeaderCol: "Header column", tableDelete: "Delete table",
      listMenu: "Lists", bulletList: "Bullet list", checkList: "Checklist", numberList: "Numbered list", outdent: "Decrease indent",
      indent: "Increase indent", removeFormat: "Clear formatting",
      secret: "Hide from players",
    },
  },
};

export function getStrings(language: Language): Strings {
  return STRINGS[language];
}
