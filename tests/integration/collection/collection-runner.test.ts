import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { collectWebviewMessages, createBruCollection, flattenItems, getTestApi, loadCollection, waitForWebviewMessage, type LoadedCollection } from '../helpers';
import { TEST_SERVER, ensureTestServer } from '../test-server';

/**
 * Integration port of tests/e2e/collection/runner/collection-runner.spec.ts.
 *
 * The runner UI calls `renderer:run-collection-folder` and renders the `main:run-folder-event`s that
 * follow. These tests start a run the same way and check those events: which requests ran, in what
 * order, with what status, and how long it took. The runner panel itself (request count, result
 * rows, All/Passed/Failed filters) stays in the e2e spec.
 */

type RunnerTags = { include: string[]; exclude: string[] };
type RunEvent = { type: string; itemUid?: string; responseReceived?: { status: number | string } };

suite('Collection runner', () => {
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

  /**
   * A .bru collection with one GET /ping request per entry. Requests are written through
   * `renderer:save-request` — what the webview calls when a request (or its tags) is saved — so
   * the file format, tags included, is the extension's own.
   */
  const collectionWithRequests = async (name: string, requests: { name: string; tags?: string[] }[]): Promise<LoadedCollection> => {
    let collection = await createBruCollection(api, tmpDir, name);
    openedCollections.push(collection.pathname);

    for (const [index, request] of requests.entries()) {
      const pathname = path.join(collection.pathname, `${request.name}.bru`);
      fs.writeFileSync(pathname, ''); // save-request only overwrites existing files
      await api.invoke('renderer:save-request', pathname, {
        name: request.name,
        type: 'http-request',
        seq: index + 1,
        tags: request.tags ?? [],
        settings: {},
        request: {
          method: 'GET',
          url: `${TEST_SERVER}/ping`,
          headers: [],
          params: [],
          body: { mode: 'none' },
          auth: { mode: 'none' },
          script: {},
          vars: {},
          assertions: [],
          tests: '',
          docs: ''
        }
      }, 'bru');
    }

    // Reopen so the scan picks up the new files (the watcher can miss writes made right after opening).
    await api.invoke('renderer:close-collection', collection.pathname);
    collection = await loadCollection(api, collection.pathname);
    return collection;
  };

  /**
   * Run the whole collection as the runner panel's "Run Collection" button does, and return the
   * names of the requests that got a response (in order) with their statuses, plus the run time.
   */
  const runCollection = async (collection: LoadedCollection, { delay = 0, tags = null as RunnerTags | null } = {}) => {
    const nameByUid = new Map(flattenItems(collection.items).map((item) => [item.uid as string, item.name as string]));
    const startedAt = Date.now();

    const events = await collectWebviewMessages(api, async () => {
      const ended = waitForWebviewMessage(api, 'main:run-folder-event', ([event]) =>
        (event as RunEvent).type === 'testrun-ended', 30_000
      );
      //   folder, collection, environment, runtimeVariables, recursive, delay, tags, selectedRequestUids
      await api.invoke('renderer:run-collection-folder', null, collection, null, {}, true, delay, tags, undefined);
      await ended;
    });

    const results = events
      .filter(({ channel }) => channel === 'main:run-folder-event')
      .map(({ args }) => args[0] as RunEvent)
      .filter((event) => event.type === 'response-received')
      .map((event) => ({ name: nameByUid.get(event.itemUid ?? ''), status: event.responseReceived?.status }));

    return { results, elapsedMs: Date.now() - startedAt };
  };

  test('TC-3668: Verify that the user is able to execute all the request which are under the Collection using Run @sanity', async () => {
    const collection = await collectionWithRequests('runner', [{ name: 'Ping' }]);

    const { results } = await runCollection(collection);

    assert.deepStrictEqual(results, [{ name: 'Ping', status: 200 }]);
  });

  test('TC-3667: Verify that the delay in the requests execution in the Collection run @sanity', async () => {
    const delayMs = 2000;
    const collection = await collectionWithRequests('runner-delay', [{ name: 'Ping One' }, { name: 'Ping Two' }]);

    const { results, elapsedMs } = await runCollection(collection, { delay: delayMs });

    assert.deepStrictEqual(results, [{ name: 'Ping One', status: 200 }, { name: 'Ping Two', status: 200 }]);
    // The runner pauses `delay` before each request, so two requests take at least twice that.
    assert.ok(elapsedMs >= delayMs * 2, `expected at least ${delayMs * 2}ms, took ${elapsedMs}ms`);
  }).timeout(30_000);

  test('TC-3666: Verify the Include Tags functionality under Collection Run @sanity', async () => {
    const collection = await collectionWithRequests('runner-include', [
      { name: 'Smoke Request', tags: ['smoke'] },
      { name: 'Plain Request' }
    ]);

    const { results } = await runCollection(collection, { tags: { include: ['smoke'], exclude: [] } });

    assert.deepStrictEqual(results, [{ name: 'Smoke Request', status: 200 }]);
  });

  test('TC-3665: Verify the Exclude Tags functionality under Collection Run @sanity', async () => {
    const collection = await collectionWithRequests('runner-exclude', [
      { name: 'Smoke Request', tags: ['smoke'] },
      { name: 'Plain Request' }
    ]);

    const { results } = await runCollection(collection, { tags: { include: [], exclude: ['smoke'] } });

    assert.deepStrictEqual(results, [{ name: 'Plain Request', status: 200 }]);
  });
});
