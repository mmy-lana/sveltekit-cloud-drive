<script lang="ts">
  /**
   * Primary navigation.
   *
   * One component, three presentations, because they are the same list of links
   * and duplicating them three times is how the tablet rail ends up missing an
   * entry the sidebar has. The caller picks the density:
   *
   * - `full` — the 256px desktop sidebar, labels always visible.
   * - `rail` — the 64px tablet rail, icons with tooltips.
   * - `bottom` — the mobile bar, icons above 10px labels.
   *
   * The active link is marked with `aria-current="page"` and a filled
   * background, never by colour alone. The storage meter and the account chip
   * are part of the same component because on mobile they live *above* the bar
   * in the same visual band, and splitting them would mean two components
   * tracking the same quota.
   */
  import { HardDrive, LogOut, LoaderCircle, Star, Trash } from '@lucide/svelte';
  import type { LucideIcon } from '@lucide/svelte';
  import StorageMeter from '$lib/components/molecules/StorageMeter.svelte';
  import { formatCount } from '$lib/utils/formatters';
  import type { StorageQuota } from '$lib/types/drive';
  import type { DriveScope } from '$lib/stores/driveStore.svelte';

  /** How much of the component to render. */
  type Density = 'full' | 'rail' | 'bottom';

  interface Props {
    density: Density;
    /** The scope currently on screen, used to mark the active link. */
    scope: DriveScope;
    /** Signed-in display name, or `null` while it is still loading. */
    displayName: string | null;
    /** Signed-in email, shown in the account chip. */
    email: string | null;
    /** Quota figures. Zeroed before the profile has loaded. */
    quota: StorageQuota;
    /** Count in the trash, for the badge. */
    trashCount: number;
    /** True while an auth operation is in flight. */
    busy: boolean;
    onNavigate: (scope: DriveScope) => void;
    onSignOut: () => void;
  }

  let {
    density,
    scope,
    displayName,
    email,
    quota,
    trashCount,
    busy,
    onNavigate,
    onSignOut
  }: Props = $props();

  interface NavLink {
    readonly id: string;
    readonly label: string;
    readonly icon: LucideIcon;
    readonly scope: DriveScope;
    /** Optional count badge, hidden on the rail where it would not fit. */
    readonly badge: number;
  }

  const links = $derived<NavLink[]>([
    { id: 'drive', label: 'My Drive', icon: HardDrive, scope: { kind: 'folder', folderId: null }, badge: 0 },
    { id: 'starred', label: 'Starred', icon: Star, scope: { kind: 'starred' }, badge: 0 },
    { id: 'trash', label: 'Trash', icon: Trash, scope: { kind: 'trash' }, badge: trashCount }
  ]);

  /** Whether a link points at the scope on screen. */
  function isActive(link: NavLink): boolean {
    if (scope.kind !== link.scope.kind) return false;
    if (scope.kind === 'folder' && link.scope.kind === 'folder') {
      return scope.folderId === link.scope.folderId;
    }
    return true;
  }

  /** The initials shown in the account chip. */
  const initials = $derived.by((): string => {
    const source = displayName ?? email ?? '';
    const parts = source.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
    return `${(parts[0] ?? '')[0] ?? ''}${(parts[1] ?? '')[0] ?? ''}`.toUpperCase();
  });

  const accountName = $derived(displayName ?? email ?? 'Signed in');

  const itemBase =
    'flex items-center gap-3 rounded-lg text-sm font-medium text-fg-muted transition-colors';
  const itemActive = 'bg-accent-soft text-accent';
</script>

{#snippet LinkList(vertical: boolean)}
  <nav aria-label="Primary" class={vertical ? 'flex flex-col gap-1' : 'flex items-center'}>
    {#each links as link (link.id)}
      {@const Icon = link.icon}
      {@const active = isActive(link)}
      <a
        href={link.scope.kind === 'folder' ? (link.scope.folderId === null ? '/' : `/folder/${link.scope.folderId}`) : `/${link.scope.kind}`}
        aria-current={active ? 'page' : undefined}
        onclick={(event) => {
          // A modified click should open a new tab, not hijack this one.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onNavigate(link.scope);
        }}
        title={density === 'rail' ? link.label : undefined}
        class="{itemBase} {active ? itemActive : 'hover:bg-surface-hover hover:text-fg'} {vertical ? 'min-h-11 px-3' : 'min-h-11 px-2 lg:px-3'}"
      >
        <Icon size={20} class="shrink-0" aria-hidden="true" />
        <span class={density === 'rail' ? 'sr-only' : density === 'bottom' ? 'text-[10px]' : 'truncate'}>
          {link.label}
        </span>
        {#if link.badge > 0 && density !== 'rail'}
          <span
            class={density === 'bottom'
              ? 'absolute right-3 top-2 rounded-full bg-surface px-1.5 text-[10px] font-semibold text-fg-muted'
              : 'ml-auto rounded-full bg-surface px-2 py-0.5 text-xs tabular-nums text-fg-muted'}
          >
            {formatCount(link.badge)}
          </span>
        {/if}
      </a>
    {/each}
  </nav>
{/snippet}

{#snippet Account()}
  <div class="flex items-center gap-3">
    <span
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft
             text-xs font-semibold text-accent"
      aria-hidden="true"
    >
      {initials}
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-medium text-fg">{accountName}</span>
      {#if displayName !== null && email !== null}
        <span class="block truncate text-xs text-fg-muted">{email}</span>
      {/if}
    </span>
    <button
      type="button"
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-fg-muted
             transition-colors hover:bg-surface-hover hover:text-fg
             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
             disabled:opacity-50"
      disabled={busy}
      onclick={onSignOut}
    >
      {#if busy}
        <LoaderCircle size={18} class="animate-spin" aria-label="Signing out" />
      {:else}
        <LogOut size={18} aria-label="Sign out" />
      {/if}
    </button>
  </div>
{/snippet}

{#if density === 'full'}
  <div class="flex h-full flex-col gap-4 p-4">
    <div class="min-h-0 flex-1 overflow-y-auto">
      {@render LinkList(true)}
    </div>

    <StorageMeter {quota} variant="compact" />

    <div class="border-t border-line pt-3">
      {@render Account()}
    </div>
  </div>
{:else if density === 'rail'}
  <div class="flex h-full flex-col items-center gap-4 py-4">
    <div class="min-h-0 flex-1 overflow-y-auto">
      {@render LinkList(true)}
    </div>

    <StorageMeter {quota} variant="compact" />

    <div class="border-t border-line pt-3">
      {@render Account()}
    </div>
  </div>
{:else}
  <div class="border-t border-line bg-surface px-2 pb-[env(safe-area-inset-bottom)] pt-1">
    {@render LinkList(false)}
  </div>
{/if}
