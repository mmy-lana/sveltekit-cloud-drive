<script lang="ts">
  import type { LucideIcon } from '@lucide/svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type IconButtonVariant = 'ghost' | 'surface' | 'danger' | 'accent';
  type IconButtonSize = 'sm' | 'md' | 'lg';

  interface Props extends Omit<HTMLButtonAttributes, 'children' | 'aria-label'> {
    /**
     * Required. An icon-only control has no visible text, so this is the only
     * thing that gives it an accessible name — it is enforced at the type level.
     */
    label: string;
    variant?: IconButtonVariant;
    size?: IconButtonSize;
    loading?: boolean;
    /** Renders the glyph toward one edge, for aligning a row of toolbar icons. */
    align?: 'center' | 'start' | 'end';
    /** Icon glyph. */
    icon: LucideIcon;
  }

  let {
    label,
    variant = 'ghost',
    size = 'md',
    loading = false,
    align = 'center',
    disabled = false,
    type = 'button',
    class: className,
    icon,
    ...rest
  }: Props = $props();

  const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
    ghost: 'bg-transparent text-fg-muted hover:bg-hover hover:text-fg',
    surface: 'bg-surface text-fg-muted border border-line-strong hover:bg-hover hover:text-fg',
    danger: 'bg-transparent text-danger hover:bg-danger-soft',
    accent: 'bg-accent-soft text-accent hover:bg-accent hover:text-accent-fg'
  };

  /**
   * `sm` keeps a 36px visual footprint for dense toolbars while `md`/`lg` hold
   * the full 44px touch minimum; all sizes remain pointer-sized.
   */
  const SIZE_CLASSES: Record<IconButtonSize, string> = {
    sm: 'h-9 w-9 rounded-md',
    md: 'tap-target rounded-lg',
    lg: 'tap-target rounded-xl'
  };

  const ALIGN_CLASSES: Record<NonNullable<Props['align']>, string> = {
    center: 'justify-center',
    start: 'justify-start',
    end: 'justify-end'
  };

  const ICON_SIZE = $derived(size === 'sm' ? 18 : size === 'lg' ? 24 : 20);

  const Icon = $derived(icon);
</script>

<button
  {...rest}
  {type}
  {disabled}
  aria-label={label}
  title={rest.title ?? label}
  aria-busy={loading || undefined}
  class={[
    'inline-flex shrink-0 items-center p-0 select-none',
    'disabled:cursor-not-allowed disabled:opacity-55',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    ALIGN_CLASSES[align],
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')}
>
  <span class="inline-flex" data-icon-size={ICON_SIZE}>
    <Icon size={ICON_SIZE} aria-hidden="true" />
  </span>
</button>
