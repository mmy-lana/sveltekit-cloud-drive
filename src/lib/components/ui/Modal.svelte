<script lang="ts">
  import { X } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import IconButton from './IconButton.svelte';

  type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

  interface Props {
    /** Two-way bound visibility. Closing sets this to `false`. */
    open?: boolean;
    /** Heading text. Required so the dialog is never unlabelled. */
    title: string;
    /** Optional supporting copy rendered under the title. */
    description?: string | null;
    size?: ModalSize;
    /** Disables ESC and backdrop dismissal for destructive, in-flight work. */
    dismissible?: boolean;
    /** Hides the header close affordance; the consumer supplies its own. */
    hideCloseButton?: boolean;
    /** Invoked after the modal has closed and focus has been restored. */
    onclose?: () => void;
    /** Body content. */
    children: Snippet;
    /** Footer actions, pinned below the scrollable body. */
    footer?: Snippet;
  }

  let {
    open = $bindable(false),
    title,
    description = null,
    size = 'md',
    dismissible = true,
    hideCloseButton = false,
    onclose,
    children,
    footer
  }: Props = $props();

  const generatedId = $props.id();
  const titleId = `modal-title-${generatedId}`;
  const descriptionId = `modal-description-${generatedId}`;

  let dialogElement = $state<HTMLDialogElement | null>(null);
  /** Element focused before opening, so focus can be handed back on close. */
  let previouslyFocused = $state<HTMLElement | null>(null);

  const SIZE_CLASSES: Record<ModalSize, string> = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-[min(96vw,72rem)] h-[min(92dvh,72rem)]'
  };

  function requestClose(): void {
    if (!dismissible) return;
    open = false;
  }

  function handleCancel(event: Event): void {
    // Prevent the native dialog from closing on its own, so that the
    // `dismissible` contract is enforced in one place.
    event.preventDefault();
    requestClose();
  }

  function handleBackdropClick(event: MouseEvent): void {
    // Only a click on the dialog element itself lands on the backdrop, because
    // the panel is a child and stops propagation by construction.
    if (event.target === dialogElement) {
      requestClose();
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === 'Escape' && dismissible) {
      event.preventDefault();
      requestClose();
    }
  }

  // `showModal()` gives a real top-layer element with a genuine focus trap, a
  // modal inertness boundary and correct scroll locking for free.
  $effect(() => {
    const element = dialogElement;
    if (!element) return;

    if (open && !element.open) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  });

  // `onclose` fires on the open -> closed edge only, not on mount while closed.
  let wasOpen = $state(false);
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      return;
    }
    if (!open && wasOpen) {
      wasOpen = false;
      onclose?.();
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<dialog
  bind:this={dialogElement}
  aria-labelledby={titleId}
  aria-describedby={description ? descriptionId : undefined}
  oncancel={handleCancel}
  onclick={handleBackdropClick}
  class={[
    'w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] rounded-card border border-line bg-surface p-0 text-fg shadow-overlay',
    'backdrop:bg-black/50 backdrop:backdrop-blur-[2px]',
    'open:animate-scale-in',
    'm-auto',
    SIZE_CLASSES[size]
  ]
    .filter(Boolean)
    .join(' ')}
  onclose={() => {
    open = false;
    previouslyFocused?.focus();
    previouslyFocused = null;
  }}
>
  <div class="flex max-h-[inherit] flex-col overflow-hidden rounded-card">
    <header class="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 id={titleId} class="text-balance text-base font-semibold text-fg">{title}</h2>
        {#if description}
          <p id={descriptionId} class="text-sm text-fg-muted">{description}</p>
        {/if}
      </div>

      {#if !hideCloseButton}
        <IconButton label="Close dialog" size="sm" onclick={requestClose} icon={X} />
      {/if}
    </header>

    <div class="scrollbar-slim min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
      {@render children()}
    </div>

    {#if footer}
      <footer
        class="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3"
      >
        {@render footer()}
      </footer>
    {/if}
  </div>
</dialog>
