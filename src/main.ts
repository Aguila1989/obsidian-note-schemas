import { Debouncer, Notice, Plugin, TFile, WorkspaceLeaf, debounce, normalizePath } from "obsidian";
import { SchemaStore } from "./schema";
import { computeSafeFixes, validateFrontmatter, Violation } from "./validate";
import { DEFAULT_SETTINGS, NoteSchemasSettingTab, NoteSchemasSettings, defaultSchemaPath } from "./settings";
import { NoteViolations, ViolationsView, VIEW_TYPE_VIOLATIONS } from "./view";
import { SchemaSuggest } from "./suggest";

export default class NoteSchemasPlugin extends Plugin {
	settings: NoteSchemasSettings = DEFAULT_SETTINGS;
	schema!: SchemaStore;
	private statusBar!: HTMLElement;
	private debouncedValidateActive!: Debouncer<[], void>;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.schema = new SchemaStore(this.app);

		this.registerView(VIEW_TYPE_VIOLATIONS, (leaf) => new ViolationsView(leaf, this));

		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("note-schemas-status");
		this.setStatus("neutral", "Schemas: —");

		this.addSettingTab(new NoteSchemasSettingTab(this.app, this));
		this.registerEditorSuggest(new SchemaSuggest(this.app, this));

		this.addRibbonIcon("list-checks", "Validate vault against schemas", () => {
			void this.validateVault();
		});

		this.addCommand({
			id: "validate-vault",
			name: "Validate vault against schemas",
			callback: () => void this.validateVault(),
		});

		this.addCommand({
			id: "open-violations-panel",
			name: "Open schema violations panel",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "fix-active-note",
			name: "Fix all safe issues in this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.fixActiveNote(file);
				return true;
			},
		});

		// Debounced re-validation of the active note for the status-bar indicator.
		this.debouncedValidateActive = debounce(() => this.validateActiveNote(), 600, true);

		// Re-validate the active note when its metadata (frontmatter) is re-parsed.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (!this.settings.validateOnSave) return;
				const active = this.app.workspace.getActiveFile();
				if (active && file.path === active.path) this.debouncedValidateActive();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.validateActiveNote()),
		);

		// Reload the schema whenever the schema file itself changes on disk.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file.path === this.normalizeSchemaPath()) void this.reloadSchema(false);
			}),
		);

		// Initial load once the metadata cache is ready.
		this.app.workspace.onLayoutReady(() => {
			void this.reloadSchema(false).then(() => this.validateActiveNote());
		});
	}

	onunload(): void {
		// Deliberately do NOT detach leaves here: per Obsidian's plugin guidelines,
		// detaching in onunload destroys the user's layout on every plugin update.
	}

	private normalizeSchemaPath(): string {
		return normalizePath(this.settings.schemaPath);
	}

	async loadSettings(): Promise<void> {
		const defaults: NoteSchemasSettings = {
			...DEFAULT_SETTINGS,
			schemaPath: defaultSchemaPath(this.app.vault.configDir),
		};
		const data = (await this.loadData()) as Partial<NoteSchemasSettings> | null;
		this.settings = Object.assign({}, defaults, data);
		// Guard against an empty stored value; user-set paths are kept as-is.
		if (!this.settings.schemaPath.trim()) this.settings.schemaPath = defaults.schemaPath;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		await this.reloadSchema(false);
	}

	/** Re-read the schema file; `notify` surfaces the outcome as a Notice. */
	async reloadSchema(notify: boolean): Promise<void> {
		const ok = await this.schema.load(this.settings.schemaPath);
		if (notify) {
			if (ok) {
				new Notice(`Note Schemas: loaded ${this.schema.typeNames.length} type(s).`);
			} else {
				new Notice(`Note Schemas: ${this.schema.loadError ?? "could not load schema"}`);
			}
		}
		this.validateActiveNote();
	}

	/** Validate every markdown file that resolves to a known type. */
	async validateVault(): Promise<void> {
		if (this.schema.loadError) {
			new Notice(`Note Schemas: ${this.schema.loadError}`);
		}
		if (this.schema.isEmpty) {
			new Notice("Note Schemas: no types declared. Configure a schema file first.");
			await this.activateView();
			return;
		}

		const results: NoteViolations[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const typeName = this.schema.resolveType(file, cache);
			if (!typeName) continue;
			const def = this.schema.getType(typeName);
			if (!def) continue;
			const violations = validateFrontmatter(cache?.frontmatter, typeName, def);
			if (violations.length > 0) results.push({ file, typeName, violations });
		}

		// Notes with errors first, then by descending violation count.
		results.sort((a, b) => this.errorCount(b.violations) - this.errorCount(a.violations) || b.violations.length - a.violations.length);

		const view = await this.activateView();
		const label = `${results.length} note(s) with issues`;
		view?.setResults(results, label);

		const errors = results.reduce((n, r) => n + this.errorCount(r.violations), 0);
		new Notice(
			errors > 0
				? `Note Schemas: ${errors} error(s) across ${results.length} note(s).`
				: results.length > 0
					? `Note Schemas: only warnings — ${results.length} note(s).`
					: "Note Schemas: all notes valid.",
		);
	}

	/** Validate the active note and update the status-bar indicator. */
	private validateActiveNote(): void {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			this.setStatus("neutral", "Schemas: —");
			return;
		}
		if (this.schema.loadError) {
			this.setStatus("neutral", "Schemas: error");
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const typeName = this.schema.resolveType(file, cache);
		if (!typeName) {
			this.setStatus("neutral", "Schemas: untyped");
			return;
		}
		const def = this.schema.getType(typeName);
		if (!def) {
			this.setStatus("neutral", "Schemas: untyped");
			return;
		}
		const violations = validateFrontmatter(cache?.frontmatter, typeName, def);
		const errors = this.errorCount(violations);
		if (errors > 0) {
			this.setStatus("invalid", `✗ ${typeName}: ${errors} error(s)`);
		} else if (violations.length > 0) {
			this.setStatus("warn", `⚠ ${typeName}: ${violations.length} warning(s)`);
		} else {
			this.setStatus("valid", `✓ ${typeName}`);
		}
	}

	/** Apply every safe fix to the active note via processFrontMatter. */
	private async fixActiveNote(file: TFile): Promise<void> {
		if (this.schema.isEmpty) {
			new Notice("Note Schemas: no schema configured.");
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const typeName = this.schema.resolveType(file, cache);
		if (!typeName) {
			new Notice("Note Schemas: this note does not match any type.");
			return;
		}
		const def = this.schema.getType(typeName);
		if (!def) return;
		const fixes = computeSafeFixes(cache?.frontmatter, def);
		if (fixes.length === 0) {
			new Notice("Note Schemas: nothing safe to fix.");
			return;
		}
		try {
			let applied = 0;
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				// Recompute against the live frontmatter: the metadata cache may lag the
				// editor, and applying stale fixes would clobber newer user edits.
				const liveFixes = computeSafeFixes(fm, def);
				for (const fix of liveFixes) fix.apply(fm);
				applied = liveFixes.length;
			});
			new Notice(`Note Schemas: applied ${applied} fix(es).`);
		} catch (e) {
			new Notice(`Note Schemas: fix failed — ${String(e)}`);
			return;
		}
		this.validateActiveNote();
	}

	private errorCount(violations: Violation[]): number {
		return violations.filter((v) => v.severity === "error").length;
	}

	private setStatus(kind: "valid" | "invalid" | "warn" | "neutral", text: string): void {
		this.statusBar.removeClass("is-valid", "is-invalid", "is-warn", "is-neutral");
		this.statusBar.addClass(`is-${kind}`);
		this.statusBar.setText(text);
	}

	/** Reveal the violations side panel, creating a leaf if necessary. */
	async activateView(): Promise<ViolationsView | null> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_VIOLATIONS);
		let leaf: WorkspaceLeaf | null;
		if (existing.length > 0) {
			leaf = existing[0];
			// A workspace-restored leaf may still hold a DeferredView (Obsidian 1.7.6+);
			// re-setting the view state forces the real ViolationsView to load.
			if (!(leaf.view instanceof ViolationsView)) {
				await leaf.setViewState({ type: VIEW_TYPE_VIOLATIONS, active: true });
			}
		} else {
			leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice("Note Schemas: could not open the side panel.");
				return null;
			}
			await leaf.setViewState({ type: VIEW_TYPE_VIOLATIONS, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		return view instanceof ViolationsView ? view : null;
	}
}
