<script lang="ts">
  /**
   * Grid view.
   *
   * A thin layout shell over `FileCard`, which already owns the interaction
   * contract. The wrapper's only real decisions are the column count and the
   * scroll-anchor behaviour.
   *
   * The column count is a clamp rather than a media query per breakpoint, so a
   * container that is not the full window — a half-width panel, a split view —
   * still produces an even grid instead of a ragged last row.
   */
  import FileCard from '$lib/components/organisms/FileCard.svelte';
  import type { DriveItem } from '$lib/types/drive';

  interface Props {
    items: readonly DriveItem[];
    /** Currently selected ids, for the tiles' selected state. */
    selectedIds: ReadonlySet<string>;
    /** True once multi-select is engaged, which hides secondary affordances. */
    selectionMode: boolean;
    onOpen: (item: DriveItem) => void;
    onToggleSelect: (item: DriveItem, mode: 'toggle' | 'range') => void;
    onContextMenu: (
      item: DriveItem,
      anchor: { x: number; y: number } | { element: HTMLElement }
    ) => void;
  }

  let { items, selectedIds, selectionMode, onOpen, onToggleSelect, onContextMenu }: Props = $props();
</script>

<!--
  A listbox rather than a grid of buttons: the container owns selection and
  arrow-key navigation, and the cards are its options. That buys a single
  announcement for the whole selection instead of one per tile.
-->
<div
  role="listbox"
  aria-multiselectable="true"
  aria-label="Files and folders"
  class="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 p-1
         sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]"
>
  {#each items as item (item.id)}
    <FileCard
      {item}
      selected={selectedIds.has(item.id)}
      {selectionMode}
      {onOpen}
      {onToggleSelect}
      {onContextMenu}
    />
  {/each}
</div>
