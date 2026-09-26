/**
 * View-mode preference.
 *
 * The plan classifies view mode as a non-authoritative presentation state, so it
 * is persisted straight to `localStorage` rather than to Firestore: it never
 * needs to survive on another device, and keeping it local means the layout can
 * render in the stored mode on the very first paint without waiting on a query.
 */
import { browser } from '$app/environment';
import { isViewMode, type ViewMode } from '$lib/types/drive';

const STORAGE_KEY = 'drive.viewMode.v1';

function readStoredViewMode(): ViewMode | null {
  if (!browser) return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isViewMode(stored) ? stored : null;
  } catch {
    // Storage can be disabled or unavailable (private mode, embedded contexts).
    // The in-memory default remains correct, so failing to read is not fatal.
    return null;
  }
}

class ViewModeStore {
  #mode = $state<ViewMode>(readStoredViewMode() ?? 'grid');

  /** Current layout density. */
  get mode(): ViewMode {
    return this.#mode;
  }

  set mode(next: ViewMode) {
    this.#mode = next;
    if (!browser) return;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A failed write only costs the preference on the next visit.
    }
  }

  toggle(): void {
    this.mode = this.#mode === 'grid' ? 'list' : 'grid';
  }

  /**
   * Re-reads the stored value. Called once after hydration, when the server has
   * already rendered a default that the stored preference may contradict.
   */
  hydrate(): void {
    const stored = readStoredViewMode();
    if (stored !== null && stored !== this.#mode) {
      this.#mode = stored;
    }
  }
}

export const viewModeStore = new ViewModeStore();
