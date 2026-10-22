import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { createBruCollection, getTestApi, sendRequest, type LoadedCollection } from '../helpers';
import { TEST_SERVER, ensureTestServer } from '../test-server';

/**
 * Integration port of the extension half of tests/e2e/response/timeline.spec.ts.
 *
 * The timeline's network logs and a failed request's status come back in the `send-http-request`
 * result. These tests check that data. The timeline UI — expanding entries, clearing the timeline,
 * clearing the response, folding a JSON body — stays in the e2e spec.
 */

// VS Code's proxy agent exempts `localhost` and `127.0.0.1`, so only another spelling exercises the
// substituted path. Not every runner has IPv6.
const ipv6LoopbackReachable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '::1', port });
    const settle = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(2_000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });

const getRequest = (url: string) => ({
  uid: 'timeline-request',
  name: 'Ping',
  type: 'http-request',
  request: { method: 'GET', url, headers: [], params: [], body: { mode: 'none' }, auth: { mode: 'none' } }
});

suite('Response timeline', () => {
  let api: BrunoTestApi;
  let tmpDir: string;
  let collection: LoadedCollection;

  suiteSetup(async () => {
    api = await getTestApi();
    await ensureTestServer();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-integration-'));
    collection = await createBruCollection(api, tmpDir, 'timeline');
  });

  suiteTeardown(async () => {
    await api.invoke('renderer:close-collection', collection.pathname);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Send a GET and return the response, with its timeline flattened to text for matching. */
  const send = async (url: string) => {
    const item = getRequest(url);
    const { response } = await sendRequest(api, { ...collection, items: [item] }, item);
    return { response, logs: JSON.stringify(response.timeline ?? []) };
  };

  test('network logs carry the same detail as the desktop app', async () => {
    // `localhost` rather than TEST_SERVER's 127.0.0.1: earlier suites in this VS Code already hold a
    // keep-alive connection to 127.0.0.1:8081, and a reused socket logs no Trying/Connected lines
    // (connection-log.ts skips sockets that are already connected). This host is only used here.
    const url = 'http://localhost:8081/ping';
    const { response, logs } = await send(url);

    assert.strictEqual(response.status, 200);
    for (const expected of [
      `Preparing request to ${url}`,
      'User-Agent: bruno-runtime',
      'HTTP/1.1 200 OK',
      'content-type: text/html'
    ]) {
      assert.ok(logs.includes(expected), `network logs should contain "${expected}":\n${logs}`);
    }
    assert.match(logs, /Trying localhost:8081/);
    assert.match(logs, /Connected to localhost \((127\.0\.0\.1|::1)\)/);
    assert.match(logs, /Request completed in \d+ ms/);
  });

  test('network logs report the connection for a host VS Code proxies', async function () {
    if (!(await ipv6LoopbackReachable(8081))) {
      this.skip(); // IPv6 loopback unavailable
    }

    const { response, logs } = await send('http://[::1]:8081/ping');

    assert.strictEqual(response.status, 200);
    assert.match(logs, /Trying ::1:8081/);
    assert.match(logs, /Connected to ::1/);
  });

  test('network logs show the body of an error response as text', async () => {
    const { response, logs } = await send(`${TEST_SERVER}/no-such-route`);

    assert.strictEqual(response.status, 404);
    assert.ok(logs.includes('HTTP/1.1 404 Not Found'), `missing 404 status line:\n${logs}`);
    // A base64 blob here would mean the body was logged encoded.
    assert.ok(logs.includes('Cannot GET /no-such-route'), `error body should be logged as text:\n${logs}`);
  });

  test('a failed request reports the axios error code as its status', async () => {
    // Malformed scheme: fails inside axios before any response. Loopback host so a change in
    // axios' URL parsing can never send this to the public internet.
    const { response } = await send('gethttps://127.0.0.1:8081/sample.mp4');

    // The timeline shows statusText for failed requests — the code, not the raw axios message.
    assert.strictEqual(response.statusText, 'ERR_BAD_REQUEST');
  });
});
