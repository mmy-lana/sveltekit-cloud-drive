/**
 * Real-time item state and every write that touches Firestore.
 *
 * Scope model
 * -----------
 * The store is subscribed to exactly one *scope* at a time — a folder's
 * children, the starred set, or the trash — and the filter/sort state is
 * applied in memory on top of that subscription. Two reasons:
 *
 * 1. A composite server query per filter combination would need a
 *    `Firestore` index per sort field, and would re-subscribe on every change to
 *    the sort control.
 * 2. Server `orderBy` on `sizeBytes` would *drop folders from the result
 *    entirely*, because Firestore excludes documents missing the ordered field
 *    from an ordering. Sorting client-side is the only way a folder and a file
 *    can appear in one size-ordered list.
 *
 * A stable `orderBy(normalizedName)` is still issued on the wire so the
 * emulator's composite indexes are exercised and the result order is
 * deterministic between snapshots.
 *
 * Optimism boundary
 * -----------------
 * Selection, view mode and the search query are optimistic because they are
 * presentation state owned by this device. Nothing here updates `items` ahead
 * of Firestore: quota, upload status and trash state only ever move when a
 * transaction commits, which is what keeps the on-screen numbers honest.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type FirestoreError,
  type QueryConstraint,
  type Transaction,
  type Unsubscribe
} from 'firebase/firestore';
import { SvelteMap } from 'svelte/reactivity';
import { getFirestoreClient, getStorageClient } from '$lib/firebase/client';
import { classifyError, type ClassifiedError } from '$lib/firebase/errors';
import { authStore } from '$lib/stores/authStore.svelte';
import {
  MAX_ANCESTOR_DEPTH,
  MAX_BATCH_OPERATIONS,
  MAX_IN_QUERY_VALUES
} from '$lib/config/constants';
import { chunk, forEachChunk } from '$lib/utils/chunk';
import { toDriveItem } from '$lib/domain/deserialize';
import {
  assertWritableParent,
  isDescendantOf,
  runBoundedTransaction
} from '$lib/domain/transactions';
import { getFileMimeDescriptor, resolveMimeType } from '$lib/utils/mimetypes';
import {
  normalizeItemName,
  resolveNameCollision,
  validateItemName,
  type NameValidation
} from '$lib/domain/itemNames';
import {
  getItemSizeBytes,
  isDriveFile,
  isDriveFolder,
  type DriveFile,
  type DriveFolder,
  type DriveItem,
  type ItemType,
  type UpdateItemPatch
} from '$lib/types/drive';
import { deleteObject, ref as storageRef } from 'firebase/storage';
import type { BreadcrumbNode } from '$lib/types/drive';

/** Documents fetched per page when paging the folder tree. */
const FOLDER_PAGE_SIZE = 200;

/**
 * Page ceiling for the folder tree.
 *
 * A guard rather than a limit in the usual sense: twenty pages is four
 * thousand folders, past which the tree is unusable as a picker anyway and the
 * honest outcome is a truncated list the caller can see the end of.
 */
const MAX_FOLDER_TREE_PAGES = 20;

/** Which collection of items the store is currently subscribed to. */
export type DriveScope =
  | { readonly kind: 'folder'; readonly folderId: string | null }
  | { readonly kind: 'starred' }
  | { readonly kind: 'trash' };

/** Filter and sort applied to the subscribed set. Presentation only. */
export interface FilterSortState {
  searchQuery: string;
  itemType: 'all' | ItemType;
  showOnlyStarred: boolean;
  sortBy: 'name' | 'updatedAt' | 'sizeBytes';
  sortDirection: 'asc' | 'desc';
}

/**
 * Upper bound on the rows read when enumerating the trash.
 *
 * A whole-drive scan is only ever used to empty the trash, and an unbounded
 * `getDocs` would pull every document an account has ever written.
 */
const MAX_TRASH_SCAN_LIMIT = 2000;

/** Attempts before a contended transaction is reported as a failure. */
const TRANSACTION_ATTEMPTS = 3;

/**
 * Attempts allowed for name resolution, covering both transaction contention
 * and the post-commit uniqueness re-check.
 */
const NAME_RESOLUTION_ATTEMPTS = 3;

/** A name paired with the collision key derived from it. */
interface ResolvedName {
  readonly name: string;
  readonly normalized: string;
}

const DEFAULT_FILTERS: FilterSortState = Object.freeze({
  searchQuery: '',
  itemType: 'all',
  showOnlyStarred: false,
  sortBy: 'name',
  sortDirection: 'asc'
});

/** Result of a write that the UI may need to surface. */
export interface MutationResult {
  readonly ok: boolean;
  /** Set when `ok` is false. */
  readonly error?: ClassifiedError;
  /** Item ids the operation actually touched, for selection reconciliation. */
  readonly affectedIds?: readonly string[];
}

const ok = (affectedIds: readonly string[] = []): MutationResult => ({ ok: true, affectedIds });
const fail = (error: unknown, affectedIds: readonly string[] = []): MutationResult => ({
  ok: false,
  error: classifyError(error),
  affectedIds
});

export class DriveStore {
  /** Items in the active subscription. Reactive so `$derived` tracks it. */
  readonly #items = new SvelteMap<string, DriveItem>();

  /** Ancestor folders loaded on demand for breadcrumb resolution. */
  readonly #ancestors = new SvelteMap<string, DriveFolder>();

  /**
   * Every folder the account owns outside the trash, for the move picker.
   *
   * A separate map from `#items` because the tree has the opposite shape: it
   * spans the whole account rather than one scope, and it is loaded on demand
   * instead of live. Folders are few — a drive that reached ten thousand of them
   * would be unusable as a drive long before the query became the bottleneck.
   */
  readonly #folderIndex = new SvelteMap<string, DriveFolder>();
  #folderTreeStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  /** De-dupes concurrent `loadFolderTree()` calls from two open pickers. */
  #folderTreeRequest: Promise<void> | null = null;

  #scope = $state<DriveScope>({ kind: 'folder', folderId: null });
  #filters = $state<FilterSortState>({ ...DEFAULT_FILTERS });
  #status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  #error = $state<ClassifiedError | null>(null);
  #pendingCount = $state(0);

  #unsubscribe: Unsubscribe | null = null;
  /** Resolves when the in-flight subscription for the current scope settles. */
  #firstSnapshot = $state(false);

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                    */
  /* ---------------------------------------------------------------------- */

  /** The active scope. */
  get scope(): DriveScope {
    return this.#scope;
  }

  /** Current filter and sort state. */
  get filters(): FilterSortState {
    return this.#filters;
  }

  /** `true` while the first snapshot for the current scope is still in flight. */
  get isLoading(): boolean {
    return this.#status === 'loading';
  }

  /** `true` once a snapshot has been applied for the current scope. */
  get hasLoaded(): boolean {
    return this.#firstSnapshot;
  }

  /** Last subscription or mutation failure. */
  get error(): ClassifiedError | null {
    return this.#error;
  }

  /** Number of write operations currently in flight. */
  get pendingOperations(): number {
    return this.#pendingCount;
  }

  /** `true` when any write is in flight, for the shell's busy indicator. */
  get isBusy(): boolean {
    return this.#pendingCount > 0;
  }

  /** The folder uploads should land in — never the trash, never a star view. */
  get uploadTargetFolderId(): string | null {
    return this.#scope.kind === 'folder' ? this.#scope.folderId : null;
  }

  /** Every subscribed item, unordered. */
  get allItems(): DriveItem[] {
    return [...this.#items.values()];
  }

  /** Subscribed items after filtering and sorting. */
  get visibleItems(): DriveItem[] {
    const query = this.#filters.searchQuery.trim().toLowerCase();
    const type = this.#filters.itemType;

    const filtered = [...this.#items.values()].filter((item) => {
      if (type !== 'all' && item.type !== type) return false;
      if (this.#filters.showOnlyStarred && !item.isStarred) return false;
      if (query.length > 0 && !item.normalizedName.includes(query)) return false;
      return true;
    });

    return sortItems(filtered, this.#filters.sortBy, this.#filters.sortDirection);
  }

  /** Visible items of one type — the default "folders first" listing order. */
  get organizedItems(): DriveItem[] {
    const sorted = this.visibleItems;
    if (this.#filters.sortBy === 'name') {
      return [...sorted].sort((left, right) => {
        if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
        return 0;
      });
    }
    return sorted;
  }

  /** Look up a subscribed item by id. */
  getItem(id: string): DriveItem | null {
    return this.#items.get(id) ?? this.#ancestors.get(id) ?? null;
  }

  /** Look up a subscribed item, narrowed to a folder. */
  getFolder(id: string): DriveFolder | null {
    const item = this.getItem(id);
    return isDriveFolder(item) ? item : null;
  }

  /** Look up a subscribed item, narrowed to a file. */
  getFile(id: string): DriveFile | null {
    const item = this.getItem(id);
    return isDriveFile(item) ? item : null;
  }

  /**
   * The path from the root to the current folder.
   *
   * Ancestors are fetched by id on scope transitions and cached in a flat map,
   * so opening a folder deep in the tree costs one query per *new* ancestor
   * rather than a traversal round-trip per level on every navigation.
   */
  get breadcrumbs(): BreadcrumbNode[] {
    const trail: BreadcrumbNode[] = [{ id: null, name: 'My Drive' }];
    if (this.#scope.kind !== 'folder' || this.#scope.folderId === null) return trail;

    const chain: DriveFolder[] = [];
    let cursor: string | null = this.#scope.folderId;
    let guard = 0;

    while (cursor !== null && guard < MAX_ANCESTOR_DEPTH) {
      const folder: DriveFolder | null = this.#ancestors.get(cursor) ?? null;
      if (folder === null) break;
      chain.push(folder);
      cursor = folder.parentFolderId;
      guard += 1;
    }

    // Collected leaf-first, so reverse to render root-first.
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const folder: DriveFolder = chain[index];
      trail.push({ id: folder.id, name: folder.name });
    }
    return trail;
  }

  /** Title for the header, reflecting the active scope. */
  get scopeTitle(): string {
    if (this.#scope.kind === 'starred') return 'Starred';
    if (this.#scope.kind === 'trash') return 'Trash';
    if (this.#scope.folderId === null) return 'My Drive';
    return this.getFolder(this.#scope.folderId)?.name ?? 'Folder';
  }

  /* ---------------------------------------------------------------------- */
  /* Subscription                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Subscribe to a scope, replacing any current subscription.
   *
   * Safe to call before sign-in completes: it records the intent, and the
   * subscription is established by {@link #sync} once a uid exists.
   */
  openScope(scope: DriveScope): void {
    this.#scope = scope;
    this.#firstSnapshot = false;
    this.#status = 'loading';
    this.#error = null;
    this.#resubscribe();
  }

  /** Patch the filter/sort state. Presentation only, so this is immediate. */
  setFilters(patch: Partial<FilterSortState>): void {
    this.#filters = { ...this.#filters, ...patch };
  }

  /** Restore every filter to its default. */
  resetFilters(): void {
    this.#filters = { ...DEFAULT_FILTERS };
  }

  /**
   * Re-establish the subscription if a uid is now available.
   *
   * Called by the shell after sign-in, and again whenever the scope changes.
   */
  sync(): void {
    this.#resubscribe();
  }

  #resubscribe(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;

    const uid = authStore.uid;
    if (uid === null) return;

    const constraints: QueryConstraint[] = [where('ownerId', '==', uid)];

    if (this.#scope.kind === 'trash') {
      constraints.push(where('isTrashed', '==', true));
    } else if (this.#scope.kind === 'starred') {
      constraints.push(where('isTrashed', '==', false), where('isStarred', '==', true));
    } else {
      constraints.push(where('isTrashed', '==', false), where('parentFolderId', '==', this.#scope.folderId));
    }

    // Stable server ordering; the user-selected sort is applied in memory.
    // This is what makes the emulator's composite indexes load-bearing and
    // keeps the result order identical between two consecutive snapshots.
    constraints.push(orderBy('normalizedName', 'asc'));

    const itemsQuery = query(collection(getFirestoreClient(), 'items'), ...constraints);

    this.#status = 'loading';
    this.#unsubscribe = onSnapshot(
      itemsQuery,
      (snapshot) => {
        const next = new SvelteMap<string, DriveItem>();
        for (const docSnapshot of snapshot.docs) {
          const item = toDriveItem(docSnapshot.id, docSnapshot.data());
          if (item !== null) next.set(item.id, item);
        }
        this.#items.clear();
        for (const [key, value] of next) this.#items.set(key, value);
        this.#firstSnapshot = true;
        this.#status = 'ready';
      },
      (error: FirestoreError) => {
        this.#error = classifyError(error);
        this.#status = 'error';
        this.#firstSnapshot = true;
      }
    );

    if (this.#scope.kind === 'folder' && this.#scope.folderId !== null) {
      void this.#loadAncestors(this.#scope.folderId);
    }
  }

  /**
   * Walk a folder's lineage into the flat ancestor cache.
   *
   * Each level is one point lookup and the chain stops at the first id already
   * cached, so re-entering a folder the user has visited before costs nothing.
   */
  async #loadAncestors(folderId: string): Promise<void> {
    if (this.#ancestors.has(folderId)) return;
    const uid = authStore.uid;
    if (uid === null) return;

    let cursor: string | null = folderId;
    let guard = 0;

    try {
      while (cursor !== null && guard < MAX_ANCESTOR_DEPTH) {
        const existing = this.#ancestors.get(cursor);
        if (existing !== undefined) {
          cursor = existing.parentFolderId;
          guard += 1;
          continue;
        }

        const snapshot = await getDoc(doc(getFirestoreClient(), 'items', cursor));
        if (!snapshot.exists()) break;

        const item = toDriveItem(snapshot.id, snapshot.data());
        if (item === null || !isDriveFolder(item)) break;

        this.#ancestors.set(item.id, item);
        cursor = item.parentFolderId;
        guard += 1;
      }
    } catch (error) {
      // A breadcrumb that fails to load degrades to a shallower trail; the
      // listing itself is unaffected, so this is reported but not thrown.
      this.#error = classifyError(error);
    }
  }

  /** Stop the subscription. Called by the shell on destroy. */
  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#folderIndex.clear();
    this.#folderTreeStatus = 'idle';
    this.#folderTreeRequest = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Folder tree                                                               */
  /* ---------------------------------------------------------------------- */

  /** Every non-trashed folder in the loaded index, for search over the tree. */
  get indexedFolders(): readonly DriveFolder[] {
    return [...this.#folderIndex.values()];
  }

  /** `true` while the move picker's folder tree is being fetched. */
  get isLoadingFolderTree(): boolean {
    return this.#folderTreeStatus === 'loading';
  }

  /** `true` once the folder tree has been fetched at least once. */
  get hasFolderTree(): boolean {
    return this.#folderTreeStatus === 'ready';
  }

  /**
   * Fetch every non-trashed folder in the account, paginated.
   *
   * Loading is idempotent and shared: opening a second picker while the first
   * fetch is in flight awaits the same promise rather than issuing a second
   * query. A failure leaves the previously loaded tree in place, so a picker
   * that was already usable stays usable.
   */
  loadFolderTree(): Promise<void> {
    if (this.#folderTreeStatus === 'ready' && this.#folderIndex.size > 0) {
      return Promise.resolve();
    }
    if (this.#folderTreeRequest !== null) return this.#folderTreeRequest;

    const uid = authStore.uid;
    if (uid === null) return Promise.resolve();

    this.#folderTreeStatus = 'loading';

    const request = (async () => {
      const db = getFirestoreClient();
      try {
        const base = query(
          collection(db, 'items'),
          where('ownerId', '==', uid),
          where('type', '==', 'folder'),
          where('isTrashed', '==', false),
          orderBy('normalizedName', 'asc')
        );

        // Paginated rather than `getDocs` in one shot: a Firestore read returns
        // at most a bounded result set, and silently truncating a folder tree
        // would make some destinations unreachable with no way to tell.
        let page = await getDocs(query(base, limit(FOLDER_PAGE_SIZE)));
        let guard = 0;

        for (;;) {
          for (const snapshot of page.docs) {
            const item = toDriveItem(snapshot.id, snapshot.data());
            if (item !== null && isDriveFolder(item)) this.#folderIndex.set(item.id, item);
          }

          if (page.docs.length < FOLDER_PAGE_SIZE) break;
          guard += 1;
          if (guard >= MAX_FOLDER_TREE_PAGES) break;

          const cursor = page.docs[page.docs.length - 1];
          if (cursor === undefined) break;
          page = await getDocs(query(base, limit(FOLDER_PAGE_SIZE), startAfter(cursor)));
        }

        this.#folderTreeStatus = 'ready';
      } catch (error) {
        this.#folderTreeStatus = 'error';
        this.#error = classifyError(error);
      } finally {
        this.#folderTreeRequest = null;
      }
    })();

    this.#folderTreeRequest = request;
    return request;
  }

  /** Children of a folder in the loaded tree. `null` means the drive root. */
  folderChildren(parentId: string | null): DriveFolder[] {
    const result: DriveFolder[] = [];
    for (const folder of this.#folderIndex.values()) {
      if (folder.parentFolderId === parentId && !folder.isTrashed) result.push(folder);
    }
    return result.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
  }

  /** A folder in the loaded tree, if it is present. */
  folderFromIndex(id: string): DriveFolder | null {
    return this.#folderIndex.get(id) ?? null;
  }

  /**
   * Ids of every folder beneath `rootId`, excluding `rootId` itself.
   *
   * Computed from the loaded index by walking downward. A cycle in the stored
   * parent links — which the rules should prevent but a manual write could
   * create — terminates on a visited set rather than looping forever.
   */
  descendantFolderIds(rootId: string): Set<string> {
    const childrenOf = new Map<string, string[]>();
    for (const folder of this.#folderIndex.values()) {
      const parent = folder.parentFolderId;
      if (parent === null) continue;
      const bucket = childrenOf.get(parent);
      if (bucket === undefined) childrenOf.set(parent, [folder.id]);
      else bucket.push(folder.id);
    }

    const found = new Set<string>();
    const stack = [...(childrenOf.get(rootId) ?? [])];

    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || found.has(id)) continue;
      found.add(id);
      for (const child of childrenOf.get(id) ?? []) stack.push(child);
    }

    return found;
  }

  /* ---------------------------------------------------------------------- */
  /* Write operations                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Create a folder under `parentFolderId`.
   *
   * The collision check runs *inside* the transaction, not before it: reading
   * siblings outside would leave a window in which two concurrent creates both
   * see a free name and both write it.
   */
  async createFolder(
    name: string,
    parentFolderId: string | null,
    color: string | null = null
  ): Promise<{ result: MutationResult; validation: NameValidation }> {
    const validation = validateItemName(name);
    if (!validation.valid) {
      return { result: { ok: false }, validation };
    }

    const uid = authStore.uid;
    if (uid === null) return { result: fail(new Error('Not signed in.')), validation };

    const folderId = newItemId();
    this.#pendingCount += 1;
    try {
      const db = getFirestoreClient();
      await runBoundedTransaction(db, async (tx) => {
        await assertWritableParent(tx, parentFolderId);
      });

      await runNameTransaction(uid, parentFolderId, new Set(), validation.name, (tx, resolved) => {
        tx.set(doc(db, 'items', folderId), {
          id: folderId,
          name: resolved.name,
          normalizedName: resolved.normalized,
          ownerId: uid,
          parentFolderId,
          type: 'folder' as const,
          color,
          isTrashed: false,
          trashedAt: null,
          isStarred: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      });

      return { result: ok([folderId]), validation };
    } catch (error) {
      return { result: fail(error), validation };
    } finally {
      this.#pendingCount -= 1;
    }
  }

  /**
   * Rename one item, appending a numeric suffix on collision.
   *
   * Renaming a trashed item is refused rather than silently redirected, since
   * the sibling set of a trashed folder is not the one the user is looking at.
   */
  async renameItem(itemId: string, name: string): Promise<{ result: MutationResult; validation: NameValidation }> {
    const validation = validateItemName(name);
    if (!validation.valid) {
      return { result: { ok: false }, validation };
    }

    const uid = authStore.uid;
    const item = this.getItem(itemId);
    if (uid === null || item === null) {
      return { result: fail(new Error('Item is no longer available.')), validation };
    }
    if (item.isTrashed) {
      return {
        result: {
          ok: false,
          error: {
            kind: 'invalid-argument',
            message: 'Restore the item from the trash before renaming it.',
            retryable: false,
            cause: null
          }
        },
        validation
      };
    }

    this.#pendingCount += 1;
    try {
      const db = getFirestoreClient();
      await runNameTransaction(
        uid,
        item.parentFolderId,
        new Set([itemId]),
        validation.name,
        (tx, resolved) => {
          tx.update(doc(db, 'items', itemId), {
            name: resolved.name,
            normalizedName: resolved.normalized,
            updatedAt: serverTimestamp()
          });
        }
      );

      return { result: ok([itemId]), validation };
    } catch (error) {
      return { result: fail(error), validation };
    } finally {
      this.#pendingCount -= 1;
    }
  }

  /**
   * Move items into `destinationId`.
   *
   * A folder move is transactional and walks the destination's lineage to prove
   * the destination is neither the folder itself nor one of its descendants —
   * without that check, dropping a folder into its own child would detach the
   * subtree from the drive and every later read of it would fail.
   */
  async moveItems(itemIds: readonly string[], destinationId: string | null): Promise<MutationResult> {
    const uid = authStore.uid;
    if (uid === null) return fail(new Error('Not signed in.'));

    const targets = itemIds
      .map((id) => this.getItem(id))
      .filter((item): item is DriveItem => item !== null && !item.isTrashed);

    if (targets.length === 0) return ok(itemIds);

    // A no-op move would still burn a transaction and re-suffix a name.
    const moving = targets.filter((item) => item.parentFolderId !== destinationId);
    if (moving.length === 0) return ok(itemIds);

    const movingIds = new Set(moving.map((item) => item.id));
    this.#pendingCount += 1;

    try {
      const db = getFirestoreClient();

      // The parent and lineage checks are their own transaction, because a
      // transaction cannot span the name-resolution reads and still be retried
      // independently: an aborted cycle check must not discard a commit.
      await runBoundedTransaction(db, async (tx) => {
        await assertWritableParent(tx, destinationId);

        // Every folder taking part in the move blocks a cyclic destination.
        for (const item of moving) {
          if (!isDriveFolder(item)) continue;
          if (item.id === destinationId) {
            throw new MoveCycleError('A folder cannot be moved into itself.');
          }
          if (destinationId !== null && (await isDescendantOf(tx, destinationId, item.id))) {
            throw new MoveCycleError('A folder cannot be moved into one of its own subfolders.');
          }
        }
      });

      // Each file re-resolves its name against the destination it is entering,
      // excluding every other item in this same move so a batch that drops two
      // identically named files does not make them collide with each other.
      for (const item of moving) {
        if (isDriveFolder(item)) continue;
        await runNameTransaction(uid, destinationId, movingIds, item.name, (tx, resolved) => {
          tx.update(doc(db, 'items', item.id), {
            parentFolderId: destinationId,
            ...(resolved.name === item.name ? {} : {
              name: resolved.name,
              normalizedName: resolved.normalized
            }),
            updatedAt: serverTimestamp()
          });
        });
      }

      // Folders move under their existing name: a folder's identity within its
      // parent is not in question, and a suffix here would be a silent rename
      // the user never asked for.
      await forEachChunk(moving, MAX_BATCH_OPERATIONS, async (slice) => {
        const batch = writeBatch(db);
        for (const item of slice) {
          batch.update(doc(db, 'items', item.id), {
            parentFolderId: destinationId,
            updatedAt: serverTimestamp()
          });
        }
        await batch.commit();
      });

      return ok([...movingIds]);
    } catch (error) {
      if (error instanceof MoveCycleError) {
        return {
          ok: false,
          error: { kind: 'invalid-argument', message: error.message, retryable: false, cause: error }
        };
      }
      return fail(error, [...movingIds]);
    } finally {
      this.#pendingCount -= 1;
    }
  }

  /**
   * Move items to the trash, including every descendant.
   *
   * Descendants are resolved level by level with `in` queries, then written
   * **deepest first**. The ordering is not cosmetic: `firestore.rules` requires
   * an item's parent to be untrashed, so a batch that trashed a parent before
   * its children would be rejected outright. Deepest-first means each batch's
   * `getAfter(parent)` still reads an untrashed parent, and the final batch is
   * the only one that contains the subtree root.
   */
  async trashItems(itemIds: readonly string[]): Promise<MutationResult> {
    const uid = authStore.uid;
    if (uid === null) return fail(new Error('Not signed in.'));

    const roots = itemIds
      .map((id) => this.getItem(id))
      .filter((item): item is DriveItem => item !== null && !item.isTrashed);
    if (roots.length === 0) return ok(itemIds);

    this.#pendingCount += 1;
    try {
      const subtree = await collectSubtree(uid, roots);
      const deepestFirst = [...subtree].sort((left, right) => right.depth - left.depth);

      await forEachChunk(deepestFirst, MAX_BATCH_OPERATIONS, async (slice) => {
        const batch = writeBatch(getFirestoreClient());
        for (const entry of slice) {
          batch.update(doc(getFirestoreClient(), 'items', entry.item.id), {
            isTrashed: true,
            trashedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
        await batch.commit();
      });

      return ok(subtree.map((entry) => entry.item.id));
    } catch (error) {
      return fail(error, itemIds);
    } finally {
      this.#pendingCount -= 1;
    }
  }

  /**
   * Restore items from the trash.
   *
   * Two things differ from trashing, and both are forced by the rules:
   *
   * 1. **Shallowest first.** `hasValidParentOnUpdate` refuses to un-trash a
   *    document while its parent is still in the trash, so a parent must
   *    already be restored — in the same batch, or an earlier one — for its
   *    children to be legal. The exact reverse of the trashing order.
   * 2. **Orphan reparenting.** A child whose parent is itself still in the
   *    trash would fail the same check permanently, because the parent is not
   *    necessarily part of the selection. Such an item is reparented to the
   *    root instead of being left unrestorable.
   */
  async restoreItems(itemIds: readonly string[]): Promise<MutationResult> {
    const uid = authStore.uid;
    if (uid === null) return fail(new Error('Not signed in.'));

    const roots = itemIds
      .map((id) => this.getItem(id))
      .filter((item): item is DriveItem => item !== null && item.isTrashed);
    if (roots.length === 0) return ok(itemIds);

    this.#pendingCount += 1;
    try {
      const subtree = await collectSubtree(uid, roots);
      const restoredIds = new Set(subtree.map((entry) => entry.item.id));

      // Decide each item's destination before writing anything, so the whole
      // tree can be ordered shallowest-first in one pass.
      const targets = new Map<string, string | null>();
      for (const entry of subtree) {
        targets.set(entry.item.id, await resolveRestoreParent(entry.item, restoredIds));
      }

      const shallowestFirst = [...subtree].sort((left, right) => left.depth - right.depth);

      await forEachChunk(shallowestFirst, MAX_BATCH_OPERATIONS, async (slice) => {
        const batch = writeBatch(getFirestoreClient());
        for (const entry of slice) {
          batch.update(doc(getFirestoreClient(), 'items', entry.item.id), {
            isTrashed: false,
            trashedAt: null,
            parentFolderId: targets.get(entry.item.id) ?? null,
            updatedAt: serverTimestamp()
          });
        }
        await batch.commit();
      });

      return ok(subtree.map((entry) => entry.item.id));
    } catch (error) {
      return fail(error, itemIds);
    } finally {
      this.#pendingCount -= 1;
    }
  }

  /** Delete trashed items permanently, in the three phases the plan mandates. */
  async permanentlyDelete(itemIds: readonly string[]): Promise<MutationResult> {
    const uid = authStore.uid;
    if (uid === null) return fail(new Error('Not signed in.'));

    const targets = itemIds
      .map((id) => this.getItem(id))
      .filter((item): item is DriveItem => item !== null && item.isTrashed);
    if (targets.length === 0) return ok(itemIds);

    this.#pendingCount += 1;
    try {
      // Phase 1 — tombstone every file, so a Storage failure can be retried
      // without ever leaving a live document pointing at deleted bytes.
      const files = targets.filter(isDriveFile);
      await forEachChunk(files, MAX_BATCH_OPERATIONS, async (slice) => {
        const batch = writeBatch(getFirestoreClient());
        for (const file of slice) {
          if (file.uploadStatus === 'deletion-pending') continue;
          batch.update(doc(getFirestoreClient(), 'items', file.id), {
            uploadStatus: 'deletion-pending',
            updatedAt: serverTimestamp()
          });
        }
        if (slice.some((file) => file.uploadStatus !== 'deletion-pending')) {
          await batch.commit();
        }
      });

      // Phase 2 — drop the bytes. A blob that is already gone is the desired
      // end state, not a failure, so `object-not-found` is swallowed.
      await Promise.all(
        files.map(async (file) => {
          try {
            await deleteObject(storageRef(getStorageClient(), file.storagePath));
          } catch (error) {
            if (!isMissingObject(error)) throw error;
          }
        })
      );

      // Phase 3 — hard-delete the documents and release the quota in one
      // transaction per chunk, so the ledger and the collection cannot diverge.
      const ids = targets.map((item) => item.id);
      await forEachChunk(ids, MAX_BATCH_OPERATIONS, async (slice) => {
        const db = getFirestoreClient();
        await runBoundedTransaction(db, async (tx) => {
          const snapshots = await Promise.all(
            slice.map((id) => tx.get(doc(db, 'items', id)))
          );
          const userSnapshot = await tx.get(doc(db, 'users', uid));
          if (!userSnapshot.exists()) throw new Error('Account document is missing.');

          let reclaimed = 0;
          const batch = writeBatch(db);
          for (const snapshot of snapshots) {
            if (!snapshot.exists()) continue; // Already gone: deletion is idempotent.
            const data = snapshot.data() as DocumentData;
            if (data.type === 'file') reclaimed += Number(data.sizeBytes ?? 0);
            batch.delete(snapshot.ref);
          }

          if (reclaimed > 0) {
            const quota = userSnapshot.data().quota as { usedBytes: number };
            batch.set(doc(db, 'users', uid), {
              quota: { usedBytes: Math.max(0, quota.usedBytes - reclaimed) },
              updatedAt: serverTimestamp()
            });
          }
          await batch.commit();
        });
      });

      return ok(ids);
    } catch (error) {
      return fail(error, itemIds);
    } finally {
      this.#pendingCount -= 1;
    }
  }

  /** Empty the trash: every trashed subtree, permanently. */
  async emptyTrash(): Promise<MutationResult> {
    const uid = authStore.uid;
    if (uid === null) return fail(new Error('Not signed in.'));

    const trashed = (await getDocs(
      query(
        collection(getFirestoreClient(), 'items'),
        where('ownerId', '==', uid),
        where('isTrashed', '==', true),
        limit(MAX_TRASH_SCAN_LIMIT)
      )
    ))
      .docs.map((snapshot) => toDriveItem(snapshot.id, snapshot.data()))
      .filter((item): item is DriveItem => item !== null);

    if (trashed.length === 0) return ok();

    // Only the shallowest nodes are roots of a trashed subtree; a child would
    // otherwise be walked twice.
    const trashedIds = new Set(trashed.map((item) => item.id));
    const roots = trashed.filter(
      (item) => item.parentFolderId === null || !trashedIds.has(item.parentFolderId)
    );

    return this.permanentlyDelete(roots.map((item) => item.id));
  }

  /** Toggle the star on a set of items. Presentation is server-authoritative. */
  async setStarred(itemIds: readonly string[], starred: boolean): Promise<MutationResult> {
    const uid = authStore.uid;
    if (uid === null) return fail(new Error('Not signed in.'));

    const targets = itemIds.filter((id) => this.getItem(id) !== null);
    if (targets.length === 0) return ok(itemIds);

    this.#pendingCount += 1;
    try {
      await forEachChunk(targets, MAX_BATCH_OPERATIONS, async (slice) => {
        const batch = writeBatch(getFirestoreClient());
        for (const id of slice) {
          batch.update(doc(getFirestoreClient(), 'items', id), {
            isStarred: starred,
            updatedAt: serverTimestamp()
          });
        }
        await batch.commit();
      });
      return ok(targets);
    } catch (error) {
      return fail(error, targets);
    } finally {
      this.#pendingCount -= 1;
    }
  }

  /** Apply a patch (name, colour) to a single folder. */
  async updateFolder(folderId: string, patch: UpdateItemPatch): Promise<MutationResult> {
    if (authStore.uid === null) return fail(new Error('Not signed in.'));

    const update: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (patch.name !== undefined) {
      const validation = validateItemName(patch.name);
      if (!validation.valid) return fail(new Error('That name cannot be used.'));
      update.name = validation.name;
      update.normalizedName = validation.normalized;
    }
    if (patch.color !== undefined) update.color = patch.color;
    if (patch.isStarred !== undefined) update.isStarred = patch.isStarred;

    this.#pendingCount += 1;
    try {
      await updateDoc(doc(getFirestoreClient(), 'items', folderId), update);
      return ok([folderId]);
    } catch (error) {
      return fail(error, [folderId]);
    } finally {
      this.#pendingCount -= 1;
    }
  }

  /**
   * Create a placeholder file document for an upload that has not been
   * committed yet.
   *
   * Called by the upload manager, not the UI: it is the only writer that may
   * create a document in a pre-commit upload status.
   */
  async ensureItemDocument(item: DriveItem): Promise<void> {
    const snapshot = await getDoc(doc(getFirestoreClient(), 'items', item.id));
    if (snapshot.exists()) return;
    await setDoc(doc(getFirestoreClient(), 'items', item.id), item, { merge: true });
  }

  /** A single-item read, used by the preview modal for items outside the scope. */
  async fetchItem(itemId: string): Promise<DriveItem | null> {
    try {
      const snapshot = await getDoc(doc(getFirestoreClient(), 'items', itemId));
      if (!snapshot.exists()) return null;
      const item = toDriveItem(snapshot.id, snapshot.data());
      if (item !== null && isDriveFolder(item)) this.#ancestors.set(item.id, item);
      return item;
    } catch (error) {
      this.#error = classifyError(error);
      return null;
    }
  }

  /** Dismiss the current error. */
  clearError(): void {
    this.#error = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Raised for a move that would create a cycle in the folder graph. */
class MoveCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoveCycleError';
  }
}

/** Fresh client-generated id for an item document. */
export function newItemId(): string {
  return crypto.randomUUID();
}

/** Build the canonical storage path for a file, mirroring §3.3 of the plan. */
export function buildStoragePath(uid: string, itemId: string, fileName: string): string {
  return `users/${uid}/${itemId}/${fileName}`;
}

/** A UUID v4 session id, matching the `uploadSessionId` contract. */
export function newUploadSessionId(): string {
  return crypto.randomUUID();
}

/** The resolved MIME type the upload pipeline will persist for a file. */
export function resolveUploadMimeType(file: { name: string; type: string }): string {
  return resolveMimeType({ name: file.name, type: file.type });
}

/** Preview descriptor for a stored file. */
export function describeFile(file: DriveFile) {
  return getFileMimeDescriptor({ name: file.name, type: 'file', mimeType: file.mimeType });
}

/** In-memory sort, so folders and files can share one ordered list. */
function sortItems(items: DriveItem[], by: FilterSortState['sortBy'], direction: FilterSortState['sortDirection']): DriveItem[] {
  const factor = direction === 'asc' ? 1 : -1;

  return [...items].sort((left, right) => {
    if (by === 'name') {
      // `normalizedName` is the collision key, so ordering by it gives a
      // case-insensitive sort that matches the order names were assigned in.
      return left.normalizedName.localeCompare(right.normalizedName) * factor;
    }

    const leftTime = toMillis(left.updatedAt);
    const rightTime = toMillis(right.updatedAt);
    if (leftTime !== rightTime) return (leftTime - rightTime) * factor;

    if (by === 'sizeBytes') {
      // Folders have no size; they sort as empty, which keeps them grouped at
      // the top of an ascending size order instead of vanishing from it.
      return (getItemSizeBytes(left) - getItemSizeBytes(right)) * factor;
    }
    return 0;
  });
}

function toMillis(value: unknown): number {
  const candidate = value as { toMillis?: () => number } | null;
  if (candidate !== null && typeof candidate?.toMillis === 'function') return candidate.toMillis();
  return 0;
}

function isMissingObject(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'storage/object-not-found' || code === 'storage/retry-limit-exceeded';
}

/** One item within a subtree, carrying its distance from the operation root. */
interface SubtreeEntry {
  readonly item: DriveItem;
  readonly depth: number;
}

/**
 * Resolve a full subtree, one level at a time.
 *
 * Levels are read with `in` filters chunked to Firestore's 30-value ceiling, so
 * a wide tree costs a handful of queries instead of one per node. Already-seen
 * ids are tracked to make the traversal safe against a malformed cycle.
 */
async function collectSubtree(uid: string, roots: readonly DriveItem[]): Promise<SubtreeEntry[]> {
  const db = getFirestoreClient();
  const collected = new Map<string, SubtreeEntry>();
  const frontier: DriveItem[] = [];

  for (const root of roots) {
    if (collected.has(root.id)) continue;
    collected.set(root.id, { item: root, depth: 0 });
    if (isDriveFolder(root)) frontier.push(root);
  }

  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: DriveItem[] = [];

    for (const group of chunk(frontier, MAX_IN_QUERY_VALUES)) {
      const snapshot = await getDocs(
        query(
          collection(db, 'items'),
          where('ownerId', '==', uid),
          where('parentFolderId', 'in', group.map((folder) => folder.id))
        )
      );

      for (const child of snapshot.docs) {
        const item = toDriveItem(child.id, child.data());
        if (item === null || collected.has(item.id)) continue;
        collected.set(item.id, { item, depth });
        if (isDriveFolder(item)) next.push(item);
      }
    }

    frontier.length = 0;
    frontier.push(...next);
  }

  return [...collected.values()];
}

/**
 * Destination for a restored item.
 *
 * Keeps the original parent when that parent is being restored in the same
 * operation, and otherwise falls back to the root whenever the original parent
 * is still trashed or no longer exists — the alternative is an item that can
 * never satisfy `hasValidParent` and is therefore permanently unrestorable.
 */
async function resolveRestoreParent(item: DriveItem, restoredIds: ReadonlySet<string>): Promise<string | null> {
  const parentId = item.parentFolderId;
  if (parentId === null) return null;
  if (restoredIds.has(parentId)) return parentId;

  try {
    const snapshot = await getDoc(doc(getFirestoreClient(), 'items', parentId));
    if (!snapshot.exists()) return null;
    return snapshot.data().isTrashed === true ? null : parentId;
  } catch {
    // An unreadable parent is treated as absent; the root is always writable.
    return null;
  }
}

/**
 * Ids of every untrashed sibling under a parent.
 *
 * This runs *outside* the transaction, because `Transaction.get()` accepts only
 * a document reference in the JS SDK — a query cannot be read transactionally.
 * The ids it produces are only an address list: {@link runNameTransaction}
 * re-reads the documents themselves inside the transaction, so the collision
 * decision is still made against transactional state.
 */
async function readSiblingIds(
  uid: string,
  parentFolderId: string | null,
  excludeIds: ReadonlySet<string>
): Promise<string[]> {
  const snapshot = await getDocs(
    query(
      collection(getFirestoreClient(), 'items'),
      where('ownerId', '==', uid),
      where('parentFolderId', '==', parentFolderId),
      where('isTrashed', '==', false)
    )
  );

  return snapshot.docs
    .map((docSnapshot) => docSnapshot.id)
    .filter((id) => !excludeIds.has(id));
}

/**
 * Perform a write whose payload depends on sibling names, collision-free.
 *
 * Three steps per attempt:
 *
 * 1. Resolve the sibling document *ids* with a query.
 * 2. Inside the transaction, re-read those documents and resolve a name
 *    against their committed `normalizedName` values. This is the part that
 *    makes the decision transactional: a rename cannot commit a name another
 *    sibling was given after the id list was taken.
 * 3. Re-query after the commit and confirm the name that landed is still
 *    unique. A sibling created in the gap between steps 1 and 2 is invisible
 *    to the transaction, and this is what catches it — the write is retried with
 *    the name now in the taken set, so the loop converges on a free name rather
 *    than leaving two items sharing a key.
 */
async function runNameTransaction(
  uid: string,
  parentFolderId: string | null,
  excludeIds: ReadonlySet<string>,
  desiredName: string,
  write: (tx: Transaction, resolved: ResolvedName) => void
): Promise<ResolvedName> {
  const db = getFirestoreClient();
  const taken = new Set<string>();
  let resolved: ResolvedName = {
    name: desiredName,
    normalized: normalizeItemName(desiredName)
  };

  for (let attempt = 0; attempt < NAME_RESOLUTION_ATTEMPTS; attempt += 1) {
    const siblingIds = await readSiblingIds(uid, parentFolderId, excludeIds);

    await runBoundedTransaction(db, async (tx) => {
      // Sequential point reads: `Transaction` in the JS SDK exposes only
      // `get(documentRef)`, with no batched or query form. Reads must all
      // precede the first write, which the loop guarantees.
      for (const siblingId of siblingIds) {
        const snapshot = await tx.get(doc(db, 'items', siblingId));
        if (!snapshot.exists()) continue;
        const name: unknown = snapshot.data().normalizedName;
        if (typeof name === 'string') taken.add(name);
      }

      resolved = resolveNameCollision(desiredName, { taken });
      write(tx, resolved);
    });

    // Step 3: confirm against the state the commit actually produced.
    const occupied = await readSiblingIds(uid, parentFolderId, excludeIds);
    const settled = await Promise.all(
      occupied.map((id) => getDoc(doc(db, 'items', id)))
    );
    const clashes = settled.filter(
      (snapshot) => snapshot.exists() && snapshot.data().normalizedName === resolved.normalized
    );
    if (clashes.length === 0) return resolved;

    taken.add(resolved.normalized);
  }

  throw new Error('Could not find a free name for this item.');
}

/** The single item store. */
export const driveStore = new DriveStore();
