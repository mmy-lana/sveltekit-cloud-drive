<script lang="ts">
  /**
   * Error boundary.
   *
   * Renders inside the shell, so a failed folder link still lands somewhere
   * with working navigation rather than a dead end. SvelteKit hands this the
   * status and message from `error()`, and the default message for a 404 is the
   * generic "Not Found" — which says nothing about *why* this link failed, so
   * each status gets copy that names the actual problem.
   */
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import { toErrorSummary } from '$lib/firebase/errors';

  const status = $derived(page.status);
  // `page.error` is whatever a `load` or a `handle` threw — a string, an
  // `Error`, or an `HttpError` — and none of them stringify usefully on their
  // own. `toErrorSummary` unwraps all three, and falls back to something the
  // user can act on rather than "undefined".
  const message = $derived(
    page.error === undefined ? 'Something went wrong.' : toErrorSummary(page.error)
  );

  const heading = $derived.by(() => {
    if (status === 404) return 'That does not exist';
    if (status === 403) return 'You do not have access';
    if (status >= 500) return 'Something went wrong on our side';
    return 'That request did not work';
  });

  /** A 404 on this app is nearly always a mistyped or truncated link. */
  const detail = $derived(
    status === 404
      ? 'The link may be incomplete, or the folder may have been deleted. Nothing in your drive was affected.'
      : null
  );

  function goHome(): void {
    window.location.assign('/');
  }

  function goBack(): void {
    // A direct hit on a bad link has no history to go back to; sending the user
    // into a blank previous page is worse than showing the error again.
    if (window.history.length > 1) window.history.back();
    else goHome();
  }
</script>

<svelte:head>
  <title>{status} · {heading} · Cloud Drive</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto flex min-h-[60dvh] w-full max-w-md flex-col items-center justify-center gap-5 px-6 text-center">
  <p class="text-5xl font-semibold tracking-tight text-fg-subtle tabular-nums">{status}</p>

  <div class="flex flex-col gap-2">
    <h1 class="text-xl font-semibold tracking-tight text-fg">{heading}</h1>
    <p class="text-sm leading-relaxed text-fg-muted">{message}</p>
    {#if detail !== null}
      <p class="text-sm leading-relaxed text-fg-muted">{detail}</p>
    {/if}
  </div>

  <div class="flex flex-wrap items-center justify-center gap-2">
    <Button onclick={goHome}>Go to My Drive</Button>
    <Button variant="secondary" onclick={goBack}>Go back</Button>
  </div>
</div>
