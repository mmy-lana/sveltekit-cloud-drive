# Specification Plan: `sveltekit-cloud-drive`

## 1. Data Schema & Pure TypeScript Interfaces

### 1.1 Data Models & Validation Contracts

```typescript
export type ItemType = 'file' | 'folder';
export type ViewMode = 'grid' | 'list';
export type SortField = 'name' | 'updatedAt' | 'sizeBytes';
export type SortDirection = 'asc' | 'desc';

import type { Timestamp, FieldValue } from 'firebase/firestore';

export type UploadStatus = 'reserved' | 'uploading' | 'uploaded' | 'committed' | 'failed' | 'deletion-pending';

export interface StorageQuota {
  usedBytes: number;
  reservedBytes: number;
  totalBytes: number;
}

// Persisted Firestore Read Domain Models
export interface DriveUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  quota: StorageQuota;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DriveItemBase {
  id: string;
  name: string;
  normalizedName: string;
  ownerId: string;
  parentFolderId: string | null;
  isTrashed: boolean;
  trashedAt: Timestamp | null;
  isStarred: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DriveFolder extends DriveItemBase {
  type: 'folder';
  color: string | null;
}

export interface DriveFile extends DriveItemBase {
  type: 'file';
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  uploadStatus: UploadStatus;
  uploadSessionId: string;
  thumbnailUrl?: string | null;
  md5Hash?: string;
}

// Write DTOs (Separation of Server Timestamps / FieldValue Sentinels)
export interface ReserveUploadDTO {
  name: string;
  normalizedName: string;
  ownerId: string;
  parentFolderId: string | null;
  type: 'file';
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  uploadStatus: 'reserved';
  uploadSessionId: string;
  isTrashed: false;
  trashedAt: null;
  isStarred: boolean;
  createdAt: FieldValue;
  updatedAt: FieldValue;
}

export interface CreateFolderDTO {
  name: string;
  normalizedName: string;
  ownerId: string;
  parentFolderId: string | null;
  type: 'folder';
  color: string | null;
  isTrashed: false;
  trashedAt: null;
  isStarred: boolean;
  createdAt: FieldValue;
  updatedAt: FieldValue;
}

export interface UpdateItemDTO {
  name?: string;
  normalizedName?: string;
  parentFolderId?: string | null;
  isStarred?: boolean;
  isTrashed?: boolean;
  trashedAt?: FieldValue | null;
  uploadStatus?: UploadStatus;
  updatedAt: FieldValue;
}

export type DriveItem = DriveFolder | DriveFile;

export interface BreadcrumbNode {
  id: string | null;
  name: string;
}

export interface UploadTaskProgress {
  id: string;
  fileName: string;
  sizeBytes: number;
  bytesTransferred: number;
  progressPercentage: number;
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'paused';
  errorMessage: string | null;
}

export interface SelectionState {
  selectedIds: Set<string>;
  lastSelectedId: string | null;
}

export interface FilterSortOptions {
  searchQuery: string;
  itemType: 'all' | 'file' | 'folder';
  mimeFilter: string | null;
  sortBy: SortField;
  sortDirection: SortDirection;
  showOnlyStarred: boolean;
  showTrash: boolean;
}
```

### 1.2 Validation & Lifecycle Rules

- Canonical Normalization & Sibling Collision:
  - `normalizedName` is deterministically computed via `name.normalize('NFC').trim().toLowerCase()`.
  - Item creation, renaming, and relocation must evaluate sibling collisions within the same Firestore transaction as the write operation. The transaction must read existing sibling `normalizedName` records under the destination `(ownerId, parentFolderId)`. If collisions exist, append an auto-incremented numeric suffix: `base (1).ext`.
- Storage Allocation & Quota Integrity:
  - Quota enforcement is transactionally authoritative through Firestore transactions and Security Rules; no client-only quota check is trusted.
  - Write operations must guarantee `(quota.usedBytes + quota.reservedBytes + newBytes) <= quota.totalBytes`.
- State Authority & Optimistic UI Boundaries:
  - Optimistic UI updates are strictly reserved for non-authoritative presentation states (e.g. selection toggles, view modes, search queries).
  - Quota accounting, file upload statuses, and trash states must reconcile strictly against committed Firestore transaction outcomes.
- Trash & Restore Lifecycle:
  - Trashing a folder updates the folder and all retrieved descendants using chunked atomic batches (maximum 400 operations per batch to satisfy Firestore 500-write and Security Rules access limits).
  - Restoring an item whose parent was permanently deleted or remains in trash automatically reparents the item to root (`parentFolderId: null`).
- Idempotent Permanent Deletion:
  - Phase 1: Mark documents in Firestore as `uploadStatus: 'deletion-pending'` within a chunked batch.
  - Phase 2: Invoke Firebase Storage deletion on corresponding binary paths (`deleteObject(storageRef)`), catching and ignoring `storage/object-not-found` to ensure idempotency.
  - Phase 3: Hard-delete Firestore documents and decrement `quota.usedBytes` atomically. Incomplete deletion cycles can safely be resumed on subsequent client runs.
- Framework Standard: Pure Svelte 5 runes (`$state`, `$derived`, `$effect`, `.svelte.ts` modules) are strictly enforced. Legacy Svelte 4 store contracts (`writable`, `readable`) must not be used.

---

## 2. Component Architecture

### 2.1 Atomic Primitives (`src/lib/components/ui/`)
- `Button.svelte`: Pure button with variants (`primary`, `secondary`, `ghost`, `danger`), sizes (`sm`, `md`, `lg`), loading spinner slot.
- `IconButton.svelte`: Accessible icon wrapper with touch-target optimization (minimum 44x44px bounding area).
- `Input.svelte`: Text input with clear button, icon prefix/suffix slots, and error feedback state.
- `Badge.svelte`: Neutral/status tag for file sizes, status indicators, and counts.
- `Checkbox.svelte`: Custom dual-state/indeterminate checkbox with keyboard and touch accessibility.
- `ProgressBar.svelte`: Linear bar showing upload/quota fill percentage.
- `DropdownMenu.svelte`: Accessible menu popup for context options, anchored to triggering coordinate or target node.
- `Modal.svelte`: Accessible dialog overlay with trap focus, ESC key handling, and background dismiss.

### 2.2 Compound Molecules (`src/lib/components/molecules/`)
- `Breadcrumbs.svelte`: Horizontal path navigator with touch scrolling on mobile and drop target capabilities.
- `SearchBar.svelte`: Filter input with debounce, search-history dropdown, and clear trigger.
- `StorageMeter.svelte`: Gauge displaying used vs. available storage bytes with contextual warning thresholds (>80%, >95%).
- `ViewToggle.svelte`: Segmented control switching between `'grid'` and `'list'`.
- `FileIcon.svelte`: Deterministic SVG icon generator mapping mime types (`image/*`, `video/*`, `application/pdf`, code, archives, audio).
- `EmptyState.svelte`: Centered vector artwork and descriptive fallback copy for empty folders, trash, and search results.

### 2.3 Feature Organisms (`src/lib/components/organisms/`)
- `SidebarNavigation.svelte`: Primary navigation list (My Drive, Starred, Trash, Storage details). Collapsible on small screens.
- `TopNavbar.svelte`: Search bar, view toggles, upload CTA, and user profile avatar.
- `FileGrid.svelte`: Grid layout displaying items as responsive cards with thumbnail previews.
- `FileList.svelte`: Responsive list layout. Desktop/tablet renders tabular columns (Name, Owner, Date Modified, File Size). Mobile (<=430px) shifts to a two-line stacked card row (Line 1: Icon + Name + Context Menu; Line 2: Date Modified + File Size) and hides the Owner column completely to eliminate horizontal overflow.
- `FileCard.svelte`: Grid tile item with touch selection checkmark, double-tap open, and explicit context button.
- `FileRow.svelte`: Table row item with identical touch/context triggers to `FileCard`.
- `UploadDropzone.svelte`: Full-viewport drag-and-drop overlay with visual upload boundary indicator.
- `UploadQueueDrawer.svelte`: Bottom-docked drawer tracking active, paused, and finished file uploads.
- `FilePreviewModal.svelte`: Media previewer supporting images, PDFs, plain text, and video/audio playback.
- `ItemContextMenu.svelte`: Action menu (Rename, Star/Unstar, Move, Download, Trash, Permanent Delete).
- `BatchActionBar.svelte`: Floating bottom bar appearing when items are selected (Delete, Move, Clear selection).
- `CreateFolderModal.svelte`: Form modal with input validation to spawn a new folder node.

### 2.4 Layout Shell (`src/routes/+layout.svelte`)
- Responsive three-tier layout:
  - Mobile (< 768px): Bottom app bar or slide-out sheet drawer, full-width content area, floating action button (FAB) for uploads.
  - Tablet (768px - 1023px): Collapsible icon-only navigation rail, adaptive content header.
  - Desktop (>= 1024px): Persistent 256px sidebar, fixed global search header, expansive flexible canvas.

---

## 3. Core Feature Logic

### 3.1 Firebase Emulator & Client Bridge Architecture

Singleton Ownership Invariant:
`src/lib/firebase/client.ts` is the single authoritative module responsible for initializing and exporting Firebase services. No other module, service, or component may directly execute `initializeApp`, `initializeFirestore`, `getFirestore`, `getAuth`, or `getStorage`.

```typescript
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import {
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: env.PUBLIC_FIREBASE_API_KEY || 'mock-api-key',
  authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN || 'mock-drive.firebaseapp.com',
  projectId: env.PUBLIC_FIREBASE_PROJECT_ID || 'mock-drive-system',
  storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET || 'mock-drive-system.appspot.com',
  messagingSenderId: env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: env.PUBLIC_FIREBASE_APP_ID || '1:000000000000:web:000000000000'
};

interface FirebaseClients {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
}

let clients: FirebaseClients | null = null;

export function getFirebase(): FirebaseClients {
  if (!browser) {
    throw new Error('Firebase client SDK must not be invoked during SSR.');
  }

  if (clients) return clients;

  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
  const auth = getAuth(app);
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
  const storage = getStorage(app);

  if (env.PUBLIC_USE_FIREBASE_EMULATOR === 'true') {
    const host = env.PUBLIC_EMULATOR_HOST || 'localhost';
    connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, host, 8080);
    connectStorageEmulator(storage, host, 9199);
  }

  clients = { app, auth, db, storage };
  return clients;
}
```

### 3.2 Atomic Hierarchy & Transactional Move Operations
1. Root representation is `null`.
2. Path resolution uses flat map cache refreshed on root/folder transitions to prevent traversal roundtrips.
3. Atomic Folder Relocation: All folder moves execute within a Firestore transaction:
   - Read current target folder metadata and target ancestor lineage.
   - Assert destination folder is active (`!isTrashed`) and belongs to the calling user.
   - Assert target folder is not equal to or a child of source folder `A`.
   - Update `parentFolderId` and `updatedAt: serverTimestamp()` atomically.

### 3.3 Upload State Machine & Session Integrity Pipeline
Primary entrypoint is `<input type="file">`. Pointer drag-and-drop on `window` and directory parsing (`webkitGetAsEntry`) act as progressive enhancements with strict fallback.

1. Reservation (Firestore Transaction):
   - Generate a unique `uploadSessionId` (UUID v4) for the upload attempt.
   - Transact on `users/${uid}` document and sibling query.
   - Assert `(quota.usedBytes + quota.reservedBytes + file.size) <= quota.totalBytes`.
   - Resolve sibling name collisions deterministically.
   - Atomically increment `quota.reservedBytes` by `file.size`.
   - Write pending file document to `items` collection with `uploadStatus: 'reserved'` and `uploadSessionId`.
2. Storage Upload:
   - Target reference: `users/${uid}/${itemId}/${file.name}`.
   - Dispatch `uploadBytesResumable(storageRef, file)`.
   - Update document status to `uploadStatus: 'uploading'`.
   - Dispatch progress mutations to runes-based `uploadQueueState`.
3. Finalization Commit (Firestore Transaction):
   - On upload completion, transact to update file document:
     - Verify document `uploadSessionId` matches current attempt.
     - Set `uploadStatus: 'committed'`, `storagePath`, `sizeBytes`, `updatedAt: serverTimestamp()`.
     - Atomically decrement `quota.reservedBytes` by `file.size` and increment `quota.usedBytes` by `file.size`.
4. Race-Resistant Orphan Cleanup:
   - On Storage error or explicit abort: transact on the file document. Verify current document `uploadSessionId === activeSessionId` before mutating. If matched, delete pending document and release `reservedBytes`. If session ID mismatch is detected, abort rollback to preserve active subsequent retry.
   - Storage-success/Firestore-failure compensation: If Firestore finalization fails, mark document `uploadStatus: 'failed'` and invoke background compensator to clean the Storage blob idempotently before releasing reserved bytes.

### 3.4 Multi-Selection Strategy
- Mobile/Touch: Long-press (400ms delay) enters multi-select mode. Touch taps toggle item in `SelectionState`.
- Desktop: Single click selects item. Ctrl/Cmd + click toggles specific item. Shift + click performs continuous range selection based on visible item sequence.
- Dedicated action button trigger available on all viewports without requiring hover.

---

## 4. Responsive Breakpoint Matrix

| Viewport Width | Navigation Mode | View Layout Default | Context Trigger | Multi-select Trigger |
| :--- | :--- | :--- | :--- | :--- |
| **360px** | Bottom Bar / Slide Drawer | 1 Column List or 2 Column Grid | 3-Dot Button on Card | Checkbox overlay / Long press |
| **390px** | Bottom Bar / Slide Drawer | 1 Column List or 2 Column Grid | 3-Dot Button on Card | Checkbox overlay / Long press |
| **430px** | Bottom Bar / Slide Drawer | 1 Column List or 2 Column Grid | 3-Dot Button on Card | Checkbox overlay / Long press |
| **768px** | Mini Navigation Rail (64px) | Dynamic Grid (3-4 Cols) / List | Row Action Button | Checkbox / Ctrl+Click |
| **1024px+** | Full Sidebar (256px) | Dynamic Grid (4-6 Cols) / List | Row Action / Right Click | Checkbox / Shift/Ctrl+Click |

---

## 5. Five-Phase Sequential Execution Queue

### Phase 1: Types, Storage/API Client Config, and Base Utilities
- [ ] Define segregated domain read models and write DTOs in `src/lib/types/drive.ts`.
- [ ] Implement Firebase client singleton connection with SSR browser guard and `persistentLocalCache` in `src/lib/firebase/client.ts`.
- [ ] Configure declarative `firestore.rules` enforcing:
  - `request.auth.uid == resource.data.ownerId` (authenticated user ownership).
  - Immutability of `ownerId` and item `type` on update.
  - Parent validation: `parentFolderId == null` or parent exists and belongs to `request.auth.uid`.
  - Quota field protection: direct client updates to `quota.usedBytes` and `quota.totalBytes` disallowed outside valid transaction invariants.
  - Enforced state transitions for `uploadStatus` (`reserved -> uploading -> committed -> deletion-pending`).
- [ ] Configure `storage.rules` verifying caller `request.auth.uid` matches storage object path prefix `/users/{uid}/...`.
- [ ] Write storage byte formatting and timestamp presentation utilities in `src/lib/utils/formatters.ts`.
- [ ] Write MIME-type resolution engine in `src/lib/utils/mimetypes.ts`.
- [ ] Set up Docker emulator configuration files (`docker-compose.yml`, `firebase.json`).

### Phase 2: Design Foundation & Atomic UI Primitives
- [ ] Configure Tailwind CSS v4 styling foundation using `@tailwindcss/vite` and `src/app.css` via `@import "tailwindcss";` without legacy PostCSS or `tailwind.config.js`.
- [ ] Implement `Button.svelte` and `IconButton.svelte` with standard touch compliance.
- [ ] Implement `Input.svelte`, `Checkbox.svelte`, and `ProgressBar.svelte`.
- [ ] Implement accessible floating layers: `Modal.svelte` and `DropdownMenu.svelte`.
- [ ] Build MIME-based vector representation in `FileIcon.svelte`.

### Phase 3: Compound Molecules & Feature Components
- [ ] Build `Breadcrumbs.svelte` with interactive segment routing.
- [ ] Build `SearchBar.svelte` with live debounced filtering.
- [ ] Build `StorageMeter.svelte` with linear usage visualization.
- [ ] Build `ViewToggle.svelte` and view switcher persistence.
- [ ] Build `FileCard.svelte` (grid tile) and `FileRow.svelte` (list row) with explicit touch menus.
- [ ] Build `UploadDropzone.svelte` with screen-wide drag interception.

### Phase 4: Domain Logic, Reactive State, and Specialized APIs
- [ ] Implement user auth state runes module (`authStore.svelte.ts`) using Firebase Auth emulator anonymous/test authentication.
- [ ] Implement real-time items runes module (`driveStore.svelte.ts`) subscribing to Firestore queries by `currentFolderId` with optimistic local caching.
- [ ] Implement transactional upload manager (`uploadQueueStore.svelte.ts`) with quota reservation, progress tracking, and orphan cleanup compensation.
- [ ] Implement multi-selection runes module (`selectionStore.svelte.ts`) handling pointer selection, shift-range selection, and mobile long-press with motion-cancellation boundaries.
- [ ] Build `ItemContextMenu.svelte` and `BatchActionBar.svelte` executing transactional move, recursive trash/restore, and download URL resolution via `getDownloadURL(ref)`.
- [ ] Build `FilePreviewModal.svelte` resolving canonical `storagePath` dynamically into playable/viewable object URLs.

### Phase 5: Complete Page/Screen Assembly & Responsive Shell
- [ ] Construct `AppShell` in `src/routes/+layout.svelte` integrating Sidebar, TopNavbar, and UploadQueueDrawer.
- [ ] Assemble main drive route `src/routes/+page.svelte` supporting root and subfolder listing via query params or folder route `src/routes/folder/[id]/+page.svelte`.
- [ ] Assemble Starred view in `src/routes/starred/+page.svelte`.
- [ ] Assemble Trash/Bin view in `src/routes/trash/+page.svelte` with empty-bin and restore operations.
- [ ] Perform responsive layout verification across 360px, 390px, 430px, 768px, and 1024px+ viewports without hover dependencies.