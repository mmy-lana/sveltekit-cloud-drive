/**
 * Route params for a folder.
 *
 * A `load` rather than reading `page.params` in the component, so a malformed
 * link is rejected during navigation instead of after a Firestore query has
 * already been built around it.
 *
 * Firestore document ids are 20 characters of `[A-Za-z0-9_-]`, and the client
 * generates folder ids with the same alphabet. A route parameter is
 * user-controlled input that ends up inside a query constraint, so it is
 * validated here: a wrong-shaped id is a broken link, which is a different
 * problem from a well-formed id that names a folder the user cannot read.
 */
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

const ID_PATTERN = /^[A-Za-z0-9_-]{20}$/;

export const load: PageLoad = ({ params }) => {
  if (!ID_PATTERN.test(params.id)) {
    error(404, 'That folder link is not valid.');
  }

  return { folderId: params.id };
};
