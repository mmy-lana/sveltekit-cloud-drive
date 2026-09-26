# SvelteKit Cloud Drive

A minimalist personal cloud dashboard and mock drive system built with SvelteKit and Firebase. Designed with clean Google Drive and Dropbox aesthetics, offline-first development via Docker Firebase emulators, and transactional data integrity.

- **Live Demo:** [https://sveltekit-cloud-drive.vercel.app](https://sveltekit-cloud-drive.vercel.app)
- **Repository:** [https://github.com/mmy-lana/sveltekit-cloud-drive](https://github.com/mmy-lana/sveltekit-cloud-drive)

---

## Key Features

- **File & Folder Management:** Create nested folders up to 64 levels deep, rename items with deterministic collision resolution (`file (1).ext`), move items with circular-dependency prevention, and toggle starred items.
- **Transactional Quota Accounting:** Quota checks are enforced via atomic Firestore transactions and Firestore Security Rules. Storage reservations occur prior to binary upload and commit upon completion.
- **Idempotent Deletion & Recovery:** Three-phase permanent deletion (tombstone document -> remove binary from Firebase Storage -> hard delete Firestore document and reclaim quota).
- **Responsive Multi-Tier Shell:**
  - **Desktop (>= 1024px):** Persistent 256px sidebar with storage telemetry gauge and global search.
  - **Tablet (768px - 1023px):** 64px icon-only navigation rail.
  - **Mobile (360px - 767px):** Pinned bottom navigation bar, floating upload trigger, and two-line stacked card rows with no horizontal scroll.
- **Accessible Touch & Pointer Contracts:** 44x44px minimum bounding areas across all controls, keyboard traps on modals, and complete independence from desktop hover states.
- **In-Browser File Previews:** View raster images with zoom controls, stream video and audio, render PDFs in sandboxed frames, and inspect syntax-escaped source code.

---

## Tech Stack

- **Framework:** SvelteKit (Svelte 5 Runes: `$state`, `$derived`, `$effect`, `.svelte.ts` modules)
- **Styling:** Tailwind CSS v4 via `@tailwindcss/vite`
- **Backend & Storage:** Firebase Web SDK (Auth, Firestore, Cloud Storage)
- **Local Emulation:** Docker Compose running containerized Firebase Emulator Suite
- **Icons:** Lucide Svelte
- **Package Manager:** pnpm

---

## Architecture Overview

```
                      +-----------------------------+
                      |   SvelteKit App (Browser)   |
                      +--------------+--------------+
                                     |
               +---------------------+---------------------+
               |                     |                     |
     [Anonymous Auth]       [Firestore Database]   [Firebase Storage]
               |                     |                     |
     Session Identity        Items & Quota Ledger   Raw Binary Blobs
```

1. **Client Bridge (`src/lib/firebase/client.ts`):** Module singleton that acts as the sole accessor for Firebase SDK handles. Guards against SSR invocation and configures `persistentLocalCache` with `persistentMultipleTabManager`.
2. **Quota State Machine:** Uploads reserve bytes in `users/{uid}.quota.reservedBytes` atomically. On upload completion, bytes transition to `usedBytes`. If an upload fails or cancels, reservations rollback using attempt-specific generation tokens (`uploadSessionId`).
3. **Hierarchy Traversal:** Trashing executes deepest-first in chunked batches (max 400 writes per batch). Restores execute shallowest-first to satisfy security rule parent constraints (`hasValidParentOnUpdate`).

---

## Local Development Setup

### Prerequisites

- Node.js (v20+ recommended)
- pnpm
- Docker and Docker Compose

### 1. Clone the Repository

```bash
git clone https://github.com/mmy-lana/sveltekit-cloud-drive.git
cd sveltekit-cloud-drive
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Start Firebase Emulators

Run the emulator container (Firestore on 8080, Auth on 9099, Storage on 9199, UI on 4000):

```bash
pnpm run emulators:up
```

View emulator logs anytime:

```bash
pnpm run emulators:logs
```

### 4. Configure Environment Variables

Copy the sample environment file:

```bash
cp .env.example .env
```

Ensure the following variables are present in `.env`:

```env
PUBLIC_USE_FIREBASE_EMULATOR=true
PUBLIC_EMULATOR_HOST=localhost
PUBLIC_FIREBASE_API_KEY=mock-api-key
PUBLIC_FIREBASE_AUTH_DOMAIN=mock-drive.firebaseapp.com
PUBLIC_FIREBASE_PROJECT_ID=mock-drive-system
PUBLIC_FIREBASE_STORAGE_BUCKET=mock-drive-system.appspot.com
PUBLIC_FIREBASE_MESSAGING_SENDER_ID=000000000000
PUBLIC_FIREBASE_APP_ID=1:000000000000:web:000000000000
```

### 5. Run Development Server

```bash
pnpm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Available Scripts

| Command | Description |
| :--- | :--- |
| `pnpm run dev` | Start Vite development server |
| `pnpm run build` | Build production application bundle |
| `pnpm run preview` | Locally preview production build |
| `pnpm run check` | Run SvelteKit sync and TypeScript diagnostics |
| `pnpm run verify` | Execute transactional store verification suite against live emulator |
| `pnpm run audit:responsive` | Run Playwright headless responsive and accessibility matrix audit |
| `pnpm run emulators:up` | Launch Docker Firebase emulator suite |
| `pnpm run emulators:down` | Stop Docker Firebase emulator suite |
| `pnpm run emulators:reset` | Tear down containers and wipe persistent emulator volumes |

---

## Deployment (Vercel)

When deploying to production or staging on Vercel without local emulators:

1. Configure a production Firebase project in Google Cloud / Firebase Console.
2. In your Vercel Project Settings, define the production environment variables:
   - `PUBLIC_USE_FIREBASE_EMULATOR=false`
   - `PUBLIC_FIREBASE_API_KEY`
   - `PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `PUBLIC_FIREBASE_PROJECT_ID`
   - `PUBLIC_FIREBASE_STORAGE_BUCKET`
   - `PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
   - `PUBLIC_FIREBASE_APP_ID`
3. Deploy Security Rules using the Firebase CLI:
   ```bash
   firebase deploy --only firestore:rules,storage:rules,firestore:indexes
   ```

---

## License

MIT
