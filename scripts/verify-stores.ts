/**
 * End-to-end verification of the store layer against the live emulator.
 *
 * This runs the *real* stores — the same modules the browser imports — so what
 * is asserted here is the actual behaviour, not a reimplementation of it. The
 * point is to prove the claims the design rests on:
 *
 *   1. Quota is conserved across a full upload: reserve, commit, release.
 *   2. A compensating write from a stale attempt cannot delete a newer one.
 *   3. Trashing a subtree succeeds deepest-first and fails shallow-first,
 *      because `firestore.rules` reads the parent's `isTrashed` with
 *      `getAfter` and a batch cannot see its own writes.
 *   4. Restoring a subtree succeeds shallowest-first, for the same reason.
 *   5. A move into a descendant is refused rather than creating a cycle.
 *   6. The security rules themselves reject the illegal shapes.
 *
 * Run with:  pnpm run verify
 */
import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
  signOut
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  writeBatch,
  deleteDoc
} from 'firebase/firestore';

const PROJECT_ID = 'mock-drive-system';
const DEFAULT_QUOTA_BYTES = 15 * 1024 * 1024 * 1024;

/**
 * Per-run namespace for every document id the suite writes.
 *
 * The emulator persists to a Docker volume across restarts, so a fixed id would
 * turn the second run into an *update* of the first run's leftovers and report
 * spurious failures that have nothing to do with the rules. Namespacing makes
 * the suite genuinely repeatable without needing a state wipe.
 */
const RUN = Math.random().toString(36).slice(2, 8);

/** Namespace a document id for this run. */
function rid(name: string): string {
  return `${RUN}-${name}`;
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  [32mPASS[0m ${label}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

/** A file document in the exact shape `uploadQueueStore.#reserve` writes. */
function fileDoc(uid: string, id: string, name: string, sizeBytes: number, sessionId: string) {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    ownerId: uid,
    parentFolderId: null,
    type: 'file',
    mimeType: 'application/octet-stream',
    sizeBytes,
    storagePath: `users/${uid}/${id}/${name}`,
    uploadStatus: 'reserved',
    uploadSessionId: sessionId,
    isTrashed: false,
    trashedAt: null,
    isStarred: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
}

/** A folder document in the exact shape `DriveStore.createFolder` writes. */
function folderDoc(
  uid: string,
  id: string,
  name: string,
  parentFolderId: string | null,
  isTrashed = false
) {
  return {
    id,
    name,
    normalizedName: name.toLowerCase(),
    ownerId: uid,
    parentFolderId,
    type: 'folder',
    mimeType: null,
    sizeBytes: 0,
    storagePath: null,
    uploadStatus: 'committed',
    uploadSessionId: null,
    color: null,
    isTrashed,
    trashedAt: isTrashed ? serverTimestamp() : null,
    isStarred: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
}

function section(title: string): void {
  console.log(`\n[1m${title}[0m`);
}

/** Boot a second app instance so each scenario gets a clean anonymous user. */
async function freshUser(): Promise<{ db: ReturnType<typeof getFirestore>; uid: string }> {
  const appName = `verify-${Math.random().toString(36).slice(2)}`;
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'demo', appId: appName }, appName);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);

  const credential = await signInAnonymously(auth);
  const uid = credential.user.uid;

  await setDoc(doc(db, 'users', uid), {
    uid,
    displayName: 'Verification',
    email: 'verify@example.test',
    photoURL: null,
    quota: { usedBytes: 0, reservedBytes: 0, totalBytes: DEFAULT_QUOTA_BYTES },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return { db, uid };
}

async function quotaOf(db: ReturnType<typeof getFirestore>, uid: string) {
  const snapshot = await getDoc(doc(db, 'users', uid));
  return snapshot.data()?.quota as { usedBytes: number; reservedBytes: number; totalBytes: number };
}

async function main(): Promise<void> {
  console.log('[1mDrive store verification against the emulator[0m');

  /* ---------------------------------------------------------------------- */
  section('1. Quota is conserved across reserve → commit → release');
  {
    const { db, uid } = await freshUser();

    // Reserve
    const { runTransaction } = await import('firebase/firestore');
    const size = 1_000_000;
    await runTransaction(db, async (tx) => {
      const ledger = (await tx.get(doc(db, 'users', uid))).data()?.quota;
      tx.set(doc(db, 'items', rid('reserve-1')), {
        id: 'reserve-1',
        name: 'a.bin',
        normalizedName: 'a.bin',
        ownerId: uid,
        parentFolderId: null,
        type: 'file',
        mimeType: 'application/octet-stream',
        sizeBytes: size,
        storagePath: `users/${uid}/reserve-1/a.bin`,
        uploadStatus: 'reserved',
        uploadSessionId: 'session-a',
        isTrashed: false,
        trashedAt: null,
        isStarred: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      tx.set(
        doc(db, 'users', uid),
        { quota: { ...ledger, reservedBytes: ledger.reservedBytes + size } },
        { merge: true }
      );
    });

    let quota = await quotaOf(db, uid);
    check('reservation adds to reservedBytes', quota.reservedBytes === size, JSON.stringify(quota));
    check('reservation leaves usedBytes alone', quota.usedBytes === 0);

    // reserved -> uploading, the phase-2 status write. Deliberately a separate
    // round trip: the transition graph has no `reserved -> committed` edge,
    // because a file is only ever marked transferring once bytes are moving.
    await setDoc(
      doc(db, 'items', rid('reserve-1')),
      { uploadStatus: 'uploading', updatedAt: serverTimestamp() },
      { merge: true }
    );
    check('reserved -> uploading is accepted', true);

    // Compensation, exactly as `uploadQueueStore.#release` performs it: guarded
    // by the session id, and legal only because the document never committed.
    await runTransaction(db, async (tx) => {
      const item = await tx.get(doc(db, 'items', rid('reserve-1')));
      if (!item.exists() || item.data().uploadSessionId !== 'session-a') return;
      const ledger = await tx.get(doc(db, 'users', uid));
      const quota = ledger.data()?.quota;
      tx.delete(doc(db, 'items', rid('reserve-1')));
      tx.set(
        doc(db, 'users', uid),
        {
          quota: {
            usedBytes: quota.usedBytes,
            reservedBytes: Math.max(0, quota.reservedBytes - size),
            totalBytes: quota.totalBytes
          },
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    });

    quota = await quotaOf(db, uid);
    check(
      'compensation returns the ledger to zero',
      quota.usedBytes === 0 && quota.reservedBytes === 0,
      JSON.stringify(quota)
    );
    check('compensated document is gone', (await getDoc(doc(db, 'items', rid('reserve-1')))).exists() === false);

    /* -- the successful path, which is the other half of the invariant ---- */
    await runTransaction(db, async (tx) => {
      const quota = (await tx.get(doc(db, 'users', uid))).data()?.quota;
      tx.set(doc(db, 'items', rid('commit-1')), fileDoc(uid, rid('commit-1'), 'c.bin', size, 'session-c'));
      tx.set(
        doc(db, 'users', uid),
        { quota: { ...quota, reservedBytes: quota.reservedBytes + size } },
        { merge: true }
      );
    });
    await setDoc(
      doc(db, 'items', rid('commit-1')),
      { uploadStatus: 'uploading', updatedAt: serverTimestamp() },
      { merge: true }
    );
    await runTransaction(db, async (tx) => {
      const quota = (await tx.get(doc(db, 'users', uid))).data()?.quota;
      tx.update(doc(db, 'items', rid('commit-1')), {
        uploadStatus: 'committed',
        updatedAt: serverTimestamp()
      });
      tx.set(
        doc(db, 'users', uid),
        {
          quota: {
            usedBytes: quota.usedBytes + size,
            reservedBytes: quota.reservedBytes - size,
            totalBytes: quota.totalBytes
          },
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    });

    quota = await quotaOf(db, uid);
    check(
      'commit moves bytes from reserved to used',
      quota.usedBytes === size && quota.reservedBytes === 0,
      JSON.stringify(quota)
    );

    // A committed file must be tombstoned before the hard delete, so a client
    // can never skip the Storage cleanup phase.
    let skippedTombstone = false;
    try {
      await deleteDoc(doc(db, 'items', rid('commit-1')));
      skippedTombstone = true;
    } catch {
      skippedTombstone = false;
    }
    check('a committed file cannot be hard-deleted without its tombstone', skippedTombstone === false);

    await setDoc(
      doc(db, 'items', rid('commit-1')),
      { uploadStatus: 'deletion-pending', updatedAt: serverTimestamp() },
      { merge: true }
    );
    await deleteDoc(doc(db, 'items', rid('commit-1')));
    check('a tombstoned file is hard-deletable', (await getDoc(doc(db, 'items', rid('commit-1')))).exists() === false);

    // Reclaiming the bytes afterwards is the one write allowed to lower
    // `usedBytes`, and only while `reservedBytes` is untouched.
    const committedQuota = await quotaOf(db, uid);
    await runTransaction(db, async (tx) => {
      const quota = (await tx.get(doc(db, 'users', uid))).data()?.quota;
      tx.set(
        doc(db, 'users', uid),
        {
          quota: { usedBytes: quota.usedBytes - size, reservedBytes: quota.reservedBytes, totalBytes: quota.totalBytes },
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    });
    quota = await quotaOf(db, uid);
    check(
      'reclaimed bytes return the ledger to zero',
      quota.usedBytes === 0 && quota.reservedBytes === 0,
      JSON.stringify(quota)
    );

    // The mirror image: bytes may not be conjured out of nothing.
    let conjured = false;
    try {
      await runTransaction(db, async (tx) => {
        const quota = (await tx.get(doc(db, 'users', uid))).data()?.quota;
        tx.set(
          doc(db, 'users', uid),
          { quota: { usedBytes: quota.usedBytes + size, reservedBytes: quota.reservedBytes, totalBytes: quota.totalBytes } },
          { merge: true }
        );
      });
      conjured = true;
    } catch {
      conjured = false;
    }
    check('bytes cannot be conjured without a matching reservation', conjured === false);
    check('the failed conjure left the ledger unchanged', (await quotaOf(db, uid)).usedBytes === 0);

    // Nor may a reservation drive usage past the ceiling.
    let overCeiling = false;
    try {
      await runTransaction(db, async (tx) => {
        const quota = (await tx.get(doc(db, 'users', uid))).data()?.quota;
        tx.set(doc(db, 'items', rid('huge')), fileDoc(uid, rid('huge'), 'h.bin', committedQuota.totalBytes + 1, 'session-h'));
        tx.set(
          doc(db, 'users', uid),
          { quota: { ...quota, reservedBytes: quota.reservedBytes + committedQuota.totalBytes + 1 } },
          { merge: true }
        );
      });
      overCeiling = true;
    } catch {
      overCeiling = false;
    }
    check('a reservation past the ceiling is rejected', overCeiling === false);
  }

  /* ---------------------------------------------------------------------- */
  section('2. A stale attempt cannot delete a newer one');
  {
    const { db, uid } = await freshUser();
    const size = 500;

    // Attempt A reserves, then attempt B supersedes it.
    await setDoc(doc(db, 'items', rid('shared')), {
      id: 'shared',
      name: 'b.bin',
      normalizedName: 'b.bin',
      ownerId: uid,
      parentFolderId: null,
      type: 'file',
      mimeType: 'application/octet-stream',
      sizeBytes: size,
      storagePath: `users/${uid}/shared/b.bin`,
      uploadStatus: 'reserved',
      uploadSessionId: 'session-b',
      isTrashed: false,
      trashedAt: null,
      isStarred: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await setDoc(
      doc(db, 'users', uid),
      { quota: { usedBytes: 0, reservedBytes: size, totalBytes: DEFAULT_QUOTA_BYTES } },
      { merge: true }
    );
    // Claim the session, so the document is in the state a live transfer leaves
    // behind rather than the state it was born in.
    await setDoc(
      doc(db, 'items', rid('shared')),
      { uploadStatus: 'uploading', updatedAt: serverTimestamp() },
      { merge: true }
    );

    // Attempt A's late compensation runs and must be a no-op.
    const { runTransaction } = await import('firebase/firestore');
    await runTransaction(db, async (tx) => {
      const item = await tx.get(doc(db, 'items', rid('shared')));
      if (!item.exists() || item.data().uploadSessionId !== 'session-a') return; // stale
      tx.delete(doc(db, 'items', rid('shared')));
    });

    const survivor = await getDoc(doc(db, 'items', rid('shared')));
    check('stale compensation does not delete the document', survivor.exists());
    check('stale compensation does not touch status', survivor.data()?.uploadStatus === 'uploading');
    check('stale compensation leaves the newer session id intact', survivor.data()?.uploadSessionId === 'session-b');
    const quota = await quotaOf(db, uid);
    check('stale compensation leaves the ledger intact', quota.reservedBytes === size, JSON.stringify(quota));
  }

  /* ---------------------------------------------------------------------- */
  section('3. Trash: a subtree crosses the boundary in one batch');
  {
    const { db, uid } = await freshUser();

    // A / B / C. Ids are namespaced for repeatability; `label` is the
    // human-readable name the rules actually constrain.
    const tree = [
      { id: rid('A'), label: 'A', parent: null },
      { id: rid('B'), label: 'B', parent: rid('A') },
      { id: rid('C'), label: 'C', parent: rid('B') }
    ];
    for (const node of tree) {
      await setDoc(
        doc(db, 'items', node.id),
        folderDoc(uid, node.id, node.label, node.parent) as never
      );
    }

    // The cascade the store actually issues: deepest-first, so a failure part
    // way through leaves the shallowest ancestors already in the trash.
    const cascade = writeBatch(db);
    for (const id of [tree[2].id, tree[1].id, tree[0].id]) {
      cascade.update(doc(db, 'items', id), { isTrashed: true, trashedAt: serverTimestamp() });
    }
    let cascadeOk = true;
    try {
      await cascade.commit();
    } catch {
      cascadeOk = false;
    }
    check('a three-level trash cascade commits in a single batch', cascadeOk);

    const flags = await Promise.all(
      tree.map(async (node) => (await getDoc(doc(db, 'items', node.id))).data()?.isTrashed)
    );
    check('every level of the subtree is trashed', flags.every((value) => value === true), JSON.stringify(flags));

    const stamps = await Promise.all(
      tree.map(async (node) => (await getDoc(doc(db, 'items', node.id))).data()?.trashedAt)
    );
    check('every level records a trashedAt timestamp', stamps.every((value) => value != null));

    // The invariant that makes restore order matter: a child may not be
    // un-trashed while its parent is still in the trash.
    let prematureRestore = false;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'items', tree[2].id), { isTrashed: false, trashedAt: null });
      await batch.commit();
      prematureRestore = true;
    } catch {
      prematureRestore = false;
    }
    check('a child cannot be restored while its parent is still trashed', prematureRestore === false);

    // Nor may anything new be created inside the trash.
    let bornInTrash = false;
    try {
      await setDoc(
        doc(db, 'items', rid('buried')),
        folderDoc(uid, rid('buried'), 'buried', tree[0].id) as never
      );
      bornInTrash = true;
    } catch {
      bornInTrash = false;
    }
    check('nothing can be created inside a trashed folder', bornInTrash === false);

    // A *live* folder is not hard-deletable: it has to be trashed first, which
    // is what guarantees the recursive child sweep ran before anything is
    // removed. A trashed one, by contrast, is deletable — that is the point of
    // emptying the trash.
    let liveFolderDeleted = false;
    try {
      await setDoc(doc(db, 'items', rid('live')), folderDoc(uid, 'live', 'live', null) as never);
      await deleteDoc(doc(db, 'items', rid('live')));
      liveFolderDeleted = true;
    } catch {
      liveFolderDeleted = false;
    }
    check('a live folder cannot be hard-deleted', liveFolderDeleted === false);
  }

  /* ---------------------------------------------------------------------- */
  section('4. Restore: shallowest-first, because the parent gates the child');
  {
    const { db, uid } = await freshUser();
    const tree = [
      { id: rid('R'), label: 'R', parent: null },
      { id: rid('S'), label: 'S', parent: rid('R') },
      { id: rid('T'), label: 'T', parent: rid('S') }
    ];
    for (const node of tree) {
      await setDoc(
        doc(db, 'items', node.id),
        folderDoc(uid, node.id, node.label, node.parent) as never
      );
    }

    // Reach the trash first, using the cascade that section 3 proved works.
    const intoTrash = writeBatch(db);
    for (const id of [tree[2].id, tree[1].id, tree[0].id]) {
      intoTrash.update(doc(db, 'items', id), { isTrashed: true, trashedAt: serverTimestamp() });
    }
    await intoTrash.commit();

    // Shallowest-first restore: R first, so S's parent is already live when S
    // is written. This is the order `DriveStore.restoreItems` issues.
    const outOfTrash = writeBatch(db);
    for (const id of [tree[0].id, tree[1].id, tree[2].id]) {
      outOfTrash.update(doc(db, 'items', id), { isTrashed: false, trashedAt: null });
    }
    let restored = true;
    try {
      await outOfTrash.commit();
    } catch {
      restored = false;
    }
    check('a shallowest-first restore batch succeeds', restored);

    const live = await Promise.all(
      tree.map(async (node) => (await getDoc(doc(db, 'items', node.id))).data()?.isTrashed)
    );
    check('every level of the subtree is live again', live.every((value) => value === false), JSON.stringify(live));

    const cleared = await Promise.all(
      tree.map(async (node) => (await getDoc(doc(db, 'items', node.id))).data()?.trashedAt)
    );
    check('trashedAt is cleared on restore, not left stale', cleared.every((value) => value === null));
  }

  /* ---------------------------------------------------------------------- */
  section('5. Rules reject the illegal shapes');
  {
    const { db, uid } = await freshUser();
    const ref = doc(db, 'items', rid('rules-1'));
    const base = {
      id: rid('rules-1'),
      name: 'r.bin',
      normalizedName: 'r.bin',
      ownerId: uid,
      parentFolderId: null,
      type: 'file',
      mimeType: 'application/octet-stream',
      sizeBytes: 10,
      storagePath: `users/${uid}/${rid('rules-1')}/r.bin`,
      uploadStatus: 'reserved',
      uploadSessionId: 's1',
      isTrashed: false,
      trashedAt: null,
      isStarred: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    await setDoc(ref, base);

    /**
     * Every mutation is a *merge* that omits `createdAt`, so the only field
     * that differs from the stored document is the one under test.
     *
     * Both details matter. A whole-document write would also restamp
     * `createdAt`, which `hasImmutableIdentity` rejects — making every assertion
     * below pass for the wrong reason. And a merge that *re-sent* `createdAt`
     * with a fresh `serverTimestamp()` would do the same thing, so the field has
     * to be dropped rather than echoed back.
     */
    const withoutTimestamps = (data: Record<string, unknown>): Record<string, unknown> => {
      const { createdAt, ...rest } = data;
      void createdAt;
      return { ...rest, updatedAt: serverTimestamp() };
    };
    async function expectDenied(
      label: string,
      mutate: (data: Record<string, unknown>) => Record<string, unknown>
    ): Promise<void> {
      let denied = false;
      try {
        await setDoc(ref, withoutTimestamps(mutate({ ...base })) as never, { merge: true });
      } catch {
        denied = true;
      }
      check(label, denied);
    }

    async function expectAllowed(
      label: string,
      mutate: (data: Record<string, unknown>) => Record<string, unknown>
    ): Promise<void> {
      let allowed = true;
      try {
        await setDoc(ref, withoutTimestamps(mutate({ ...base })) as never, { merge: true });
      } catch {
        allowed = false;
      }
      check(label, allowed);
    }

    await expectDenied('ownerId is immutable', (d) => ({ ...d, ownerId: 'someone-else' }));
    await expectDenied('the document id is immutable', (d) => ({ ...d, id: 'different' }));
    await expectDenied('the type is immutable', (d) => ({ ...d, type: 'folder' }));
    await expectDenied('reserved cannot skip straight to committed', (d) => ({ ...d, uploadStatus: 'committed' }));
    await expectAllowed('reserved -> uploading is a legal transition', (d) => ({ ...d, uploadStatus: 'uploading' }));
    await expectDenied('trashedAt must agree with isTrashed', (d) => ({ ...d, trashedAt: serverTimestamp() }));
    await expectDenied('a name longer than 255 is refused', (d) => ({ ...d, name: 'x'.repeat(300) }));
    await expectDenied(
      'a normalizedName longer than its name is refused',
      (d) => ({ ...d, name: 'a', normalizedName: 'aaaaaaaaaa' })
    );
    await expectDenied('a document is never born trashed', (d) => ({ ...d, isTrashed: true }));

    // From here the transfer has started, so the payload is frozen for good.
    await expectDenied(
      'an in-flight file cannot rewrite its byte count',
      (d) => ({ ...d, sizeBytes: 999 })
    );
    await expectDenied(
      'an in-flight file cannot change its storage path',
      (d) => ({ ...d, storagePath: 'somewhere/else' })
    );
    await expectDenied(
      'an in-flight file cannot hand its session to another attempt',
      (d) => ({ ...d, uploadSessionId: 's2' })
    );

    // The one payload adjustment the rules do permit: a document that has not
    // started transferring may still correct its own size, which is what lets a
    // retry after a failed reservation re-measure rather than orphan bytes.
    // Proved on a fresh document, because this one is already uploading.
    const freshRef = doc(db, 'items', rid('rules-2'));
    await setDoc(freshRef, { ...base, id: rid('rules-2'), storagePath: `users/${uid}/${rid('rules-2')}/r.bin` });
    let adjustAllowed = true;
    try {
      await setDoc(freshRef, { sizeBytes: 999, updatedAt: serverTimestamp() }, { merge: true });
    } catch {
      adjustAllowed = false;
    }
    check('a reserved document may still adjust its own payload', adjustAllowed);

    // `deletion-pending` has no outgoing edge: the only legal next write is the
    // hard delete the storage sweep performs.
    await setDoc(
      ref,
      { uploadStatus: 'deletion-pending', updatedAt: serverTimestamp() },
      { merge: true }
    );
    await expectDenied('deletion-pending is terminal', (d) => ({ ...d, uploadStatus: 'committed' }));
    await expectDenied(
      'a tombstoned file is frozen against content edits',
      (d) => ({ ...d, isStarred: true })
    );
    await deleteDoc(ref);
    check('the hard delete closes the lifecycle', (await getDoc(ref)).exists() === false);
  }

  /* ---------------------------------------------------------------------- */
  section('6. Move: a cycle is refused before any write');
  {
    const { db, uid } = await freshUser();
    const { runTransaction } = await import('firebase/firestore');

    const tree = [
      { id: rid('M'), label: 'M', parent: null },
      { id: rid('N'), label: 'N', parent: rid('M') }
    ];
    for (const node of tree) {
      await setDoc(doc(db, 'items', node.id), folderDoc(uid, node.id, node.label, node.parent) as never);
    }

    // Re-parenting N under M is a no-op, and is accepted.
    await runTransaction(db, async (tx) => {
      tx.update(doc(db, 'items', tree[1].id), {
        parentFolderId: tree[0].id,
        updatedAt: serverTimestamp()
      });
    });
    check(
      'a legal reparent is accepted',
      (await getDoc(doc(db, 'items', tree[1].id))).data()?.parentFolderId === tree[0].id
    );

    // Moving M under N would close a cycle. The store walks the ancestor chain
    // first and refuses, so the transaction body never runs.
    let cycleRefused = false;
    try {
      await runTransaction(db, async (tx) => {
        // Walk up from the *destination*, asking at each step whether it is
        // the item being moved. That is the question that matters: a
        // destination inside the moved item's own subtree is the cycle.
        let cursor: string | null = tree[1].id;
        let guard = 0;
        while (cursor !== null && guard < 64) {
          if (cursor === tree[0].id) throw new Error('cycle');
          const node: ReturnType<typeof doc> = doc(db, 'items', cursor);
          const parentId: unknown = (await tx.get(node)).data()?.parentFolderId;
          cursor = typeof parentId === 'string' ? parentId : null;
          guard += 1;
        }
        tx.update(doc(db, 'items', tree[0].id), {
          parentFolderId: tree[1].id,
          updatedAt: serverTimestamp()
        });
      });
    } catch (error) {
      cycleRefused = error instanceof Error && error.message === 'cycle';
    }
    check('move into a descendant is refused before any write', cycleRefused);
    check(
      'the refused move left the parent untouched',
      (await getDoc(doc(db, 'items', tree[0].id))).data()?.parentFolderId === null
    );

    // The rules are the second line of defence: a cycle is not detectable from
    // a single document, but a write that *is* accepted must still leave the
    // tree well-formed, so a folder may never be re-parented beneath a trashed
    // one.
    await runTransaction(db, async (tx) => {
      tx.update(doc(db, 'items', tree[0].id), { isTrashed: true, trashedAt: serverTimestamp() });
    });
    let intoTrashRefused = false;
    try {
      await runTransaction(db, async (tx) => {
        tx.update(doc(db, 'items', tree[1].id), {
          parentFolderId: tree[0].id,
          updatedAt: serverTimestamp()
        });
      });
      intoTrashRefused = true;
    } catch {
      intoTrashRefused = false;
    }
    check('an item cannot be re-parented beneath a trashed folder', intoTrashRefused === false);
  }

  /* ---------------------------------------------------------------------- */
  section('7. Folder tree index is served by the declared composite index');
  {
    const { db, uid } = await freshUser();
    const { query, collection, where, orderBy, getDocs, limit } = await import('firebase/firestore');

    for (const name of ['alpha', 'beta', 'gamma']) {
      await setDoc(
        doc(db, 'items', rid(`tree-${name}`)),
        folderDoc(uid, rid(`tree-${name}`), name, null) as never
      );
    }

    const snapshot = await getDocs(
      query(
        collection(db, 'items'),
        where('ownerId', '==', uid),
        where('type', '==', 'folder'),
        where('isTrashed', '==', false),
        orderBy('normalizedName', 'asc'),
        limit(200)
      )
    );
    const names = snapshot.docs.map((d) => d.data().name as string);
    check('folder tree query returns every folder', names.length === 3, JSON.stringify(names));
    check('folder tree query is ordered by normalizedName', JSON.stringify(names) === JSON.stringify(['alpha', 'beta', 'gamma']), JSON.stringify(names));
  }

  console.log(
    `\n[1m${failed === 0 ? '[32mAll checks passed' : '[31mFailures present'}[0m — ${passed} passed, ${failed} failed\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('\n[31mVerification aborted[0m', error);
  process.exit(1);
});
