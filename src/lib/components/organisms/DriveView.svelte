<script lang="ts">
  /**
   * The drive listing.
   *
   * One component serves all four scopes — a folder, the drive root, Starred
   * and Trash — because they differ in the *query* (which the store owns) and
   * in a handful of labels, never in the interaction contract. Every route in
   * the app is this component plus a scope, so a bug fixed here is fixed in
   * all four places and the scopes cannot drift apart.
   *
   * The component owns interaction and presentation only. Quota, upload status
   * and trash state are never written optimistically: every mutation here goes
   * through `driveStore`, and the list re-renders from the committed snapshot.
   */
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { CheckCheck, LoaderCircle, StarOff, Trash2, X } from '@lucide/svelte';
  import { authStore } from '$lib/stores/authStore.svelte';
  import { driveStore, type DriveScope, type MutationResult } from '$lib/stores/driveStore.svelte';
  import { selectionStore } from '$lib/stores/selectionStore.svelte';
  import { viewportStore } from '$lib/stores/viewport.svelte';
  import { viewModeStore } from '$lib/stores/viewMode.svelte';
  import { getStorageClient } from '$lib/firebase/client';
  import { isDriveFile, isDriveFolder, type DriveFile, type DriveItem } from '$lib/types/drive';
  import { formatItems } from '$lib/utils/formatters';
  import { classifyError } from '$lib/firebase/errors';
  import FileGrid from './FileGrid.svelte';
  import FileList from './FileList.svelte';
  import ItemContextMenu from './ItemContextMenu.svelte';
  import BatchActionBar from './BatchActionBar.svelte';
  import MoveDestinationModal from './MoveDestinationModal.svelte';
  import NamePromptModal from './NamePromptModal.svelte';
  import FilePreviewModal from './FilePreviewModal.svelte';
  import ConfirmDialog from '../molecules/ConfirmDialog.svelte';
  import EmptyState from '../molecules/EmptyState.svelte';
  import Button from '../ui/Button.svelte';
  import type { DropdownMenuAnchor } from '../ui/DropdownMenu.svelte';

  /** Where an item menu was requested, as the card and row report it. */
  type ContextAnchor = { x: number; y: number } | { element: HTMLElement };

  interface Props {
    /** The scope this listing shows. The store is told about it by the route. */
    scope: DriveScope;
    /** Opens the shared file picker. */
    onRequestUpload: () => void;
    /** Opens the shared new-folder dialog. */
    onCreateFolder: () => void;
  }

  let { scope, onRequestUpload, onCreateFolder }: Props = $props();

  const store = driveStore;
  const selection = selectionStore;

  /** The items as currently rendered, already filtered and sorted. */
  const items = $derived(store.visibleItems);
  const inTrash = $derived(scope.kind === 'trash');
  const isFolderScope = $derived(scope.kind === 'folder');

  /** Sibling names, so the rename and create dialogs can warn about collisions. */
  const siblingNames = $derived(items.map((item) => item.name.toLowerCase()));

  /** Stable identity for the scope, used to detect a change of listing. */
  const scopeKey: string = $derived(
    scope.kind === 'folder' ? `folder:${scope.folderId ?? 'root'}` : scope.kind
  );

  const selectedItems = $derived(
    [...selection.selectedIds]
      .map((id) => store.getItem(id))
      .filter((item): item is DriveItem => item !== null)
  );
  const selectedBytes = $derived(
    selectedItems.reduce((total, item) => total + (isDriveFile(item) ? item.sizeBytes : 0), 0)
  );
  const selectionHasFolders = $derived(selectedItems.some(isDriveFolder));
  const allSelected = $derived(items.length > 0 && selection.selectedIds.size === items.length);

  /** True once the first snapshot for this scope has landed. */
  const settled = $derived(store.hasLoaded);
  const isEmpty = $derived(settled && items.length === 0);
  const hasQuery = $derived(store.filters.searchQuery.trim().length > 0);

  // --- dialog state -------------------------------------------------------

  let menuItem = $state<DriveItem | null>(null);
  let menuOpen = $state(false);
  let menuAnchor = $state<DropdownMenuAnchor | null>(null);

  let previewFile = $state<DriveFile | null>(null);
  let previewOpen = $state(false);
  let renameTarget = $state<DriveItem | null>(null);
  let renameOpen = $state(false);
  let moveOpen = $state(false);

  /** Which destructive confirmation, if any, is on screen. */
  let pendingConfirm = $state<'none' | 'delete-forever' | 'empty-trash'>('none');

  /** True while a store mutation is in flight, for dialog button states. */
  let mutating = $state(false);
  /** Last failure to surface inside a dialog. */
  let actionError = $state<string | null>(null);
  /** Last failure to surface above the listing. */
  let listingError = $state<string | null>(null);
  /** Non-blocking notice, e.g. a download that could not be started. */
  let notice = $state<string | null>(null);

  // --- effects ------------------------------------------------------------

  /**
   * Keep the selection store's notion of "the visible order" in step with the
   * rendered list, and drop anything that has left it. Doing both here is what
   * makes a shift-range selection correct after a sort or a filter change: the
   * range is computed against this snapshot, not against whatever was on screen
   * when the anchor was set.
   */
  $effect(() => {
    const ids = items.map((item) => item.id);
    selection.setVisibleOrder(ids);
    selection.retain(ids);
  });

  /**
   * A scope change invalidates every selection, because item ids are
   * scope-local: an id selected in the bin means nothing in My Drive.
   *
   * The key is read reactively and the resets are untracked, so clearing the
   * selection cannot re-trigger the effect that cleared it.
   */
  $effect(() => {
    void scopeKey;
    untrack(() => {
      selection.clear();
      previewFile = null;
      previewOpen = false;
      renameTarget = null;
      renameOpen = false;
      moveOpen = false;
      menuOpen = false;
      menuItem = null;
      listingError = null;
      actionError = null;
      notice = null;
    });
  });

  /** Errors raised by the subscription itself render above the listing. */
  $effect(() => {
    listingError = store.error?.message ?? null;
  });

  /**
   * Announce a result to assistive technology without moving focus. Every
   * mutation ends in exactly one of these, so a screen-reader user learns the
   * outcome of a batch action without having to go looking for the change.
   */
  $effect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      notice = null;
    }, 6000);
    return () => clearTimeout(timer);
  });

  // --- listing interactions ----------------------------------------------

  function handleOpen(item: DriveItem): void {
    if (isDriveFolder(item)) {
      if (inTrash) {
        notice = 'Restore this folder before opening it.';
        return;
      }
      void goto(`/folder/${item.id}`);
      return;
    }
    previewFile = item;
    previewOpen = true;
  }

  function handleToggleSelect(item: DriveItem, mode: 'toggle' | 'range'): void {
    selection.apply({ kind: mode, id: item.id });
  }

  function handleContextMenu(item: DriveItem, anchor: ContextAnchor): void {
    menuItem = item;
    menuAnchor =
      'x' in anchor ? { type: 'point', x: anchor.x, y: anchor.y } : { type: 'element', element: anchor.element };
    menuOpen = true;
  }

  // --- mutations ----------------------------------------------------------

  /**
   * Run a store mutation and translate the outcome into the two things the
   * user needs to know: a reconciled selection, and a message.
   */
  async function run(label: string, action: () => Promise<MutationResult>): Promise<boolean> {
    mutating = true;
    actionError = null;
    try {
      const result = await action();
      if (!result.ok) {
        actionError = classifyError(result.error ?? new Error('The change could not be saved.')).message;
        return false;
      }
      if (result.affectedIds && result.affectedIds.length > 0) {
        notice = `${label} ${formatItems(result.affectedIds.length, 'item')}.`;
        selection.removeAll(result.affectedIds);
      }
      return true;
    } catch (error) {
      actionError = classifyError(error).message;
      return false;
    } finally {
      mutating = false;
    }
  }

  async function trashSelected(): Promise<void> {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    const succeeded = await run('Moved to trash', () => store.trashItems(ids));
    if (succeeded) selection.clear();
  }

  async function restoreSelected(): Promise<void> {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    const succeeded = await run('Restored', () => store.restoreItems(ids));
    if (succeeded) selection.clear();
  }

  async function starSelected(starred: boolean): Promise<void> {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    const succeeded = await run(starred ? 'Starred' : 'Removed from Starred', () =>
      store.setStarred(ids, starred)
    );
    if (succeeded) selection.clear();
  }

  async function confirmDeleteForever(): Promise<void> {
    const ids = [...selection.selectedIds];
    if (ids.length > 0) await run('Permanently deleted', () => store.permanentlyDelete(ids));
    pendingConfirm = 'none';
    selection.clear();
  }

  async function confirmEmptyTrash(): Promise<void> {
    const succeeded = await run('Emptied the bin', () => store.emptyTrash());
    pendingConfirm = 'none';
    if (succeeded) selection.clear();
  }

  async function submitRename(name: string): Promise<void> {
    const target = renameTarget;
    if (target === null) return;
    mutating = true;
    actionError = null;
    try {
      const { result } = await store.renameItem(target.id, name);
      if (!result.ok) {
        actionError = classifyError(result.error ?? new Error('Rename failed.')).message;
        return;
      }
      renameTarget = null;
      renameOpen = false;
    } finally {
      mutating = false;
    }
  }

  async function submitMove(destinationId: string | null): Promise<void> {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) {
      moveOpen = false;
      return;
    }
    const succeeded = await run('Moved', () => store.moveItems(ids, destinationId));
    if (succeeded) {
      moveOpen = false;
      selection.clear();
    }
  }

  /**
   * Folder ids that cannot be a move destination: the moved items themselves,
   * plus anything beneath a moved folder, since that would close a cycle.
   */
  const blockedDestinations = $derived.by((): { moved: Set<string>; descendants: Set<string> } => {
    const moved = new Set<string>();
    const descendants = new Set<string>();

    for (const item of selectedItems) {
      moved.add(item.id);
      if (isDriveFolder(item)) {
        for (const id of store.descendantFolderIds(item.id)) descendants.add(id);
      }
    }
    return { moved, descendants };
  });

  /**
   * Download a set of files.
   *
   * `getDownloadURL` is called per file and each object URL is revoked as soon
   * as the browser has taken it. A failure on one file does not abandon the
   * rest: the user is told which ones did not start rather than losing the
   * whole batch to the first error.
   */
  async function downloadItems(targets: readonly DriveItem[]): Promise<void> {
    const files = targets.filter(isDriveFile);
    if (files.length === 0) return;

    const failed: string[] = [];
    for (const file of files) {
      try {
        const { getDownloadURL, ref: storageRef } = await import('firebase/storage');
        const url = await getDownloadURL(storageRef(getStorageClient(), file.storagePath));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } catch (error) {
        failed.push(`${file.name} (${classifyError(error).message})`);
      }
    }

    if (failed.length > 0) {
      notice = `Could not download ${formatItems(failed.length, 'file')}: ${failed.join(', ')}`;
    }
  }

  const contextActions = $derived({
    open: handleOpen,
    preview: (item: DriveItem) => {
      if (!isDriveFile(item)) return;
      previewFile = item;
      previewOpen = true;
    },
    star: (item: DriveItem) => {
      void run(item.isStarred ? 'Removed from Starred' : 'Starred', () =>
        store.setStarred([item.id], !item.isStarred)
      );
    },
    rename: (item: DriveItem) => {
      actionError = null;
      renameTarget = item;
      renameOpen = true;
    },
    move: (item: DriveItem) => {
      selection.clear();
      selection.apply({ kind: 'select', id: item.id });
      actionError = null;
      moveOpen = true;
    },
    download: (item: DriveItem) => {
      void downloadItems([item]);
    },
    trash: (item: DriveItem) => {
      void run('Moved to trash', () => store.trashItems([item.id]));
    },
    restore: (item: DriveItem) => {
      void run('Restored', () => store.restoreItems([item.id]));
    },
    deleteForever: (item: DriveItem) => {
      selection.clear();
      selection.apply({ kind: 'select', id: item.id });
      actionError = null;
      pendingConfirm = 'delete-forever';
    }
  });

  // --- keyboard -----------------------------------------------------------

  function handleKeydown(event: KeyboardEvent): void {
    // Any dialog owns the keyboard while it is open.
    if (menuOpen || previewOpen || moveOpen || renameOpen || pendingConfirm !== 'none') return;

    if (event.key === 'Escape' && selection.isActive) {
      event.preventDefault();
      selection.clear();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && items.length > 0) {
      event.preventDefault();
      selection.addAll(items.map((item) => item.id));
    }
  }

  // --- empty-state copy ---------------------------------------------------

  const emptyCopy = $derived.by((): {
    title: string;
    description: string;
    artwork: 'folder' | 'search' | 'star' | 'trash';
    actionLabel: string | null;
    onAction: (() => void) | null;
    secondaryLabel: string | null;
    onSecondary: (() => void) | null;
  } => {
    if (hasQuery) {
      return {
        title: 'No matches',
        description: `Nothing in ${store.scopeTitle.toLowerCase()} matches “${store.filters.searchQuery.trim()}”.`,
        artwork: 'search',
        actionLabel: 'Clear search',
        onAction: () => store.setFilters({ searchQuery: '' }),
        secondaryLabel: null,
        onSecondary: null
      };
    }

    if (inTrash) {
      return {
        title: 'The bin is empty',
        description: 'Items you trash stay here until you delete them for good.',
        artwork: 'trash',
        actionLabel: null,
        onAction: null,
        secondaryLabel: null,
        onSecondary: null
      };
    }

    if (scope.kind === 'starred') {
      return {
        title: 'Nothing starred yet',
        description: 'Star the files and folders you reach for most to find them here.',
        artwork: 'star',
        actionLabel: 'Back to My Drive',
        onAction: () => void goto('/'),
        secondaryLabel: null,
        onSecondary: null
      };
    }

    return {
      title: 'This folder is empty',
      description: 'Upload files or drop them anywhere on this page, or create a folder to organise them.',
      artwork: 'folder',
      actionLabel: 'Upload files',
      onAction: onRequestUpload,
      secondaryLabel: 'New folder',
      onSecondary: onCreateFolder
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex flex-col gap-3 p-3 sm:p-4">
  <!--
    The listing is a document region and needs a name of its own: the title tag
    and the breadcrumb trail both live in the chrome above it, so without this
    a screen-reader user arriving at `main` finds a toolbar and a grid with no
    indication of where they are. Visually hidden — the breadcrumb already
    says it, and saying it twice on screen is just noise.
  -->
  <h1 class="sr-only">{store.scopeTitle}</h1>

  <!-- Listing toolbar: count, select-all, sort, and the bin's own action. -->
  <div class="flex flex-wrap items-center gap-2">
    <p class="text-sm text-fg-muted" role="status" aria-live="polite">
      {#if !settled}
        Loading…
      {:else}
        {formatItems(items.length, 'item')}
      {/if}
    </p>

    {#if settled && items.length > 0}
      <Button
        variant="ghost"
        size="sm"
        leading={allSelected ? X : CheckCheck}
        onclick={() => (allSelected ? selection.clear() : selection.selectAll(items.map((item) => item.id)))}
      >
        {allSelected ? 'Clear selection' : 'Select all'}
      </Button>
    {/if}

    <div class="ml-auto flex items-center gap-2">
      {#if settled && items.length > 1}
        <label class="flex items-center gap-1.5 text-sm text-fg-muted">
          <span class="sr-only sm:not-sr-only">Sort by</span>
          <select
            value={store.filters.sortBy}
            class="h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg
                   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onchange={(event) =>
              store.setFilters({ sortBy: event.currentTarget.value as typeof store.filters.sortBy })}
          >
            <option value="name">Name</option>
            <option value="updatedAt">Date modified</option>
            <option value="sizeBytes">File size</option>
          </select>
        </label>
        <Button
          variant="ghost"
          size="sm"
          onclick={() =>
            store.setFilters({ sortDirection: store.filters.sortDirection === 'asc' ? 'desc' : 'asc' })}
        >
          {store.filters.sortDirection === 'asc' ? 'Ascending' : 'Descending'}
        </Button>
      {/if}

      {#if inTrash && items.length > 0}
        <Button variant="danger" size="sm" leading={Trash2} onclick={() => (pendingConfirm = 'empty-trash')}>
          Empty bin
        </Button>
      {/if}
    </div>
  </div>

  <!-- Non-blocking feedback: batch outcomes and download failures. -->
  <p class="sr-only" role="status" aria-live="polite">{notice ?? ''}</p>
  {#if notice}
    <div
      class="flex items-start gap-2 rounded-card border border-line bg-sunken px-3 py-2 text-sm text-fg-muted"
    >
      <p class="min-w-0 flex-1">{notice}</p>
      <button
        type="button"
        class="-m-1 rounded p-1 text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        aria-label="Dismiss message"
        onclick={() => (notice = null)}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  {/if}

  <!-- Subscription failure. Distinct from "no items": the two look identical
       to a user, and only one of them is fixable by waiting. -->
  {#if listingError}
    <div
      class="flex flex-col items-start gap-2 rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      <p class="font-medium">This folder could not be loaded.</p>
      <p class="text-red-700">{listingError}</p>
      <Button variant="secondary" size="sm" onclick={() => store.sync()}>Try again</Button>
    </div>
  {/if}

  <div aria-busy={store.isLoading && !settled}>
    {#if !settled && store.isLoading}
      <div class="flex items-center justify-center gap-2 py-20 text-sm text-fg-muted" role="status">
        <LoaderCircle size={18} class="animate-spin" aria-hidden="true" />
        Loading your drive…
      </div>
    {:else if isEmpty && listingError === null}
      <EmptyState
        title={emptyCopy.title}
        description={emptyCopy.description}
        artwork={emptyCopy.artwork}
        actionLabel={emptyCopy.actionLabel}
        onAction={emptyCopy.onAction ?? undefined}
        secondaryLabel={emptyCopy.secondaryLabel}
        onSecondary={emptyCopy.onSecondary ?? undefined}
      />
    {:else if items.length > 0}
      {#if viewModeStore.mode === 'grid'}
        <FileGrid
          {items}
          selectedIds={selection.selectedIds}
          selectionMode={selection.isMultiSelectMode}
          onOpen={handleOpen}
          onToggleSelect={handleToggleSelect}
          onContextMenu={handleContextMenu}
        />
      {:else}
        <FileList
          {items}
          selectedIds={selection.selectedIds}
          selectionMode={selection.isMultiSelectMode}
          ownerLabel={authStore.profile?.displayName ?? undefined}
          onOpen={handleOpen}
          onToggleSelect={handleToggleSelect}
          onContextMenu={handleContextMenu}
        />
      {/if}
    {/if}
  </div>
</div>

<!-- Selection affordances. Positioned over the bottom bar's safe area. -->
<BatchActionBar
  count={selection.count}
  busy={mutating || store.isBusy}
  {inTrash}
  hasFolders={selectionHasFolders}
  totalBytes={selectedBytes}
  onSelectAll={() => selection.selectAll(items.map((item) => item.id))}
  onDownload={() => void downloadItems(selectedItems)}
  onStar={() => void starSelected(selectedItems.every((item) => !item.isStarred))}
  onTrash={() => void trashSelected()}
  onRestore={() => void restoreSelected()}
  onDeleteForever={() => (pendingConfirm = 'delete-forever')}
  onClear={() => selection.clear()}
/>

{#if menuItem !== null && menuAnchor !== null}
  <ItemContextMenu
    item={menuItem}
    {scope}
    bind:open={menuOpen}
    anchor={menuAnchor}
    actions={contextActions}
    onOpenChange={(next) => {
      menuOpen = next;
      if (!next) menuItem = null;
    }}
  />
{/if}

{#if renameTarget !== null}
  <NamePromptModal
    bind:open={renameOpen}
    mode="rename"
    title={`Rename “${renameTarget.name}”`}
    description="The new name must be unique within this folder."
    initialName={renameTarget.name}
    takenNames={siblingNames.filter((name) => name !== renameTarget?.name.toLowerCase())}
    busy={mutating}
    error={actionError}
    onclose={() => {
      renameTarget = null;
      renameOpen = false;
      actionError = null;
    }}
    onsubmit={(name) => void submitRename(name)}
  />
{/if}

<MoveDestinationModal
  bind:open={moveOpen}
  count={selection.count}
  store={driveStore}
  movedIds={blockedDestinations.moved}
  descendantIds={blockedDestinations.descendants}
  busy={mutating || store.isBusy}
  error={actionError}
  onclose={() => {
    moveOpen = false;
    actionError = null;
  }}
  onsubmit={(destinationId) => void submitMove(destinationId)}
/>

<FilePreviewModal
  bind:open={previewOpen}
  file={previewFile}
  onclose={() => {
    previewFile = null;
    previewOpen = false;
  }}
/>

<ConfirmDialog
  open={pendingConfirm !== 'none'}
  title={pendingConfirm === 'empty-trash' ? 'Empty the bin?' : 'Delete for good?'}
  description={pendingConfirm === 'empty-trash'
    ? 'Every item in the bin — and the storage behind each one — is destroyed. This cannot be undone.'
    : `${formatItems(selection.count, 'item')} will be removed from this device permanently. The storage behind ${selectionHasFolders ? 'them' : 'it'} is destroyed and the quota is released.`}
  confirmLabel={pendingConfirm === 'empty-trash' ? 'Empty bin' : 'Delete for good'}
  busy={mutating}
  onclose={() => {
    pendingConfirm = 'none';
    actionError = null;
  }}
  onconfirm={() => {
    if (pendingConfirm === 'empty-trash') void confirmEmptyTrash();
    else void confirmDeleteForever();
  }}
/>
