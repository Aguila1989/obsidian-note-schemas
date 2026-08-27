import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from "obsidian";
import type NoteSchemasPlugin from "./main";
import { FieldDef } from "./schema";

/** One suggestion item: either a field name or an enum value. */
interface SchemaSuggestion {
	kind: "key" | "value";
	text: string;
	field?: FieldDef;
	fieldName: string;
}

const KEY_LINE_RE = /^(\s*)([A-Za-z0-9_\- ]*)$/;
const VALUE_LINE_RE = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/;

/**
 * Suggests frontmatter field names for the current note's type, and enum values
 * when the cursor sits on an enum field's value. Only fires inside the `---` block.
 */
export class SchemaSuggest extends EditorSuggest<SchemaSuggestion> {
	private plugin: NoteSchemasPlugin;
	/** Meta about the trigger, shared between onTrigger and getSuggestions. */
	private pending: { mode: "key" | "value"; typeName: string; fieldName?: string } | null = null;

	constructor(app: App, plugin: NoteSchemasPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!file) return null;
		const closeLine = this.frontmatterCloseLine(editor);
		// Must be inside the frontmatter block (after opening `---`, before closing `---`).
		if (closeLine < 0 || cursor.line <= 0 || cursor.line >= closeLine) return null;

		const cache = this.app.metadataCache.getFileCache(file);
		const typeName = this.plugin.schema.resolveType(file, cache);
		if (!typeName) return null;
		const def = this.plugin.schema.getType(typeName);
		if (!def) return null;

		const before = editor.getLine(cursor.line).slice(0, cursor.ch);

		// Case 1: typing a value on an enum field -> suggest allowed values.
		const valueMatch = before.match(VALUE_LINE_RE);
		if (valueMatch) {
			const fieldName = valueMatch[2];
			const field = def.fields[fieldName];
			if (field && field.type === "enum" && field.values && field.values.length > 0) {
				const query = valueMatch[3];
				const startCh = cursor.ch - query.length;
				this.pending = { mode: "value", typeName, fieldName };
				return {
					start: { line: cursor.line, ch: startCh },
					end: cursor,
					query,
				};
			}
			return null;
		}

		// Case 2: typing a bare key -> suggest field names.
		const keyMatch = before.match(KEY_LINE_RE);
		if (keyMatch) {
			const indent = keyMatch[1];
			const query = keyMatch[2];
			this.pending = { mode: "key", typeName };
			return {
				start: { line: cursor.line, ch: indent.length },
				end: cursor,
				query,
			};
		}

		return null;
	}

	getSuggestions(context: EditorSuggestContext): SchemaSuggestion[] {
		const pending = this.pending;
		if (!pending) return [];
		const def = this.plugin.schema.getType(pending.typeName);
		if (!def) return [];
		const query = context.query.toLowerCase().trim();

		if (pending.mode === "value" && pending.fieldName) {
			const field = def.fields[pending.fieldName];
			const values = field?.values ?? [];
			return values
				.filter((v) => v.toLowerCase().includes(query))
				.map((v) => ({ kind: "value", text: v, field, fieldName: pending.fieldName as string }));
		}

		// key mode: existing keys already present should not be suggested again.
		// (frontmatterKeys already excludes the line being typed on.)
		const existing = new Set(this.frontmatterKeys(context.editor, context.start.line));
		return Object.entries(def.fields)
			.filter(([name]) => name.toLowerCase().includes(query))
			.filter(([name]) => !existing.has(name))
			.map(([name, field]) => ({ kind: "key", text: name, field, fieldName: name }));
	}

	renderSuggestion(item: SchemaSuggestion, el: HTMLElement): void {
		el.addClass("note-schemas-suggestion");
		el.createSpan({ cls: "note-schemas-suggestion-text", text: item.text });
		if (item.field) {
			const meta = item.kind === "key" ? item.field.type + (item.field.required ? " · required" : "") : "value";
			el.createSpan({ cls: "note-schemas-suggestion-meta", text: meta });
		}
	}

	selectSuggestion(item: SchemaSuggestion, _evt: MouseEvent | KeyboardEvent): void {
		const ctx = this.context;
		if (!ctx) return;
		const replacement = item.kind === "key" ? `${item.text}: ` : item.text;
		ctx.editor.replaceRange(replacement, ctx.start, ctx.end);
		const newCh = ctx.start.ch + replacement.length;
		ctx.editor.setCursor({ line: ctx.start.line, ch: newCh });
		this.pending = null;
	}

	/** Line index of the closing `---`, or -1 if there is no frontmatter block. */
	private frontmatterCloseLine(editor: Editor): number {
		if (editor.getLine(0).trim() !== "---") return -1;
		const max = Math.min(editor.lineCount(), 500); // bound the scan for huge files
		for (let i = 1; i < max; i++) {
			if (editor.getLine(i).trim() === "---") return i;
		}
		return -1;
	}

	/** Collect the top-level keys already declared in the frontmatter block. */
	private frontmatterKeys(editor: Editor, exceptLine: number): string[] {
		const close = this.frontmatterCloseLine(editor);
		const keys: string[] = [];
		for (let i = 1; i < close; i++) {
			if (i === exceptLine) continue;
			const m = editor.getLine(i).match(VALUE_LINE_RE);
			if (m) keys.push(m[2]);
		}
		return keys;
	}
}
