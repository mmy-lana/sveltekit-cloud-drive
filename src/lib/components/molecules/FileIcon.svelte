<script lang="ts">
  /**
   * Deterministic vector icon generator.
   *
   * The same file always produces the same glyph: shape comes from the
   * resolved {@link FileCategory}, and the only per-file variation is the
   * two-letter extension badge. Nothing here is a font icon, so it inherits
   * colour, scales cleanly, and never shows a tofu box.
   */
  import { getFileMimeDescriptor, type FileCategory } from '$lib/utils/mimetypes';
  import type { ItemType } from '$lib/types/drive';

  type IconSize = 'sm' | 'md' | 'lg' | 'xl';

  interface Props {
    name: string;
    type: ItemType;
    mimeType?: string | null;
    size?: IconSize;
    /** Overrides the category accent, e.g. to match a folder's custom colour. */
    color?: string | null;
    /** Renders the extension badge (files only). */
    showBadge?: boolean;
    class?: string;
  }

  let {
    name,
    type,
    mimeType = null,
    size = 'md',
    color = null,
    showBadge = true,
    class: className
  }: Props = $props();

  const SIZE_PX: Record<IconSize, number> = { sm: 20, md: 28, lg: 40, xl: 64 };

  const descriptor = $derived(getFileMimeDescriptor({ name, type, mimeType }));
  const pixels = $derived(SIZE_PX[size]);

  interface CategoryPalette {
    body: string;
    fold: string;
    accent: string;
  }

  /**
   * Per-category palette. Folder accents resolve to the user-chosen colour when
   * one is supplied; files keep the stable category colour so a list reads as
   * one consistent system.
   */
  const PALETTES: Record<FileCategory, CategoryPalette> = {
    folder: { body: '#f5b942', fold: '#e09b26', accent: '#ffffff' },
    image: { body: '#3b82f6', fold: '#2563eb', accent: '#ffffff' },
    video: { body: '#8b5cf6', fold: '#6d28d9', accent: '#ffffff' },
    audio: { body: '#ec4899', fold: '#be185d', accent: '#ffffff' },
    pdf: { body: '#ef4444', fold: '#b91c1c', accent: '#ffffff' },
    text: { body: '#64748b', fold: '#475569', accent: '#ffffff' },
    code: { body: '#0ea5e9', fold: '#0369a1', accent: '#ffffff' },
    document: { body: '#2563eb', fold: '#1d4ed8', accent: '#ffffff' },
    spreadsheet: { body: '#16a34a', fold: '#15803d', accent: '#ffffff' },
    presentation: { body: '#f97316', fold: '#c2410c', accent: '#ffffff' },
    archive: { body: '#a16207', fold: '#713f12', accent: '#ffffff' },
    font: { body: '#6366f1', fold: '#4338ca', accent: '#ffffff' },
    binary: { body: '#94a3b8', fold: '#64748b', accent: '#ffffff' }
  };

  const palette = $derived<Pick<CategoryPalette, 'body' | 'fold'>>(
    type === 'folder' && color !== null
      ? { body: color, fold: color }
      : { body: PALETTES[descriptor.category].body, fold: PALETTES[descriptor.category].fold }
  );

  const accent = $derived(PALETTES[descriptor.category].accent);

  /** Two-character badge, uppercased, e.g. "pd", "js", "" for folders. */
  const badge = $derived.by(() => {
    if (type === 'folder') return '';
    if (!showBadge) return '';
    const extension = descriptor.extension;
    if (extension === null) return descriptor.category === 'binary' ? 'bin' : 'file';
    return extension.slice(0, 2);
  });

  const badgeFontSize = $derived(Math.max(7, pixels * 0.19));
  const showsBadge = $derived(badge.length > 0 && pixels >= 24);
</script>

<svg
  width={pixels}
  height={pixels}
  viewBox="0 0 48 48"
  fill="none"
  role="img"
  aria-label="{descriptor.label}: {name}"
  class={className ?? ''}
>
  <title>{name} — {descriptor.label}</title>

  <!-- Document/folder body with a folded corner. -->
  <path
    d="M9 7.5A3.5 3.5 0 0 1 12.5 4h14.38a3.5 3.5 0 0 1 2.47 1.02l6.63 6.63A3.5 3.5 0 0 1 37 14.13V40.5A3.5 3.5 0 0 1 33.5 44h-21A3.5 3.5 0 0 1 9 40.5v-33Z"
    fill={palette.body}
  />
  <path d="M28 4.5V13a2 2 0 0 0 2 2h6.5L28 4.5Z" fill={palette.fold} opacity="0.85" />

  {#if type === 'folder'}
    <!-- Tab affordance so a folder never reads as a document. -->
    <path d="M6 18.5A3.5 3.5 0 0 1 9.5 15h9.2a2 2 0 0 1 1.5.69l2.1 2.42H38.5A3.5 3.5 0 0 1 42 21.6v3.9H6v-7Z" fill={palette.fold} />
  {:else if showsBadge}
    <text
      x="24"
      y="34"
      text-anchor="middle"
      dominant-baseline="middle"
      fill={accent}
      font-family="ui-sans-serif, system-ui, sans-serif"
      font-size="{badgeFontSize}"
      font-weight="700"
      letter-spacing="0.02em"
    >{badge.toUpperCase()}</text>
  {/if}
</svg>
