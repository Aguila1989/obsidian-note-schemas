import { App, CachedMetadata, TFile, getAllTags, normalizePath, parseYaml } from "obsidian";

/** The primitive kinds a frontmatter field can declare. */
export type FieldType = "string" | "number" | "boolean" | "date" | "enum" | "list";

/** Declaration of a single frontmatter field within a note type. */
export interface FieldDef {
	type: FieldType;
	required?: boolean;
	/** Allowed values — only meaningful for `enum` (and used to validate `list` members if present). */
	values?: string[];
	/** Value inserted by autofix when a required field is missing. */
	default?: unknown;
}

/** Rules that decide whether a note belongs to a given type. */
export interface MatchRule {
	/** Vault-relative folder prefix; the note matches if it lives in (or under) this folder. */
	folder?: string;
	/** A tag (with or without the leading `#`) the note must carry. */
	tagged?: string;
	/** Value the frontmatter `type` field must equal. */
	frontmatterType?: string;
}

/** A named note type: how to recognise it, and the fields it should carry. */
export interface NoteTypeDef {
	match?: MatchRule;
	fields: Record<string, FieldDef>;
}

/** The whole schema document: a map of typeName -> definition. */
export type SchemaDoc = Record<string, NoteTypeDef>;

const VALID_TYPES: FieldType[] = ["string", "number", "boolean", "date", "enum", "list"];

/**
 * Loads, parses and caches the schema document, and resolves which type a note belongs to.
 * Deliberately tolerant: a malformed schema surfaces as an error string rather than a throw.
 */
export class SchemaStore {
	private app: App;
	private doc: SchemaDoc = {};
	/** Non-null when the last load failed; carries a human-readable reason. */
	loadError: string | null = null;

	constructor(app: App) {
		this.app = app;
	}

	/** Ordered list of declared type names (object insertion order is preserved). */
	get typeNames(): string[] {
		return Object.keys(this.doc);
	}

	getType(name: string): NoteTypeDef | undefined {
		return this.doc[name];
	}

	get isEmpty(): boolean {
		return this.typeNames.length === 0;
	}

	/**
	 * Read and parse the schema file at `path`. Supports both `.json` (parsed as JSON)
	 * and `.yaml`/`.yml` (parsed with Obsidian's parseYaml). Returns true on success.
	 */
	async load(path: string): Promise<boolean> {
		this.loadError = null;
		const normalized = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		let raw: string;
		if (file instanceof TFile) {
			try {
				raw = await this.app.vault.read(file);
			} catch (e) {
				this.doc = {};
				this.loadError = `Could not read schema file: ${String(e)}`;
				return false;
			}
		} else {
			// Files under dot-folders (e.g. the `.obsidian` config dir — the default
			// schema location) are not part of the vault index, so getAbstractFileByPath
			// returns null for them. Fall back to the adapter for those paths.
			try {
				if (!(await this.app.vault.adapter.exists(normalized))) {
					this.doc = {};
					this.loadError = `Schema file not found: ${normalized}`;
					return false;
				}
				raw = await this.app.vault.adapter.read(normalized);
			} catch (e) {
				this.doc = {};
				this.loadError = `Could not read schema file: ${String(e)}`;
				return false;
			}
		}
		return this.parse(raw, normalized.endsWith(".json"));
	}

	/** Parse raw text into the schema document, validating its shape. */
	private parse(raw: string, asJson: boolean): boolean {
		let parsed: unknown;
		try {
			parsed = asJson ? JSON.parse(raw) : parseYaml(raw);
		} catch (e) {
			this.doc = {};
			this.loadError = `Schema is not valid ${asJson ? "JSON" : "YAML"}: ${String(e)}`;
			return false;
		}
		const errors: string[] = [];
		const cleaned = this.coerceDoc(parsed, errors);
		if (errors.length > 0) {
			this.doc = cleaned; // keep whatever was valid so partial schemas still work
			this.loadError = errors.join("; ");
			return false;
		}
		this.doc = cleaned;
		return true;
	}

	/** Validate/normalise the parsed object into a SchemaDoc, appending problems to `errors`. */
	private coerceDoc(parsed: unknown, errors: string[]): SchemaDoc {
		const out: SchemaDoc = {};
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			errors.push("Schema root must be an object of typeName -> definition");
			return out;
		}
		for (const [typeName, rawDef] of Object.entries(parsed as Record<string, unknown>)) {
			if (rawDef === null || typeof rawDef !== "object" || Array.isArray(rawDef)) {
				errors.push(`Type "${typeName}" must be an object`);
				continue;
			}
			const def = rawDef as Record<string, unknown>;
			const fieldsRaw = def.fields;
			const fields: Record<string, FieldDef> = {};
			if (fieldsRaw && typeof fieldsRaw === "object" && !Array.isArray(fieldsRaw)) {
				for (const [fieldName, rawField] of Object.entries(fieldsRaw as Record<string, unknown>)) {
					const fd = this.coerceField(typeName, fieldName, rawField, errors);
					if (fd) fields[fieldName] = fd;
				}
			} else {
				errors.push(`Type "${typeName}" is missing a "fields" object`);
			}
			out[typeName] = { match: this.coerceMatch(def.match), fields };
		}
		return out;
	}

	private coerceMatch(rawMatch: unknown): MatchRule | undefined {
		if (!rawMatch || typeof rawMatch !== "object" || Array.isArray(rawMatch)) return undefined;
		const m = rawMatch as Record<string, unknown>;
		const rule: MatchRule = {};
		if (typeof m.folder === "string") rule.folder = m.folder;
		if (typeof m.tagged === "string") rule.tagged = m.tagged;
		if (typeof m.frontmatterType === "string") rule.frontmatterType = m.frontmatterType;
		return rule;
	}

	private coerceField(
		typeName: string,
		fieldName: string,
		rawField: unknown,
		errors: string[],
	): FieldDef | null {
		if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) {
			errors.push(`Field "${typeName}.${fieldName}" must be an object`);
			return null;
		}
		const f = rawField as Record<string, unknown>;
		const type = f.type;
		if (typeof type !== "string" || !VALID_TYPES.includes(type as FieldType)) {
			errors.push(
				`Field "${typeName}.${fieldName}" has invalid type "${String(type)}" ` +
					`(expected one of ${VALID_TYPES.join(", ")})`,
			);
			return null;
		}
		const fd: FieldDef = { type: type as FieldType };
		if (f.required === true) fd.required = true;
		if (Array.isArray(f.values)) fd.values = f.values.map((v) => String(v));
		if ("default" in f) fd.default = f.default;
		if (fd.type === "enum" && (!fd.values || fd.values.length === 0)) {
			errors.push(`Enum field "${typeName}.${fieldName}" must declare a non-empty "values" list`);
		}
		return fd;
	}

	/**
	 * Resolve the note type for a file: the first declared type whose match rules apply.
	 * Precedence within a type: explicit frontmatter `type`, then frontmatterType/folder/tag.
	 * Returns null when no type matches.
	 */
	resolveType(file: TFile, cache: CachedMetadata | null): string | null {
		const fm = cache?.frontmatter ?? {};
		const declaredType = typeof fm.type === "string" ? fm.type : null;

		// An explicit, known `type` always wins.
		if (declaredType && this.doc[declaredType]) return declaredType;

		const tags = cache ? (getAllTags(cache) ?? []) : [];
		for (const name of this.typeNames) {
			const rule = this.doc[name].match;
			if (!rule) continue;
			if (rule.frontmatterType && declaredType === rule.frontmatterType) return name;
			if (rule.folder && this.fileInFolder(file, rule.folder)) return name;
			if (rule.tagged && this.hasTag(tags, rule.tagged)) return name;
		}
		return null;
	}

	private fileInFolder(file: TFile, folder: string): boolean {
		const prefix = normalizePath(folder).replace(/\/+$/, "");
		if (prefix === "" || prefix === "/") return true;
		return file.path === prefix || file.path.startsWith(prefix + "/");
	}

	private hasTag(tags: string[], wanted: string): boolean {
		const norm = (t: string) => (t.startsWith("#") ? t.slice(1) : t).toLowerCase();
		const target = norm(wanted);
		return tags.some((t) => norm(t) === target);
	}
}
