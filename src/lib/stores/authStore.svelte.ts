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
import { getAuthClient, getFirestoreClient } from '$lib/firebase/client';
import { classifyError, type ClassifiedError } from '$lib/firebase/errors';
import { DEFAULT_QUOTA_BYTES } from '$lib/config/constants';
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

class AuthStore {
  #status = $state<AuthStatus>('initializing');
  #user = $state<User | null>(null);
  #profile = $state<DriveUser | null>(null);
  #profileError = $state<ClassifiedError | null>(null);
  #error = $state<ClassifiedError | null>(null);

  #authUnsubscribe: Unsubscribe | null = null;
  #profileUnsubscribe: Unsubscribe | null = null;
  #initialized = false;
  #signInFlight: Promise<void> | null = null;

  /** Current lifecycle state. */
  get status(): AuthStatus {
    return this.#status;
  }

  /** The Firebase Auth user, or `null` before sign-in resolves. */
  get authUser(): User | null {
    return this.#user;
  }

  /** The uid every other store scopes its queries by. */
  get uid(): string | null {
    return this.#user?.uid ?? null;
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
      this.#user !== null &&
      this.#status !== 'initializing' &&
      this.#status !== 'signing-in'
    );
  }

  /** `true` once a uid *and* the profile that carries the quota ledger exist. */
  get isReady(): boolean {
    return this.#user !== null && this.#profile !== null;
  }

  /**
   * Begin the anonymous session.
   *
   * Idempotent and safe to call from several components in the same tick: the
   * in-flight promise is shared, so mounting the shell twice cannot race two
   * `signInAnonymously` calls against each other.
   *
   * Must only be called in the browser — Firebase has no SSR contract.
   */
  async initialize(): Promise<void> {
    if (!browser) return;
    if (this.#initialized) return;
    this.#initialized = true;

    this.#status = 'signing-in';

    this.#authUnsubscribe = onAuthStateChanged(
      getAuthClient(),
      (user) => {
        this.#user = user;
        if (user === null) {
          this.#profileUnsubscribe?.();
          this.#profileUnsubscribe = null;
          this.#profile = null;
          this.#profileError = null;
          this.#status = 'signed-out';
          return;
        }
        this.#status = 'signed-in';
        void this.#bindProfile(user);
      },
      (error) => {
        this.#error = classifyError(error);
        this.#status = 'error';
      }
    );

    try {
      // A restored emulator session short-circuits this, which is the point:
      // a reload must not mint a new account and orphan the old one's items.
      if (getAuthClient().currentUser === null) {
        await signInAnonymously(getAuthClient());
      }
    } catch (error) {
      this.#error = classifyError(error);
      this.#status = 'error';
    }
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
    const user = this.#user;
    if (user === null) return;
    this.#profileError = null;
    void this.#bindProfile(user);
  }

  /** Change the display name shown in the account menu. */
  async setDisplayName(displayName: string): Promise<void> {
    const user = this.#user;
    if (user === null) return;

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
   */
  async signOut(): Promise<void> {
    if (!browser) return;
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
