<script lang="ts">
  import { ChevronRight, House } from '@lucide/svelte';
  import type { BreadcrumbNode } from '$lib/types/drive';

  interface Props {
    /** Root-first path. A leading `{ id: null }` node renders as the Drive home. */
    nodes: readonly BreadcrumbNode[];
    /** Called with the node's id, or `null` for the root. */
    onNavigate: (id: string | null) => void;
    /**
     * Accepts dropped folders to relocate the current folder into them.
     * Omitted on routes that cannot accept a move (trash, search results).
     */
    onDropFolder?: (folderId: string) => void;
    class?: string;
  }

  let { nodes, onNavigate, onDropFolder, class: className }: Props = $props();

  let dropTargetId = $state<string | null>(null);

  /** The last node is the current location and must not be a link. */
  const trail = $derived(nodes.length > 0 ? nodes : [{ id: null, name: 'My Drive' }]);
  const currentIndex = $derived(trail.length - 1);

  function isRoot(node: BreadcrumbNode): boolean {
    return node.id === null;
  }

  function handleDragOver(event: DragEvent, node: BreadcrumbNode): void {
    if (!onDropFolder || node.id === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    dropTargetId = node.id;
  }

  function handleDragLeave(node: BreadcrumbNode): void {
    if (dropTargetId === node.id) dropTargetId = null;
  }

  function handleDrop(event: DragEvent, node: BreadcrumbNode): void {
    if (!onDropFolder || node.id === null) return;
    event.preventDefault();
    dropTargetId = null;

    const folderId = event.dataTransfer?.getData('application/x-drive-folder-id') ?? '';
    if (folderId.length > 0) onDropFolder(folderId);
  }
</script>

<nav aria-label="Breadcrumb" class={['min-w-0', className ?? ''].filter(Boolean).join(' ')}>
  <ol
    class="scrollbar-slim -mx-1 flex items-center gap-0.5 overflow-x-auto px-1 py-1"
    style="scrollbar-width: none;"
  >
    {#each trail as node, index (index)}
      <!--
        The drag handlers live on the list item rather than on the current-page
        <span> or the sibling buttons: a bare span with drag handlers carries no
        implicit role, and hoisting them here also lets the whole crumb, chevron
        included, act as the drop target.
      -->
      <li
        class="flex shrink-0 items-center"
        ondragover={onDropFolder ? (event) => handleDragOver(event, node) : undefined}
        ondragleave={onDropFolder ? () => handleDragLeave(node) : undefined}
        ondrop={onDropFolder ? (event) => handleDrop(event, node) : undefined}
        class:rounded-md={dropTargetId === node.id}
        class:bg-accent-soft={dropTargetId === node.id}
        class:ring-2={dropTargetId === node.id}
        class:ring-accent={dropTargetId === node.id}
      >
        {#if index > 0}
          <span class="px-0.5 text-fg-subtle" aria-hidden="true">
            <ChevronRight size={16} />
          </span>
        {/if}

        {#if index === currentIndex}
          <span
            aria-current="page"
            class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-semibold text-fg"
          >
            {#if isRoot(node)}
              <House size={15} aria-hidden="true" />
            {/if}
            <span class="max-w-[10rem] truncate">{node.name}</span>
          </span>
        {:else}
          <button
            type="button"
            onclick={() => onNavigate(node.id)}
            draggable={onDropFolder !== undefined && node.id !== null}
            ondragstart={onDropFolder && node.id !== null
              ? (event) => {
                  event.dataTransfer?.setData('application/x-drive-folder-id', node.id as string);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                }
              : undefined}
            class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-hover"
          >
            {#if isRoot(node)}
              <House size={15} aria-hidden="true" />
            {/if}
            <span class="max-w-[10rem] truncate">{node.name}</span>
          </button>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
