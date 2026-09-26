/**
 * Authoritative Firebase client bridge.
 *
 * ## Singleton ownership invariant
 *
 * This module is the ONLY place in the codebase allowed to call
 * `initializeApp`, `initializeFirestore`, `getAuth` or `getStorage`. Every other
 * module imports the already-initialised handles from here. Initialising the SDK
 * twice throws (`Firestore has already been started`) and silently creating a
 * second `App` leaks listeners, so the invariant is enforced by construction:
 * the handles live in a module-scoped singleton created on first use.
 *
 * ## SSR boundary
 *
 * The Firebase web SDK touches `window`, `indexedDB` and `navigator` during
 * initialisation. All access therefore goes through {@link getFirebase}, which
 * throws a descriptive error during server-side rendering instead of letting
 * the SDK fail with an opaque `ReferenceError`. The SvelteKit server never
 * calls it: data access lives in `+page.ts` loaders, which run on the client.
 */
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  type Auth
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore
} from 'firebase/firestore';
import {
  connectStorageEmulator,
  getStorage,
  type FirebaseStorage
} from 'firebase/storage';

/** Hard-coded emulator ports, mirrored from `firebase.json` and `docker-compose.yml`. */
export const EMULATOR_PORTS = Object.freeze({
  auth: 9099,
  firestore: 8080,
  storage: 9199
} as const);

/** Emulator endpoint conventions. The host is configurable, the ports are not. */
const EMULATOR_SCHEME = 'http';

/** Validated public Firebase configuration. */
interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

/** The complete, fully-initialised client surface handed to the rest of the app. */
export interface FirebaseClients {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
  config: FirebaseConfig;
  /** `true` when the handles are wired to the local emulator suite. */
  isEmulator: boolean;
}

/** Immutable module singleton. `null` until the first browser-side call. */
let clients: FirebaseClients | null = null;

/**
 * `true` when the public env asks for the emulator suite.
 *
 * Public env values are always strings, so the comparison is string-typed. The
 * `1` spelling is accepted too, because `.env` files authored from shells that
 * export numeric booleans are common.
 */
export function isEmulatorEnabled(): boolean {
  const flag = env.PUBLIC_USE_FIREBASE_EMULATOR;
  return flag === 'true' || flag === '1';
}

/** Emulator host, normalised and stripped of any scheme or trailing slash. */
function getEmulatorHost(): string {
  const raw = (env.PUBLIC_EMULATOR_HOST ?? '').trim();
  if (raw.length === 0) return 'localhost';

  const withoutScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  return withoutScheme.replace(/\/+$/, '') || 'localhost';
}

/**
 * Hostname that mirrors the page the SDK is running in.
 *
 * `PUBLIC_EMULATOR_HOST` is a *deployment* setting: it names where the suite
 * lives for whoever configured the environment, and `localhost` is the value
 * that ships in `.env`. That is the wrong host for every developer who reaches
 * the app by any other name, and the mismatch is silent — the suite is on the
 * same machine, the ports are published on `0.0.0.0`, so the requests do not
 * fail, they are simply *cross-origin*: `127.0.0.1` is not `localhost` to a
 * browser, and neither is a LAN address or a Docker bridge alias.
 *
 * The rule that removes the whole class of problem: point the emulator at the
 * same hostname the page was served from, whenever the suite is not being
 * addressed deliberately. Then the requests are same-origin, and neither a CORS
 * preflight nor an origin check in the suite can reject them.
 *
 * `PUBLIC_EMULATOR_HOST` still wins when it is set, because that is the escape
 * hatch for a genuinely remote suite (a shared host, a tunnel, a second
 * machine) where the page hostname is not the suite hostname at all.
 */
function getBrowserEmulatorHost(): string {
  if (!browser) return getEmulatorHost();

  const configured = (env.PUBLIC_EMULATOR_HOST ?? '').trim();
  if (configured.length > 0) return getEmulatorHost();

  const hostname = window.location.hostname.trim();
  if (hostname.length === 0) return 'localhost';

  // `localhost`, `::1` and `0.0.0.0` are all the loopback interface and are
  // reached identically, so normalising them to one spelling keeps the
  // diagnostics output stable regardless of how the developer typed the URL.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    return 'localhost';
  }
  if (hostname === '0.0.0.0') return 'localhost';

  return hostname;
}

/**
 * Resolve the public config.
 *
 * When the emulator is enabled, deterministic `mock-*` placeholders keep a
 * fresh clone runnable with zero configuration. When it is disabled, the
 * variables must be real: failing loudly at boot is far better than shipping a
 * build that silently authenticates against `mock-drive-system`.
 */
function resolveConfig(): FirebaseConfig {
  if (isEmulatorEnabled()) {
    return {
      apiKey: env.PUBLIC_FIREBASE_API_KEY?.trim() || 'mock-api-key',
      authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN?.trim() || 'mock-drive.firebaseapp.com',
      projectId: env.PUBLIC_FIREBASE_PROJECT_ID?.trim() || 'mock-drive-system',
      storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET?.trim() || 'mock-drive-system.appspot.com',
      messagingSenderId: env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID?.trim() || '000000000000',
      appId: env.PUBLIC_FIREBASE_APP_ID?.trim() || '1:000000000000:web:000000000000'
    };
  }

  const required: ReadonlyArray<readonly [keyof FirebaseConfig, string | undefined]> = [
    ['apiKey', env.PUBLIC_FIREBASE_API_KEY],
    ['authDomain', env.PUBLIC_FIREBASE_AUTH_DOMAIN],
    ['projectId', env.PUBLIC_FIREBASE_PROJECT_ID],
    ['storageBucket', env.PUBLIC_FIREBASE_STORAGE_BUCKET],
    ['messagingSenderId', env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID],
    ['appId', env.PUBLIC_FIREBASE_APP_ID]
  ];

  const missing = required.filter(([, value]) => !value?.trim()).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Firebase client configuration is incomplete. Missing: ${missing.join(', ')}. ` +
        'Set the PUBLIC_FIREBASE_* variables in .env, or set PUBLIC_USE_FIREBASE_EMULATOR=true to run against the local emulator suite.'
    );
  }

  return {
    apiKey: env.PUBLIC_FIREBASE_API_KEY!.trim(),
    authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN!.trim(),
    projectId: env.PUBLIC_FIREBASE_PROJECT_ID!.trim(),
    storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET!.trim(),
    messagingSenderId: env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID!.trim(),
    appId: env.PUBLIC_FIREBASE_APP_ID!.trim()
  };
}

/**
 * Feature-detect IndexedDB before opting into the persistent cache.
 *
 * `persistentLocalCache` is the default because offline reads and instant
 * hydration are core requirements of a drive UI. Some privacy modes and
 * hardened embedded webviews expose `indexedDB` as `undefined`, where
 * constructing the cache throws and takes the whole app down. Falling back to
 * `memoryLocalCache` keeps the app alive with a documented, one-session cache.
 */
function supportsIndexedDb(): boolean {
  if (typeof indexedDB === 'undefined' || indexedDB === null) return false;
  // Some hardened browsers expose the object but throw on any call. Treat that
  // as "no persistence" instead of letting the cache constructor explode.
  try {
    return typeof indexedDB.open === 'function';
  } catch {
    return false;
  }
}

/**
 * Create the Firestore handle with persistence when the platform allows it.
 *
 * The multi-tab manager lets another tab process writes for this one, which is
 * what makes quota transactions race-free across simultaneous tabs.
 */
function createFirestore(app: FirebaseApp): Firestore {
  if (supportsIndexedDb()) {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
      })
    });
  }

  return initializeFirestore(app, { localCache: memoryLocalCache() });
}

/** Point the Auth handle at the Auth emulator. Safe to call once per handle. */
function connectAuthEmulatorOnce(auth: Auth, host: string): void {
  connectAuthEmulator(auth, `${EMULATOR_SCHEME}://${host}:${EMULATOR_PORTS.auth}`, {
    disableWarnings: true
  });
}

/** Point the Firestore handle at the Firestore emulator. Safe to call once per handle. */
function connectFirestoreEmulatorOnce(db: Firestore, host: string): void {
  connectFirestoreEmulator(db, host, EMULATOR_PORTS.firestore);
}

/** Point the Storage handle at the Storage emulator. Safe to call once per handle. */
function connectStorageEmulatorOnce(storage: FirebaseStorage, host: string): void {
  connectStorageEmulator(storage, host, EMULATOR_PORTS.storage);
}

/**
 * Return the initialised Firebase handles, creating them on first call.
 *
 * @throws {Error} during SSR — the Firebase web SDK is browser-only.
 *
 * @example
 * ```ts
 * const { db, auth, storage } = getFirebase();
 * ```
 */
export function getFirebase(): FirebaseClients {
  if (!browser) {
    throw new Error('Firebase client SDK must not be invoked during SSR.');
  }

  if (clients) return clients;

  const config = resolveConfig();

  // Reuse the default app when something (HMR, a test harness) already created
  // one; `initializeApp` would throw on a duplicate name.
  const app = getApps().length === 0 ? initializeApp(config) : getApp();

  const auth = getAuth(app);
  const db = createFirestore(app);
  const storage = getStorage(app);

  const isEmulator = isEmulatorEnabled();
  if (isEmulator) {
    const host = getBrowserEmulatorHost();
    connectAuthEmulatorOnce(auth, host);
    connectFirestoreEmulatorOnce(db, host);
    connectStorageEmulatorOnce(storage, host);
  }

  clients = { app, auth, db, storage, config, isEmulator };
  return clients;
}

/** Typed convenience accessor for the Firestore handle. */
export function getFirestoreClient(): Firestore {
  return getFirebase().db;
}

/** Typed convenience accessor for the Auth handle. */
export function getAuthClient(): Auth {
  return getFirebase().auth;
}

/** Typed convenience accessor for the Storage handle. */
export function getStorageClient(): FirebaseStorage {
  return getFirebase().storage;
}

/** `true` once {@link getFirebase} has actually run in this browser context. */
export function isFirebaseReady(): boolean {
  return clients !== null;
}

/** Human-readable description of the active wiring, surfaced in the app's status screen. */
export interface FirebaseRuntimeStatus {
  ready: boolean;
  isEmulator: boolean;
  projectId: string;
  storageBucket: string;
  emulatorHost: string | null;
  authPort: number;
  firestorePort: number;
  storagePort: number;
  persistentCache: boolean;
}

/**
 * Resolve the current wiring without initialising anything.
 *
 * Used by diagnostics/UI that must render before (or instead of) a live
 * connection, so it must stay side-effect free.
 */
export function getFirebaseRuntimeStatus(): FirebaseRuntimeStatus {
  const emulator = isEmulatorEnabled();
  return {
    ready: clients !== null,
    isEmulator: emulator,
    projectId: env.PUBLIC_FIREBASE_PROJECT_ID?.trim() || 'mock-drive-system',
    storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET?.trim() || 'mock-drive-system.appspot.com',
    emulatorHost: emulator ? getBrowserEmulatorHost() : null,
    authPort: EMULATOR_PORTS.auth,
    firestorePort: EMULATOR_PORTS.firestore,
    storagePort: EMULATOR_PORTS.storage,
    persistentCache: supportsIndexedDb()
  };
}
