/**
 * Backend-agnostic drive rules, applied to an in-memory item index.
 *
 * ## Why these exist separately
 *
 * The Firestore path enforces its structure through transactions and
 * `firestore.rules`; the local path enforces it by computing the same answers
 * before it writes. Both answers have to agree, or the same user action succeeds
 * in one mode and fails in the other — which is the worst possible outcome for a
 * fallback that is supposed to be invisible.
 *
 * Rather than trust that two implementations of "what is a legal move" stay in
 * step by review, the rules live here once and both paths are checked against
 * this file. The Firestore path keeps its transaction boundaries and its rules
 * file; this module supplies the decisions those boundaries were protecting.
 *
 * Every function here is pure and synchronous. It reads a `DriveItem` index and
 * returns either a value or a `DriveRuleError` — never a promise, never a write.
 * The local repository owns the write; this module only answers the question.
 */
import { MAX_ANCESTOR_DEPTH } from '$lib/config/constants';
import { isDriveFolder, type DriveItem } from '$lib/types/drive';
import { resolveNameCollision, type SiblingNameIndex } from '$lib/domain/itemNames';

/** An item plus its distance from the root of the operation that found it. */
export interface DriveSubtreeNode {
  readonly item: DriveItem;
  /** `0` for the item the operation was started on. */
  readonly depth: number;
}

/**
 * A refused operation, with the sentence the user should read.
 *
 * A discriminated code alongside the message so a caller can branch without
 * matching on English, and so the Firestore path can map it onto the
 * `ClassifiedError` kind it would have produced from a permission error.
 */
export type DriveRuleCode =
  | 'parent-missing'
  | 'parent-not-folder'
  | 'parent-trashed'
  | 'move-into-self'
  | 'move-into-descendant'
  | 'name-unavailable';

export class DriveRuleError extends Error {
  readonly code: DriveRuleCode;

  constructor(code: DriveRuleCode, message: string) {
    super(message);
    this.name = 'DriveRuleError';
    this.code = code;
  }
}

/**
 * A read-only view of the drive's folder graph.
 *
 * The Firestore path never builds one — it asks the server level by level — so
 * this type exists for the local repository, which holds the whole drive anyway.
 * Building it once per mutation and reusing it across the several rules a single
 * operation must satisfy keeps those rules reading the *same* snapshot, rather
 * than each seeing a graph that has shifted underneath it.
 */
export class DriveItemIndex {
  readonly #byId = new Map<string, DriveItem>();
  /** Parent id to child ids, in insertion order. */
  readonly #children = new Map<string, string[]>();

  constructor(items: Iterable<DriveItem>) {
    for (const item of items) {
      this.#byId.set(item.id, item);
      if (item.parentFolderId === null) continue;
      const bucket = this.#children.get(item.parentFolderId);
      if (bucket === undefined) this.#children.set(item.parentFolderId, [item.id]);
      else bucket.push(item.id);
    }
  }

  /** An item by id, or `null`. */
  get(itemId: string): DriveItem | null {
    return this.#byId.get(itemId) ?? null;
  }

  /** `true` when the id is present in the index. */
  has(itemId: string): boolean {
    return this.#byId.has(itemId);
  }

  /** Direct children of a folder, or of the root when `parentId` is `null`. */
  childrenOf(parentId: string | null): DriveItem[] {
    const ids = parentId === null ? this.#rootChildren() : (this.#children.get(parentId) ?? []);
    return ids
      .map((id) => this.#byId.get(id))
      .filter((item): item is DriveItem => item !== undefined);
  }

  /** Direct child ids of a folder, or of the root when `parentId` is `null`. */
  childIdsOf(parentId: string | null): readonly string[] {
    return parentId === null ? this.#rootChildren() : (this.#children.get(parentId) ?? []);
  }

  #rootChildren(): readonly string[] {
    const roots: string[] = [];
    for (const item of this.#byId.values()) {
      if (item.parentFolderId === null) roots.push(item.id);
    }
    return roots;
  }
}

/**
 * Resolve a full subtree beneath a set of roots, one level at a time.
 *
 * Level-by-level rather than a recursive descent, for the same reason the
 * Firestore path walks it level by level: the work is expressed as a frontier
 * that cannot grow a stack proportional to tree depth, and the visited set makes
 * a malformed cycle in the stored parent links terminate instead of spinning.
 *
 * A node's descendants are always included, whether or not they are themselves
 * trashed or starred — trashing a folder has to take its contents with it, and a
 * child that is separately in the trash is still a child.
 */
export function collectSubtree(index: DriveItemIndex, roots: readonly DriveItem[]): DriveSubtreeNode[] {
  const collected = new Map<string, DriveSubtreeNode>();
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

    for (const parent of frontier) {
      for (const child of index.childrenOf(parent.id)) {
        if (collected.has(child.id)) continue;
        collected.set(child.id, { item: child, depth });
        if (isDriveFolder(child)) next.push(child);
      }
    }

    frontier.length = 0;
    frontier.push(...next);
  }

  return [...collected.values()];
}

/**
 * Assert a destination folder can receive items.
 *
 * The client-side twin of `hasValidParent` in `firestore.rules`, producing the
 * same three sentences the rules' rejection would have produced. The rules
 * remain the arbiter on the remote path; this exists so the local path cannot
 * accept a move that the remote path would refuse.
 *
 * @throws DriveRuleError when the destination is missing, is not a folder, or is
 * in the trash.
 */
export function assertWritableParent(index: DriveItemIndex, parentFolderId: string | null): void {
  if (parentFolderId === null) return;

  const parent = index.get(parentFolderId);
  if (parent === null) {
    throw new DriveRuleError('parent-missing', 'The destination folder no longer exists.');
  }
  if (!isDriveFolder(parent)) {
    throw new DriveRuleError('parent-not-folder', 'Items can only be moved into a folder.');
  }
  if (parent.isTrashed) {
    throw new DriveRuleError('parent-trashed', 'The destination folder is in the trash.');
  }
}

/**
 * Prove a folder is neither `ancestorId` itself nor one of its descendants.
 *
 * `true` means the move would detach the subtree from the drive: the destination
 * would live beneath the folder being moved, and every later read of the folder
 * would have to walk up through itself forever.
 */
export function isDescendantOf(index: DriveItemIndex, candidateId: string, ancestorId: string): boolean {
  let cursor: string | null = candidateId;
  let guard = 0;

  while (cursor !== null && guard < MAX_ANCESTOR_DEPTH) {
    if (cursor === ancestorId) return true;

    const item = index.get(cursor);
    if (item === null) return false;

    cursor = item.parentFolderId;
    guard += 1;
  }
  return false;
}

/**
 * Assert every folder in a move is not moving into itself or its own subtree.
 *
 * Checked for all participants before any of them is written, so a batch that
 * contains one valid and one cyclic move is refused as a whole rather than
 * half-applied.
 *
 * @throws DriveRuleError on the first participant that would create a cycle.
 */
export function assertNoMoveCycles(index: DriveItemIndex, moving: readonly DriveItem[], destinationId: string | null): void {
  for (const item of moving) {
    if (!isDriveFolder(item)) continue;

    if (item.id === destinationId) {
      throw new DriveRuleError('move-into-self', 'A folder cannot be moved into itself.');
    }
    if (destinationId !== null && isDescendantOf(index, destinationId, item.id)) {
      throw new DriveRuleError('move-into-descendant', 'A folder cannot be moved into one of its own subfolders.');
    }
  }
}

/**
 * Normalized names already taken by the siblings an item would join.
 *
 * `excludeIds` removes the items taking part in the same operation, so a batch
 * that moves two identically named files into one folder does not make them
 * collide with each other and produce "report (1).pdf" for both.
 *
 * Trashed siblings are included, because they still hold the name: a file
 * restored tomorrow must not collide with one created today.
 */
export function takenSiblingNames(
  index: DriveItemIndex,
  parentFolderId: string | null,
  excludeIds: ReadonlySet<string>
): Set<string> {
  const taken = new Set<string>();

  for (const sibling of index.childrenOf(parentFolderId)) {
    if (excludeIds.has(sibling.id)) continue;
    taken.add(sibling.normalizedName);
  }
  return taken;
}

/**
 * Pick a free name for an item entering `parentFolderId`.
 *
 * Shared by create, rename and move so all three produce the same
 * `base (n).ext` ladder for the same sibling set. The caller owns the write; this
 * only decides the name.
 */
export function resolveFreeName(
  index: DriveItemIndex,
  parentFolderId: string | null,
  excludeIds: ReadonlySet<string>,
  desiredName: string
): { name: string; normalized: string } {
  const siblings: SiblingNameIndex = {
    taken: takenSiblingNames(index, parentFolderId, excludeIds)
  };
  return resolveNameCollision(desiredName, siblings);
}

/**
 * Destination for a restored item.
 *
 * Keeps the original parent when that parent is part of the same restore, and
 * otherwise falls back to the root whenever the original parent is still trashed,
 * is no longer a folder, or is missing. The lineage is walked rather than the
 * immediate parent alone, because a parent that is itself live but sits beneath
 * a trashed grandparent is still unrestorable, and reparenting it to the root is
 * the only outcome the user can act on.
 *
 * A chain deeper than {@link MAX_ANCESTOR_DEPTH} keeps its original parent: the
 * alternative is to move an item whose real location was never established.
 */
export function resolveRestoreParent(
  index: DriveItemIndex,
  item: DriveItem,
  restoredIds: ReadonlySet<string>
): string | null {
  const parentId = item.parentFolderId;
  if (parentId === null) return null;
  if (restoredIds.has(parentId)) return parentId;

  let cursor: string | null = parentId;
  let guard = 0;

  while (cursor !== null && guard < MAX_ANCESTOR_DEPTH) {
    if (restoredIds.has(cursor)) return parentId;

    const ancestor = index.get(cursor);
    if (ancestor === null) return null;
    if (ancestor.isTrashed || !isDriveFolder(ancestor)) return null;

    cursor = ancestor.parentFolderId;
    guard += 1;
  }

  return parentId;
}

/**
 * Subtree roots within a set of trashed items.
 *
 * Used when emptying the bin: a folder and its already-listed child are the same
 * subtree, and walking both would enumerate it twice and delete it twice.
 */
export function subtreeRoots(items: readonly DriveItem[]): DriveItem[] {
  const present = new Set(items.map((item) => item.id));
  return items.filter(
    (item) => item.parentFolderId === null || !present.has(item.parentFolderId)
  );
}
