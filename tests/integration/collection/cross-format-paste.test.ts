import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { createBruCollection, findItem, getTestApi, loadCollection } from '../helpers';
import { TEST_SERVER } from '../test-server';

/**
 * Integration port of tests/e2e/collection/moving-requests/cross-format-paste.spec.ts.
 *
 * Pasting a request across collections of different on-disk formats used to write source-format
 * content into a destination-named file, which couldn't be re-parsed and crashed the sidebar
 * (VSCODE-75). Paste calls `renderer:clone-request`; this checks what it writes, and that the
 * extension can load the result like the sidebar would.
 */

suite('Cross-format paste', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  const openedCollections: string[] = [];

  suiteSetup(async () => {
    api = await getTestApi();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
  });

  suiteTeardown(async () => {
    for (const collectionPath of openedCollections) {
      await api.invoke('renderer:close-collection', collectionPath);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('paste a request from a .bru collection into a .yml collection', async () => {
    const source = await createBruCollection(api, tmpDir, 'Bru Source', {
      'Ping.bru': [
        'meta {', '  name: Ping', '  type: http', '  seq: 1', '}', '',
        'post {', `  url: ${TEST_SERVER}/ping`, '  body: none', '  auth: none', '}', ''
      ].join('\n')
    });
    openedCollections.push(source.pathname);

    const targetPath = path.join(tmpDir, 'Yml Target');
    fs.mkdirSync(targetPath);
    fs.writeFileSync(path.join(targetPath, 'opencollection.yml'), 'opencollection: 1.0.0\n\ninfo:\n  name: Yml Target\n');
    await loadCollection(api, targetPath);
    openedCollections.push(targetPath);

    // What the sidebar's Paste sends: source file, destination file (in the destination's format), name, seq.
    const pastedPath = path.join(targetPath, 'Ping.yml');
    await api.invoke('renderer:clone-request', findItem(source, 'Ping').pathname, pastedPath, 'Ping', 1);

    // The pasted file must hold YAML (`info:`), not .bru syntax (`meta {`).
    const pastedContent = fs.readFileSync(pastedPath, 'utf8');
    assert.ok(pastedContent.includes('info:'), `expected YAML:\n${pastedContent}`);
    assert.ok(!pastedContent.includes('meta {'), `expected no .bru syntax:\n${pastedContent}`);

    // And it parses back into the same request — what the sidebar needs to render it.
    await api.invoke('renderer:close-collection', targetPath);
    const target = await loadCollection(api, targetPath);
    const pasted = findItem(target, 'Ping') as { request: { method: string; url: string } };
    assert.strictEqual(pasted.request.url, `${TEST_SERVER}/ping`);
    assert.strictEqual(pasted.request.method.toUpperCase(), 'POST');
  });
});
