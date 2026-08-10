import type TabSpacesPlugin from './main';
import {
	type SpaceNode,
	type TabSpacesData,
	type TabSpacesSettings,
	type OpenBehavior,
	type ColorSlot,
	type ColorChoice,
	COLOR_SLOTS,
	DEFAULT_DATA,
	DEFAULT_SETTINGS,
	COMPLETED_PARENT_ID,
	generateId,
} from './types';

/** Retired sentinel: groups used to get parked here until organized. Now
 * every detected pane is a real, permanent, root-level group from the
 * moment it's created, so this bucket no longer exists -- only kept here to
 * migrate anything still pointing at it from before the change. */
const LEGACY_UNSORTED_PARENT_ID = '__unsorted__';

export class TabSpacesStore {
	private plugin: TabSpacesPlugin;
	private data: TabSpacesData;
	private listeners: Array<() => void> = [];

	constructor(plugin: TabSpacesPlugin) {
		this.plugin = plugin;
		this.data = { items: [], settings: { ...DEFAULT_SETTINGS } };
	}

	async load(): Promise<void> {
		const saved = (await this.plugin.loadData()) as Partial<TabSpacesData> | null;
		this.data = {
			items: saved?.items ?? DEFAULT_DATA.items,
			settings: { ...DEFAULT_SETTINGS, ...(saved?.settings ?? {}) },
		};
		// One-time migration: anything still filed under the retired Unsorted
		// bucket becomes a normal root-level group/tab, same as everything else.
		for (const item of this.data.items) {
			if (item.parentId === LEGACY_UNSORTED_PARENT_ID) item.parentId = null;
		}
		// Colour coding arrived after these groups/sections were created, so
		// backfill the slot they'd have been handed at creation -- otherwise
		// existing users would see an uncoloured sidebar until they made
		// something new, which reads as the feature being broken.
		for (const item of this.data.items) {
			if ((item.type === 'group' || item.type === 'section') && !item.autoColor) {
				item.autoColor = this.pickAutoColor();
			}
		}
	}

	/**
	 * Hands out the least-used slot, so a handful of groups and sections come
	 * out visibly different instead of the rotation doubling back early.
	 *
	 * Groups and sections share one rotation rather than counting separately:
	 * a section's stripe and a root-level group's stripe show up side by side
	 * in the same workspace, so letting each type restart the rotation would
	 * reliably hand the first section the same colour as the first group --
	 * exactly the collision the feature exists to prevent.
	 *
	 * Counts `autoColor` only: an explicit user choice shouldn't push the
	 * automatic rotation around.
	 */
	private pickAutoColor(): ColorSlot {
		const used = new Map<ColorSlot, number>(COLOR_SLOTS.map((slot) => [slot, 0]));
		for (const node of this.data.items) {
			if (!node.autoColor) continue;
			used.set(node.autoColor, (used.get(node.autoColor) ?? 0) + 1);
		}
		let best: ColorSlot = COLOR_SLOTS[0];
		for (const slot of COLOR_SLOTS) {
			if ((used.get(slot) ?? 0) < (used.get(best) ?? 0)) best = slot;
		}
		return best;
	}

	/**
	 * The colour a group/section actually displays, resolved in this order:
	 * the node's own explicit pick, then whatever its section resolves to
	 * (recursively, so a section nested in a section still follows), then its
	 * own auto-assigned slot.
	 *
	 * Inheritance living here -- rather than being copied onto each group when
	 * it's filed -- is what makes drag-into-a-section adopt the section colour
	 * with no move-time bookkeeping at all, and drag-back-out restore the
	 * group's own. Nothing has to notice the move; the answer is just derived
	 * fresh each time it's asked for.
	 */
	effectiveColor(node: SpaceNode): ColorSlot | undefined {
		// The single choke point every stripe and swatch already runs through,
		// which is what lets the master switch be one line instead of a
		// suppression rule duplicated across the sidebar and the workspace.
		if (!this.data.settings.colorCoding) return undefined;
		if (node.type !== 'group' && node.type !== 'section') return undefined;
		if (node.color) return node.color === 'none' ? undefined : node.color;
		const parent = node.parentId ? this.find(node.parentId) : undefined;
		// A section set to 'none' hands back undefined here, so its groups go
		// uncoloured with it -- no separate rule needed for the section case.
		if (parent?.type === 'section') return this.effectiveColor(parent);
		return node.autoColor;
	}

	/** `color: undefined` is "Automatic" -- back to inheriting from the section
	 * (or to this node's own auto-assigned slot when it isn't in one).
	 * `'none'` is the explicit opt-out, which inheritance can't override. */
	async setColor(id: string, color: ColorChoice | undefined): Promise<void> {
		const node = this.find(id);
		if (!node || (node.type !== 'group' && node.type !== 'section')) return;
		node.color = color;
		await this.save();
		this.notify();
	}

	/** Drops every explicit colour inside a section, so groups that had been
	 * individually recoloured fall back to following the section again. The
	 * "make this whole section one colour" escape hatch, kept as its own
	 * deliberate action rather than a side effect of setting the section's
	 * colour -- which would silently discard per-group choices. */
	async clearChildColors(sectionId: string): Promise<void> {
		let changed = false;
		for (const child of this.children(sectionId)) {
			if (child.color === undefined) continue;
			child.color = undefined;
			changed = true;
		}
		if (!changed) return;
		await this.save();
		this.notify();
	}

	/**
	 * Collapses every mutation made inside `fn` into a single disk write and a
	 * single change notification.
	 *
	 * Each mutator below ends in `save(); notify()`, which is right for a lone
	 * user action but pathological for a reconcile pass: that walks every open
	 * tab and can call syncTitle/syncViewState/setOrder on each, so an N-tab
	 * workspace paid N full `saveData()` serializations of the entire store
	 * plus N full sidebar re-renders -- all synchronous, all on the same main
	 * thread that xterm.js needs to accept keystrokes and paint. Batching turns
	 * that back into one of each.
	 *
	 * Re-entrant (depth-counted) because reconcile's helpers call each other,
	 * and flushed in a `finally` so a throw mid-pass still persists whatever
	 * already changed rather than silently dropping it.
	 */
	async batch<T>(fn: () => Promise<T>): Promise<T> {
		this.batchDepth++;
		try {
			return await fn();
		} finally {
			this.batchDepth--;
			if (this.batchDepth === 0 && this.batchPending) {
				this.batchPending = false;
				await this.plugin.saveData(this.data);
				this.notify();
			}
		}
	}

	private batchDepth = 0;
	private batchPending = false;

	async save(): Promise<void> {
		if (this.batchDepth > 0) {
			this.batchPending = true;
			return;
		}
		await this.plugin.saveData(this.data);
	}

	onChange(listener: () => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	private notify(): void {
		if (this.batchDepth > 0) {
			this.batchPending = true;
			return;
		}
		for (const listener of this.listeners) listener();
	}

	get settings(): TabSpacesSettings {
		return this.data.settings;
	}

	async updateSettings(patch: Partial<TabSpacesSettings>): Promise<void> {
		this.data.settings = { ...this.data.settings, ...patch };
		await this.save();
		this.notify();
	}

	get items(): SpaceNode[] {
		return this.data.items;
	}

	find(id: string): SpaceNode | undefined {
		return this.data.items.find((i) => i.id === id);
	}

	children(parentId: string | null): SpaceNode[] {
		return this.data.items
			.filter((item) => item.parentId === parentId)
			.sort((a, b) => a.order - b.order);
	}

	private nextOrder(parentId: string | null): number {
		const siblings = this.children(parentId);
		return siblings.length > 0 ? Math.max(...siblings.map((s) => s.order)) + 1 : 0;
	}

	/** Default title for a freshly-created group/section -- "Group 1",
	 * "Section 1", etc. -- since neither is named up front (a group is
	 * auto-created the moment a pane appears; a section is created instantly
	 * with no naming prompt). Renaming later is just the normal rename flow. */
	nextDefaultTitle(type: 'group' | 'section'): string {
		const count = this.data.items.filter((n) => n.type === type).length;
		const label = type === 'group' ? 'Group' : 'Section';
		return `${label} ${count + 1}`;
	}

	async addSection(title: string, parentId: string | null = null): Promise<SpaceNode> {
		const node: SpaceNode = {
			id: generateId(),
			type: 'section',
			title,
			parentId,
			order: this.nextOrder(parentId),
			collapsed: false,
			autoColor: this.pickAutoColor(),
		};
		this.data.items.push(node);
		await this.save();
		this.notify();
		return node;
	}

	async addGroup(
		title: string,
		parentId: string | null = null,
		openBehavior: OpenBehavior = this.data.settings.defaultOpenBehavior
	): Promise<SpaceNode> {
		const node: SpaceNode = {
			id: generateId(),
			type: 'group',
			title,
			parentId,
			order: this.nextOrder(parentId),
			collapsed: false,
			openBehavior: { ...openBehavior },
			autoColor: this.pickAutoColor(),
		};
		this.data.items.push(node);
		await this.save();
		this.notify();
		return node;
	}

	async addTab(
		groupId: string,
		tabKey: string,
		title: string,
		options: { filePath?: string; viewState?: unknown } = {}
	): Promise<SpaceNode> {
		const node: SpaceNode = {
			id: generateId(),
			type: 'tab',
			title,
			parentId: groupId,
			order: this.nextOrder(groupId),
			tabKey,
			filePath: options.filePath,
			viewState: options.viewState,
		};
		this.data.items.push(node);
		await this.save();
		this.notify();
		return node;
	}

	/** The user-facing rename (dblclick, F2, "Rename" menu item). Marks a tab's
	 * title as overridden so reconcile's live-title sync (see syncTitle) never
	 * clobbers a name the user deliberately chose. */
	async rename(id: string, title: string): Promise<void> {
		const node = this.find(id);
		if (!node) return;
		node.title = title;
		if (node.type === 'tab') node.titleOverridden = true;
		await this.save();
		this.notify();
	}

	/** Reconcile-only: keeps a tab's title in step with its live view (a
	 * renamed Terminus tab, a browser tab's title loading in, etc.), unless
	 * the user has explicitly renamed it via `rename()` above. */
	async syncTitle(id: string, title: string): Promise<void> {
		const node = this.find(id);
		if (!node || node.type !== 'tab' || node.titleOverridden || node.title === title) return;
		node.title = title;
		await this.save();
		this.notify();
	}

	/** Reconcile-only: keeps a tab's full view state in step with its live
	 * view. Titles get their own explicit sync (with an override guard) since
	 * users can rename those; there's no equivalent user-facing edit for view
	 * state, so it's always kept fresh -- this is the only place a URL lives
	 * for a browser tab, so without it, navigating within an already-tracked
	 * tab would silently go stale and reopening it later would land back on
	 * whatever page was open when it was first captured, not wherever it
	 * actually ended up. JSON-compares before writing so an unchanged tab
	 * (the common case on most reconcile passes) doesn't touch disk. */
	async syncViewState(id: string, viewState: unknown): Promise<void> {
		const node = this.find(id);
		if (!node || node.type !== 'tab') return;
		const next = JSON.stringify(viewState);
		if (JSON.stringify(node.viewState) === next) return;
		node.viewState = viewState;
		await this.save();
		this.notify();
	}

	/** Follows a vault file rename into every tab tracking it (`filePath` and
	 * `tabKey` are the same string for file-backed tabs) -- without this, a
	 * renamed file's old path stops matching anything open, so the tab looks
	 * closed to reconcile and either gets knocked out of its group as a
	 * "new" ad hoc one, or, if marked done, is left permanently pointing at a
	 * path that no longer exists. */
	async remapTabPath(oldPath: string, newPath: string, newTitle: string): Promise<void> {
		let changed = false;
		for (const node of this.data.items) {
			if (node.type !== 'tab' || node.filePath !== oldPath) continue;
			node.filePath = newPath;
			node.tabKey = newPath;
			if (!node.titleOverridden) node.title = newTitle;
			const state = (node.viewState as { state?: Record<string, unknown> } | undefined)?.state;
			if (state && state.file === oldPath) state.file = newPath;
			changed = true;
		}
		if (!changed) return;
		await this.save();
		this.notify();
	}

	/** Reconcile-only: re-derives a tab's stored order from its live tab-strip
	 * position, so dragging the actual Obsidian tabs updates the sidebar too.
	 * No-ops if the order already matches, so a normal reconcile pass with
	 * nothing to fix doesn't write to disk. */
	async setOrder(id: string, order: number): Promise<void> {
		const node = this.find(id);
		if (!node || node.order === order) return;
		node.order = order;
		await this.save();
		this.notify();
	}

	async toggleCollapsed(id: string): Promise<void> {
		const node = this.find(id);
		if (!node || (node.type !== 'group' && node.type !== 'section')) return;
		node.collapsed = !node.collapsed;
		await this.save();
		this.notify();
	}

	/** Purely cosmetic -- never closes or removes the tab. */
	async toggleDone(id: string): Promise<void> {
		const node = this.find(id);
		if (!node || node.type !== 'tab') return;
		node.done = !node.done;
		await this.save();
		this.notify();
	}

	async setDescription(id: string, description: string | undefined): Promise<void> {
		const node = this.find(id);
		if (!node || (node.type !== 'group' && node.type !== 'section')) return;
		node.description = description;
		await this.save();
		this.notify();
	}

	async setOpenBehavior(id: string, openBehavior: OpenBehavior): Promise<void> {
		const node = this.find(id);
		if (!node || node.type !== 'group') return;
		node.openBehavior = { ...openBehavior };
		await this.save();
		this.notify();
	}

	/** Tracks the pane a group is currently occupying; cleared once the pane closes. */
	async setHomeLeaf(id: string, leafId: string | undefined): Promise<void> {
		const node = this.find(id);
		if (!node || node.type !== 'group') return;
		node.homeLeafId = leafId;
		await this.save();
		this.notify();
	}

	async toggleHidden(id: string): Promise<void> {
		const node = this.find(id);
		if (!node || (node.type !== 'group' && node.type !== 'section')) return;
		node.hidden = !node.hidden;
		await this.save();
		this.notify();
	}

	groupByHomeLeaf(leafId: string): SpaceNode | undefined {
		return this.data.items.find((i) => i.type === 'group' && i.homeLeafId === leafId);
	}

	/** Removes a node. If it's a group/section, its descendants are removed too. */
	async remove(id: string): Promise<void> {
		const idsToRemove = new Set<string>([id]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const item of this.data.items) {
				if (item.parentId && idsToRemove.has(item.parentId) && !idsToRemove.has(item.id)) {
					idsToRemove.add(item.id);
					grew = true;
				}
			}
		}
		this.data.items = this.data.items.filter((i) => !idsToRemove.has(i.id));
		await this.save();
		this.notify();
	}

	/** Returns true if `ancestorId` is `id` itself or one of its ancestors. */
	private isDescendantOf(id: string, ancestorId: string): boolean {
		let current = this.find(id);
		while (current) {
			if (current.id === ancestorId) return true;
			current = current.parentId ? this.find(current.parentId) : undefined;
		}
		return false;
	}

	/**
	 * Moves `id` to be a child of `newParentId`, inserted at `index` among its
	 * new siblings. Reordering within the same parent, moving a tab to a
	 * different group, and moving a group into/out of a section are all just
	 * this one operation -- no special-casing needed.
	 */
	async moveInto(
		id: string,
		newParentId: string | null,
		index: number,
		options: { adoptSectionColor?: boolean } = {}
	): Promise<void> {
		const node = this.find(id);
		if (!node) return;
		// A group/section can't be dropped into itself or one of its own descendants.
		if (newParentId && (newParentId === id || this.isDescendantOf(newParentId, id))) return;

		const previousParentId = node.parentId;
		const newParent = newParentId ? this.find(newParentId) : undefined;
		node.parentId = newParentId;

		// Filing a group into a section adopts that section's colour, even if
		// the group had one of its own: dropping something into a colour-coded
		// section is a statement about where it now belongs, and a group that
		// kept its old colour would sit in the section looking like it wasn't
		// really part of it. Clearing the override (rather than overwriting it
		// with the section's slot) is what keeps the group tracking the section
		// afterwards, including if the section is later recoloured.
		//
		// Guarded on the parent actually changing, so reordering a group *within*
		// a section doesn't wipe a colour deliberately set while it lived there.
		// Restore opts out entirely -- putting a completed group back where it
		// came from should return it as it was, not repaint it.
		if (
			(options.adoptSectionColor ?? true) &&
			node.type === 'group' &&
			node.color !== undefined &&
			newParentId !== previousParentId &&
			newParent?.type === 'section'
		) {
			node.color = undefined;
		}

		const siblings = this.children(newParentId).filter((s) => s.id !== id);
		siblings.splice(Math.max(0, Math.min(index, siblings.length)), 0, node);
		siblings.forEach((s, i) => {
			s.order = i;
		});
		await this.save();
		this.notify();
	}

	get completed(): SpaceNode[] {
		return this.children(COMPLETED_PARENT_ID);
	}

	/**
	 * Marks a group done: remembers where it lived (so Restore can put it
	 * back), moves it under the reserved COMPLETED_PARENT_ID bucket. Does not
	 * touch any live leaves -- callers (leaf-sync) detach those first.
	 */
	async complete(id: string): Promise<void> {
		const node = this.find(id);
		if (!node || node.type !== 'group') return;
		node.lastParentId = node.parentId;
		node.homeLeafId = undefined;
		node.completedAt = Date.now();
		await this.moveInto(id, COMPLETED_PARENT_ID, this.children(COMPLETED_PARENT_ID).length);
	}

	/** Restores a completed group to its original section, or root if that's gone. */
	async restore(id: string): Promise<void> {
		const node = this.find(id);
		if (!node || node.type !== 'group') return;
		const target = node.lastParentId && this.find(node.lastParentId) ? node.lastParentId : null;
		node.completedAt = undefined;
		// Restoring is "put it back how it was", so it's the one move that
		// doesn't repaint the group to match the section it lands in.
		await this.moveInto(id, target, this.children(target).length, { adoptSectionColor: false });
	}
}
