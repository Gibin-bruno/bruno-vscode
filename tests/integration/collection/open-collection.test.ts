import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { collectWebviewMessages, getTestApi } from '../helpers';

/**
 * Integration port of tests/e2e/collection/open/open-collection.spec.ts.
 *
 * Runs inside VS Code's extension host, next to the Bruno extension, and talks to it the way the
 * sidebar webview does: it invokes `renderer:open-collection-by-path` and watches for the
 * `main:collection-opened` event the extension sends back. No UI, no dialogs.
 */

const fixturesDir = path.resolve(__dirname, '../../e2e/collection/open/fixtures');

// Copy a fixture folder into a temp dir so the collection watcher never touches the checked-in files.
const copyFixture = (fixtureName: string, tmpDir: string): string => {
  const target = path.join(tmpDir, fixtureName);
  fs.cpSync(path.join(fixturesDir, fixtureName), target, { recursive: true });
  return target;
};

// Open a collection and report whether the extension announced it to the webviews.
const openCollection = async (api: BrunoTestApi, collectionPath: string): Promise<boolean> => {
  const messages = await collectWebviewMessages(api, () =>
    api.invoke('renderer:open-collection-by-path', [collectionPath])
  );
  return messages.some(({ channel, args }) => channel === 'main:collection-opened' && args[0] === collectionPath);
};

suite('Open collection', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  let collectionPath: string | undefined;

  suiteSetup(async () => {
    api = await getTestApi();
    // One temp dir for the whole suite, deleted at the end: deleting a collection's folder right
    // after a test races with the watcher's background scan and logs parse errors.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
  });

  setup(() => {
    collectionPath = undefined;
  });

  // Close what the test opened, so the next test starts with no collections open.
  teardown(async () => {
    if (collectionPath) {
      await api.invoke('renderer:close-collection', collectionPath);
    }
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const cases = [
    { title: 'bruno.json with version "1"', fixture: 'bru-with-version' },
    { title: 'bruno.json without version', fixture: 'bru-without-version' },
    { title: 'bruno.json with a version other than "1"', fixture: 'bru-version-2' },
    { title: 'opencollection.yml with version', fixture: 'yml-with-version' },
    { title: 'opencollection.yml without version', fixture: 'yml-without-version' }
  ];

  for (const { title, fixture } of cases) {
    test(`Verify user can open a collection with ${title}`, async () => {
      collectionPath = copyFixture(fixture, tmpDir);

      assert.strictEqual(await openCollection(api, collectionPath), true);
    });
  }

  test('Verify a collection with an invalid bruno.json is rejected', async () => {
    collectionPath = copyFixture('bru-invalid-config', tmpDir);

    assert.strictEqual(await openCollection(api, collectionPath), false);
  });
});
