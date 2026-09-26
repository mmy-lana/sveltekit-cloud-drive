<script lang="ts">
  /**
   * Application bar.
   *
   * Holds the things that are always reachable regardless of where the user is:
   * the create menu, the search field, the view toggle and the upload trigger.
   * Scope-specific actions — rename, move, trash — deliberately do *not* live
   * here; they belong to the selection, and a global trash button next to a
   * per-row one is how users delete the wrong thing.
   *
   * Two rows on mobile. The bar wraps rather than compressing, because a search
   * field squeezed below 120px stops being usable and the alternative —
   * hiding it behind an icon — costs a tap on the action used most.
   */
  import { FolderPlus, Menu, Upload } from '@lucide/svelte';
  import Breadcrumbs from '$lib/components/molecules/Breadcrumbs.svelte';
  import DemoModeBadge from '$lib/components/molecules/DemoModeBadge.svelte';
  import SearchBar from '$lib/components/molecules/SearchBar.svelte';
  import ViewToggle from '$lib/components/molecules/ViewToggle.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import { formatCount } from '$lib/utils/formatters';
  import type { BreadcrumbNode, ViewMode } from '$lib/types/drive';
  import type { UploadQueueStore } from '$lib/stores/uploadQueueStore.svelte';

  interface Props {
    /** Root-first path for the breadcrumb trail. */
    breadcrumbs: readonly BreadcrumbNode[];
    /** Title for the document, and the accessible name of the trail. */
    scopeTitle: string;
    /** Two-way bound view mode. */
    viewMode: ViewMode;
    /** Two-way bound search query. */
    query: string;
    /** True while a search is running. */
    searching: boolean;
    /** Number of results for the current query. */
    resultCount: number;
    /** True while a create or move mutation is running. */
    busy: boolean;
    /** The upload queue, for the trigger's badge. */
    queue: UploadQueueStore;
    /** `true` on routes that cannot accept a move; hides drop targets. */
    canDropFolders: boolean;
    onBreadcrumbNavigate: (id: string | null) => void;
    onQueryChange: (query: string) => void;
    onCreateFolder: () => void;
    onUploadClick: () => void;
    /** Opens the file picker for the shared upload input. */
    onOpenSidebar: () => void;
    /** Receives a folder dropped onto the trail. */
    onDropFolder: (folderId: string) => void;
  }

  let {
    breadcrumbs,
    scopeTitle,
    viewMode = $bindable(),
    query = $bindable(),
    searching,
    resultCount,
    busy,
    queue,
    canDropFolders,
    onBreadcrumbNavigate,
    onQueryChange,
    onCreateFolder,
    onUploadClick,
    onOpenSidebar,
    onDropFolder
  }: Props = $props();

  /** True when a query is active, which is the only time a count is useful. */
  const showResultCount = $derived(query.trim().length > 0);

  /** Headline for the queue trigger: count while active, nothing when idle. */
  const queueBadge = $derived(queue.activeTasks.length);
</script>

<header
  class="sticky top-0 z-20 flex flex-col gap-2 border-b border-line bg-surface/95 px-3 py-2
         backdrop-blur-md sm:px-4"
>
  <div class="flex items-center gap-2">
    <IconButton
      label="Open navigation"
      variant="ghost"
      icon={Menu}
      class="lg:hidden"
      onclick={onOpenSidebar}
    />

    <div class="min-w-0 flex-1">
      <Breadcrumbs
        nodes={breadcrumbs}
        onNavigate={onBreadcrumbNavigate}
        onDropFolder={canDropFolders ? onDropFolder : undefined}
      />
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <!-- The status of the backend, next to the one control that changes it.
           Hidden on the narrowest screens, where the sidebar account band shows
           the same chip and there is no room for two. -->
      <div class="mr-1 hidden sm:block">
        <DemoModeBadge />
      </div>

      <!-- `md`, not `sm`: this is the primary toolbar, and `sm` is a 36px
           control that clears the WCAG 2.5.8 minimum but not this project's
           44px bar. -->
      <ViewToggle bind:value={viewMode} size="md" disabled={busy} />

      <IconButton
        label="New folder"
        variant="ghost"
        icon={FolderPlus}
        class="hidden sm:inline-flex"
        disabled={busy}
        onclick={onCreateFolder}
      />

      <Button
        size="md"
        variant="primary"
        leading={Upload}
        class="relative"
        onclick={onUploadClick}
        aria-label={queueBadge > 0 ? queue.summary : 'Upload files'}
      >
        <span class="hidden sm:inline">Upload</span>
        {#if queueBadge > 0}
          <span
            class="ml-1 rounded-full bg-white/25 px-1.5 text-xs tabular-nums"
            aria-hidden="true"
          >
            {formatCount(queueBadge)}
          </span>
        {/if}
      </Button>
    </div>
  </div>

  <div class="flex items-center gap-2">
    <SearchBar
      bind:value={query}
      onSearch={onQueryChange}
      loading={searching}
      placeholder="Search files and folders…"
      submitRoute="/"
      debounceMs={200}
      class="min-w-0 flex-1"
    />

    {#if showResultCount}
      <p class="shrink-0 text-xs tabular-nums text-fg-muted" role="status" aria-live="polite">
        {formatCount(resultCount)} {resultCount === 1 ? 'result' : 'results'}
      </p>
    {/if}
  </div>

  <p class="sr-only" role="status" aria-live="polite">
    {queue.isUploading ? queue.summary : ''}
  </p>
</header>
