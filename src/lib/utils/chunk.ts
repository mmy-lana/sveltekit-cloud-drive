/**
 * Chunking helpers for Firestore's hard limits.
 *
 * Kept in one module so the constants and their rationale are stated once, and
 * so the traversal code cannot quietly use the wrong bound in one place and the
 * right one in another.
 */

/**
 * Split a list into fixed-size consecutive slices.
 *
 * A trailing partial slice is included rather than dropped — an off-by-one
 * here would silently lose the last few hundred items of a large subtree.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new RangeError(`Chunk size must be positive, received ${size}.`);
  }
  if (items.length === 0) return [];

  const slices: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    slices.push(items.slice(start, start + size));
  }
  return slices;
}

/**
 * Yield batches of work, awaiting each before starting the next.
 *
 * Firestore batches must be committed one at a time, and a large tree has to be
 * written in chunks anyway. Running them strictly in sequence is what keeps a
 * subtree's descendants and ancestors from racing each other, and gives the
 * rules engine a bounded working set per commit.
 */
export async function forEachChunk<T>(
  items: readonly T[],
  size: number,
  work: (slice: T[], index: number) => Promise<void>
): Promise<void> {
  const slices = chunk(items, size);
  for (let index = 0; index < slices.length; index += 1) {
    await work(slices[index], index);
  }
}
