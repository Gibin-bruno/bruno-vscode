import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { createBruCollection, environment, findItem, getTestApi, scriptReport, sendRequest, type LoadedCollection } from '../helpers';
import { TEST_SERVER, ensureTestServer } from '../test-server';

/**
 * Integration port of the extension half of tests/e2e/specs/script-error.spec.ts.
 *
 * The e2e spec checks the script error *card*. What the card shows comes from the extension:
 * the send result, and the `<type>-script-execution` report (message, failing file, source lines,
 * stack). These tests check that data. Rendering, the stack toggle, closing/reopening the card and
 * jumping to the line stay in the e2e spec, as do the two folder-script cases (folders and unsaved
 * drafts aren't modelled by `loadCollection` yet).
 */

const request = (name: string, { url = `${TEST_SERVER}/capture`, extra = [] as string[] } = {}) => [
  'meta {', `  name: ${name}`, '  type: http', '  seq: 1', '}', '',
  'get {', `  url: ${url}`, '  body: none', '  auth: inherit', '}', '',
  ...extra
].join('\n');

const script = (type: 'pre-request' | 'post-response', ...lines: string[]) =>
  [`script:${type} {`, ...lines.map((line) => `  ${line}`), '}', ''];

// `bru.setEnvVar` rejects names with spaces, so the failure comes from the sandbox itself.
const INVALID_SET_ENV_VAR = 'bru.setEnvVar("Bad Name", "x");';
const UNSENT_TOKEN = 'PRE_REQUEST_SHOULD_NOT_SEND';

const lastCapturedToken = async () =>
  ((await (await fetch(`${TEST_SERVER}/last-capture`)).json()) as { token: string | null }).token;

suite('Script errors', () => {
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

  test('a failing post-response script is reported with its file, failing line and stack', async () => {
    const collection = await collectionWith('post-response-error', {
      'Boom.bru': request('Boom', { extra: script('post-response', 'const a = 1;', INVALID_SET_ENV_VAR, 'console.log(a);') })
    });

    const { response, events } = await sendRequest(api, collection, findItem(collection, 'Boom'));

    assert.strictEqual(response.status, 200, 'the request itself still succeeds');
    const report = scriptReport(events, 'post-response');
    assert.match(report?.errorMessage ?? '', /contains invalid characters/);
    assert.strictEqual(path.basename(report?.errorContext?.filePath ?? ''), 'Boom.bru');
    const errorLine = report?.errorContext?.lines?.find((line) => line.isError);
    assert.match(errorLine?.content ?? '', /bru\.setEnvVar\("Bad Name", "x"\)/);
    assert.match(report?.errorContext?.stack ?? '', /Boom\.bru/);
  });

  test('a failing pre-request script aborts the send', async () => {
    const collection = await collectionWith('pre-request-error', {
      'PreBoom.bru': request('PreBoom', {
        extra: ['headers {', `  x-token: ${UNSENT_TOKEN}`, '}', '', ...script('pre-request', INVALID_SET_ENV_VAR)]
      })
    });

    const { response, events } = await sendRequest(api, collection, findItem(collection, 'PreBoom'));

    assert.strictEqual(response.status, 'Error');
    assert.match(scriptReport(events, 'pre-request')?.errorMessage ?? '', /contains invalid characters/);
    assert.notStrictEqual(await lastCapturedToken(), UNSENT_TOKEN, 'the request must not reach the server');
  });

  test('variables written before a script throws are still applied', async () => {
    const collection = await collectionWith('partial-script-writes', {
      'environments/Local.bru': 'vars {\n  seed: SEED\n}\n',
      'Boom.bru': request('Boom', { extra: script('post-response', "bru.setEnvVar('envTok', 'ENVVAL');", "bru.setEnvVar('Bad Name', 'x');") })
    });
    // The "Local" environment from environments/Local.bru, selected in the request's env picker.
    const local = environment('Local', { seed: 'SEED' });

    const { events } = await sendRequest(api, collection, findItem(collection, 'Boom'), local);

    assert.ok(scriptReport(events, 'post-response')?.errorMessage, 'the script should have failed');
    // The extension reports the new value for the webview to persist (`mergeAndPersistEnvironment`).
    const update = events.find(({ channel }) => channel === 'main:persistent-env-variables-update');
    assert.strictEqual((update?.args[0] as { persistentEnvVariables: Record<string, unknown> })?.persistentEnvVariables?.envTok, 'ENVVAL');
  });

  test('a failing collection-level script is attributed to the collection, not the request', async () => {
    const collection = await collectionWith('collection-script-error', {
      'collection.bru': script('post-response', 'const fromCollection = 1;', "throw new Error('boom from collection');").join('\n'),
      // No request-level script, so this only resolves if a segment is recorded for the collection.
      'Boom.bru': request('Boom')
    });

    const { events } = await sendRequest(api, collection, findItem(collection, 'Boom'));

    const report = scriptReport(events, 'post-response');
    assert.strictEqual(path.basename(report?.errorContext?.filePath ?? ''), 'collection.bru');
    const errorLine = report?.errorContext?.lines?.find((line) => line.isError);
    assert.match(errorLine?.content ?? '', /throw new Error\('boom from collection'\)/);
  });

  test('an empty url with no script at all reports the url', async () => {
    const collection = await collectionWith('empty-url', { 'NoUrl.bru': request('NoUrl', { url: '' }) });

    const { response, events } = await sendRequest(api, collection, findItem(collection, 'NoUrl'));

    assert.match(String(response.error ?? ''), /URL/);
    assert.ok(!scriptReport(events, 'pre-request')?.errorMessage, 'no script error should be reported');
  });

  test('a failing pre-request script wins over a host that would not resolve', async () => {
    const collection = await collectionWith('bad-host', {
      'BadHost.bru': request('BadHost', { url: 'http://does-not-exist-bruno-test.invalid/x', extra: script('pre-request', INVALID_SET_ENV_VAR) })
    });

    const { response, events } = await sendRequest(api, collection, findItem(collection, 'BadHost'));

    assert.strictEqual(response.status, 'Error');
    assert.match(scriptReport(events, 'pre-request')?.errorMessage ?? '', /contains invalid characters/);
    assert.doesNotMatch(String(response.error ?? ''), /ENOTFOUND|getaddrinfo/);
  });

  test('a failing pre-request script wins over an empty url', async () => {
    const collection = await collectionWith('empty-url-script', {
      'NoUrl.bru': request('NoUrl', { url: '', extra: script('pre-request', INVALID_SET_ENV_VAR) })
    });

    const { response, events } = await sendRequest(api, collection, findItem(collection, 'NoUrl'));

    assert.strictEqual(response.status, 'Error');
    assert.match(scriptReport(events, 'pre-request')?.errorMessage ?? '', /contains invalid characters/);
    assert.doesNotMatch(String(response.error ?? ''), /URL/);
  });
});
