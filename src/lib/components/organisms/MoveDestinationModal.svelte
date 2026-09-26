<script lang="ts">
  /**
   * Move-destination picker.
   *
   * A dialog rather than a dropdown because the tree is the whole job and a
   * dropdown gives it no room. The tree comes from
   * `driveStore.loadFolderTree()`, which fetches every non-trashed folder in
   * the account, so a destination is reachable from anywhere rather than only
   * from a chain the user has already visited.
   *
   * Two destinations are refused, and both are shown disabled with a reason
   * rather than hidden — a user who cannot see why a folder is unavailable will
   * assume the picker is broken. The moved items themselves are excluded, and so
   * is every descendant of a moved folder, because a move into a descendant
   * would create a parent cycle no traversal could later escape.
   */
  import { ChevronRight, Folder, FolderOpen, LoaderCircle, Search, TriangleAlert } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import { formatCount } from '$lib/utils/formatters';
  import type { DriveStore } from '$lib/stores/driveStore.svelte';

  interface Props {
    /** Two-way bound visibility. */
    open: boolean;
    /** How many items are being moved, for the heading. */
    count: number;
    /** The item store, which owns the folder index. */
    store: DriveStore;
    /** The moved items themselves, never valid targets. */
    movedIds: ReadonlySet<string>;
    /** Folder ids that are descendants of a moved folder. */
    descendantIds: ReadonlySet<string>;
    /** True while the caller's transaction is running. */
    busy: boolean;
    /** Server-side failure to surface. */
    error: string | null;
    onclose: () => void;
    /** Resolves with the destination folder id, or `null` for the drive root. */
    onsubmit: (destinationId: string | null) => void;
  }

  let { open = $bindable(), count, store, movedIds, descendantIds, busy, error, onclose, onsubmit }: Props =
    $props();

  let query = $state('');
  let expandedIds = $state<Set<string>>(new Set());
  let selectedId = $state<string | null>(null);
  let loadError = $state<string | null>(null);

  $effect(() => {
    if (!open) return;
    query = '';
    selectedId = null;
    loadError = null;
    expandedIds = new Set();

    void store.loadFolderTree().then(() => {
      if (!open) return;
      loadError = store.error === null ? null : store.error.message;

      // The folder the user is currently in is the likeliest destination, so it
      // starts selected — and its parent is the row that reveals it.
      const current = store.scope.kind === 'folder' ? store.scope.folderId : null;
      if (current === null || isForbidden(current)) return;

      selectedId = current;
      const parent = store.folderFromIndex(current)?.parentFolderId ?? null;
      if (parent !== null) expandedIds = new Set([parent]);
    });
  });

  /** A folder that must not be a destination, with the reason it is excluded. */
  function isForbidden(id: string): boolean {
    return movedIds.has(id) || descendantIds.has(id);
  }

  /** `true` when the folder has at least one visible child in the index. */
  function hasChildren(id: string): boolean {
    return store.folderChildren(id).length > 0;
  }

  /**
   * The rows to render, flattened with a depth.
   *
   * A flat list beats a recursive component here for two reasons: the search
   * filter can re-order and re-depth the result in one pass, and expanding a
   * node is a `Set` mutation rather than a component mount.
   */
  const rows = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const output: { id: string | null; label: string; depth: number; disabled: boolean; expandable: boolean }[] = [];

    if (needle.length > 0) {
      // While filtering, every folder in the index is reachable regardless of
      // expansion: the filter is the user asking to see one specific folder,
      // and hiding it behind a collapsed ancestor would defeat the search.
      return store.indexedFolders
        .filter((folder) => folder.name.toLowerCase().includes(needle))
        .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName))
        .map((folder) => ({
          id: folder.id as string | null,
          label: folder.name,
          depth: 0,
          disabled: isForbidden(folder.id),
          expandable: false
        }));
    }

    const walk = (parentId: string | null, depth: number): void => {
      for (const folder of store.folderChildren(parentId)) {
        const expandable = hasChildren(folder.id);
        output.push({
          id: folder.id,
          label: folder.name,
          depth,
          disabled: isForbidden(folder.id),
          expandable
        });
        if (expandable && expandedIds.has(folder.id)) walk(folder.id, depth + 1);
      }
    };

    walk(null, 0);
    return output;
  });

  const selectedLabel = $derived(
    selectedId === null ? 'My Drive' : (store.folderFromIndex(selectedId)?.name ?? 'Unknown folder')
  );

  function toggle(id: string): void {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedIds = next;
  }
</script>

<Modal
  bind:open
  title="Move {formatCount(count)} {count === 1 ? 'item' : 'items'}"
  description={`Destination: ${selectedLabel}`}
  size="md"
  dismissible={!busy}
  onclose={onclose}
>
  <div class="flex flex-col gap-3">
    <Input
      bind:value={query}
      prefix={Search}
      label="Filter folders"
      name="folder-filter"
      autocomplete="off"
      spellcheck="false"
      placeholder="Type to filter…"
      clearable
      clearLabel="Clear folder filter"
      disabled={busy}
    />

    <div
      class="max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-gray-200 p-1 dark:border-gray-800"
      role="tree"
      aria-label="Destination folders"
      aria-busy={store.isLoadingFolderTree}
    >
      <button
        type="button"
        role="treeitem"
        aria-selected={selectedId === null}
        class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm
               text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800
               aria-selected:bg-blue-50 aria-selected:font-medium aria-selected:text-blue-900
               dark:aria-selected:bg-blue-950 dark:aria-selected:text-blue-100"
        onclick={() => {
          selectedId = null;
        }}
      >
        <span class="w-6 shrink-0" aria-hidden="true"></span>
        {#if selectedId === null}
          <FolderOpen size={18} class="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
        {:else}
          <Folder size={18} class="shrink-0 text-gray-400" aria-hidden="true" />
        {/if}
        <span class="truncate">My Drive</span>
      </button>

      {#each rows as row (row.id)}
        <div role="none" style:padding-left={`${row.depth * 16}px`}>
          <div class="flex items-center">
            {#if row.expandable}
              <button
                type="button"
                class="flex h-11 w-6 shrink-0 items-center justify-center rounded text-gray-500
                       hover:bg-gray-200 dark:hover:bg-gray-700"
                aria-label={`${expandedIds.has(row.id ?? '') ? 'Collapse' : 'Expand'} ${row.label}`}
                aria-expanded={expandedIds.has(row.id ?? '')}
                onclick={() => {
                  if (row.id !== null) toggle(row.id);
                }}
              >
                <ChevronRight
                  size={16}
                  class={expandedIds.has(row.id ?? '') ? 'rotate-90 transition-transform' : 'transition-transform'}
                />
              </button>
            {:else}
              <span class="w-6 shrink-0" aria-hidden="true"></span>
            {/if}

            <button
              type="button"
              role="treeitem"
              aria-selected={row.id === selectedId}
              aria-disabled={row.disabled}
              disabled={row.disabled}
              class="flex min-h-11 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm
                     text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed
                     disabled:opacity-50 disabled:hover:bg-transparent dark:text-gray-300 dark:hover:bg-gray-800
                     aria-selected:bg-blue-50 aria-selected:font-medium aria-selected:text-blue-900
                     dark:aria-selected:bg-blue-950 dark:aria-selected:text-blue-100"
              onclick={() => {
                selectedId = row.id;
              }}
            >
              {#if row.id === selectedId}
                <FolderOpen size={18} class="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              {:else}
                <Folder size={18} class="shrink-0 text-gray-400" aria-hidden="true" />
              {/if}
              <span class="truncate">{row.label}</span>
              {#if row.disabled}
                <span class="ml-auto shrink-0 text-xs text-gray-400">
                  {movedIds.has(row.id ?? '') ? 'Selected' : 'Contains items being moved'}
                </span>
              {/if}
            </button>
          </div>
        </div>
      {/each}

      {#if store.isLoadingFolderTree}
        <p class="flex items-center justify-center gap-2 px-3 py-6 text-sm text-gray-500">
          <LoaderCircle size={16} class="animate-spin" aria-hidden="true" />
          Loading folders…
        </p>
      {:else if rows.length === 0}
        <p class="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {query.trim().length > 0 ? `No folder matches “${query}”.` : 'No folders yet.'}
        </p>
      {/if}
    </div>

    {#if error !== null || loadError !== null}
      <p
        class="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700
               dark:bg-red-950 dark:text-red-300"
        role="alert"
      >
        <TriangleAlert size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
        {error ?? loadError}
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" disabled={busy} onclick={onclose}>Cancel</Button>
    <Button
      variant="primary"
      loading={busy}
      loadingLabel="Moving…"
      disabled={selectedId !== null && isForbidden(selectedId)}
      onclick={() => onsubmit(selectedId)}
    >
      Move here
    </Button>
  {/snippet}
</Modal>
