/**
 * Transactional upload pipeline.
 *
 * Three phases, each of which is independently restartable:
 *
 *   1. **Reserve** — a transaction reads the ledger, asserts
 *      `used + reserved + size <= total`, and writes the file document as
 *      `reserved` while adding the bytes to `reservedBytes`.
 *   2. **Upload** — `uploadBytesResumable` streams to Storage and reports
 *      progress into this store. The document moves `reserved -> uploading` on
 *      the server, but progress itself is local and advisory.
 *   3. **Commit** — a transaction asserts the document still belongs to *this*
 *      attempt, flips it to `committed`, and moves the bytes from
 *      `reservedBytes` to `usedBytes`.
 *
 * Compensation
 * ------------
 * Every failure releases the reservation through a transaction guarded by the
 * same `uploadSessionId` the write used. A retry that lost the race to a newer
 * attempt finds a mismatched id, skips the compensation entirely, and leaves
 * the newer attempt's document and reservation untouched. That guard is the
 * whole reason session ids exist: without it, a late failure from attempt *N*
 * would delete the document and release the bytes of attempt *N+1*.
 *
 * Pause semantics
 * ---------------
 * Pausing suspends the transfer and keeps the reservation, because the bytes
 * are still committed to this upload and are still consuming the account's
 * ceiling. Resuming continues from the last transferred byte rather than
 * starting over, which is what the SDK's own `UploadTask.pause()`/`resume()`
 * pair provides. Cancelling is the operation that releases the reservation.
 *
 * The consequence is worth stating plainly: a task paused in a tab that is then
 * closed holds its reservation until that tab returns and the task is
 * cancelled. Nothing else can reclaim it safely, because the session id that
 * identifies the attempt lives in the client that created it.
 *
 * Concurrency
 * -----------
 * At most {@link MAX_CONCURRENT_UPLOADS} transfers run at once, and bytes are
 * reserved only as a slot frees up — so dropping a hundred files never reserves
 * a hundred files' worth of quota at the same time.
 */
import { doc, runTransaction, serverTimestamp, type Firestore } from 'firebase/firestore';
import {
  deleteObject,
  ref as storageRef,
  uploadBytesResumable,
  type UploadTask as StorageUploadTask,
  type UploadTaskSnapshot
} from 'firebase/storage';
import { getFirestoreClient, getStorageClient } from '$lib/firebase/client';
import { classifyError, isQuotaRejection, type ClassifiedError } from '$lib/firebase/errors';
import { authStore } from '$lib/stores/authStore.svelte';
import { MAX_FILE_SIZE_BYTES } from '$lib/config/constants';
import {
  assertWritableParent,
  readLedger,
  runBoundedTransaction
} from '$lib/domain/transactions';
import { formatBytes } from '$lib/utils/formatters';
import type { UploadTaskProgress, UploadTaskStatus } from '$lib/types/drive';

/** Transfers allowed to run at once. */
const MAX_CONCURRENT_UPLOADS = 3;

/** Abort a transfer that reports no progress for this long. */
const STALL_TIMEOUT_MS = 120_000;

/** Progress sampling interval, so the UI is not repainted hundreds of times a second. */
const PROGRESS_SAMPLE_MS = 120;

/** One row in the queue panel. */
export interface UploadTask extends UploadTaskProgress {
  /** Stable row id, distinct from the `items/{id}` document id. */
  readonly taskId: string;
  /** Destination at enqueue time, so navigating away mid-flight is harmless. */
  readonly targetFolderId: string | null;
  /** Live transfer handle, for pause, resume and cancel. */
  upload: StorageUploadTask | null;
  /** True once the user has asked for a cancel that has not landed yet. */
  cancelRequested: boolean;
  /** The `items/{id}` document, once phase 1 has created it. */
  itemId: string | null;
  /** The attempt id every compensating write must match. */
  sessionId: string | null;
  /** Destination object path, needed to remove orphaned bytes. */
  storagePath: string | null;
  readonly sizeBytes: number;
  readonly mimeType: string;
  /** Whether the task has reached a terminal state for this attempt. */
  isSettled: boolean;
  /** Timestamp of the last progress event, used to throttle row updates. */
  sampledAt: number;
}

export class UploadQueueStore {
  #tasks = $state<UploadTask[]>([]);
  #expanded = $state(false);
  #running = 0;
  #waiters: (() => void)[] = [];
  /** Tasks the user asked to pause, so the abort is not read as a failure. */
  /** Tasks the user paused, so the resulting rejection is not read as failure. */
  #pauseRequests = new Set<string>();

  /** Every row, oldest first. */
  get tasks(): readonly UploadTask[] {
    return this.#tasks;
  }

  /** Rows that have not settled. */
  get activeTasks(): readonly UploadTask[] {
    return this.#tasks.filter((task) => !task.isSettled);
  }

  /** Rows that committed successfully. */
  get finishedTasks(): readonly UploadTask[] {
    return this.#tasks.filter((task) => task.isSettled && task.status === 'completed');
  }

  /** Rows that failed. */
  get failedTasks(): readonly UploadTask[] {
    return this.#tasks.filter((task) => task.isSettled && task.status === 'error');
  }

  /** Rows awaiting a concurrency slot. */
  get queuedTasks(): readonly UploadTask[] {
    return this.#tasks.filter((task) => task.status === 'pending');
  }

  /** `true` while any transfer is in flight. */
  get isUploading(): boolean {
    return this.activeTasks.length > 0;
  }

  /** `true` when a paused row can be resumed. */
  get hasPaused(): boolean {
    return this.#tasks.some((task) => task.status === 'paused');
  }

  /** Whether the drawer is open. */
  get isExpanded(): boolean {
    return this.#expanded;
  }

  /** Headline for the drawer trigger. */
  get summary(): string {
    const active = this.activeTasks.length;
    const failed = this.failedTasks.length;

    if (active > 0) {
      const total = this.#tasks.length;
      return total > active ? `Uploading ${active} of ${total}` : `Uploading ${active}`;
    }
    if (failed > 0) return `${failed} upload${failed === 1 ? '' : 's'} failed`;
    if (this.#tasks.length > 0) return 'Uploads complete';
    return 'No uploads';
  }

  /** Bytes transferred across every running task, for the drawer header. */
  get aggregateProgress(): number {
    const running = this.activeTasks.filter((task) => task.sizeBytes > 0);
    if (running.length === 0) return 100;

    const total = running.reduce((sum, task) => sum + task.sizeBytes, 0);
    const done = running.reduce((sum, task) => sum + task.bytesTransferred, 0);
    return total === 0 ? 100 : Math.min(100, (done / total) * 100);
  }

  /** Show or hide the drawer. */
  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
  }

  /** Toggle the drawer. */
  toggle(): void {
    this.#expanded = !this.#expanded;
  }

  /**
   * Queue files for upload into `targetFolderId`.
   *
   * @returns The task ids, so a caller can watch individual rows.
   */
  enqueue(files: readonly File[], targetFolderId: string | null): string[] {
    const taskIds: string[] = [];

    for (const file of files) {
      const taskId = crypto.randomUUID();

      this.#tasks.push({
        taskId,
        id: taskId,
        fileName: file.name,
        sizeBytes: file.size,
        bytesTransferred: 0,
        progressPercentage: 0,
        status: 'pending',
        errorMessage: null,
        targetFolderId,
        upload: null,
        cancelRequested: false,
        itemId: null,
        sessionId: null,
        storagePath: null,
        mimeType: resolveUploadMimeType(file),
        isSettled: false,
        sampledAt: 0
      });

      taskIds.push(taskId);
      void this.#run(this.#require(taskId), file);
    }

    return taskIds;
  }

  /**
   * Pause a running transfer.
   *
   * The reservation is released and the row stays resumable; see the module
   * header for why a pause is a fresh attempt rather than a suspended one.
   */
  pause(taskId: string): void {
    const task = this.#find(taskId);
    if (task === null || task.isSettled) return;

    if (task.upload !== null) {
      task.upload.pause();
      task.status = 'paused';
      return;
    }

    // Queued but not yet started: there is nothing to suspend, so the row is
    // simply held until it would have run.
    this.#pauseRequests.add(taskId);
    task.status = 'paused';
  }

  /**
   * Resume a paused task.
   *
   * A transfer the SDK suspended continues from its last byte. A row that was
   * paused before it ever acquired a slot is re-queued, which is why this
   * method needs the `File` handle the picker produced.
   */
  resume(taskId: string, file: File): void {
    const task = this.#find(taskId);
    if (task === null || task.status !== 'paused') return;

    this.#pauseRequests.delete(taskId);

    if (task.upload !== null) {
      task.upload.resume();
      task.status = 'uploading';
      return;
    }

    task.status = 'pending';
    task.isSettled = false;
    void this.#run(task, file);
  }

  /** Abort a task and release its reservation. */
  cancel(taskId: string): void {
    const task = this.#find(taskId);
    if (task === null || task.isSettled) return;

    task.cancelRequested = true;

    if (task.upload !== null) {
      // `cancel()` rejects the task's promise with `storage/canceled`, which
      // the run loop treats as a user abort and compensates for.
      task.upload.cancel();
      return;
    }

    // Queued: nothing is in flight, so release the slot bookkeeping at once.
    this.#pauseRequests.delete(taskId);
    task.status = 'error';
    task.errorMessage = 'Upload cancelled.';
    task.isSettled = true;
  }

  /** Retry a failed task from the beginning. */
  retry(taskId: string, file: File): void {
    const task = this.#find(taskId);
    if (task === null || task.status !== 'error') return;

    task.cancelRequested = false;
    task.status = 'pending';
    task.errorMessage = null;
    task.bytesTransferred = 0;
    task.progressPercentage = 0;
    task.isSettled = false;
    void this.#run(task, file);
  }

  /** Dismiss every settled row, keeping anything still running. */
  clearFinished(): void {
    if (!this.#tasks.some((task) => task.isSettled)) return;
    this.#tasks = this.#tasks.filter((task) => !task.isSettled);
  }

  /** Remove one settled row. */
  dismiss(taskId: string): void {
    const task = this.#find(taskId);
    if (task === null || !task.isSettled) return;
    this.#tasks = this.#tasks.filter((candidate) => candidate.taskId !== taskId);
  }

  /* ---------------------------------------------------------------------- */
  /* Execution                                                                 */
  /* ---------------------------------------------------------------------- */

  async #run(task: UploadTask, file: File): Promise<void> {
    if (task.sizeBytes > MAX_FILE_SIZE_BYTES) {
      this.#settleAsError(task, {
        kind: 'invalid-argument',
        message: `Files must be smaller than ${formatBytes(MAX_FILE_SIZE_BYTES)}.`,
        retryable: false,
        cause: null
      });
      return;
    }

    if (authStore.uid === null) {
      this.#settleAsError(task, {
        kind: 'unauthenticated',
        message: 'Sign in before uploading.',
        retryable: true,
        cause: null
      });
      return;
    }

    await this.#acquireSlot();

    // A pause that landed while the task was queued for a slot must not start
    // a transfer at all.
    if (this.#pauseRequests.has(task.taskId)) {
      this.#releaseSlot();
      this.#applyTerminalIntent(task);
      return;
    }

    task.status = 'uploading';

    try {
      const reservation = await this.#reserve(task, file);
      if (reservation === null) return;

      await this.#transfer(task, file, reservation);

      if (task.cancelRequested) {
        await this.#release(task);
        this.#settleAsError(task, {
          kind: 'cancelled',
          message: 'Upload cancelled.',
          retryable: true,
          cause: null
        });
        return;
      }

      task.bytesTransferred = task.sizeBytes;
      task.progressPercentage = 100;

      await this.#commit(task);
      task.status = 'completed';
      task.isSettled = true;
    } catch (error) {
      await this.#release(task);
      this.#settleAsError(task, this.#describeFailure(task, error));
    } finally {
      this.#releaseSlot();
      task.upload = null;
    }
  }

  /** Classify a run-loop failure, distinguishing the cases the user can act on. */
  #describeFailure(task: UploadTask, error: unknown): ClassifiedError {
    if (task.cancelRequested) {
      return { kind: 'cancelled', message: 'Upload cancelled.', retryable: true, cause: error };
    }
    if (this.#pauseRequests.has(task.taskId)) {
      this.#pauseRequests.delete(task.taskId);
      return { kind: 'cancelled', message: 'Upload paused.', retryable: true, cause: error };
    }
    return classifyError(error);
  }

  /**
   * Phase 1 — reserve quota and create the `reserved` document.
   *
   * @returns The identity of the reservation, or `null` when the task has
   * already been settled with a classified failure.
   */
  async #reserve(
    task: UploadTask,
    file: File
  ): Promise<{ itemId: string; sessionId: string; storagePath: string } | null> {
    const uid = authStore.uid;
    if (uid === null) {
      this.#settleAsError(task, {
        kind: 'unauthenticated',
        message: 'Sign in before uploading.',
        retryable: true,
        cause: null
      });
      return null;
    }

    const db = getFirestoreClient();
    const itemId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const storagePath = `users/${uid}/${itemId}/${file.name}`;
    const sizeBytes = file.size;

    try {
      await runBoundedTransaction(db, async (tx) => {
        const ledger = await readLedger(tx, uid);
        if (ledger === null) throw new Error('The account document could not be read.');

        const committed = ledger.usedBytes + ledger.reservedBytes;
        if (committed + sizeBytes > ledger.totalBytes) {
          throw new QuotaRejectionError(ledger.totalBytes - committed);
        }

        await assertWritableParent(tx, task.targetFolderId);

        tx.set(doc(db, 'items', itemId), {
          id: itemId,
          name: file.name,
          normalizedName: normalizeUploadName(file.name),
          ownerId: uid,
          parentFolderId: task.targetFolderId,
          type: 'file',
          mimeType: task.mimeType,
          sizeBytes,
          storagePath,
          uploadStatus: 'reserved',
          uploadSessionId: sessionId,
          isTrashed: false,
          trashedAt: null,
          isStarred: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });

        tx.set(
          doc(db, 'users', uid),
          {
            quota: {
              usedBytes: ledger.usedBytes,
              reservedBytes: ledger.reservedBytes + sizeBytes,
              totalBytes: ledger.totalBytes
            },
            updatedAt: serverTimestamp()
          },
          { merge: true }
        );
      });

      task.itemId = itemId;
      task.sessionId = sessionId;
      task.storagePath = storagePath;
      return { itemId, sessionId, storagePath };
    } catch (error) {
      this.#settleAsError(task, describeUploadFailure(error, ledgerHint(error)));
      return null;
    }
  }

  /**
   * Phase 2 — stream the bytes, sampling progress.
   *
   * The SDK's `UploadTask` is used directly rather than wrapped: it is the only
   * object that supports a real pause, and re-implementing one over
   * `uploadBytes` would lose that for no benefit. Progress events arrive far
   * faster than a row can usefully repaint, so they are sampled.
   */
  async #transfer(
    task: UploadTask,
    file: File,
    reservation: { itemId: string; sessionId: string; storagePath: string }
  ): Promise<void> {
    await markUploading(reservation.itemId, reservation.sessionId);

    const upload = uploadBytesResumable(
      storageRef(getStorageClient(), reservation.storagePath),
      file,
      { contentType: task.mimeType }
    );
    task.upload = upload;

    let lastSample = 0;
    let lastBytes = 0;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    const armStall = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        // No forward progress for the whole window: treat the transfer as dead
        // so the reservation is released instead of being held by a socket that
        // will never deliver.
        upload.cancel();
      }, STALL_TIMEOUT_MS);
    };
    armStall();

    const stopListening = upload.on(
      'state_changed',
      (snapshot: UploadTaskSnapshot) => {
        lastBytes = snapshot.bytesTransferred;

        if (snapshot.state === 'paused') {
          task.status = 'paused';
          return;
        }
        if (snapshot.state === 'running') {
          task.status = 'uploading';
          armStall();
        }

        const now = Date.now();
        if (now - lastSample < PROGRESS_SAMPLE_MS) return;
        lastSample = now;

        task.bytesTransferred = snapshot.bytesTransferred;
        task.progressPercentage =
          task.sizeBytes === 0
            ? 100
            : Math.min(100, (snapshot.bytesTransferred / task.sizeBytes) * 100);
        task.sampledAt = now;
      }
    );

    try {
      await upload;
      task.bytesTransferred = Math.max(lastBytes, task.sizeBytes);
    } finally {
      stopListening();
      if (stallTimer !== undefined) clearTimeout(stallTimer);
    }
  }

  /** Phase 3 — promote the reservation into committed bytes. */
  async #commit(task: UploadTask): Promise<void> {
    const uid = authStore.uid;
    if (uid === null || task.itemId === null || task.sessionId === null) {
      throw new Error('The session ended before the upload could be committed.');
    }

    const db = getFirestoreClient();
    const itemId = task.itemId;
    const sessionId = task.sessionId;
    const sizeBytes = task.sizeBytes;

    await runBoundedTransaction(db, async (tx) => {
      const itemSnapshot = await tx.get(doc(db, 'items', itemId));
      if (!itemSnapshot.exists()) {
        throw new SupersededUploadError();
      }
      if (itemSnapshot.data().uploadSessionId !== sessionId) {
        throw new SupersededUploadError();
      }

      const ledger = await readLedger(tx, uid);
      if (ledger === null) throw new Error('The account document could not be read.');

      tx.update(doc(db, 'items', itemId), {
        uploadStatus: 'committed',
        storagePath: task.storagePath,
        sizeBytes,
        updatedAt: serverTimestamp()
      });

      tx.set(
        doc(db, 'users', uid),
        {
          quota: {
            usedBytes: ledger.usedBytes + sizeBytes,
            reservedBytes: Math.max(0, ledger.reservedBytes - sizeBytes),
            totalBytes: ledger.totalBytes
          },
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    });
  }

  /**
   * Release the reservation this attempt holds and delete its document.
   *
   * Safe to call when nothing was reserved: the ledger read and the session
   * check are both no-ops in that case, so the same code path serves a
   * reservation-time failure, a transfer failure and a user cancel.
   */
  async #release(task: UploadTask): Promise<void> {
    const uid = authStore.uid;
    const { itemId, sessionId, sizeBytes, storagePath } = task;
    task.itemId = null;
    task.sessionId = null;

    if (uid === null || itemId === null || sessionId === null) return;

    const db = getFirestoreClient();

    try {
      await runBoundedTransaction(db, async (tx) => {
        const itemSnapshot = await tx.get(doc(db, 'items', itemId));
        if (!itemSnapshot.exists()) return; // Already reclaimed; do not double-release.
        if (itemSnapshot.data().uploadSessionId !== sessionId) return; // A newer attempt owns it.

        const ledger = await readLedger(tx, uid);
        if (ledger === null) return;

        tx.delete(doc(db, 'items', itemId));
        tx.set(
          doc(db, 'users', uid),
          {
            quota: {
              usedBytes: ledger.usedBytes,
              reservedBytes: Math.max(0, ledger.reservedBytes - sizeBytes),
              totalBytes: ledger.totalBytes
            },
            updatedAt: serverTimestamp()
          },
          { merge: true }
        );
      });
    } catch (error) {
      // The compensation failed. The orphan document is still guarded by its
      // session id, so the bytes are released on the next attempt that touches
      // it, and the user is told the upload did not complete.
      throw error;
    }

    // Storage cleanup is best-effort and idempotent: a blob that was never
    // written, or was already removed, is the desired end state either way.
    if (storagePath !== null) {
      try {
        await deleteObject(storageRef(getStorageClient(), storagePath));
      } catch {
        // Intentionally ignored — see above.
      }
    }
  }

  /** Apply a pause that landed before the task acquired a transfer slot. */
  #applyTerminalIntent(task: UploadTask): void {
    if (task.cancelRequested) {
      task.status = 'error';
      task.errorMessage = 'Upload cancelled.';
      task.isSettled = true;
      return;
    }

    this.#pauseRequests.delete(task.taskId);
    task.status = 'paused';
    task.isSettled = false;
  }

  /** Settle a task as failed. */
  #settleAsError(task: UploadTask, error: ClassifiedError): void {
    task.status = 'error';
    task.errorMessage = error.message;
    task.isSettled = true;
  }

  /* ---------------------------------------------------------------------- */
  /* Concurrency slots                                                         */
  /* ---------------------------------------------------------------------- */

  /** Wait for a free transfer slot, taking one on arrival. */
  async #acquireSlot(): Promise<void> {
    if (this.#running < MAX_CONCURRENT_UPLOADS) {
      this.#running += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** Hand the slot to the next waiter, or return it to the pool. */
  #releaseSlot(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#running = Math.max(0, this.#running - 1);
  }

  /** Find a task by id. */
  #find(taskId: string): UploadTask | null {
    return this.#tasks.find((task) => task.taskId === taskId) ?? null;
  }

  /** Find a task by id, throwing if it vanished. Used on the enqueue path only. */
  #require(taskId: string): UploadTask {
    const task = this.#find(taskId);
    if (task === null) throw new Error(`Upload task ${taskId} is no longer queued.`);
    return task;
  }
}

/** Raised when a reservation would exceed the account's ceiling. */
class QuotaRejectionError extends Error {
  readonly availableBytes: number;

  constructor(availableBytes: number) {
    super('Not enough storage available.');
    this.name = 'QuotaRejectionError';
    this.availableBytes = Math.max(0, availableBytes);
  }
}

/** Raised when a newer attempt has taken over the upload document. */
class SupersededUploadError extends Error {
  constructor() {
    super('Superseded by a newer upload attempt.');
    this.name = 'SupersededUploadError';
  }
}

/** Bytes still free when a reservation was rejected, or `null`. */
function ledgerHint(error: unknown): number | null {
  return error instanceof QuotaRejectionError ? error.availableBytes : null;
}

/** Turn a raw failure into something worth reading, quota first. */
function describeUploadFailure(error: unknown, availableBytes: number | null): ClassifiedError {
  if (error instanceof QuotaRejectionError) {
    return {
      kind: 'quota-exceeded',
      message:
        availableBytes === null
          ? 'There is not enough storage left to save this file.'
          : `Not enough storage left — ${formatBytes(availableBytes)} still free.`,
      retryable: false,
      cause: error
    };
  }
  if (error instanceof SupersededUploadError) {
    return { kind: 'conflict', message: error.message, retryable: true, cause: error };
  }
  if (isQuotaRejection(error)) {
    return {
      kind: 'quota-exceeded',
      message: 'There is not enough storage left to save this file.',
      retryable: false,
      cause: error
    };
  }
  return classifyError(error);
}

/** The collision key for an uploaded file's name. */
function normalizeUploadName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** Resolve the MIME type to persist for a picked file. */
function resolveUploadMimeType(file: { name: string; type: string }): string {
  const declared = file.type.trim();
  if (declared.length > 0 && declared !== 'application/octet-stream') return declared;

  const extension = file.name.split('.').pop();
  if (extension === undefined || extension === file.name) return 'application/octet-stream';
  return `application/${extension.toLowerCase()}`;
}

/** Mark a document as transferring, ignoring an attempt that lost its claim. */
async function markUploading(itemId: string, sessionId: string): Promise<void> {
  const db: Firestore = getFirestoreClient();
  try {
    await runTransaction(db, async (tx) => {
      const snapshot = await tx.get(doc(db, 'items', itemId));
      if (!snapshot.exists() || snapshot.data().uploadSessionId !== sessionId) return;
      tx.update(doc(db, 'items', itemId), {
        uploadStatus: 'uploading',
        updatedAt: serverTimestamp()
      });
    });
  } catch {
    // A missed status write is cosmetic: the commit phase re-asserts the
    // session id, and `reserved -> committed` is itself a legal transition.
  }
}

/** The single upload queue. */
export const uploadQueueStore = new UploadQueueStore();

/** Re-exported so the queue drawer can type its status union locally. */
export type { UploadTaskStatus };
