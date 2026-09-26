<script lang="ts">
  /**
   * List row.
   *
   * Two layouts share one DOM. From `sm` up it is a grid with tabular columns
   * (Name, Owner, Date modified, File size). Below `sm` — and therefore across
   * the 360/390/430px widths — it collapses to a two-line card, with the Owner
   * column removed entirely rather than hidden, so no horizontal scroll can
   * appear. Both layouts keep the same checkbox and context-button triggers, so
   * every touch target that works at 1280px also works at 360px.
   */
  import { EllipsisVertical, Star } from '@lucide/svelte';
  import FileIcon from '../molecules/FileIcon.svelte';
  import Checkbox from '../ui/Checkbox.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Badge from '../ui/Badge.svelte';
  import { formatBytes, formatModifiedDate, formatLongDate } from '$lib/utils/formatters';
  import type { DriveItem } from '$lib/types/drive';
  import { FOLDER_DRAG_MIME } from '$lib/config/constants';

  interface Props {
    item: DriveItem;
    selected: boolean;
    /** Owner label; hidden below `md` where the row becomes a two-line card. */
    ownerLabel?: string;
    /**
     * Grid template shared with the list header.
     *
     * The row used to carry its own `sm:grid-cols-[...]` while the header
     * carried a different one, so the columns never lined up. One source for
     * both is the only arrangement that cannot drift.
     */
    template?: string;
    onOpen: (item: DriveItem) => void;
    onToggleSelect: (item: DriveItem, mode: 'toggle' | 'range') => void;
    onContextMenu: (item: DriveItem, anchor: { x: number; y: number } | { element: HTMLElement }) => void;
    selectionMode?: boolean;
    class?: string;
  }

  let {
    item,
    selected,
    ownerLabel = 'Me',
    template = 'md:grid-cols-[minmax(0,1fr)_9rem_10rem_5rem_7rem]',
    onOpen,
    onToggleSelect,
    onContextMenu,
    selectionMode = false,
    class: className
  }: Props = $props();

  // Narrowed once, up front: the union is a discriminated `type`, so deriving
  // the concrete member is what makes `sizeBytes`/`mimeType` reachable at all.
  const file = $derived(item.type === 'file' ? item : null);
  const folder = $derived(item.type === 'folder' ? item : null);
  const sizeLabel = $derived(file === null ? '—' : formatBytes(file.sizeBytes, { decimals: 1 }));
  const modifiedLabel = $derived(formatModifiedDate(item.updatedAt));
  const modifiedFull = $derived(formatLongDate(item.updatedAt) ?? modifiedLabel);

  let clickCount = 0;
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  function isTouchInput(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
  }

  function handleClick(event: MouseEvent): void {
    if (selectionMode || isTouchInput()) {
      onOpen(item);
      return;
    }

    clickCount += 1;
    if (clickTimer !== null) clearTimeout(clickTimer);

    if (clickCount === 1) {
      clickTimer = setTimeout(() => {
        clickCount = 0;
        onToggleSelect(item, event.shiftKey ? 'range' : 'toggle');
      }, 180);
      return;
    }

    clickCount = 0;
    clickTimer = null;
    onOpen(item);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(item);
    }
  }

  function openContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(item, { element: event.currentTarget as HTMLElement });
  }

  $effect(() => () => {
    if (clickTimer !== null) clearTimeout(clickTimer);
  });

  /**
   * Only folders are draggable. A file has nothing meaningful to be dropped
   * *into* — moving one is what the context menu's "Move" is for — whereas
   * dragging a folder into a breadcrumb is the fastest way to reorganise.
   */
  const isDraggable = $derived(item.type === 'folder' && !selectionMode);

  function handleDragStart(event: DragEvent): void {
    if (!isDraggable || event.dataTransfer === null) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(FOLDER_DRAG_MIME, item.id);
    // Some browsers refuse to start a drag unless text/plain is also present.
    event.dataTransfer.setData('text/plain', item.name);
  }
</script>

<!--
  One DOM, two layouts. From `md` up the row is a five-column grid: name, owner,
  date modified, file size, status. Below `md` it is a two-line card and the
  last four cells are removed from the flow entirely, so the row can never
  produce horizontal overflow at 360px. The context button lives inside the
  name cell in both layouts, so there is exactly one trigger and its position is
  always the far right of the line it belongs to.

  The root is the `role="row"`; the grid in `FileList` must not wrap it in a
  second one. It is also a direct child of the `role="grid"`, which is what lets
  the row be its own grid track container without an intermediate element.
-->
<div
  role="row"
  aria-selected={selected}
  tabindex="0"
  onclick={handleClick}
  onkeydown={handleKeydown}
  oncontextmenu={(event) => {
    event.preventDefault();
    onContextMenu(item, { x: event.clientX, y: event.clientY });
  }}
  draggable={isDraggable}
  ondragstart={handleDragStart}
  class={[
    'group relative flex cursor-pointer scroll-mt-24 flex-col gap-1 rounded-lg border bg-surface p-3',
    'transition-colors duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'md:grid md:items-center md:gap-3 {template}',
    selected ? 'border-accent bg-accent-soft/40' : 'border-transparent hover:bg-hover',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')}
>
  <!-- Cell 1: line 1 on mobile, the name column on desktop. -->
  <div class="flex min-w-0 items-center gap-3">
    <Checkbox
      checked={selected}
      label="Select {item.name}"
      hideLabel
      onclick={(event) => {
        event.stopPropagation();
        onToggleSelect(item, event.shiftKey ? 'range' : 'toggle');
      }}
      onkeydown={(event) => {
        if (event.key === ' ') event.stopPropagation();
      }}
    />

    <span class="shrink-0">
      <FileIcon
        name={item.name}
        type={item.type}
        mimeType={file?.mimeType ?? null}
        color={folder?.color ?? null}
        size="sm"
      />
    </span>

    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="flex min-w-0 items-center gap-1.5">
        <span class="truncate text-sm font-medium text-fg" title={item.name}>{item.name}</span>
        {#if item.isStarred}
          <Star size={13} class="shrink-0 text-warning" fill="currentColor" aria-label="Starred" />
        {/if}
      </span>

      <!-- Line 2 on mobile only: the columns that are dropped below `md`. -->
      <span class="flex items-center gap-1.5 text-xs text-fg-muted md:hidden">
        <span>{modifiedLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{file === null ? 'Folder' : sizeLabel}</span>
      </span>
    </span>

    <IconButton
      label="Actions for {item.name}"
      size="sm"
      align="end"
      // The negative margin is what kept the 36px glyph from crowding the name,
      // but it also pulled the button half out of the row's padding. Below `md`
      // that margin is dropped so the whole 44px target stays inside the row and
      // inside the viewport, rather than straddling the edge.
      class="shrink-0 md:-mr-1.5"
      onclick={openContextMenu}
      icon={EllipsisVertical}
    />
  </div>

  <!-- Cells 2-4: desktop/tablet columns, absent from the mobile layout. -->
  <span class="hidden min-w-0 truncate text-sm text-fg-muted md:block" title={ownerLabel}>
    {ownerLabel}
  </span>
  <span class="hidden min-w-0 truncate text-sm text-fg-muted md:block" title={modifiedFull}>
    {modifiedLabel}
  </span>
  <span class="hidden min-w-0 truncate text-sm text-fg-muted tabular-nums md:block">{sizeLabel}</span>

  <!-- Cell 5: status only, so it never shifts the columns when it appears. -->
  <span class="hidden min-w-0 justify-end md:flex">
    {#if file?.uploadStatus === 'failed'}
      <Badge tone="danger" size="sm" dot>Failed</Badge>
    {:else if file !== null && file.uploadStatus !== 'committed'}
      <Badge tone="warning" size="sm" dot>Pending</Badge>
    {:else if item.isTrashed}
      <Badge tone="neutral" size="sm">Trashed</Badge>
    {/if}
  </span>
</div>
