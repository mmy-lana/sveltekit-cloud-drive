<script lang="ts">
  import { Check, Minus } from '@lucide/svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';

  type CheckboxSize = 'sm' | 'md' | 'lg';

  // `size` on the native element is a character width; here it is a visual
  // scale, so the inherited attribute is dropped first.
  interface Props extends Omit<HTMLInputAttributes, 'type' | 'checked' | 'class' | 'size'> {
    /** Two-way bound checked state. */
    checked?: boolean;
    /**
     * Third, "mixed" state used by batch selection when only some visible rows
     * are selected. Rendered with a dash and announced as `mixed`.
     */
    indeterminate?: boolean;
    /** Visible label text. When omitted, `aria-label` must be supplied. */
    label?: string;
    /** Hides the label visually while keeping it as the accessible name. */
    hideLabel?: boolean;
    size?: CheckboxSize;
    /** Mirrors the checked state for the whole row, not just the box. */
    highlightRow?: boolean;
    class?: string;
  }

  let {
    checked = $bindable(false),
    indeterminate = false,
    label,
    hideLabel = false,
    size = 'md',
    disabled = false,
    highlightRow = false,
    id,
    name,
    value,
    class: className,
    ...rest
  }: Props = $props();

  const generatedId = $props.id();
  const fieldId = $derived(id ?? `checkbox-${generatedId}`);

  const SIZE_CLASSES: Record<CheckboxSize, { box: string; icon: number }> = {
    sm: { box: 'size-4 rounded-[4px]', icon: 11 },
    md: { box: 'size-5 rounded-[5px]', icon: 14 },
    lg: { box: 'size-6 rounded-md', icon: 16 }
  };

  const boxSize = $derived(SIZE_CLASSES[size]);
  const isVisuallyChecked = $derived(checked || indeterminate);
</script>

<label
  for={fieldId}
  class={[
    'group inline-flex select-none items-center gap-2.5',
    disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')}
>
  <!--
    The visible box is 16-24px, which is a drawing, not a target: the input is
    stretched over this wrapper, so the wrapper's box is the real hit area.
    `tap-target-compact` raises it to 44x44 below 768px, where the label is
    often the only way to select a row and the surface scrolls under the finger.
  -->
  <span class="relative inline-flex shrink-0 items-center justify-center tap-target-compact">
    <input
      {...rest}
      {id}
      {name}
      {value}
      {disabled}
      type="checkbox"
      bind:checked
      aria-checked={indeterminate ? 'mixed' : checked}
      class="peer absolute inset-0 size-full cursor-inherit appearance-none rounded-[inherit] opacity-0 disabled:cursor-not-allowed"
    />
    <span
      aria-hidden="true"
      class={[
        'flex items-center justify-center border transition-colors',
        'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
        boxSize.box,
        isVisuallyChecked ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface',
        highlightRow && isVisuallyChecked ? 'border-accent' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {#if indeterminate}
        <Minus size={boxSize.icon} strokeWidth={3} />
      {:else if checked}
        <Check size={boxSize.icon} strokeWidth={3} />
      {/if}
    </span>
  </span>

  {#if label}
    <span
      class={[
        'text-sm leading-tight group-hover:text-fg',
        isVisuallyChecked ? 'text-fg' : 'text-fg-muted',
        hideLabel ? 'visually-hidden' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {label}
    </span>
  {/if}
</label>
