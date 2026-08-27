import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { SchemaStore } from "../src/schema";

/**
 * Minimal fake of the App surface SchemaStore touches:
 * - vault.getAbstractFileByPath / vault.read for indexed files,
 * - vault.adapter.exists / adapter.read for dot-folder paths (config dir).
 * Paths starting with "." are treated as NOT indexed, mirroring Obsidian.
 */
function makeApp(files: Record<string, string>) {
	return {
		vault: {
			getAbstractFileByPath(path: string): TFile | null {
				if (path.startsWith(".") || !(path in files)) return null;
				const f = new TFile();
				f.path = path;
				return f;
			},
			async read(file: TFile): Promise<string> {
				return files[file.path];
			},
			adapter: {
				async exists(path: string): Promise<boolean> {
					return path in files;
				},
				async read(path: string): Promise<string> {
					return files[path];
				},
			},
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

function makeFile(path: string): TFile {
	const f = new TFile();
	f.path = path;
	f.basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
	f.extension = "md";
	return f;
}

const BOOK_MEETING_SCHEMA = JSON.stringify({
	book: {
		match: { folder: "Books", tagged: "book", frontmatterType: "livre" },
		fields: {
			title: { type: "string", required: true },
			status: { type: "enum", values: ["to-read", "reading", "done"] },
		},
	},
	meeting: {
		match: { folder: "Meetings" },
		fields: { date: { type: "date", required: true } },
	},
});

async function loadedStore(schemaJson: string, path = "schema.json") {
	const store = new SchemaStore(makeApp({ [path]: schemaJson }));
	const ok = await store.load(path);
	return { store, ok };
}

describe("SchemaStore.load", () => {
	it("loads a JSON schema and preserves declaration order", async () => {
		const { store, ok } = await loadedStore(BOOK_MEETING_SCHEMA);
		expect(ok).toBe(true);
		expect(store.loadError).toBeNull();
		expect(store.typeNames).toEqual(["book", "meeting"]);
		expect(store.getType("book")?.fields.title).toEqual({ type: "string", required: true });
		expect(store.isEmpty).toBe(false);
	});

	it("loads a YAML schema via parseYaml", async () => {
		const yaml = [
			"book:",
			"  match:",
			"    folder: Books",
			"  fields:",
			"    title:",
			"      type: string",
			"      required: true",
		].join("\n");
		const { store, ok } = await loadedStore(yaml, "schema.yaml");
		expect(ok).toBe(true);
		expect(store.getType("book")?.match?.folder).toBe("Books");
		expect(store.getType("book")?.fields.title.required).toBe(true);
	});

	it("falls back to the adapter for dot-folder paths (config dir)", async () => {
		const { store, ok } = await loadedStore(BOOK_MEETING_SCHEMA, ".obsidian/note-schemas.json");
		expect(ok).toBe(true);
		expect(store.typeNames).toEqual(["book", "meeting"]);
	});

	it("reports a missing schema file without throwing", async () => {
		const store = new SchemaStore(makeApp({}));
		expect(await store.load("nope.json")).toBe(false);
		expect(store.loadError).toContain("not found");
		expect(store.isEmpty).toBe(true);
	});

	it("reports malformed JSON as a load error", async () => {
		const { store, ok } = await loadedStore("{ not json");
		expect(ok).toBe(false);
		expect(store.loadError).toContain("not valid JSON");
		expect(store.isEmpty).toBe(true);
	});

	it("rejects a non-object schema root", async () => {
		const { store, ok } = await loadedStore(JSON.stringify(["book"]));
		expect(ok).toBe(false);
		expect(store.loadError).toContain("Schema root must be an object");
	});

	it("keeps the valid parts of a partially-broken schema", async () => {
		const raw = JSON.stringify({
			book: {
				fields: {
					title: { type: "string" },
					weird: { type: "unicorn" }, // invalid field type
				},
			},
			broken: "not-an-object",
		});
		const { store, ok } = await loadedStore(raw);
		expect(ok).toBe(false);
		expect(store.loadError).toContain('"book.weird" has invalid type "unicorn"');
		expect(store.loadError).toContain('"broken" must be an object');
		// valid field survives, invalid field is dropped, broken type is skipped
		expect(store.getType("book")?.fields.title.type).toBe("string");
		expect(store.getType("book")?.fields.weird).toBeUndefined();
		expect(store.getType("broken")).toBeUndefined();
	});

	it("flags an enum field without values", async () => {
		const raw = JSON.stringify({ book: { fields: { status: { type: "enum" } } } });
		const { store, ok } = await loadedStore(raw);
		expect(ok).toBe(false);
		expect(store.loadError).toContain('Enum field "book.status" must declare a non-empty "values" list');
	});

	it("flags a type missing its fields object", async () => {
		const { store, ok } = await loadedStore(JSON.stringify({ book: {} }));
		expect(ok).toBe(false);
		expect(store.loadError).toContain('Type "book" is missing a "fields" object');
	});

	it("stringifies non-string enum values", async () => {
		const raw = JSON.stringify({ t: { fields: { n: { type: "enum", values: [1, 2] } } } });
		const { store, ok } = await loadedStore(raw);
		expect(ok).toBe(true);
		expect(store.getType("t")?.fields.n.values).toEqual(["1", "2"]);
	});
});

describe("SchemaStore.resolveType", () => {
	async function store() {
		const { store } = await loadedStore(BOOK_MEETING_SCHEMA);
		return store;
	}

	it("lets an explicit, known frontmatter `type` win over any match rule", async () => {
		const s = await store();
		// Note lives in Meetings/ but declares type: book -> book wins.
		const t = s.resolveType(makeFile("Meetings/x.md"), { frontmatter: { type: "book" } });
		expect(t).toBe("book");
	});

	it("resolves via a frontmatterType alias", async () => {
		const s = await store();
		const t = s.resolveType(makeFile("Elsewhere/x.md"), { frontmatter: { type: "livre" } });
		expect(t).toBe("book");
	});

	it("ignores an unknown declared type and falls through to match rules", async () => {
		const s = await store();
		const t = s.resolveType(makeFile("Meetings/x.md"), { frontmatter: { type: "unknown-kind" } });
		expect(t).toBe("meeting");
	});

	it("matches by folder, including nested subfolders", async () => {
		const s = await store();
		expect(s.resolveType(makeFile("Books/dune.md"), {})).toBe("book");
		expect(s.resolveType(makeFile("Books/sci-fi/dune.md"), {})).toBe("book");
	});

	it("does not treat a folder-name prefix as a match", async () => {
		const s = await store();
		expect(s.resolveType(makeFile("Bookshelf/dune.md"), {})).toBeNull();
	});

	it("normalizes a trailing slash in the folder rule", async () => {
		const raw = JSON.stringify({ book: { match: { folder: "Books/" }, fields: {} } });
		const { store: s } = await loadedStore(raw);
		expect(s.resolveType(makeFile("Books/dune.md"), {})).toBe("book");
	});

	it("matches by tag, hash-optional and case-insensitive", async () => {
		const s = await store();
		const inline = { tags: [{ tag: "#Book" }] };
		expect(s.resolveType(makeFile("Elsewhere/x.md"), inline)).toBe("book");
		const fm = { frontmatter: { tags: ["book"] } };
		expect(s.resolveType(makeFile("Elsewhere/y.md"), fm)).toBe("book");
	});

	it("uses declaration order when multiple types match", async () => {
		const raw = JSON.stringify({
			first: { match: { folder: "Shared" }, fields: {} },
			second: { match: { folder: "Shared" }, fields: {} },
		});
		const { store: s } = await loadedStore(raw);
		expect(s.resolveType(makeFile("Shared/x.md"), {})).toBe("first");
	});

	it("returns null for unmatched notes and for a null cache outside matched folders", async () => {
		const s = await store();
		expect(s.resolveType(makeFile("Journal/today.md"), {})).toBeNull();
		expect(s.resolveType(makeFile("Journal/today.md"), null)).toBeNull();
		// null cache but folder rule still applies (folder needs no metadata)
		expect(s.resolveType(makeFile("Books/dune.md"), null)).toBe("book");
	});
});
