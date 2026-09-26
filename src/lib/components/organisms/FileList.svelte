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
   * The column tracks, shared by the header and every row.
   *
   * Declared once and handed to {@link FileRow}, because a header and a row
   * that each compute their own columns drift apart the first time either is
   * edited. They already had: the header used `8rem 7rem 10rem 3rem` and the row
   * used `9rem 10rem 5rem 7rem`, so the two were not the same layout at any width.
   *
   * Carries no base `grid-cols`, only the `md` one. Below 768px the header is a
   * one-column auto-placed grid and the row is not a grid at all — it is the
   * two-line card, with the name and its controls on the first line and the date
   * and size on the second. The header has to say the same thing, or it becomes
   * the widest thing on the page.
   *
   * It used not to. The header carried the full four- or five-track template at
   * every width while the rows collapsed, and hiding a cell does not remove its
   * track: `display: none` takes the element out of the grid, not the `10rem` the
   * template still reserves for it. So the header held `7rem + 10rem + 3rem` of
   * fixed columns plus a gap either side on a 360px screen, and the list scrolled
   * sideways. With an owner column it reserved `28rem` and overflowed by 136px.
   *
   * The breakpoint is `md` (768px) rather than `sm` (640px) so the owner column
   * is absent across the whole mobile range instead of appearing for the 128px
   * sliver between the two, where a `9rem` track leaves almost nothing for the
   * name it exists to protect.
   *
   * The two templates differ by exactly one track, and they have to. This grid
   * places the header in tracks 1..n; `FileRow` places its own cells in tracks
   * 1..n. If the track count and the cell count ever disagree, the extra cell
   * does not overflow — it wraps onto an implicit second row, and every column
   * after the gap sits one position out of step with its heading. So the owner
   * cell in `FileRow` is rendered conditionally for the same reason the track
   * is dropped here, and the two edits belong in the same commit.
   */

  /**
   * Whether the Owner column exists, decided once, here.
   *
   * A display name that is present but blank is the same as no display name:
   * the column would hold nothing, so it is normalised away rather than
   * rendered empty. This is also the only place that decision is made — the
   * track count, the header cells and the `ownerLabel` handed to `FileRow` all
   * read `owner`, so the row's cell count cannot disagree with the track count.
   * Deriving the fallback twice, once here and once in `FileRow`, is what
   * allowed the two halves to drift in the first place.
   */
  const owner = $derived(ownerLabel !== undefined && ownerLabel.trim() === '' ? undefined : ownerLabel);

  const template = $derived(
    owner === undefined
      ? 'md:grid-cols-[minmax(0,1fr)_10rem_5rem_7rem]'
      : 'md:grid-cols-[minmax(0,1fr)_9rem_10rem_5rem_7rem]'
  );
</script>

<div role="grid" aria-label="Files and folders" aria-multiselectable="true" class="w-full overflow-hidden">
  <div
    role="row"
    class="grid items-center gap-3 border-b border-line px-3 py-2 text-xs font-medium
           uppercase tracking-wide text-fg-muted {template}"
  >
    <span role="columnheader" aria-colindex={1} class="min-w-0 truncate">Name</span>
    {#if owner !== undefined}
      <span role="columnheader" aria-colindex={2} class="hidden md:block">Owner</span>
    {/if}
    <span role="columnheader" aria-colindex={owner === undefined ? 2 : 3} class="hidden md:block">
      Modified
    </span>
    <span role="columnheader" aria-colindex={owner === undefined ? 3 : 4} class="hidden md:block">
      Size
    </span>
    <span role="columnheader" aria-colindex={owner === undefined ? 4 : 5} class="sr-only">
      Actions
    </span>
  </div>

  <!--
    No wrapper element per item.

    `FileRow`'s root is already `role="row"` and already carries
    `aria-selected`, so an enclosing `role="row"` put a grid inside a grid: every
    file was announced twice, and assistive technology saw each row as containing
    a single row containing all the others. `class="contents"` was hiding the
    duplicate from the box tree, not from the accessibility tree, which is why
    it was never visible in a screenshot.
  -->
  {#each items as item (item.id)}
    <FileRow
      {item}
      selected={selectedIds.has(item.id)}
      {selectionMode}
      ownerLabel={owner}
      {template}
      {onOpen}
      {onToggleSelect}
      {onContextMenu}
    />
  {/each}
</div>
