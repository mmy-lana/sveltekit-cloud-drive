<script lang="ts">
  /**
   * My Drive, at the root.
   *
   * A route is a scope and a title, nothing more: the listing, the selection
   * model and every mutation live in `DriveView` and the stores, so a new route
   * cannot diverge from the others.
   *
   * The scope is handed to the store on mount rather than at module scope,
   * because this also renders on the server where the store has no uid to
   * subscribe with. Re-entering the route by client-side navigation re-runs
   * the effect, which is what makes "back to the root from a folder" a real
   * scope change rather than a no-op.
   */
  import { onMount } from 'svelte';
  import DriveView from '$lib/components/organisms/DriveView.svelte';
  import { driveStore } from '$lib/stores/driveStore.svelte';
  import { shellStore } from '$lib/stores/shellStore.svelte';

  onMount(() => {
    driveStore.openScope({ kind: 'folder', folderId: null });
  });
</script>

<svelte:head>
  <title>My Drive · Cloud Drive</title>
  <meta name="description" content="Browse, upload and organise the files and folders in your drive." />
</svelte:head>

<DriveView
  scope={{ kind: 'folder', folderId: null }}
  onRequestUpload={shellStore.openUploadPicker}
  onCreateFolder={shellStore.openCreateFolderDialog}
/>
