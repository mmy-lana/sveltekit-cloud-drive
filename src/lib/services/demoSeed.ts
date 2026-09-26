/**
 * Content planted into an empty local drive.
 *
 * ## Why seed at all
 *
 * A drive with nothing in it proves nothing. The first screen would show an
 * empty state, and every affordance — sorting, filtering, previewing, trashing,
 * the storage meter — would be untested and invisible until the user happened to
 * produce the right file. One folder with a text file and an image exercises the
 * folder tree, the listing, both preview paths, and the quota gauge in a single
 * glance, and it tells anyone who lands on the demo what they are looking at.
 *
 * ## Why the image is inline base64
 *
 * The obvious alternative is to fetch or draw one at seed time. Both are worse:
 * a fetch is a network dependency in the one mode that exists precisely because
 * the network is not available, and drawing one means a canvas round trip whose
 * failure would have to be handled on a path that should not be able to fail.
 *
 * So the bytes are here, as a real 128x72 PNG — signature, IHDR, IDAT and IEND,
 * about 1.8 KB, decodable by anything that can decode an image file. A malformed
 * decode is caught at seed time and the file is simply not planted, which leaves
 * a drive with a folder and a text file rather than a drive that failed to open.
 */

/** Name of the folder planted at the drive root. */
export const SEED_FOLDER_NAME = 'Welcome to Cloud Drive';

/** A short note explaining what the user is looking at. */
export const SEED_README_NAME = 'Read me first.md';

/** The sample image, named so the preview path is obvious from the listing. */
export const SEED_IMAGE_NAME = 'Drive overview.png';

/** MIME type recorded for the seeded image. */
export const SEED_IMAGE_MIME = 'image/png';

/** MIME type recorded for the seeded note. */
export const SEED_README_MIME = 'text/markdown';

/**
 * Body of the seeded note.
 *
 * Written as a list of what actually works, because in demo mode the honest
 * answer to "is this real?" is "the bytes are real, the server is not", and a
 * user who knows that will exercise the drive properly.
 */
export const SEED_README_BODY = `# Welcome to your local drive

This drive is running in **Demo Mode**: there is no Firebase project behind it,
so everything you do here is stored in this browser's IndexedDB.

## What still works

- Uploading real files, stored as blobs and shown at their true byte size
- Creating, renaming, moving, starring, trashing and permanently deleting
- Previewing images and text, rendered from the stored bytes
- The storage meter, against a 1 GB local ceiling

## What is different

- Nothing leaves this device. Clearing site data deletes the drive with it.
- The local quota is 1 GB, not the 15 GB a real account is granted.
- There is no second device to sync with. Two tabs share one local drive;
  a different browser or a different machine does not.

## Leaving demo mode

Point \`PUBLIC_FIREBASE_*\` at a real project and set
\`PUBLIC_USE_FIREBASE_EMULATOR=false\`. The app re-initialises against Firebase
on the next load and the local drive stays where it is, untouched.
`;

/**
 * The sample image, as a base64-encoded PNG.
 *
 * Line breaks and the surrounding quotes are part of the encoding pipeline, not
 * the payload: {@link decodeSeedImage} joins the pieces before decoding.
 */
const SEED_IMAGE_BASE64_PARTS: readonly string[] = [
  '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'
];

/**
 * Decode the sample image into a `Blob`.
 *
 * A `Blob` rather than a `Uint8Array` because that is the shape the storage
 * layer needs, and returning it from here keeps the one unavoidable
 * buffer-to-blob conversion on the same line as the base64 it comes from,
 * instead of spreading a byte-array responsibility across both modules.
 *
 * @returns The PNG, or `null` when the payload is not decodable in this
 * environment. A `null` is a survivable outcome — the seed is a convenience, and
 * refusing to open the drive over it would be the wrong trade.
 */
export function decodeSeedImage(): Blob | null {
  try {
    const binary = atob(SEED_IMAGE_BASE64_PARTS.join(''));
    // Copied into a fresh `Uint8Array` before it reaches the `Blob` constructor
    // so the bytes are a plain `ArrayBuffer` buffer and not a view onto one the
    // caller could still write through.
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes.buffer as ArrayBuffer], { type: SEED_IMAGE_MIME });
  } catch {
    return null;
  }
}
