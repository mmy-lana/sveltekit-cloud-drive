/**
 * Viewport tier.
 *
 * The responsive matrix in the plan assigns a different *navigation shape* to
 * each breakpoint — bottom bar, icon rail, labelled sidebar — so the layout
 * cannot be left to media queries alone: `SidebarNavigation` needs a `density`
 * prop, and the icon-only rail has to replace the sidebar rather than merely
 * narrow it.
 *
 * That makes this store a genuine source of truth rather than a convenience.
 * It starts at the desktop width so the server and the first client render
 * agree, and `attach()` corrects it on the client before paint. Starting at
 * desktop rather than mobile is deliberate: a user on a phone should get one
 * reflow of a shell that is already fully labelled, not a flash of a desktop
 * layout that then collapses, and desktop is the tier whose markup carries the
 * most information — collapsing it to the rail is the smaller error.
 */
import { browser } from '$app/environment';
import { DEFAULT_VIEWPORT_WIDTH, VIEWPORT_TIER_MIN_WIDTH } from '$lib/config/constants';

/** The three navigation tiers of the plan's responsive matrix. */
export type ViewportTier = 'mobile' | 'tablet' | 'desktop';

/** How `SidebarNavigation` should render for a given tier. */
export type NavigationDensity = 'bottom' | 'rail' | 'full';

function tierFor(width: number): ViewportTier {
  if (width >= VIEWPORT_TIER_MIN_WIDTH.desktop) return 'desktop';
  if (width >= VIEWPORT_TIER_MIN_WIDTH.tablet) return 'tablet';
  return 'mobile';
}

class ViewportStore {
  #width = $state<number>(DEFAULT_VIEWPORT_WIDTH);
  #attached = false;

  /** Last measured viewport width, in CSS pixels. */
  get width(): number {
    return this.#width;
  }

  /** The tier that width falls into. */
  get tier(): ViewportTier {
    return tierFor(this.#width);
  }

  /** Navigation shape for the current tier. */
  get density(): NavigationDensity {
    switch (this.tier) {
      case 'mobile':
        return 'bottom';
      case 'tablet':
        return 'rail';
      case 'desktop':
        return 'full';
    }
  }

  /** True below the tablet boundary, where the bottom bar and FAB apply. */
  get isMobile(): boolean {
    return this.tier === 'mobile';
  }

  /** True where a right-click is a usable secondary input. */
  get hasPointerPrecision(): boolean {
    return this.tier !== 'mobile';
  }

  /**
   * Begin tracking the viewport. Idempotent, and a no-op on the server, so the
   * layout can call it from an effect without guarding.
   */
  attach(): void {
    if (!browser || this.#attached) return;
    this.#attached = true;

    this.#measure();
    window.addEventListener('resize', this.#measure, { passive: true });
    // The address bar collapsing changes the visual viewport on mobile without
    // necessarily resizing the window, which is exactly the case where a phone
    // most needs the bottom bar to stay put.
    window.visualViewport?.addEventListener('resize', this.#measure, { passive: true });
  }

  /** Stop tracking. Called when the layout unmounts. */
  detach(): void {
    if (!browser || !this.#attached) return;
    this.#attached = false;
    window.removeEventListener('resize', this.#measure);
    window.visualViewport?.removeEventListener('resize', this.#measure);
  }

  /**
   * Re-measure and adopt the result only when the tier actually changed.
   *
   * Ignoring width changes within a tier matters: the drive is a three-column
   * list on a tablet, and re-rendering the shell on every pixel of a rotation
   * or a drag-resize would thrash scroll position for no visual gain.
   */
  #measure = (): void => {
    const next: number = Math.round(window.innerWidth);
    if (tierFor(next) === this.tier && next === this.#width) return;
    if (tierFor(next) === tierFor(this.#width)) return;
    this.#width = next;
  };
}

export const viewportStore = new ViewportStore();
