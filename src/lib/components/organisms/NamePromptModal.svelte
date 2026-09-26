<script lang="ts">
  /**
   * Create-folder and rename dialog.
   *
   * One component, because the validation is the same job twice: a name has to
   * be legal and within the length limit, and the only difference between the
   * two flows is the heading, the icon and which store method the caller runs
   * afterwards.
   *
   * The check here is *client-side ergonomics*, not enforcement. A sibling can
   * appear between the keystroke and the commit, so the caller's transaction
   * re-checks and the store resolves collisions server-side by appending a
   * counter. This dialog therefore reports an obvious conflict immediately but
   * never promises the name is safe.
   */
  import { FolderPlus, Pencil } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import { NAME_ERROR_MESSAGES, validateItemName } from '$lib/domain/itemNames';
  import { MAX_ITEM_NAME_LENGTH } from '$lib/config/constants';

  interface Props {
    /** Two-way bound visibility. */
    open: boolean;
    /** `create` or `rename`, which changes the heading and the icon. */
    mode: 'create' | 'rename';
    /** Name to prefill, for rename. Ignored when creating. */
    initialName?: string;
    /** Heading override, for callers that name their own destination. */
    title?: string | null;
    /** Body copy override; `null` keeps the default for the mode. */
    description?: string | null;
    /** Normalized names already taken in the destination. */
    takenNames?: readonly string[];
    /** True while the caller's transaction is running. */
    busy?: boolean;
    /** Server-side failure to surface. */
    error?: string | null;
    onclose: () => void;
    /** Resolves with a name the caller considers valid, not necessarily free. */
    onsubmit: (name: string) => void;
  }

  let {
    open = $bindable(),
    mode,
    initialName = '',
    title = null,
    description = null,
    takenNames = [],
    busy = false,
    error = null,
    onclose,
    onsubmit
  }: Props = $props();

  let value = $state('');
  let touched = $state(false);

  /**
   * Seeding has to happen when the dialog opens, not when the component mounts:
   * the modal stays mounted and only toggles `open`, so a second rename would
   * otherwise prefill the first rename's name.
   */
  $effect(() => {
    if (open) {
      value = initialName;
      touched = false;
    }
  });

  const validation = $derived(validateItemName(value));

  /**
   * A name that is already in use by a sibling. Reported separately from the
   * syntactic checks because it is a warning the user can override — the
   * store will resolve it by appending a counter — whereas an illegal name
   * blocks the submit outright.
   */
  const conflicts = $derived(
    validation.valid && takenNames.includes(validation.normalized) ? takenNames.length : 0
  );

  /** The one problem to show, most specific first. */
  const message = $derived.by((): string | null => {
    if (error !== null) return error;
    if (!touched || value.trim().length === 0) return null;
    if (!validation.valid) return NAME_ERROR_MESSAGES[validation.reason];
    if (conflicts > 0) return 'A folder with this name already exists here. A number will be added.';
    return null;
  });

  const canSubmit = $derived(validation.valid && !busy);

  const heading: string = $derived(title ?? (mode === 'create' ? 'New folder' : 'Rename'));
  const body: string | null = $derived(
    description ?? (mode === 'create' ? 'Folders can be nested up to 64 levels deep.' : null)
  );

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    touched = true;
    if (!canSubmit || !validation.valid) return;
    onsubmit(validation.name);
  }

  function reset(): void {
    value = '';
    touched = false;
    onclose();
  }
</script>

<Modal
  bind:open
  title={heading}
  description={body}
  size="sm"
  dismissible={!busy}
  onclose={reset}
>
  <form id="name-prompt-form" onsubmit={submit} novalidate>
    <Input
      bind:value
      label="Folder name"
      name="item-name"
      autocomplete="off"
      spellcheck="false"
      placeholder="Untitled folder"
      error={message}
      hint={`Up to ${MAX_ITEM_NAME_LENGTH} characters`}
      maxlength={MAX_ITEM_NAME_LENGTH}
      disabled={busy}
      autofocus
      oninput={() => {
        touched = true;
      }}
    />
  </form>

  {#snippet footer()}
    <Button variant="secondary" disabled={busy} onclick={reset}>Cancel</Button>
    <Button
      type="submit"
      form="name-prompt-form"
      variant="primary"
      leading={mode === 'create' ? FolderPlus : Pencil}
      loading={busy}
      disabled={!canSubmit}
    >
      {mode === 'create' ? 'Create' : 'Rename'}
    </Button>
  {/snippet}
</Modal>
