<script lang="ts">
  import { LayoutGrid, List } from '@lucide/svelte';
  import type { ViewMode } from '$lib/types/drive';

  interface Props {
    /** Two-way bound view mode. */
    value?: ViewMode;
    /** Accessible name for the control group. */
    label?: string;
    size?: 'sm' | 'md';
    /** Disables the control while the listing is re-sorting. */
    disabled?: boolean;
  }

  let { value = $bindable('grid'), label = 'View mode', size = 'md', disabled = false }: Props = $props();

  const OPTIONS: readonly { id: ViewMode; label: string }[] = [
    { id: 'grid', label: 'Grid view' },
    { id: 'list', label: 'List view' }
  ];

  const TOGGLE_HEIGHT: Record<'sm' | 'md', string> = { sm: 'h-9', md: 'h-11' };
</script>

<!--
  A radio group rather than a toggle: both destinations are named, so the
  current state is announced instead of being implied by a pressed/unpressed
  pair. Arrow keys move between options, which is the standard group behaviour.
-->
<div
  role="radiogroup"
  aria-label={label}
  class={[
    'inline-flex items-center gap-0.5 rounded-lg border border-line-strong bg-surface p-1',
    TOGGLE_HEIGHT[size]
  ].join(' ')}
>
  {#each OPTIONS as option (option.id)}
    {@const OptionIcon = option.id === 'grid' ? LayoutGrid : List}
    <button
      type="button"
      role="radio"
      aria-checked={value === option.id}
      {disabled}
      onclick={() => (value = option.id)}
      class={[
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        value === option.id
          ? 'bg-accent text-accent-fg shadow-raised'
          : 'text-fg-muted hover:bg-hover hover:text-fg'
      ].join(' ')}
    >
      <OptionIcon size={size === 'sm' ? 16 : 18} aria-hidden="true" />
      <span class="hidden sm:inline">{option.label.replace(' view', '')}</span>
    </button>
  {/each}
</div>
