/**
 * Minting a URL a browser can read a file's bytes from, in either mode.
 *
 * ## Why this is a module and not a store
 *
 * Two components need this — the preview modal and the download path in the
 * item grid — and in the Firebase mode they each reached for `getDownloadURL`
 * directly. That is correct for them and unusable for the local one, where there
 * is no Storage bucket to sign against and the bytes are a `Blob` sitting in
 * IndexedDB a few lines away.
 *
 * Rather than branch at both call sites, both call this. It resolves the active
 * repository, asks it for a URL, and hands back the one extra fact the callers
 * cannot derive themselves: whether the type the renderer will see is already
 * known or has to be discovered over the wire.
 *
 * ## The one behavioural difference, and why it is not a hole
 *
 * The preview modal refuses to render a type that would hand the bytes to an
 * HTML parser — `text/html`, `image/svg+xml` and friends — and it discovers that
 * type with a `HEAD` request, because the recorded MIME type and the bytes are
 * two independent facts about the same file. For a local file the recorded type
 * *is* the type the blob carries: there is no server, no upload-time override
 * and no intermediary, so a probe would return exactly what the document already
 * says.
 *
 * The refusal itself is unaffected. {@link ResolvedFileAccess.local} only skips
 * the probe; `FilePreviewModal` still runs the same executable-type check over
 * the value this module supplies, and still refuses.
 */
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { getStorageClient } from '$lib/firebase/client';
import { getActiveRepository } from '$lib/services/driveRepository';
import { resolveMimeType } from '$lib/utils/mimetypes';
import type { DriveFile } from '$lib/types/drive';

/** A readable URL for one file, and everything the caller needs to let it go. */
export interface ResolvedFileAccess {
  /** A URL the browser can fetch or navigate to. */
  readonly url: string;

  /**
   * The type a renderer will actually see, or `null` when that is not yet known
   * and the caller must find out for itself.
   *
   * Always populated for a local file. Always `null` for a remote one, where the
   * only authority is the server that will serve it.
   */
  readonly contentType: string | null;

  /**
   * `true` when the bytes are in this process.
   *
   * The single flag callers branch on: it means {@link contentType} is
   * authoritative, and it means {@link release} has real work to do.
   */
  readonly local: boolean;

  /**
   * Give the URL back.
   *
   * A no-op for a remote repository, whose tokens belong to the server and die
   * on their own. For a local one this revokes the object URL, so a caller that
   * cannot guarantee a release — a download handed to the browser and forgotten
   * — should not call it at all rather than call it too early.
   */
  release(): void;
}

/** Reduce a content type to the bare essence the type checks compare against. */
function bareType(value: string): string {
  return value.toLowerCase().split(';')[0].trim();
}

/**
 * Mint a URL for `file` from whichever repository is serving this session.
 *
 * A no-op release for the Firebase path keeps the two callers free of mode
 * branches: they call {@link ResolvedFileAccess.release} unconditionally, and it
 * costs nothing when there is nothing to release.
 */
export async function resolveFileAccess(file: DriveFile): Promise<ResolvedFileAccess> {
  const repository = getActiveRepository();

  if (repository !== null) {
    const url = await repository.getDownloadURL(file);
    return {
      url,
      contentType: bareType(resolveMimeType({ name: file.name, type: file.mimeType })),
      local: true,
      release: () => {
        repository.releaseObjectUrl(url);
      }
    };
  }

  const url = await getDownloadURL(storageRef(getStorageClient(), file.storagePath));
  return {
    url,
    contentType: null,
    local: false,
    release: () => {}
  };
}

/**
 * Hand a URL to the browser as a file download.
 *
 * The anchor is created, clicked and discarded in one synchronous block, which
 * is the only sequence every current browser accepts. The `download` attribute
 * is set explicitly because an object URL carries no filename of its own and a
 * cross-origin token would otherwise be saved under its last path segment.
 *
 * The release is deferred by one task rather than done inline: revoking the
 * object URL in the same turn as the click has raced in the past, and a caller
 * that gets it wrong fails as a silent zero-byte file rather than an error.
 */
export function startFileDownload(access: ResolvedFileAccess, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = access.url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    access.release();
  }, 0);
}
