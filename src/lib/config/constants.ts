/**
 * Application constants.
 *
 * Everything that a product decision would eventually move to a remote config
 * lives here, so no magic number is ever written inline at a call site.
 */

/**
 * Storage ceiling granted to a newly created account, in bytes (15 GB).
 *
 * This is written once, by the client, at account creation — and
 * `firestore.rules` pins `quota.totalBytes` on every subsequent write, so it
 * can never be revised from a client after that point. A real deployment would
 * provision this from a trusted backend instead.
 */
export const DEFAULT_QUOTA_BYTES = 15 * 1024 * 1024 * 1024;

/** Hard ceiling for a single binary, enforced by both the client and `storage.rules`. */
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024;

/** Longest accepted item name. Mirrors the `isNonEmptyString(name, 255)` rule. */
export const MAX_ITEM_NAME_LENGTH = 255;

/** Shortest accepted item name once trimmed. */
export const MIN_ITEM_NAME_LENGTH = 1;

/**
 * Writes per chunked batch.
 *
 * Firestore caps a batch at 500 operations; 400 leaves headroom for the
 * `getAfter` reads and the quota document that a trashing batch may also touch.
 */
export const MAX_BATCH_OPERATIONS = 400;

/**
 * Maximum values in a Firestore `in` filter.
 *
 * Traversal queries resolve one level of a subtree at a time, so the parent ids
 * of a level must be chunked to this width.
 */
export const MAX_IN_QUERY_VALUES = 30;

/** Number of upload tasks retained in the queue after they settle. */
export const MAX_UPLOAD_TASK_HISTORY = 20;

/** Debounce before a directory drag is parsed and enqueued, in milliseconds. */
export const DIRECTORY_SCAN_DEBOUNCE_MS = 120;

/** Longest ancestor chain walked when validating a folder move. */
export const MAX_ANCESTOR_DEPTH = 64;
