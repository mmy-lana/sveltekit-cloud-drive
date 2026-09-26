<script lang="ts">
  /**
   * Empty and zero-result state.
   *
   * The artwork is drawn, not imported: a single vector that is tinted by the
   * tone and scaled by size, so there is no binary asset to ship and no
   * layout shift while a font or image is still loading.
   */
  import type { LucideIcon } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import Button from '../ui/Button.svelte';

  type EmptyStateSize = 'sm' | 'md' | 'lg';
  type EmptyStateArtwork = 'folder' | 'search' | 'trash' | 'star' | 'upload' | 'shield';

  interface Props {
    /** Headline explaining why the region is empty. */
    title: string;
    /** One or two sentences of recovery-oriented guidance. */
    description?: string | null;
    artwork?: EmptyStateArtwork;
    size?: EmptyStateSize;
    /** Optional primary recovery action, e.g. "Upload files". */
    actionLabel?: string | null;
    onAction?: () => void;
    /** Optional secondary action for the "clear filters" path. */
    secondaryLabel?: string | null;
    onSecondary?: () => void;
    /** Replaces the default artwork. */
    icon?: LucideIcon;
    class?: string;
    children?: Snippet;
  }

  let {
    title,
    description = null,
    artwork = 'folder',
    size = 'md',
    actionLabel = null,
    onAction,
    secondaryLabel = null,
    onSecondary,
    icon,
    class: className,
    children
  }: Props = $props();

  const ARTWORK_SIZE: Record<EmptyStateSize, number> = { sm: 48, md: 64, lg: 88 };
  const CONTAINER_CLASSES: Record<EmptyStateSize, string> = {
    sm: 'gap-3 py-8',
    md: 'gap-4 py-12',
    lg: 'gap-5 py-16'
  };

  const pixels = $derived(ARTWORK_SIZE[size]);
  const hasActions = $derived(actionLabel !== null || secondaryLabel !== null);
</script>

<div
  class={[
    'flex w-full flex-col items-center justify-center px-6 text-center',
    CONTAINER_CLASSES[size],
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')}
  role="status"
>
  {#if icon}
    {@const CustomIcon = icon}
    <span
      class="flex items-center justify-center rounded-2xl bg-sunken text-fg-subtle"
      style:width="{pixels}px"
      style:height="{pixels}px"
    >
      <CustomIcon size={Math.round(pixels * 0.5)} aria-hidden="true" />
    </span>
  {:else}
    <svg
      width={pixels}
      height={pixels}
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
      class="text-fg-subtle/70"
    >
      <!-- Plate -->
      <rect x="8" y="14" width="80" height="68" rx="12" fill="currentColor" opacity="0.08" />

      {#if artwork === 'search'}
        <circle cx="43" cy="43" r="17" stroke="currentColor" stroke-width="4" opacity="0.45" />
        <path d="M56 56l14 14" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity="0.45" />
      {:else if artwork === 'trash'}
        <path
          d="M36 34v34M48 34v34M60 34v34"
          stroke="currentColor"
          stroke-width="4"
          stroke-linecap="round"
          opacity="0.4"
        />
        <path d="M30 30h36" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity="0.55" />
        <path
          d="M34 30l3-10h22l3 10"
          stroke="currentColor"
          stroke-width="4"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity="0.55"
        />
      {:else if artwork === 'star'}
        <path
          d="M48 22l8.2 16.6 18.3 2.7-13.2 12.9 3.1 18.3L48 64.2 31.6 72.5l3.1-18.3L21.5 41.3l18.3-2.7L48 22Z"
          stroke="currentColor"
          stroke-width="4"
          stroke-linejoin="round"
          opacity="0.45"
        />
      {:else if artwork === 'upload'}
        <path
          d="M48 62V32M36 44l12-12 12 12"
          stroke="currentColor"
          stroke-width="4"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity="0.5"
        />
        <path d="M28 66h40" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity="0.5" />
      {:else if artwork === 'shield'}
        <path
          d="M48 20l22 9v16c0 14-9 25-22 31-13-6-22-17-22-31V29l22-9Z"
          stroke="currentColor"
          stroke-width="4"
          stroke-linejoin="round"
          opacity="0.45"
        />
        <path
          d="M40 47l6 6 11-12"
          stroke="currentColor"
          stroke-width="4"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity="0.5"
        />
      {:else}
        <path
          d="M22 34a6 6 0 0 1 6-6h12l6 7h24a6 6 0 0 1 6 6v31a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6V34Z"
          stroke="currentColor"
          stroke-width="4"
          stroke-linejoin="round"
          opacity="0.45"
        />
      {/if}
    </svg>
  {/if}

  <h3 class="text-base font-semibold text-fg">{title}</h3>

  {#if description}
    <p class="max-w-sm text-sm leading-relaxed text-fg-muted">{description}</p>
  {/if}

  {#if children}
    <div class="mt-1">{@render children()}</div>
  {/if}

  {#if hasActions}
    <div class="mt-2 flex flex-wrap items-center justify-center gap-2">
      {#if secondaryLabel !== null}
        <Button variant="secondary" onclick={onSecondary}>{secondaryLabel}</Button>
      {/if}
      {#if actionLabel !== null}
        <Button onclick={onAction}>{actionLabel}</Button>
      {/if}
    </div>
  {/if}
</div>
