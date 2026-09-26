/**
 * The drive persistence contract, and the registry that decides who serves it.
 *
 * ## Why a contract at all
 *
 * The app is a Firebase client, and its Firestore implementation is the primary
 * code path: transactional quota ledgers, rule-enforced batch ordering, real
 * `onSnapshot` listeners. That path is load-bearing and is not being replaced.
 * What changes here is the *floor* under it.
 *
 * A deployment that ships to Vercel with no `PUBLIC_FIREBASE_*` values, or with
 * the placeholder `mock-api-key` still in place, has no Firestore at all. Before
 * this module the only outcomes were a splash screen that never resolves or a
 * permission error. Now there is a third: a complete drive backed by the
 * browser's own IndexedDB, wired in through exactly the interface below.
 *
 * ## The dual-mode strategy, stated plainly
 *
 * `IDriveRepository` is the shape of a *repository* — a source of truth that can
 * list, mutate and serve bytes. {@link getActiveRepository} returns the one
 * serving the current session:
 *
 * - `null` — Firebase owns the drive. `driveStore` and `uploadQueueStore` run
 *   their existing Firestore code paths, unmodified and untouched.
 * - an instance — the local repository owns the drive and the two stores
 *   delegate to it instead.
 *
 * The registry is a plain module-scoped variable rather than a Svelte store on
 * purpose. It is read at the top of each store operation, and the stores are
 * re-synchronised by the shell whenever the account changes, so a
 * reactive-publishing wrapper would add a dependency edge from this leaf module
 * to the reactivity system for no behavioural gain.
 *
 * ## What this module deliberately does not do
 *
 * It does not re-declare the Firestore rules. The local repository is
 * single-user, single-tab and has no adversary, so a transaction is a promise
 * chain rather than a conflict-detecting compare-and-set. Where a rule has a
 * matching client-side twin (`assertWritableParent`, cycle detection, the
 * restore ordering) the local repository applies the *same* rule through
 * {@link $lib/domain/operations}, so the two modes cannot disagree about what a
 * legal drive looks like.
 */
import type { DriveFile, DriveFolder, DriveItem, DriveUser } from '$lib/types/drive';

/* -------------------------------------------------------------------------- */
/* Mode                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Which persistence layer owns the drive.
 *
 * - `firebase` — a real project, or the local emulator suite.
 * - `demo` — no backend was reachable, so the browser is the backend.
 */
export type DriveMode = 'firebase' | 'demo';

/**
 * Why the app landed in a given mode.
 *
 * Surfaced verbatim in the demo-mode dialog: "no credentials" and "credentials
 * present but the network failed" are different problems for whoever deployed
 * this, and a single boolean would hide the distinction.
 */
export type DriveModeReason =
  | 'configured'
  | 'missing-config'
  | 'placeholder-config'
  | 'connection-failed';

/* -------------------------------------------------------------------------- */
/* Scopes and streams                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The listing a subscription covers.
 *
 * Structurally identical to `DriveScope` in the item store, and declared
 * separately so this module stays a leaf: the store imports the contract, never
 * the reverse.
 */
export type DriveRepositoryScope =
  | { readonly kind: 'folder'; readonly folderId: string | null }
  | { readonly kind: 'starred' }
  | { readonly kind: 'trash' };

/** Handle returned by {@link IDriveRepository.subscribeItems}. */
export interface DriveSubscription {
  /** Detach the listener. Idempotent. */
  close(): void;
}

/**
 * A subscription, in the shape the stores hold it in.
 *
 * Firebase's `onSnapshot` returns a bare `Unsubscribe` function and
 * `subscribeItems` returns a `DriveSubscription`, so the store's detach field
 * has to accept both. Declaring the union here keeps that fact in one place
 * rather than at every assignment site.
 */
export type DriveUnsubscribe = DriveSubscription | (() => void);

/** Called with the full contents of a scope, in `normalizedName` order. */
export type DriveItemsListener = (items: readonly DriveItem[]) => void;

/** Called once per subscription when the source fails irrecoverably. */
export type DriveErrorListener = (error: unknown) => void;

/** Called with the current account document, including the quota ledger. */
export type DriveProfileListener = (profile: DriveUser) => void;

/* -------------------------------------------------------------------------- */
/* Uploads                                                                     */
/* -------------------------------------------------------------------------- */

/** One progress sample from an in-flight transfer. */
export interface DriveUploadProgress {
  readonly bytesTransferred: number;
  readonly totalBytes: number;
  /** `bytesTransferred / totalBytes`, clamped to `[0, 1]`. Zero-size files report `1`. */
  readonly ratio: number;
}

/** Progress callback handed to {@link IDriveRepository.uploadFile}. */
export type DriveProgressListener = (progress: DriveUploadProgress) => void;

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything a drive must be able to do, independent of where it is stored.
 *
 * The write methods return the ids they touched rather than a success flag:
 * an operation that resolved a name collision or expanded a subtree can do
 * either in full or in no part, so a partial result is not representable, and
 * the caller needs the ids anyway to reconcile its selection.
 */
export interface IDriveRepository {
  /** Which layer is serving. */
  readonly mode: DriveMode;

  /** The signed-in account, including the authoritative quota ledger. */
  getCurrentUser(): Promise<DriveUser>;

  /**
   * Live items for a scope.
   *
   * `listener` is invoked immediately on attach and again on every change, which
   * mirrors `onSnapshot` closely enough that the item store's loading states
   * need no mode-specific branch.
   */
  subscribeItems(
    scope: DriveRepositoryScope,
    listener: DriveItemsListener,
    onError?: DriveErrorListener
  ): DriveSubscription;

  /** Create a folder, resolving a name collision against its siblings. */
  createFolder(name: string, parentFolderId: string | null, color?: string | null): Promise<DriveFolder>;

  /** Rename one item, resolving a name collision against its siblings. */
  renameItem(id: string, name: string): Promise<DriveItem>;

  /** Move items into a destination folder, or into the root when `null`. */
  moveItems(ids: readonly string[], destinationId: string | null): Promise<readonly string[]>;

  /** Move items to the trash, together with every descendant. */
  trashItems(ids: readonly string[]): Promise<readonly string[]>;

  /** Restore items from the trash, reparenting orphans to the root. */
  restoreItems(ids: readonly string[]): Promise<readonly string[]>;

  /** Delete trashed items and their bytes for good. Idempotent. */
  permanentlyDelete(ids: readonly string[]): Promise<readonly string[]>;

  /** Permanently delete every trashed item. */
  emptyTrash(): Promise<readonly string[]>;

  /** Set or clear the star on a set of items. */
  setStarred(ids: readonly string[], starred: boolean): Promise<readonly string[]>;

  /**
   * Store a file's bytes and its metadata as one logical unit.
   *
   * Rejects with a {@link DriveQuotaError} when the transfer would exceed the
   * account ceiling, and honours `signal` so a cancel is not merely advisory.
   */
  uploadFile(
    file: File,
    targetFolderId: string | null,
    onProgress?: DriveProgressListener,
    signal?: AbortSignal
  ): Promise<DriveFile>;

  /**
   * A URL the browser can read the file's bytes from.
   *
   * For a remote repository this is a signed token; for a local one it is an
   * object URL whose lifetime is owned by the caller. Callers that cannot
   * guarantee a revoke should pair this with {@link DriveRepository.releaseObjectUrl}.
   */
  getDownloadURL(item: DriveFile): Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* Repository — contract plus the queries the shell needs                      */
/* -------------------------------------------------------------------------- */

/**
 * The contract extended with the read-only lookups the stores make outside a
 * subscription.
 *
 * Kept separate from {@link IDriveRepository} so that a second implementation
 * can satisfy the write contract alone, and so the "what does a drive have to
 * be able to do" list stays readable.
 */
export interface DriveRepositoryQueries {
  /** Items in the trash. The badge needs a number, not the documents. */
  countTrashed(): Promise<number>;

  /** One item by id, or `null`. Used for breadcrumb ancestors. */
  getItem(itemId: string): Promise<DriveItem | null>;

  /** Every non-trashed folder, for the move picker. */
  listFolders(): Promise<readonly DriveFolder[]>;

  /**
   * Apply a field patch to one folder.
   *
   * Not part of {@link IDriveRepository} because it is a general document write
   * rather than a drive operation, and a repository is free to have no such
   * concept. It lives here because the item store's folder editor needs it, and
   * expressing it as `renameItem` plus `setStarred` would be a lossy fit — the
   * colour has nowhere to go.
   */
  updateFolder(folderId: string, patch: DriveRepositoryFolderPatch): Promise<DriveFolder>;

  /** Live account document, so the storage meter tracks every write. */
  subscribeProfile(listener: DriveProfileListener, onError?: DriveErrorListener): DriveSubscription;

  /**
   * Release an object URL handed out by {@link IDriveRepository.getDownloadURL}.
   *
   * A no-op for remote repositories, whose URLs are not process-owned.
   */
  releaseObjectUrl(url: string): void;

  /** Drop listeners and release resources. The repository is unusable after. */
  destroy(): void;
}

/** The full surface `driveStore` and `uploadQueueStore` consume. */
export type DriveRepository = IDriveRepository & DriveRepositoryQueries;

/**
 * The subset of a folder's mutable fields a repository can be asked to change.
 *
 * Structurally the same as `UpdateItemPatch` in the drive types, declared
 * separately so this module stays a leaf: the store imports the contract, never
 * the reverse. Both are optional, so an empty patch is well-formed and a
 * repository may treat it as a touch.
 */
export interface DriveRepositoryFolderPatch {
  readonly name?: string;
  readonly color?: string | null;
  readonly isStarred?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Raised when a write would take the account past its storage ceiling.
 *
 * The `code` is deliberately the Firestore spelling rather than a bespoke one:
 * `classifyError` already maps `resource-exhausted` to "There is not enough
 * storage left to save this item", so a local rejection produces byte-identical
 * copy to a remote one and the UI needs no mode branch to render it.
 */
export class DriveQuotaError extends Error {
  /** Matches the Firestore code the shared classifier already understands. */
  readonly code = 'resource-exhausted';

  constructor(message = 'There is not enough storage left to save this item.') {
    super(message);
    this.name = 'DriveQuotaError';
  }
}

/** `true` when a thrown value is a local quota rejection. */
export function isDriveQuotaError(error: unknown): error is DriveQuotaError {
  return error instanceof DriveQuotaError;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/** The repository serving this session. `null` means Firebase owns the drive. */
let activeRepository: DriveRepository | null = null;

/** The repository serving this session, or `null` when Firebase owns the drive. */
export function getActiveRepository(): DriveRepository | null {
  return activeRepository;
}

/**
 * Install or clear the active repository.
 *
 * Idempotent for the same instance, so a repeated demo-mode activation does not
 * orphan the previous repository's listeners.
 */
export function setActiveRepository(repository: DriveRepository | null): void {
  activeRepository = repository;
}
