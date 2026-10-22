import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { createBruCollection, getTestApi, sendRequest, type LoadedCollection } from '../helpers';
import { TEST_SERVER, ensureTestServer } from '../test-server';

/**
 * Integration port of the request half of tests/e2e/collection/create/collection.spec.ts
 * ("Create a collection, send a request to echo.usebruno.com, and verify the response").
 *
 * The e2e test posts to the public echo.usebruno.com; this one posts the same JSON body to the
 * local test server's /api/echo/json, so it doesn't depend on the network. Creating the collection
 * and request through the UI stays in the e2e spec.
 */

suite('Send a JSON request', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  let collection: LoadedCollection;

  suiteSetup(async () => {
    api = await getTestApi();
    await ensureTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
    collection = await createBruCollection(api, tmpDir, 'echo-test');
  });

  suiteTeardown(async () => {
    await api.invoke('renderer:close-collection', collection.pathname);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a POST with a JSON body gets 200 and the echoed body @regression', async () => {
    const item = {
      uid: 'ping-echo',
      name: 'Ping Echo',
      type: 'http-request',
      request: {
        method: 'POST',
        url: `${TEST_SERVER}/api/echo/json`,
        headers: [],
        params: [],
        auth: { mode: 'none' },
        body: { mode: 'json', json: '{"foo":"bar"}' }
      }
    };

    const { response } = await sendRequest(api, { ...collection, items: [item] }, item);

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.data, { foo: 'bar' });
  });
});
