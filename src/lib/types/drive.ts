/**
 * Canonical domain contracts for the SvelteKit Cloud Drive.
 *
 * This module is the single source of truth for every persisted shape in
 * Firestore. It is split into two strictly separated layers:
 *
 * 1. READ MODELS (`DriveUser`, `DriveItem`, ...) describe documents exactly as
 *    they are stored once a server `Timestamp` has materialised. They are safe
 *    to consume in the UI, in `$derived` expressions and in template logic.
 * 2. WRITE DTOs (`ReserveUploadDTO`, `CreateFolderDTO`, `UpdateItemDTO`) describe
 *    documents at the moment they are written. They use `FieldValue` sentinels
 *    (`serverTimestamp()`) instead of `Timestamp`, so a write payload can never
 *    accidentally pin a client-clock timestamp.
 *
 * Mixing the two layers is a type error by construction: a `DriveFile` is not
 * assignable to `ReserveUploadDTO` and vice versa, because `FieldValue` and
 * `Timestamp` are unrelated types.
 */
import type { FieldValue, Timestamp } from 'firebase/firestore';

/* -------------------------------------------------------------------------- */
/* Primitive unions                                                            */
/* -------------------------------------------------------------------------- */

/** Discriminator for the two concrete item shapes stored in `items`. */
export type ItemType = 'file' | 'folder';

/** Presentation-only density of the main item canvas. */
export type ViewMode = 'grid' | 'list';

/** Sortable columns exposed by the listing layer. */
export type SortField = 'name' | 'updatedAt' | 'sizeBytes';

/** Sort orientation paired with a {@link SortField}. */
export type SortDirection = 'asc' | 'desc';

/**
 * Lifecycle of a file's binary payload.
 *
 * `reserved` -> `uploading` -> `uploaded` -> `committed` -> `deletion-pending`
 * is the happy path. `failed` is a branch reachable from any pre-commit state;
 * `deletion-pending` is the idempotent tombstone written before any byte of a
 * permanent delete touches Storage.
 *
 * Folders never carry an upload status: the field only exists on {@link DriveFile}.
 */
export type UploadStatus =
  | 'reserved'
  | 'uploading'
  | 'uploaded'
  | 'committed'
  | 'failed'
  | 'deletion-pending';

/** Client-side task status, mirrored from {@link UploadStatus} for the queue UI. */
export type UploadTaskStatus = 'pending' | 'uploading' | 'completed' | 'error' | 'paused';

/** Scope of the item-type filter applied to a listing. */
export type ItemTypeFilter = 'all' | ItemType;

/* -------------------------------------------------------------------------- */
/* Account / quota                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Byte ledger for a single owner.
 *
 * Invariant enforced transactionally (and re-checked by `firestore.rules`):
 * `usedBytes + reservedBytes <= totalBytes`.
 *
 * - `usedBytes` — bytes of files whose Firestore commit succeeded.
 * - `reservedBytes` — bytes held by in-flight reservations that have not been
 *   converted to `usedBytes` yet. Released on failure, abort, or commit.
 */
export interface StorageQuota {
  usedBytes: number;
  reservedBytes: number;
  totalBytes: number;
}

/** READ MODEL — `users/{uid}`. */
export interface DriveUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  quota: StorageQuota;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/* -------------------------------------------------------------------------- */
/* Item read models                                                            */
/* -------------------------------------------------------------------------- */

/** Fields shared by every `items/{itemId}` document. */
export interface DriveItemBase {
  id: string;
  name: string;
  /** `name.normalize('NFC').trim().toLowerCase()` — the sibling-collision key. */
  normalizedName: string;
  ownerId: string;
  /** `null` represents the drive root. */
  parentFolderId: string | null;
  isTrashed: boolean;
  trashedAt: Timestamp | null;
  isStarred: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** READ MODEL — `items/{itemId}` where `type == 'folder'`. */
export interface DriveFolder extends DriveItemBase {
  type: 'folder';
  /** Optional user-picked accent colour (CSS colour string) for the grid tile. */
  color: string | null;
}

/** READ MODEL — `items/{itemId}` where `type == 'file'`. */
export interface DriveFile extends DriveItemBase {
  type: 'file';
  mimeType: string;
  sizeBytes: number;
  /** Canonical Storage object path: `users/{uid}/{itemId}/{fileName}`. */
  storagePath: string;
  uploadStatus: UploadStatus;
  /** UUID v4 identifying the single attempt that owns the pending binary. */
  uploadSessionId: string;
  thumbnailUrl?: string | null;
  md5Hash?: string;
}

/** Discriminated union over every persisted item. */
export type DriveItem = DriveFolder | DriveFile;

/* -------------------------------------------------------------------------- */
/* Write DTOs — `FieldValue` sentinels, never `Timestamp`                      */
/* -------------------------------------------------------------------------- */

/** Phase 1 write payload: create the `reserved` file document atomically with the quota hold. */
export interface ReserveUploadDTO {
  name: string;
  normalizedName: string;
  ownerId: string;
  parentFolderId: string | null;
  type: 'file';
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  uploadStatus: 'reserved';
  uploadSessionId: string;
  isTrashed: false;
  trashedAt: null;
  isStarred: boolean;
  createdAt: FieldValue;
  updatedAt: FieldValue;
}

/** Write payload for spawning a folder node. */
export interface CreateFolderDTO {
  name: string;
  normalizedName: string;
  ownerId: string;
  parentFolderId: string | null;
  type: 'folder';
  color: string | null;
  isTrashed: false;
  trashedAt: null;
  isStarred: boolean;
  createdAt: FieldValue;
  updatedAt: FieldValue;
}

/**
 * Partial mutation payload. `updatedAt` is required on every patch, so a
 * writer can never forget to stamp the change.
 */
export interface UpdateItemDTO {
  name?: string;
  normalizedName?: string;
  parentFolderId?: string | null;
  isStarred?: boolean;
  isTrashed?: boolean;
  trashedAt?: FieldValue | null;
  uploadStatus?: UploadStatus;
  updatedAt: FieldValue;
}

/** Read-model projection of a partial {@link UpdateItemDTO} (identity fields excluded). */
export type UpdateItemPatch = Partial<
  Omit<DriveItemBase, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>
>;

/** Quota ledger deltas applied inside a single Firestore transaction. */
export interface QuotaDelta {
  /** Bytes added to `reservedBytes` (a reservation). Always `>= 0`. */
  reserveBytes: number;
  /** Bytes moved from `reservedBytes` into `usedBytes` (a commit). Always `>= 0`. */
  commitBytes: number;
  /** Bytes returned from `reservedBytes` after a failure or abort. Always `>= 0`. */
  releaseBytes: number;
  /** Bytes returned from `usedBytes` after a completed permanent delete. Always `>= 0`. */
  reclaimBytes: number;
}

/* -------------------------------------------------------------------------- */
/* View / navigation models                                                    */
/* -------------------------------------------------------------------------- */

/** One hop of the ancestor chain rendered by the breadcrumb trail. `id === null` is the root. */
export interface BreadcrumbNode {
  id: string | null;
  name: string;
}

/** Live progress row rendered inside the upload queue drawer. */
export interface UploadTaskProgress {
  id: string;
  fileName: string;
  sizeBytes: number;
  bytesTransferred: number;
  progressPercentage: number;
  status: UploadTaskStatus;
  errorMessage: string | null;
}

/**
 * Multi-selection bookkeeping.
 *
 * `Set` is intentional (not an array): membership is the hot path for row
 * rendering, and every mutation here is presentation-only — never
 * authoritative, per the optimistic-UI boundary rules.
 */
export interface SelectionState {
  selectedIds: Set<string>;
  lastSelectedId: string | null;
}

/** Complete, serialisable description of the active listing query. */
export interface FilterSortOptions {
  searchQuery: string;
  itemType: ItemTypeFilter;
  mimeFilter: string | null;
  sortBy: SortField;
  sortDirection: SortDirection;
  showOnlyStarred: boolean;
  showTrash: boolean;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Canonical collision key. This is the *only* legal way to derive
 * `normalizedName`; Firestore rules and every write path depend on it.
 */
export function normalizeItemName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Upload state machine                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Directed graph of legal `uploadStatus` transitions.
 *
 * `deletion-pending` is intentionally terminal: once the tombstone is written,
 * the only remaining legal operation is the hard `delete` of the document, so
 * no update rule may ever fire on such a document.
 */
export const UPLOAD_STATUS_TRANSITIONS: Readonly<Record<UploadStatus, readonly UploadStatus[]>> =
  Object.freeze({
    reserved: ['uploading', 'failed', 'deletion-pending'],
    uploading: ['uploaded', 'committed', 'failed', 'deletion-pending'],
    uploaded: ['committed', 'failed', 'deletion-pending'],
    committed: ['deletion-pending'],
    failed: ['uploading', 'deletion-pending'],
    'deletion-pending': []
  });

/** Type guard for untrusted status values coming from Firestore or the network. */
export function isUploadStatus(value: unknown): value is UploadStatus {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(UPLOAD_STATUS_TRANSITIONS, value)
  );
}

/** True when `from -> to` is a legal edge of {@link UPLOAD_STATUS_TRANSITIONS}. */
export function canTransitionUploadStatus(from: UploadStatus, to: UploadStatus): boolean {
  return UPLOAD_STATUS_TRANSITIONS[from].includes(to);
}

/** True when the item has entered the idempotent permanent-deletion pipeline. */
export function isDeletionPending(item: DriveItem): boolean {
  return item.type === 'file' && item.uploadStatus === 'deletion-pending';
}

/* -------------------------------------------------------------------------- */
/* Item narrowing helpers                                                      */
/* -------------------------------------------------------------------------- */

/** Narrow a {@link DriveItem} to its file variant. */
export function isDriveFile(item: DriveItem): item is DriveFile {
  return item.type === 'file';
}

/** Narrow a {@link DriveItem} to its folder variant. */
export function isDriveFolder(item: DriveItem): item is DriveFolder {
  return item.type === 'folder';
}

/** Type guard for untrusted `type` discriminators. */
export function isItemType(value: unknown): value is ItemType {
  return value === 'file' || value === 'folder';
}

/** Type guard for a view mode read back from storage or a URL. */
export function isViewMode(value: unknown): value is ViewMode {
  return value === 'grid' || value === 'list';
}

/** Type guard for untrusted sort fields. */
export function isSortField(value: unknown): value is SortField {
  return value === 'name' || value === 'updatedAt' || value === 'sizeBytes';
}

/** Type guard for untrusted sort directions. */
export function isSortDirection(value: unknown): value is SortDirection {
  return value === 'asc' || value === 'desc';
}

/** Folders occupy the same rows as files in listings; size sorting treats them as empty. */
export function getItemSizeBytes(item: DriveItem): number {
  return item.type === 'file' ? item.sizeBytes : 0;
}

/** Compile-time exhaustiveness guard for `switch` over a union. */
export function assertNever(value: never, context?: string): never {
  throw new Error(
    `Unhandled variant ${JSON.stringify(value)}${context ? ` in ${context}` : ''}. ` +
      'This is a bug: the union is not exhaustive.'
  );
}
