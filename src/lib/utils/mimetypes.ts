/**
 * Deterministic MIME-type resolution engine.
 *
 * Browsers hand over wildly inconsistent `File.type` values: Chrome returns an
 * empty string for unknown binaries, Safari returns `application/octet-stream`
 * for plenty of known formats, and drag-and-drop events frequently carry no
 * type at all. This module resolves a stable, display-grade classification by
 * combining three ordered signals:
 *
 * 1. the file extension (most reliable for the *actual* file the user picked),
 * 2. the declared MIME type (authoritative when it is specific),
 * 3. a documented fallback (`application/octet-stream`).
 *
 * Everything here is pure and side-effect free, and the extension index is built
 * once at module load in a deterministic order, so two runs on two machines
 * classify the same file identically.
 */

import type { ItemType } from '$lib/types/drive';

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Coarse, presentation-oriented buckets.
 *
 * These drive icon selection, preview capability and list filtering — they are
 * intentionally far fewer than MIME types so the UI can stay consistent.
 */
export type FileCategory =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'code'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'font'
  | 'binary';

/** How {@link FilePreviewModal} should render a file once its blob is resolved. */
export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';

/** Human-readable label per category, used for badges and empty-state copy. */
export const FILE_CATEGORY_LABELS: Readonly<Record<FileCategory, string>> = Object.freeze({
  folder: 'Folder',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF document',
  text: 'Text document',
  code: 'Source file',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  archive: 'Archive',
  font: 'Font',
  binary: 'File'
});

/** Categories whose bytes are directly viewable in a browser tab. */
const PREVIEWABLE_CATEGORIES: ReadonlySet<FileCategory> = new Set<FileCategory>([
  'image',
  'video',
  'audio',
  'pdf',
  'text',
  'code'
]);

/** Categories the browser can play inline without conversion. */
const PLAYABLE_CATEGORIES: ReadonlySet<FileCategory> = new Set<FileCategory>([
  'video',
  'audio'
]);

/** Categories worth requesting a thumbnail for. */
const THUMBNAILABLE_CATEGORIES: ReadonlySet<FileCategory> = new Set<FileCategory>(['image']);

/** MIME string used whenever nothing more specific is known. */
export const FALLBACK_MIME_TYPE = 'application/octet-stream';

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Strip parameters and casing from a MIME type.
 *
 * @example
 * normalizeMimeType('Text/Plain; charset=UTF-8') // 'text/plain'
 * normalizeMimeType(undefined)                    // null
 */
export function normalizeMimeType(mimeType: string | null | undefined): string | null {
  if (typeof mimeType !== 'string') return null;

  const [essence] = mimeType.split(';');
  if (essence === undefined) return null;

  const normalized = essence.trim().toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

/** `true` when the declared type carries no classification information. */
export function isGenericMimeType(mimeType: string | null | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized === null || normalized === FALLBACK_MIME_TYPE;
}

/* -------------------------------------------------------------------------- */
/* Filename helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Lower-cased extension without the dot, or `null` for dotfiles / extensionless names. */
export function getFileExtension(fileName: string): string | null {
  if (typeof fileName !== 'string') return null;

  const lastSegment = fileName.split(/[\\/]/).pop() ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');

  // A leading dot means a dotfile (`.gitignore`), not an extension.
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return null;

  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

/** Filename without its extension. `archive.tar.gz` -> `archive.tar`. */
export function stripFileExtension(fileName: string): string {
  const extension = getFileExtension(fileName);
  if (extension === null) return fileName;

  return fileName.slice(0, fileName.length - extension.length - 1);
}

/** Filename without its directory component. */
export function getBaseName(fileName: string): string {
  if (typeof fileName !== 'string') return '';
  return fileName.split(/[\\/]/).pop() ?? '';
}

/* -------------------------------------------------------------------------- */
/* Extension -> MIME index                                                     */
/* -------------------------------------------------------------------------- */

/** Authoritative extension to MIME map used for `File.type`-less uploads. */
export const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  // Images
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/vnd.microsoft.icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  raw: 'image/x-panasonic-raw',

  // Video
  '3gp': 'video/3gpp',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  ogv: 'video/ogg',
  webm: 'video/webm',
  wmv: 'video/x-ms-wmv',

  // Audio
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mid: 'audio/midi',
  midi: 'audio/midi',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  weba: 'audio/webm',
  wma: 'audio/x-ms-wma',

  // Documents
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  pdf: 'application/pdf',
  pages: 'application/vnd.apple.pages',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',

  // Spreadsheets
  csv: 'text/csv',
  numbers: 'application/vnd.apple.numbers',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  tsv: 'text/tab-separated-values',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  // Presentations
  odp: 'application/vnd.oasis.opendocument.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',

  // Archives
  '7z': 'application/x-7z-compressed',
  bz2: 'application/x-bzip2',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
  xz: 'application/x-xz',
  zip: 'application/zip',
  zst: 'application/zstd',

  // Fonts
  eot: 'application/vnd.ms-fontobject',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',

  // Source code
  bash: 'text/x-shellscript',
  bat: 'text/plain',
  c: 'text/x-c',
  cc: 'text/x-c++',
  clj: 'text/x-clojure',
  cpp: 'text/x-c++',
  cs: 'text/x-csharp',
  css: 'text/css',
  dart: 'application/dart',
  diff: 'text/x-diff',
  dockerfile: 'text/x-dockerfile',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  go: 'text/x-go',
  gql: 'application/graphql',
  graphql: 'application/graphql',
  h: 'text/x-c',
  hpp: 'text/x-c++',
  hs: 'text/haskell',
  html: 'text/html',
  htm: 'text/html',
  ini: 'text/plain',
  java: 'text/x-java-source',
  js: 'text/javascript',
  json: 'application/json',
  jsonc: 'application/json',
  jsx: 'text/jsx',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  less: 'text/x-less',
  lua: 'text/x-lua',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  php: 'application/x-httpd-php',
  pl: 'text/x-perl',
  ps1: 'text/plain',
  py: 'text/x-python',
  r: 'text/x-r',
  rb: 'text/x-ruby',
  rs: 'text/rust',
  sass: 'text/x-sass',
  scala: 'text/x-scala',
  scss: 'text/x-scss',
  sh: 'text/x-shellscript',
  sql: 'application/sql',
  svelte: 'text/x-svelte',
  swift: 'text/x-swift',
  toml: 'text/plain',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  vue: 'text/x-vue',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  zsh: 'text/x-shellscript',

  // Misc
  apk: 'application/vnd.android.package-archive',
  bin: 'application/octet-stream',
  exe: 'application/vnd.microsoft.portable-executable',
  iso: 'application/x-iso9660-image',
  dmg: 'application/x-apple-diskimage',
  wasm: 'application/wasm'
});

/**
 * Extension keys sorted longest-first, then alphabetically.
 *
 * The stable ordering is what makes `guessMimeType` deterministic when two
 * suffixes could both match; it also guarantees multi-part extensions such as
 * `tar.gz` are matched before the shorter `gz`.
 */
const SORTED_EXTENSIONS: readonly string[] = Object.freeze(
  Object.keys(MIME_TYPE_BY_EXTENSION).sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length;
    return left.localeCompare(right);
  })
);

/**
 * Best-effort MIME type for a filename, derived from its extension.
 *
 * Returns `null` — never a guess — when the extension is unknown, so callers
 * can distinguish "known file type" from "unknown extension" in filter UIs.
 *
 * @example
 * guessMimeType('holiday.JPEG') // 'image/jpeg'
 * guessMimeType('notes')        // null
 */
export function guessMimeType(fileName: string): string | null {
  const extension = getFileExtension(fileName);
  if (extension === null) return null;

  return MIME_TYPE_BY_EXTENSION[extension] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Category resolution                                                         */
/* -------------------------------------------------------------------------- */

/** Exact MIME matches, checked before the prefix table. */
const MIME_CATEGORY_BY_EXACT_TYPE: Readonly<Record<string, FileCategory>> = Object.freeze({
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/rtf': 'document',
  'text/rtf': 'document',
  'text/csv': 'spreadsheet',
  'text/tab-separated-values': 'spreadsheet',
  'application/json': 'code',
  'application/ld+json': 'code',
  'application/xml': 'code',
  'application/graphql': 'code',
  'application/xhtml+xml': 'code',
  'application/wasm': 'binary',
  'application/octet-stream': 'binary',
  'application/zip': 'archive',
  'application/gzip': 'archive',
  'application/x-7z-compressed': 'archive',
  'application/vnd.rar': 'archive',
  'application/x-tar': 'archive',
  'application/x-bzip2': 'archive',
  'application/x-xz': 'archive',
  'application/zstd': 'archive',
  'application/vnd.android.package-archive': 'archive',
  'application/vnd.ms-fontobject': 'font',
  'font/otf': 'font',
  'font/ttf': 'font',
  'font/woff': 'font',
  'font/woff2': 'font',
  'application/font-sfnt': 'font',
  'application/vnd.ms-powerpoint': 'presentation',
  'application/vnd.ms-excel': 'spreadsheet'
});

/** Prefix matches (`image/*`), evaluated in declaration order after exact matches. */
const MIME_CATEGORY_BY_PREFIX: ReadonlyArray<readonly [string, FileCategory]> = Object.freeze([
  ['image/', 'image'],
  ['video/', 'video'],
  ['audio/', 'audio'],
  ['text/', 'text'],
  ['font/', 'font']
]);

/** Exact MIME matches that are code despite living under an office namespace. */
const CODE_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/javascript',
  'application/ecmascript',
  'application/typescript',
  'application/x-javascript',
  'application/x-typescript',
  'application/toml',
  'application/x-toml',
  'application/x-sh',
  'application/x-shellscript',
  'application/sql',
  'application/x-httpd-php',
  'application/dart',
  'application/x-perl',
  'application/x-ruby',
  'application/x-httpd-php-src',
  'application/x-latex',
  'application/x-tex'
]);

/** Office namespaces that are documents, not spreadsheets or presentations. */
const DOCUMENT_MIME_PREFIXES: readonly string[] = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.ms-word',
  'application/msword',
  'application/vnd.apple.pages'
];

const SPREADSHEET_MIME_PREFIXES: readonly string[] = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.ms-excel',
  'application/vnd.apple.numbers'
];

const PRESENTATION_MIME_PREFIXES: readonly string[] = [
  'application/vnd.openxmlformats-officedocument.presentationml',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.apple.keynote'
];

/** Extensions that always mean "source code", even without a MIME hint. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'bash', 'bat', 'c', 'cc', 'clj', 'cpp', 'cs', 'css', 'dart', 'diff', 'dockerfile',
  'ex', 'exs', 'go', 'gql', 'graphql', 'h', 'hpp', 'hs', 'html', 'htm', 'ini', 'java',
  'js', 'json', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'lua', 'mjs', 'cjs', 'php', 'pl',
  'ps1', 'py', 'r', 'rb', 'rs', 'sass', 'scala', 'scss', 'sh', 'sql', 'svelte', 'swift',
  'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml', 'zsh'
]);

/** Text-ish extensions that render as plain text in the preview modal. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['log', 'text', 'txt', 'csv', 'tsv', 'env']);

/** Extensions treated as archives even when the MIME is missing or generic. */
const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  '7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip', 'zst'
]);

/** `true` when `mimeType` starts with any of the given namespace prefixes. */
function matchesAnyPrefix(mimeType: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => mimeType.startsWith(prefix));
}

/**
 * Classify a MIME type into a {@link FileCategory}.
 *
 * The MIME type is authoritative when it is specific; the optional
 * `fileName` is consulted only to break ties the MIME cannot (e.g. a `.ts`
 * reported as `application/octet-stream`).
 */
export function getMimeCategory(mimeType: string | null | undefined, fileName?: string): FileCategory {
  const normalized = normalizeMimeType(mimeType);
  const extension = fileName === undefined ? null : getFileExtension(fileName);

  if (normalized !== null) {
    const exact = MIME_CATEGORY_BY_EXACT_TYPE[normalized];
    if (exact !== undefined) return exact;

    if (CODE_MIME_TYPES.has(normalized)) return 'code';
    if (matchesAnyPrefix(normalized, DOCUMENT_MIME_PREFIXES)) return 'document';
    if (matchesAnyPrefix(normalized, SPREADSHEET_MIME_PREFIXES)) return 'spreadsheet';
    if (matchesAnyPrefix(normalized, PRESENTATION_MIME_PREFIXES)) return 'presentation';

    for (const [prefix, category] of MIME_CATEGORY_BY_PREFIX) {
      if (normalized.startsWith(prefix)) {
        // `text/plain` is the most common lie in the wild: `.ts` and `.json`
        // files are frequently reported as plain text.
        if (category === 'text' && extension !== null && CODE_EXTENSIONS.has(extension)) {
          return 'code';
        }
        if (category === 'text' && extension !== null && TEXT_EXTENSIONS.has(extension)) {
          return 'text';
        }
        return category;
      }
    }
  }

  if (extension !== null) {
    if (CODE_EXTENSIONS.has(extension)) return 'code';
    if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
    if (TEXT_EXTENSIONS.has(extension)) return 'text';

    const guessed = MIME_TYPE_BY_EXTENSION[extension];
    if (guessed !== undefined) {
      // Re-enter classification with the authoritative guessed MIME so a single
      // definition of "what is a PDF" backs both paths.
      return getMimeCategory(guessed, fileName);
    }
  }

  return 'binary';
}

/**
 * Full resolution: MIME first, extension as fallback.
 *
 * @returns a concrete MIME type, never `null`; falls back to
 * {@link FALLBACK_MIME_TYPE}.
 *
 * @example
 * resolveMimeType({ name: 'clip.mp4', type: '' })                  // 'video/mp4'
 * resolveMimeType({ name: 'blob', type: 'application/octet-stream' })// 'application/octet-stream'
 */
export function resolveMimeType(input: { name: string; type?: string | null }): string {
  const declared = normalizeMimeType(input.type);
  if (declared !== null && declared !== FALLBACK_MIME_TYPE) {
    return declared;
  }

  return guessMimeType(input.name) ?? FALLBACK_MIME_TYPE;
}

/** Classify a `File`-like input (`{ name, type }`) into a {@link FileCategory}. */
export function getFileCategory(file: { name: string; type?: string | null }): FileCategory {
  return getMimeCategory(resolveMimeType(file), file.name);
}

/* -------------------------------------------------------------------------- */
/* Capability predicates                                                       */
/* -------------------------------------------------------------------------- */

function categoryOf(mimeType: string | null | undefined, fileName?: string): FileCategory {
  return getMimeCategory(mimeType, fileName);
}

/** `true` for anything the browser renders as a still image. */
export function isImageMime(mimeType: string | null | undefined, fileName?: string): boolean {
  return categoryOf(mimeType, fileName) === 'image';
}

/** `true` for anything the browser plays as video. */
export function isVideoMime(mimeType: string | null | undefined, fileName?: string): boolean {
  return categoryOf(mimeType, fileName) === 'video';
}

/** `true` for anything the browser plays as audio. */
export function isAudioMime(mimeType: string | null | undefined, fileName?: string): boolean {
  return categoryOf(mimeType, fileName) === 'audio';
}

/** `true` for PDF documents, including the legacy `x-pdf` alias. */
export function isPdfMime(mimeType: string | null | undefined, fileName?: string): boolean {
  return categoryOf(mimeType, fileName) === 'pdf';
}

/** `true` for plain text and source code. */
export function isTextLike(mimeType: string | null | undefined, fileName?: string): boolean {
  const category = categoryOf(mimeType, fileName);
  return category === 'text' || category === 'code';
}

/** `true` for compressed bundles. */
export function isArchiveMime(mimeType: string | null | undefined, fileName?: string): boolean {
  return categoryOf(mimeType, fileName) === 'archive';
}

/** `true` for source code. */
export function isCodeMime(mimeType: string | null | undefined, fileName?: string): boolean {
  return categoryOf(mimeType, fileName) === 'code';
}

/** `true` for anything renderable as a still thumbnail. */
export function isThumbnailable(mimeType: string | null | undefined, fileName?: string): boolean {
  return THUMBNAILABLE_CATEGORIES.has(categoryOf(mimeType, fileName));
}

/** `true` for anything playable inline with a `<video>`/`<audio>` element. */
export function isPlayableMime(mimeType: string | null | undefined, fileName?: string): boolean {
  return PLAYABLE_CATEGORIES.has(categoryOf(mimeType, fileName));
}

/** `true` for anything the preview modal can render without a download. */
export function isPreviewableMime(mimeType: string | null | undefined, fileName?: string): boolean {
  return PREVIEWABLE_CATEGORIES.has(categoryOf(mimeType, fileName));
}

/**
 * Which preview surface a file needs.
 *
 * @returns `'none'` for categories with no inline representation, which the
 * preview modal renders as an explicit "no preview available" state.
 */
export function getPreviewKind(mimeType: string | null | undefined, fileName?: string): PreviewKind {
  const category = categoryOf(mimeType, fileName);
  switch (category) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'pdf':
      return 'pdf';
    case 'text':
    case 'code':
      return 'text';
    default:
      return 'none';
  }
}

/* -------------------------------------------------------------------------- */
/* Presentation descriptors                                                    */
/* -------------------------------------------------------------------------- */

/** Everything a file icon needs to render, resolved in one pass. */
export interface FileMimeDescriptor {
  /** Normalised MIME type, or `null` when nothing is known. */
  mimeType: string | null;
  /** Presentation bucket. */
  category: FileCategory;
  /** Human-readable category label. */
  label: string;
  /** Lower-cased extension without the dot, or `null`. */
  extension: string | null;
  /** Whether the preview modal can render it. */
  previewable: boolean;
  /** Which preview surface it needs. */
  previewKind: PreviewKind;
}

/**
 * Build a complete descriptor for an item.
 *
 * Folders short-circuit on their `type` discriminator — the caller must say
 * whether this is a folder, because an extensionless *file* ("Makefile",
 * "LICENSE") is not a folder and must never be misclassified as one.
 */
export function getFileMimeDescriptor(input: {
  name: string;
  type: ItemType;
  mimeType?: string | null;
}): FileMimeDescriptor {
  if (input.type === 'folder') {
    return {
      mimeType: null,
      category: 'folder',
      label: FILE_CATEGORY_LABELS.folder,
      extension: null,
      previewable: false,
      previewKind: 'none'
    };
  }

  const normalized = normalizeMimeType(input.mimeType);
  const category = getMimeCategory(normalized, input.name);

  return {
    mimeType: normalized,
    category,
    label: FILE_CATEGORY_LABELS[category],
    extension: getFileExtension(input.name),
    previewable: PREVIEWABLE_CATEGORIES.has(category),
    previewKind: getPreviewKind(normalized, input.name)
  };
}

/**
 * `true` when the declared MIME type is a meaningful, non-generic value.
 *
 * The upload pipeline stores the *resolved* MIME type, so this predicate is the
 * guard for "the browser actually knew what this file was".
 */
export function hasSpecificMimeType(mimeType: string | null | undefined): boolean {
  return !isGenericMimeType(mimeType);
}

/**
 * Every known extension, longest first.
 *
 * Exported so the extension filter UI can enumerate the same list the
 * classifier uses instead of maintaining a divergent copy.
 */
export function getKnownExtensions(): readonly string[] {
  return SORTED_EXTENSIONS;
}

/** Every distinct category present in {@link FILE_CATEGORY_LABELS}, in declaration order. */
export function getAllCategories(): readonly FileCategory[] {
  return Object.keys(FILE_CATEGORY_LABELS) as FileCategory[];
}

/**
 * Test a MIME type against a category filter.
 *
 * Mirrors the `mimeFilter` field of `FilterSortOptions`, which stores a single
 * category (or `null` for "no MIME filtering").
 */
export function matchesCategoryFilter(
  mimeType: string | null | undefined,
  category: FileCategory | null,
  fileName?: string
): boolean {
  if (category === null) return true;
  return categoryOf(mimeType, fileName) === category;
}
