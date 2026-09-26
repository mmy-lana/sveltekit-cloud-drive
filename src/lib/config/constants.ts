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

/**
 * MIME type carrying a dragged folder's id.
 *
 * A custom type rather than `text/plain` so the drop can be told apart from
 * dragging text into the page, which the upload dropzone handles separately.
 */
export const FOLDER_DRAG_MIME = 'application/x-drive-folder-id';

/** Longest ancestor chain walked when validating a folder move. */
export const MAX_ANCESTOR_DEPTH = 64;

/**
 * The plan's responsive matrix, as three lower bounds in CSS pixels.
 *
 * The layout switches on these in JavaScript — the navigation changes shape,
 * not just size, so it cannot be left to media queries alone — and in CSS
 * through the matching `sm:`/`md:`/`lg:` prefixes. Keep the two in step:
 * `sm` is 640 in Tailwind, which is deliberately *not* a matrix boundary, so
 * the prefixes are only used for spacing refinements inside a tier.
 */
export const VIEWPORT_TIER_MIN_WIDTH = {
  /** Below this the primary navigation is a fixed bottom bar. */
  tablet: 768,
  /** At or above this the sidebar is persistent and fully labelled. */
  desktop: 1024
} as const;

/** Width assumed before the client has measured, matching the desktop tier. */
export const DEFAULT_VIEWPORT_WIDTH = VIEWPORT_TIER_MIN_WIDTH.desktop;
