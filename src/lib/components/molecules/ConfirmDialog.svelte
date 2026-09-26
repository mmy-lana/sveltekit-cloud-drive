<script lang="ts">
  /**
   * Destructive-action confirmation.
   *
   * Every irreversible action in the app routes through here — permanent
   * deletion, emptying the bin — because the two entry points (the item menu
   * and the batch bar) must not be able to drift into different wording for
   * the same consequence. The dialog states what is about to be lost rather
   * than asking "are you sure?", and it never makes the confirm button the
   * default focus: `Modal` focuses the first focusable element, which is
   * Cancel, so a stray Enter does not destroy anything.
   */
  import type { LucideIcon } from '@lucide/svelte';
  import { AlertTriangle } from '@lucide/svelte';
  import Modal from '../ui/Modal.svelte';
  import Button from '../ui/Button.svelte';

  interface Props {
    /** Two-way bound visibility. */
    open: boolean;
    /** Heading, which should name the action, not the object. */
    title: string;
    /** What happens, stated in terms the user can check against the list. */
    description: string;
    /** Label for the confirm button. Must name the verb, not say "OK". */
    confirmLabel: string;
    /** `danger` is reserved for actions with no undo. */
    tone?: 'danger' | 'primary';
    /** True while the confirmed action is in flight. */
    busy?: boolean;
    /** Replaces the default warning glyph. */
    icon?: LucideIcon;
    onclose: () => void;
    onconfirm: () => void;
  }

  let {
    open = $bindable(),
    title,
    description,
    confirmLabel,
    tone = 'danger',
    busy = false,
    icon,
    onclose,
    onconfirm
  }: Props = $props();

  const Glyph = $derived(icon ?? AlertTriangle);
</script>

<Modal {open} {title} size="sm" dismissible={!busy} {onclose}>
  <div class="flex flex-col gap-4">
    <div class="flex gap-3">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full
               {tone === 'danger' ? 'bg-red-50 text-red-600' : 'bg-accent-soft text-accent'}"
        aria-hidden="true"
      >
        <Glyph size={20} />
      </span>
      <p class="text-sm leading-relaxed text-fg-muted">{description}</p>
    </div>
  </div>

  {#snippet footer()}
    <Button variant="secondary" disabled={busy} onclick={onclose}>Cancel</Button>
    <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onclick={onconfirm}>
      {confirmLabel}
    </Button>
  {/snippet}
</Modal>
