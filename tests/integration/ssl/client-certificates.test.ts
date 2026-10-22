import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrunoTestApi } from '../../../src/extension/test-api';
import { getTestApi, loadCollection, waitForWebviewMessage, type LoadedCollection } from '../helpers';
import { ensureTestServer } from '../test-server';
import {
  CLIENT_CERT,
  CLIENT_KEY,
  CLIENT_PFX,
  CLIENT_SUBJECT_CN,
  GRPC_HANDSHAKE_FAILURE,
  MTLS_GRPC_URL,
  MTLS_URL,
  MTLS_WS_URL,
  PFX_PASSPHRASE,
  TLS_HANDSHAKE_FAILURE,
  UNTRUSTED_CLIENT_CERT,
  UNTRUSTED_CLIENT_KEY
} from '../../e2e/ssl/client-certificate/server/mtls-certs';
import { GRPC_PROTO_PATH } from '../../e2e/server/grpc';

/**
 * Integration port of tests/e2e/ssl/client-certificate/*.spec.ts (https, wss, grpcs, untrusted).
 *
 * Every endpoint of the mTLS server requires a client certificate signed by the test CA. Each test
 * opens a collection whose config lists the certificate (saved the way the Client Certificates tab
 * saves it), then sends the request exactly as the webview does and checks what the server reported.
 */

type ClientCert =
  | { type: 'cert'; certFilePath: string; keyFilePath: string }
  | { type: 'pfx'; pfxFilePath: string; passphrase: string };

const PEM: ClientCert = { type: 'cert', certFilePath: CLIENT_CERT, keyFilePath: CLIENT_KEY };
const PFX: ClientCert = { type: 'pfx', pfxFilePath: CLIENT_PFX, passphrase: PFX_PASSPHRASE };
const UNTRUSTED_PEM: ClientCert = { type: 'cert', certFilePath: UNTRUSTED_CLIENT_CERT, keyFilePath: UNTRUSTED_CLIENT_KEY };

// The request items as the webview's store holds them when sending (see `newHttpRequest`,
// `newWsRequest`, `newGrpcRequest` in src/webview/.../collections/actions.tsx).
const httpItem = (url: string) => ({
  uid: 'https-request',
  name: 'https-request',
  type: 'http-request',
  request: { method: 'GET', url, headers: [], params: [], body: { mode: 'none' }, auth: { mode: 'none' } }
});

const wsItem = (url: string) => ({
  uid: 'wss-request',
  name: 'wss-request',
  type: 'ws-request',
  request: { url, headers: [], params: [], body: { mode: 'ws', ws: [] }, auth: { mode: 'none' } },
  settings: {}
});

const grpcItem = (url: string, method: { path: string; type: string }) => ({
  uid: 'grpc-request',
  name: 'grpc-request',
  type: 'grpc-request',
  request: {
    url,
    method: method.path,
    methodType: method.type,
    protoPath: GRPC_PROTO_PATH,
    headers: [],
    body: { mode: 'grpc', grpc: [{ name: 'message 1', content: '{"message":"hi"}' }] },
    auth: { mode: 'none' }
  }
});

suite('Collection client certificates', () => {
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
   * Create a yml collection and, if given, add `cert` for localhost the way the Client Certificates
   * tab saves it (`renderer:save-collection-root` with the updated config). Then reopen it so the
   * extension loads the config from disk, as it would for a collection a user opens.
   *
   * yml, like the e2e spec: for a .bru collection the extension never loads bruno.json on open
   * (its initial scan only lists *.bru files), so client certs configured on disk are ignored.
   */
  const collectionWith = async (name: string, cert?: ClientCert): Promise<LoadedCollection> => {
    const collectionPath = path.join(tmpDir, name);
    fs.mkdirSync(collectionPath);
    fs.writeFileSync(path.join(collectionPath, 'opencollection.yml'), `opencollection: 1.0.0\n\ninfo:\n  name: ${name}\n`);

    let collection = await loadCollection(api, collectionPath);
    if (cert) {
      const brunoConfig = { ...collection.brunoConfig, clientCertificates: { enabled: true, certs: [{ domain: 'localhost', ...cert }] } };
      await api.invoke('renderer:save-collection-root', collectionPath, collection.root, brunoConfig);
      await api.invoke('renderer:close-collection', collectionPath);
      collection = await loadCollection(api, collectionPath);
    }
    openedCollections.push(collectionPath);
    return collection;
  };

  /** Send an HTTP request as the webview does (`send-http-request`) and return the response. */
  const sendHttp = (collection: LoadedCollection) => {
    const item = httpItem(MTLS_URL);
    return api.invoke<{ status: number; data: unknown; error?: string }>(
      'send-http-request', item, { ...collection, items: [item] }, null, {}
    );
  };

  /** Connect a WebSocket as the webview's Connect button does; resolve with the first message or error. */
  const connectWs = async (collection: LoadedCollection) => {
    const item = wsItem(MTLS_WS_URL);
    const isOurs = ([requestId]: unknown[]) => requestId === item.uid;
    const outcome = Promise.race([
      waitForWebviewMessage(api, 'main:ws:message', isOurs).then((args) => ({ message: JSON.stringify(args) })),
      waitForWebviewMessage(api, 'main:ws:error', isOurs).then((args) => ({ error: JSON.stringify(args) }))
    ]);
    await api.invoke('renderer:ws:start-connection', {
      request: item,
      collection: { ...collection, items: [item] },
      environment: null,
      runtimeVariables: {},
      settings: item.settings,
      options: { connectOnly: true }
    });
    try {
      return await outcome;
    } finally {
      await api.invoke('renderer:ws:close-connection', item.uid);
    }
  };

  /** Load echo.proto and invoke Echo as the webview does; resolve with the response or error. */
  const callGrpcEcho = async (collection: LoadedCollection) => {
    const loaded = await api.invoke<{ methods?: { path: string; type: string }[] }>(
      'grpc:load-methods-proto', { filePath: GRPC_PROTO_PATH, includeDirs: [] }
    );
    const echo = loaded.methods?.find((method) => method.path.endsWith('/Echo'));
    assert.ok(echo, `Echo not found in echo.proto: ${JSON.stringify(loaded)}`);

    const item = grpcItem(MTLS_GRPC_URL, echo);
    const isOurs = ([requestId]: unknown[]) => requestId === item.uid;
    // A failed call can arrive either as `grpc:error` or as a `grpc:response` carrying an `error`.
    const outcome = Promise.race([
      waitForWebviewMessage(api, 'grpc:response', isOurs).then((args) =>
        (args[2] as { error?: unknown })?.error ? { error: JSON.stringify(args) } : { message: JSON.stringify(args) }
      ),
      waitForWebviewMessage(api, 'grpc:error', isOurs).then((args) => ({ error: JSON.stringify(args) }))
    ]);
    await api.invoke('grpc:start-connection', {
      request: item,
      collection: { ...collection, items: [item] },
      environment: null,
      runtimeVariables: {}
    });
    return outcome;
  };

  suite('https', () => {
    test('without a certificate the server rejects the request', async () => {
      const response = await sendHttp(await collectionWith('https-no-cert'));

      assert.strictEqual(response.status, 0);
      assert.match(response.error ?? '', TLS_HANDSHAKE_FAILURE);
    });

    test('a PEM cert/key is attached on https', async () => {
      const response = await sendHttp(await collectionWith('https-pem', PEM));

      assert.strictEqual(response.status, 200);
      assert.match(JSON.stringify(response.data), new RegExp(CLIENT_SUBJECT_CN));
    });

    test('a PFX bundle is attached on https', async () => {
      const response = await sendHttp(await collectionWith('https-pfx', PFX));

      assert.strictEqual(response.status, 200);
      assert.match(JSON.stringify(response.data), new RegExp(CLIENT_SUBJECT_CN));
    });

    test('an untrusted PEM cert/key is rejected at the handshake', async () => {
      const response = await sendHttp(await collectionWith('https-untrusted', UNTRUSTED_PEM));

      assert.strictEqual(response.status, 0);
      assert.match(response.error ?? '', TLS_HANDSHAKE_FAILURE);
    });
  });

  suite('wss', () => {
    test('without a certificate the server rejects the connection', async () => {
      const outcome = await connectWs(await collectionWith('wss-no-cert'));

      assert.ok('error' in outcome, `expected an error, got ${JSON.stringify(outcome)}`);
      assert.match(outcome.error, TLS_HANDSHAKE_FAILURE);
    });

    test('a PEM cert/key is attached on wss', async () => {
      const outcome = await connectWs(await collectionWith('wss-pem', PEM));

      assert.ok('message' in outcome, `expected a message, got ${JSON.stringify(outcome)}`);
      assert.match(outcome.message, new RegExp(CLIENT_SUBJECT_CN));
    });

    test('a PFX bundle is attached on wss', async () => {
      const outcome = await connectWs(await collectionWith('wss-pfx', PFX));

      assert.ok('message' in outcome, `expected a message, got ${JSON.stringify(outcome)}`);
      assert.match(outcome.message, new RegExp(CLIENT_SUBJECT_CN));
    });
  });

  suite('grpcs', () => {
    test('without a certificate the server rejects the request', async () => {
      const outcome = await callGrpcEcho(await collectionWith('grpcs-no-cert'));

      assert.ok('error' in outcome, `expected an error, got ${JSON.stringify(outcome)}`);
      assert.match(outcome.error, GRPC_HANDSHAKE_FAILURE);
    });

    test('a PEM cert/key is attached on grpcs', async () => {
      const outcome = await callGrpcEcho(await collectionWith('grpcs-pem', PEM));

      assert.ok('message' in outcome, `expected a response, got ${JSON.stringify(outcome)}`);
      assert.match(outcome.message, /mTLS ok/);
    });

    test('a PFX bundle is attached on grpcs', async () => {
      const outcome = await callGrpcEcho(await collectionWith('grpcs-pfx', PFX));

      assert.ok('message' in outcome, `expected a response, got ${JSON.stringify(outcome)}`);
      assert.match(outcome.message, /mTLS ok/);
    });
  });
});
