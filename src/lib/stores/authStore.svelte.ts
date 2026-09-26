/**
 * Account state.
 *
 * The app runs against the Auth emulator with anonymous sign-in, which is the
 * only identity the demo understands: a real deployment would add a Google or
 * email provider here, and nothing below it would change, because every other
 * module only ever reads `uid`.
 *
 * Owns exactly one responsibility beyond identity — the `users/{uid}` profile
 * document, including the quota ledger that every other store depends on. That
 * coupling is deliberate: quota is per-user state, and creating it in one place
 * removes a class of "reserved bytes against a user document that does not
 * exist yet" failures.
 *
 * ## Also owns the choice of backend
 *
 * A deployment can arrive here in two shapes. Either Firebase is reachable and
 * everything below is the existing, complete implementation. Or it is not — no
 * credentials, placeholder credentials, or a project that does not answer — and
 * the app serves a drive out of the browser's own IndexedDB instead.
 *
 * This store makes that decision because it is the only place that knows whether
 * an identity was obtained, and an identity is the precondition for every other
 * store doing anything at all. The mode is settled *before* {@link uid} becomes
 * non-null, so by the time the shell re-syncs the item store on the way a uid
 * appears, the repository serving that store is already installed.
 */
import { browser } from '$app/environment';
import {
  onAuthStateChanged,
  signInAnonymously,
  signOut as firebaseSignOut,
  updateProfile,
  type User
} from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe
} from 'firebase/firestore';
import {
  clearFirebaseConnectionFailure,
  detectDriveMode,
  getAuthClient,
  getFirestoreClient,
  isEmulatorEnabled,
  reportFirebaseConnectionFailure
} from '$lib/firebase/client';
import {
  classifyError,
  isUnreachableBackendError,
  type ClassifiedError
} from '$lib/firebase/errors';
import { DEFAULT_QUOTA_BYTES } from '$lib/config/constants';
import { DEMO_USER_ID, MockDriveRepository } from '$lib/services/mockDriveBackend';
import {
  setActiveRepository,
  type DriveMode,
  type DriveModeReason,
  type DriveSubscription
} from '$lib/services/driveRepository';
import type { DriveUser, StorageQuota } from '$lib/types/drive';

/** State of the anonymous account lifecycle. */
export type AuthStatus = 'initializing' | 'signed-out' | 'signing-in' | 'signed-in' | 'error';

/** A display name for a profile that has not chosen one. */
function deriveDisplayName(user: User): string {
  if (user.displayName !== null && user.displayName.trim().length > 0) {
    return user.displayName.trim();
  }
  const emailLocal = user.email?.split('@')[0]?.trim();
  if (emailLocal !== undefined && emailLocal.length > 0) {
    return emailLocal;
  }
  return `Guest ${user.uid.slice(0, 4)}`;
}

/** What a failed sign-in says when the failure is one of reachability. */
const CONNECTION_FAILURE_DETAIL =
  'A Firebase project is configured, but it could not be reached from this browser.';

class AuthStore {
  #status = $state<AuthStatus>('initializing');
  #user = $state<User | null>(null);
  #uid = $state<string | null>(null);
  #profile = $state<DriveUser | null>(null);
  #profileError = $state<ClassifiedError | null>(null);
  #error = $state<ClassifiedError | null>(null);

  #mode = $state<DriveMode>('firebase');
  #modeReason = $state<DriveModeReason>('configured');
  #modeDetail = $state('');

  #authUnsubscribe: Unsubscribe | null = null;
  #profileUnsubscribe: Unsubscribe | null = null;
  #localProfileSubscription: DriveSubscription | null = null;
  #localRepository: MockDriveRepository | null = null;
  #initialized = false;
  #signInFlight: Promise<void> | null = null;

  /** Current lifecycle state. */
  get status(): AuthStatus {
    return this.#status;
  }

  /** The Firebase Auth user, or `null` before sign-in resolves. Always `null` in demo mode. */
  get authUser(): User | null {
    return this.#user;
  }

  /** The uid every other store scopes its queries by. */
  get uid(): string | null {
    return this.#uid;
  }

  /**
   * Which layer is serving the drive.
   *
   * The two stores branch on `getActiveRepository()` rather than on this, because
   * that is what actually performs the work — but they must never disagree, and
   * this getter is the one place the answer is published so they can be compared.
   */
  get mode(): DriveMode {
    return this.#mode;
  }

  /** Why the app landed in {@link mode}. Surfaced verbatim in the demo dialog. */
  get modeReason(): DriveModeReason {
    return this.#modeReason;
  }

  /** The sentence behind {@link modeReason}. */
  get modeDetail(): string {
    return this.#modeDetail;
  }

  /** `true` when the drive is served by the browser rather than by Firebase. */
  get isDemoMode(): boolean {
    return this.#mode === 'demo';
  }

  /**
   * `true` when the local drive survives a reload.
   *
   * `false` means IndexedDB was refused and the drive is held in memory, so the
   * demo dialog can say so instead of promising persistence it cannot deliver.
   */
  get isDemoPersistent(): boolean {
    return this.#localRepository?.isPersistent ?? true;
  }

  /** The `users/{uid}` document, including the authoritative quota ledger. */
  get profile(): DriveUser | null {
    return this.#profile;
  }

  /** Quota ledger, or `null` until the profile has loaded. */
  get quota(): StorageQuota | null {
    return this.#profile?.quota ?? null;
  }

  /** Last failure, already translated into something showable. */
  get error(): ClassifiedError | null {
    return this.#error;
  }

  /**
   * Why the drive profile could not be read or provisioned.
   *
   * Deliberately separate from {@link error}: a Firestore problem is not an
   * authentication problem, and conflating them is what made a provisioning
   * failure look identical to "still connecting" — a state with no exit.
   */
  get profileError(): ClassifiedError | null {
    return this.#profileError;
  }

  /**
   * `true` once the auth layer has settled on an identity.
   *
   * This is what the shell gate keys on. It deliberately does not wait for the
   * profile document: identity comes from Auth, and a drive record that fails to
   * load is a drive problem with its own surface and its own retry, not a reason
   * to hold the whole app behind a splash screen.
   */
  get isAuthenticated(): boolean {
    return (
      this.#uid !== null &&
      this.#status !== 'initializing' &&
      this.#status !== 'signing-in'
    );
  }

  /** `true` once a uid *and* the profile that carries the quota ledger exist. */
  get isReady(): boolean {
    return this.#uid !== null && this.#profile !== null;
  }

  /**
   * Begin the session: an anonymous Firebase sign-in, or a local drive.
   *
   * Idempotent and safe to call from several components in the same tick: the
   * in-flight promise is shared, so mounting the shell twice cannot race two
   * `signInAnonymously` calls against each other.
   *
   * Must only be called in the browser — Firebase has no SSR contract, and
   * IndexedDB has none either, so the local path is equally client-only.
   */
  async initialize(): Promise<void> {
    if (!browser) return;
    if (this.#initialized) return;
    this.#initialized = true;

    const detection = detectDriveMode();
    if (detection.mode === 'demo') {
      await this.#enterDemoMode(detection.reason, detection.detail);
      return;
    }

    this.#status = 'signing-in';

    this.#authUnsubscribe = onAuthStateChanged(
      getAuthClient(),
      (user) => {
        this.#user = user;
        if (user === null) {
          this.#uid = null;
          this.#profileUnsubscribe?.();
          this.#profileUnsubscribe = null;
          this.#profile = null;
          this.#profileError = null;
          this.#status = 'signed-out';
          return;
        }
        this.#uid = user.uid;
        this.#status = 'signed-in';
        void this.#bindProfile(user);
      },
      (error) => {
        void this.#handleStartupFailure(error);
      }
    );

    try {
      // A restored emulator session short-circuits this, which is the point:
      // a reload must not mint a new account and orphan the old one's items.
      if (getAuthClient().currentUser === null) {
        await signInAnonymously(getAuthClient());
      }
      clearFirebaseConnectionFailure();
    } catch (error) {
      await this.#handleStartupFailure(error);
    }
  }

  /**
   * Decide whether a startup failure is fatal, or is a reason to go local.
   *
   * The two exclusions are the entire policy:
   *
   * - **The emulator never fails over.** A developer who asked for the local
   *   suite and got an error has a bug — a container that did not start, a
   *   port that is taken, a seed that did not apply. Swapping in an IndexedDB
   *   drive would make every one of those look like a working app, and the
   *   emulator suites in `pnpm run verify` are the only thing standing between
   *   a regression and a deployment.
   * - **A refusal never fails over.** See
   *   {@link isUnreachableBackendError}: a rules denial and an expired session
   *   are answers from a live project, and hiding either behind a local drive
   *   conceals a real fault behind a healthy-looking UI.
   */
  async #handleStartupFailure(error: unknown): Promise<void> {
    if (isEmulatorEnabled() || !isUnreachableBackendError(error)) {
      this.#error = classifyError(error);
      this.#status = 'error';
      return;
    }

    reportFirebaseConnectionFailure(CONNECTION_FAILURE_DETAIL);
    await this.#enterDemoMode('connection-failed', CONNECTION_FAILURE_DETAIL);
  }

  /**
   * Serve the drive from the browser.
   *
   * The ordering inside this method is load-bearing. Every step that changes
   * what the rest of the app sees comes *after* the repository is fully open and
   * installed:
   *
   * 1. The repository is opened, so the store that never exists is not one that
   *    reports a failure later.
   * 2. `setActiveRepository` runs, so the item store finds a backend the moment
   *    it looks.
   * 3. Only then does {@link uid} become non-null, which is the signal the
   *    shell's effect uses to sync the item store.
   *
   * Inverting 2 and 3 produces a real and very confusing failure: the store
   * syncs against a `null` repository, takes the Firebase branch, and throws
   * against a config that no longer exists.
   */
  async #enterDemoMode(reason: DriveModeReason, detail: string): Promise<void> {
    this.#status = 'signing-in';
    this.#mode = 'demo';
    this.#modeReason = reason;
    this.#modeDetail = detail;

    const repository = new MockDriveRepository();
    try {
      await repository.open();
    } catch (error) {
      // `MockDriveRepository` degrades to memory rather than refusing to open,
      // so reaching here means IndexedDB *and* the in-memory fallback both
      // failed. There is no third place to go.
      this.#error = classifyError(error);
      this.#status = 'error';
      return;
    }

    this.#authUnsubscribe?.();
    this.#authUnsubscribe = null;
    this.#profileUnsubscribe?.();
    this.#profileUnsubscribe = null;
    this.#localProfileSubscription?.close();
    this.#localProfileSubscription = null;
    this.#user = null;
    this.#profile = null;
    this.#profileError = null;
    this.#error = null;

    this.#localRepository = repository;
    setActiveRepository(repository);

    this.#uid = DEMO_USER_ID;
    this.#status = 'signed-in';

    // The ledger is re-derived after every local mutation, so this subscription
    // is what keeps the storage meter live rather than a one-time read.
    this.#localProfileSubscription = repository.subscribeProfile(
      (profile) => {
        this.#profile = profile;
        this.#profileError = null;
      },
      (error: unknown) => {
        this.#profileError = classifyError(error);
      }
    );
  }

  /**
   * Create the profile document if it is missing, then subscribe to it.
   *
   * ## Why this is a create, never a merge
   *
   * The payload below carries `quota: { usedBytes: 0, reservedBytes: 0, ... }`.
   * A merge write applies *every* field it is given, so a merge against a
   * profile that already exists resets the caller's ledger to zero. `getDoc` is
   * served from the local cache, so "does not exist" is a statement about the
   * cache, not about the server: a second tab, a device that has been offline,
   * or simply a snapshot that has not landed yet is enough to make it stale.
   *
   * That write is *permitted* by `firestore.rules`. `quotaLedgerIsBalanced`
   * accepts a fall in `usedBytes` whenever `reservedBytes` is untouched, which
   * is the shape a legitimate permanent delete has — so the rules cannot tell
   * a reclaimed file from a ledger that was simply overwritten. The result is
   * that a stale read followed by a merge silently destroys the account's usage
   * accounting, and the bytes become invisible to quota accounting forever.
   *
   * The guard is therefore local and strict: provision only a document that the
   * *server* says does not exist, and write it with a plain `setDoc`, so the
   * write is a `create` and is evaluated against `allow create` — which pins
   * `usedBytes == 0` and `reservedBytes == 0` as an invariant of provisioning
   * rather than a value a client may reassert at will.
   */
  async #bindProfile(user: User): Promise<void> {
    const db = getFirestoreClient();
    const profileRef = doc(db, 'users', user.uid);

    this.#profileUnsubscribe?.();
    this.#profileUnsubscribe = onSnapshot(
      profileRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        this.#profile = { uid: snapshot.id, ...snapshot.data() } as DriveUser;
        this.#profileError = null;
      },
      (error) => {
        this.#profileError = classifyError(error);
      }
    );

    try {
      // `getDocFromServer` rather than `getDoc`: a cached "missing" answer is
      // the exact condition that turns a merge into a ledger reset, so the
      // existence check has to be the server's answer and not the cache's.
      const existing = await getDocFromServer(profileRef);
      if (existing.exists()) {
        this.#profileError = null;
        return;
      }

      await setDoc(profileRef, {
        // Mirrors the document id. The rules compare this field to the path
        // segment, which is what proves ownership without trusting `auth.uid`
        // to survive a rules-test context.
        uid: user.uid,
        email: user.email ?? '',
        displayName: deriveDisplayName(user),
        photoURL: user.photoURL ?? null,
        // Written once, at account creation. `firestore.rules` pins
        // `totalBytes` on every later write, so this ceiling is final.
        quota: { usedBytes: 0, reservedBytes: 0, totalBytes: DEFAULT_QUOTA_BYTES },
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      this.#profileError = null;
    } catch (error) {
      this.#profileError = classifyError(error);
    }
  }

  /**
   * Re-run profile provisioning for the signed-in user.
   *
   * Surfaced by the shell's "drive unavailable" card. A no-op when there is no
   * session, so the button cannot resurrect a profile for a user who is gone.
   */
  retryProfile(): void {
    if (this.#mode === 'demo') {
      // The local drive is in memory, so there is nothing to retry against: the
      // profile only fails here if the repository itself failed to open, and
      // that is reported as an error rather than as a drive problem. Clearing
      // the flag is the whole of the recovery.
      this.#profileError = null;
      return;
    }

    const user = this.#user;
    if (user === null) return;
    this.#profileError = null;
    void this.#bindProfile(user);
  }

  /**
   * Change the display name shown in the account menu.
   *
   * Firebase-only, and deliberately so: this writes both an Auth profile field
   * and a Firestore document, and the local repository's contract has no
   * equivalent because a local account has no one to rename it away from. The
   * guard is a no-op rather than a fake success, because a name that appeared
   * to change and did not would be worse than one that stayed put.
   */
  async setDisplayName(displayName: string): Promise<void> {
    const user = this.#user;
    if (user === null || this.#mode === 'demo') return;

    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      this.#error = {
        kind: 'invalid-argument',
        message: 'Display name cannot be empty.',
        retryable: false,
        cause: null
      };
      return;
    }

    try {
      await updateProfile(user, { displayName: trimmed });
      await updateDoc(doc(getFirestoreClient(), 'users', user.uid), {
        displayName: trimmed,
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      this.#error = classifyError(error);
    }
  }

  /**
   * End the session and clear the mirrored state.
   *
   * There is no user-facing sign-out in this build — the app is a single-owner
   * demo — but the teardown is implemented because the account menu exposes it
   * and a half-wired button is worse than none.
   *
   * In demo mode there is no session to end: the local account is not an
   * identity anyone can leave. The shell hides the control rather than calling
   * this, and the guard here is the second line of that same defence.
   */
  async signOut(): Promise<void> {
    if (!browser) return;
    if (this.#mode === 'demo') return;

    try {
      await firebaseSignOut(getAuthClient());
    } catch (error) {
      this.#error = classifyError(error);
    }
  }

  /** Dismiss the current error banner. */
  clearError(): void {
    this.#error = null;
  }
}

/** The single account store. Modules import this instance, never the class. */
export const authStore = new AuthStore();
