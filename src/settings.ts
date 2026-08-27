import { App, PluginSettingTab, Setting } from "obsidian";
import type NoteSchemasPlugin from "./main";

export interface NoteSchemasSettings {
	/** Vault-relative path to the schema file (JSON or YAML). */
	schemaPath: string;
	/** Validate the active note on save and reflect the result in the status bar. */
	validateOnSave: boolean;
}

export const DEFAULT_SETTINGS: NoteSchemasSettings = {
	// Resolved to `<configDir>/note-schemas.json` at load time (see defaultSchemaPath);
	// the config dir name is user-configurable, so it must not be hardcoded here.
	schemaPath: "",
	validateOnSave: true,
};

/** Default schema location inside the vault's config directory (usually `.obsidian`). */
export function defaultSchemaPath(configDir: string): string {
	return `${configDir}/note-schemas.json`;
}

export class NoteSchemasSettingTab extends PluginSettingTab {
	private plugin: NoteSchemasPlugin;

	constructor(app: App, plugin: NoteSchemasPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const fallbackPath = defaultSchemaPath(this.app.vault.configDir);
		new Setting(containerEl)
			.setName("Schema file path")
			.setDesc(
				"Vault-relative path to the schema definition. JSON (.json) or YAML (.yaml/.yml) are supported.",
			)
			.addText((text) =>
				text
					.setPlaceholder(fallbackPath)
					.setValue(this.plugin.settings.schemaPath)
					.onChange(async (value) => {
						this.plugin.settings.schemaPath = value.trim() || fallbackPath;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Validate on save")
			.setDesc("Re-validate the active note whenever it changes and show a status-bar indicator.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.validateOnSave).onChange(async (value) => {
					this.plugin.settings.validateOnSave = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Reload schema")
			.setDesc("Re-read the schema file from disk after editing it.")
			.addButton((btn) =>
				btn
					.setButtonText("Reload")
					.setCta()
					.onClick(async () => {
						await this.plugin.reloadSchema(true);
					}),
			);

		const status = containerEl.createDiv({ cls: "note-schemas-settings-status" });
		if (this.plugin.schema.loadError) {
			status.addClass("is-error");
			status.setText(`Schema problem: ${this.plugin.schema.loadError}`);
		} else if (this.plugin.schema.isEmpty) {
			status.setText("No types declared yet. Create the schema file to get started.");
		} else {
			status.setText(
				`Loaded ${this.plugin.schema.typeNames.length} type(s): ${this.plugin.schema.typeNames.join(", ")}`,
			);
		}
	}
}
