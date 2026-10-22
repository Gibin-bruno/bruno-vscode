import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { collectWebviewMessages, createBruCollection, getTestApi, type LoadedCollection } from '../helpers';

/**
 * Integration port of the extension half of "keeps comments when saving from the raw view" in
 * tests/e2e/specs/dotenv-files.spec.ts.
 *
 * The raw view shows the file content the extension sends in `main:dotenv-file-update`, and saving
 * calls `renderer:save-dotenv-raw` with the editor's text. These tests check both ends keep
 * comments; whether the raw editor displays that content is webview behaviour and stays in e2e.
 */

const DOTENV = '# staging credentials\nTOKEN=abc\n';

suite('.env files', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  let collection: LoadedCollection;
  let rawContent: string | undefined;

  suiteSetup(async () => {
    api = await getTestApi();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
    const events = await collectWebviewMessages(api, async () => {
      collection = await createBruCollection(api, tmpDir, 'dotenv-raw', { '.env.local': DOTENV });
    });
    const update = events.find(({ channel, args }) =>
      channel === 'main:dotenv-file-update' && (args[0] as { filename: string }).filename === '.env.local'
    );
    rawContent = (update?.args[0] as { content?: string } | undefined)?.content;
  });

  suiteTeardown(async () => {
    await api.invoke('renderer:close-collection', collection.pathname);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the raw content sent on open includes comments', () => {
    assert.strictEqual(rawContent, DOTENV);
  });

  test('keeps comments when saving from the raw view', async () => {
    const dotEnvPath = path.join(collection.pathname, '.env.local');

    // The raw view saves the editor's text as-is.
    await api.invoke('renderer:save-dotenv-raw', collection.pathname, rawContent, '.env.local');

    const content = fs.readFileSync(dotEnvPath, 'utf8');
    assert.ok(content.includes('# staging credentials'), `comment lost:\n${content}`);
    assert.ok(content.includes('TOKEN=abc'), `value lost:\n${content}`);
  });
});
