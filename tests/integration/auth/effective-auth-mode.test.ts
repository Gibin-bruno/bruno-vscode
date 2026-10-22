import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { findItem, getTestApi, loadCollection, sendRequest, type LoadedCollection } from '../helpers';
import { TEST_SERVER, ensureTestServer } from '../test-server';

/**
 * Integration port of tests/e2e/auth/auth-mode/effective-auth-mode/effective-auth-mode.spec.ts.
 *
 * The fixture collection is folder-1 > folder-2 > folder-3, with protected-request in folder-1.
 * Auth modes are set on the collection/folder roots in memory, as the settings panels hold them
 * before saving (the extension resolves `inherit` from those roots when sending — `mergeAuth`).
 *
 * The e2e spec sends to an external Basic Auth endpoint and reads the timeline; here the request
 * goes to the local /api/echo/auth, which returns the Authorization header it received, so each
 * check sees exactly which credentials (if any) were sent. The "Auth inherited from …" labels are
 * computed by the webview and stay in the e2e spec.
 */

const FIXTURE = path.resolve(__dirname, '../../e2e/auth/auth-mode/effective-auth-mode/fixtures/collection');
const ECHO_AUTH = `${TEST_SERVER}/api/echo/auth`;

const basic = (username: string, password: string) => ({ mode: 'basic', basic: { username, password } });
const basicHeader = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

type Root = { request?: { auth?: unknown } };

suite('Effective auth mode resolution', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  let collection: LoadedCollection;

  suiteSetup(async () => {
    api = await getTestApi();
    await ensureTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
    const collectionPath = path.join(tmpDir, 'effective-auth-mode-collection');
    fs.cpSync(FIXTURE, collectionPath, { recursive: true });
    collection = await loadCollection(api, collectionPath);
  });

  suiteTeardown(async () => {
    await api.invoke('renderer:close-collection', collection.pathname);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const setAuth = (root: Root, auth: unknown) => {
    root.request = { ...root.request, auth };
  };
  const folderRoot = (name: string) => findItem(collection, name).root as Root;

  /** Send `item` with `auth: inherit` to the echo endpoint; return the Authorization header received. */
  const sentAuthorization = async (item: Record<string, unknown>) => {
    const request = { ...(item.request as Record<string, unknown>), url: ECHO_AUTH, auth: { mode: 'inherit' } };
    const { response } = await sendRequest(api, collection, { ...item, request });
    assert.strictEqual(response.status, 200);
    return (response.data as { authorization: string }).authorization;
  };

  test('Inherit resolves to the nearest parent, stops at a No Auth folder, and sends no Authorization header', async () => {
    // Collection: Basic Auth (bruno / della). folder-2: Basic Auth with its own credentials, so the
    // header shows which level a request inherited from. folder-3: Inherit.
    setAuth(collection.root as Root, basic('bruno', 'della'));
    setAuth(folderRoot('folder-2'), basic('folder-2-user', 'folder-2-pass'));
    setAuth(folderRoot('folder-3'), { mode: 'inherit' });

    // A request in folder-3 inherits from folder-2 (the nearest parent with auth), not the collection.
    const folder3 = findItem(collection, 'folder-3') as { items: Record<string, unknown>[] };
    const inFolder3 = { ...findItem(collection, 'protected-request'), uid: 'request-in-folder-3', name: 'request-in-folder-3' };
    folder3.items.push(inFolder3);
    assert.strictEqual(await sentAuthorization(inFolder3), basicHeader('folder-2-user', 'folder-2-pass'));

    // folder-1 = No Auth: protected-request (in folder-1) inherits No Auth and sends no header.
    setAuth(folderRoot('folder-1'), { mode: 'none' });
    assert.strictEqual(await sentAuthorization(findItem(collection, 'protected-request')), '');

    // folder-1 = Inherit: protected-request now inherits the collection's Basic Auth.
    setAuth(folderRoot('folder-1'), { mode: 'inherit' });
    assert.strictEqual(await sentAuthorization(findItem(collection, 'protected-request')), basicHeader('bruno', 'della'));
  });
});
