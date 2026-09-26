<script lang="ts">
  /**
   * Phase 1 diagnostics screen.
   *
   * Proves the three foundation layers are actually wired in a real browser:
   * the public env contract, the Firebase client singleton (including its SSR
   * guard) and the local persistent cache. It is intentionally a real screen
   * rather than a stub — a misconfigured emulator should be obvious on first
   * run instead of surfacing later as a silent auth failure.
   */
  import { browser } from '$app/environment';
  import {
    getFirebase,
    getFirebaseRuntimeStatus,
    isFirebaseReady,
    type FirebaseRuntimeStatus
  } from '$lib/firebase/client';
  import { formatBytes, formatQuotaSummary } from '$lib/utils/formatters';
  import { FILE_CATEGORY_LABELS, getFileMimeDescriptor, getKnownExtensions } from '$lib/utils/mimetypes';
  import { UPLOAD_STATUS_TRANSITIONS } from '$lib/types/drive';

  type CheckState = 'idle' | 'pending' | 'ok' | 'error';

  interface CheckResult {
    state: CheckState;
    message: string;
  }

  let runtime = $state<FirebaseRuntimeStatus>(getFirebaseRuntimeStatus());
  let clientCheck = $state<CheckResult>({ state: 'idle', message: 'Not run yet.' });

  // A worked example so the classifier is observable before any file exists.
  const sampleDescriptor = getFileMimeDescriptor({
    name: 'quarterly-report.PDF',
    type: 'file',
    mimeType: 'application/pdf'
  });

  const statusTransitions = Object.entries(UPLOAD_STATUS_TRANSITIONS) as ReadonlyArray<
    readonly [keyof typeof UPLOAD_STATUS_TRANSITIONS, readonly (keyof typeof UPLOAD_STATUS_TRANSITIONS)[]]
  >;

  function runClientCheck(): void {
    if (!browser) return;

    clientCheck = { state: 'pending', message: 'Initialising the Firebase client singleton…' };
    try {
      const clients = getFirebase();
      clientCheck = {
        state: 'ok',
        message: `Initialised "${clients.config.projectId}" (app "${clients.app.name}"), ${clients.isEmulator ? 'emulator' : 'live'} wiring.`
      };
      runtime = getFirebaseRuntimeStatus();
    } catch (error) {
      clientCheck = {
        state: 'error',
        message: error instanceof Error ? error.message : 'Unknown initialisation failure.'
      };
    }
  }

  $effect(() => {
    runClientCheck();
  });
</script>

<svelte:head>
  <title>Foundation status · Cloud Drive</title>
</svelte:head>

<main id="main-content" class="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
  <header class="flex flex-col gap-2">
    <h1 class="text-2xl font-semibold tracking-tight text-slate-900">Foundation status</h1>
    <p class="text-sm text-slate-600">
      Phase 1 — domain contracts, the Firebase client bridge, presentation utilities and the
      declarative security rules.
    </p>
  </header>

  <section class="flex flex-col gap-3" aria-labelledby="env-heading">
    <h2 id="env-heading" class="text-sm font-semibold tracking-wide text-slate-500 uppercase">
      Runtime wiring
    </h2>
    <dl class="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-slate-200 sm:grid-cols-2">
      <div class="flex flex-col gap-1 bg-white px-4 py-3">
        <dt class="text-xs text-slate-500">Mode</dt>
        <dd class="text-sm font-medium text-slate-900">
          {runtime.isEmulator ? 'Local emulator suite' : 'Live Firebase project'}
        </dd>
      </div>
      <div class="flex flex-col gap-1 bg-white px-4 py-3">
        <dt class="text-xs text-slate-500">Project id</dt>
        <dd class="font-mono text-sm text-slate-900">{runtime.projectId}</dd>
      </div>
      <div class="flex flex-col gap-1 bg-white px-4 py-3">
        <dt class="text-xs text-slate-500">Storage bucket</dt>
        <dd class="font-mono text-sm text-slate-900">{runtime.storageBucket}</dd>
      </div>
      <div class="flex flex-col gap-1 bg-white px-4 py-3">
        <dt class="text-xs text-slate-500">Persistent local cache</dt>
        <dd class="text-sm text-slate-900">
          {runtime.persistentCache ? 'IndexedDB available' : 'Unavailable — in-memory fallback'}
        </dd>
      </div>
      <div class="flex flex-col gap-1 bg-white px-4 py-3">
        <dt class="text-xs text-slate-500">Emulator host</dt>
        <dd class="font-mono text-sm text-slate-900">{runtime.emulatorHost ?? '—'}</dd>
      </div>
      <div class="flex flex-col gap-1 bg-white px-4 py-3">
        <dt class="text-xs text-slate-500">Endpoints</dt>
        <dd class="font-mono text-sm text-slate-900">
          auth :{runtime.authPort} · firestore :{runtime.firestorePort} · storage :{runtime.storagePort}
        </dd>
      </div>
    </dl>
  </section>

  <section class="flex flex-col gap-3" aria-labelledby="client-heading">
    <h2 id="client-heading" class="text-sm font-semibold tracking-wide text-slate-500 uppercase">
      Client singleton
    </h2>
    <div
      class="flex flex-col gap-3 rounded-lg border border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      role="status"
      aria-live="polite"
    >
      <p
        class="text-sm {clientCheck.state === 'error'
          ? 'text-red-700'
          : clientCheck.state === 'ok'
            ? 'text-slate-900'
            : 'text-slate-600'}"
      >
        {clientCheck.message}
      </p>
      <div class="flex shrink-0 items-center gap-3">
        <span class="text-xs text-slate-500">
          {isFirebaseReady() ? 'initialised' : 'not initialised'}
        </span>
        <button
          type="button"
          class="min-h-11 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          onclick={runClientCheck}
        >
          Re-run check
        </button>
      </div>
    </div>
  </section>

  <section class="flex flex-col gap-3" aria-labelledby="utils-heading">
    <h2 id="utils-heading" class="text-sm font-semibold tracking-wide text-slate-500 uppercase">
      Presentation utilities
    </h2>
    <ul class="flex flex-col gap-2 text-sm text-slate-700">
      <li class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-slate-500">formatBytes(1_048_576)</span>
        <span class="font-mono">{formatBytes(1_048_576)}</span>
      </li>
      <li class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-slate-500">formatBytes(1536, decimals: 2)</span>
        <span class="font-mono">{formatBytes(1536, { decimals: 2 })}</span>
      </li>
      <li class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-slate-500">formatQuotaSummary(empty ledger)</span>
        <span class="font-mono">
          {formatQuotaSummary({ usedBytes: 0, reservedBytes: 0, totalBytes: 0 })}
        </span>
      </li>
      <li class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-slate-500">getFileMimeDescriptor("quarterly-report.PDF")</span>
        <span class="font-mono">
          {sampleDescriptor.label} · {sampleDescriptor.previewKind} · {sampleDescriptor.extension}
        </span>
      </li>
      <li class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-slate-500">known extensions</span>
        <span class="font-mono">{getKnownExtensions().length}</span>
      </li>
      <li class="flex flex-wrap items-baseline gap-x-2">
        <span class="text-slate-500">categories</span>
        <span class="font-mono">
          {Object.values(FILE_CATEGORY_LABELS).join(', ')}
        </span>
      </li>
    </ul>
  </section>

  <section class="flex flex-col gap-3" aria-labelledby="fsm-heading">
    <h2 id="fsm-heading" class="text-sm font-semibold tracking-wide text-slate-500 uppercase">
      Upload state machine
    </h2>
    <ul class="flex flex-col gap-1 text-sm text-slate-700">
      {#each statusTransitions as [status, next] (status)}
        <li class="flex flex-wrap items-baseline gap-x-2">
          <span class="font-mono text-slate-900">{status}</span>
          <span class="text-slate-500">→</span>
          <span class="font-mono">{next.length > 0 ? next.join(', ') : 'terminal'}</span>
        </li>
      {/each}
    </ul>
  </section>
</main>
