/**
 * Transaction primitives shared by the item store and the upload pipeline.
 *
 * Both need the same three things: a retry budget, a parent-validity assertion
 * that mirrors `firestore.rules`, and a safe read of the quota ledger. Having
 * one implementation means the rule and its client-side twin cannot drift — a
 * divergence would show up as a permission error the client believed
 * impossible.
 */
import {
  doc,
  runTransaction,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type Transaction
} from 'firebase/firestore';
import { getFirestoreClient } from '$lib/firebase/client';
import { toDriveItem } from '$lib/domain/deserialize';
import { isDriveFolder } from '$lib/types/drive';
import { MAX_ANCESTOR_DEPTH } from '$lib/config/constants';
import type { StorageQuota } from '$lib/types/drive';

/** Attempts before a contended transaction is reported as a failure. */
const TRANSACTION_ATTEMPTS = 3;

/**
 * `runTransaction` with a bounded retry budget.
 *
 * The SDK retries internally, but an aborted transaction still surfaces as a
 * thrown error. Re-running the callback keeps a two-tab edit from reporting a
 * failure that one immediate retry would have resolved.
 *
 * Every callback passed here is idempotent by construction: each re-reads inside
 * the transaction and writes only from what it just read, so a replay cannot
 * double-apply a ledger delta.
 */
export async function runBoundedTransaction(
  db: Firestore,
  work: (tx: Transaction) => Promise<void>
): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      await runTransaction(db, work);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'aborted' && code !== 'contention') throw error;
      await delay(40 * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * Assert a destination folder is writable by this client.
 *
 * Mirrors `hasValidParent` in `firestore.rules`, so the user gets a sentence
 * explaining the problem instead of a bare `permission-denied`, and a
 * trashed or non-existent destination is caught before the commit is attempted.
 *
 * @throws Error with a user-facing message when the destination is unusable.
 */
export async function assertWritableParent(tx: Transaction, parentFolderId: string | null): Promise<void> {
  if (parentFolderId === null) return;

  const snapshot = await tx.get(doc(getFirestoreClient(), 'items', parentFolderId));
  if (!snapshot.exists()) {
    throw new Error('The destination folder no longer exists.');
  }

  const parent = toDriveItem(snapshot.id, snapshot.data());
  if (!isDriveFolder(parent)) {
    throw new Error('Items can only be moved into a folder.');
  }
  if (parent.isTrashed) {
    throw new Error('The destination folder is in the trash.');
  }
}

/**
 * Read the quota ledger inside a transaction.
 *
 * @returns `null` when the account document or its `quota` field is absent, so
 * a caller can distinguish "no ledger" from "an empty ledger" — the first is a
 * fatal state, the second is a valid full-drive state.
 */
export async function readLedger(tx: Transaction, uid: string): Promise<StorageQuota | null> {
  const snapshot = await tx.get(doc(getFirestoreClient(), 'users', uid));
  if (!snapshot.exists()) return null;

  const quota: unknown = snapshot.data().quota;
  if (quota === null || typeof quota !== 'object') return null;

  const ledger = quota as { usedBytes?: unknown; reservedBytes?: unknown; totalBytes?: unknown };
  return {
    usedBytes: toByteCount(ledger.usedBytes),
    reservedBytes: toByteCount(ledger.reservedBytes),
    totalBytes: toByteCount(ledger.totalBytes)
  };
}

/**
 * Walk a candidate destination's lineage looking for `ancestorId`.
 *
 * Used to prove a folder move cannot create a cycle. Returns `true` when the
 * candidate *is* the ancestor or lives beneath it.
 *
 * The walk stops at a fixed depth and at the first missing document, so a
 * corrupted parent chain terminates instead of spinning, and a destination whose
 * lineage cannot be fully read is treated as "not a descendant" — the write
 * that follows is still validated by `firestore.rules`.
 */
export async function isDescendantOf(
  tx: Transaction,
  candidateId: string,
  ancestorId: string,
  db: Firestore = getFirestoreClient()
): Promise<boolean> {
  let cursor: string | null = candidateId;
  let guard = 0;

  while (cursor !== null && guard < MAX_ANCESTOR_DEPTH) {
    if (cursor === ancestorId) return true;

    const snapshot: DocumentSnapshot<DocumentData> = await tx.get(doc(db, 'items', cursor));
    if (!snapshot.exists()) return false;

    const parent: unknown = snapshot.data().parentFolderId;
    cursor = typeof parent === 'string' ? parent : null;
    guard += 1;
  }
  return false;
}

/** Clamp an untrusted ledger value to a non-negative integer. */
function toByteCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Promise-based pause between transaction attempts. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
