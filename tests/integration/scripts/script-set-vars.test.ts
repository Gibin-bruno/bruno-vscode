import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { createBruCollection, environment, findItem, getTestApi, sendRequest, type LoadedCollection } from '../helpers';
import { TEST_SERVER, ensureTestServer } from '../test-server';

/**
 * Integration port of tests/e2e/request/script/script-set-vars.spec.ts.
 *
 * The test server's /capture records the `x-token` header; /last-capture reads it back. That is the
 * ground truth for whether a script ran and its variable was interpolated into the outgoing request.
 */

const pingWithPreRequest = (header: string, ...scriptLines: string[]) => [
  'meta {', '  name: Ping', '  type: http', '  seq: 1', '}', '',
  'get {', `  url: ${TEST_SERVER}/capture`, '  body: none', '  auth: inherit', '}', '',
  'headers {', `  x-token: ${header}`, '}', '',
  'script:pre-request {', ...scriptLines.map((line) => `  ${line}`), '}', ''
].join('\n');

const lastCapturedToken = async () =>
  ((await (await fetch(`${TEST_SERVER}/last-capture`)).json()) as { token: string | null }).token;

suite('Scripting: variable APIs', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  const openedCollections: string[] = [];

  suiteSetup(async () => {
    api = await getTestApi();
    await ensureTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
  });

  teardown(async () => {
    for (const collectionPath of openedCollections.splice(0)) {
      await api.invoke('renderer:close-collection', collectionPath);
    }
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const collectionWith = async (name: string, files: Record<string, string>): Promise<LoadedCollection> => {
    const collection = await createBruCollection(api, tmpDir, name, files);
    openedCollections.push(collection.pathname);
    return collection;
  };

  test('a pre-request script (bru.setVar) runs and its variable interpolates into the outgoing request', async () => {
    const collection = await collectionWith('script-vars', {
      'Ping.bru': pingWithPreRequest('{{token}}', "bru.setVar('token', 'ABC123');")
    });

    const { response } = await sendRequest(api, collection, findItem(collection, 'Ping'));

    assert.strictEqual(response.status, 200);
    // If the script never ran, the server sees the literal '{{token}}'.
    assert.strictEqual(await lastCapturedToken(), 'ABC123');
  });

  test('bru.setEnvVar / bru.deleteEnvVar take effect and are reported for persistence', async () => {
    const collection = await collectionWith('env-script-vars', {
      'environments/Local.bru': 'vars {\n  seed: SEED\n}\n',
      'Ping.bru': pingWithPreRequest('{{envTok}}', "bru.setEnvVar('envTok', 'ENVVAL');", "bru.deleteEnvVar('seed');")
    });
    // The "Local" environment from environments/Local.bru, selected in the request's env picker.
    const local = environment('Local', { seed: 'SEED' });

    const { response, events } = await sendRequest(api, collection, findItem(collection, 'Ping'), local);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(await lastCapturedToken(), 'ENVVAL', 'setEnvVar should interpolate into the request');

    // The extension reports the resulting environment; the webview merges and writes it to
    // environments/Local.bru (`mergeAndPersistEnvironment`), which isn't covered here.
    const update = events.find(({ channel }) => channel === 'main:persistent-env-variables-update');
    const variables = (update?.args[0] as { persistentEnvVariables: Record<string, unknown> })?.persistentEnvVariables;
    assert.strictEqual(variables?.envTok, 'ENVVAL');
    assert.ok(!('seed' in (variables ?? {})), 'deleteEnvVar should remove seed');
  });
});
