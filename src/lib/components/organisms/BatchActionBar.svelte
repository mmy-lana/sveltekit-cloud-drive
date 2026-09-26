<script lang="ts">
  /**
   * Batch action bar.
   *
   * Replaces the selection count in place when items are selected, so the
   * toolbar never jumps: the bar occupies the same row the count sat in, and
   * the actions slide in. On mobile it is a fixed bar above the bottom nav so
   * the thumb reaches it without a scroll; from `sm` up it floats as a card.
   *
   * Nothing here mutates state. Each button hands the caller a *request*;
   * confirmation and selection reconciliation belong to the operation, not to
   * the button, so they live with the component that owns the `driveStore`
   * calls.
   */
  import { Download, RotateCcw, Star, Trash, X } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import { formatBytes, formatCount } from '$lib/utils/formatters';

  interface Props {
    /** How many items are selected. */
    count: number;
    /** True while a batch mutation is in flight; disables the actions. */
    busy: boolean;
    /** True when the active scope is the trash, which changes the verb set. */
    inTrash: boolean;
    /** True when the selection contains a folder, which blocks download. */
    hasFolders: boolean;
    /** Total bytes across the selected files, for the size readout. */
    totalBytes: number;
    onSelectAll: () => void;
    onDownload: () => void;
    onStar: () => void;
    onTrash: () => void;
    onRestore: () => void;
    onDeleteForever: () => void;
    onClear: () => void;
  }

  let {
    count,
    busy,
    inTrash,
    hasFolders,
    totalBytes,
    onSelectAll,
    onDownload,
    onStar,
    onTrash,
    onRestore,
    onDeleteForever,
    onClear
  }: Props = $props();

  interface Action {
    readonly id: string;
    readonly label: string;
    readonly icon: LucideIcon;
    readonly run: () => void;
    readonly variant: 'primary' | 'secondary' | 'danger';
    /** Rendered as a spinner instead of the label while the batch is running. */
    readonly primary: boolean;
    readonly disabled: boolean;
    readonly title: string | undefined;
  }

  /**
   * The trash offers restore and purge; every other scope offers the working
   * set. Building this as a list rather than a template with `{#if}`s keeps
   * the primary-action rule enforceable: exactly one entry is `primary`, and
   * it is the one the scope is built around.
   */
  const actions = $derived<Action[]>(
    inTrash
      ? [
          {
            id: 'restore',
            label: 'Restore',
            icon: RotateCcw,
            run: onRestore,
            variant: 'primary',
            primary: true,
            disabled: busy,
            title: undefined
          },
          {
            id: 'delete',
            label: 'Delete forever',
            icon: Trash,
            run: onDeleteForever,
            variant: 'danger',
            primary: false,
            disabled: busy,
            title: 'This cannot be undone'
          }
        ]
      : [
          {
            id: 'download',
            label: 'Download',
            icon: Download,
            run: onDownload,
            variant: 'secondary',
            primary: false,
            disabled: busy || hasFolders,
            title: hasFolders ? 'Folders cannot be downloaded' : undefined
          },
          {
            id: 'star',
            label: 'Star',
            icon: Star,
            run: onStar,
            variant: 'secondary',
            primary: false,
            disabled: busy,
            title: undefined
          },
          {
            id: 'trash',
            label: 'Trash',
            icon: Trash,
            run: onTrash,
            variant: 'primary',
            primary: true,
            disabled: busy,
            title: undefined
          }
        ]
  );

  /** Shown only when a non-empty selection spans actual bytes. */
  const sizeLabel = $derived(totalBytes > 0 ? formatBytes(totalBytes) : null);
</script>

<div
  class="fixed inset-x-0 bottom-16 z-40 border-t border-gray-200 bg-white/95 backdrop-blur-md dark:border-gray-800 dark:bg-gray-950/95 sm:inset-x-auto sm:bottom-4 sm:left-1/2 sm:w-auto sm:max-w-lg sm:-translate-x-1/2 sm:rounded-xl sm:border sm:px-2 sm:shadow-xl md:left-auto md:right-4 md:translate-x-0"
  role="toolbar"
  aria-label="Selection actions"
  aria-busy={busy}
>
  <div class="flex items-center gap-2 px-3 py-2 sm:px-2">
    <div class="min-w-0 shrink-0">
      <p class="text-sm font-medium text-gray-900 dark:text-gray-100">{formatCount(count)} selected</p>
      {#if sizeLabel !== null}
        <p class="text-xs text-gray-500 dark:text-gray-400">{sizeLabel}</p>
      {/if}
    </div>

    <div class="ml-auto flex items-center gap-1">
      {#each actions as action (action.id)}
        <Button
          size="md"
          variant={action.variant}
          leading={action.icon}
          loading={busy && action.primary}
          disabled={action.disabled}
          title={action.title}
          onclick={action.run}
        >
          {action.label}
        </Button>
      {/each}
    </div>

    <IconButton label="Clear selection" size="md" variant="ghost" icon={X} disabled={busy} onclick={onClear} />
  </div>

  <div class="hidden border-t border-gray-100 px-2 py-1 sm:block dark:border-gray-800">
    <Button size="md" variant="ghost" disabled={busy} onclick={onSelectAll}>Select all</Button>
  </div>
</div>
