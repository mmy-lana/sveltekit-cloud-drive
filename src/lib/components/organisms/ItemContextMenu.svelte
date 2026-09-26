<script module lang="ts">
  import type { DriveItem } from '$lib/types/drive';
  import type { DriveScope } from '$lib/stores/driveStore.svelte';
  import type { DropdownMenuEntry } from '$lib/components/ui/DropdownMenu.svelte';

  /** Everything the menu can ask its owner to do. */
  export interface ItemContextActions {
    open: (item: DriveItem) => void;
    preview: (item: DriveItem) => void;
    star: (item: DriveItem) => void;
    rename: (item: DriveItem) => void;
    move: (item: DriveItem) => void;
    download: (item: DriveItem) => void;
    trash: (item: DriveItem) => void;
    restore: (item: DriveItem) => void;
    deleteForever: (item: DriveItem) => void;
  }

  /**
   * Build the entry list for an item in a given scope.
   *
   * The same verb means different things in different scopes, so the entries
   * are a function of both rather than a constant list with disabled rows:
   * "Restore" only exists in the trash, "Move" is meaningless there, and
   * "Download" does not apply to a folder because a folder is not a byte
   * stream.
   */
  export function buildItemEntries(
    item: DriveItem,
    scope: DriveScope,
    actions: ItemContextActions
  ): DropdownMenuEntry[] {
    const isFile = item.type === 'file';
    const inTrash = scope.kind === 'trash';

    if (inTrash) {
      return [
        { id: 'restore', label: 'Restore', icon: RotateCcw, onSelect: () => actions.restore(item) },
        { id: 'delete', label: 'Delete forever', icon: Trash, destructive: true, description: 'This cannot be undone', onSelect: () => actions.deleteForever(item) }
      ];
    }

    return [
      { id: 'open', label: 'Open', icon: FolderInput, onSelect: () => actions.open(item) },
      ...(isFile
        ? ([{ id: 'preview', label: 'Preview', icon: Eye, onSelect: () => actions.preview(item) }] as DropdownMenuEntry[])
        : []),
      {
        id: 'star',
        label: item.isStarred ? 'Remove from starred' : 'Add to starred',
        icon: item.isStarred ? StarOff : Star,
        onSelect: () => actions.star(item)
      },
      { id: 'sep-1', separator: true },
      { id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => actions.rename(item) },
      { id: 'move', label: 'Move to…', icon: SquareArrowOutUpRight, onSelect: () => actions.move(item) },
      {
        id: 'download',
        label: 'Download',
        icon: Download,
        disabled: !isFile,
        description: isFile ? undefined : 'Folders cannot be downloaded',
        onSelect: () => actions.download(item)
      },
      { id: 'sep-2', separator: true },
      { id: 'trash', label: 'Move to trash', icon: Trash, destructive: true, onSelect: () => actions.trash(item) }
    ];
  }
</script>

<script lang="ts">
  /**
   * Per-item action menu.
   *
   * Reachable two ways on every viewport: a permanent three-dot button on the
   * row or card, and a right-click on pointer devices. Neither is the only
   * route, so the menu is never hidden behind a hover-only affordance or
   * behind a gesture a touch device cannot make.
   */
  import {
    Download,
    Eye,
    FolderInput,
    Pencil,
    RotateCcw,
    SquareArrowOutUpRight,
    Star,
    StarOff,
    Trash
  } from '@lucide/svelte';
  import DropdownMenu, { type DropdownMenuAnchor } from '$lib/components/ui/DropdownMenu.svelte';

  interface Props {
    /** The item this menu acts on. */
    item: DriveItem;
    /** Active scope, which decides the available actions. */
    scope: DriveScope;
    /** Two-way bound visibility. */
    open: boolean;
    /** Where the panel is positioned against. */
    anchor: DropdownMenuAnchor;
    /** Owner callbacks, forwarded to the entry list. */
    actions: ItemContextActions;
    onOpenChange: (open: boolean) => void;
  }

  let { item, scope, open = $bindable(), anchor, actions, onOpenChange }: Props = $props();

  const entries = $derived(buildItemEntries(item, scope, actions));
</script>

<DropdownMenu bind:open {anchor} {entries} label={`Actions for ${item.name}`} onclose={() => onOpenChange(false)} />
