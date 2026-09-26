<script lang="ts">
  /**
   * New-folder dialog.
   *
   * A thin, folder-specific wrapper over `NamePromptModal` rather than a second
   * implementation: the validation, the focus trap, the busy state and the
   * error surface are all the same problem in both cases, and duplicating them
   * would guarantee the two drift. What genuinely differs is the copy, the
   * icon, and the fact that a folder name is never *promised* to be unique —
   * the store resolves a collision transactionally and the resolved name comes
   * back through `onsubmit`.
   */
  import NamePromptModal from './NamePromptModal.svelte';

  interface Props {
    /** Two-way bound visibility. */
    open: boolean;
    /** True while the create transaction is in flight. */
    busy?: boolean;
    /** Normalized names already taken in the destination folder. */
    takenNames?: readonly string[];
    /** Server-side failure to surface. */
    error?: string | null;
    /** Label for the destination, e.g. "Documents". `null` means the root. */
    destinationLabel?: string | null;
    onclose: () => void;
    onsubmit: (name: string) => void;
  }

  let {
    open = $bindable(),
    busy = false,
    takenNames = [],
    error = null,
    destinationLabel = null,
    onclose,
    onsubmit
  }: Props = $props();

  // Derived rather than computed once: the dialog is reused across scopes, and
  // a captured `destinationLabel` would leave it naming the folder the user
  // opened it from.
  const heading: string = $derived(
    destinationLabel === null ? 'New folder' : `New folder in ${destinationLabel}`
  );

  const description: string = $derived(
    destinationLabel === null
      ? 'Folders can be renamed, moved and starred like any other item.'
      : `This folder will be created inside ${destinationLabel}, and can be nested up to 64 levels deep.`
  );
</script>

<NamePromptModal
  bind:open
  mode="create"
  title={heading}
  {description}
  {busy}
  {takenNames}
  {error}
  {onclose}
  {onsubmit}
/>
