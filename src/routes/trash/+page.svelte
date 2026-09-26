<script lang="ts">
  /**
   * Trash.
   *
   * The one scope that is not a place. Nothing can be created here and a
   * folder cannot be opened until it is restored, so the listing's own empty
   * states and the item menu already enforce that; this route only has to hand
   * the store the scope and say so in the document title.
   */
  import { onMount } from 'svelte';
  import DriveView from '$lib/components/organisms/DriveView.svelte';
  import { driveStore } from '$lib/stores/driveStore.svelte';
  import { shellStore } from '$lib/stores/shellStore.svelte';
  import { goto } from '$app/navigation';

  const scope = { kind: 'trash' } as const;

  onMount(() => {
    driveStore.openScope(scope);
  });

  /**
   * Neither action applies in the bin, but the empty state still offers a way
   * out. Both point at My Drive rather than doing nothing.
   */
  function toMyDrive(): void {
    void goto('/');
  }
</script>

<svelte:head>
  <title>Trash · Cloud Drive</title>
  <meta name="description" content="Items you have trashed, until you delete them for good." />
</svelte:head>

<DriveView {scope} onRequestUpload={toMyDrive} onCreateFolder={toMyDrive} />
