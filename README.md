# Note Schemas

Give your note kinds a **type**. Note Schemas lets you declare, in one file, what
frontmatter each kind of note should carry — required fields, their types, allowed
enum values — and then validates your vault against those rules, autocompletes
frontmatter while you type, and safely autofixes the easy mistakes.

## Features

- **Typed schemas** for note kinds, defined in a single JSON (or YAML) file.
- **Validation** of every note's frontmatter: missing required fields, wrong types,
  disallowed enum values and list members (errors), and unknown fields (warnings).
- **A side panel** listing all violations, grouped by note and clickable.
- **A live status-bar indicator** for the active note (`✓` valid / `✗` invalid),
  refreshed on save.
- **Frontmatter autocomplete**: field names for the note's type, and enum values
  for enum fields — only inside the `---` block.
- **Safe autofix**: insert missing required fields that declare a `default`, and
  coerce obvious type mistakes (numeric strings → numbers, `"true"`/`"false"` →
  booleans, a lone scalar → a one-item list).

## How to use

### The schema file

By default the plugin reads `note-schemas.json` from your vault's config directory
(usually `.obsidian/note-schemas.json`); the path is configurable in settings.
It is a map of **type name → definition**:

```json
{
  "book": {
    "match": { "folder": "Books", "tagged": "book", "frontmatterType": "book" },
    "fields": {
      "title":  { "type": "string", "required": true },
      "author": { "type": "string" },
      "status": { "type": "enum", "values": ["to-read", "reading", "done"], "default": "to-read", "required": true },
      "rating": { "type": "number" },
      "tags":   { "type": "list" },
      "finished": { "type": "date" }
    }
  },
  "meeting": {
    "match": { "folder": "Meetings" },
    "fields": {
      "date":       { "type": "date", "required": true },
      "attendees":  { "type": "list", "required": true },
      "type":       { "type": "string" }
    }
  }
}
```

YAML is also supported — point the setting at a `.yaml`/`.yml` file instead.

### How a note's type is resolved

For each note the plugin picks the **first matching type**:

1. If frontmatter `type` equals a declared type name, that type is used.
2. Otherwise each type's `match` rule is tried in declaration order:
   - `frontmatterType` — frontmatter `type` equals this value,
   - `folder` — the note lives in (or under) this folder,
   - `tagged` — the note carries this tag (frontmatter or inline, `#` optional).

Notes that match no type are simply ignored ("untyped").

### Field types

`string`, `number`, `boolean`, `date` (`YYYY-MM-DD`), `enum` (requires `values`),
`list`. Each field may set `required: true`, and any field may declare a `default`
used by autofix. A `list` field may also declare `values`; its members are then
validated against that allow-list.

### Commands

- **Validate vault against schemas** — validates every typed note and opens the
  violations panel. Also available from the ribbon (checklist icon).
- **Open schema violations panel** — reveal the side panel.
- **Fix all safe issues in this note** — apply every safe fix to the active note.

## Settings

- **Schema file path** — vault-relative path to the schema file.
- **Validate on save** — re-validate the active note on change and drive the
  status-bar indicator.
- **Reload schema** — re-read the schema file after editing it. Schema files kept
  *inside* the vault also reload automatically on save; the default path lives under
  the config directory, which Obsidian does not watch, so use this button (or
  re-open settings) to reload after editing the default file.

## Limitations

- Validation reads Obsidian's parsed frontmatter cache, so it only covers notes
  with a YAML frontmatter block; body content is not inspected.
- `date` accepts `YYYY-MM-DD`-style strings (and real dates) but does not check
  calendar validity (e.g. `2026-02-31` passes).
- Autofix is intentionally conservative: it never deletes unknown fields, never
  invents values for required fields without a `default`, and only performs
  loss-free coercions.
- Enum and list-value matching is case-sensitive.
- Nested/object frontmatter fields are treated as their top-level value only.

## Installation

This plugin is **not yet in the community store**. To install it manually:

1. Build: from the repo root run the workspace build so `main.js` is produced next
   to `manifest.json`.
2. Copy `manifest.json`, `main.js`, and `styles.css` into
   `<your-vault>/.obsidian/plugins/note-schemas/`.
3. Enable **Note Schemas** in *Settings → Community plugins*.
4. Create `note-schemas.json` in your vault's config directory with a schema like
   the example above.
5. Add matching notes, then run **Validate vault against schemas**. Edit a typed
   note's frontmatter to see autocomplete and the status-bar indicator, and try
   **Fix all safe issues in this note**.

## Support

If this plugin is useful to you, you can support its development at
[Buy Me a Coffee](https://buymeacoffee.com/aguila1989).
