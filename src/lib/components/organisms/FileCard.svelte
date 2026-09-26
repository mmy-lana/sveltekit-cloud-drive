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

  let clickCount = 0;
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  function isTouchInput(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
  }

  /**
   * A single click on a pointer selects, matching every other file manager; a
   * double click opens. On touch there is no hover or double-click affordance,
   * so a single tap opens and selection stays on the checkbox.
   */
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
    const element = event.currentTarget as HTMLElement;
    onContextMenu(item, { element });
  }

  $effect(() => () => {
    if (clickTimer !== null) clearTimeout(clickTimer);
  });
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
  class={[
    'group relative flex cursor-pointer flex-col gap-2 rounded-card border bg-surface p-3 text-left',
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
