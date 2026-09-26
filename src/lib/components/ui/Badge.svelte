<script lang="ts">
  import type { Snippet } from 'svelte';

  type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  type BadgeSize = 'sm' | 'md';

  interface Props {
    /** Colour intent. `danger` is reserved for destructive or failed states. */
    tone?: BadgeTone;
    size?: BadgeSize;
    /** Renders a leading status dot in the same colour. */
    dot?: boolean;
    /** Keeps the badge on one line and truncates with an ellipsis. */
    truncate?: boolean;
    /** Overrides the tone-specific text colour when embedding in dark contexts. */
    class?: string;
    children: Snippet;
  }

  let { tone = 'neutral', size = 'md', dot = false, truncate = false, class: className, children }: Props =
    $props();

  const TONE_CLASSES: Record<BadgeTone, string> = {
    neutral: 'bg-sunken text-fg-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger'
  };

  const DOT_CLASSES: Record<BadgeTone, string> = {
    neutral: 'bg-fg-subtle',
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger'
  };

  const SIZE_CLASSES: Record<BadgeSize, string> = {
    sm: 'h-5 px-1.5 text-[11px]',
    md: 'h-6 px-2 text-xs'
  };
</script>

<span
  class={[
    'inline-flex max-w-full items-center gap-1.5 rounded-md font-medium whitespace-nowrap',
    TONE_CLASSES[tone],
    SIZE_CLASSES[size],
    truncate ? 'overflow-hidden' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')}
>
  {#if dot}
    <span class={['size-1.5 shrink-0 rounded-full', DOT_CLASSES[tone]].join(' ')}></span>
  {/if}
  <span class={truncate ? 'truncate' : ''}>{@render children()}</span>
</span>
