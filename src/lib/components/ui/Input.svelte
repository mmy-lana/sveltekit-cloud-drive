<script lang="ts">
  import { CircleAlert, X } from '@lucide/svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';

  type InputSize = 'sm' | 'md' | 'lg';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'size' | 'class' | 'prefix'> {
    /** Two-way bound field value. */
    value?: string;
    /** Visible label. When omitted, `aria-label` becomes the accessible name. */
    label?: string;
    /** Validation message. Presence switches the field to its error presentation. */
    error?: string | null;
    /** Secondary guidance rendered under the field, hidden while `error` is set. */
    hint?: string | null;
    size?: InputSize;
    /** Shows a trailing clear affordance whenever the field is non-empty. */
    clearable?: boolean;
    /** Icon rendered inside the field, before the text. */
    prefix?: LucideIcon;
    /** Icon rendered inside the field, after the text. */
    suffix?: LucideIcon;
    /** Accessible name for the clear button. */
    clearLabel?: string;
    class?: string;
  }

  let {
    value = $bindable(''),
    label,
    error = null,
    hint = null,
    size = 'md',
    clearable = false,
    disabled = false,
    prefix,
    suffix,
    clearLabel = 'Clear input',
    id,
    name,
    required = false,
    placeholder,
    type = 'text',
    class: className,
    ...rest
  }: Props = $props();

  const generatedId = $props.id();
  const fieldId = $derived(id ?? `input-${generatedId}`);
  const errorId = $derived(`${fieldId}-error`);
  const hintId = $derived(`${fieldId}-hint`);

  const hasError = $derived(error !== null && error !== '');
  const showClear = $derived(clearable && value.length > 0 && !disabled);
  const describedBy = $derived(
    hasError ? errorId : hint !== null && hint !== '' ? hintId : undefined
  );

  const SIZE_CLASSES: Record<InputSize, string> = {
    sm: 'h-9 text-sm',
    md: 'h-11 text-sm',
    lg: 'h-12 text-base'
  };

  function handleClear(): void {
    value = '';
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (showClear && event.key === 'Escape' && value.length > 0) {
      event.stopPropagation();
      handleClear();
    }
  }

  const PrefixIcon = $derived(prefix);
  const SuffixIcon = $derived(suffix);
</script>

<div class="flex w-full flex-col gap-1.5">
  {#if label}
    <label for={fieldId} class="text-sm font-medium text-fg">
      {label}
      {#if required}
        <span class="text-danger" aria-hidden="true">*</span>
      {/if}
    </label>
  {/if}

  <div
    class={[
      'flex items-center gap-2 rounded-lg border bg-surface transition-colors',
      'focus-within:border-accent',
      SIZE_CLASSES[size],
      hasError ? 'border-danger' : 'border-line-strong',
      disabled ? 'cursor-not-allowed bg-sunken opacity-60' : '',
      className ?? ''
    ]
      .filter(Boolean)
      .join(' ')}
  >
    {#if PrefixIcon}
      <span class="flex shrink-0 items-center pl-3 text-fg-subtle" aria-hidden="true">
        <PrefixIcon size={size === 'lg' ? 20 : 18} />
      </span>
    {/if}

    <input
      {...rest}
      {id}
      {name}
      {type}
      {placeholder}
      {required}
      {disabled}
      bind:value
      aria-invalid={hasError || undefined}
      aria-describedby={describedBy}
      aria-label={label ? undefined : (rest['aria-label'] ?? undefined)}
      onkeydown={handleKeydown}
      class="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed"
      class:pl-3={!prefix}
      class:pr-3={!showClear && !suffix}
    />

    {#if SuffixIcon}
      <span class="flex shrink-0 items-center text-fg-subtle" aria-hidden="true">
        <SuffixIcon size={size === 'lg' ? 20 : 18} />
      </span>
    {/if}

    {#if showClear}
      <button
        type="button"
        {disabled}
        aria-label={clearLabel}
        title={clearLabel}
        onclick={handleClear}
        class="mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg"
      >
        <X size={16} aria-hidden="true" />
      </button>
    {/if}
  </div>

  {#if hasError}
    <p id={errorId} class="flex items-center gap-1.5 text-sm text-danger">
      <CircleAlert size={14} class="shrink-0" aria-hidden="true" />
      {error}
    </p>
  {:else if hint !== null && hint !== ''}
    <p id={hintId} class="text-sm text-fg-muted">{hint}</p>
  {/if}
</div>
