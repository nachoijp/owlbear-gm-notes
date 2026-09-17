# GM Notes

An [Owlbear Rodeo](https://www.owlbear.rodeo/) extension for a private,
rich-text campaign journal — visible only to the GM. Players who open it see
a simple access-restricted screen; there's no sharing, no per-note
visibility toggle, nothing for them to see or edit.

![GM Notes](docs/header.png)

## Install

Add this extension to your room using its manifest URL:

```
https://notes.ijpedraza.com/manifest.json
```

## Features

- Rich text: bold, italic, underline, strikethrough, headings, color pills,
  text color, colored blockquotes, dividers, and bulleted/numbered lists
  (with indent for sub-lists).
- Multiple notes per room, with search and a quick switcher.
- **Paste recognizes Markdown** — headings, `**bold**`/`*italic*`, lists,
  `> quotes`, and `---` dividers all convert straight into real formatting
  instead of landing as literal symbols.
- **Export/import**: back up a note (or all of them) to a file — a single
  `.json`, or a `.zip` with one file per note when exporting several at
  once — and bring them back later. Also the way to free up room storage
  without losing anything, see below.
- Personal accent color and language (English/Spanish) per player.

![The note editor](docs/screenshot-editor.png)

## Room storage

Owlbear caps a room's total shared metadata at 16 KB, split across every
extension in the room — not just this one. Notes are compressed before
being stored, and a meter in Settings shows how much of that budget is in
use. If you're getting close to the limit, export a note you don't need
active (Settings has an "export all" option too) and delete it from the
room — you can always import it back later without losing anything.

![Settings and storage meter](docs/screenshot-settings.png)

## Support

Found a bug or have a feature request? Open an issue at
<https://github.com/nachoijp/owlbear-gm-notes/issues>.
