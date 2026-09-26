<script module lang="ts">
  import type { LucideIcon } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  /** A single actionable row. */
  export interface DropdownMenuItem {
    id: string;
    label: string;
    /** Leading glyph, decorative. */
    icon?: LucideIcon;
    /** Right-aligned hint, e.g. a keyboard shortcut. */
    shortcut?: string;
    disabled?: boolean;
    /** Renders in the danger palette and announces as a destructive action. */
    destructive?: boolean;
    /** Presence switches the row to `menuitemcheckbox` and reflects the state. */
    checked?: boolean;
    /** Secondary line explaining a disabled or risky action. */
    description?: string;
    onSelect?: () => void;
  }

  /** A non-actionable divider. */
  export interface DropdownMenuSeparator {
    id: string;
    separator: true;
  }

  export type DropdownMenuEntry = DropdownMenuItem | DropdownMenuSeparator;

  /** Where the panel is positioned relative to the viewport. */
  export type DropdownMenuAnchor =
    | { type: 'point'; x: number; y: number }
    | { type: 'element'; element: HTMLElement };

  export function isSeparator(entry: DropdownMenuEntry): entry is DropdownMenuSeparator {
    return 'separator' in entry && entry.separator === true;
  }
</script>

<script lang="ts">
  interface Props {
    /** Two-way bound visibility. Dismissing sets this to `false`. */
    open?: boolean;
    /** Anchor point or element the panel is positioned against. */
    anchor: DropdownMenuAnchor;
    /** Accessible name for the menu. */
    label: string;
    entries: readonly DropdownMenuEntry[];
    /** Preferred side. The panel flips automatically when it would overflow. */
    placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
    /** Minimum gap between the anchor and the panel, in pixels. */
    offset?: number;
    /** Invoked after the menu closes, for any dismissal reason. */
    onclose?: () => void;
    /** Optional pinned row at the bottom of the panel. */
    footer?: Snippet;
  }

  let {
    open = $bindable(false),
    anchor,
    label,
    entries,
    placement = 'bottom-start',
    offset = 6,
    onclose,
    footer
  }: Props = $props();

  const generatedId = $props.id();
  const menuId = `menu-${generatedId}`;

  let panelElement = $state<HTMLDivElement | null>(null);
  let position = $state<{ top: number; left: number; maxHeight: number } | null>(null);
  /** Index of the roving-focus item, or -1 when focus is on the panel itself. */
  let activeIndex = $state(-1);

  const actionableIndexes = $derived(
    entries.reduce<number[]>((acc, entry, index) => {
      if (!isSeparator(entry) && entry.disabled !== true) acc.push(index);
      return acc;
    }, [])
  );

  const GAP = 8;

  function clampToViewport(
    desiredLeft: number,
    desiredTop: number,
    panelWidth: number,
    panelHeight: number
  ): { left: number; top: number; maxHeight: number } {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    const maxLeft = Math.max(GAP, viewportWidth - panelWidth - GAP);
    const maxTop = Math.max(GAP, viewportHeight - panelHeight - GAP);

    const left = Math.min(Math.max(GAP, desiredLeft), maxLeft);
    const top = Math.min(Math.max(GAP, desiredTop), maxTop);

    // Vertical room above and below the anchor decides how tall the scrollable
    // panel may become, so a menu near the bottom of the screen still fits.
    const roomBelow = viewportHeight - desiredTop - offset - GAP;
    const roomAbove = desiredTop - offset - GAP;
    const maxHeight = Math.max(160, placement.startsWith('top') ? roomAbove : roomBelow);

    return { left, top, maxHeight };
  }

  function computePosition(): void {
    const panel = panelElement;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;

    if (anchor.type === 'point') {
      const desiredLeft =
        placement.endsWith('end') ? anchor.x - rect.width : anchor.x;
      const desiredTop =
        placement.startsWith('top') ? anchor.y - rect.height - offset : anchor.y + offset;
      position = clampToViewport(desiredLeft, desiredTop, rect.width, rect.height);
      return;
    }

    const anchorRect = anchor.element.getBoundingClientRect();
    const spaceRight = viewportWidth - anchorRect.right;
    const preferEnd = placement.endsWith('end');
    const flipToEnd = spaceRight < rect.width + GAP && !preferEnd;

    const desiredLeft = flipToEnd || preferEnd ? anchorRect.right - rect.width : anchorRect.left;
    const desiredTop =
      placement.startsWith('top') ? anchorRect.top - rect.height - offset : anchorRect.bottom + offset;

    position = clampToViewport(desiredLeft, desiredTop, rect.width, rect.height);
  }

  function close(reason: 'select' | 'dismiss' | 'escape' | 'outside'): void {
    if (!open) return;
    open = false;
    position = null;
    activeIndex = -1;
    if (reason === 'select' || reason === 'escape' || reason === 'outside') {
      onclose?.();
    }
  }

  function focusEntry(index: number): void {
    activeIndex = index;
    const panel = panelElement;
    if (!panel) return;
    const target = panel.querySelector<HTMLElement>(`[data-entry-index="${index}"]`);
    target?.focus();
  }

  function moveFocus(direction: 1 | -1): void {
    if (actionableIndexes.length === 0) return;
    const current = actionableIndexes.indexOf(activeIndex);
    const nextPosition =
      current === -1
        ? direction === 1
          ? 0
          : actionableIndexes.length - 1
        : (current + direction + actionableIndexes.length) % actionableIndexes.length;
    focusEntry(actionableIndexes[nextPosition]);
  }

  function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(-1);
        break;
      case 'Home': {
        event.preventDefault();
        const first = actionableIndexes[0];
        if (first !== undefined) focusEntry(first);
        break;
      }
      case 'End': {
        event.preventDefault();
        const last = actionableIndexes[actionableIndexes.length - 1];
        if (last !== undefined) focusEntry(last);
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close('escape');
        break;
      case 'Tab':
        // Tabbing out is a dismissal, so the menu never strands focus in it.
        close('dismiss');
        break;
      default:
        break;
    }
  }

  function handleSelect(entry: DropdownMenuItem): void {
    if (entry.disabled) return;
    entry.onSelect?.();
    close('select');
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (panelElement?.contains(target) ?? false) return;
    // Clicks on the trigger that opened this menu toggle it closed.
    if (anchor.type === 'element' && anchor.element.contains(target)) {
      close('dismiss');
      return;
    }
    close('outside');
  }

  function handleWindowBlur(): void {
    close('dismiss');
  }

  // Position once the panel has been measured, then keep it inside the viewport
  // on resize or scroll.
  $effect(() => {
    if (!open) {
      position = null;
      return;
    }

    computePosition();

    // Opening with focus already inside the menu is what makes the arrow keys
    // usable immediately; with nothing actionable, the panel itself takes focus
    // so Escape and Tab still work.
    const first = actionableIndexes[0];
    if (first === undefined) {
      activeIndex = -1;
      panelElement?.focus();
    } else {
      focusEntry(first);
    }

    window.addEventListener('resize', computePosition);
    window.addEventListener('scroll', computePosition, true);

    return () => {
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
  });
</script>

<svelte:window onpointerdown={handlePointerDown} onblur={handleWindowBlur} />

{#if open}
  <div
    bind:this={panelElement}
    id={menuId}
    role="menu"
    aria-label={label}
    tabindex="-1"
    onkeydown={handleKeydown}
    oncontextmenu={(event) => event.preventDefault()}
    style:top={position ? `${position.top}px` : '-9999px'}
    style:left={position ? `${position.left}px` : '-9999px'}
    style:max-height={position ? `${position.maxHeight}px` : undefined}
    class={[
      'fixed z-50 min-w-56 overflow-hidden rounded-xl border border-line bg-raised shadow-overlay',
      'animate-scale-in origin-top',
      position ? 'opacity-100' : 'opacity-0'
    ]
      .filter(Boolean)
      .join(' ')}
  >
    <div class="scrollbar-slim overflow-y-auto overscroll-contain py-1" style:max-height="inherit">
      {#each entries as entry, index (entry.id)}
        {#if isSeparator(entry)}
          <div role="separator" class="my-1 h-px bg-line"></div>
        {:else}
          {@const EntryIcon = entry.icon}
          <button
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            data-entry-index={index}
            tabindex={index === activeIndex ? 0 : -1}
            disabled={entry.disabled === true}
            aria-disabled={entry.disabled === true || undefined}
            aria-checked={entry.checked}
            onclick={() => handleSelect(entry)}
            onmouseenter={() => {
              if (entry.disabled !== true) activeIndex = index;
            }}
            class={[
              'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-45',
              entry.destructive === true
                ? 'text-danger hover:bg-danger-soft'
                : 'text-fg hover:bg-hover'
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span class="flex w-4 shrink-0 items-center justify-center">
              {#if entry.checked}
                <span
                  class="size-2 rounded-full bg-accent"
                  role="img"
                  aria-label="Enabled"
                ></span>
              {:else if EntryIcon}
                <EntryIcon size={16} aria-hidden="true" />
              {/if}
            </span>

            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">{entry.label}</span>
              {#if entry.description}
                <span class="truncate text-xs text-fg-subtle">{entry.description}</span>
              {/if}
            </span>

            {#if entry.shortcut}
              <kbd class="shrink-0 font-mono text-xs text-fg-subtle">{entry.shortcut}</kbd>
            {/if}
          </button>
        {/if}
      {/each}
    </div>

    {#if footer}
      <div class="flex items-center justify-end border-t border-line bg-sunken px-2 py-1.5">
        {@render footer()}
      </div>
    {/if}
  </div>
{/if}
