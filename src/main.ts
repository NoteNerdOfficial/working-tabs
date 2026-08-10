import { Plugin, WorkspaceLeaf } from 'obsidian';
import { TabSpacesStore } from './store';
import { LeafSync } from './leaf-sync';
import { TabSpacesView } from './views/TabSpacesView';
import { TabSpacesSettingTab } from './settings';
import { VIEW_TYPE_WORKING_TABS } from './types';

export default class TabSpacesPlugin extends Plugin {
	store!: TabSpacesStore;
	leafSync!: LeafSync;

	async onload(): Promise<void> {
		this.store = new TabSpacesStore(this);
		await this.store.load();

		this.leafSync = new LeafSync(this, this.store);
		this.leafSync.start();

		this.applyHideTabHeaders();
		this.register(
			this.store.onChange(() => {
				this.applyHideTabHeaders();
				this.leafSync.refreshAccents();
			})
		);

		this.registerView(VIEW_TYPE_WORKING_TABS, (leaf) => new TabSpacesView(leaf, this));

		this.addRibbonIcon('layout-panel-left', 'Open working tabs', () => void this.activateView());

		this.addCommand({
			id: 'open-sidebar',
			name: 'Open sidebar',
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: 'toggle-hide-tab-bar',
			name: 'Toggle hide tab bar',
			callback: () => void this.store.updateSettings({ hideTabHeaders: !this.store.settings.hideTabHeaders }),
		});

		this.addSettingTab(new TabSpacesSettingTab(this.app, this));
	}

	/** Global appearance preference, not tied to any one pane -- toggled on a
	 * body class since Obsidian's tab-header row isn't reachable per-pane
	 * without hooking every pane's DOM as it opens/splits/closes. */
	private applyHideTabHeaders(): void {
		document.body.toggleClass('working-tabs-hide-tab-headers', this.store.settings.hideTabHeaders);
	}

	/** Called exactly once, the first time a user turns this plugin on. */
	onUserEnable(): void {
		void this.activateView();
	}

	private async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_WORKING_TABS)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeftLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE_WORKING_TABS, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	onunload(): void {
		// View instances clean up their own store subscription in onClose().
		document.body.removeClass('working-tabs-hide-tab-headers');
	}
}
