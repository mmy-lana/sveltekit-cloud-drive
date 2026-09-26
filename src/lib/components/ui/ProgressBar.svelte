<script lang="ts">
  import { clamp } from '$lib/utils/formatters';

  type ProgressVariant = 'accent' | 'success' | 'warning' | 'danger';
  type ProgressSize = 'sm' | 'md' | 'lg';

  interface Props {
    /** Current value in the same unit as `max`. */
    value: number;
    max?: number;
    /** Accessible name. Required, because the bar itself carries no text. */
    label: string;
    /** Renders the numeric percentage at the end of the label row. */
    showValue?: boolean;
    /** Renders the label above the bar instead of hiding it. */
    showLabel?: boolean;
    variant?: ProgressVariant;
    size?: ProgressSize;
    /**
     * Animates the bar without a determinate position. Used for uploads whose
     * total byte count is not yet known.
     */
    indeterminate?: boolean;
    /** Optional secondary text under the label, e.g. "1.2 MB of 5 MB". */
    detail?: string | null;
    /** Overrides the announced value, e.g. to avoid announcing "0%" repeatedly. */
    valueText?: string | null;
    class?: string;
  }

  let {
    value,
    max = 100,
    label,
    showValue = false,
    showLabel = false,
    variant = 'accent',
    size = 'md',
    indeterminate = false,
    detail = null,
    valueText = null,
    class: className
  }: Props = $props();

  const generatedId = $props.id();
  const barId = `progress-${generatedId}`;
  const labelId = `${barId}-label`;

  const percentage = $derived(max > 0 ? clamp((value / max) * 100, 0, 100) : 0);
  const roundedPercentage = $derived(Math.round(percentage));
  const roundedValue = $derived(Number.isFinite(value) ? Math.round(value * 10) / 10 : 0);

  const TRACK_CLASSES: Record<ProgressSize, string> = {
    sm: 'h-1.5',
    md: 'h-2',
    lg: 'h-2.5'
  };

  const FILL_CLASSES: Record<ProgressVariant, string> = {
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger'
  };
</script>

<div class={['flex w-full flex-col gap-1.5', className ?? ''].filter(Boolean).join(' ')}>
  {#if showLabel || showValue || detail !== null}
    <div class="flex items-baseline justify-between gap-3">
      {#if showLabel}
        <span id={labelId} class="truncate text-sm font-medium text-fg">{label}</span>
      {:else}
        <span id={labelId} class="visually-hidden">{label}</span>
      {/if}

      {#if showValue && !indeterminate}
        <span class="shrink-0 text-xs font-medium text-fg-muted tabular-nums"
          >{roundedPercentage}%</span
        >
      {/if}
    </div>
  {:else}
    <span id={labelId} class="visually-hidden">{label}</span>
  {/if}

  <div
    id={barId}
    role="progressbar"
    aria-labelledby={labelId}
    aria-valuemin={0}
    aria-valuemax={indeterminate ? undefined : max}
    aria-valuenow={indeterminate ? undefined : roundedValue}
    aria-valuetext={indeterminate ? 'In progress' : (valueText ?? `${roundedPercentage}%`)}
    class={[
      'w-full overflow-hidden rounded-full bg-sunken',
      TRACK_CLASSES[size],
      indeterminate ? 'animate-pulse' : ''
    ]
      .filter(Boolean)
      .join(' ')}
  >
    {#if indeterminate}
      <div class="h-full w-1/3 rounded-full bg-accent"></div>
    {:else}
      <div
        class={['h-full rounded-full transition-[width] duration-200 ease-out', FILL_CLASSES[variant]]
          .filter(Boolean)
          .join(' ')}
        style:width="{percentage}%"
      ></div>
    {/if}
  </div>

  {#if detail !== null && detail !== ''}
    <p class="text-xs text-fg-muted">{detail}</p>
  {/if}
</div>
