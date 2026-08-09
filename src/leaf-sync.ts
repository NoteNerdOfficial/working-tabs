import { Notice, TFile, WorkspaceLeaf, type ViewState } from 'obsidian';
import type TabSpacesPlugin from './main';
import type { TabSpacesStore } from './store';
import type { OpenBehavior, SpaceNode } from './types';
import { VIEW_TYPE_WORKING_TABS } from './types';

/** Every leaf has a runtime `id` (that's what getLeafById() looks up), but it
 * isn't part of the public WorkspaceLeaf type -- this is the standard
 * workaround community plugins use to track a specific pane across renders. */
function getLeafId(leaf: WorkspaceLeaf): string | undefined {
	return (leaf as unknown as { id?: string }).id;
}

/** Derived from the path alone (not leaf.view.getDisplayText()) so it works
 * the same whether or not the leaf's view has actually loaded yet. */
function titleFromPath(path: string): string {
	const base = path.split('/').pop() ?? path;
	return base.replace(/\.[^./]+$/, '') || base;
}

interface TabIdentity {
	/** Matching key used for reconcile's dedup/diff logic -- equals `path` when
	 * there is one (restart-stable), otherwise a session-scoped fallback. */
	key: string;
	/** Set only when this leaf is backed by a real vault file. */
	path?: string;
	title: string;
}


/**
 * Bridges the plugin's own group/section/tab data (in TabSpacesStore) with
 * Obsidian's live workspace. Nothing here has an analogue in a bookmarks-only
 * plugin, since bookmarks don't track live panes.
 */
export class LeafSync {
	constructor(
		private plugin: TabSpacesPlugin,
		private store: TabSpacesStore
	) {}

	private get app() {
		return this.plugin.app;
	}

	private get workspace() {
		return this.plugin.app.workspace;
	}

	/**
	 * Identifies a leaf for tracking purposes, whether or not it's backed by a
	 * vault file -- a terminal, an embedded browser tab, a canvas, or any other
	 * plugin's custom view is just as much a "tab" as a note is.
	 *
	 * The file path is read out of the leaf's *stored* view state instead of
	 * `leaf.view instanceof FileView`, because a background pane's view is
	 * often a lightweight `DeferredView` stand-in (not yet instantiated as a
	 * real MarkdownView/FileView) until the user actually clicks into it, so
	 * an instanceof check would silently skip every leaf in any split that
	 * isn't currently focused. The path is also verified against the vault --
	 * some non-file views happen to store an unrelated string under a `file`
	 * key too, which would otherwise get misread as a real path.
	 */
	private getTabIdentity(leaf: WorkspaceLeaf): TabIdentity {
		const viewState = leaf.getViewState();
		const rawFile = viewState.state?.file;
		const path =
			typeof rawFile === 'string' && this.app.vault.getAbstractFileByPath(rawFile) instanceof TFile
				? rawFile
				: undefined;
		if (path) return { key: path, path, title: titleFromPath(path) };

		// No file -- fall back to a session-scoped identity. This can't survive
		// a restart (leaf ids reset), which just reflects that most non-file
		// views (a terminal process, an in-memory web viewer tab) generally
		// can't be restored across a restart either.
		const leafId = getLeafId(leaf) ?? `${Date.now()}-${Math.random()}`;
		const title = leaf.getDisplayText() || viewState.type || 'Untitled';
		return { key: `${viewState.type}:${leafId}`, title };
	}

	/** The reverse of clicking a tab in the sidebar: given a leaf that just
	 * became active in the workspace, finds the stored tab tracking it (if
	 * any), so the sidebar can highlight/reveal it in turn. */
	findTabForLeaf(leaf: WorkspaceLeaf): SpaceNode | undefined {
		const key = this.getTabIdentity(leaf).key;
		return this.store.items.find((i) => i.type === 'tab' && i.tabKey === key);
	}

	private reconcileRunning = false;
	private reconcileQueued = false;
	/** Groups currently mid-open (see openGroup) -- reconcile skips syncing
	 * their tab list until opening finishes, to avoid treating "not created
	 * yet" the same as "closed". */
	private openingGroups = new Set<string>();

	start(): void {
		this.workspace.onLayoutReady(() => void this.reconcile());
		this.plugin.registerEvent(this.workspace.on('layout-change', () => void this.reconcile()));

		// A rename made through another plugin's own UI (e.g. Terminus letting
		// you rename a terminal tab) only touches that plugin's internal DOM
		// elements directly -- it doesn't fire any Obsidian workspace event, so
		// layout-change never sees it. A slow periodic fallback is the only way
		// to notice; syncTitle() already no-ops when nothing's actually changed,
		// so this costs nothing on the (typical) tick where titles are unchanged.
		this.plugin.registerInterval(window.setInterval(() => void this.reconcile(), 3000));

		// A file rename is a vault event, not a workspace layout-change --
		// without this, a renamed file's tab looks "closed" (old path no
		// longer open) while the new path looks like a brand-new tab, so it
		// gets orphaned out of its group instead of renamed in place.
		this.plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) void this.store.remapTabPath(oldPath, file.path, titleFromPath(file.path));
			})
		);
	}

	/**
	 * `layout-change` fires often (any tab/pane change), and a reconcile pass
	 * does several sequential awaited store mutations, each of which writes
	 * to disk. Without this guard, a second layout-change firing mid-pass
	 * would start an overlapping reconcile reading/writing the same data
	 * concurrently -- interleaved writes from two passes is exactly what
	 * produced the duplicate/missing tabs seen while testing this. Instead,
	 * a call that arrives while one is already running just requests exactly
	 * one more full pass after the current one finishes.
	 */
	private async reconcile(): Promise<void> {
		if (this.reconcileRunning) {
			this.reconcileQueued = true;
			return;
		}
		this.reconcileRunning = true;
		try {
			await this.doReconcile();
		} finally {
			this.reconcileRunning = false;
			if (this.reconcileQueued) {
				this.reconcileQueued = false;
				void this.reconcile();
			}
		}
	}

	/**
	 * Keeps live-tracking state honest against reality. Runs on every
	 * layout-change plus once at startup, since that's also how a group gets
	 * reclaimed after a restart: Obsidian's own session restore reopens last
	 * session's leaves (under new, unrelated leaf ids) before this plugin
	 * runs, so matching a stored group back to its pane has to go by the
	 * tab's identity key, not leaf id.
	 *
	 * Every open pane is, structurally, already a group of tabs -- so any pane
	 * not claimed by an existing group becomes a brand-new one, permanent from
	 * the moment it's created (no separate "Unsorted, deleted once empty"
	 * bucket -- once made, it behaves exactly like one you created yourself:
	 * goes dormant, not gone, when its pane closes). `leaf.parent` object
	 * identity is what distinguishes one pane from another within a single
	 * pass. This includes any leaf at all (a terminal, an embedded browser
	 * tab, a canvas, any other plugin's view) -- not just notes.
	 */
	private async doReconcile(): Promise<void> {
		const openLeafIds = new Set<string>();
		const keyToLeaf = new Map<string, WorkspaceLeaf>();
		const containerLeaves = new Map<object, { leaf: WorkspaceLeaf; identity: TabIdentity }[]>();

		this.workspace.iterateAllLeaves((leaf) => {
			const id = getLeafId(leaf);
			if (id) openLeafIds.add(id);
			// Left/right sidebar docks (backlinks, outline, a note someone
			// dragged into the sidebar, this plugin's own panel, etc.) are
			// utility docks, not "working tab" panes -- only the main editor
			// area's splits count as groupable panes.
			const root = leaf.getRoot();
			if (root === this.workspace.leftSplit || root === this.workspace.rightSplit) return;
			if (leaf.view.getViewType() === VIEW_TYPE_WORKING_TABS) return;

			const identity = this.getTabIdentity(leaf);
			if (!keyToLeaf.has(identity.key)) keyToLeaf.set(identity.key, leaf);
			const list = containerLeaves.get(leaf.parent) ?? [];
			list.push({ leaf, identity });
			containerLeaves.set(leaf.parent, list);
		});

		// Keep every currently-open tab's title and view state in step with its
		// live view -- a renamed Terminus tab, a browser tab's title loading in
		// (and its URL after navigating further, which otherwise only gets
		// captured once and goes stale), a note getting renamed elsewhere,
		// etc. -- regardless of which group it's filed under. syncTitle()
		// itself no-ops for anything the user has explicitly renamed via this
		// plugin; syncViewState() no-ops when nothing actually changed.
		const tabByKey = new Map<string, SpaceNode>();
		for (const item of this.store.items) {
			if (item.type === 'tab' && item.tabKey) tabByKey.set(item.tabKey, item);
		}
		for (const entries of containerLeaves.values()) {
			for (const { leaf, identity } of entries) {
				const tab = tabByKey.get(identity.key);
				if (!tab) continue;
				await this.store.syncTitle(tab.id, identity.title);
				await this.store.syncViewState(tab.id, leaf.getViewState());
			}
		}

		// Keep stored tab order in step with the live tab strip for any
		// currently-live group -- so dragging the *actual* Obsidian tabs
		// updates the sidebar's order too. Purely reads iterateAllLeaves'
		// traversal order (which matches visual left-to-right order), no
		// internal API needed for this direction. Live tabs are renumbered
		// first in their live sequence; done/closed tabs keep their relative
		// order, appended after.
		for (const node of this.store.items) {
			if (node.type !== 'group' || !node.homeLeafId) continue;
			const homeLeaf = this.workspace.getLeafById(node.homeLeafId);
			if (!homeLeaf) continue;
			const liveKeys = (containerLeaves.get(homeLeaf.parent) ?? []).map((e) => e.identity.key);
			if (liveKeys.length === 0) continue;
			const tabs = this.store.children(node.id);
			const liveTabs = tabs
				.filter((t) => t.tabKey && liveKeys.includes(t.tabKey))
				.sort((a, b) => liveKeys.indexOf(a.tabKey as string) - liveKeys.indexOf(b.tabKey as string));
			const otherTabs = tabs.filter((t) => !t.tabKey || !liveKeys.includes(t.tabKey));
			let index = 0;
			for (const tab of [...liveTabs, ...otherTabs]) await this.store.setOrder(tab.id, index++);
		}

		// 1. A group whose tracked *anchor* leaf closed isn't necessarily a
		// group whose whole *pane* closed -- closing one native tab among
		// several in the same pane only takes out whichever leaf happened to
		// be the tracking anchor. If another of this group's tabs is still
		// open, re-anchor to that leaf instead of dropping the group; only
		// clear it (truly inactive) when none of its tabs are open anywhere.
		// Without this, closing just the anchor tab left its still-open
		// siblings' pane unclaimed, and step 4 below would spin up a brand
		// new duplicate group for that same pane on this very pass.
		for (const node of this.store.items) {
			if (node.type !== 'group' || !node.homeLeafId || openLeafIds.has(node.homeLeafId)) continue;
			const survivingTab = this.store.children(node.id).find((t) => t.tabKey && keyToLeaf.has(t.tabKey));
			const replacement = survivingTab?.tabKey ? keyToLeaf.get(survivingTab.tabKey) : undefined;
			if (replacement) {
				await this.store.setHomeLeaf(node.id, getLeafId(replacement));
				continue;
			}
			// Truly nothing from this group is open anywhere anymore -- prune
			// whatever wasn't deliberately kept via the "done" checkbox
			// (otherwise its stale record would just sit there forever,
			// looking like a still-open tab that never closes), and if that
			// leaves the group with nothing at all, the group itself has no
			// reason to keep occupying the sidebar as an empty husk.
			await this.store.setHomeLeaf(node.id, undefined);
			for (const tab of this.store.children(node.id)) {
				if (!tab.done) await this.store.remove(tab.id);
			}
			if (this.store.children(node.id).length === 0) await this.store.remove(node.id);
		}

		// 2. Claim: a not-yet-live group whose every tab is open (regardless of
		// which pane) reattaches to that pane -- the native-session-restore
		// case. Only meaningful for tabs with a restart-stable key (real
		// files); non-file tabs just won't match here.
		const claimedContainers = new Map<object, string>();
		for (const node of this.store.items) {
			if (node.type !== 'group' || node.homeLeafId) continue;
			const tabs = this.store.children(node.id);
			if (tabs.length === 0) continue;
			const leaves = tabs.map((t) => (t.tabKey ? keyToLeaf.get(t.tabKey) : undefined));
			if (leaves.some((l) => !l)) continue;
			const first = leaves[0] as WorkspaceLeaf;
			const firstId = getLeafId(first);
			if (!firstId) continue;
			await this.store.setHomeLeaf(node.id, firstId);
			this.applyHiddenClass(node);
			claimedContainers.set(first.parent, node.id);
		}
		// Any group already live from an earlier pass.
		for (const node of this.store.items) {
			if (node.type !== 'group' || !node.homeLeafId) continue;
			const leaf = this.workspace.getLeafById(node.homeLeafId);
			if (leaf) claimedContainers.set(leaf.parent, node.id);
		}

		// 3. Every live group's tab list mirrors its pane's actual contents --
		// wherever a tab gets opened is where it belongs, whether that pane's
		// group is one filed in a section or one that just got created below.
		// This is also what makes a tab opened directly in Obsidian (not
		// through this plugin) show up somewhere instead of vanishing.
		for (const [container, groupId] of claimedContainers) {
			if (this.openingGroups.has(groupId)) continue;
			await this.syncGroupTabs(groupId, containerLeaves.get(container) ?? []);
		}

		// 4. Any pane still unclaimed gets a brand-new group, permanent from
		// here on -- it'll be reclaimed via the "already live" loop above on
		// every future pass for as long as its pane stays open, and once that
		// pane closes it just goes dormant like any other group, not deleted.
		for (const [container, entries] of containerLeaves) {
			if (claimedContainers.has(container)) continue;
			const group = await this.store.addGroup(this.store.nextDefaultTitle('group'), null);
			const firstId = getLeafId(entries[0].leaf);
			if (firstId) await this.store.setHomeLeaf(group.id, firstId);
			await this.syncGroupTabs(group.id, entries);
		}
	}

	/** Adds any of `entries` not already tracked under `groupId`, and prunes
	 * any currently-tracked, non-done tab whose leaf is no longer among them.
	 * A tab marked done was deliberately closed via the checkbox, not closed
	 * externally -- its leaf being gone is expected, not a signal to forget it. */
	private async syncGroupTabs(
		groupId: string,
		entries: { leaf: WorkspaceLeaf; identity: TabIdentity }[]
	): Promise<void> {
		// One row per unique key, even if the same tab happens to be open
		// twice in this pane -- dedupe before adding, since existingKeys below
		// is a snapshot from before this loop starts and wouldn't otherwise
		// catch a second entry with the same key.
		const openEntries = new Map(entries.map((e) => [e.identity.key, e]));
		for (const tab of this.store.children(groupId)) {
			if (tab.done) continue;
			if (!tab.tabKey || !openEntries.has(tab.tabKey)) await this.store.remove(tab.id);
		}
		const existingKeys = new Set(this.store.children(groupId).map((t) => t.tabKey));
		for (const [key, entry] of openEntries) {
			if (existingKeys.has(key)) continue;
			await this.store.addTab(groupId, key, entry.identity.title, {
				filePath: entry.identity.path,
				viewState: entry.leaf.getViewState(),
			});
		}
	}

	/**
	 * Ported from Vertical Tabs' own (proven, shipped-for-years) approach:
	 * toggle a class on the specific pane, then let a *declarative* CSS
	 * `:has()` selector (see styles.css) cascade the collapse up through
	 * however many nested splits are affected -- not JavaScript walking the
	 * DOM. An earlier attempt tried to replicate that cascade ourselves by
	 * recursively adjusting flex values, which occasionally corrupted the
	 * sizing of *other*, unrelated panes; CSS re-evaluating `:has()` on its
	 * own, with nothing but a class toggle from us, can't drift out of sync
	 * with the DOM the way hand-rolled JS state can.
	 */
	/** A group counts as hidden either because it was individually marked so,
	 * or because the section it's filed under was -- bulk-hiding a section
	 * doesn't overwrite each group's own flag, so un-hiding the section later
	 * restores whatever each group's individual state actually was. */
	private isEffectivelyHidden(group: SpaceNode): boolean {
		if (group.hidden) return true;
		const parent = group.parentId ? this.store.find(group.parentId) : undefined;
		return Boolean(parent?.type === 'section' && parent.hidden);
	}

	private applyHiddenClass(group: SpaceNode): void {
		if (!group.homeLeafId) return;
		const leaf = this.workspace.getLeafById(group.homeLeafId);
		const tabsEl = leaf?.view.containerEl.closest('.workspace-tabs') as HTMLElement | null;
		tabsEl?.toggleClass('working-tabs-hidden-pane', this.isEffectivelyHidden(group));
	}

	async toggleGroupHidden(id: string): Promise<void> {
		await this.store.toggleHidden(id);
		const group = this.store.find(id);
		if (group) this.applyHiddenClass(group);
	}

	/** Same mechanism as toggleGroupHidden, but for every group filed under a
	 * section at once -- each group's own `hidden` flag is untouched, only
	 * the section's is flipped, and isEffectivelyHidden combines the two. */
	async toggleSectionHidden(id: string): Promise<void> {
		await this.store.toggleHidden(id);
		for (const group of this.store.children(id)) {
			if (group.type === 'group') this.applyHiddenClass(group);
		}
	}

	/** For 'split', resolves the anchor pane ourselves and calls
	 * `createLeafBySplit` explicitly instead of `getLeaf('split', direction)`
	 * -- the same public API `getLeaf` uses internally (`getLeaf('split', d)`
	 * is just `createLeafBySplit(getMostRecentLeaf(), d)` under the hood), but
	 * going through it directly is one less layer to trust, and matches the
	 * mechanism the workspace drag-and-drop feature already uses successfully. */
	private createLeafFor(behavior: OpenBehavior): WorkspaceLeaf {
		switch (behavior.mode) {
			case 'split': {
				const anchor = this.workspace.getMostRecentLeaf();
				if (anchor) return this.workspace.createLeafBySplit(anchor, behavior.direction ?? 'vertical');
				return this.workspace.getLeaf('split', behavior.direction ?? 'vertical');
			}
			case 'window':
				return this.workspace.getLeaf('window');
			case 'tab':
			default:
				return this.workspace.getLeaf('tab');
		}
	}

	/** Opens a brand-new, empty pane per the chosen placement -- no group
	 * record is created here at all. The next reconcile pass finds the new
	 * pane unclaimed and auto-creates + auto-names its group ("Group N"),
	 * exactly like any other pane opened by hand; this is just the sidebar's
	 * "+ New group" row shortcut for that same, already-existing path. */
	async openNewGroup(behavior: OpenBehavior): Promise<void> {
		const leaf = this.createLeafFor(behavior);
		await leaf.setViewState({ type: 'empty', active: true });
		this.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/** viewState works for any view type (terminal, web viewer, canvas, notes
	 * with their scroll/mode preserved) and is preferred whenever present;
	 * plain openFile() is only a fallback for simple file tabs that don't
	 * have one captured. */
	private async openTabInLeaf(leaf: WorkspaceLeaf, tab: SpaceNode): Promise<void> {
		if (tab.viewState) {
			await leaf.setViewState({ ...(tab.viewState as ViewState), active: true });
			return;
		}
		if (!tab.filePath) return;
		const file = this.app.vault.getAbstractFileByPath(tab.filePath);
		if (file instanceof TFile) await leaf.openFile(file);
	}

	/** Whether a group currently has a live pane. */
	isLive(id: string): boolean {
		const group = this.store.find(id);
		return Boolean(group?.homeLeafId && this.workspace.getLeafById(group.homeLeafId));
	}

	private findOpenLeaf(tabKey: string | undefined): WorkspaceLeaf | undefined {
		if (!tabKey) return undefined;
		let found: WorkspaceLeaf | undefined;
		this.workspace.iterateAllLeaves((l) => {
			if (!found && this.getTabIdentity(l).key === tabKey) found = l;
		});
		return found;
	}

	/** Clicking a tab in the sidebar should focus that exact tab, not just
	 * whichever one happens to already be active in its pane. Opens the whole
	 * group first if it isn't live yet (or this particular tab isn't open --
	 * e.g. it was just un-done). */
	async focusTab(tab: SpaceNode): Promise<void> {
		if (tab.type !== 'tab' || !tab.parentId) return;
		let leaf = this.findOpenLeaf(tab.tabKey);
		if (!leaf) {
			await this.openGroup(tab.parentId);
			leaf = this.findOpenLeaf(tab.tabKey);
		}
		if (!leaf) return;
		await leaf.loadIfDeferred();
		this.workspace.setActiveLeaf(leaf, { focus: true });
		await this.workspace.revealLeaf(leaf);
	}

	/** Activates a group: reveals its pane if still live, otherwise reopens
	 * all its tabs into a fresh pane per `behaviorOverride` or its own
	 * OpenBehavior, remembering the override as its new default. */
	async openGroup(id: string, behaviorOverride?: OpenBehavior): Promise<void> {
		const group = this.store.find(id);
		if (!group || group.type !== 'group') return;

		if (this.isEffectivelyHidden(group)) {
			// Tucked away, not actually closed -- clear whichever flag(s) are
			// making it hidden (its own, its section's, or both) rather than
			// calling revealLeaf on a pane our own styles.css is still forcing
			// display:none on. Opening a specific group is a clear enough
			// signal to show it even if its whole section was hidden.
			if (group.hidden) await this.store.toggleHidden(id);
			const parent = group.parentId ? this.store.find(group.parentId) : undefined;
			if (parent?.type === 'section' && parent.hidden) await this.store.toggleHidden(parent.id);
			this.applyHiddenClass(group);
		}

		if (group.homeLeafId) {
			const leaf = this.workspace.getLeafById(group.homeLeafId);
			if (leaf) {
				await leaf.loadIfDeferred();
				await this.workspace.revealLeaf(leaf);
				return;
			}
		}

		const tabs = this.store.children(id).filter((t) => t.viewState || t.filePath);
		if (tabs.length === 0) return;

		const behavior = behaviorOverride ?? group.openBehavior ?? this.store.settings.defaultOpenBehavior;
		if (behaviorOverride) await this.store.setOpenBehavior(id, behaviorOverride);

		// "New tab" adds to whichever pane is currently active, same as
		// Obsidian's own new-tab behavior -- if another group already lives in
		// that pane, it's about to become shared. Only 'tab' mode can land in
		// an already-owned pane; split/window always create a fresh one.
		const owner =
			behavior.mode === 'tab' ? this.findOwningGroup(this.workspace.getMostRecentLeaf()?.parent, id) : undefined;

		const first = this.createLeafFor(behavior);

		// Claim the pane immediately -- before opening any tab's content or
		// creating the rest, both of which await and so can let a
		// layout-change-triggered reconcile() interleave. Reconcile has no way
		// to know these leaves belong to this group until homeLeafId says so,
		// so a pass sneaking in during that gap would see an unclaimed pane
		// and spin up a duplicate new group for it. Skipped entirely in the
		// merge case below, since this group is about to be archived, not left live.
		if (!owner) {
			const firstId = getLeafId(first);
			if (firstId) await this.store.setHomeLeaf(id, firstId);
		}

		// The pane is now claimed but only partially populated -- opening tabs
		// 2..N one at a time below still awaits between each, still letting a
		// reconcile pass interleave. Without this guard, a pass sneaking in
		// mid-loop would see the pane as claimed-but-only-has-1-tab-so-far and
		// prune the rest as if they'd been closed, then re-add each as it
		// actually appears a moment later -- the "tabs disappear one by one,
		// then reappear" flicker. Suppressing this group's own sync for the
		// duration of opening it sidesteps the ambiguity entirely: reconcile
		// still runs and still syncs every *other* live group normally.
		this.openingGroups.add(id);
		try {
			await this.openTabInLeaf(first, tabs[0]);

			for (const tab of tabs.slice(1)) {
				const leaf = this.workspace.createLeafInParent(first.parent, 9999);
				await this.openTabInLeaf(leaf, tab);
			}
		} finally {
			this.openingGroups.delete(id);
		}

		if (owner) {
			// Its tabs are now physically sitting in the owner's pane and will
			// merge into that group automatically via reconcile()'s live
			// mirroring -- no need to move the records over by hand. This
			// group is now empty of any live pane of its own, so it's just
			// removed rather than archived -- archiving it left a stale,
			// never-reopenable duplicate of the same tabs sitting under
			// Completed alongside the real, live copy in the owner group.
			await this.store.remove(id);
			new Notice(`"${group.title}" merged into "${owner.title}".`);
			return;
		}

		await this.workspace.revealLeaf(first);
	}

	private findOwningGroup(container: unknown, excludeId: string): SpaceNode | undefined {
		if (!container) return undefined;
		return this.store.items.find(
			(n) =>
				n.type === 'group' &&
				n.id !== excludeId &&
				n.homeLeafId &&
				this.workspace.getLeafById(n.homeLeafId)?.parent === container
		);
	}

	/**
	 * Opens a group's tabs anchored to a *specific* pane the user dropped it
	 * onto (see TabSpacesView's workspace drop zones), instead of
	 * `openGroup`'s implicit "whichever pane Obsidian thinks was most
	 * recently active" -- dragging directly onto a pane's edge is exactly as
	 * unambiguous as it looks, so there's no guessing involved here the way
	 * there is with the "Open in..." menu's split-right/split-down choices.
	 * `createLeafBySplit` is the same public API `getLeaf('split', ...)` uses
	 * internally, just with an explicit anchor instead of an implicit one.
	 *
	 * Works the same whether the group is dormant or already live: an
	 * already-live group is treated as "move this pane" -- closed at its
	 * current spot first, then reopened fresh at the drop target. Its tabs'
	 * viewState is kept continuously up to date (see syncViewState), so this
	 * reopen is a close approximation of a true in-place relocate, without
	 * the fragility of hand-rolling Obsidian's own internal split-tree
	 * surgery to actually move the live pane object -- the kind of custom
	 * DOM manipulation that corrupted an unrelated pane's sizing the one
	 * other time this codebase tried it (see the hide-pane CSS comment above).
	 */
	async openGroupAtDropTarget(
		id: string,
		targetLeaf: WorkspaceLeaf,
		zone: 'top' | 'bottom' | 'left' | 'right' | 'center'
	): Promise<void> {
		const group = this.store.find(id);
		if (!group || group.type !== 'group') return;

		if (group.homeLeafId) {
			const currentLeaf = this.workspace.getLeafById(group.homeLeafId);
			// Dropped back onto its own current pane -- nothing to do.
			if (currentLeaf && currentLeaf.parent === targetLeaf.parent) return;
		}

		const tabs = this.store.children(id).filter((t) => t.viewState || t.filePath);
		if (tabs.length === 0) return;

		// Guards the whole operation, including the close-if-live step below,
		// not just the reopen -- otherwise a reconcile pass landing in the
		// brief gap between closing the old pane and claiming the new one
		// would see this group's tabs recorded but momentarily not open
		// anywhere, which is harmless (it just skips them) but unnecessary
		// to risk when the guard is this cheap to widen.
		this.openingGroups.add(id);
		try {
			if (group.homeLeafId && this.workspace.getLeafById(group.homeLeafId)) await this.closeGroup(id);

			if (zone === 'center') {
				// Dropped into the middle of an existing pane -- merge as new
				// tabs there, same idea as "Open in... New tab" landing in an
				// already-owned pane, just with an explicit target instead of
				// whatever Obsidian considers "most recently active".
				const owner = this.findOwningGroup(targetLeaf.parent, id);
				if (!owner) return;
				for (const tab of tabs) {
					const leaf = this.workspace.createLeafInParent(targetLeaf.parent, 9999);
					await this.openTabInLeaf(leaf, tab);
				}
				await this.store.remove(id);
				new Notice(`"${group.title}" merged into "${owner.title}".`);
				return;
			}

			const direction = zone === 'top' || zone === 'bottom' ? 'horizontal' : 'vertical';
			const before = zone === 'top' || zone === 'left';
			const first = this.workspace.createLeafBySplit(targetLeaf, direction, before);

			const firstId = getLeafId(first);
			if (firstId) await this.store.setHomeLeaf(id, firstId);

			await this.openTabInLeaf(first, tabs[0]);
			for (const tab of tabs.slice(1)) {
				const leaf = this.workspace.createLeafInParent(first.parent, 9999);
				await this.openTabInLeaf(leaf, tab);
			}
			await this.workspace.revealLeaf(first);
		} finally {
			this.openingGroups.delete(id);
		}
	}

	/** Closes a group's live pane (all sibling leaves in it), without touching stored data. */
	async closeGroup(id: string): Promise<void> {
		const group = this.store.find(id);
		if (!group || group.type !== 'group' || !group.homeLeafId) return;
		const leaf = this.workspace.getLeafById(group.homeLeafId);
		if (leaf) {
			const container = leaf.parent;
			const siblings: WorkspaceLeaf[] = [];
			this.workspace.iterateAllLeaves((l) => {
				if (l.parent === container) siblings.push(l);
			});
			for (const sibling of siblings) sibling.detach();
		}
		await this.store.setHomeLeaf(id, undefined);
	}

	async completeGroup(id: string): Promise<void> {
		await this.closeGroup(id);
		await this.store.complete(id);
	}

	/** Opens a blank tab in a live group's pane -- the sidebar's stand-in for
	 * Obsidian's native "+" button, which lives in the tab-header row the
	 * "Hide tab bar" setting hides. Not open yet -- if it's dormant in a
	 * section, use "Open" first. */
	async addBlankTab(groupId: string): Promise<void> {
		const group = this.store.find(groupId);
		if (!group || group.type !== 'group') return;

		let homeLeaf = group.homeLeafId ? this.workspace.getLeafById(group.homeLeafId) : null;

		// Dormant but has tabs to its name -- open it first (reusing openGroup's
		// own merge-detection etc.), then add the blank tab to its now-live pane.
		if (!homeLeaf && this.store.children(groupId).length > 0) {
			await this.openGroup(groupId);
			const opened = this.store.find(groupId);
			homeLeaf = opened?.type === 'group' && opened.homeLeafId ? this.workspace.getLeafById(opened.homeLeafId) : null;
			if (!homeLeaf) return; // opening failed, or it merged into another group and got archived
		}

		if (homeLeaf) {
			const leaf = this.workspace.createLeafInParent(homeLeaf.parent, 9999);
			await leaf.setViewState({ type: 'empty', active: true });
			this.workspace.setActiveLeaf(leaf, { focus: true });
			return;
		}

		// Brand-new, empty group with no pane yet -- this blank tab becomes its first one.
		const behavior = group.openBehavior ?? this.store.settings.defaultOpenBehavior;
		const leaf = this.createLeafFor(behavior);
		const leafId = getLeafId(leaf);
		if (leafId) await this.store.setHomeLeaf(groupId, leafId);
		await leaf.setViewState({ type: 'empty', active: true });
		this.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/** Detaches a tab's live leaf (if its group is live and that tab is
	 * actually open in its pane) without touching stored data -- used both by
	 * the "mark done" checkbox (keep the record, just close it) and as the
	 * first half of closeTab (which also forgets the record). */
	async closeLiveTabOnly(tab: SpaceNode): Promise<void> {
		if (tab.type !== 'tab' || !tab.parentId || !tab.tabKey) return;
		const group = this.store.find(tab.parentId);
		if (group?.type !== 'group' || !group.homeLeafId) return;
		const homeLeaf = this.workspace.getLeafById(group.homeLeafId);
		if (!homeLeaf) return;
		const container = homeLeaf.parent;
		const siblings: WorkspaceLeaf[] = [];
		this.workspace.iterateAllLeaves((l) => {
			if (l.parent === container) siblings.push(l);
		});
		const matches = siblings.filter((l) => this.getTabIdentity(l).key === tab.tabKey);

		// If the leaf we're about to close is the group's own tracked anchor,
		// hand tracking off to another still-open sibling first -- otherwise
		// the whole group would look inactive just because this one tab (not
		// the whole pane) closed.
		if (matches.some((l) => getLeafId(l) === group.homeLeafId)) {
			const replacement = siblings.find((l) => !matches.includes(l));
			await this.store.setHomeLeaf(group.id, replacement ? getLeafId(replacement) : undefined);
		}

		for (const match of matches) match.detach();
	}

	/** How many of `tab`'s siblings (by stored order) currently have a live
	 * leaf in `groupId`'s pane -- the correct index to insert/reposition
	 * `tab` at, so it lands where it actually belongs instead of at the end. */
	private countLiveSiblingsBefore(groupId: string, tab: SpaceNode, excludeTabId?: string): number {
		const group = this.store.find(groupId);
		if (!group || group.type !== 'group' || !group.homeLeafId) return 0;
		const homeLeaf = this.workspace.getLeafById(group.homeLeafId);
		if (!homeLeaf) return 0;
		const container = homeLeaf.parent;
		const openKeys = new Set<string>();
		this.workspace.iterateAllLeaves((l) => {
			if (l.parent === container) openKeys.add(this.getTabIdentity(l).key);
		});
		return this.store
			.children(groupId)
			.filter((s) => s.id !== excludeTabId && s.order < tab.order && s.tabKey && openKeys.has(s.tabKey))
			.length;
	}

	/** Reopens one specific tab into its group's live pane (e.g. after
	 * unchecking "done"), at the position it actually belongs among its
	 * currently-open siblings -- not just appended at the end. Does nothing
	 * if the group isn't currently live; the tab will simply show up normally
	 * next time the whole group opens. */
	async reopenTab(tab: SpaceNode): Promise<void> {
		if (tab.type !== 'tab' || !tab.parentId) return;
		const group = this.store.find(tab.parentId);
		if (group?.type !== 'group' || !group.homeLeafId) return;
		const homeLeaf = this.workspace.getLeafById(group.homeLeafId);
		if (!homeLeaf) return;
		const index = this.countLiveSiblingsBefore(group.id, tab);
		const leaf = this.workspace.createLeafInParent(homeLeaf.parent, index);
		await this.openTabInLeaf(leaf, tab);
	}

	/**
	 * Repositions a tab's already-open leaf to match where it now sits in the
	 * sidebar (after a drag-to-reorder, or a drag into a different group) --
	 * relocating it between panes too if the group it was dropped into isn't
	 * the one it was already open in.
	 *
	 * Obsidian has no public API for repositioning an already-open leaf, so
	 * this uses the same undocumented `WorkspaceParent.removeChild`/
	 * `insertChild`/`selectTabIndex` internals the Vertical Tabs plugin relies
	 * on for its own tab reordering. Guarded with an existence check so it
	 * quietly no-ops instead of throwing if a future Obsidian version removes
	 * or renames them.
	 */
	async relocateLiveLeaf(tab: SpaceNode): Promise<void> {
		if (tab.type !== 'tab' || !tab.parentId || !tab.tabKey) return;
		const group = this.store.find(tab.parentId);
		if (!group || group.type !== 'group' || !group.homeLeafId) return;
		const homeLeaf = this.workspace.getLeafById(group.homeLeafId);
		if (!homeLeaf) return;
		const targetContainer = homeLeaf.parent;

		const sourceLeaf = this.findOpenLeaf(tab.tabKey);
		if (!sourceLeaf) return; // not currently open -- nothing to relocate

		const index = this.countLiveSiblingsBefore(group.id, tab, tab.id);
		const source = sourceLeaf.parent as unknown as { removeChild?: (leaf: WorkspaceLeaf) => void };
		const target = targetContainer as unknown as {
			insertChild?: (index: number, leaf: WorkspaceLeaf) => void;
			selectTabIndex?: (index: number) => void;
		};
		if (typeof source.removeChild !== 'function' || typeof target.insertChild !== 'function') return;

		source.removeChild(sourceLeaf);
		target.insertChild(index, sourceLeaf);
		target.selectTabIndex?.(index);
		(this.workspace as unknown as { requestResize?: () => void }).requestResize?.();
	}

	/** Closes one specific tab: detaches its live leaf and forgets it, same as
	 * closing a browser tab. Without the detach half, "removing" a tab that's
	 * still genuinely open would just have reconcile() re-add it right back
	 * under Unsorted on the next pass. */
	async closeTab(tab: SpaceNode): Promise<void> {
		await this.closeLiveTabOnly(tab);
		await this.store.remove(tab.id);
		if (tab.parentId) await this.removeGroupIfEmpty(tab.parentId);
	}

	/** A group left with nothing at all -- no live tabs, no done ones kept on
	 * purpose -- has no reason to keep occupying the sidebar. Used after any
	 * plugin-initiated tab removal; reconcile's own step 1 handles the same
	 * cleanup for tabs closed natively in Obsidian. */
	private async removeGroupIfEmpty(groupId: string): Promise<void> {
		const group = this.store.find(groupId);
		if (group?.type === 'group' && this.store.children(groupId).length === 0) {
			await this.store.remove(groupId);
		}
	}
}
