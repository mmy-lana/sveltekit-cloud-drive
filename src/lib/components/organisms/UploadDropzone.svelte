<script lang="ts">
  /**
   * Screen-wide drag interception.
   *
   * A `dragenter`/`dragleave` counter is used rather than the event target alone,
   * because moving between two child elements fires `dragleave` on the old target
   * while `dragenter` fires on the new one; without the counter the overlay
   * flickers off and on during every mouse movement. DataTransfer is also probed
   * for file payloads, so dragging selected text or a link does not raise the
   * overlay.
   */
  import { CloudUpload, FolderInput } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    /** Two-way bound overlay visibility, for callers that need to observe it. */
    active?: boolean;
    /** Only folder drags change the destination, so the copy can differ. */
    mode?: 'files' | 'folder';
    /** Called with the dropped entries. Empty folders have no File entry. */
    onDrop: (entries: File[], droppedDirectory: File | null) => void;
    /** The folder the drop would land in, shown in the overlay copy. */
    destinationLabel?: string | null;
    /** Rejects the drop, e.g. inside Trash, and shows the overlay as blocked. */
    disabled?: boolean;
    class?: string;
    children?: Snippet;
  }

  let {
    active = $bindable(false),
    mode = 'files',
    onDrop,
    destinationLabel = null,
    disabled = false,
    class: className,
    children
  }: Props = $props();

  let dragDepth = $state(0);
  let blocked = $state(false);
  let dropTarget = $state<HTMLElement | null>(null);

  const MIME_FOLDERS = 'application/x-moz-file-promise;application/x-moz-file';

  function containsFiles(transfer: DataTransfer | null): boolean {
    if (transfer === null) return false;
    if (transfer.types.includes('Files')) return true;
    // Firefox exposes directories through a vendor MIME type that `types` omits.
    return transfer.types.some((type) => MIME_FOLDERS.includes(type));
  }

  function handleDragEnter(event: DragEvent): void {
    if (disabled) return;
    // Without preventDefault the browser navigates away to the dropped file.
    event.preventDefault();
    if (!containsFiles(event.dataTransfer)) return;

    dragDepth += 1;
    blocked = false;
    active = true;
  }

  function handleDragOver(event: DragEvent): void {
    if (disabled) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = containsFiles(event.dataTransfer) ? 'copy' : 'none';
    }
  }

  function handleDragLeave(event: DragEvent): void {
    if (disabled) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      active = false;
      blocked = false;
    }
  }

  function handleDrop(event: DragEvent): void {
    event.preventDefault();
    dragDepth = 0;
    active = false;
    blocked = false;

    if (disabled) return;

    const transfer = event.dataTransfer;
    if (transfer === null) return;

    const entries = Array.from(transfer.files);
    if (entries.length === 0) return;

    // A directory drag arrives as a single File with no type and a `.name` that
    // matches the directory; it is handed back separately because the browser
    // never exposes its children.
    const directory = entries.find((entry) => entry.type === '' && entry.size === 0) ?? null;
    const files = directory === null ? entries : entries.filter((entry) => entry !== directory);

    onDrop(files, directory);
  }

  $effect(() => {
    // Re-anchor after mount so the listeners can see the rendered subtree.
    dropTarget = document.body;
  });
</script>

<svelte:window
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
/>

{#if active && !blocked && !disabled}
  <!--
    The overlay is a sibling of the page content rather than a parent, so it can
    never swallow the pointer events of the tree it is announcing. `pointer-events:
    none` guarantees clicks pass through to the drop handler's normal path.
  -->
  <div
    class={[
      'animate-fade-in pointer-events-none fixed inset-0 z-[60] flex items-center justify-center',
      'bg-accent/10 backdrop-blur-[2px]',
      className ?? ''
    ]
      .filter(Boolean)
      .join(' ')}
  >
    <div
      class={[
        'animate-scale-in m-4 flex w-full max-w-xl flex-col items-center gap-3 rounded-card',
        'border-2 border-dashed border-accent bg-surface/95 p-10 text-center shadow-overlay'
      ].join(' ')}
    >
      {#if mode === 'folder'}
        <span class="text-accent">
          <FolderInput size={44} aria-hidden="true" />
        </span>
      {:else}
        <span class="text-accent">
          <CloudUpload size={44} aria-hidden="true" />
        </span>
      {/if}

      <p class="text-lg font-semibold text-fg">
        {#if mode === 'folder'}Drop to move here{:else}Drop files to upload{/if}
      </p>

      <p class="text-sm text-fg-muted">
        {#if destinationLabel !== null}
          Destination: <span class="font-medium text-fg">{destinationLabel}</span>
        {:else}
          Release to add them to this folder
        {/if}
      </p>

      {#if children}
        {@render children()}
      {/if}
    </div>
  </div>
{/if}
