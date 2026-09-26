<script lang="ts">
  /**
   * App shell.
   *
   * Owns everything that outlives a route: the session gate, the navigation,
   * the global search header, the upload affordances and the queue. Routes
   * below it are pure content — each one names a `DriveScope` and nothing else.
   *
   * The responsive matrix from the plan is implemented here, and in one place:
   * the navigation is a fixed bottom bar below 768px, a 64px icon rail from
   * 768px, and a persistent 256px labelled sidebar from 1024px. Which one is
   * rendered comes from `viewportStore` rather than from a media query, because
   * the three are different components with different affordances, not the same
   * component at three widths.
   */
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import '../app.css';
  import { authStore } from '$lib/stores/authStore.svelte';
  import { driveStore, type DriveScope } from '$lib/stores/driveStore.svelte';
  import { uploadQueueStore } from '$lib/stores/uploadQueueStore.svelte';
  import { viewportStore } from '$lib/stores/viewport.svelte';
  import { shellStore } from '$lib/stores/shellStore.svelte';
  import { viewModeStore } from '$lib/stores/viewMode.svelte';
  import { getStorageClient } from '$lib/firebase/client';
  import { classifyError } from '$lib/firebase/errors';
  import { FOLDER_DRAG_MIME, MAX_FILE_SIZE_BYTES } from '$lib/config/constants';
  import { formatBytes } from '$lib/utils/formatters';
  import SidebarNavigation from '$lib/components/organisms/SidebarNavigation.svelte';
  import TopNavbar from '$lib/components/organisms/TopNavbar.svelte';
  import UploadQueueDrawer from '$lib/components/organisms/UploadQueueDrawer.svelte';
  import UploadDropzone from '$lib/components/organisms/UploadDropzone.svelte';
  import CreateFolderModal from '$lib/components/organisms/CreateFolderModal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import StorageMeter from '$lib/components/molecules/StorageMeter.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  /** The single file input both the button and the dropzone feed. */
  let fileInput = $state<HTMLInputElement | null>(null);
  /** `File` handles by task id, so a paused upload can be resumed. */
  let uploadFiles = $state<ReadonlyMap<string, File>>(new Map());

  let createFolderOpen = $state(false);
  let createFolderError = $state<string | null>(null);
  let creatingFolder = $state(false);
  /** Mobile sheet, which carries the account controls the bottom bar omits. */
  let mobileNavOpen = $state(false);
  let navError = $state<string | null>(null);
  let signingOut = $state(false);
  /** Mirrors the store's filter so the search field can be two-way bound. */
  let query = $state('');
  /** True while a dragged folder is over the content area. */
  let folderOverContent = $state(false);

  const EMPTY_QUOTA = { usedBytes: 0, reservedBytes: 0, totalBytes: 0 };

  const quota = $derived(authStore.quota ?? EMPTY_QUOTA);
  const trashCount = $derived(driveStore.trashCount);
  const canDropFolders = $derived(driveStore.scope.kind !== 'trash');
  const canCreateFolder = $derived(driveStore.scope.kind !== 'trash');

  // A navigation on mobile should dismiss the sheet; leaving it open over a new
  // scope would hide the result of the tap that closed it.
  $effect(() => {
    void driveStore.scope;
    mobileNavOpen = false;
  });

  // The search field is owned by the navbar, but the authoritative value lives
  // on the store so it survives navigation. Syncing both ways here keeps the
  // field and the query from drifting when either side changes on its own.
  $effect(() => {
    const stored: string = driveStore.filters.searchQuery;
    if (stored !== query) query = stored;
  });

  onMount(() => {
    void authStore.initialize();
    viewportStore.attach();
    viewModeStore.hydrate();

    // The listing's empty states and the mobile FAB both reach the real
    // controls through these, so there is one file input and one dialog in the
    // document rather than one per trigger.
    const unregister = shellStore.register({ openUploadPicker, openCreateFolder: openCreateFolderDialog });

    return () => {
      unregister();
      viewportStore.detach();
      driveStore.destroy();
    };
  });

  // --- navigation ---------------------------------------------------------

  function pathFor(scope: DriveScope): string {
    if (scope.kind === 'folder') return scope.folderId === null ? '/' : `/folder/${scope.folderId}`;
    return `/${scope.kind}`;
  }

  function navigate(scope: DriveScope): void {
    driveStore.openScope(scope);
  }

  async function signOut(): Promise<void> {
    mobileNavOpen = false;
    signingOut = true;
    try {
      await authStore.signOut();
    } finally {
      signingOut = false;
    }
  }

  // --- uploads ------------------------------------------------------------

  function openUploadPicker(): void {
    fileInput?.click();
  }

  function openCreateFolderDialog(): void {
    createFolderError = null;
    createFolderOpen = true;
  }

  function handleFileInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    // Reset first: without it, re-picking the same file fires no change event
    // and the second attempt silently does nothing.
    input.value = '';
    enqueue(files);
  }

  function enqueue(files: readonly File[]): void {
    if (files.length === 0) return;

    const quota = authStore.quota;
    if (quota === null) {
      navError = 'Storage is not ready yet. Try again in a moment.';
      return;
    }

    const available = quota.totalBytes - quota.usedBytes - quota.reservedBytes;
    const rejected: string[] = [];
    const accepted: File[] = [];

    for (const file of files) {
      // Rejecting here rather than in the store keeps the reason attached to
      // the file the user picked, rather than to a task row they have to find.
      if (file.size > MAX_FILE_SIZE_BYTES) {
        rejected.push(`${file.name} is ${formatBytes(file.size)}, over the per-file limit`);
        continue;
      }
      if (file.size > available) {
        rejected.push(`${file.name} does not fit in your remaining space`);
        continue;
      }
      accepted.push(file);
    }

    if (accepted.length > 0) {
      const ids = uploadQueueStore.enqueue(accepted, driveStore.uploadTargetFolderId);
      const next = new Map(uploadFiles);
      accepted.forEach((file, index) => {
        const id = ids[index];
        if (id !== undefined) next.set(id, file);
      });
      uploadFiles = next;
      uploadQueueStore.setExpanded(true);
    }

    navError = rejected.length > 0 ? rejected.join('; ') : null;
  }

  function handleDrop(entries: readonly File[], _droppedDirectory: File | null): void {
    enqueue(entries);
  }

  // --- folder creation ----------------------------------------------------

  async function submitCreateFolder(name: string): Promise<void> {
    creatingFolder = true;
    createFolderError = null;
    try {
      const { result } = await driveStore.createFolder(name, driveStore.uploadTargetFolderId);
      if (!result.ok) {
        createFolderError = classifyError(result.error ?? new Error('The folder could not be created.')).message;
        return;
      }
      createFolderOpen = false;
    } finally {
      creatingFolder = false;
    }
  }

  /**
   * Move a folder dropped onto the breadcrumb trail into the current scope.
   * A drop on the crumb the folder already lives in is a no-op rather than an
   * error, because that is the easiest way to hit this by accident.
   */
  async function dropFolder(folderId: string): Promise<void> {
    if (folderId === driveStore.uploadTargetFolderId) return;
    const result = await driveStore.moveItems([folderId], driveStore.uploadTargetFolderId);
    navError = result.ok
      ? null
      : classifyError(result.error ?? new Error('The folder could not be moved.')).message;
  }

  /**
   * Accept a folder dragged onto the content area.
   *
   * The breadcrumb trail is the precise target, but it is not always under the
   * pointer, and a drop that does nothing is indistinguishable from a bug. The
   * main column is therefore a fallback target with the same meaning: "put this
   * where I am looking".
   */
  function handleContentDragOver(event: DragEvent): void {
    if (!canDropFolders) return;
    if (event.dataTransfer?.types.includes(FOLDER_DRAG_MIME) !== true) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    folderOverContent = true;
  }

  function handleContentDrop(event: DragEvent): void {
    folderOverContent = false;
    if (!canDropFolders) return;
    const folderId = event.dataTransfer?.getData(FOLDER_DRAG_MIME) ?? '';
    if (folderId === '') return;
    event.preventDefault();
    void dropFolder(folderId);
  }

  // --- accessible names ---------------------------------------------------

  const accountName = $derived(
    authStore.profile?.displayName ?? authStore.authUser?.displayName ?? authStore.uid ?? 'Signed in'
  );

  /** A uid is known and the session has settled, so the gate can be lifted. */
  const sessionResolved = $derived(authStore.isAuthenticated);
  const signedIn = $derived(authStore.isAuthenticated);
  /** The profile carrying the quota ledger is still missing or failed. */
  const driveUnavailable = $derived(authStore.isAuthenticated && !authStore.isReady);

  const dropDestination = $derived(
    driveStore.scope.kind === 'trash' ? null : (driveStore.scopeTitle ?? null)
  );

  /**
   * Establish the listing subscription when — and only when — a uid exists.
   *
   * `driveStore.openScope()` is called during component setup, which happens
   * before sign-in has resolved, so the store correctly records the intent and
   * declines to subscribe: there is no `ownerId` to filter on yet. Nothing
   * re-runs it afterwards on its own, so without this effect the drive stayed
   * in `loading` for the rest of the session. That is worse than an error,
   * because no listener error ever fires, so the "This folder could not be
   * loaded" card never appears and the retry button that would call `sync()`
   * is never rendered. The only recovery was a full page reload.
   *
   * Keyed on the uid so a sign-out and a subsequent sign-in as a different
   * account both re-subscribe, and so repeated renders of the same session
   * (profile arriving, filters changing) do not tear the listener down.
   */
  $effect(() => {
    if (authStore.uid !== null) driveStore.sync();
  });

</script>

<svelte:head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="light dark" />
  <!-- No <title> here on purpose: every route names itself, and a layout
       title would win over the page's. `+error.svelte` supplies the fallback
       for the routes that do not. -->
</svelte:head>

<a
  href="#main-content"
  class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50
         focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-sm
         focus:font-medium focus:text-accent-fg focus:shadow-lg"
>
  Skip to main content
</a>

<!--
  The gate and the page are siblings, not alternatives. Both are always in the
  DOM; which one is *shown* depends on the session. That matters for more than
  the visuals: `{@render children()}` is what puts the page's `<svelte:head>`
  in the document, so a gate that skipped the children on the server would ship
  every route with the app's default title and no per-page description. Keeping
  the content mounted also means the listing subscribes as soon as a uid
  arrives, instead of mounting a second time behind the gate.
-->
<div class="relative min-h-dvh">
  <!--
    The app shell stays mounted whatever the session is doing. That is not a
    styling shortcut: `{@render children()}` is what puts each page's
    `<svelte:head>` into the document, so a gate that skipped the children on
    the server would ship every route with the app's default title and no
    per-page description. It also means the listing subscribes the moment a uid
    arrives, instead of mounting a second time once the gate lifts.
  -->
  <div class="min-h-dvh" class:hidden={!signedIn} aria-busy={!sessionResolved || undefined}>
  <div class="flex min-h-dvh bg-canvas">
    <!-- Desktop sidebar, and the tablet rail. Both are fixed rails; only the
         content column scrolls, so the navigation never leaves the screen. -->
    {#if viewportStore.tier === 'desktop' || viewportStore.tier === 'tablet'}
      <aside
        class="sticky top-0 hidden h-dvh shrink-0 border-r border-line bg-surface md:block
               md:w-16 lg:w-64"
        aria-label="Drive navigation"
      >
        <SidebarNavigation
          density={viewportStore.density}
          scope={driveStore.scope}
          displayName={authStore.profile?.displayName ?? authStore.authUser?.displayName ?? null}
          email={authStore.authUser?.email ?? null}
          {quota}
          {trashCount}
          busy={signingOut}
          onNavigate={navigate}
          onSignOut={() => void signOut()}
        />
      </aside>
    {/if}

    <div class="flex min-w-0 flex-1 flex-col">
      <TopNavbar
        breadcrumbs={driveStore.breadcrumbs}
        scopeTitle={driveStore.scopeTitle}
        bind:viewMode={viewModeStore.mode}
        bind:query={query}
        searching={driveStore.isLoading}
        resultCount={driveStore.visibleItems.length}
        busy={driveStore.isBusy}
        queue={uploadQueueStore}
        canDropFolders={canDropFolders}
        onBreadcrumbNavigate={(id) => navigate({ kind: 'folder', folderId: id })}
        onQueryChange={(value) => {
          query = value;
          driveStore.setFilters({ searchQuery: value });
        }}
        onCreateFolder={openCreateFolderDialog}
        onUploadClick={openUploadPicker}
        onOpenSidebar={() => (mobileNavOpen = true)}
        onDropFolder={(folderId) => void dropFolder(folderId)}
      />

      <main
        id="main-content"
        class="relative min-w-0 flex-1 pb-20 md:pb-0"
        class:ring-2={folderOverContent}
        class:ring-inset={folderOverContent}
        class:ring-accent={folderOverContent}
        tabindex="-1"
        ondragover={handleContentDragOver}
        ondragleave={() => (folderOverContent = false)}
        ondrop={handleContentDrop}
      >
        {#if folderOverContent}
          <p
            class="pointer-events-none absolute inset-x-4 top-4 z-10 mx-auto w-fit rounded-full
                   bg-accent px-4 py-2 text-sm text-accent-fg shadow-lg"
            aria-hidden="true"
          >
            Drop to move into {driveStore.scopeTitle}
          </p>
        {/if}
        {@render children()}

        <!--
          Profile provisioning is the one thing the app cannot work without —
          the quota ledger lives on the user document — but it is not a reason
          to hold the whole shell behind a splash screen. The navigation stays
          usable and the failure is reported here, with a retry, instead of
          stranding the user on a spinner that never resolves.
        -->
        {#if driveUnavailable}
          <div
            class="absolute inset-0 z-20 flex items-start justify-center bg-canvas/90 px-6 py-16
                   backdrop-blur-sm"
          >
            <div class="w-full max-w-md rounded-card border border-line bg-surface p-6 shadow-raised">
              {#if authStore.profileError}
                <h2 class="text-balance text-base font-semibold tracking-tight text-fg">Your drive is not available</h2>
                <p class="mt-2 text-sm leading-relaxed text-fg-muted">
                  The account signed in, but its drive profile could not be read or created. Your files
                  are untouched — nothing has been deleted or modified.
                </p>
                <p
                  class="mt-3 rounded-card bg-sunken px-3 py-2 text-sm text-fg-subtle"
                  role="alert"
                >
                  {authStore.profileError.message}
                </p>
                <div class="mt-4 flex justify-end">
                  <Button onclick={() => authStore.retryProfile()}>Try again</Button>
                </div>
              {:else}
                <div class="flex flex-col items-center gap-3 py-4 text-fg-muted" role="status" aria-live="polite">
                  <span
                    class="h-7 w-7 animate-spin rounded-full border-2 border-line border-t-accent"
                    aria-hidden="true"
                  ></span>
                  <p class="text-sm">Preparing your drive…</p>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </main>
    </div>
  </div>

  <!--
    Mobile upload FAB. The header's upload button is out of comfortable reach on
    a phone, and the bottom bar has no room for a fourth primary action, so the
    main create gesture gets a floating target above the bar.
  -->
  {#if viewportStore.isMobile}
    <button
      type="button"
      class="fixed right-4 bottom-20 z-30 flex h-14 w-14 items-center justify-center rounded-full
             bg-accent text-accent-fg shadow-overlay transition-transform active:scale-95
             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      aria-label="Upload files"
      onclick={openUploadPicker}
    >
      <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M12 19V5M5 12l7-7 7 7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  {/if}

  <!-- Mobile navigation: a fixed bottom bar for the three primary scopes, with
       the account controls reached through a sheet. -->
  {#if viewportStore.tier === 'mobile'}
    <div class="fixed inset-x-0 bottom-0 z-30">
      <SidebarNavigation
        density="bottom"
        scope={driveStore.scope}
        displayName={authStore.profile?.displayName ?? authStore.authUser?.displayName ?? null}
        email={authStore.authUser?.email ?? null}
        {quota}
        {trashCount}
        busy={false}
        onNavigate={navigate}
        onSignOut={() => void signOut()}
      />
    </div>
  {/if}
  </div>

  <!-- The gate, overlaid on whatever the shell is doing. -->
  {#if !sessionResolved}
  <div class="absolute inset-0 flex items-center justify-center bg-canvas px-6" aria-hidden="true">
    <div class="flex flex-col items-center gap-3 text-fg-muted" role="status" aria-live="polite">
      <span class="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden="true"></span>
      <p class="text-sm">Connecting to your drive…</p>
    </div>
  </div>
{:else if !signedIn}
  <main class="flex min-h-dvh items-center justify-center bg-canvas px-6">
    <div class="flex w-full max-w-sm flex-col items-center gap-5 text-center">
      <div class="flex flex-col items-center gap-2">
        <span
          class="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent"
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" stroke-linejoin="round" />
          </svg>
        </span>
        <h1 class="text-xl font-semibold tracking-tight text-fg">Cloud Drive</h1>
        <p class="text-sm leading-relaxed text-fg-muted">
          Sign in to reach your files. This build authenticates anonymously against the emulator, so no
          credentials are collected.
        </p>
      </div>

      {#if authStore.error}
        <p class="w-full rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {authStore.error.message}
        </p>
      {/if}

      <Button fullWidth onclick={() => void authStore.initialize()}>Continue</Button>
    </div>
  </main>
{/if}
</div>

<!--
  Chrome that outlives the gate: the queue drawer, the dropzone and the shared
  dialogs. They are outside the signed-in shell because an upload in flight
  must still be cancellable while the session is being re-established, and
  because the file input has to exist before the dropzone can hand anything to
  the queue.
-->
  <!-- The queue drawer is a sibling of the main column so it can sit above the
       bottom bar rather than inside the scroll container. -->
  <UploadQueueDrawer store={uploadQueueStore} files={uploadFiles} />

  <UploadDropzone
    mode="files"
    destinationLabel={dropDestination}
    disabled={driveStore.scope.kind === 'trash'}
    onDrop={handleDrop}
  />

<!-- Mobile navigation sheet. Rendered outside the tier branches so it is
     available the moment the tier flips, and hidden from the a11y tree when
     closed rather than merely invisible. -->
{#if mobileNavOpen && authStore.status === 'signed-in'}
  <div class="fixed inset-0 z-40 md:hidden" role="presentation">
    <button
      type="button"
      class="absolute inset-0 bg-black/50"
      aria-label="Close navigation"
      onclick={() => (mobileNavOpen = false)}
    ></button>
    <div
      class="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Drive menu"
    >
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-base font-semibold text-fg">{accountName}</h2>
        <button
          type="button"
          class="-m-2 rounded-lg p-2 text-fg-muted hover:bg-surface-hover hover:text-fg
                 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label="Close navigation"
          onclick={() => (mobileNavOpen = false)}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <StorageMeter {quota} variant="compact" class="mb-4" />

      <div class="flex flex-col gap-2">
        <Button
          variant="secondary"
          fullWidth
          onclick={() => {
            mobileNavOpen = false;
            openCreateFolderDialog();
          }}
        >
          New folder
        </Button>
        <Button variant="secondary" fullWidth onclick={openUploadPicker}>Upload files</Button>
        <Button variant="ghost" fullWidth onclick={() => void signOut()}>Sign out</Button>
      </div>
    </div>
  </div>
{/if}

<!-- Shared upload input. One element serves the button, the sheet and the
     dropzone's fallback path, so there is a single place that turns a File
     list into queue tasks. -->
<input
  bind:this={fileInput}
  type="file"
  multiple
  class="sr-only"
  aria-hidden="true"
  tabindex="-1"
  onchange={handleFileInput}
/>

<CreateFolderModal
  bind:open={createFolderOpen}
  busy={creatingFolder}
  destinationLabel={canCreateFolder ? driveStore.scopeTitle : null}
  error={createFolderError}
  takenNames={driveStore.visibleItems.map((item) => item.name.toLowerCase())}
  onclose={() => {
    createFolderOpen = false;
    createFolderError = null;
  }}
  onsubmit={(name) => void submitCreateFolder(name)}
/>

{#if navError}
  <div
    class="pointer-events-auto fixed inset-x-3 bottom-20 z-50 mx-auto w-fit max-w-[min(30rem,90vw)]
           rounded-card border border-line bg-surface px-4 py-3 text-sm text-fg-muted shadow-overlay
           md:bottom-6"
    role="alert"
  >
    {navError}
  </div>
{/if}
