/**
 * The local drive: an IndexedDB repository that makes a zero-config deployment
 * a working drive rather than an error page.
 *
 * ## Shape
 *
 * The whole drive lives in one in-memory `Map`, and IndexedDB is the durable
 * mirror of it. That is the opposite of the Firestore path, and deliberately so:
 * a local drive is bounded by one browser's quota and is read in full every time
 * it is opened, so a resident index costs a few hundred kilobytes and removes
 * every partial-failure case a document store would otherwise have to handle.
 * Firestore keeps nothing resident precisely because it is unbounded; copying
 * that constraint here would buy nothing.
 *
 * ## Why the ledger is recomputed rather than incremented
 *
 * The Firestore path moves bytes between `usedBytes` and `reservedBytes` inside
 * transactions, because two clients can write at once and a blind read-modify
 * write would lose a delta. A local drive has exactly one writer, so the
 * transaction is unnecessary — and so the ledger is instead *derived* from the
 * item index after every change, and written back as a single value.
 *
 * That is a stronger guarantee than the transaction provides. The ledger cannot
 * drift from the items it describes, because there is no code path that updates
 * one without the other: the only way to change the number is to change the
 * items first. A crash mid-write leaves a stale number on disk for at most one
 * session, and it is corrected from the items the moment the drive is reopened.
 *
 * ## Serialisation
 *
 * Every mutation goes through {@link MockDriveRepository.enqueue}, which chains
 * onto a single promise. That is not a lock and does not need to be one — the
 * JavaScript event loop already runs one mutation's synchronous section to
 * completion before another's begins. What it *does* buy is that a mutation
 * never interleaves with another's awaited storage write, which is the only way
 * a single-writer design can still lose a write.
 */
import { Timestamp } from 'firebase/firestore';
import {
  DriveItemIndex,
  assertNoMoveCycles,
  assertWritableParent,
  collectSubtree,
  resolveFreeName,
  resolveRestoreParent,
  subtreeRoots
} from '$lib/domain/operations';
import { validateItemName } from '$lib/domain/itemNames';
import { resolveMimeType } from '$lib/utils/mimetypes';
import {
  DriveQuotaError,
  type DriveErrorListener,
  type DriveItemsListener,
  type DriveMode,
  type DriveProfileListener,
  type DriveProgressListener,
  type DriveRepository,
  type DriveRepositoryFolderPatch,
  type DriveRepositoryScope,
  type DriveSubscription
} from '$lib/services/driveRepository';
import {
  SEED_FOLDER_NAME,
  SEED_IMAGE_MIME,
  SEED_IMAGE_NAME,
  SEED_README_BODY,
  SEED_README_MIME,
  SEED_README_NAME,
  decodeSeedImage
} from '$lib/services/demoSeed';
import type { DriveFile, DriveFolder, DriveItem, DriveUser, StorageQuota, UploadStatus } from '$lib/types/drive';

/* -------------------------------------------------------------------------- */
/* Identity and limits                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The single local account.
 *
 * A constant rather than a generated id because it has to be stable across
 * sessions: the uid keys every item and the profile, and a fresh one per load
 * would orphan the previous session's drive on every refresh.
 */
export const DEMO_USER_ID = 'demo-local-user';

/** Display name for the local account. */
export const DEMO_USER_DISPLAY_NAME = 'Demo User';

/**
 * Email shown in the account chip.
 *
 * `.invalid` is reserved by RFC 2606 precisely so an address can be displayed
 * without any chance of it reaching a real mailbox.
 */
export const DEMO_USER_EMAIL = 'demo@local.invalid';

/**
 * Ceiling for a local drive: 1 GB.
 *
 * A fraction of the 15 GB a real account is granted, and far below what any
 * browser will store. The point is not to be generous but to make the quota meter
 * reachable: a ceiling nobody can hit is a meter nobody can watch work.
 */
export const DEMO_QUOTA_TOTAL_BYTES = 1024 * 1024 * 1024;

/** Bytes read per progress tick while streaming a file into storage. */
const UPLOAD_CHUNK_BYTES = 256 * 1024;

/* -------------------------------------------------------------------------- */
/* Persisted shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * An item as stored.
 *
 * Timestamps are epoch milliseconds rather than `Timestamp` instances: numbers
 * clone cheaply, compare cheaply, and cannot drift from the value they were
 * written with. The read models handed to the UI are rebuilt with real
 * `Timestamp` objects by {@link toDriveItem}, so nothing downstream — formatters,
 * `updatedAt` sorts, the breadcrumb trail — can tell the two modes apart.
 */
interface StoredItem {
  id: string;
  name: string;
  normalizedName: string;
  ownerId: string;
  parentFolderId: string | null;
  type: 'file' | 'folder';
  mimeType: string | null;
  sizeBytes: number;
  storagePath: string | null;
  uploadStatus: UploadStatus;
  uploadSessionId: string | null;
  color: string | null;
  isTrashed: boolean;
  trashedAt: number | null;
  isStarred: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A file's bytes, keyed by the item that owns them. */
interface StoredFile {
  itemId: string;
  blob: Blob;
  sizeBytes: number;
}

/** The account document, including the quota ledger. */
interface StoredProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string | null;
  quota: StorageQuota;
  createdAt: number;
  updatedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Storage backends                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The durable surface the repository needs, and nothing more.
 *
 * Narrow on purpose: it is the seam that lets a browser refusing IndexedDB —
 * private windows in some configurations, a blocked origin, a full disk — fall
 * back to a memory-only drive that behaves identically minus persistence.
 */
interface DemoStorage {
  readonly persistent: boolean;
  /**
   * Confirm the backend can be reached.
   *
   * Separated from the first read so the choice of backend costs one connection
   * rather than a connection plus a full read of a drive that may be discarded.
   */
  probe(): Promise<void>;
  readAllItems(): Promise<StoredItem[]>;
  writeItems(records: readonly StoredItem[]): Promise<void>;
  deleteItems(ids: readonly string[]): Promise<void>;
  readFile(itemId: string): Promise<StoredFile | null>;
  writeFile(record: StoredFile): Promise<void>;
  deleteFiles(ids: readonly string[]): Promise<void>;
  readProfile(uid: string): Promise<StoredProfile | null>;
  writeProfile(profile: StoredProfile): Promise<void>;
  close(): void;
}

/** Database name. Namespaced so it cannot collide with Firebase's own storage. */
const DATABASE_NAME = 'sveltekit-cloud-drive';

/** Schema version. Bump only alongside a migration. */
const DATABASE_VERSION = 1;

/** Object store holding {@link StoredItem} records. */
const ITEMS_STORE = 'items';

/** Object store holding {@link StoredFile} records. */
const FILES_STORE = 'files';

/** Object store holding the single {@link StoredProfile} record. */
const USER_STORE = 'user';

/** Resolve an `IDBRequest` to its result. */
function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed.'));
    };
  });
}

/** Resolve when a transaction commits, and reject if it aborts. */
function toTransactionPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    };
  });
}

/** The default, durable backend. */
class IndexedDbStorage implements DemoStorage {
  readonly persistent = true;

  #db: IDBDatabase | null = null;
  #opening: Promise<IDBDatabase> | null = null;

  #open(): Promise<IDBDatabase> {
    const existing = this.#db;
    if (existing !== null) return Promise.resolve(existing);
    if (this.#opening !== null) return this.#opening;

    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ITEMS_STORE)) {
          const store = db.createObjectStore(ITEMS_STORE, { keyPath: 'id' });
          store.createIndex('ownerId', 'ownerId', { unique: false });
        }
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: 'itemId' });
        }
        if (!db.objectStoreNames.contains(USER_STORE)) {
          db.createObjectStore(USER_STORE, { keyPath: 'uid' });
        }
      };

      request.onsuccess = () => {
        this.#db = request.result;
        // A second tab asking for a version upgrade must not block this one's
        // connection: it is closed, its writes are already durable, and the other
        // tab is the one that needs to proceed.
        request.result.onversionchange = () => {
          this.close();
        };
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB could not be opened.'));
      };

      request.onblocked = () => {
        reject(new Error('IndexedDB upgrade is blocked by another open tab.'));
      };
    });

    // A failed open must not poison every later attempt.
    const guarded = attempt.catch((error: unknown) => {
      this.#opening = null;
      throw error;
    });
    this.#opening = guarded;
    return guarded;
  }

  async probe(): Promise<void> {
    await this.#open();
  }

  async readAllItems(): Promise<StoredItem[]> {
    const db = await this.#open();
    const transaction = db.transaction(ITEMS_STORE, 'readonly');
    return toPromise(transaction.objectStore(ITEMS_STORE).getAll() as IDBRequest<StoredItem[]>);
  }

  async writeItems(records: readonly StoredItem[]): Promise<void> {
    if (records.length === 0) return;
    const db = await this.#open();
    const transaction = db.transaction(ITEMS_STORE, 'readwrite');
    const store = transaction.objectStore(ITEMS_STORE);
    for (const record of records) store.put(record);
    await toTransactionPromise(transaction);
  }

  async deleteItems(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.#open();
    const transaction = db.transaction(ITEMS_STORE, 'readwrite');
    const store = transaction.objectStore(ITEMS_STORE);
    for (const id of ids) store.delete(id);
    await toTransactionPromise(transaction);
  }

  async readFile(itemId: string): Promise<StoredFile | null> {
    const db = await this.#open();
    const transaction = db.transaction(FILES_STORE, 'readonly');
    const record = await toPromise(
      transaction.objectStore(FILES_STORE).get(itemId) as IDBRequest<StoredFile | undefined>
    );
    return record ?? null;
  }

  async writeFile(record: StoredFile): Promise<void> {
    const db = await this.#open();
    const transaction = db.transaction(FILES_STORE, 'readwrite');
    transaction.objectStore(FILES_STORE).put(record);
    await toTransactionPromise(transaction);
  }

  async deleteFiles(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.#open();
    const transaction = db.transaction(FILES_STORE, 'readwrite');
    const store = transaction.objectStore(FILES_STORE);
    for (const id of ids) store.delete(id);
    await toTransactionPromise(transaction);
  }

  async readProfile(uid: string): Promise<StoredProfile | null> {
    const db = await this.#open();
    const transaction = db.transaction(USER_STORE, 'readonly');
    const record = await toPromise(
      transaction.objectStore(USER_STORE).get(uid) as IDBRequest<StoredProfile | undefined>
    );
    return record ?? null;
  }

  async writeProfile(profile: StoredProfile): Promise<void> {
    const db = await this.#open();
    const transaction = db.transaction(USER_STORE, 'readwrite');
    transaction.objectStore(USER_STORE).put(profile);
    await toTransactionPromise(transaction);
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#opening = null;
  }
}

/**
 * The last-resort backend, used when IndexedDB cannot be opened.
 *
 * Behaves identically for the life of the tab and forgets everything on reload.
 * That is a strictly better outcome than refusing to open the drive: a user who
 * has hit a storage restriction can still create a folder, upload a file, and
 * see the quota meter move, which is the whole point of the mode.
 */
class MemoryStorage implements DemoStorage {
  readonly persistent = false;

  readonly #items = new Map<string, StoredItem>();
  readonly #files = new Map<string, StoredFile>();
  readonly #profiles = new Map<string, StoredProfile>();

  async probe(): Promise<void> {
    // Nothing to reach: the maps exist by virtue of this object existing.
  }

  async readAllItems(): Promise<StoredItem[]> {
    return [...this.#items.values()];
  }

  async writeItems(records: readonly StoredItem[]): Promise<void> {
    for (const record of records) this.#items.set(record.id, record);
  }

  async deleteItems(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.#items.delete(id);
  }

  async readFile(itemId: string): Promise<StoredFile | null> {
    return this.#files.get(itemId) ?? null;
  }

  async writeFile(record: StoredFile): Promise<void> {
    this.#files.set(record.itemId, record);
  }

  async deleteFiles(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.#files.delete(id);
  }

  async readProfile(uid: string): Promise<StoredProfile | null> {
    return this.#profiles.get(uid) ?? null;
  }

  async writeProfile(profile: StoredProfile): Promise<void> {
    this.#profiles.set(profile.uid, profile);
  }

  close(): void {
    // Nothing to release: the maps are garbage once the repository is dropped.
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The alphabet a Firestore document id is drawn from, plus the length the
 * client's own ids use.
 *
 * A local id is a *route parameter* on the way into `/folder/[id]`, and that
 * route rejects anything outside `/^[A-Za-z0-9_-]{20}$/`. A `crypto.randomUUID()`
 * is 36 characters long and fails that check, so a demo-mode folder would 404 the
 * instant it was opened — the one action the seed data exists to invite.
 *
 * The id contract belongs to the repository, not to the route: honouring it here
 * is what makes a local folder and a cloud folder indistinguishable to every
 * layer above, which is the entire point of the abstraction.
 */
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const ID_LENGTH = 20;

/**
 * Fresh client-generated id in the `items/{id}` document shape.
 *
 * The alphabet is exactly 64 characters, so `byte & 63` is a uniform draw from
 * it. The modulo-with-rejection alternative buys a bias nobody would notice in an
 * id, and costs a loop; this keeps the function branch-free and single-pass.
 */
function newLocalId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);

  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte & 63];
  return id;
}

/** Epoch milliseconds. Read once per operation so a batch shares a clock. */
function now(): number {
  return Date.now();
}

/** Rehydrate a stored record into the read model the rest of the app expects. */
function toDriveItem(record: StoredItem): DriveItem {
  const base = {
    id: record.id,
    name: record.name,
    normalizedName: record.normalizedName,
    ownerId: record.ownerId,
    parentFolderId: record.parentFolderId,
    isTrashed: record.isTrashed,
    trashedAt: record.trashedAt === null ? null : Timestamp.fromMillis(record.trashedAt),
    isStarred: record.isStarred,
    createdAt: Timestamp.fromMillis(record.createdAt),
    updatedAt: Timestamp.fromMillis(record.updatedAt)
  };

  if (record.type === 'folder') {
    return { ...base, type: 'folder', color: record.color };
  }

  return {
    ...base,
    type: 'file',
    mimeType: record.mimeType ?? 'application/octet-stream',
    sizeBytes: record.sizeBytes,
    storagePath: record.storagePath ?? `users/${record.ownerId}/${record.id}/${record.name}`,
    uploadStatus: record.uploadStatus,
    uploadSessionId: record.uploadSessionId ?? ''
  };
}

/** Rebuild the read model of a file, asserting the record really is one. */
function toDriveFile(record: StoredItem): DriveFile {
  return toDriveItem(record) as DriveFile;
}

/** Rebuild the read model of a folder, asserting the record really is one. */
function toDriveFolder(record: StoredItem): DriveFolder {
  return toDriveItem(record) as DriveFolder;
}

/** Bytes that count against the ceiling once a file has committed. */
function isCommitted(record: StoredItem): boolean {
  return record.type === 'file' && record.uploadStatus === 'committed';
}

/** Bytes held by a transfer that has reserved but not yet committed them. */
function isReserved(record: StoredItem): boolean {
  return record.type === 'file' && record.uploadStatus !== 'committed';
}

/** Yield to the event loop, so a long local transfer still repaints the queue. */
function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/* -------------------------------------------------------------------------- */
/* Repository                                                                  */
/* -------------------------------------------------------------------------- */

/** One live item subscription. */
interface ItemSubscription {
  readonly scope: DriveRepositoryScope;
  readonly listener: DriveItemsListener;
  readonly onError: DriveErrorListener | null;
}

/** One live profile subscription. */
interface ProfileSubscription {
  readonly listener: DriveProfileListener;
  readonly onError: DriveErrorListener | null;
}

/**
 * A complete drive, served from the browser.
 *
 * Construct it, `await` {@link MockDriveRepository.open}, and hand it to
 * `setActiveRepository`. From that point `driveStore` and `uploadQueueStore`
 * stop talking to Firestore and talk to this instead, through the same
 * {@link DriveRepository} contract a remote implementation would satisfy.
 */
export class MockDriveRepository implements DriveRepository {
  readonly mode: DriveMode = 'demo';

  /** The resident index. Authoritative; IndexedDB mirrors it. */
  readonly #items = new Map<string, StoredItem>();

  /** Blobs staged during seeding, so a write failure leaves nothing behind. */
  readonly #stagedBlobs = new Map<string, Blob>();

  #profile: StoredProfile | null = null;
  #storage: DemoStorage | null = null;
  #ready: Promise<void> | null = null;
  #destroyed = false;

  readonly #itemSubscriptions = new Set<ItemSubscription>();
  readonly #profileSubscriptions = new Set<ProfileSubscription>();

  /** Object URLs handed out and not yet released. */
  readonly #objectUrls = new Set<string>();

  /** Tail of the mutation queue; every write chains onto it. */
  #tail: Promise<unknown> = Promise.resolve();

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Load the drive, choosing a storage backend and seeding an empty one.
   *
   * Idempotent: concurrent callers share one open, and a call after the first
   * resolved is a no-op rather than a re-read.
   */
  async open(): Promise<void> {
    this.#ready ??= this.#bootstrap();
    return this.#ready;
  }

  async #bootstrap(): Promise<void> {
    this.#storage = await this.#createStorage();

    const stored = await this.#storage.readAllItems();
    for (const record of stored) this.#items.set(record.id, record);

    this.#profile = (await this.#storage.readProfile(DEMO_USER_ID)) ?? this.#createProfile();
    if (this.#items.size === 0) {
      await this.#seed();
    }
    // Written unconditionally: a drive reopened after a crash mid-write carries
    // a ledger that may be a few bytes out of date, and this is where it is
    // corrected from the items that are actually present.
    await this.#syncLedger();
  }

  /**
   * Pick a backend, degrading to memory when IndexedDB refuses.
   *
   * The refusal is not reported to the user: a drive that works for the session
   * is worth more than an error page explaining why it does not persist, and the
   * UI's demo-mode dialog already says the data is local.
   */
  async #createStorage(): Promise<DemoStorage> {
    const storage = new IndexedDbStorage();
    try {
      await storage.probe();
      return storage;
    } catch {
      storage.close();
      return new MemoryStorage();
    }
  }

  /** `true` when the drive survives a reload. `false` means memory-only. */
  get isPersistent(): boolean {
    return this.#storage?.persistent ?? false;
  }

  /** Release listeners, object URLs and the database handle. */
  destroy(): void {
    this.#destroyed = true;
    this.#itemSubscriptions.clear();
    this.#profileSubscriptions.clear();
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
    this.#stagedBlobs.clear();
    this.#storage?.close();
    this.#storage = null;
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  /** The local account, including the ledger as of the last change. */
  async getCurrentUser(): Promise<DriveUser> {
    await this.open();
    const profile = this.#requireProfile();
    return {
      uid: profile.uid,
      email: profile.email,
      displayName: profile.displayName,
      photoURL: profile.photoURL,
      quota: { ...profile.quota },
      createdAt: Timestamp.fromMillis(profile.createdAt),
      updatedAt: Timestamp.fromMillis(profile.updatedAt)
    };
  }

  /**
   * Live items for a scope, in `normalizedName` order.
   *
   * Returns its handle synchronously so the caller's teardown cannot race the
   * open, and delivers the first batch as soon as the drive is ready — which is
   * the same shape `onSnapshot` has: attach, then a delivery, then more.
   */
  subscribeItems(
    scope: DriveRepositoryScope,
    listener: DriveItemsListener,
    onError?: DriveErrorListener
  ): DriveSubscription {
    let closed = false;
    const subscription: ItemSubscription = { scope, listener, onError: onError ?? null };

    void this.open().then(
      () => {
        if (closed || this.#destroyed) return;
        this.#itemSubscriptions.add(subscription);
        this.#deliverItems(subscription);
      },
      (error: unknown) => {
        if (closed) return;
        this.#fail(subscription.onError, error);
      }
    );

    return {
      close: () => {
        closed = true;
        this.#itemSubscriptions.delete(subscription);
      }
    };
  }

  /** Live account document, so the storage meter tracks every write. */
  subscribeProfile(listener: DriveProfileListener, onError?: DriveErrorListener): DriveSubscription {
    let closed = false;
    const subscription: ProfileSubscription = { listener, onError: onError ?? null };

    void this.open().then(
      () => {
        if (closed || this.#destroyed) return;
        this.#profileSubscriptions.add(subscription);
        this.#deliverProfile(subscription);
      },
      (error: unknown) => {
        if (closed) return;
        this.#fail(subscription.onError, error);
      }
    );

    return {
      close: () => {
        closed = true;
        this.#profileSubscriptions.delete(subscription);
      }
    };
  }

  /** Items currently in the trash, including the descendants of trashed folders. */
  async countTrashed(): Promise<number> {
    await this.open();
    let total = 0;
    for (const record of this.#items.values()) {
      if (record.isTrashed) total += 1;
    }
    return total;
  }

  /** One item by id, or `null`. */
  async getItem(itemId: string): Promise<DriveItem | null> {
    await this.open();
    const record = this.#items.get(itemId);
    return record === undefined ? null : toDriveItem(record);
  }

  /** Every non-trashed folder, for the move picker. */
  async listFolders(): Promise<readonly DriveFolder[]> {
    await this.open();
    return [...this.#items.values()]
      .filter((record) => record.type === 'folder' && !record.isTrashed)
      .sort((left, right) => left.normalizedName.localeCompare(right.normalizedName))
      .map(toDriveFolder);
  }

  /* ------------------------------------------------------------------ */
  /* Writes                                                              */
  /* ------------------------------------------------------------------ */

  /** Create a folder under `parentFolderId`. */
  createFolder(
    name: string,
    parentFolderId: string | null,
    color: string | null = null
  ): Promise<DriveFolder> {
    return this.#enqueue(async () => {
      const validation = validateItemName(name);
      if (!validation.valid) {
        throw new Error('That folder name cannot be used.');
      }

      const index = this.#index();
      assertWritableParent(index, parentFolderId);

      const resolved = resolveFreeName(index, parentFolderId, new Set<string>(), validation.name);
      const stamp = now();
      const record: StoredItem = {
        id: newLocalId(),
        name: resolved.name,
        normalizedName: resolved.normalized,
        ownerId: DEMO_USER_ID,
        parentFolderId,
        type: 'folder',
        mimeType: null,
        sizeBytes: 0,
        storagePath: null,
        uploadStatus: 'committed',
        uploadSessionId: null,
        color,
        isTrashed: false,
        trashedAt: null,
        isStarred: false,
        createdAt: stamp,
        updatedAt: stamp
      };

      await this.#commit([record]);
      return toDriveFolder(record);
    });
  }

  /** Rename one item, resolving a name collision against its siblings. */
  renameItem(id: string, name: string): Promise<DriveItem> {
    return this.#enqueue(async () => {
      const validation = validateItemName(name);
      if (!validation.valid) {
        throw new Error('That name cannot be used.');
      }

      const record = this.#require(id);
      if (record.isTrashed) {
        throw new Error('Restore the item from the trash before renaming it.');
      }

      // A no-op rename must not re-suffix the item against itself.
      if (record.normalizedName === validation.normalized) {
        return toDriveItem(record);
      }

      const index = this.#index();
      const resolved = resolveFreeName(
        index,
        record.parentFolderId,
        new Set<string>([record.id]),
        validation.name
      );

      const next: StoredItem = {
        ...record,
        name: resolved.name,
        normalizedName: resolved.normalized,
        updatedAt: now()
      };
      await this.#commit([next]);
      return toDriveItem(next);
    });
  }

  /**
   * Move items into `destinationId`.
   *
   * Files re-resolve their name against the destination they are entering, with
   * every other participant in the move excluded — so dropping two identically
   * named files together does not make them collide with each other. Folders
   * keep their names: a folder's identity within its parent is not in question,
   * and a suffix there would be a rename nobody asked for.
   */
  moveItems(ids: readonly string[], destinationId: string | null): Promise<readonly string[]> {
    return this.#enqueue(async () => {
      const index = this.#index();
      assertWritableParent(index, destinationId);

      const moving = this.#records(ids).filter(
        (record) => !record.isTrashed && record.parentFolderId !== destinationId
      );
      if (moving.length === 0) return [];

      assertNoMoveCycles(index, moving.map(toDriveItem), destinationId);

      const stamp = now();
      const excluded = new Set<string>(moving.map((record) => record.id));
      const writes = moving.map((record) => {
        const relocated: StoredItem = { ...record, parentFolderId: destinationId, updatedAt: stamp };
        if (record.type !== 'file') return relocated;

        const resolved = resolveFreeName(index, destinationId, excluded, record.name);
        return { ...relocated, name: resolved.name, normalizedName: resolved.normalized };
      });

      await this.#commit(writes);
      return writes.map((record) => record.id);
    });
  }

  /** Move items to the trash, together with every descendant. */
  trashItems(ids: readonly string[]): Promise<readonly string[]> {
    return this.#enqueue(async () => {
      const roots = this.#records(ids).filter((record) => !record.isTrashed);
      if (roots.length === 0) return [];

      const stamp = now();
      const subtree = collectSubtree(this.#index(), roots.map(toDriveItem));
      const writes = subtree.map(({ item }) => ({
        ...this.#require(item.id),
        isTrashed: true,
        trashedAt: stamp,
        updatedAt: stamp
      }));

      await this.#commit(writes);
      return writes.map((record) => record.id);
    });
  }

  /**
   * Restore items from the trash.
   *
   * An item whose original parent is not part of this restore is reparented to
   * the root, so a folder trashed on its own while its children stayed reachable
   * cannot leave them permanently unrestorable.
   */
  restoreItems(ids: readonly string[]): Promise<readonly string[]> {
    return this.#enqueue(async () => {
      const roots = this.#records(ids).filter((record) => record.isTrashed);
      if (roots.length === 0) return [];

      const index = this.#index();
      const subtree = collectSubtree(index, roots.map(toDriveItem));
      const restoredIds = new Set<string>(subtree.map(({ item }) => item.id));

      const stamp = now();
      const writes = subtree.map(({ item }) => {
        const record = this.#require(item.id);
        return {
          ...record,
          isTrashed: false,
          trashedAt: null,
          parentFolderId: resolveRestoreParent(index, toDriveItem(record), restoredIds),
          updatedAt: stamp
        };
      });

      await this.#commit(writes);
      return writes.map((record) => record.id);
    });
  }

  /**
   * Delete trashed items and their bytes for good.
   *
   * Quota is reclaimed by recomputation rather than by a subtraction, so a
   * delete run against an already-deleted item — the idempotent case the trash
   * view relies on when a user acts twice — cannot underflow the ledger. Bytes
   * are dropped before the documents, matching the Firestore path's order, so a
   * failure in between leaves a tombstoned file the next attempt will finish
   * rather than a live document pointing at nothing.
   */
  permanentlyDelete(ids: readonly string[]): Promise<readonly string[]> {
    return this.#enqueue(async () => {
      const roots = this.#records(ids).filter((record) => record.isTrashed);
      if (roots.length === 0) return [];

      const removed = collectSubtree(this.#index(), roots.map(toDriveItem)).map(({ item }) => item.id);
      await this.#removeRecords(removed);
      return removed;
    });
  }

  /** Permanently delete every trashed item. */
  emptyTrash(): Promise<readonly string[]> {
    return this.#enqueue(async () => {
      const trashed = [...this.#items.values()]
        .filter((record) => record.isTrashed)
        .map(toDriveItem);
      if (trashed.length === 0) return [];

      const removed = collectSubtree(this.#index(), subtreeRoots(trashed)).map(({ item }) => item.id);
      await this.#removeRecords(removed);
      return removed;
    });
  }

  /** Set or clear the star on a set of items. */
  setStarred(ids: readonly string[], starred: boolean): Promise<readonly string[]> {
    return this.#enqueue(async () => {
      const records = this.#records(ids);
      if (records.length === 0) return [];

      const stamp = now();
      const writes = records
        .filter((record) => record.isStarred !== starred)
        .map((record) => ({ ...record, isStarred: starred, updatedAt: stamp }));

      if (writes.length === 0) return records.map((record) => record.id);
      await this.#commit(writes);
      return writes.map((record) => record.id);
    });
  }

  /**
   * Apply a field patch to one folder.
   *
   * A name change goes through the same collision resolver as a rename, because
   * it is a rename — a folder edited from a context menu must not be able to
   * take a name a sibling already holds.
   */
  updateFolder(folderId: string, patch: DriveRepositoryFolderPatch): Promise<DriveFolder> {
    return this.#enqueue(async () => {
      const record = this.#require(folderId);
      if (record.type !== 'folder') {
        throw new Error('Only a folder can be edited this way.');
      }
      if (record.isTrashed) {
        throw new Error('Restore the folder from the trash before editing it.');
      }

      let next: StoredItem = { ...record, updatedAt: now() };

      if (patch.name !== undefined) {
        const validation = validateItemName(patch.name);
        if (!validation.valid) {
          throw new Error('That name cannot be used.');
        }
        if (validation.normalized !== record.normalizedName) {
          const resolved = resolveFreeName(
            this.#index(),
            record.parentFolderId,
            new Set<string>([record.id]),
            validation.name
          );
          next = { ...next, name: resolved.name, normalizedName: resolved.normalized };
        }
      }

      if (patch.color !== undefined) next = { ...next, color: patch.color };
      if (patch.isStarred !== undefined) next = { ...next, isStarred: patch.isStarred };

      await this.#commit([next]);
      return toDriveFolder(next);
    });
  }

  /**
   * Store a file's bytes and its metadata, in the same three phases a remote
   * upload uses.
   *
   * 1. **Reserve** — the item is created as `reserved` and its bytes are held
   *    against the ceiling, so a full drive is refused before a single byte is
   *    read rather than after.
   * 2. **Stream** — the blob is read in chunks and each one is reported. The
   *    yield between chunks is what makes the progress bar real: without it the
   *    whole read would complete inside a single task and the queue would jump
   *    from 0 to 100.
   * 3. **Commit** — the bytes are written to storage and the status becomes
   *    `committed`, moving them from reserved to used.
   *
   * An abort at any phase removes the item and releases the hold, so a cancelled
   * upload leaves nothing behind — the same compensation the remote path
   * performs, arrived at the same way.
   */
  uploadFile(
    file: File,
    targetFolderId: string | null,
    onProgress?: DriveProgressListener,
    signal?: AbortSignal
  ): Promise<DriveFile> {
    return this.#enqueue(async () => {
      this.#throwIfAborted(signal);

      const index = this.#index();
      assertWritableParent(index, targetFolderId);

      const profile = this.#requireProfile();
      const sizeBytes = file.size;
      const available = profile.quota.totalBytes - profile.quota.usedBytes - profile.quota.reservedBytes;
      if (sizeBytes > available) {
        throw new DriveQuotaError();
      }

      // A file whose name the drive would refuse — an empty `File`, a name the
      // OS reserves — still gets stored, under a name the drive will accept.
      const validation = validateItemName(file.name);
      const resolved = resolveFreeName(
        index,
        targetFolderId,
        new Set<string>(),
        validation.valid ? validation.name : 'Untitled'
      );

      const itemId = newLocalId();
      const stamp = now();
      const reserved: StoredItem = {
        id: itemId,
        name: resolved.name,
        normalizedName: resolved.normalized,
        ownerId: DEMO_USER_ID,
        parentFolderId: targetFolderId,
        type: 'file',
        mimeType: resolveMimeType({ name: file.name, type: file.type }),
        sizeBytes,
        storagePath: `users/${DEMO_USER_ID}/${itemId}/${resolved.name}`,
        uploadStatus: 'reserved',
        uploadSessionId: newLocalId(),
        color: null,
        isTrashed: false,
        trashedAt: null,
        isStarred: false,
        createdAt: stamp,
        updatedAt: stamp
      };

      await this.#commit([reserved]);
      this.#report(onProgress, 0, sizeBytes);

      try {
        const uploading: StoredItem = { ...reserved, uploadStatus: 'uploading', updatedAt: now() };
        await this.#commit([uploading]);

        let transferred = 0;
        while (transferred < sizeBytes) {
          this.#throwIfAborted(signal);
          const end = Math.min(transferred + UPLOAD_CHUNK_BYTES, sizeBytes);
          await file.slice(transferred, end).arrayBuffer();
          transferred = end;
          this.#report(onProgress, transferred, sizeBytes);
          await nextTick();
        }

        this.#throwIfAborted(signal);
        await this.#requireStorage().writeFile({ itemId, blob: file, sizeBytes });

        const committed: StoredItem = { ...uploading, uploadStatus: 'committed', updatedAt: now() };
        await this.#commit([committed]);
        this.#report(onProgress, sizeBytes, sizeBytes);

        return toDriveFile(committed);
      } catch (error) {
        await this.#removeRecords([itemId]);
        throw error;
      }
    });
  }

  /**
   * A URL the browser can read the bytes from.
   *
   * An object URL, because the bytes are in this process and there is nothing to
   * sign. The URL is tracked so {@link releaseObjectUrl} can revoke it; an
   * unreleased one pins the blob in memory for the life of the document.
   */
  async getDownloadURL(item: DriveFile): Promise<string> {
    await this.open();
    const record = await this.#requireStorage().readFile(item.id);
    if (record === null) {
      throw new Error('This file has no stored content.');
    }

    const url = URL.createObjectURL(record.blob);
    this.#objectUrls.add(url);
    return url;
  }

  /** Revoke an object URL previously returned by {@link getDownloadURL}. */
  releaseObjectUrl(url: string): void {
    if (!this.#objectUrls.delete(url)) return;
    URL.revokeObjectURL(url);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Serialise every mutation, after the drive is open.
   *
   * The queue never rejects, so one failed write cannot stall the writes behind
   * it; the caller still receives the original outcome.
   */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      await this.open();
      return work();
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * The open storage backend.
   *
   * Named apart from the field on purpose: a private field and a private method
   * may not share a name, and calling one while reading the other is exactly
   * the confusion the split avoids.
   */
  #requireStorage(): DemoStorage {
    const storage = this.#storage;
    if (storage === null) {
      throw new Error('The local drive is not open.');
    }
    return storage;
  }

  #requireProfile(): StoredProfile {
    const profile = this.#profile;
    if (profile === null) {
      throw new Error('The local account could not be read.');
    }
    return profile;
  }

  #require(itemId: string): StoredItem {
    const record = this.#items.get(itemId);
    if (record === undefined) {
      throw new Error('That item no longer exists.');
    }
    return record;
  }

  /** Records for the given ids that are present, in the order requested. */
  #records(ids: readonly string[]): StoredItem[] {
    const found: StoredItem[] = [];
    for (const id of ids) {
      const record = this.#items.get(id);
      if (record !== undefined) found.push(record);
    }
    return found;
  }

  /** A fresh index over the current items. Built per operation, never cached. */
  #index(): DriveItemIndex {
    return new DriveItemIndex([...this.#items.values()].map(toDriveItem));
  }

  /** Report progress, treating a zero-byte file as instantly complete. */
  #report(listener: DriveProgressListener | undefined, bytesTransferred: number, totalBytes: number): void {
    listener?.({
      bytesTransferred,
      totalBytes,
      ratio: totalBytes === 0 ? 1 : Math.min(1, bytesTransferred / totalBytes)
    });
  }

  /** Throw a cancellation the shared classifier already understands. */
  #throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal === undefined || !signal.aborted) return;
    const error = new Error('Upload cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  /**
   * Persist a batch of item records, re-derive the ledger, then notify.
   *
   * The order matters. Items are durable before the ledger is recomputed, so a
   * crash between the two leaves a stale number rather than a number describing
   * items that were never written — and a stale number is self-correcting on the
   * next open, while the reverse is not.
   */
  async #commit(records: readonly StoredItem[], removedIds: readonly string[] = []): Promise<void> {
    if (this.#destroyed) return;
    if (records.length === 0 && removedIds.length === 0) return;

    for (const record of records) this.#items.set(record.id, record);
    for (const id of removedIds) this.#items.delete(id);

    await this.#requireStorage().writeItems(records);
    if (removedIds.length > 0) await this.#requireStorage().deleteItems(removedIds);
    await this.#syncLedger();
    this.#emitAll();
  }

  /**
   * Remove items and their bytes.
   *
   * Bytes go first. A file whose document outlives its blob is a row that cannot
   * be previewed or downloaded; a blob whose document is already gone is
   * unreachable and reclaimed by the browser on its own.
   */
  async #removeRecords(ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || this.#destroyed) return;
    await this.#requireStorage().deleteFiles(ids);
    await this.#commit([], ids);
  }

  /** Recompute the ledger from the items and persist it. */
  async #syncLedger(): Promise<void> {
    const profile = this.#requireProfile();
    let usedBytes = 0;
    let reservedBytes = 0;

    for (const record of this.#items.values()) {
      if (isCommitted(record)) usedBytes += record.sizeBytes;
      else if (isReserved(record)) reservedBytes += record.sizeBytes;
    }

    const next: StoredProfile = {
      ...profile,
      quota: { usedBytes, reservedBytes, totalBytes: profile.quota.totalBytes },
      updatedAt: now()
    };
    this.#profile = next;
    await this.#requireStorage().writeProfile(next);
  }

  /** Deliver the current contents of a scope to one subscription. */
  #deliverItems(subscription: ItemSubscription): void {
    const { scope } = subscription;

    const matches = [...this.#items.values()].filter((record) => {
      if (scope.kind === 'trash') return record.isTrashed;
      if (record.isTrashed) return false;
      if (scope.kind === 'starred') return record.isStarred;
      return record.parentFolderId === scope.folderId;
    });

    matches.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));

    try {
      subscription.listener(matches.map(toDriveItem));
    } catch (error) {
      this.#fail(subscription.onError, error);
    }
  }

  #deliverProfile(subscription: ProfileSubscription): void {
    const profile = this.#requireProfile();
    try {
      subscription.listener({
        uid: profile.uid,
        email: profile.email,
        displayName: profile.displayName,
        photoURL: profile.photoURL,
        quota: { ...profile.quota },
        createdAt: Timestamp.fromMillis(profile.createdAt),
        updatedAt: Timestamp.fromMillis(profile.updatedAt)
      });
    } catch (error) {
      this.#fail(subscription.onError, error);
    }
  }

  /** Push the current state to every listener. */
  #emitAll(): void {
    for (const subscription of [...this.#itemSubscriptions]) this.#deliverItems(subscription);
    for (const subscription of [...this.#profileSubscriptions]) this.#deliverProfile(subscription);
  }

  #fail(listener: DriveErrorListener | null, error: unknown): void {
    if (listener === null) return;
    listener(error);
  }

  #createProfile(): StoredProfile {
    const stamp = now();
    return {
      uid: DEMO_USER_ID,
      displayName: DEMO_USER_DISPLAY_NAME,
      email: DEMO_USER_EMAIL,
      photoURL: null,
      quota: { usedBytes: 0, reservedBytes: 0, totalBytes: DEMO_QUOTA_TOTAL_BYTES },
      createdAt: stamp,
      updatedAt: stamp
    };
  }

  /**
   * Plant the welcome folder.
   *
   * Runs only when the drive is completely empty, so it can never resurrect
   * content a user deleted on purpose. An image that will not decode costs the
   * image, not the drive.
   */
  async #seed(): Promise<void> {
    const stamp = now();
    const folderId = newLocalId();

    const folder: StoredItem = {
      id: folderId,
      name: SEED_FOLDER_NAME,
      normalizedName: SEED_FOLDER_NAME.toLowerCase(),
      ownerId: DEMO_USER_ID,
      parentFolderId: null,
      type: 'folder',
      mimeType: null,
      sizeBytes: 0,
      storagePath: null,
      uploadStatus: 'committed',
      uploadSessionId: null,
      color: null,
      isTrashed: false,
      trashedAt: null,
      isStarred: false,
      createdAt: stamp,
      updatedAt: stamp
    };

    const image = this.#seedImage();
    const seeds: StoredItem[] = [
      this.#seedFile(folderId, SEED_README_NAME, SEED_README_MIME, new Blob([SEED_README_BODY], { type: SEED_README_MIME }), stamp),
      ...(image === null ? [] : [this.#seedFile(folderId, SEED_IMAGE_NAME, SEED_IMAGE_MIME, image, stamp)])
    ];

    const staged = [...this.#stagedBlobs.entries()];
    this.#stagedBlobs.clear();

    this.#items.set(folder.id, folder);
    for (const record of seeds) this.#items.set(record.id, record);

    await this.#requireStorage().writeItems([folder, ...seeds]);
    for (const [itemId, blob] of staged) {
      await this.#requireStorage().writeFile({ itemId, blob, sizeBytes: blob.size });
    }
  }

  #seedFile(parentFolderId: string, name: string, mimeType: string, blob: Blob, stamp: number): StoredItem {
    const id = newLocalId();
    this.#stagedBlobs.set(id, blob);
    return {
      id,
      name,
      normalizedName: name.toLowerCase(),
      ownerId: DEMO_USER_ID,
      parentFolderId,
      type: 'file',
      mimeType,
      sizeBytes: blob.size,
      storagePath: `users/${DEMO_USER_ID}/${id}/${name}`,
      uploadStatus: 'committed',
      uploadSessionId: id,
      color: null,
      isTrashed: false,
      trashedAt: null,
      isStarred: false,
      createdAt: stamp,
      updatedAt: stamp
    };
  }

  /** The packaged sample image, or `null` when it cannot be decoded here. */
  #seedImage(): Blob | null {
    return decodeSeedImage();
  }
}
