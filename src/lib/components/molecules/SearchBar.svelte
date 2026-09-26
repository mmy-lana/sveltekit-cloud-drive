<script lang="ts">
  /**
   * Debounced search field with a persisted query history.
   *
   * The visible text is a local draft: keystrokes never round-trip to the
   * listing until the debounce elapses, which keeps filtering off the main
   * thread on every character. The applied value is the two-way binding.
   */
  import { Search, X, Clock, LoaderCircle } from '@lucide/svelte';
  import { goto } from '$app/navigation';

  interface Props {
    /** Two-way bound, already-applied query. */
    value?: string;
    /** Fired after the debounce window with the settled query. */
    onSearch: (query: string) => void;
    /** Debounce window in milliseconds. */
    debounceMs?: number;
    placeholder?: string;
    /** Accessible name; also used as the input's `aria-label` when no label shows. */
    label?: string;
    /** Shows a spinner and marks the field busy while a query is in flight. */
    loading?: boolean;
    /** Route the Enter key pushes into, e.g. `/search?q=…`. Empty disables it. */
    submitRoute?: string;
    /** Disables the history dropdown, e.g. where it would obscure results. */
    disableHistory?: boolean;
    class?: string;
  }

  const HISTORY_KEY = 'drive.searchHistory.v1';
  const HISTORY_LIMIT = 8;

  let {
    value = $bindable(''),
    onSearch,
    debounceMs = 220,
    placeholder = 'Search in Drive',
    label = 'Search in Drive',
    loading = false,
    submitRoute = '',
    disableHistory = false,
    class: className
  }: Props = $props();

  let draft = $state(value);
  let history = $state<string[]>([]);
  let historyOpen = $state(false);
  let historyIndex = $state(-1);
  let inputElement = $state<HTMLInputElement | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while the field has focus, so a click outside can close the history. */
  let focused = $state(false);

  // An externally changed value (back navigation, "clear search" elsewhere)
  // must win over a stale in-progress draft.
  $effect(() => {
    if (value !== draft && document.activeElement !== inputElement) {
      draft = value;
    }
  });

  $effect(() => {
    if (disableHistory) return;
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored === null) return;
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        history = parsed.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch {
      // A corrupt or blocked store must not prevent searching; history is
      // strictly an optimisation, so it degrades to "no history".
      history = [];
    }
  });

  function persistHistory(next: string[]): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // Private-mode or quota failures are non-fatal: search still works.
    }
  }

  function apply(next: string): void {
    draft = next;
    value = next;

    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onSearch(next), debounceMs);
  }

  function commitHistory(query: string): void {
    if (disableHistory) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) return;

    const next = [trimmed, ...history.filter((entry) => entry !== trimmed)].slice(0, HISTORY_LIMIT);
    history = next;
    persistHistory(next);
  }

  function clear(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    draft = '';
    value = '';
    historyOpen = false;
    onSearch('');
    inputElement?.focus();
  }

  function selectHistory(query: string): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    draft = query;
    value = query;
    historyOpen = false;
    onSearch(query);
    inputElement?.focus();
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    const query = draft.trim();
    onSearch(query);
    if (query.length > 0) commitHistory(query);
    if (submitRoute.length > 0) {
      historyOpen = false;
      await goto(`${submitRoute}?q=${encodeURIComponent(query)}`, { keepFocus: true });
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (historyOpen) {
        historyOpen = false;
        return;
      }
      if (draft.length > 0) {
        event.preventDefault();
        clear();
      }
      return;
    }

    if (!historyOpen || history.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      historyIndex = (historyIndex + 1) % history.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      historyIndex = historyIndex <= 0 ? history.length - 1 : historyIndex - 1;
    } else if (event.key === 'Enter' && historyIndex >= 0) {
      event.preventDefault();
      event.stopPropagation();
      const query = history[historyIndex];
      if (query !== undefined) selectHistory(query);
    }
  }

  function handleBlur(event: FocusEvent): void {
    // `relatedTarget` stays inside the field when a history option is clicked,
    // so the dropdown survives that interaction and closes for everything else.
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) {
      return;
    }
    focused = false;
    historyOpen = false;
  }

  const showHistory = $derived(
    !disableHistory && focused && historyOpen && draft.trim().length === 0 && history.length > 0
  );

  $effect(() => () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
  });
</script>

<!--
  The field is a combobox rather than a plain searchbox because the history
  popup is a listbox that the input controls. `aria-activedescendant` then moves
  the active option without taking DOM focus away from the input, so typing
  continues uninterrupted while arrowing through history.
-->
<form role="search" aria-label={label} onsubmit={handleSubmit} class={['relative', className ?? ''].join(' ')}>
  <div
    class={[
      'flex items-center gap-2 rounded-full bg-surface px-3 transition-colors',
      'focus-within:ring-accent',
      // A ring, not a border. A border is drawn *inside* the box, so it would
      // take 2px off the height the input gets and leave the field 2px short
      // of the 44px target; a ring is drawn outside and costs no layout.
      'h-11 ring-1 ring-inset ring-line-strong'
    ].join(' ')}
  >
    {#if loading}
      <LoaderCircle size={18} class="shrink-0 animate-spin text-fg-subtle" aria-hidden="true" />
    {:else}
      <Search size={18} class="shrink-0 text-fg-subtle" aria-hidden="true" />
    {/if}

    <input
      bind:this={inputElement}
      type="search"
      name="q"
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      role="combobox"
      aria-haspopup="listbox"
      aria-autocomplete="list"
      aria-expanded={showHistory}
      aria-controls={showHistory ? 'search-history-listbox' : undefined}
      aria-activedescendant={showHistory && historyIndex >= 0
        ? `search-history-${historyIndex}`
        : undefined}
      autocomplete="off"
      enterkeyhint="search"
      oninput={(event) => apply(event.currentTarget.value)}
      onkeydown={handleKeydown}
      onfocus={() => {
        focused = true;
        historyOpen = true;
        historyIndex = -1;
      }}
      onblur={handleBlur}
      class="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:hidden"
    />

    {#if draft.length > 0}
      <!--
        A 44px button pulled in by a negative margin, not a 32px one with a
        padded-out ::before. The target is the element, so the element has to
        be the size a finger needs; the negative margin keeps the pill's
        padding looking unchanged.
      -->
      <button
        type="button"
        onclick={clear}
        aria-label="Clear search"
        title="Clear search"
        class="-mx-2 flex size-11 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-hover hover:text-fg"
      >
        <X size={16} aria-hidden="true" />
      </button>
    {/if}
  </div>

  {#if showHistory}
    <div
      id="search-history-listbox"
      role="listbox"
      aria-label="Recent searches"
      class="animate-scale-in absolute inset-x-0 top-[calc(100%+0.375rem)] z-40 overflow-hidden rounded-xl border border-line bg-raised py-1 shadow-overlay"
    >
      <p
        class="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase"
      >
        <Clock size={12} aria-hidden="true" />
        Recent
      </p>
      {#each history as entry, index (entry)}
        <button
          type="button"
          id="search-history-{index}"
          role="option"
          aria-selected={index === historyIndex}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => selectHistory(entry)}
          onmouseenter={() => (historyIndex = index)}
          class={[
            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
            index === historyIndex ? 'bg-hover text-fg' : 'text-fg-muted'
          ].join(' ')}
        >
          <Search size={14} class="shrink-0 text-fg-subtle" aria-hidden="true" />
          <span class="truncate">{entry}</span>
        </button>
      {/each}
    </div>
  {/if}
</form>
