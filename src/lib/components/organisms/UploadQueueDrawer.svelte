<script lang="ts">
  /**
   * Upload queue panel.
   *
   * Presentational only. It reads the queue store and reports intent; the shell
   * owns the `File` handles needed to resume or retry, because a browser cannot
   * re-derive a picked `File` from a path the way a native app can. That
   * constraint is the reason the drawer takes a `files` map rather than
   * reaching for one itself.
   *
   * A row is never removed by a timer. A failed upload stays until it is
   * dismissed or retried, because a message that disappears on its own is a
   * message the user cannot act on.
   */
  import {
    Check,
    ChevronDown,
    ChevronUp,
    Ellipsis,
    LoaderCircle,
    Pause,
    Play,
    RotateCcw,
    TriangleAlert,
    X
  } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import ProgressBar from '$lib/components/ui/ProgressBar.svelte';
  import DropdownMenu, { type DropdownMenuAnchor } from '$lib/components/ui/DropdownMenu.svelte';
  import { formatBytes, formatPercentage } from '$lib/utils/formatters';
  import type { UploadQueueStore, UploadTask } from '$lib/stores/uploadQueueStore.svelte';

  interface Props {
    /** The queue store. */
    store: UploadQueueStore;
    /** The original `File` handles, keyed by task id, for resume and retry. */
    files: ReadonlyMap<string, File>;
    /** Absolute path the fixed trigger is pinned to. */
    class?: string;
  }

  let { store, files, class: className = '' }: Props = $props();

  /** Which row's overflow menu is open, if any. */
  let menuTaskId = $state<string | null>(null);
  let menuAnchor = $state<DropdownMenuAnchor | null>(null);

  const open = $derived(menuTaskId !== null && menuAnchor !== null);

  function openMenu(event: MouseEvent, taskId: string): void {
    menuAnchor = { type: 'point', x: event.clientX, y: event.clientY };
    menuTaskId = taskId;
  }

  function closeMenu(): void {
    menuTaskId = null;
    menuAnchor = null;
  }

  /** Human-readable status for a row. */
  function statusLabel(task: UploadTask): string {
    switch (task.status) {
      case 'pending':
        return 'Waiting for a free slot';
      case 'uploading':
        return `${formatPercentage(task.progressPercentage)} · ${formatBytes(task.bytesTransferred)} of ${formatBytes(task.sizeBytes)}`;
      case 'paused':
        return 'Paused — your place in the queue is held';
      case 'completed':
        return 'Uploaded';
      case 'error':
        return task.errorMessage ?? 'Upload failed';
    }
  }

  /** The row's progress, expressed for `ProgressBar`. */
  function barValue(task: UploadTask): number {
    if (task.status === 'completed') return 100;
    return Math.max(0, Math.min(100, task.progressPercentage));
  }

  function canResume(task: UploadTask): boolean {
    return task.status === 'paused' && files.has(task.taskId);
  }

  function canRetry(task: UploadTask): boolean {
    return task.status === 'error' && files.has(task.taskId);
  }
</script>

<section
  class="fixed bottom-20 right-4 z-40 flex max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] flex-col
         overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl
         dark:border-gray-800 dark:bg-gray-900 sm:bottom-4 {className}"
  aria-label="Upload queue"
  aria-busy={store.isUploading}
>
  <header class="flex items-center gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
    <h2 class="text-sm font-semibold text-gray-900 dark:text-gray-100">{store.summary}</h2>

    {#if store.tasks.length > 0}
      <div class="ml-auto flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={store.isUploading} onclick={() => store.clearFinished()}>
          Clear
        </Button>
        <IconButton
          label={store.isExpanded ? 'Collapse upload queue' : 'Expand upload queue'}
          size="sm"
          variant="ghost"
          aria-expanded={store.isExpanded}
          aria-controls="upload-queue-list"
          icon={store.isExpanded ? ChevronDown : ChevronUp}
          onclick={() => store.toggle()}
        />
      </div>
    {/if}
  </header>

  <!--
    Collapsed by unmounting, not by height.

    A height/overflow collapse leaves the rows in the DOM at their full size with
    the container clipped, so every per-row button inside is still laid out and
    still focusable — a keyboard user tabs into a list they cannot see, and a
    pointer user on the row underneath can be handed a click to a button that is
    not visible. `{#if}` removes the subtree, so the collapsed drawer is exactly
    the header and nothing else.

    The trade-off is that there is no animation. It is the right one here: the
    alternative is an `aria-hidden` box full of live controls, which is a worse
    accessibility defect than a missing transition.
  -->
  {#if store.isExpanded}
    {#if store.isUploading}
      <div class="border-b border-gray-100 px-4 py-2 dark:border-gray-800">
        <ProgressBar value={store.aggregateProgress} label="Overall upload progress" size="sm" />
      </div>
    {/if}

    <ul id="upload-queue-list" class="flex-1 overflow-y-auto overscroll-contain">
    {#each store.tasks as task (task.taskId)}
      <li class="border-b border-gray-50 px-4 py-3 last:border-b-0 dark:border-gray-800/60">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-gray-900 dark:text-gray-100" title={task.fileName}>
              {task.fileName}
            </p>
            <p
              class="mt-0.5 flex items-center gap-1.5 text-xs
                     {task.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}"
              class:truncate={task.status !== 'error'}
            >
              {#if task.status === 'uploading' || task.status === 'pending'}
                <LoaderCircle size={12} class="shrink-0 animate-spin" aria-hidden="true" />
              {:else if task.status === 'completed'}
                <Check size={12} class="shrink-0 text-green-600" aria-hidden="true" />
              {:else if task.status === 'error'}
                <TriangleAlert size={12} class="shrink-0" aria-hidden="true" />
              {/if}
              <span class="truncate">{statusLabel(task)}</span>
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-1">
            {#if task.status === 'uploading'}
              <IconButton
                label={`Pause ${task.fileName}`}
                size="sm"
                variant="ghost"
                icon={Pause}
                onclick={() => store.pause(task.taskId)}
              />
            {:else if task.status === 'paused'}
              <IconButton
                label={`Resume ${task.fileName}`}
                size="sm"
                variant="ghost"
                icon={Play}
                disabled={!canResume(task)}
                onclick={() => store.resume(task.taskId, files.get(task.taskId) as File)}
              />
            {/if}

            {#if canRetry(task)}
              <IconButton
                label={`Retry ${task.fileName}`}
                size="sm"
                variant="ghost"
                icon={RotateCcw}
                onclick={() => store.retry(task.taskId, files.get(task.taskId) as File)}
              />
            {/if}

            <IconButton
              label={`Cancel ${task.fileName}`}
              size="sm"
              variant="ghost"
              icon={X}
              disabled={task.isSettled}
              onclick={() => store.cancel(task.taskId)}
            />

            {#if task.isSettled}
              <IconButton
                label={`Dismiss ${task.fileName}`}
                size="sm"
                variant="ghost"
                icon={Ellipsis}
                onclick={(event) => openMenu(event, task.taskId)}
              />
            {/if}
          </div>
        </div>

        {#if task.status === 'uploading' || task.status === 'paused'}
          <div class="mt-2">
            <ProgressBar
              value={barValue(task)}
              label={`${task.fileName} progress`}
              size="sm"
              indeterminate={task.status === 'paused'}
            />
          </div>
        {/if}
      </li>
    {:else}
      <li class="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
        Nothing in the queue.
      </li>
    {/each}
    </ul>
  {/if}
</section>

{#if open && menuTaskId !== null && menuAnchor !== null}
  {@const task = store.tasks.find((candidate) => candidate.taskId === menuTaskId)}
  {#if task !== undefined}
    <DropdownMenu
      open={true}
      anchor={menuAnchor}
      label={`Options for ${task.fileName}`}
      onclose={closeMenu}
      entries={[
        {
          id: 'retry',
          label: 'Retry upload',
          icon: RotateCcw,
          disabled: !canRetry(task),
          onSelect: () => store.retry(task.taskId, files.get(task.taskId) as File)
        },
        {
          id: 'dismiss',
          label: 'Remove from list',
          icon: X,
          onSelect: () => store.dismiss(task.taskId)
        }
      ]}
    />
  {/if}
{/if}
