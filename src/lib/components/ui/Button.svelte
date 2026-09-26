<script lang="ts">
  import { LoaderCircle } from '@lucide/svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
  type ButtonSize = 'sm' | 'md' | 'lg';

  interface Props extends Omit<HTMLButtonAttributes, 'children'> {
    /** Visual weight. `primary` is reserved for the single main action on screen. */
    variant?: ButtonVariant;
    /** Control height. `sm` still clears 36px for pointer-dense toolbars. */
    size?: ButtonSize;
    /** Swaps the label for a spinner and blocks interaction. */
    loading?: boolean;
    /** Announced and displayed while `loading` is true. */
    loadingLabel?: string;
    /** Stretches the button to its container's width. */
    fullWidth?: boolean;
    /** Renders before the label, typically an icon. Hidden while loading. */
    leading?: LucideIcon;
    /** Renders after the label. Hidden while loading. */
    trailing?: LucideIcon;
    children: Snippet;
  }

  let {
    variant = 'primary',
    size = 'md',
    loading = false,
    loadingLabel,
    fullWidth = false,
    leading,
    trailing,
    disabled = false,
    type = 'button',
    class: className,
    children,
    ...rest
  }: Props = $props();

  const VARIANT_CLASSES: Record<ButtonVariant, string> = {
    primary:
      'bg-accent text-accent-fg hover:bg-accent-hover disabled:hover:bg-accent shadow-raised',
    secondary:
      'bg-surface text-fg border border-line-strong hover:bg-hover disabled:hover:bg-surface',
    ghost: 'bg-transparent text-fg-muted hover:bg-hover hover:text-fg disabled:hover:bg-transparent',
    danger: 'bg-danger text-white hover:bg-danger-hover disabled:hover:bg-danger shadow-raised'
  };

  const SIZE_CLASSES: Record<ButtonSize, string> = {
    sm: 'h-9 gap-1.5 px-3 text-sm',
    md: 'h-11 gap-2 px-4 text-sm',
    lg: 'h-12 gap-2 px-5 text-base'
  };

  const accessibleLabel = $derived(loading ? (loadingLabel ?? 'Working…') : undefined);
  const ICON_SIZE = $derived(size === 'lg' ? 20 : 18);

  const LeadingIcon = $derived(leading);
  const TrailingIcon = $derived(trailing);
</script>

<button
  {...rest}
  {type}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
  aria-label={rest['aria-label'] ?? accessibleLabel}
  class={[
    'inline-flex shrink-0 items-center justify-center rounded-lg font-medium select-none',
    'disabled:cursor-not-allowed disabled:opacity-55',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth ? 'w-full' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')}
>
  {#if loading}
    <LoaderCircle size={ICON_SIZE} class="animate-spin" aria-hidden="true" />
  {:else if LeadingIcon}
    <LeadingIcon size={ICON_SIZE} aria-hidden="true" />
  {/if}

  <span class="truncate">
    {#if loading && loadingLabel}
      {loadingLabel}
    {:else}
      {@render children()}
    {/if}
  </span>

  {#if !loading && TrailingIcon}
    <TrailingIcon size={ICON_SIZE} aria-hidden="true" />
  {/if}
</button>
