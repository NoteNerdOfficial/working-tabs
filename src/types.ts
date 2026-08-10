export type NodeType = 'section' | 'group' | 'tab';

/**
 * Colour-coding palette. Stored as a slot id, never a hex -- every slot maps to
 * a CSS custom property (see styles.css), which in turn defers to Obsidian's own
 * `--color-*` variables, so a colour picked in a dark theme stays right after
 * switching to a light one. A stored hex would be frozen to whichever theme
 * happened to be active when it was chosen.
 *
 * Order matters: it's the rotation auto-assignment walks (see
 * TabSpacesStore.pickAutoColor), so the first few slots are the ones most
 * people will actually see.
 */
export const COLOR_SLOTS = ['blue', 'purple', 'green', 'orange', 'cyan', 'pink', 'yellow', 'red'] as const;

export type ColorSlot = (typeof COLOR_SLOTS)[number];

/** What a group/section can be set to. The `'none'` sentinel is deliberately
 * distinct from leaving `color` unset: unset means "inherit" (follow my
 * section, or fall back to my auto-assigned slot), while `'none'` is an
 * explicit "show no colour at all" that a section's colour can't override. */
export type ColorChoice = ColorSlot | 'none';

export const COLOR_LABELS: Record<ColorSlot, string> = {
	blue: 'Blue',
	purple: 'Purple',
	green: 'Green',
	orange: 'Orange',
	cyan: 'Cyan',
	pink: 'Pink',
	yellow: 'Yellow',
	red: 'Red',
};

export type PaneType = 'tab' | 'split' | 'window';

export interface OpenBehavior {
	mode: PaneType;
	/** Only meaningful when mode === 'split'. */
	direction?: 'vertical' | 'horizontal';
}

/**
 * A single flat tree, same shape for sections/groups/tabs -- reorder,
 * reparent (move to another group/section), rename, and delete all become
 * one generic operation each instead of three parallel implementations.
 */
export interface SpaceNode {
	id: string;
	type: NodeType;
	title: string;
	/** null = root level. Or a real section/group id. Or one of the sentinels below. */
	parentId: string | null;
	order: number;

	/** Groups and sections only. */
	collapsed?: boolean;
	/** Groups and sections -- optional short note shown below the title. */
	description?: string;

	/** Groups only -- how this group's tabs get opened when activated. */
	openBehavior?: OpenBehavior;
	/** Groups only -- the pane (WorkspaceLeaf id) this group last occupied, reused if still valid. */
	homeLeafId?: string;
	/** Groups and sections. For a group: when true, its pane is hidden from
	 * the main workspace (not closed, still open in the background -- see
	 * LeafSync.applyHiddenClass). For a section: when true, every group filed
	 * under it is treated as hidden too, regardless of that group's own flag
	 * -- see LeafSync.isEffectivelyHidden. */
	hidden?: boolean;

	/** Groups and sections -- the colour the user explicitly picked. Absent
	 * means "inherit", which is the default state: a group filed under a
	 * section shows that section's colour, so dragging a group in adopts the
	 * section instantly and dragging it out returns it to its own.
	 *
	 * An explicit colour outranks inheritance but is *not* permanent: filing a
	 * group into a section clears it, so the group joins the section's colour
	 * rather than sitting inside it looking unrelated (see
	 * TabSpacesStore.moveInto). It survives reordering within a section, and
	 * survives being completed and restored.
	 *
	 * `'none'` is an explicit "no colour at all" that a section can't override.
	 * See TabSpacesStore.effectiveColor for the full resolution order. */
	color?: ColorChoice;
	/** Groups and sections -- the slot handed out automatically at creation, so
	 * colour coding works without anyone opening a menu. Only consulted once
	 * nothing above it in the chain has an explicit `color`, which is why a
	 * group's own autoColor stays dormant for as long as it lives in a
	 * section. Never shown to the user as a choice; picking any colour writes
	 * `color` instead, and "Automatic" clears that to fall back here. */
	autoColor?: ColorSlot;

	/** Tabs only -- internal matching key used by reconcile to tell "same tab, still
	 * open" apart from "closed". Equals filePath for note/file tabs (stable across
	 * restarts); for tabs with no file (a terminal, web viewer, etc.) it's a
	 * session-scoped `viewType:leafId` -- those can't be restart-matched in general,
	 * which just reflects that most non-file views aren't restorable that way either. */
	tabKey?: string;
	/** Tabs only -- set when this tab is backed by a real vault file; used to reopen
	 * it via openFile() and to survive restarts. Absent for non-file tabs (terminal,
	 * web viewer, canvas without a file, etc.) -- those rely on `viewState` alone. */
	filePath?: string;
	/** Tabs only -- raw leaf.getViewState(). For file tabs this preserves fidelity
	 * (mode/scroll); for non-file tabs it's the *only* way to reopen them at all. */
	viewState?: unknown;
	/** Tabs only -- cosmetic "done" checkbox; never closes or removes the tab. */
	done?: boolean;
	/** Tabs only -- set once the title has been explicitly renamed via this
	 * plugin's own UI, so reconcile's live-title sync (e.g. picking up a
	 * renamed Terminus tab or a browser tab's title loading in) stops
	 * overwriting it. */
	titleOverridden?: boolean;

	/** Groups only, once moved under COMPLETED_PARENT_ID. */
	completedAt?: number;
	/** Groups only -- where to restore to if its original section/parent is gone. */
	lastParentId?: string | null;
}

/** Reserved parentId value for the Completed bucket, so it reuses the same node
 * machinery (rename/delete/restore/drag all keep working with zero special-casing)
 * instead of living in a separate array. Never collides with a real id since
 * generateId() only ever produces base36 timestamp+random strings. */
export const COMPLETED_PARENT_ID = '__completed__';

export type TitleOverflow = 'truncate' | 'wrap';

export interface TabSpacesSettings {
	confirmBeforeComplete: boolean;
	defaultOpenBehavior: OpenBehavior;
	titleOverflow: TitleOverflow;
	/** Hides Obsidian's native tab-header row globally -- pairs with the "New tab"
	 * group-menu item, since that row is also where the native "+" button lives. */
	hideTabHeaders: boolean;
	/** Master switch for colour coding. Off suppresses every stripe and swatch
	 * without touching a single stored colour, so turning it back on restores
	 * exactly what was set before -- and it spares anyone who doesn't want the
	 * feature from setting "No colour" on every group forever, only for the
	 * next auto-assigned one to arrive coloured anyway. */
	colorCoding: boolean;
}

export interface TabSpacesData {
	items: SpaceNode[];
	settings: TabSpacesSettings;
}

export const DEFAULT_SETTINGS: TabSpacesSettings = {
	confirmBeforeComplete: true,
	defaultOpenBehavior: { mode: 'tab' },
	titleOverflow: 'truncate',
	hideTabHeaders: false,
	colorCoding: true,
};

export const DEFAULT_DATA: TabSpacesData = {
	items: [],
	settings: DEFAULT_SETTINGS,
};

export const VIEW_TYPE_WORKING_TABS = 'working-tabs-view';

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}
