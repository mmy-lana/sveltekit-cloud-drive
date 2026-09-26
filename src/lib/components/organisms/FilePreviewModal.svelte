<script lang="ts">
  /**
   * File preview.
   *
   * The download URL is minted on open with `getDownloadURL` and then held for
   * the life of the dialog, rather than being stored on the document. Two
   * reasons: a token in Firestore goes stale and would have to be re-minted on
   * every view anyway, and a file's bytes can change under a document that
   * still points at the same path.
   *
   * What can be shown depends entirely on the type. An image, a PDF, a video or
   * an audio file renders inline; text is fetched and typeset; anything else —
   * an archive, a binary, a format with no browser decoder — gets an explicit
   * "cannot preview" panel with a download button, not a blank frame. The
   * distinction is drawn from the MIME type with an extension fallback, so a
   * file the browser reported as `application/octet-stream` still previews when
   * its extension gives the type away.
   */
  import {
    Download,
    FileText,
    LoaderCircle,
    Music,
    TriangleAlert,
    ZoomIn,
    ZoomOut
  } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/ui/Modal.svelte';
  import FileIcon from '$lib/components/molecules/FileIcon.svelte';
  import { getDownloadURL, ref as storageRef } from 'firebase/storage';
  import { getStorageClient } from '$lib/firebase/client';
  import { classifyError } from '$lib/firebase/errors';
  import { getMimeCategory, resolveMimeType } from '$lib/utils/mimetypes';
  import { formatBytes, formatDateTime } from '$lib/utils/formatters';
  import type { DriveFile } from '$lib/types/drive';

  interface Props {
    /** Two-way bound visibility. */
    open: boolean;
    /** The file being previewed, or `null` while nothing is selected. */
    file: DriveFile | null;
    onclose: () => void;
  }

  let { open = $bindable(), file, onclose }: Props = $props();

  /** MIME types that render inline without a fetch. */
  type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'unsupported';

  const kind = $derived<PreviewKind>(classify(file));
  const displayName = $derived(file?.name ?? '');
  const effectiveType = $derived(file === null ? '' : resolveMimeType({ name: file.name, type: file.mimeType }));
  const category = $derived(file === null ? 'binary' : getMimeCategory(effectiveType, file.name));

  /** The token URL, minted once per open. */
/** Characters of a text file rendered inline before it is truncated. */
const TEXT_LIMIT = 200_000;

  let downloadUrl = $state<string | null>(null);
  /** Text body, for the `text` kind only. */
  let textBody = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  /** Image zoom, as a multiplier clamped to a sane band. */
  let zoom = $state(1);
  /** How much text to render; longer files are truncated with an explicit note. */
  let textLimit = $state(TEXT_LIMIT);

  /**
   * Decide how to render a file.
   *
   * `text/plain` is included in `text` before `image` because a `.svg` arrives
   * as `image/svg+xml`, which a browser will happily execute as script. Serving
   * it through a text panel instead keeps the preview from becoming an injection
   * surface for a file the user merely uploaded.
   */
  function classify(target: DriveFile | null): PreviewKind {
    if (target === null) return 'unsupported';
    if (target.uploadStatus !== 'committed') return 'unsupported';

    const type = resolveMimeType({ name: target.name, type: target.mimeType }).toLowerCase();

    if (type === 'image/svg+xml') return 'text';
    if (type.startsWith('image/')) return 'image';
    if (type === 'application/pdf') return 'pdf';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml') {
      return 'text';
    }
    return 'unsupported';
  }

  /**
   * Why an uncommitted file cannot be shown.
   *
   * A `reserved` or `failed` upload has no bytes to serve, and saying "unsupported
   * format" for a file that is simply not finished would be a lie.
   */
  const unavailableReason = $derived.by((): string | null => {
    if (file === null) return null;
    if (file.uploadStatus === 'committed') return null;
    if (file.uploadStatus === 'failed') return 'This upload failed, so there is nothing to preview.';
    if (file.uploadStatus === 'deletion-pending') return 'This file is being deleted.';
    return 'This file is still uploading.';
  });

  $effect(() => {
    if (!open || file === null) {
      downloadUrl = null;
      textBody = null;
      loadError = null;
      loading = false;
      return;
    }

    const target = file;
    let cancelled = false;

    downloadUrl = null;
    textBody = null;
    loadError = null;
    zoom = 1;

    if (target.storagePath === null || target.uploadStatus !== 'committed') {
      loading = false;
      return;
    }

    loading = true;

    void (async () => {
      try {
        const url = await getDownloadURL(storageRef(getStorageClient(), target.storagePath as string));
        if (cancelled) return;
        downloadUrl = url;

        if (classify(target) === 'text') {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
          const body = await response.text();
          if (cancelled) return;
          textLimit = Math.min(body.length, TEXT_LIMIT);
          textBody = body;
        }
      } catch (error) {
        if (cancelled) return;
        loadError = classifyError(error).message;
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  /** The subtitle line: size and last-modified, whichever are known. */
  function fileSummary(target: DriveFile | null): string | null {
    if (target === null) return null;

    const parts: string[] = [];
    if (target.sizeBytes > 0) parts.push(formatBytes(target.sizeBytes));

    const modifiedAt = formatDateTime(target.updatedAt);
    if (modifiedAt !== null) parts.push(modifiedAt);

    return parts.length === 0 ? null : parts.join(' · ');
  }

  function adjustZoom(delta: number): void {
    zoom = Math.min(4, Math.max(0.25, Math.round((zoom + delta) * 4) / 4));
  }

  /** True when the text was cut and the full file should be downloaded instead. */
  const textTruncated = $derived(textBody !== null && textBody.length > textLimit);
</script>

<Modal
  bind:open
  title={displayName || 'Preview'}
  description={fileSummary(file)}
  size="xl"
  onclose={onclose}
>
  <div class="flex min-h-64 flex-col gap-3">
    {#if file === null}
      <p class="py-16 text-center text-sm text-gray-500">Nothing to preview.</p>
    {:else if unavailableReason !== null}
      <div class="flex flex-col items-center gap-3 py-12 text-center">
        <FileIcon name={file.name} type="file" mimeType={effectiveType} showBadge size="xl" />
        <p class="max-w-sm text-sm text-gray-600 dark:text-gray-300">{unavailableReason}</p>
        {#if downloadUrl !== null}
          <a
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 text-sm
                   font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200
                   dark:hover:bg-gray-800"
            href={downloadUrl}
            download={file.name}
          >
            <Download size={18} aria-hidden="true" />
            Download instead
          </a>
        {/if}
      </div>
    {:else if loading}
      <div class="flex items-center justify-center gap-2 py-16 text-sm text-gray-500" aria-live="polite">
        <LoaderCircle size={18} class="animate-spin" aria-hidden="true" />
        Preparing preview…
      </div>
    {:else if loadError !== null}
      <div class="flex flex-col items-center gap-3 py-12 text-center" role="alert">
        <TriangleAlert size={32} class="text-red-500" aria-hidden="true" />
        <p class="max-w-sm text-sm text-gray-700 dark:text-gray-300">{loadError}</p>
        {#if downloadUrl !== null}
          <a
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 text-sm
                   font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200
                   dark:hover:bg-gray-800"
            href={downloadUrl}
            download={file.name}
          >
            <Download size={18} aria-hidden="true" />
            Download instead
          </a>
        {/if}
      </div>
    {:else if kind === 'image' && downloadUrl !== null}
      <div class="relative flex min-h-64 items-center justify-center overflow-auto rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
        <img
          src={downloadUrl}
          alt={file.name}
          class="max-h-[60vh] w-auto max-w-full object-contain transition-transform"
          style:transform={`scale(${zoom})`}
        />
      </div>
      <div class="flex items-center justify-center gap-2">
        <Button variant="secondary" size="sm" leading={ZoomOut} onclick={() => adjustZoom(-0.25)} disabled={zoom <= 0.25}>
          Zoom out
        </Button>
        <span class="w-14 text-center text-sm tabular-nums text-gray-600 dark:text-gray-300">
          {Math.round(zoom * 100)}%
        </span>
        <Button variant="secondary" size="sm" leading={ZoomIn} onclick={() => adjustZoom(0.25)} disabled={zoom >= 4}>
          Zoom in
        </Button>
      </div>
    {:else if kind === 'pdf' && downloadUrl !== null}
      <object
        data={downloadUrl}
        type="application/pdf"
        aria-label={`Preview of ${file.name}`}
        class="h-[65vh] w-full rounded-lg border border-gray-200 dark:border-gray-800"
      >
        <div class="flex flex-col items-center gap-3 p-8 text-center">
          <FileText size={32} class="text-gray-400" aria-hidden="true" />
          <p class="text-sm text-gray-600 dark:text-gray-300">
            This browser cannot display PDFs inline.
          </p>
          <a
            class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 text-sm
                   font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200
                   dark:hover:bg-gray-800"
            href={downloadUrl}
            download={file.name}
          >
            <Download size={18} aria-hidden="true" />
            Download instead
          </a>
        </div>
      </object>
    {:else if kind === 'video' && downloadUrl !== null}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video controls src={downloadUrl} class="max-h-[65vh] w-full rounded-lg bg-black">
        <track kind="captions" />
        Your browser cannot play this video.
      </video>
    {:else if kind === 'audio' && downloadUrl !== null}
      <div class="flex flex-col items-center gap-4 rounded-lg bg-gray-50 p-8 dark:bg-gray-900">
        <Music size={48} class="text-gray-400" aria-hidden="true" />
        <audio controls src={downloadUrl} class="w-full max-w-md">
          Your browser cannot play this audio file.
        </audio>
      </div>
    {:else if kind === 'text' && textBody !== null}
      {#if textTruncated}
        <p class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Showing the first {formatBytes(textLimit)} of a larger file. Download it to read the rest.
        </p>
      {/if}
      <pre
        class="max-h-[65vh] overflow-auto rounded-lg bg-gray-50 p-4 font-mono text-xs leading-relaxed
               text-gray-800 dark:bg-gray-900 dark:text-gray-200"><code>{textBody.slice(0, textLimit)}</code></pre>
    {:else if downloadUrl !== null}
      <div class="flex flex-col items-center gap-3 py-12 text-center">
        <FileIcon name={file.name} type="file" mimeType={effectiveType} showBadge size="xl" />
        <p class="max-w-sm text-sm text-gray-600 dark:text-gray-300">
          {effectiveType || 'This format'} cannot be shown in the browser.
        </p>
        <a
          class="inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium
                 text-white hover:bg-blue-700"
          href={downloadUrl}
          download={file.name}
        >
          <Download size={18} aria-hidden="true" />
          Download
        </a>
      </div>
    {:else}
      <p class="py-16 text-center text-sm text-gray-500">This file has no stored content.</p>
    {/if}
  </div>

  {#snippet footer()}
    {#if downloadUrl !== null && kind !== 'unsupported'}
      {#if downloadUrl !== null && file !== null}
        <a
          class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 text-sm
                 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200
                 dark:hover:bg-gray-800"
          href={downloadUrl}
          download={file.name}
        >
          <Download size={18} aria-hidden="true" />
          Download
        </a>
      {/if}
    {/if}
    <Button variant="primary" onclick={onclose}>Close</Button>
  {/snippet}
</Modal>
