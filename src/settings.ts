import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';
import type TabSpacesPlugin from './main';
import type { TitleOverflow } from './types';

const TITLE_OVERFLOW_OPTIONS: Record<TitleOverflow, string> = {
	truncate: 'Truncate with ellipsis',
	wrap: 'Wrap to multiple lines',
};

export class TabSpacesSettingTab extends PluginSettingTab {
	plugin: TabSpacesPlugin;

	constructor(app: App, plugin: TabSpacesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Declarative settings (1.13.0+): gets these into Obsidian's settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Confirm before completing a group',
				desc: "Ask before marking a group done and moving it to completed. Turn off once you're comfortable -- completed groups can still be restored.",
				control: { type: 'toggle', key: 'confirmBeforeComplete' },
			},
			{
				name: 'Long titles',
				desc: 'How to handle tab and group titles too long to fit on one line.',
				control: {
					type: 'dropdown',
					key: 'titleOverflow',
					options: TITLE_OVERFLOW_OPTIONS,
				},
			},
			{
				name: 'Hide tab bar',
				desc: "Hide Obsidian's native tab-header row across every pane, for a cleaner view. Since that row is also where the native \"+\" button lives, use each group's \"new tab\" menu item to open a blank tab instead.",
				control: { type: 'toggle', key: 'hideTabHeaders' },
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.store.settings[key as keyof typeof this.plugin.store.settings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await this.plugin.store.updateSettings({ [key]: value });
	}

	/** Fallback for Obsidian versions older than 1.13.0. Not called at all once getSettingDefinitions() above is available. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Confirm before completing a group')
			.setDesc(
				"Ask before marking a group done and moving it to completed. Turn off once you're comfortable -- completed groups can still be restored."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.store.settings.confirmBeforeComplete).onChange(async (value) => {
					await this.plugin.store.updateSettings({ confirmBeforeComplete: value });
				})
			);

		new Setting(containerEl)
			.setName('Long titles')
			.setDesc('How to handle tab and group titles too long to fit on one line.')
			.addDropdown((dropdown) => {
				for (const [key, label] of Object.entries(TITLE_OVERFLOW_OPTIONS)) dropdown.addOption(key, label);
				dropdown.setValue(this.plugin.store.settings.titleOverflow).onChange(async (value) => {
					await this.plugin.store.updateSettings({ titleOverflow: value as TitleOverflow });
				});
			});

		new Setting(containerEl)
			.setName('Hide tab bar')
			.setDesc(
				'Hide Obsidian\'s native tab-header row across every pane, for a cleaner view. Since that row is also where the native "+" button lives, use each group\'s "new tab" menu item to open a blank tab instead.'
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.store.settings.hideTabHeaders).onChange(async (value) => {
					await this.plugin.store.updateSettings({ hideTabHeaders: value });
				})
			);
	}
}
