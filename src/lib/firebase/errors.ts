/**
 * Translation of raw Firebase errors into the vocabulary the UI can act on.
 *
 * Every call site that catches a Firebase error needs the same three answers:
 * what category it was, what the user should read, and whether retrying could
 * plausibly help. Deriving those in one place keeps a permission-denied from
 * being reported as a transient network blip and retried forever.
 */

import { FirebaseError } from 'firebase/app';

/**
 * Coarse buckets the UI branches on.
 *
 * `unknown` is a real member, not a placeholder: an error the SDK does not
 * describe is shown verbatim rather than forced into a category that would
 * tell the user something untrue.
 */
export type DriveErrorKind =
  | 'permission-denied'
  | 'not-found'
  | 'unavailable'
  | 'deadline-exceeded'
  | 'quota-exceeded'
  | 'invalid-argument'
  | 'unauthenticated'
  | 'conflict'
  | 'cancelled'
  | 'unknown';

/** A failure with everything a caller needs to report it. */
export interface ClassifiedError {
  readonly kind: DriveErrorKind;
  /** Sentence to show the user. Never a raw SDK message. */
  readonly message: string;
  /** Whether an identical retry could plausibly succeed. */
  readonly retryable: boolean;
  /** The original error, for logging. */
  readonly cause: unknown;
}

const MESSAGES: Readonly<Record<DriveErrorKind, string>> = Object.freeze({
  'permission-denied':
    'You do not have access to that item. It may belong to someone else.',
  'not-found':
    'That item no longer exists. It may have been deleted in another session.',
  unavailable: 'The service is unreachable right now. Check the emulator and retry.',
  'deadline-exceeded': 'The request took too long to complete. Try again.',
  'quota-exceeded': 'This file is larger than the per-file limit allows.',
  'invalid-argument': 'That operation is not valid for this item.',
  unauthenticated: 'Your session expired. Sign in again to continue.',
  conflict: 'Someone else changed this item a moment ago. Reload and try again.',
  cancelled: 'The operation was cancelled.',
  unknown: 'Something went wrong. Please try again.'
});

const RETRYABLE: ReadonlySet<DriveErrorKind> = new Set<DriveErrorKind>([
  'unavailable',
  'deadline-exceeded',
  'conflict',
  'unknown'
]);

/** Firebase code to bucket. Anything absent falls through to `unknown`. */
const CODE_KINDS: Readonly<Record<string, DriveErrorKind>> = Object.freeze({
  'permission-denied': 'permission-denied',
  unauthenticated: 'unauthenticated',
  'not-found': 'not-found',
  unavailable: 'unavailable',
  'deadline-exceeded': 'deadline-exceeded',
  'resource-exhausted': 'quota-exceeded',
  'invalid-argument': 'invalid-argument',
  'failed-precondition': 'invalid-argument',
  'aborted': 'conflict',
  'already-exists': 'conflict',
  'not-supported': 'invalid-argument',
  'storage/canceled': 'cancelled',
  'storage/object-not-found': 'not-found',
  'storage/retry-limit-exceeded': 'deadline-exceeded',
  'storage/unauthenticated': 'unauthenticated',
  'storage/permission-denied': 'permission-denied',
  'storage/quota-exceeded': 'quota-exceeded',
  'storage/invalid-argument': 'invalid-argument',
  'storage/unknown': 'unknown'
});

/**
 * Bucket an arbitrary thrown value.
 *
 * Accepts `unknown` because that is what a `catch` clause hands you, and
 * a {@link FirebaseError} is detected structurally rather than with `instanceof`
 * so an error that crossed a module boundary — or a duplicate copy of the SDK
 * in the bundle — is still classified.
 */
export function classifyError(error: unknown): ClassifiedError {
  const code = readFirebaseCode(error);
  const kind = (code !== null ? CODE_KINDS[code] : undefined) ?? 'unknown';

  // A user-space quota rejection must win over the generic `failed-precondition`
  // the rules raise, otherwise "not valid for this item" is shown for a full drive.
  if (isQuotaRejection(error)) {
    return {
      kind: 'quota-exceeded',
      message: 'There is not enough storage left to save this item.',
      retryable: false,
      cause: error
    };
  }

  return { kind, message: MESSAGES[kind], retryable: RETRYABLE.has(kind), cause: error };
}

/** `true` when the error means the account is out of storage. */
export function isQuotaRejection(error: unknown): boolean {
  const code = readFirebaseCode(error);
  return code === 'storage/quota-exceeded' || code === 'resource-exhausted';
}

/** Pull `code` off a Firebase error without trusting its prototype. */
function readFirebaseCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** A short label for the failure, used in aria-live announcements. */
export function toErrorSummary(error: unknown): string {
  const classified = classifyError(error);
  if (error instanceof FirebaseError) {
    return `${classified.message} (${error.code})`;
  }
  return classified.message;
}

/* -------------------------------------------------------------------------- */
/* Failover                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Kinds that mean "there is no backend", as opposed to "the backend said no".
 *
 * `permission-denied` and `unauthenticated` are conspicuously absent. Both
 * describe a project that answered — a rules decision and an expired session are
 * both *responses*, and both are things a user or an operator must fix. Treating
 * them as unreachable would swap a working cloud drive for a fake local one and
 * hide the actual fault behind a healthy-looking UI.
 */
const UNREACHABLE_KINDS: ReadonlySet<DriveErrorKind> = new Set<DriveErrorKind>([
  'unavailable',
  'deadline-exceeded'
]);

/**
 * Codes the SDK raises before a project is ever reached.
 *
 * Auth reports the whole class, because the very first call a fresh deployment
 * makes is `signInAnonymously` and its failure modes are the earliest place a
 * missing project, a placeholder key or a blocked origin shows itself.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set<string>([
  'auth/api-key-not-valid.-not-a-valid-firebase-api-key',
  'auth/api-key-not-valid.-invalid-firebase-api-key',
  'auth/invalid-api-key',
  'auth/network-request-failed',
  'auth/operation-not-allowed',
  'auth/unauthorized-domain',
  'auth/internal-error',
  'app-check/fetch-status-error'
]);

/**
 * `true` when the failure is one a local drive could plausibly stand in for.
 *
 * Used only to decide whether to fail over, and only for a deployment that
 * asked to be real — see {@link isEmulatorEnabled} callers for why the emulator
 * path is excluded. A `true` here does not mean the failure *should* be papered
 * over, only that it is a reachability failure rather than a refusal.
 */
export function isUnreachableBackendError(error: unknown): boolean {
  const code = readFirebaseCode(error);
  if (code !== null && UNREACHABLE_CODES.has(code)) return true;
  return UNREACHABLE_KINDS.has(classifyError(error).kind);
}
