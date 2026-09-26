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

  interface Props {
    item: DriveItem;
    selected: boolean;
    /** Owner label; hidden below `sm` where the row becomes a two-line card. */
    ownerLabel?: string;
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
</script>

<!--
  One DOM, two layouts. From `sm` up the row is a five-column grid: name,
  owner, date modified, file size, status. Below `sm` it is a two-line card and
  the last four cells are removed from the flow entirely, so the row can never
  produce horizontal overflow at 360px. The context button lives inside the
  name cell in both layouts, so there is exactly one trigger and its position is
  always the far right of the line it belongs to.
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
  class={[
    'group relative flex cursor-pointer flex-col gap-1 rounded-lg border bg-surface p-3',
    'transition-colors duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'sm:grid sm:grid-cols-[minmax(0,1fr)_9rem_10rem_5rem_7rem] sm:items-center sm:gap-3',
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

      <!-- Line 2 on mobile only: the columns that are dropped below `sm`. -->
      <span class="flex items-center gap-1.5 text-xs text-fg-muted sm:hidden">
        <span>{modifiedLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{file === null ? 'Folder' : sizeLabel}</span>
      </span>
    </span>

    <IconButton
      label="Actions for {item.name}"
      size="sm"
      align="end"
      class="-mr-1.5 shrink-0"
      onclick={openContextMenu}
      icon={EllipsisVertical}
    />
  </div>

  <!-- Cells 2-4: desktop/tablet columns, absent from the mobile layout. -->
  <span class="hidden min-w-0 truncate text-sm text-fg-muted sm:block" title={ownerLabel}>
    {ownerLabel}
  </span>
  <span class="hidden min-w-0 truncate text-sm text-fg-muted sm:block" title={modifiedFull}>
    {modifiedLabel}
  </span>
  <span class="hidden min-w-0 truncate text-sm text-fg-muted tabular-nums sm:block">{sizeLabel}</span>

  <!-- Cell 5: status only, so it never shifts the columns when it appears. -->
  <span class="hidden min-w-0 justify-end sm:flex">
    {#if file?.uploadStatus === 'failed'}
      <Badge tone="danger" size="sm" dot>Failed</Badge>
    {:else if file !== null && file.uploadStatus !== 'committed'}
      <Badge tone="warning" size="sm" dot>Pending</Badge>
    {:else if item.isTrashed}
      <Badge tone="neutral" size="sm">Trashed</Badge>
    {/if}
  </span>
</div>
