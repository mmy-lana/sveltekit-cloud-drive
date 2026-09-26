/**
 * Multi-selection.
 *
 * Purely presentational: the plan explicitly allows optimistic updates for
 * selection, view mode and the search query, because none of them are
 * authoritative. Nothing here writes to Firestore — a selection only ever
 * names items a later operation will look up again.
 *
 * Three input models
 * -----------------
 * **Pointer (mouse/trackpad).** A plain click selects, Cmd/Ctrl-click toggles,
 * Shift-click extends a range. The range anchor is the last item *acted on*,
 * not the last item selected, which is what makes a second Shift-click
 * collapse the range the way file managers behave.
 *
 * **Touch.** A tap opens; a 400 ms press enters multi-select. The press only
 * arms while the finger is still, because a press is really the start of a
 * scroll: once the pointer has moved further than the slop radius, or once the
 * page has scrolled, the press is abandoned rather than converting into a
 * selection. Without that check, scrolling a long list on a phone would
 * scatter selections across every row the thumb passed over.
 *
 * **Keyboard.** Shift+Arrow moves the range, Space toggles, Escape clears.
 */
import type { SelectionState } from '$lib/types/drive';

/** Milliseconds a touch must be held before multi-select engages. */
const LONG_PRESS_MS = 400;

/**
 * Movement allowed during a long press, in CSS pixels.
 *
 * A finger that moves more than this is scrolling, not pressing. The value is
 * deliberately larger than a tap slop: a press is longer and less precise than
 * a tap, and a boundary that cancelled on a 2 px wobble would fire
 * unpredictably.
 */
const LONG_PRESS_SLOP_PX = 12;

/** A resolved intent from a pointer or key event. */
export type SelectionIntent =
  | { readonly kind: 'select'; readonly id: string }
  | { readonly kind: 'toggle'; readonly id: string }
  | { readonly kind: 'range'; readonly id: string }
  | { readonly kind: 'long-press'; readonly id: string };

/** Per-item press bookkeeping. */
interface PressState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  timer: ReturnType<typeof setTimeout>;
}

class SelectionStore {
  #selectedIds = $state<Set<string>>(new Set());
  #anchorId = $state<string | null>(null);
  /** The ids visible when the current range was last computed. */
  #orderSnapshot: readonly string[] = [];
  #presses = new Map<string, PressState>();
  /** Multi-select engaged by a long press, until dismissed. */
  #multiSelectMode = $state(false);
  /** True once a selection exists, which is what reveals the batch bar. */
  #active = $state(false);

  /** The currently selected ids. */
  get selectedIds(): ReadonlySet<string> {
    return this.#selectedIds;
  }

  /** `true` when at least one item is selected. */
  get isActive(): boolean {
    return this.#active;
  }

  /** `true` when a long press has engaged multi-select on a touch device. */
  get isMultiSelectMode(): boolean {
    return this.#multiSelectMode;
  }

  /** The range anchor, for the visible range highlight. */
  get anchorId(): string | null {
    return this.#anchorId;
  }

  /** Number of selected items, for the batch bar's count. */
  get count(): number {
    return this.#selectedIds.size;
  }

  /** `true` when this id is selected. */
  has(id: string): boolean {
    return this.#selectedIds.has(id);
  }

  /** Replace the ids a range may span, on every listing change. */
  setVisibleOrder(ids: readonly string[]): void {
    this.#orderSnapshot = [...ids];
  }

  /** The ids a range from the anchor to `id` would cover. */
  rangeTo(id: string): string[] {
    const anchor = this.#anchorId;
    if (anchor === null) return [id];

    const from = this.#orderSnapshot.indexOf(anchor);
    const to = this.#orderSnapshot.indexOf(id);
    if (from === -1 || to === -1) return [id];

    const [start, end] = from <= to ? [from, to] : [to, from];
    return this.#orderSnapshot.slice(start, end + 1);
  }

  /**
   * Apply a resolved intent.
   *
   * @param intent What the input model resolved to.
   * @param additive Whether a modifier key extends the current selection
   * rather than replacing it.
   */
  apply(intent: SelectionIntent, additive = false): void {
    switch (intent.kind) {
      case 'select': {
        this.#set(new Set([intent.id]), intent.id);
        return;
      }
      case 'toggle': {
        const next = new Set(this.#selectedIds);
        if (next.has(intent.id)) {
          next.delete(intent.id);
        } else {
          next.add(intent.id);
        }
        this.#set(next, intent.id);
        return;
      }
      case 'range': {
        const range = this.rangeTo(intent.id);
        const next = additive ? new Set([...this.#selectedIds, ...range]) : new Set(range);
        this.#set(next, intent.id);
        return;
      }
      case 'long-press': {
        this.#multiSelectMode = true;
        this.#toggleOne(intent.id);
      }
    }
  }

  /** Select exactly these ids. */
  selectAll(ids: readonly string[]): void {
    this.#set(new Set(ids), ids[ids.length - 1] ?? null);
  }

  /** Add ids to the selection without clearing it. */
  addAll(ids: readonly string[]): void {
    this.#set(new Set([...this.#selectedIds, ...ids]), ids[ids.length - 1] ?? this.#anchorId);
  }

  /** Drop ids from the selection. */
  removeAll(ids: readonly string[]): void {
    const next = new Set(this.#selectedIds);
    for (const id of ids) next.delete(id);
    this.#set(next, this.#anchorId);
  }

  /** Clear the selection and leave multi-select mode. */
  clear(): void {
    this.#cancelAllPresses();
    this.#selectedIds = new Set();
    this.#anchorId = null;
    this.#multiSelectMode = false;
    this.#active = false;
  }

  /**
   * Drop ids that no longer exist, after a listing change or a mutation.
   *
   * Called after every operation that can remove items, so a batch action never
   * leaves a selection pointing at a deleted document.
   */
  retain(availableIds: readonly string[]): void {
    if (this.#selectedIds.size === 0) return;

    const available = new Set(availableIds);
    const next = new Set<string>();
    for (const id of this.#selectedIds) {
      if (available.has(id)) next.add(id);
    }

    if (next.size === this.#selectedIds.size) return;
    this.#set(next, this.#anchorId !== null && available.has(this.#anchorId) ? this.#anchorId : null);
    if (next.size === 0) this.#multiSelectMode = false;
  }

  /**
   * Begin watching a press on an item.
   *
   * @param pointerId Identifies the finger or cursor, so a second touch on a
   * different item does not inherit the first one's timer.
   */
  pressStart(pointerId: string, id: string, x: number, y: number, onLongPress: (id: string) => void): void {
    this.pressCancel(pointerId);

    const press: PressState = {
      id,
      x,
      y,
      timer: setTimeout(() => {
        this.#presses.delete(pointerId);
        onLongPress(id);
      }, LONG_PRESS_MS)
    };
    this.#presses.set(pointerId, press);
  }

  /**
   * Update a live press.
   *
   * @returns `true` when the press survived, `false` when it was cancelled
   * because the pointer travelled too far.
   */
  pressMove(pointerId: string, x: number, y: number): boolean {
    const press = this.#presses.get(pointerId);
    if (press === undefined) return false;

    const dx = x - press.x;
    const dy = y - press.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX) {
      this.pressCancel(pointerId);
      return false;
    }
    return true;
  }

  /** End a press that completed before the long-press threshold. */
  pressEnd(pointerId: string): void {
    this.pressCancel(pointerId);
  }

  /**
   * Abandon a press.
   *
   * Called when the list scrolls during a press: the user is moving the content,
   * not holding an item, so a long press must not fire on the row the finger
   * happens to stop over.
   */
  pressCancel(pointerId: string): void {
    const press = this.#presses.get(pointerId);
    if (press === undefined) return;
    clearTimeout(press.timer);
    this.#presses.delete(pointerId);
  }

  /** Abandon every live press, for a blur or teardown. */
  #cancelAllPresses(): void {
    for (const press of this.#presses.values()) clearTimeout(press.timer);
    this.#presses.clear();
  }

  /** Commit a new selection and the derived active flag. */
  #set(ids: Set<string>, anchor: string | null): void {
    this.#selectedIds = ids;
    this.#anchorId = anchor;
    this.#active = ids.size > 0;
    if (ids.size === 0) this.#multiSelectMode = false;
  }

  /** Add or remove one id, keeping the anchor on it. */
  #toggleOne(id: string): void {
    const next = new Set(this.#selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.#set(next, id);
  }

  /** A serialisable snapshot, for callers that must not hold the reactive set. */
  toState(): SelectionState {
    return {
      selectedIds: new Set(this.#selectedIds),
      lastSelectedId: this.#anchorId
    };
  }
}

/** The single selection store. */
export const selectionStore = new SelectionStore();

/** Re-exported so components can type a local snapshot without a second import. */
export type { SelectionState };
