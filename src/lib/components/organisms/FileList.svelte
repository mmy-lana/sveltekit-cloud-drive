<script lang="ts">
  /**
   * List view.
   *
   * A table over `FileRow`. The header is a real `<div role="row">` inside a
   * `role="grid"`, and the rows carry `aria-colindex`, because a file list is
   * genuinely tabular — the size and date columns only mean anything as columns.
   *
   * The column widths are declared here and nowhere else. They use a single
   * grid template so the header and the rows cannot drift apart, which is the
   * usual way a hand-built list ends up with a misaligned header.
   */
  import FileRow from '$lib/components/organisms/FileRow.svelte';
  import type { DriveItem } from '$lib/types/drive';

  interface Props {
    items: readonly DriveItem[];
    selectedIds: ReadonlySet<string>;
    /** True once multi-select is engaged, which hides secondary affordances. */
    selectionMode: boolean;
    /** Owner label for the owner column; omit to drop the column entirely. */
    ownerLabel?: string;
    onOpen: (item: DriveItem) => void;
    onToggleSelect: (item: DriveItem, mode: 'toggle' | 'range') => void;
    onContextMenu: (
      item: DriveItem,
      anchor: { x: number; y: number } | { element: HTMLElement }
    ) => void;
  }

  let { items, selectedIds, selectionMode, ownerLabel, onOpen, onToggleSelect, onContextMenu }: Props =
    $props();

  /**
   * One template for every row, header included.
   *
   * The owner column only exists when a label is supplied, so the template is
   * computed rather than hard-coded: a three-column and a four-column list
   * cannot share a fixed template without leaving a dead column behind.
   */
  const template = $derived(
    ownerLabel === undefined
      ? 'minmax(0,1fr) 7rem 10rem 3rem'
      : 'minmax(0,1fr) 8rem 7rem 10rem 3rem'
  );
</script>

<div role="grid" aria-label="Files and folders" aria-multiselectable="true" class="w-full">
  <div
    role="row"
    class="grid items-center gap-2 border-b border-line px-3 py-2 text-xs font-medium
           uppercase tracking-wide text-fg-muted"
    style:grid-template-columns={template}
  >
    <span role="columnheader" aria-colindex={1}>Name</span>
    {#if ownerLabel !== undefined}
      <span role="columnheader" aria-colindex={2} class="hidden sm:block">Owner</span>
    {/if}
    <span role="columnheader" aria-colindex={ownerLabel === undefined ? 2 : 3}>Modified</span>
    <span role="columnheader" aria-colindex={ownerLabel === undefined ? 3 : 4}>Size</span>
    <span role="columnheader" aria-colindex={ownerLabel === undefined ? 4 : 5} class="sr-only">
      Actions
    </span>
  </div>

  {#each items as item (item.id)}
    <div role="row" style:grid-template-columns={template} class="contents">
      <FileRow
        {item}
        selected={selectedIds.has(item.id)}
        {selectionMode}
        {ownerLabel}
        {onOpen}
        {onToggleSelect}
        {onContextMenu}
      />
    </div>
  {/each}
</div>
