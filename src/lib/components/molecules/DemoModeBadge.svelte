<script lang="ts">
  /**
   * Demo mode indicator.
   *
   * Renders nothing at all unless `authStore.isDemoMode` is true, so callers can
   * drop it into a layout unconditionally rather than guarding each slot.
   *
   * It is a badge rather than a banner on purpose. A deployment with no
   * Firebase configuration is a legitimate state, not an error, and a full-width
   * strip across a working drive reads as one. A quiet chip in the account band
   * says the same thing, opens the explanation on demand, and leaves the file
   * grid untouched.
   *
   * The dialog names the actual reason the app fell back — missing configuration,
   * a placeholder key, or an unreachable backend — because "Demo Mode" alone
   * sends people looking for a settings page that does not exist.
   */
  import { HardDrive, TriangleAlert } from '@lucide/svelte';
  import { authStore } from '$lib/stores/authStore.svelte';
  import { DEMO_QUOTA_TOTAL_BYTES } from '$lib/services/mockDriveBackend';
  import { formatBytes } from '$lib/utils/formatters';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';

  type Variant = 'chip' | 'full';

  interface Props {
    /** `chip` is a button that opens the dialog; `full` is the expanded row. */
    variant?: Variant;
  }

  let { variant = 'chip' }: Props = $props();

  let open = $state(false);

  /**
   * Why the app is not talking to a real project.
   *
   * `modeReason` is set once at startup and never changes, so this is a lookup
   * rather than a chain of conditionals, and an unknown reason degrades to the
   * generic sentence instead of rendering a blank.
   */
  const reason = $derived.by((): string => {
    switch (authStore.modeReason) {
      case 'missing-config':
        return 'This deployment has no Firebase environment variables set, so there is no project to connect to.';
      case 'placeholder-config':
        return 'This deployment is still carrying the placeholder Firebase credentials from the template.';
      case 'connection-failed':
        return 'The configured Firebase project could not be reached, so the drive fell back to this device.';
      default:
        return 'The app is running against a local drive instead of a Firebase project.';
    }
  });

  /**
   * Where the files actually are.
   *
   * `isDemoPersistent` is the honest answer to "will my files still be here
   * tomorrow": IndexedDB survives a reload but is erased with the browser's
   * site data, and the in-memory fallback survives neither. Saying "stored in
   * your browser" without that distinction is the difference between a useful
   * warning and a promise the app cannot keep.
   */
  const storageSentence = $derived(
    authStore.isDemoPersistent
      ? 'Your files are stored locally in your browser\'s IndexedDB. They survive a reload, but they are erased if you clear this site\'s data, and they are not visible on any other device.'
      : 'Your files are being held in memory for this tab only, because this browser refused persistent storage. They are lost on reload.'
  );
</script>

{#if authStore.isDemoMode}
  {#if variant === 'chip'}
    <button
      type="button"
      class="inline-flex min-h-8 shrink-0 items-center"
      onclick={() => (open = true)}
      aria-haspopup="dialog"
      title="Demo Mode - your files are stored in this browser"
    >
      <Badge tone="warning" size="sm" dot>
        <HardDrive size={12} aria-hidden="true" />
        Demo Mode
      </Badge>
    </button>
  {:else}
    <div class="flex flex-col gap-2">
      <button
        type="button"
        class="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left"
        onclick={() => (open = true)}
        aria-haspopup="dialog"
      >
        <Badge tone="warning" size="md" dot>
          <HardDrive size={14} aria-hidden="true" />
          Demo Mode
        </Badge>
      </button>
      <p class="text-xs text-fg-muted">
        Files are stored in this browser. Quota is capped at {formatBytes(DEMO_QUOTA_TOTAL_BYTES)}.
      </p>
    </div>
  {/if}

  <Modal
    bind:open
    title="Demo Mode"
    description="Cloud Drive is running without a Firebase project."
    size="sm"
  >
    <div class="flex flex-col gap-4 text-sm text-fg-muted">
      <p class="flex gap-2.5">
        <TriangleAlert size={16} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <span>{reason}</span>
      </p>

      <p>{storageSentence}</p>

      <p>
        To enable permanent multi-device sync, configure Firebase credentials in your environment and
        reload. No data is sent anywhere in the meantime.
      </p>

      {#if authStore.modeDetail !== null}
        <p class="rounded-md bg-sunken px-3 py-2 font-mono text-xs break-words text-fg-subtle">
          {authStore.modeDetail}
        </p>
      {/if}
    </div>

    {#snippet footer()}
      <Button variant="secondary" onclick={() => (open = false)}>Close</Button>
    {/snippet}
  </Modal>
{/if}
