/**
 * Narrowing raw Firestore documents into the read models in `$lib/types/drive`.
 *
 * Lives apart from any store because both the item store and the upload
 * pipeline have to agree on exactly which documents are readable — if they
 * disagreed, the upload manager could create a document the listing refuses to
 * render, and the file would exist in Storage with no row to reach it from.
 */
import type { DocumentData } from 'firebase/firestore';
import { normalizeItemName } from '$lib/types/drive';
import type { DriveFile, DriveItem, UploadStatus } from '$lib/types/drive';

/**
 * Build a read model from a raw document.
 *
 * @returns `null` for a document too malformed to render. One bad write must
 * not take down a whole listing, and `firestore.rules` already rejects the
 * shapes that should not exist; this is the last line of defence for a document
 * that predates a rule change or arrived through the Admin SDK.
 */
export function toDriveItem(id: string, data: DocumentData): DriveItem | null {
  if (typeof data.name !== 'string' || typeof data.ownerId !== 'string') return null;
  if (data.type !== 'file' && data.type !== 'folder') return null;
  if (data.createdAt == null || data.updatedAt == null) return null;

  const base = {
    id,
    name: data.name,
    normalizedName:
      typeof data.normalizedName === 'string' ? data.normalizedName : normalizeItemName(data.name),
    ownerId: data.ownerId,
    parentFolderId: typeof data.parentFolderId === 'string' ? data.parentFolderId : null,
    isTrashed: data.isTrashed === true,
    trashedAt: data.trashedAt ?? null,
    isStarred: data.isStarred === true,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };

  if (data.type === 'folder') {
    return {
      ...base,
      type: 'folder',
      color: typeof data.color === 'string' ? data.color : null
    };
  }

  return {
    ...base,
    type: 'file',
    mimeType: typeof data.mimeType === 'string' ? data.mimeType : 'application/octet-stream',
    sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : 0,
    storagePath: typeof data.storagePath === 'string' ? data.storagePath : '',
    uploadStatus: isUploadStatus(data.uploadStatus) ? data.uploadStatus : 'reserved',
    uploadSessionId: typeof data.uploadSessionId === 'string' ? data.uploadSessionId : ''
  };
}

/** Type guard for the persisted upload-status discriminator. */
function isUploadStatus(value: unknown): value is UploadStatus {
  return (
    value === 'reserved' ||
    value === 'uploading' ||
    value === 'uploaded' ||
    value === 'committed' ||
    value === 'failed' ||
    value === 'deletion-pending'
  );
}

/** Narrow a raw document to a file, or `null`. */
export function toDriveFile(id: string, data: DocumentData): DriveFile | null {
  const item = toDriveItem(id, data);
  return item !== null && item.type === 'file' ? item : null;
}
