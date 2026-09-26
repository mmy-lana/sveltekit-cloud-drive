<script lang="ts">
  /**
   * Grid tile.
   *
   * Selection is a checkbox that is always reachable, never a long-press-only
   * gesture, because a long press is undiscoverable and ambiguous on touch.
   * Activation differs by input: a pointer opens on double click, a touch screen
   * opens on single tap, and the keyboard opens on Enter or Space.
   */
  import { EllipsisVertical, Star } from '@lucide/svelte';
  import FileIcon from '../molecules/FileIcon.svelte';
  import Checkbox from '../ui/Checkbox.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Badge from '../ui/Badge.svelte';
  import { formatBytes, formatModifiedDate } from '$lib/utils/formatters';
  import type { DriveItem } from '$lib/types/drive';
  import { FOLDER_DRAG_MIME } from '$lib/config/constants';

  interface Props {
    item: DriveItem;
    selected: boolean;
    /** True while a context menu is open for this tile, to hold its hover ring. */
    active?: boolean;
    onOpen: (item: DriveItem) => void;
    onToggleSelect: (item: DriveItem, mode: 'toggle' | 'range') => void;
    onContextMenu: (item: DriveItem, anchor: { x: number; y: number } | { element: HTMLElement }) => void;
    /** Suppresses secondary action affordances, e.g. while the user selects. */
    selectionMode?: boolean;
    class?: string;
  }

  let {
    item,
    selected,
    active = false,
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
  const sizeLabel = $derived(file === null ? 'Folder' : formatBytes(file.sizeBytes, { decimals: 1 }));
  const modifiedLabel = $derived(formatModifiedDate(item.updatedAt));

  function isTouchInput(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
  }

  /**
   * A single click on a pointer selects, matching every other file manager; a
   * double click opens. On touch there is no hover or double-click affordance,
   * so a single tap opens and selection stays on the checkbox.
   *
   * The distinction reads `event.detail`, the click count the browser maintains
   * for this element: 1 on the first click of a sequence, 2 on the second, and
   * back to 1 once the next click falls outside the double-click interval. It
   * replaced a `clickCount` counter plus a 180ms `setTimeout` that every
   * selection had to sit behind, so the row now reacts on the same frame as
   * the click while a second click still opens. `>= 2` rather than `=== 2`, so
   * the third click of a triple click opens once instead of falling through to
   * a second toggle.
   */
  function handleClick(event: MouseEvent): void {
    if (selectionMode || isTouchInput()) {
      onOpen(item);
      return;
    }

    if (event.detail >= 2) {
      onOpen(item);
      return;
    }

    onToggleSelect(item, event.shiftKey ? 'range' : 'toggle');
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
    const element = event.currentTarget as HTMLElement;
    onContextMenu(item, { element });
  }

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

<div
  role="option"
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
    // `scroll-mt-24`: the header is sticky, so an item the browser scrolls to
    // on focus would otherwise land underneath it.
    'group relative flex cursor-pointer scroll-mt-24 flex-col gap-2 rounded-card border bg-surface p-3 text-left',
    'transition-[border-color,background-color,box-shadow] duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    selected ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong',
    active ? 'border-accent' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')}
>
  <div class="flex items-start justify-between gap-2">
    <Checkbox
      checked={selected}
      label="Select {item.name}"
      hideLabel
      size="md"
      onclick={(event) => {
        event.stopPropagation();
        onToggleSelect(item, event.shiftKey ? 'range' : 'toggle');
      }}
      onkeydown={(event) => {
        if (event.key === ' ') event.stopPropagation();
      }}
    />

    <div class="flex items-center gap-0.5">
      {#if item.isStarred}
        <span class="text-warning" title="Starred">
          <Star size={16} fill="currentColor" aria-label="Starred" />
        </span>
      {/if}

      <IconButton
        label="Actions for {item.name}"
        size="sm"
        align="end"
        onclick={openContextMenu}
        icon={EllipsisVertical}
      />
    </div>
  </div>

  <div class="flex items-center justify-center py-2">
    <FileIcon
      name={item.name}
      type={item.type}
      mimeType={file?.mimeType ?? null}
      color={folder?.color ?? null}
      size="lg"
    />
  </div>

  <div class="flex min-w-0 flex-col gap-1">
    <span class="truncate text-sm font-medium text-fg" title={item.name}>{item.name}</span>
    <span class="truncate text-xs text-fg-muted">
      {sizeLabel} · {modifiedLabel}
    </span>

    <!-- Only rendered for states that the metadata line cannot already convey. -->
    {#if file?.uploadStatus === 'failed'}
      <Badge tone="danger" size="sm" dot>Upload failed</Badge>
    {:else if file !== null && file.uploadStatus !== 'committed'}
      <Badge tone="warning" size="sm" dot>Pending</Badge>
    {:else if item.isTrashed}
      <Badge tone="neutral" size="sm">In trash</Badge>
    {/if}
  </div>
</div>
