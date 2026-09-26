/**
 * Item name validation and deterministic sibling-collision resolution.
 *
 * Naming is the one piece of write logic that must agree perfectly between the
 * client and `firestore.rules`: the rules assert that `normalizedName` is
 * present, non-empty, and never longer than `name`, which is the one invariant
 * that survives the fact that rules cannot run Unicode normalisation. Every
 * helper here therefore produces both halves of that pair together.
 */

import { MAX_ITEM_NAME_LENGTH, MIN_ITEM_NAME_LENGTH } from '$lib/config/constants';

/**
 * The canonical key used for sibling comparisons and range queries.
 *
 * NFC composition first so that a decomposed `e` + combining acute and a
 * precomposed `é` produce the same key, then trim, then case-fold.
 *
 * `toLowerCase()` rather than `toLocaleLowerCase()` on purpose: the case
 * mapping must not depend on the viewer's locale, or two clients in different
 * locales would disagree about whether a name collides.
 */
export function normalizeItemName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** Result of validating a candidate item name. */
export type NameValidation =
  | { readonly valid: true; readonly name: string; readonly normalized: string }
  | { readonly valid: false; readonly reason: NameError };

/** Why a candidate item name was rejected. */
export type NameError =
  | 'empty'
  | 'too-long'
  | 'trailing-period'
  | 'reserved'
  | 'control-characters'
  | 'only-spaces';

/**
 * Names the drive refuses outright.
 *
 * These are not legal on Windows, macOS or common filesystems, and a later
 * export or sync to any of those targets would fail on them.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  'desktop', '.', '..'
]);

/** Control characters that are illegal in a path segment on at least one platform. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Split a filename into its stem and extension.
 *
 * The extension is everything after the final dot, and only when that dot is
 * not the first character (`.gitignore` has no extension) and not the last
 * (`trailing.` has no extension either).
 */
export function splitFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * Validate a user-supplied name and return the canonical pair to persist.
 *
 * @param rawName The name exactly as typed, before any normalisation.
 * @returns A discriminated result carrying the trimmed name to store together
 * with the key to index it by, or the specific reason it was rejected.
 */
export function validateItemName(rawName: string): NameValidation {
  const name = rawName.normalize('NFC').trim();

  if (name.length === 0) {
    return { valid: false, reason: rawName.trim().length === 0 ? 'empty' : 'only-spaces' };
  }
  if (name.length > MAX_ITEM_NAME_LENGTH) {
    return { valid: false, reason: 'too-long' };
  }
  if (CONTROL_CHARACTERS.test(name)) {
    return { valid: false, reason: 'control-characters' };
  }
  if (name.endsWith('.')) {
    return { valid: false, reason: 'trailing-period' };
  }

  const { stem } = splitFileName(name);
  if (RESERVED_NAMES.has(stem.toLowerCase())) {
    return { valid: false, reason: 'reserved' };
  }

  return { valid: true, name, normalized: normalizeItemName(name) };
}

/** A user-facing sentence for each rejection reason. */
export const NAME_ERROR_MESSAGES: Readonly<Record<NameError, string>> = Object.freeze({
  empty: 'Enter a name.',
  'only-spaces': 'A name cannot be only spaces.',
  'too-long': `Names are limited to ${MAX_ITEM_NAME_LENGTH} characters.`,
  'trailing-period': 'Names cannot end with a period.',
  reserved: 'That name is reserved by the operating system.',
  'control-characters': 'Names cannot contain control characters.'
});

/**
 * The set of sibling keys a write must avoid, together with whether the item
 * being written is itself in that set.
 *
 * `excludeId` makes a rename a no-op when the name is unchanged: without it,
 * an item would collide with its own existing document and receive a ` (1)`
 * suffix for nothing.
 */
export interface SiblingNameIndex {
  /** Every normalized sibling name under the destination. */
  readonly taken: ReadonlySet<string>;
  /** The item currently being renamed, excluded from collisions. */
  readonly excludeId?: string | null;
}

/**
 * Append the smallest free numeric suffix to a colliding name.
 *
 * Produces `base (1).ext`, `base (2).ext`, ... incrementing from one and
 * skipping any candidate another sibling already holds, so the result is
 * deterministic for a given sibling set.
 *
 * The scan is bounded: a directory that already contains five thousand copies
 * of `report.pdf` cannot push the counter past five thousand in practice, but
 * the bound keeps a pathological case from becoming an infinite loop.
 */
export function resolveNameCollision(
  desiredName: string,
  siblings: SiblingNameIndex
): { name: string; normalized: string } {
  const taken = siblings.taken;
  const desiredNormalized = normalizeItemName(desiredName);

  if (!taken.has(desiredNormalized)) {
    return { name: desiredName, normalized: desiredNormalized };
  }

  const { stem, extension } = splitFileName(desiredName);

  for (let counter = 1; counter <= 10_000; counter += 1) {
    const candidate = `${stem} (${counter})${extension}`;
    const candidateNormalized = normalizeItemName(candidate);
    if (!taken.has(candidateNormalized)) {
      return { name: candidate, normalized: candidateNormalized };
    }
  }

  // Unreachable in practice; a distinct name is better than a thrown error.
  const fallback = `${stem} (${Date.now()})${extension}`;
  return { name: fallback, normalized: normalizeItemName(fallback) };
}
