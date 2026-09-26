/**
 * The one place that knows a scope's URL.
 *
 * The sidebar, the breadcrumb trail and the scope reset in an empty state each
 * used to build their own `href`, and the layout then changed the store's scope
 * without ever telling the router. The listing and the address bar drifted
 * apart: the browser's back button did nothing, a link was not a link, and
 * re-opening the folder the URL already named was a no-op that left the app
 * showing the wrong folder.
 *
 * Deriving the path from the scope — rather than the reverse — keeps the route
 * the single source of truth for *where you are*, which is also what makes a
 * deep link into a local demo folder work.
 */
import type { DriveScope } from '$lib/stores/driveStore.svelte';

/**
 * The path a scope lives at.
 *
 * `null` is the root of My Drive, which is the site root rather than a
 * `/folder/null` segment: the app has no other reason to spell it out, and a
 * canonical URL is one that has exactly one form.
 */
export function scopeHref(scope: DriveScope): string {
  switch (scope.kind) {
    case 'folder':
      return scope.folderId === null ? '/' : `/folder/${scope.folderId}`;
    case 'starred':
      return '/starred';
    case 'trash':
      return '/trash';
  }
}

/** Two scopes addressing the same view. Used to skip a redundant navigation. */
export function isSameScope(a: DriveScope, b: DriveScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'folder' || b.kind !== 'folder') return true;
  return a.folderId === b.folderId;
}
