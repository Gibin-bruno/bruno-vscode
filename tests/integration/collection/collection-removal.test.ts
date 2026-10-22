import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { collectWebviewMessages, getTestApi, type WebviewMessage } from '../helpers';

/**
 * Integration port of the first two tests in tests/e2e/collection/delete/collection-removal.spec.ts.
 *
 * The sidebar lists the collections in the workspace config the extension broadcasts
 * (`main:workspace-config-updated`). These tests create and remove collections through the same
 * IPC calls as the Create Collection panel and the "Remove" menu item, and check that list.
 * ("Deleted folder disappears from the sidebar" is a sidebar check and stays in the e2e spec.)
 */

type WorkspaceCollection = { name: string; path: string };

/** The collections in the last workspace config broadcast among `events`. */
const lastWorkspaceCollections = (events: WebviewMessage[]): WorkspaceCollection[] => {
  const updates = events.filter(({ channel }) => channel === 'main:workspace-config-updated');
  assert.ok(updates.length, 'expected a workspace config update');
  return (updates[updates.length - 1].args[2] as { collections: WorkspaceCollection[] }).collections;
};

suite('Collection removal', () => {
  let api: BrunoTestApi;
  let tmpDir: string;

  suiteSetup(async () => {
    api = await getTestApi();
    // The sidebar asks for this on startup, which creates the default workspace if there is none.
    // Without it, created collections have no workspace to be listed in.
    await api.invoke('sidebar:get-workspace-summary');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** What the Create Collection panel sends. Returns the events, including the workspace update. */
  const createCollection = (name: string, location: string) =>
    collectWebviewMessages(api, () => api.invoke('renderer:create-collection', name, name, location, { format: 'yml' }));

  /** What the "Remove" menu item sends (after the user confirms). */
  const removeCollection = (name: string, location: string) =>
    collectWebviewMessages(api, () => api.invoke('renderer:remove-collection', path.join(location, name), '', 'default'));

  const named = (collections: WorkspaceCollection[], name: string) => collections.filter((collection) => collection.name === name);

  test('TC-3645: Verify that Removing the collection from the sidebar and does not reappear when creating a new collection @sanity', async () => {
    await createCollection('Collection A', tmpDir);

    const afterRemove = await removeCollection('Collection A', tmpDir);
    assert.deepStrictEqual(named(lastWorkspaceCollections(afterRemove), 'Collection A'), [], 'A should be removed');

    const afterCreateB = await createCollection('Collection B', tmpDir);
    const collections = lastWorkspaceCollections(afterCreateB);
    assert.strictEqual(named(collections, 'Collection B').length, 1, 'B should be listed once');
    assert.deepStrictEqual(named(collections, 'Collection A'), [], 'A should still be gone');
    assert.ok(
      !afterCreateB.some(({ channel, args }) => channel === 'main:collection-opened' && String(args[0]).endsWith('/Collection A')),
      'A should not be reopened'
    );

    await removeCollection('Collection B', tmpDir);
  });

  test('Removing and recreating a collection with the same name works', async () => {
    // Recreate in a different folder to avoid a filesystem conflict, like the e2e spec.
    const round1 = path.join(tmpDir, 'round1');
    const round2 = path.join(tmpDir, 'round2');
    fs.mkdirSync(round1);
    fs.mkdirSync(round2);

    await createCollection('Ephemeral Collection', round1);
    await removeCollection('Ephemeral Collection', round1);
    const collections = lastWorkspaceCollections(await createCollection('Ephemeral Collection', round2));

    // Exactly one entry, pointing at the new location.
    const entries = named(collections, 'Ephemeral Collection');
    assert.strictEqual(entries.length, 1, `expected one entry, got ${JSON.stringify(entries)}`);
    assert.strictEqual(path.resolve(entries[0].path), path.join(round2, 'Ephemeral Collection'));

    await removeCollection('Ephemeral Collection', round2);
  });
});
