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
  /** Content type the Storage server actually serves, once confirmed. */
  let servedType = $state<string | null>(null);
  /** Text body, for the `text` kind only. */
  let textBody = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  /** Image zoom, as a multiplier clamped to a sane band. */
  let zoom = $state(1);
  /** How much text to render; longer files are truncated with an explicit note. */
  let textLimit = $state(TEXT_LIMIT);

  /**
   * Media types a browser will *execute* rather than merely display.
   *
   * Every one of these is an HTML document in a trench coat. An `<img>`, an
   * `<object>` and a top-level navigation will all hand the bytes to the HTML
   * parser, and once that happens the file is a script running with the
   * download URL as its origin. They are refused before any prefix match can
   * classify them as ordinary media, and they are refused by exact type rather
   * than by name — `.svg` and `.xht` reach this function as whatever the uploader
   * chose, and `resolveMimeType` will happily produce `text/html` for a
   * `.html` file that was stored with a generic content type.
   */
  const EXECUTABLE_TYPES: ReadonlySet<string> = new Set([
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'application/xml',
    'text/xml',
    'application/xslt+xml',
    'text/xsl',
    'application/mathml+xml'
  ]);

  /**
   * Raster image types, listed explicitly rather than matched by `image/`.
   *
   * The prefix would also admit `image/svg+xml`, which is the one member of
   * the namespace that is a document. SVG inside `<img>` cannot run script in
   * any current browser, but an allowlist means a future `image/`-shaped type
   * with document semantics has to be opted in deliberately instead of arriving
   * by default.
   */
  const RASTER_IMAGE_TYPES: ReadonlySet<string> = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/bmp',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/heic',
    'image/heif',
    'image/tiff'
  ]);

  /** Text types that are safe to show as escaped source. */
  const PLAIN_TEXT_TYPES: ReadonlySet<string> = new Set([
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/tab-separated-values',
    'text/yaml',
    'text/x-yaml',
    'application/json',
    'application/x-ndjson',
    'application/yaml',
    'application/javascript',
    'application/ecmascript',
    'text/x-typescript',
    'text/x-python',
    'text/x-shellscript',
    'application/x-sh',
    'application/sql',
    'application/x-httpd-php'
  ]);

  /** Media types whose decoding cannot run script. */
  const AUDIO_TYPES: ReadonlySet<string> = new Set([
    'audio/mpeg',
    'audio/mp3',
    'audio/ogg',
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/webm',
    'audio/aac',
    'audio/mp4',
    'audio/flac',
    'audio/x-flac',
    'audio/midi'
  ]);

  const VIDEO_TYPES: ReadonlySet<string> = new Set([
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    'video/x-msvideo',
    'video/mpeg',
    'video/x-matroska'
  ]);

  /**
   * Decide how to render a file.
   *
   * An allowlist, evaluated before any prefix test. The previous shape matched
   * `type.startsWith('text/')` and sent the result to the text panel, which
   * *happened* to be safe because Svelte escapes the interpolation — but the
   * safety was a property of the renderer, not of this function. A single
   * `{@html}` added to the text branch would have turned every uploaded
   * `.html` file in the drive into a stored XSS, with no change here to flag
   * it. Now the guarantee is stated here, where a reader of `classify` can see
   * it: these types render as escaped source or not at all.
   */
  function classify(target: DriveFile | null): PreviewKind {
    if (target === null) return 'unsupported';
    if (target.uploadStatus !== 'committed') return 'unsupported';

    const type = resolveMimeType({ name: target.name, type: target.mimeType }).toLowerCase().trim();

    if (EXECUTABLE_TYPES.has(type)) return 'text';
    if (RASTER_IMAGE_TYPES.has(type)) return 'image';
    if (type === 'application/pdf') return 'pdf';
    if (VIDEO_TYPES.has(type)) return 'video';
    if (AUDIO_TYPES.has(type)) return 'audio';
    if (PLAIN_TEXT_TYPES.has(type)) return 'text';

    // Unknown and unlisted types are not rendered inline. A `text/*` type this
    // build has never heard of is shown as source rather than guessed at, but
    // anything else is refused outright: the cost of a wrong guess here is a
    // renderer executing a document.
    if (type.startsWith('text/')) return 'text';

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
    servedType = null;
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
        } else {
          // Confirm what the server will actually hand the browser before any
          // element parses it. Firestore's `mimeType` and the bytes are two
          // independent facts about the same file, and only one of them is
          // under the rules. A one-byte HEAD is enough to disagree with them,
          // and disagreeing is the only thing that matters here: the rendered
          // element follows the served type, never the recorded one.
          const head = await fetch(url, { method: 'HEAD' });
          servedType = (head.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
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

  /**
   * Whether the bytes the server serves are safe to hand a document parser.
   *
   * Recorded before the download token, because the recorded type is what the
   * uploader claimed and the served type is what a renderer would actually get.
   * While the HEAD is in flight `servedType` is `null`, and `null` is treated as
   * "not yet known, so do not render": an unknown type is not evidence of a safe
   * one, and the cost of guessing wrong is a document executing in the app's UI.
   */
  const servedTypeIsExecutable = $derived(servedType === null ? true : EXECUTABLE_TYPES.has(servedType));

  /** True when the inline renderer may be used for this file. */
  const canRenderInline = $derived(kind !== 'unsupported' && !servedTypeIsExecutable);
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
    {:else if canRenderInline && kind === 'image' && downloadUrl !== null}
      <div class="relative flex min-h-64 items-center justify-center overflow-auto rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
        <img
          src={downloadUrl}
          alt={file.name}
          loading="lazy"
          decoding="async"
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
    {:else if canRenderInline && kind === 'pdf' && downloadUrl !== null}
      <!--
        A sandboxed frame, not `<object>`.

        `<object data=...>` navigates the bytes into a nested browsing context
        and lets the *server's* content type decide what parses them. The `type`
        attribute on it is a hint the browser is free to ignore, so a file
        recorded in Firestore as `application/pdf` but stored with a
        `text/html` content type would have rendered as a live document — same
        `text/html` shape as a stored XSS, reached through a file the user only
        ever uploaded.

        `sandbox` with no tokens is a deny-by-default: no scripts, no plugins,
        no forms, no same-origin access, and a unique opaque origin. A real PDF
        still renders, because the built-in viewer needs none of those. The
        consequence is deliberate — a PDF whose JavaScript is meant to run stops
        running here, and is still perfectly downloadable below.
      -->
      <iframe
        src={downloadUrl}
        title={`Preview of ${file.name}`}
        sandbox=""
        referrerpolicy="no-referrer"
        class="h-[65vh] w-full rounded-lg border border-gray-200 bg-white dark:border-gray-800"
      ></iframe>
    {:else if canRenderInline && kind === 'video' && downloadUrl !== null}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video controls src={downloadUrl} class="max-h-[65vh] w-full rounded-lg bg-black">
        <track kind="captions" />
        Your browser cannot play this video.
      </video>
    {:else if canRenderInline && kind === 'audio' && downloadUrl !== null}
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
      <!--
        Escaped source, always.

        Svelte escapes this interpolation, so a file whose contents are a
        complete HTML document — the case `EXECUTABLE_TYPES` routes here —
        renders as the text it is. Keep it that way: the only reason HTML and
        SVG are funnelled into this branch is that this renderer does not
        interpret them, and that is the invariant the whole allowlist rests on.
      -->
      <pre
        class="max-h-[65vh] overflow-auto rounded-lg bg-gray-50 p-4 font-mono text-xs leading-relaxed
               text-gray-800 dark:bg-gray-900 dark:text-gray-200"><code>{textBody.slice(0, textLimit)}</code></pre>
    {:else if downloadUrl !== null}
      <div class="flex flex-col items-center gap-3 py-12 text-center">
        <FileIcon name={file.name} type="file" mimeType={effectiveType} showBadge size="xl" />
        <p class="max-w-sm text-sm text-gray-600 dark:text-gray-300">
          {#if servedTypeIsExecutable}
            This file is an executable document format, so it is not rendered inline.
          {:else}
            {effectiveType || 'This format'} cannot be shown in the browser.
          {/if}
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
