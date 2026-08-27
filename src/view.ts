import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type NoteSchemasPlugin from "./main";
import { Violation } from "./validate";

export const VIEW_TYPE_VIOLATIONS = "note-schemas-violations";

/** All violations found for a single note, plus its resolved type. */
export interface NoteViolations {
	file: TFile;
	typeName: string;
	violations: Violation[];
}

/** Side-panel view listing schema violations grouped by note. */
export class ViolationsView extends ItemView {
	private plugin: NoteSchemasPlugin;
	private results: NoteViolations[] = [];
	private lastRunLabel = "";

	constructor(leaf: WorkspaceLeaf, plugin: NoteSchemasPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_VIOLATIONS;
	}

	getDisplayText(): string {
		return "Schema violations";
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	/** Replace the displayed results and re-render. */
	setResults(results: NoteViolations[], label: string): void {
		this.results = results;
		this.lastRunLabel = label;
		this.render();
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("note-schemas-view");

		const header = container.createDiv({ cls: "note-schemas-header" });
		header.createEl("h4", { text: "Schema violations" });
		const rerun = header.createEl("button", { text: "Re-validate", cls: "note-schemas-rerun" });
		rerun.onclick = () => void this.plugin.validateVault();

		if (this.plugin.schema.loadError) {
			container
				.createDiv({ cls: "note-schemas-empty is-error" })
				.setText(`Schema problem: ${this.plugin.schema.loadError}`);
			return;
		}

		const totalErrors = this.results.reduce(
			(n, r) => n + r.violations.filter((v) => v.severity === "error").length,
			0,
		);
		const totalWarnings = this.results.reduce(
			(n, r) => n + r.violations.filter((v) => v.severity === "warning").length,
			0,
		);

		const summary = container.createDiv({ cls: "note-schemas-summary" });
		if (this.lastRunLabel) summary.createSpan({ text: this.lastRunLabel + " · " });
		summary.createSpan({ cls: "note-schemas-count-error", text: `${totalErrors} error(s)` });
		summary.createSpan({ text: " · " });
		summary.createSpan({ cls: "note-schemas-count-warn", text: `${totalWarnings} warning(s)` });

		if (this.results.length === 0) {
			container
				.createDiv({ cls: "note-schemas-empty" })
				.setText("No violations. Run “Validate vault against schemas” to check every note.");
			return;
		}

		const list = container.createDiv({ cls: "note-schemas-list" });
		for (const result of this.results) {
			const group = list.createDiv({ cls: "note-schemas-group" });
			const title = group.createDiv({ cls: "note-schemas-note-title" });
			title.createSpan({ cls: "note-schemas-note-name", text: result.file.basename });
			title.createSpan({ cls: "note-schemas-note-type", text: result.typeName });
			title.onclick = () => void this.openNote(result.file);

			for (const v of result.violations) {
				const row = group.createDiv({
					cls: `note-schemas-violation is-${v.severity}`,
				});
				row.createSpan({ cls: "note-schemas-sev", text: v.severity === "error" ? "●" : "▲" });
				row.createSpan({ cls: "note-schemas-msg", text: v.message });
				row.onclick = () => void this.openNote(result.file);
			}
		}
	}

	private async openNote(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
