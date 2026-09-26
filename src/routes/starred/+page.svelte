<script lang="ts">
  /**
   * Starred.
   *
   * A cross-cutting view, not a folder: the query is filtered by
   * `isStarred` across the whole account, so the breadcrumb trail is
   * meaningless here and the store collapses it to a single crumb.
   *
   * Uploading is deliberately not offered. A file uploaded from this view has
   * no folder to land in, and the store's upload target is the current scope —
   * so the create and upload affordances are pointed at My Drive instead of
   * being disabled with an explanation the user has to interpret.
   */
  import { onMount } from 'svelte';
  import DriveView from '$lib/components/organisms/DriveView.svelte';
  import { driveStore } from '$lib/stores/driveStore.svelte';
  import { goto } from '$app/navigation';

  const scope = { kind: 'starred' } as const;

  onMount(() => {
    driveStore.openScope(scope);
  });

  function toMyDrive(): void {
    void goto('/');
  }
</script>

<svelte:head>
  <title>Starred · Cloud Drive</title>
  <meta name="description" content="Everything you have starred, from anywhere in your drive." />
</svelte:head>

<DriveView
  {scope}
  onRequestUpload={toMyDrive}
  onCreateFolder={toMyDrive}
/>
