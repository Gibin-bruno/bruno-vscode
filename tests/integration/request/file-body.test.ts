import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { createBruCollection, getTestApi, sendRequest, type LoadedCollection } from '../helpers';
import { TEST_SERVER, ensureTestServer } from '../test-server';

/**
 * Integration port of tests/e2e/request/body/file-body.spec.ts.
 *
 * The test server's POST /raw-body records the body and content type exactly as received;
 * GET /get-raw-body reads them back. Picking the file and inferring its content type from the
 * extension (`mime.contentType` in the webview's `updateFile` reducer) is webview logic, so the
 * item here carries the content type the reducer would have set.
 */

const FILE_CONTENT = 'first line\nsecond line\n';

const fileBodyRequest = (filePath: string, contentType: string) => ({
  uid: 'file-body-request',
  name: 'Upload File',
  type: 'http-request',
  request: {
    method: 'POST',
    url: `${TEST_SERVER}/raw-body`,
    headers: [],
    params: [],
    auth: { mode: 'none' },
    body: { mode: 'file', file: [{ uid: 'file-1', filePath, contentType, selected: true }] }
  }
});

const lastRawBody = async () =>
  (await (await fetch(`${TEST_SERVER}/get-raw-body`)).json()) as { contentType: string | null; body: string };

suite('Request body: File / Binary', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  let collection: LoadedCollection;
  let payloadPath: string;

  suiteSetup(async () => {
    api = await getTestApi();
    await ensureTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
    collection = await createBruCollection(api, tmpDir, 'file-body');
    // Outside the collection directory, like a file picked from ~/Downloads — stored as an absolute path.
    payloadPath = path.join(tmpDir, 'payload.txt');
    fs.writeFileSync(payloadPath, FILE_CONTENT);
  });

  suiteTeardown(async () => {
    await api.invoke('renderer:close-collection', collection.pathname);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const send = async (contentType: string) => {
    const item = fileBodyRequest(payloadPath, contentType);
    return (await sendRequest(api, { ...collection, items: [item] }, item)).response;
  };

  test('the picked file is uploaded as the raw request body', async () => {
    // What the webview sets for a .txt file.
    const response = await send('text/plain; charset=utf-8');

    assert.strictEqual(response.status, 200);
    const sent = await lastRawBody();
    assert.strictEqual(sent.body, FILE_CONTENT);
    assert.strictEqual(sent.contentType, 'text/plain; charset=utf-8');
  });

  test('without a content type the file is sent as application/octet-stream', async () => {
    const response = await send('');

    assert.strictEqual(response.status, 200);
    const sent = await lastRawBody();
    assert.strictEqual(sent.body, FILE_CONTENT);
    // DEFAULT_FILE_BODY_CONTENT_TYPE in src/extension/utils/file-body.ts
    assert.strictEqual(sent.contentType, 'application/octet-stream');
  });
});
