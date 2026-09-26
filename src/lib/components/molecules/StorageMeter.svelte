<script lang="ts">
  /**
   * Storage gauge.
   *
   * The bar is stacked rather than single-valued: committed bytes and in-flight
   * reservations are drawn separately, so an upload currently holding space is
   * visible as "not yet mine" instead of silently inflating the used figure.
   */
  import { HardDrive, TriangleAlert } from '@lucide/svelte';
  import { getQuotaUsage, formatBytes, type QuotaUsage } from '$lib/utils/formatters';
  import type { StorageQuota } from '$lib/types/drive';

  type MeterVariant = 'compact' | 'detailed';

  interface Props {
    quota: StorageQuota;
    variant?: MeterVariant;
    /** Hides the bar and renders the summary text only. */
    textOnly?: boolean;
    /** Overrides the computed severity, e.g. to force the critical styling. */
    severity?: 'ok' | 'warning' | 'critical';
    class?: string;
  }

  let { quota, variant = 'compact', textOnly = false, severity, class: className }: Props = $props();

  const usage = $derived<QuotaUsage>(getQuotaUsage(quota));
  const level = $derived(severity ?? usage.severity);
  const isUnprovisioned = $derived(usage.totalBytes === 0);

  const FILL_CLASSES = $derived(
    level === 'critical' ? 'bg-danger' : level === 'warning' ? 'bg-warning' : 'bg-accent'
  );

  const warningMessage = $derived.by(() => {
    if (level === 'critical') {
      return `Storage is almost full — ${formatBytes(usage.availableBytes, { decimals: 1 })} left.`;
    }
    if (level === 'warning') {
      return `Storage is filling up — ${formatBytes(usage.availableBytes, { decimals: 1 })} left.`;
    }
    return null;
  });

  const usedPercent = $derived(Math.round(usage.usedRatio * 100));
  const reservedPercent = $derived(Math.round(usage.reservedRatio * 100));
</script>

<div class={['flex w-full flex-col gap-2', className ?? ''].filter(Boolean).join(' ')}>
  <div class="flex items-baseline justify-between gap-2">
    <span class="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
      <HardDrive size={14} aria-hidden="true" />
      Storage
    </span>

    <span class="truncate text-xs text-fg-muted tabular-nums">
      {#if isUnprovisioned}
        Not provisioned
      {:else}
        <span class="font-medium text-fg">{formatBytes(usage.usedBytes, { decimals: 1 })}</span> of
        {formatBytes(usage.totalBytes, { decimals: 0 })} used
      {/if}
    </span>
  </div>

  {#if !textOnly && !isUnprovisioned}
    <div
      class={['flex w-full overflow-hidden rounded-full bg-sunken', variant === 'detailed' ? 'h-2.5' : 'h-2']}
      role="img"
      aria-label="Storage: {usedPercent}% used{usage.reservedBytes > 0
        ? `, ${reservedPercent}% reserved by uploads in progress`
        : ''}, {formatBytes(usage.availableBytes, { decimals: 1 })} available"
    >
      <div
        class={['h-full transition-[width] duration-300 ease-out', FILL_CLASSES]}
        style:width="{usedPercent}%"
      ></div>
      {#if reservedPercent > 0}
        <!-- Hatched so a reservation is distinguishable without relying on hue. -->
        <div
          class="h-full border-l border-canvas/60 bg-[repeating-linear-gradient(45deg,var(--border-strong)_0_3px,transparent_3px_6px)] transition-[width] duration-300 ease-out"
          style:width="{reservedPercent}%"
        ></div>
      {/if}
    </div>
  {/if}

  {#if variant === 'detailed' && !isUnprovisioned}
    <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      <div class="flex items-center justify-between gap-2">
        <dt class="text-fg-muted">Used</dt>
        <dd class="font-medium text-fg tabular-nums">{formatBytes(usage.usedBytes, { decimals: 1 })}</dd>
      </div>
      <div class="flex items-center justify-between gap-2">
        <dt class="text-fg-muted">Available</dt>
        <dd class="font-medium text-fg tabular-nums">
          {formatBytes(usage.availableBytes, { decimals: 1 })}
        </dd>
      </div>
      {#if usage.reservedBytes > 0}
        <div class="col-span-2 flex items-center justify-between gap-2">
          <dt class="text-fg-muted">Reserved by active uploads</dt>
          <dd class="font-medium text-fg tabular-nums">
            {formatBytes(usage.reservedBytes, { decimals: 1 })}
          </dd>
        </div>
      {/if}
    </dl>
  {/if}

  {#if warningMessage !== null}
    <p
      class={[
        'flex items-start gap-1.5 text-xs',
        level === 'critical' ? 'text-danger' : 'text-warning'
      ].join(' ')}
    >
      <TriangleAlert size={13} class="mt-px shrink-0" aria-hidden="true" />
      {warningMessage}
    </p>
  {/if}
</div>
