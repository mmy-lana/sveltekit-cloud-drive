<script lang="ts">
  /**
   * A folder.
   *
   * The id has already been validated by `+page.ts`, so this component can hand
   * it to the store without re-checking. The scope is set on mount because the
   * store cannot subscribe during SSR, and re-entering this route from a
   * sibling re-runs the effect — which is what makes it a real scope change
   * rather than a stale listing.
   */
  import { onMount } from 'svelte';
  import DriveView from '$lib/components/organisms/DriveView.svelte';
  import { driveStore } from '$lib/stores/driveStore.svelte';
  import { shellStore } from '$lib/stores/shellStore.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const scope = $derived({ kind: 'folder' as const, folderId: data.folderId });

  onMount(() => {
    driveStore.openScope(scope);
  });
</script>

<svelte:head>
  <title>Folder · Cloud Drive</title>
</svelte:head>

<DriveView
  {scope}
  onRequestUpload={shellStore.openUploadPicker}
  onCreateFolder={shellStore.openCreateFolderDialog}
/>
