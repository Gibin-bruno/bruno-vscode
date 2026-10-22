import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { getTestApi, waitForWebviewMessage } from '../helpers';

/**
 * Integration port of the extension half of tests/e2e/collection/settings/collection-settings-save.spec.ts.
 *
 * Saving collection settings writes two things: the collection *root* (headers/auth/vars/scripts)
 * and the *bruno config* (presets/proxy/protobuf). The webview's `saveCollectionSettings` thunk
 * decides which IPC calls to make:
 *   - yml: one `renderer:save-collection-root` carrying both, since both live in opencollection.yml
 *   - bru: `renderer:save-collection-root` (collection.bru) + `renderer:update-bruno-config` (bruno.json)
 *
 * These tests make exactly those calls and check what the extension writes to disk and reads back.
 * Which calls get made is webview logic and is not covered here — see the note at the bottom.
 */

const HEADER_NAME = 'x-integration';
const HEADER_VALUE = 'integration-value';
const PRESET_URL = 'http://127.0.0.1:8081/preset';

const fixturesDir = path.resolve(__dirname, '../../e2e/collection/open/fixtures');

type BrunoConfig = Record<string, unknown> & { presets?: { requestType?: string; requestUrl?: string } };
type CollectionFile = { meta: { pathname: string }; data: { request?: { headers?: { name: string; value: string }[] } } };

// The collection root as the webview's `transformCollectionRootToSave` builds it, with one header added.
const rootWithHeader = () => ({
  request: {
    headers: [{ uid: 'header-1', name: HEADER_NAME, value: HEADER_VALUE, enabled: true }]
  }
});

const withPreset = (brunoConfig: BrunoConfig): BrunoConfig => ({
  ...brunoConfig,
  presets: { requestType: 'http', requestUrl: PRESET_URL }
});

suite('Collection settings save', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  let collectionPath: string | undefined;

  // Copy a fixture, open it like the sidebar does, and return the bruno config the extension
  // loaded — the same value the webview would hold in its store.
  const openFixture = async (fixtureName: string) => {
    collectionPath = path.join(tmpDir, fixtureName);
    fs.cpSync(path.join(fixturesDir, fixtureName), collectionPath, { recursive: true });

    const opened = waitForWebviewMessage(api, 'main:collection-opened', ([pathname]) => pathname === collectionPath);
    await api.invoke('renderer:open-collection-by-path', [collectionPath]);
    const [, , brunoConfig] = await opened;
    return { collectionPath, brunoConfig: brunoConfig as BrunoConfig };
  };

  // Close and reopen the collection, returning the root and bruno config the extension parses
  // from disk on open — what the settings UI would show. Reopening (rather than waiting for the
  // file watcher) is deterministic: VS Code's watcher takes a moment to start after a collection
  // opens, so a write straight after opening can be missed by it.
  const reopenAndReadBack = async (collectionPath: string, rootFile: string) => {
    await api.invoke('renderer:close-collection', collectionPath);

    const rootParsed = waitForWebviewMessage(api, 'main:collection-tree-updated', ([action, file]) =>
      action === 'addFile' && (file as CollectionFile)?.meta?.pathname === rootFile
    );
    const opened = waitForWebviewMessage(api, 'main:collection-opened', ([pathname]) => pathname === collectionPath);
    await api.invoke('renderer:open-collection-by-path', [collectionPath]);

    const [, file] = await rootParsed;
    const [, , brunoConfig] = await opened;
    return { root: (file as CollectionFile).data, brunoConfig: brunoConfig as BrunoConfig };
  };

  suiteSetup(async () => {
    api = await getTestApi();
    // Deleted once at the end — see open-collection.test.ts for why not per test.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
  });

  setup(() => {
    collectionPath = undefined;
  });

  teardown(async () => {
    if (collectionPath) {
      await api.invoke('renderer:close-collection', collectionPath);
    }
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('yml: root and config both persist to opencollection.yml from a single save-collection-root', async () => {
    const { collectionPath, brunoConfig } = await openFixture('yml-with-version');
    const configFile = path.join(collectionPath, 'opencollection.yml');

    // What the webview sends for a yml collection: one call carrying root *and* config.
    await api.invoke('renderer:save-collection-root', collectionPath, rootWithHeader(), withPreset(brunoConfig));

    // both halves land in opencollection.yml
    const content = fs.readFileSync(configFile, 'utf8');
    assert.ok(content.includes(`url: ${PRESET_URL}`), `preset url missing from opencollection.yml:\n${content}`);
    assert.ok(content.includes(`name: ${HEADER_NAME}`), `header name missing from opencollection.yml:\n${content}`);
    assert.ok(content.includes(`value: ${HEADER_VALUE}`), `header value missing from opencollection.yml:\n${content}`);

    // both edits read back from disk — this is what the settings UI renders from
    const { root, brunoConfig: savedConfig } = await reopenAndReadBack(collectionPath, configFile);
    assert.deepStrictEqual(
      root.request?.headers?.map(({ name, value }) => ({ name, value })),
      [{ name: HEADER_NAME, value: HEADER_VALUE }]
    );
    assert.strictEqual(savedConfig.presets?.requestUrl, PRESET_URL);
  });

  test('bru: root goes to collection.bru and config goes to bruno.json', async () => {
    const { collectionPath, brunoConfig } = await openFixture('bru-with-version');
    const collectionBru = path.join(collectionPath, 'collection.bru');
    const brunoJson = path.join(collectionPath, 'bruno.json');

    // What the webview sends for a bru collection: two calls, one per file.
    await api.invoke('renderer:save-collection-root', collectionPath, rootWithHeader(), brunoConfig);
    await api.invoke('renderer:update-bruno-config', withPreset(brunoConfig), collectionPath, rootWithHeader());

    const bru = fs.readFileSync(collectionBru, 'utf8');
    assert.ok(bru.includes(`${HEADER_NAME}: ${HEADER_VALUE}`), `header missing from collection.bru:\n${bru}`);
    const json = fs.readFileSync(brunoJson, 'utf8');
    assert.ok(json.includes(PRESET_URL), `preset url missing from bruno.json:\n${json}`);

    // both edits read back from disk — this is what the settings UI renders from
    const { root, brunoConfig: savedConfig } = await reopenAndReadBack(collectionPath, collectionBru);
    assert.deepStrictEqual(
      root.request?.headers?.map(({ name, value }) => ({ name, value })),
      [{ name: HEADER_NAME, value: HEADER_VALUE }]
    );
    assert.strictEqual(savedConfig.presets?.requestUrl, PRESET_URL);
  });
});

/*
 * Not covered here: "a yml save is a single IPC call" (the e2e spec's `countIpcCalls` checks).
 * That is decided by the webview's `saveCollectionSettings` thunk
 * (src/webview/providers/ReduxStore/slices/collections/actions.tsx), which never runs in the
 * extension host. It belongs in a unit test of that thunk with a mocked `window.ipcRenderer`.
 */
